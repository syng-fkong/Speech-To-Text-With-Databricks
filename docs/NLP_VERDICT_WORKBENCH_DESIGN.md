# NLP Verdict Workbench — Design

**Status:** Proposed, deferred. See [BACKLOG.md](../BACKLOG.md).
**Drafted:** 2026-05-13.
**Owners:** TBD.

## Summary

A human-in-the-loop review tool that closes the loop between the existing dual-NLP analytical pipeline ([`speech_to_text_asset_bundle/`](../speech_to_text_asset_bundle/)) and the Databricks App ([`stt-appkit-lakebase/`](../stt-appkit-lakebase/)). Reviewers see calls where the two NLP implementations (`silver_audio_nlp_ai_query` from Foundation Model API and `silver_audio_nlp_ai_func` from AI SQL functions) disagree, pick a verdict per disagreement dimension, and those verdicts flow back to a Delta table that the existing MLflow evaluation notebook consumes as ground truth.

This use case is the integration story for **Lakehouse ↔ Lakebase**:

- **Lakehouse → Lakebase** — disagreement candidates pushed into Postgres for fast, multi-user review
- **Lakebase → Lakehouse** — reviewer verdicts read back via Unity Catalog federation into Delta, feeding MLflow

## Motivation

The asset bundle already runs two parallel NLP implementations and compares them in an MLflow evaluation notebook ([`src/stt_nlp_evaluation/`](../speech_to_text_asset_bundle/src/stt_nlp_evaluation/)). Today that comparison is *self-referential* — it uses LLM judges and deterministic validators, but no human ground truth. Without humans in the loop, the eval can only say "the two implementations disagree on X% of calls", not "implementation A is correct on Y% of calls."

The app, meanwhile, is a generic CRUD template with no domain purpose. It needs to be replaced with something that earns its keep.

Combining the two solves both problems with one project.

## Current state

```text
[Audio files] → Auto Loader → bronze → silver_audio_transcription
                                            │
                  ┌─────────────────────────┴─────────────────────────┐
                  │                                                   │
        silver_audio_nlp_ai_func                            silver_audio_nlp_ai_query
        (AI SQL functions)                                  (Foundation Model API)
                  │                                                   │
                  └─────────────────────────┬─────────────────────────┘
                                            │
                                  stt_gold_layer (detail + aggregate)
                                            │
                                  stt_nlp_evaluation (MLflow,
                                  LLM judges only — no human truth)
```

The app today is the AppKit-Lakebase todo CRUD template — unrelated to the analytical pipeline.

## Proposed architecture

```text
                LAKEHOUSE                                            LAKEBASE
          (Delta in Unity Catalog)                                (Postgres OLTP)

   silver_audio_nlp_ai_query ─┐
                              │
   silver_audio_nlp_ai_func   ├─► gold_nlp_disagreements
                              │   (view of disagreeing rows
   silver_audio_transcription ┘    + both NLP outputs)
                                            │
                                            │   Lakebase Sync
                                            │   (scheduled snapshot
                                            ▼    per pipeline run)
                                                                 ┌──────────────────────┐
                                                                 │ review_queue         │
                                                                 │  (call_id, status,   │
                                                                 │   both NLP outputs,  │
                                                                 │   claimed_by, ...)   │
                                                                 │                      │
                                          App reads /writes ◄───►│ nlp_verdicts         │
                                                                 │  (call_id, dimension,│
                                                                 │   winner, truth,     │
                                                                 │   reviewer_email)    │
                                                                 └──────────┬───────────┘
   gold_nlp_human_verdicts                                                  │
       ◄────── reads via UC Federation ◄─── lakebase catalog ────────◄──────┘
       (Delta, materialized by                  (Postgres exposed
        stt_human_verdicts pipeline)             as UC foreign catalog)
                              │
                              ▼
   stt_nlp_evaluation (MLflow)
       — now computes precision/recall
         per implementation against
         human verdicts
```

## Detailed design

### 1. Lakehouse: `gold_nlp_disagreements` view

A new view in the gold layer (added to [`speech_to_text_asset_bundle/src/stt_gold_layer/`](../speech_to_text_asset_bundle/src/stt_gold_layer/)) that joins both silver NLP tables and selects rows where they disagree on any dimension.

Trigger conditions (call rows that surface for review):

- `sentiment_ai_query != sentiment_ai_func` (categorical mismatch), OR
- `topic_ai_query != topic_ai_func`, OR
- cosine similarity of `summary_ai_query` / `summary_ai_func` embeddings `< 0.7` (configurable, threshold per pipeline variable), OR
- Jaccard similarity of entity sets `< 0.5`

Output columns:

| column | type | source |
|---|---|---|
| `call_id` | string | join key |
| `transcript` | string | `silver_audio_transcription.transcription` |
| `audio_timestamp` | timestamp | `silver_audio_transcription.event_time` |
| `summary_ai_query`, `summary_ai_func` | string | both silver tables |
| `sentiment_ai_query`, `sentiment_ai_func` | string | both silver tables |
| `topic_ai_query`, `topic_ai_func` | string | both silver tables |
| `entities_ai_query`, `entities_ai_func` | array<struct> | both silver tables |
| `summary_cosine_similarity` | float | computed in view |
| `entity_jaccard_similarity` | float | computed in view |
| `disagreement_flags` | array<string> | which dimensions disagreed |

The view is recomputed each gold-layer pipeline run.

### 2. Lakehouse → Lakebase sync

Use **Lakebase Sync** (Databricks managed Delta-to-Postgres sync) to materialize `gold_nlp_disagreements` into a Postgres table `review_queue`.

- Sync mode: **scheduled snapshot** per gold-layer pipeline run (the upstream pipeline is batch; a continuous sync isn't justified).
- Sync upserts on `call_id`. Rows whose status is `pending` are refreshed if the Lakehouse view changes; rows already `claimed` or `reviewed` are not overwritten (handled via Lakebase Sync's row-level filter or via a `BEFORE UPDATE` trigger).
- Configure via a new bundle resource in [`speech_to_text_asset_bundle/resources/`](../speech_to_text_asset_bundle/resources/), e.g., `stt_review_queue_sync.lakebase_sync.yml`.

### 3. Lakebase schemas (Postgres)

```sql
-- Synced from gold_nlp_disagreements; app reads to populate the queue.
CREATE TABLE review_queue (
  call_id                    TEXT PRIMARY KEY,
  transcript                 TEXT NOT NULL,
  audio_timestamp            TIMESTAMPTZ NOT NULL,
  summary_ai_query           TEXT,
  summary_ai_func            TEXT,
  sentiment_ai_query         TEXT,
  sentiment_ai_func          TEXT,
  topic_ai_query             TEXT,
  topic_ai_func              TEXT,
  entities_ai_query          JSONB,
  entities_ai_func           JSONB,
  summary_cosine_similarity  REAL,
  entity_jaccard_similarity  REAL,
  disagreement_flags         TEXT[] NOT NULL,
  synced_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  status                     TEXT NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending','claimed','reviewed','skipped')),
  claimed_by                 TEXT,
  claimed_at                 TIMESTAMPTZ
);

CREATE INDEX review_queue_status_idx ON review_queue(status, audio_timestamp);

-- Written by the app when a reviewer submits a verdict.
CREATE TABLE nlp_verdicts (
  verdict_id      BIGSERIAL PRIMARY KEY,
  call_id         TEXT NOT NULL REFERENCES review_queue(call_id) ON DELETE CASCADE,
  dimension       TEXT NOT NULL CHECK (dimension IN ('sentiment','topic','summary','entities')),
  winner          TEXT NOT NULL CHECK (winner IN ('ai_query','ai_func','neither','both_acceptable')),
  truth_value     TEXT,                       -- reviewer's free-form ground truth if winner='neither'
  notes           TEXT,
  reviewer_email  TEXT NOT NULL,
  reviewed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX nlp_verdicts_call_id_idx ON nlp_verdicts(call_id);
CREATE INDEX nlp_verdicts_reviewed_at_idx ON nlp_verdicts(reviewed_at);
```

Notes:
- `nlp_verdicts` is append-only — revising a verdict creates a new row; the eval pipeline picks the latest `(call_id, dimension)` pair.
- `review_queue.status` lifecycle: `pending → claimed → reviewed` (or `→ skipped`). Auto-release stale claims after 30 minutes via a Postgres scheduled job or app-side cron.

### 4. App: replace todo CRUD with verdict workbench

In [`stt-appkit-lakebase/`](../stt-appkit-lakebase/):

**Server routes** (replace [`server/routes/lakebase/todo-routes.ts`](../stt-appkit-lakebase/server/routes/lakebase/todo-routes.ts) with `verdict-routes.ts`):

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/review-queue` | List `pending` items. Query params: `dimension` (filter by disagreement type), `limit`, `cursor`. |
| `GET` | `/api/review-queue/:call_id` | Full row for the detail/diff view. |
| `POST` | `/api/review-queue/:call_id/claim` | Atomic claim: `UPDATE review_queue SET status='claimed', claimed_by=$user, claimed_at=now() WHERE call_id=$1 AND status='pending'`. Returns 409 if already claimed. |
| `POST` | `/api/review-queue/:call_id/release` | Release a claimed item without verdict. |
| `POST` | `/api/verdicts` | Transactional: insert into `nlp_verdicts` AND set `review_queue.status='reviewed'`. Body: `{ call_id, verdicts: [{dimension, winner, truth_value?, notes?}, ...] }`. |
| `GET` | `/api/verdicts/me` | History for the current reviewer. |

Reviewer identity comes from Databricks Apps' on-behalf-of-user headers (already wired in AppKit).

**Frontend** (replace [`client/src/pages/lakebase/LakebasePage.tsx`](../stt-appkit-lakebase/client/src/pages/lakebase/LakebasePage.tsx)):

- **Queue page**: paginated list of pending items, columns for `call_id`, `audio_timestamp`, `disagreement_flags`, claim button.
- **Detail / diff page**: transcript on top; below it, one card per disagreement dimension showing the two outputs side by side with a "Winner" radio (`AI SQL` / `FM API` / `Neither — provide truth` / `Both acceptable`), an optional notes field, and a submit-all button.
- **My reviews** page: history of submitted verdicts (queries `/api/verdicts/me`).

### 5. Lakebase → Lakehouse: federation + verdicts pipeline

**Foreign catalog registration** (one-time, manual or via [`docs/DATABRICKS_SETUP.md`](DATABRICKS_SETUP.md)):

```sql
CREATE FOREIGN CATALOG lakebase_stt USING CONNECTION <postgres-connection-name>;
```

This exposes `lakebase_stt.public.nlp_verdicts` as a readable Spark table.

**New pipeline `stt_human_verdicts`** in [`speech_to_text_asset_bundle/`](../speech_to_text_asset_bundle/):

- Resource file: `resources/stt_human_verdicts.pipeline.yml`
- Source: `src/stt_human_verdicts/` (Python SDP)
- Reads `lakebase_stt.public.nlp_verdicts` (federated) and `gold_call_detail` (Delta) on `call_id`.
- Deduplicates to the **latest** verdict per `(call_id, dimension)` (window over `reviewed_at DESC`).
- Materializes Delta table `gold_nlp_human_verdicts` with columns:
  - `call_id`, `dimension`, `winner`, `truth_value`, `notes`, `reviewer_email`, `reviewed_at`, plus joined gold-layer context (`audio_timestamp`, `topic_ai_query`, etc.)
- Orchestrated by the existing `stt_main` job — runs after `stt_gold_layer`.

### 6. MLflow eval extension

In [`speech_to_text_asset_bundle/src/stt_nlp_evaluation/`](../speech_to_text_asset_bundle/src/stt_nlp_evaluation/), extend the existing notebook to:

- Join `gold_nlp_human_verdicts` with the silver NLP tables on `call_id`
- For `winner ∈ {ai_query, ai_func}`: count as a correct label for that implementation
- For `winner = 'neither'`: count as miss for both, optionally use `truth_value` for further scoring
- Log per-implementation accuracy / precision / recall per `dimension` to MLflow, alongside the existing LLM-judge metrics

The MLflow run output gains four new metrics (or eight, four per implementation):

```
ai_query_sentiment_accuracy   = correct / total verdicts on sentiment
ai_func_sentiment_accuracy    = ...
ai_query_topic_accuracy       = ...
ai_func_topic_accuracy        = ...
ai_query_summary_win_rate     = winner='ai_query' / (winner ∈ {ai_query,ai_func})
ai_func_summary_win_rate      = ...
... (entities similarly)
```

## Implementation phases

Each phase is independently shippable.

1. **Lakehouse-side disagreements view** — add `gold_nlp_disagreements` to `stt_gold_layer`. No app changes; verify rows look right in the dashboard.
2. **Lakebase Sync** — set up `review_queue` table, configure Lakebase Sync. Verify rows appear in Postgres after a pipeline run.
3. **App rewrite** — replace todo routes/UI with verdict workbench. Hard-code a single reviewer for the first cut; layer in real auth in a follow-up.
4. **UC federation + verdicts pipeline** — register the foreign catalog, build `stt_human_verdicts` pipeline, schedule it.
5. **MLflow eval integration** — extend the eval notebook, add new metrics to the dashboard.

Phases 1–3 deliver an internal review tool even before the loopback. Phases 4–5 deliver the analytical payoff.

## Open questions

- **Disagreement thresholds** — what cosine/Jaccard cutoffs catch meaningful disagreement without overwhelming reviewers? Start at 0.7 / 0.5 and tune from real volume.
- **Transcript size in `review_queue`** — sync the full transcript (could be long) vs. just `call_id` + audio reference. Full transcript keeps the app self-contained (no warehouse query per page view) at the cost of duplicated data. Start with full.
- **Lakebase Sync conflict policy** — how to handle a row that's `claimed`/`reviewed` in Lakebase if the upstream view drops it. Recommend: don't delete; mark with a `stale=true` flag the app filters out of new queues.
- **Reviewer auth** — Databricks Apps' on-behalf-of-user identity (uses `user_api_scopes`) vs. a simpler email captured from headers. The current `databricks.yml` has `user_api_scopes` commented out — enabling adds OAuth complexity. Decide whether to keep it simple for v1.
- **Audit / revision** — append-only `nlp_verdicts` means revisions create new rows. Is "latest wins" the right reconciliation rule, or do we need explicit revisioning UI?
- **Multi-tenant** — single workspace fine for v1; if multiple tenants/projects share the app later, add a `project_id` to both Postgres tables and to the Lakehouse view.

## Alternatives considered

- **Simpler generic call-review queue** (flag-for-follow-up, free-text notes). Useful but doesn't naturally need bidirectional flow — could be a one-way dashboard with annotations stored anywhere. Doesn't extend the existing MLflow eval.
- **Real-time triage** on negative-sentiment calls. Fights the architecture — the pipeline is batch, not streaming, so "real-time" would mean re-architecting upstream.
- **Topic-based routing to teams**. Single-direction; no compelling reason to push state back to the Lakehouse.
- **Dual-write from the app to both Postgres and Delta directly**. Avoids UC federation but creates two consistency problems (transactional + analytical). UC federation is the cleaner read-back path.

## Risks and non-goals

- **Not real-time.** Reviewers see calls hours after they happen — fine for evaluation, not for live agent assist.
- **Not a labeler-quality tool.** No inter-rater agreement, no calibration, no labeler-payment workflow. v1 assumes a small trusted team.
- **Not training data (yet).** The verdicts could fund a fine-tune in a future iteration, but v1 is evaluation only.
- **Lakebase Sync GA status** — confirm the feature is available in the target workspace tier before committing to it; fallback is a scheduled Spark JDBC write job.
