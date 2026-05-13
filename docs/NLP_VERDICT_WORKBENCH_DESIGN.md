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

## Environment strategy

**The verdict subsystem is anchored to a single Lakebase + single Lakehouse schema (`audio_prod`).** The asset bundle's existing multi-schema pattern (`audio_prod` / `audio_dev` / `audio_<shortname>`) applies to the transcription and NLP pipelines unchanged — only the verdict subsystem is single-instance.

**Rationale.** Lakebase scale-to-zero is per branch (per compute endpoint), so per-developer branches *could* be cheap when idle. But the operational complexity — per-developer UC connections, per-environment federation catalogs, schema-aware verdict routing, per-developer deployed apps — isn't justified for current team size (one developer). The simpler single-instance design ships faster and can be upgraded later without losing the analytical payoff. The full multi-environment design is preserved in git history at commit `bf81348` and remains the upgrade path.

### Resources (all single-instance)

| Component | Identifier |
|---|---|
| Lakebase branch | `projects/speech-to-text/branches/production` (existing) |
| Lakebase database | `db-idxm-pfkiwu5v4q` (existing, already bound to the deployed app) |
| Deployed app | `stt-appkit-lakebase` (existing) |
| UC connection + foreign catalog | `lakebase_stt` (new, Phase 0) |
| Lakehouse schema (both directions) | `audio_prod` |

### The wiring rule

Both directions are anchored to `audio_prod`:

- **Lakebase Sync** reads from `audio_prod.gold_nlp_disagreements` only. Dev / per-developer schemas do not feed Lakebase. (Otherwise dev syncs would conflict with prod's data in the single `review_queue` table.)
- **Federation pipeline** writes to `audio_prod.gold_nlp_human_verdicts` only.
- The Lakebase Sync resource and the federation pipeline both deploy **only in the `prod` bundle target**, not in `dev` or per-developer.

### Consequence for dev work

The MLflow eval extension's human-verdict metrics only exist for `audio_prod` data. Dev and per-developer MLflow runs cannot compute verdict-based metrics natively. Developers test the verdict subsystem one of three ways:

1. Read `audio_prod.gold_nlp_human_verdicts` read-only as fixed test data.
2. Manually insert test rows into Lakebase via `psql`/the app for development iteration.
3. Accept that this subsystem is end-to-end-testable only in prod and rely on unit tests for component changes.

This is the deliberate trade-off of the single-instance choice.

## Proposed architecture

```text
                LAKEHOUSE                                            LAKEBASE
          (Delta in Unity Catalog)                                (Postgres OLTP)

   silver_audio_nlp_ai_query ─┐
                              │
   silver_audio_nlp_ai_func   ├─► audio_prod.gold_nlp_disagreements
                              │   (view of disagreeing rows
   silver_audio_transcription ┘    + both NLP outputs)
                                            │
                                            │   Lakebase Sync
                                            │   (scheduled snapshot
                                            ▼    per pipeline run,
                                                 prod target only)
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
   audio_prod.gold_nlp_human_verdicts                                       │
       ◄────── reads via UC Federation ◄─── lakebase_stt catalog ────◄──────┘
       (Delta, materialized by                  (single foreign catalog
        stt_human_verdicts pipeline,             pointing at the prod
        prod target only)                        Lakebase branch)
                              │
                              ▼
   stt_nlp_evaluation (MLflow)
       — now computes precision/recall
         per implementation against
         human verdicts (prod only)
```

## Detailed design

### 1. Lakehouse: `gold_nlp_disagreements` view

A new view in the gold layer (added to [`speech_to_text_asset_bundle/src/stt_gold_layer/`](../speech_to_text_asset_bundle/src/stt_gold_layer/)) that joins both silver NLP tables and selects rows where they disagree on any dimension. The view is defined for `${var.schema}`, so it materializes in every target's schema — but only the `audio_prod` materialization is consumed downstream by the verdict workflow.

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
| `entities_ai_query`, `entities_ai_func` | array of struct | both silver tables |
| `summary_cosine_similarity` | float | computed in view |
| `entity_jaccard_similarity` | float | computed in view |
| `disagreement_flags` | array of string | which dimensions disagreed |

The view is recomputed each gold-layer pipeline run.

### 2. Lakehouse → Lakebase sync

Use **Lakebase Sync** (Databricks managed Delta-to-Postgres sync) to materialize `audio_prod.gold_nlp_disagreements` into a Postgres table `review_queue`.

- Sync mode: **scheduled snapshot** per gold-layer pipeline run (the upstream pipeline is batch; a continuous sync isn't justified).
- Sync upserts on `call_id`. Rows whose status is `pending` are refreshed if the Lakehouse view changes; rows already `claimed` or `reviewed` are not overwritten (handled via Lakebase Sync's row-level filter or via a `BEFORE UPDATE` trigger).
- **Deployed only in the `prod` bundle target.** Source is hard-coded to `audio_prod.gold_nlp_disagreements`. Dev and per-developer bundle deploys skip this resource.
- Configure via a new bundle resource in [`speech_to_text_asset_bundle/resources/`](../speech_to_text_asset_bundle/resources/), e.g., `stt_review_queue_sync.lakebase_sync.yml`.

### 3. Lakebase schemas (Postgres)

```sql
-- Synced from audio_prod.gold_nlp_disagreements; app reads to populate the queue.
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
- DDL runs once against the production branch as part of Phase 0. Lakebase Sync auto-creates `review_queue` on first run; `nlp_verdicts` is the only strictly-required manual migration.

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

The bundle config in [`databricks.yml`](../stt-appkit-lakebase/databricks.yml) is unchanged — single app, fixed Postgres binding, no new variables. The app always talks to the production Lakebase branch.

### 5. Lakebase → Lakehouse: federation + verdicts pipeline

**One UC foreign catalog: `lakebase_stt`** registered during Phase 0, pointing at the production Lakebase database.

```sql
CREATE CONNECTION lakebase_stt
  TYPE POSTGRESQL
  OPTIONS (host '<lakebase-host>', port '5432', database 'db-idxm-pfkiwu5v4q', ...);

CREATE FOREIGN CATALOG lakebase_stt USING CONNECTION lakebase_stt;
```

This exposes `lakebase_stt.public.nlp_verdicts` as a readable Spark table.

**New pipeline `stt_human_verdicts`** in [`speech_to_text_asset_bundle/`](../speech_to_text_asset_bundle/):

- Resource file: `resources/stt_human_verdicts.pipeline.yml`
- Source: `src/stt_human_verdicts/` (Python SDP)
- Reads `lakebase_stt.public.nlp_verdicts` (federated) and `audio_prod.gold_call_detail` (Delta) on `call_id`.
- Deduplicates to the **latest** verdict per `(call_id, dimension)` (window over `reviewed_at DESC`).
- Materializes Delta table `audio_prod.gold_nlp_human_verdicts` with columns:
  - `call_id`, `dimension`, `winner`, `truth_value`, `notes`, `reviewer_email`, `reviewed_at`, plus joined gold-layer context (`audio_timestamp`, `topic_ai_query`, etc.)
- **Deployed only in the `prod` bundle target.** Orchestrated by the existing `stt_main` job — runs after `stt_gold_layer`.

### 6. MLflow eval extension

In [`speech_to_text_asset_bundle/src/stt_nlp_evaluation/`](../speech_to_text_asset_bundle/src/stt_nlp_evaluation/), extend the existing notebook to:

- Join `audio_prod.gold_nlp_human_verdicts` with the silver NLP tables on `call_id`
- For `winner ∈ {ai_query, ai_func}`: count as a correct label for that implementation
- For `winner = 'neither'`: count as miss for both, optionally use `truth_value` for further scoring
- Log per-implementation accuracy / precision / recall per `dimension` to MLflow, alongside the existing LLM-judge metrics

The MLflow run output gains four new metrics (or eight, four per implementation):

```text
ai_query_sentiment_accuracy   = correct / total verdicts on sentiment
ai_func_sentiment_accuracy    = ...
ai_query_topic_accuracy       = ...
ai_func_topic_accuracy        = ...
ai_query_summary_win_rate     = winner='ai_query' / (winner ∈ {ai_query,ai_func})
ai_func_summary_win_rate      = ...
... (entities similarly)
```

The notebook conditionally skips these metrics if `audio_prod.gold_nlp_human_verdicts` is empty or missing (so dev / per-developer eval runs degrade gracefully).

## Implementation phases

Each phase is independently shippable. Phase 0 must precede Phases 2, 4, and 5.

0. **Provisioning** (one-time, short):
   - Register the UC connection + foreign catalog `lakebase_stt` for the production Lakebase database.
   - Run the Postgres migration in the production database: `CREATE TABLE nlp_verdicts ...` (and optionally pre-create `review_queue` for clarity; Lakebase Sync will create it otherwise).
   - Document the commands in [`docs/DATABRICKS_SETUP.md`](DATABRICKS_SETUP.md).
1. **Disagreements view** — add `gold_nlp_disagreements` to `stt_gold_layer` (parameterized by `${var.schema}`, materialized per asset-bundle target; only the prod materialization is consumed by the verdict workflow). No app changes; verify the rows look right in the dashboard.
2. **Lakebase Sync** — configure the sync resource scoped to the `prod` bundle target. Verify rows appear in Postgres `review_queue` after a pipeline run.
3. **App rewrite** — replace todo routes / UI with the verdict workbench. Single deployment, no new bundle variables.
4. **Federation pipeline** — build `stt_human_verdicts` pipeline reading `lakebase_stt.public.nlp_verdicts`, writing `audio_prod.gold_nlp_human_verdicts`. Deploys in prod target only.
5. **MLflow eval integration** — extend the eval notebook with verdict-based metrics; guard with existence check so dev runs degrade gracefully.

Phases 1–3 deliver an internal review tool even before the loopback. Phases 4–5 deliver the analytical payoff.

## Open questions

- **Disagreement thresholds** — what cosine/Jaccard cutoffs catch meaningful disagreement without overwhelming reviewers? Start at 0.7 / 0.5 and tune from real volume.
- **Transcript size in `review_queue`** — sync the full transcript (could be long) vs. just `call_id` + audio reference. Full transcript keeps the app self-contained (no warehouse query per page view) at the cost of duplicated data. Start with full.
- **Lakebase Sync conflict policy** — how to handle a row that's `claimed`/`reviewed` in Lakebase if the upstream view drops it. Recommend: don't delete; mark with a `stale=true` flag the app filters out of new queues.
- **Reviewer auth** — Databricks Apps' on-behalf-of-user identity (uses `user_api_scopes`) vs. a simpler email captured from headers. The current `databricks.yml` has `user_api_scopes` commented out — enabling adds OAuth complexity. Decide whether to keep it simple for v1.
- **Audit / revision** — append-only `nlp_verdicts` means revisions create new rows. Is "latest wins" the right reconciliation rule, or do we need explicit revisioning UI?
- **Multi-tenant** — single workspace fine for v1; if multiple tenants/projects share the app later, add a `project_id` to both Postgres tables and to the Lakehouse view.
- **Dev testing strategy for the verdict subsystem** — read `audio_prod` data read-only? Manual `psql` inserts? Accept "no end-to-end dev test for this loop"? Decide before phase 3.

## Alternatives considered

- **Simpler generic call-review queue** (flag-for-follow-up, free-text notes). Useful but doesn't naturally need bidirectional flow — could be a one-way dashboard with annotations stored anywhere. Doesn't extend the existing MLflow eval.
- **Real-time triage** on negative-sentiment calls. Fights the architecture — the pipeline is batch, not streaming, so "real-time" would mean re-architecting upstream.
- **Topic-based routing to teams**. Single-direction; no compelling reason to push state back to the Lakehouse.
- **Dual-write from the app to both Postgres and Delta directly**. Avoids UC federation but creates two consistency problems (transactional + analytical). UC federation is the cleaner read-back path.
- **Per-environment Lakebase branches + per-developer deployed apps.** Documented in the prior design version (git commit `bf81348`). Each environment gets its own Lakebase branch + UC foreign catalog + deployed app. Provides full per-developer isolation but adds operational complexity (per-developer branch creation, per-developer UC connection setup, schema-aware federation routing, per-developer app deployments). Deferred until team size or compliance requires it. Lakebase scale-to-zero keeps idle branches cheap, so this upgrade is open without architectural blockers.

## Risks and non-goals

- **Not real-time.** Reviewers see calls hours after they happen — fine for evaluation, not for live agent assist.
- **Not a labeler-quality tool.** No inter-rater agreement, no calibration, no labeler-payment workflow. v1 assumes a small trusted team.
- **Not training data (yet).** The verdicts could fund a fine-tune in a future iteration, but v1 is evaluation only.
- **Not multi-environment.** Verdict storage lives in `audio_prod` only; dev and per-developer MLflow runs cannot compute verdict-based metrics natively. Accept for v1; revisit if/when the team scales.
- **Lakebase Sync GA status** — confirm the feature is available in the target workspace tier before committing to it; fallback is a scheduled Spark JDBC write job.
