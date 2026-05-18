"""
Gold layer: human verdicts captured by the stt-appkit-lakebase verdict
workbench, read back from Lakebase via UC federation. Phase 4 of the NLP
Verdict Workbench — closes the Lakebase → Lakehouse half of the loop. The
output table is the source-of-truth for human-verdict metrics in the
stt_nlp_evaluation MLflow notebook (Phase 5).

Source path (single instance, fixed across bundle targets):
    lakebase_stt.app.nlp_verdicts   ← UC foreign catalog over Lakebase Postgres
"""
from pyspark import pipelines as dp
from pyspark.sql.functions import col, row_number
from pyspark.sql.window import Window

# Pipeline-level parameters set in resources/stt_gold_layer.pipeline.yml
catalog = spark.conf.get("catalog")
schema  = spark.conf.get("schema")

# Federation source — single Lakebase instance, same catalog from every
# bundle target. The destination table is per-target (lives in ${schema}).
LAKEBASE_CATALOG = "lakebase_stt"
LAKEBASE_SCHEMA  = "app"


@dp.table(
    name="gold_nlp_human_verdicts",
    cluster_by=["dimension"],
    comment="Gold layer: deduplicated human verdicts from the verdict workbench "
            "(Lakebase Postgres app.nlp_verdicts, via UC federation), joined "
            "with gold_audio_sentiment_analysis for call-level context. Latest "
            "verdict per (path, dimension) wins. Source for human-verdict "
            "metrics in the stt_nlp_evaluation MLflow notebook.",
)
def gold_nlp_human_verdicts():
    """
    Gold layer: deduplicated human verdicts joined with call context.

    Sources:
        {LAKEBASE_CATALOG}.{LAKEBASE_SCHEMA}.nlp_verdicts        — federated Postgres
        {catalog}.{schema}.gold_audio_sentiment_analysis          — gold detail

    Latest verdict per (path, dimension) wins. join is LEFT so verdicts on
    calls that aren't (yet) in the current target's audio_* schema still surface
    (audio_* fields will be NULL — meaningful in dev/per-developer targets where
    audio_<shortname> has different data than what the verdict workbench
    reviewed).

    Pipeline parameters:
        catalog (spark.conf)
        schema  (spark.conf)
    """
    verdicts = spark.read.table(f"{LAKEBASE_CATALOG}.{LAKEBASE_SCHEMA}.nlp_verdicts")

    # Window: latest verdict per (path, dimension). reviewers may revise.
    w = Window.partitionBy("path", "dimension").orderBy(col("reviewed_at").desc())
    latest = (
        verdicts
        .withColumn("_rn", row_number().over(w))
        .filter(col("_rn") == 1)
        .drop("_rn")
    )

    detail = (
        spark.read.table(f"{catalog}.{schema}.gold_audio_sentiment_analysis")
        .select(
            "path",
            col("file_name").alias("audio_file_name"),
            col("sentiment").alias("audio_sentiment"),
            col("topic").alias("audio_topic"),
            col("_ingested_date").alias("audio_ingested_date"),
            col("modificationTime").alias("audio_modification_time"),
        )
    )

    return (
        latest.join(detail, on="path", how="left")
        .select(
            # ── Verdict facts ─────────────────────────────────────────────
            col("path"),
            col("dimension"),
            col("winner"),
            col("truth_value"),
            col("notes"),
            col("reviewer_email"),
            col("reviewed_at"),

            # ── Call-level context (NULL for cross-schema verdicts) ───────
            col("audio_file_name"),
            col("audio_sentiment"),
            col("audio_topic"),
            col("audio_ingested_date"),
            col("audio_modification_time"),
        )
    )
