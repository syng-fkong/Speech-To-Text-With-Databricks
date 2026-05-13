from pyspark import pipelines as dp
from pyspark.sql.functions import (
    array_intersect,
    array_union,
    col,
    expr,
    lit,
    lower,
    size,
    when,
)

# Pipeline-level parameters set in resources/stt_gold_layer.pipeline.yml
catalog = spark.conf.get("catalog")
schema  = spark.conf.get("schema")

# Disagreement thresholds — hardcoded for v1. Promote to bundle variables
# (e.g. var.disagreement_entity_threshold) when per-environment tuning is needed.
ENTITY_JACCARD_THRESHOLD = 0.5  # Below this, the two entity sets are flagged as disagreeing.


def _entity_token_array_expr(entities_col: str) -> str:
    """Build a SQL expression that flattens an entities STRUCT into a deduped array
    of tagged tokens (e.g. 'person:Alice', 'org:Acme'). Lets us treat all five
    entity types as one set for Jaccard comparison instead of five separate sets.

    entities = STRUCT<person, organization, location, date, amount>, each ARRAY<STRING>.
    """
    return (
        "array_distinct(flatten(array("
        f"  transform(coalesce({entities_col}.person,       array()), x -> concat('person:', x)),"
        f"  transform(coalesce({entities_col}.organization, array()), x -> concat('org:',    x)),"
        f"  transform(coalesce({entities_col}.location,     array()), x -> concat('loc:',    x)),"
        f"  transform(coalesce({entities_col}.date,         array()), x -> concat('date:',   x)),"
        f"  transform(coalesce({entities_col}.amount,       array()), x -> concat('amt:',    x))"
        ")))"
    )


@dp.table(
    name="gold_nlp_disagreements",
    cluster_by=["_ingested_date"],
    comment="Gold layer: calls where the two silver NLP implementations "
            "(silver_audio_nlp_ai_query vs silver_audio_nlp_ai_func) disagree on sentiment, "
            "topic, or entity set. Source for the human-review verdict workflow described in "
            "docs/NLP_VERDICT_WORKBENCH_DESIGN.md — the prod target's Lakebase Sync materialises "
            "this view into a Postgres review_queue table for the stt-appkit-lakebase app.",
)
def gold_nlp_disagreements():
    """
    Gold layer: per-call diff view of the two NLP implementations.

    Sources:
        {catalog}.{schema}.silver_audio_nlp_ai_query      — Foundation Model API output
        {catalog}.{schema}.silver_audio_nlp_ai_func       — AI SQL functions output
        {catalog}.{schema}.silver_audio_transcription     — for transcription_text + lineage

    Disagreement criteria (any one triggers inclusion):
        - sentiment_ai_query != sentiment_ai_func           (categorical mismatch)
        - topic_ai_query     != topic_ai_func               (categorical mismatch)
        - entity_jaccard_similarity < ENTITY_JACCARD_THRESHOLD

    summary_cosine_similarity is surfaced as NULL in v1 — computing it requires an
    embedding lookup, which is deferred. The column is kept so downstream consumers
    (Lakebase Sync, app) have a stable schema.

    Output columns mirror the side-by-side diff view the app will render.

    Pipeline parameters:
        catalog (spark.conf)  Unity Catalog catalog name.
        schema  (spark.conf)  Schema holding the silver tables.
    """
    ai_query = (
        spark.read.table(f"{catalog}.{schema}.silver_audio_nlp_ai_query")
        .select(
            col("path"),
            lower(col("sentiment")).alias("sentiment_ai_query"),
            col("summary").alias("summary_ai_query"),
            lower(col("topic")).alias("topic_ai_query"),
            col("entities").alias("entities_ai_query"),
        )
    )

    ai_func = (
        spark.read.table(f"{catalog}.{schema}.silver_audio_nlp_ai_func")
        .select(
            col("path"),
            lower(col("sentiment")).alias("sentiment_ai_func"),
            col("summary").alias("summary_ai_func"),
            lower(col("topic")).alias("topic_ai_func"),
            col("entities").alias("entities_ai_func"),
        )
    )

    txn = (
        spark.read.table(f"{catalog}.{schema}.silver_audio_transcription")
        .select("path", "transcription_text", "_ingested_date", "_ingested_at")
    )

    joined = ai_query.join(ai_func, on="path", how="inner").join(txn, on="path", how="inner")

    # Entity Jaccard. Empty-on-both → 1.0 (perfect agreement on "no entities").
    with_jaccard = (
        joined
        .withColumn("_ent_q", expr(_entity_token_array_expr("entities_ai_query")))
        .withColumn("_ent_f", expr(_entity_token_array_expr("entities_ai_func")))
        .withColumn(
            "entity_jaccard_similarity",
            when(
                (size(col("_ent_q")) == 0) & (size(col("_ent_f")) == 0),
                lit(1.0).cast("float"),
            ).otherwise(
                (
                    size(array_intersect(col("_ent_q"), col("_ent_f"))).cast("double")
                    / size(array_union(col("_ent_q"), col("_ent_f"))).cast("double")
                ).cast("float")
            ),
        )
        .withColumn("summary_cosine_similarity", lit(None).cast("float"))
    )

    # array_remove(array(...), NULL) is the idiom to build a non-null array from
    # conditionally-NULL elements, so disagreement_flags ends up tight.
    with_flags = with_jaccard.withColumn(
        "disagreement_flags",
        expr(
            "array_remove(array("
            "  CASE WHEN sentiment_ai_query != sentiment_ai_func THEN 'sentiment' ELSE NULL END,"
            "  CASE WHEN topic_ai_query     != topic_ai_func     THEN 'topic'     ELSE NULL END,"
            f"  CASE WHEN entity_jaccard_similarity < {ENTITY_JACCARD_THRESHOLD} THEN 'entities' ELSE NULL END"
            "), NULL)"
        ),
    )

    return (
        with_flags.filter(size(col("disagreement_flags")) > 0)
        .select(
            # ── Identity + transcript ──────────────────────────────────────
            col("path"),
            col("transcription_text"),

            # ── Both NLP outputs, side by side ─────────────────────────────
            col("sentiment_ai_query"),
            col("sentiment_ai_func"),
            col("summary_ai_query"),
            col("summary_ai_func"),
            col("topic_ai_query"),
            col("topic_ai_func"),
            col("entities_ai_query"),
            col("entities_ai_func"),

            # ── Similarity scores ──────────────────────────────────────────
            col("entity_jaccard_similarity"),
            col("summary_cosine_similarity"),

            # ── Which dimensions disagreed ─────────────────────────────────
            col("disagreement_flags"),

            # ── Audit lineage ──────────────────────────────────────────────
            col("_ingested_date"),
            col("_ingested_at"),
        )
    )
