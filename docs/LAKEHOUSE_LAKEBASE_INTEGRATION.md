# Lakehouse ↔ Lakebase Integration

**Status:** Implemented and verified end-to-end (2026-05-14).
**Design rationale:** [NLP_VERDICT_WORKBENCH_DESIGN.md](NLP_VERDICT_WORKBENCH_DESIGN.md).
**Tracking + open work:** [BACKLOG.md](../BACKLOG.md).

This is the operational reference for the Lakehouse ↔ Lakebase wiring that powers the NLP Verdict Workbench. Concrete table names, working API bodies, gotchas, and troubleshooting. For *why* this exists, read the design doc.

## What this integration does

Closes the loop between the analytical pipeline (Delta in Unity Catalog) and the OLTP-style review app (Postgres in Lakebase):

- **Lakehouse → Lakebase**: rows where the two silver NLP implementations disagree are pushed into a Postgres queue table that the [`stt-appkit-lakebase`](../stt-appkit-lakebase/) app reads. Reviewers see them live with sub-second latency.
- **Lakebase → Lakehouse**: reviewer verdicts written by the app to Postgres flow back into a Delta table via Unity Catalog federation. The existing MLflow evaluation notebook reads it to compute per-implementation win rates against human ground truth.

## As-built architecture

```text
                 LAKEHOUSE  (Delta in Unity Catalog)                               LAKEBASE  (Postgres, autoscale)

   silver_audio_nlp_ai_query   ─┐
                                │
   silver_audio_nlp_ai_func    ─┤  ─►  gold_nlp_disagreements
                                │      (MATERIALIZED_VIEW, per-target schema)
   silver_audio_transcription  ─┘                  │
                                                   │  POST /api/2.0/postgres/synced_tables
                                                   │  scheduling_policy: SNAPSHOT
                                                   ▼
                                                                    ┌──────────────────────────┐
                                                                    │ app.review_queue          │
                                                                    │   sync-owned, read-only   │
                                                                    │   (owner = databricks_    │
                                                                    │    writer_NNN — needs      │
                                                                    │    explicit GRANT to SP)   │
                                                                    │                            │
                                          App reads + writes ◄────► │ app.review_state           │
                                                                    │   app-owned, workflow      │
                                                                    │   state (path, status,     │
                                                                    │   claimed_by, claimed_at)  │
                                                                    │                            │
                                                                    │ app.nlp_verdicts           │
                                                                    │   app-owned, append-only   │
                                                                    │   verdict log              │
                                                                    └──────────────┬─────────────┘
                                                                                   │
                                                                                   │  UC Federation
                                                                                   │  via foreign catalog
                                                                                   │  lakebase_stt
                                                                                   ▼
   gold_nlp_human_verdicts                                  read at SDP pipeline run time
        (Delta, per-target schema)        ◄────────────────────────────────────────┘
              │
              ▼
   stt_nlp_evaluation MLflow notebook
   → "human_verdicts_summary" run with per-dimension win rates
```

## The resources

### Unity Catalog

| Resource | Identifier | Owned by | Notes |
|---|---|---|---|
| Foreign catalog | `lakebase_stt` | (registered as `fkong`) | Exposes the autoscale Lakebase database to Spark/SQL warehouse |

### Lakebase (Postgres on `projects/speech-to-text/branches/production/databases/db-idxm-pfkiwu5v4q`)

| Table | Owner | Source of writes | Notes |
|---|---|---|---|
| `app.review_queue` | `databricks_writer_NNN` (sync pipeline) | Lakebase Sync, SNAPSHOT mode | Materialised from `gold_nlp_disagreements`. App SP needs explicit `GRANT SELECT`. |
| `app.review_state` | App SP | App (claim / release / verdict routes) | Workflow state. Absence ⇒ `pending`. |
| `app.nlp_verdicts` | App SP | App (verdict route) | Append-only verdict log, deduped on read. |

### Lakehouse (per bundle target — `audio_prod` / `audio_dev` / `audio_<shortname>`)

| Table | Type | Built by | Notes |
|---|---|---|---|
| `gold_nlp_disagreements` | MATERIALIZED_VIEW (DLT) | [`gold_nlp_disagreements.py`](../speech_to_text_asset_bundle/src/stt_gold_layer/transformations/gold_nlp_disagreements.py) | Joins both silver NLP tables; emits rows where any dimension disagrees. |
| `gold_nlp_human_verdicts` | MATERIALIZED_VIEW (DLT) | [`gold_nlp_human_verdicts.py`](../speech_to_text_asset_bundle/src/stt_gold_layer/transformations/gold_nlp_human_verdicts.py) | Reads `lakebase_stt.app.nlp_verdicts` via UC federation; latest per `(path, dimension)`. |

## Setup recipes

### 1. Register the Lakebase foreign catalog (one-time)

This was the working invocation. Top-level body field is `spec` (not `catalog`, despite the error message saying "Field 'catalog' is required").

```bash
HOST=https://adb-7405611527540572.12.azuredatabricks.net
TOKEN=$(DATABRICKS_CONFIG_PROFILE=sandpit databricks auth token \
        | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

curl -sS -X POST "$HOST/api/2.0/postgres/catalogs?catalog_id=lakebase_stt" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "spec": {
      "postgres_database": "databricks_postgres",
      "branch": "projects/speech-to-text/branches/production"
    }
  }'
```

Verify:

```sql
SHOW SCHEMAS IN lakebase_stt;
-- Expect: __db_system, app, appkit, information_schema, pg_catalog, public
```

If the catalog metadata becomes stale (e.g., a backing Postgres table was dropped):

```sql
REFRESH FOREIGN SCHEMA lakebase_stt.app;
```

### 2. Create the Lakebase Sync (one-time, when the upstream view exists)

This was the working invocation. Same `spec` pattern as create-catalog. **Must be `SNAPSHOT`** because `gold_nlp_disagreements` is a DLT MATERIALIZED_VIEW (incremental modes only support standard Delta tables).

```bash
curl -sS -X POST \
  "$HOST/api/2.0/postgres/synced_tables?synced_table_id=lakebase_stt.app.review_queue" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "spec": {
      "source_table_full_name": "speech_to_text.audio_fkong.gold_nlp_disagreements",
      "branch": "projects/speech-to-text/branches/production",
      "postgres_database": "databricks_postgres",
      "primary_key_columns": ["path"],
      "scheduling_policy": "SNAPSHOT",
      "create_database_objects_if_missing": true
    }
  }'
```

Update `source_table_full_name` to point at the appropriate per-environment schema (e.g., `speech_to_text.audio_prod.gold_nlp_disagreements`).

Check status:

```bash
curl -sS -H "Authorization: Bearer $TOKEN" \
  "$HOST/api/2.0/postgres/synced_tables/lakebase_stt.app.review_queue"
# look for status.detailed_state and ongoing_sync_progress
```

### 3. Grant the app SP read access to the synced table (one-time per sync)

The sync owns `app.review_queue` as a Postgres role like `databricks_writer_16401`, *not* as the app SP. Even with the UC foreign catalog set up, the app's direct Postgres connection gets `permission denied`. Fix with `GRANT SELECT`.

```bash
# psql is required; install libpq (keg-only) and add to PATH:
brew install libpq
export PATH="/opt/homebrew/opt/libpq/bin:$PATH"

# Run as a user with privileges (e.g. the human who created the sync):
DATABRICKS_CONFIG_PROFILE=sandpit databricks psql \
  --project speech-to-text --branch production --endpoint primary \
  -- -d databricks_postgres \
  -c 'GRANT SELECT ON TABLE app.review_queue TO "df04e7ed-6afe-4014-9b0e-672407317e36";'
```

Replace the UUID with the app SP's `client_id` (`databricks apps get stt-appkit-lakebase` → `service_principal_client_id`).

### 4. Deploy the asset bundle (every time the gold transformations change)

```bash
cd speech_to_text_asset_bundle
DATABRICKS_CONFIG_PROFILE=sandpit databricks bundle deploy --target dev
DATABRICKS_CONFIG_PROFILE=sandpit databricks bundle run --target dev stt_gold_layer
```

This rebuilds `gold_nlp_disagreements` and `gold_nlp_human_verdicts`. The sync's snapshot picks up the new disagreement rows on its next run.

### 5. Deploy the verdict workbench app (when app code changes)

```bash
cd stt-appkit-lakebase
DATABRICKS_CONFIG_PROFILE=sandpit databricks bundle deploy
DATABRICKS_CONFIG_PROFILE=sandpit databricks bundle run app
```

Schema creation (`app.review_state`, `app.nlp_verdicts`, FK to `app.review_queue`) happens idempotently on app startup.

## End-to-end smoke test

After all four setup steps, this proves the loop:

1. Open the app at <https://stt-appkit-lakebase-7405611527540572.12.azure.databricksapps.com>.
2. Verify the queue shows pending rows from `gold_nlp_disagreements`. If empty: check sync status (Step 2 above) and `app.review_state` (any stale `reviewed`/`claimed` rows will hide items — `DELETE FROM app.review_state WHERE path = '...'` resets to pending).
3. Click a row → review the side-by-side diff → submit a verdict.
4. Re-run the gold pipeline: `databricks bundle run stt_gold_layer`. The verdict flows back via federation into `gold_nlp_human_verdicts`.
5. Verify in SQL:

   ```sql
   SELECT * FROM speech_to_text.audio_fkong.gold_nlp_human_verdicts;
   ```

6. Optionally run the eval task:

   ```bash
   databricks bundle run stt_main --only evaluate_nlp_quality
   ```

   The MLflow experiment `/Shared/nlp-quality-evaluation` gains a `human_verdicts_summary` run with per-dimension win rates.

## Operational gotchas

- **Sync source is per-environment**, but the Lakebase destination is single-instance. Today the sync points at `audio_fkong.gold_nlp_disagreements`. To use prod data, recreate the sync with `source_table_full_name: speech_to_text.audio_prod.gold_nlp_disagreements`. Currently you can only have one source feed the same `app.review_queue`.
- **Schema is `app`, not `public`.** The app SP doesn't have CREATE on `public`. All app-owned DDL targets `app`.
- **The sync overwrites the destination on initial snapshot.** If you pre-create `app.review_queue` you'll hit `BAD_REQUEST: Destination table already exists`. Drop the pre-existing table before creating the sync.
- **JSON-encoded columns.** The sync serialises Spark `ARRAY<STRING>` and `STRUCT<...>` columns to Postgres `string`. The app's queries cast `::jsonb` so the client receives parsed arrays/objects. Don't expect native Postgres `TEXT[]` or `JSONB` types on synced columns.
- **`_ingested_at` keeps its leading underscore.** The sync preserves source column names exactly. App SQL must use `q._ingested_at` (not `ingested_at`).
- **Bundle/Terraform doesn't support autoscale synced tables yet.** The bundle resource `synced_database_tables` and Terraform `databricks_database_synced_database_table` only support *provisioned* Lakebase. Until the upstream issue ([terraform-provider-databricks#5456](https://github.com/databricks/terraform-provider-databricks/issues/5456)) lands, the sync has to be created out-of-bundle (Step 2 above).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Field 'catalog' is required and must contain at least one subfield` (creating catalog) | Top-level body field needs to be `spec`, not `catalog`. | Use the body shape in Step 1 above. |
| `Field 'synced_table' is required and must contain at least one subfield` (creating sync) | Same — top-level field is `spec`. | Use the body shape in Step 2 above. |
| `Destination table lakebase_stt.app.review_queue already exists` | App pre-created the table, or sync was created before. | Drop the table from Postgres (`databricks psql ... -c 'DROP TABLE app.review_queue CASCADE'`) and retry. The app's idempotent DDL no longer creates it as of Phase 2.1. |
| `Table type MATERIALIZED_VIEW ... is not supported as a source in online materialized views in incremental mode` | DLT-built source tables are MATERIALIZED_VIEW, not standard Delta. | Use `scheduling_policy: SNAPSHOT` (full-copy mode) instead of `TRIGGERED` / `CONTINUOUS`. |
| `Database instance is not found` (Terraform deploy of synced table) | `databricks_database_synced_database_table` is provisioned-only. | Don't put the sync in the bundle; create via API (Step 2). |
| App returns 500 `permission denied for table review_queue` | App SP lacks `SELECT` on the sync-owned table. | Run the GRANT in Step 3. |
| App returns 500 `column "ingested_at" does not exist` | Sync preserves the leading underscore. | Use `_ingested_at` in app SQL. |
| Federation query fails after dropping a Postgres table | UC foreign metadata is cached. | `REFRESH FOREIGN SCHEMA lakebase_stt.app;` |
| App queue is empty after a verdict | `app.review_state.status='reviewed'` for that path filters it out. | `DELETE FROM app.review_state WHERE path = '...'` to reset to pending. |

## Reference: data flow during a single verdict

1. Reviewer opens app, sees row from `app.review_queue` (read via app SP, fed by sync from `gold_nlp_disagreements`).
2. Reviewer clicks → app `POST /api/review-queue/claim` → INSERT/UPDATE on `app.review_state` (atomic, `ON CONFLICT DO UPDATE WHERE status='pending'`).
3. Reviewer submits → app `POST /api/verdicts` → single CTE statement that:
   - Validates path exists in `app.review_queue` (`path_exists` CTE)
   - INSERTs N rows into `app.nlp_verdicts` (one per dimension)
   - UPSERTs `app.review_state` to `status='reviewed'`
4. Next gold-pipeline run: `gold_nlp_human_verdicts` reads `lakebase_stt.app.nlp_verdicts` via federation, dedupes to latest per `(path, dimension)`, joins with `gold_audio_sentiment_analysis` for context, writes Delta.
5. Next eval-task run: MLflow `human_verdicts_summary` run logs per-dimension win rates from the latest `gold_nlp_human_verdicts`.
