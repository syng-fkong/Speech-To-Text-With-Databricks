# Backlog

Deferred work and open design decisions. Add new sections at the top; oldest at the bottom.

## Feature ideas to deepen the Lakehouse ↔ Lakebase demo story

**Captured:** 2026-05-14. Candidate features for [stt-appkit-lakebase/](stt-appkit-lakebase/) that go beyond the current verdict workbench. Grouped by the integration pattern each one would showcase; not yet scoped or sequenced. Rough recommended demo bundle: **#1 + #3 + #4** is the tightest 15-minute story; **#2** and **#8** are the strongest *narrative* additions because they show writes that change downstream Lakehouse behavior.

### A. Closing the RLHF loop (strongest demo story)

- **#1 — In-app evaluation dashboard tab.** New `/eval` page that runs a federated SQL query against Lakehouse (via Databricks SDK / SQL warehouse) over `gold_nlp_human_verdicts` + `gold_nlp_disagreements` and renders per-dimension human-vs-ai_query win rate (same metrics the MLflow notebook logs), reviewer throughput, agreement-with-majority, top topics with disagreement. Adds the missing third leg of the integration: app **reads from Lakehouse via UC**, not just sync-from + federate-back.
- **#2 — Free-text "preferred answer" capture.** Reviewer rewrites the summary / edits entities. Push to a new `app.nlp_corrections` table; federate back into Lakehouse alongside `gold_nlp_human_verdicts`; MLflow eval computes ROUGE / cosine vs the human-preferred answer instead of (or in addition to) the binary verdict. Showcases structured + unstructured writeback in the same federation pipeline.
- **#3 — AI third-opinion button.** "What does another model think?" calls Foundation Model APIs via `ai_query` (Claude Sonnet 4.6 or Llama as tie-breaker) and renders the verdict next to the two NLP implementations. Optionally persist into `app.nlp_meta_verdicts` for later comparison against human verdicts in eval.

### B. Showcasing Lakebase low-latency strengths

- **#4 — Live queue depth + reviewer presence.** Top bar shows "N disagreements pending · M reviewers active · you claimed K today". Use Postgres `LISTEN/NOTIFY` (or a 2s poll on `app.review_state`) for live updates. Lock a call to a reviewer while open ("Alex is reviewing this — claim anyway?"). Makes the OLTP value prop explicit — today Lakebase looks like just a fast read replica.
- **#5 — Bulk-mode triage.** Multi-select queue rows; submit "agree with ai_func for all of these" in one atomic Postgres transaction. Showcases transactional multi-row writes that then flow back through federation.

### C. Cross-system semantic features

- **#6 — Semantic transcript search.** Build a Vector Search index over `silver_audio_transcription`; expose a search box in the app that calls the VS index via the SDK. "Find similar calls" button on the detail page seeds the query with the current transcript. Showcases Vector Search + Lakebase as two operational Databricks data stores serving one app. Pairs naturally with #3.
- **#7 — Embedded Genie panel on the detail page.** Drop a Genie iframe / API call into a side panel, pre-filtered to the current call's topic/date. The Genie Space is already provisioned by the `stt_genie` job. Showcases AI/BI Genie + Lakebase OLTP + Lakehouse analytics in one screen.

### D. Write-back that changes pipeline behavior

- **#8 — Flag for re-transcription / re-enrichment.** Reviewer marks calls where transcription quality is poor or model output is nonsense. Writes to a new `app.reingest_requests` table; a SDP transformation reads it via federation and feeds those paths back into `stt_audio_transcription` with `temperature=0` / longer-context Whisper params. Different federation pattern from current (verdicts score already-processed calls; reingest requests change *what's processed next run*).

### Open questions before scoping any of these

- Which (if any) require new Lakebase tables outside the current `review_queue` / `review_state` / `nlp_verdicts` split? Anything new should follow the Phase 2.1 ownership rule: sync-owned vs app-owned.
- For #1 specifically: does the app's SP have SQL warehouse access? Need a warehouse handle, not just the Postgres connection.
- For #3 and #6: `ai_query` from inside the app vs from a serving endpoint — which is cheaper to wire and which makes a better demo narrative?
- For #8: closing the loop requires the next pipeline run to reset the request status. Where does that bookkeeping live — app-side or pipeline-side?

## NLP Verdict Workbench — replace todo template with a real use case

**Deferred:** 2026-05-13.
**Design doc:** [docs/NLP_VERDICT_WORKBENCH_DESIGN.md](docs/NLP_VERDICT_WORKBENCH_DESIGN.md).

The current `stt-appkit-lakebase` app is the AppKit todo CRUD template — it doesn't use any of the analytical data from `speech_to_text_asset_bundle`. Proposed replacement: a human-in-the-loop review tool where reviewers pick winners between the two NLP implementations (`silver_audio_nlp_ai_query` vs `silver_audio_nlp_ai_func`), and verdicts feed back into the existing MLflow evaluation as ground truth.

Demonstrates Lakehouse ↔ Lakebase end-to-end:

- **Lakehouse → Lakebase:** new `gold_nlp_disagreements` view → Lakebase Sync → Postgres `review_queue`
- **Lakebase → Lakehouse:** Postgres `nlp_verdicts` → UC foreign catalog → new `stt_human_verdicts` SDP pipeline → Delta `gold_nlp_human_verdicts` → consumed by `stt_nlp_evaluation` MLflow notebook

Anchored to a **single Lakebase branch + single deployed app + `audio_prod` schema** — both Lakebase Sync (read) and the federation pipeline (write) live in the prod bundle target only. Multi-environment scaling (per-developer branches, per-env UC catalogs, per-developer apps) deliberately deferred because the operational complexity isn't justified for current team size; the multi-branch design is preserved at commit `bf81348` and remains the upgrade path. The asset bundle's existing multi-schema pattern for transcription/NLP is unchanged.

Six independently-shippable phases:

0. **Provisioning** (one-time, short).
   - 0.1 UC catalog registration — **DONE** (2026-05-14). UC foreign catalog `lakebase_stt` registered against the production Lakebase database. The working API body shape (found via Databricks docs after CLI/error-message probing failed): `POST /api/2.0/postgres/catalogs?catalog_id=<name>` with body `{"spec": {"postgres_database": "databricks_postgres", "branch": "projects/speech-to-text/branches/production"}}`. The federation works — `SHOW TABLES IN lakebase_stt.app` lists the Postgres tables.
   - 0.2 Postgres `nlp_verdicts` migration — folded into Phase 3 (app provisions at startup via `CREATE TABLE IF NOT EXISTS`).
1. **Disagreements view** — **DONE** (commit pending). `gold_nlp_disagreements` added at [speech_to_text_asset_bundle/src/stt_gold_layer/transformations/gold_nlp_disagreements.py](speech_to_text_asset_bundle/src/stt_gold_layer/transformations/gold_nlp_disagreements.py). Uses entity Jaccard + sentiment/topic categorical mismatch as disagreement triggers. `summary_cosine_similarity` deferred (NULL placeholder column) — would need an embedding lookup.
2. **Lakebase Sync** — **MOSTLY DONE** (2026-05-14). Sync is registered, snapshot ran, 1 row materialised in Postgres `app.review_queue` (verified via UC federation `SELECT FROM lakebase_stt.app.review_queue`). Working API body shape: `POST /api/2.0/postgres/synced_tables?synced_table_id=lakebase_stt.app.review_queue` with `{"spec": {"source_table_full_name": "...", "branch": "...", "postgres_database": "databricks_postgres", "primary_key_columns": ["path"], "scheduling_policy": "SNAPSHOT", "create_database_objects_if_missing": true}}`.
   - **SNAPSHOT (not TRIGGERED)** is required because `gold_nlp_disagreements` is a DLT MATERIALIZED_VIEW; the error message is the giveaway: `Table type MATERIALIZED_VIEW ... is not supported as a source in online materialized views in incremental mode but is supported in full-copy mode.`
   - **Bundle path doesn't work** for autoscale Lakebase — the bundle resource `synced_database_tables` and Terraform provider `databricks_database_synced_database_table` only support the *provisioned* variety. Workaround: invoke the API directly (until the bundle/Terraform provider catches up — see [terraform-provider-databricks#5456](https://github.com/databricks/terraform-provider-databricks/issues/5456)). Eventually this should become a bundle resource.
   - **Phase 2.1 follow-up: DONE** (2026-05-14). Split the data: `review_queue` is sync-owned and read-only; new `app.review_state(path PK, status, claimed_by, claimed_at, updated_at)` is app-owned for workflow state. Queue list/detail LEFT JOIN review_state and COALESCE(status, 'pending'). Claim is `INSERT ... ON CONFLICT DO UPDATE WHERE status='pending'` (atomic, no race). Verdict submission CTE writes to nlp_verdicts AND upserts review_state to 'reviewed' in one statement. Also: the sync-owned `review_queue` is owned by `databricks_writer_NNN`, NOT the app SP — required a one-time `GRANT SELECT ON TABLE app.review_queue TO "<APP_SP_UUID>"` via `databricks psql` (needs libpq installed locally: `brew install libpq && export PATH=/opt/homebrew/opt/libpq/bin:$PATH`). End-to-end claim→verdict→list flow verified.
   - Path/call_id naming decision: resolved — Postgres column is `path` (matches upstream gold view).
3. **App rewrite** — **DONE** (deployed). Verdict workbench replaces the todo CRUD: queue list + diff-and-verdict detail page. App auto-provisions `app.review_queue` and `app.nlp_verdicts` at startup (note: Postgres schema is `app`, not `public` — SP lacks CREATE on `public`. Phase 2 sync target needs to use `app.review_queue` accordingly). Reviewer identity from `X-Forwarded-Email`. End-to-end queue→verdict flow not yet exercised against real data — waits for Phase 2 to produce rows (or manual psql seed if testing sooner).
4. **Federation pipeline** — **DONE** (2026-05-14). Added as a new `@dp.table` in the existing `stt_gold_layer` (not a separate pipeline as originally designed — same compute, simpler). Reads `lakebase_stt.app.nlp_verdicts` via UC federation, deduplicates to the latest verdict per `(path, dimension)`, left-joins with `gold_audio_sentiment_analysis` for call context, writes `${var.schema}.gold_nlp_human_verdicts`. End-to-end loopback verified: verdict submitted via app → re-ran gold pipeline → row appeared in `audio_fkong.gold_nlp_human_verdicts`.
5. **MLflow eval integration** — **DONE** (2026-05-14). Added a markdown + code cell to [nlp_quality_evaluation.ipynb](speech_to_text_asset_bundle/src/stt_nlp_evaluation/evaluation/nlp_quality_evaluation.ipynb) that reads `gold_nlp_human_verdicts`, computes per-dimension win-rate metrics (ai_query / ai_func / neither / both_acceptable, plus decisive-win-rate), and logs them to a new `human_verdicts_summary` MLflow run. Gracefully skips when the verdicts table is missing or empty. Also resequenced the [stt_main job](speech_to_text_asset_bundle/resources/stt_main.job.yml): `evaluate_nlp_quality` now depends on `run_gold_layer_pipeline` (was on `run_nlp_enrichment_pipeline` — they ran in parallel) so the eval reads the latest verdict snapshot. Verified by running the eval task and inspecting the MLflow run.

Full schemas, route shapes, wiring rule, open questions, alternatives, and the deferred multi-environment design in [docs/NLP_VERDICT_WORKBENCH_DESIGN.md](docs/NLP_VERDICT_WORKBENCH_DESIGN.md).

## Tiny cleanups (low priority)

- **Drop orphan `app.todos` Postgres table.** Left over from the AppKit-Lakebase todo template (Phase 3 replaced the code but the original table is owned by the app SP and can't be dropped from `databricks psql` as a human user). Harmless (empty, unused). To clean up: temporarily add a `DROP TABLE app.todos` to the app's startup setup or a one-shot admin route, deploy once, then remove. Not worth a deploy cycle on its own — bundle it with a future Phase 3 change.

## CI/CD for `stt-appkit-lakebase` app

**Deferred:** 2026-05-12.
**Goal:** push to `dev` (and later `main`) auto-deploys the app, mirroring the existing pattern in [`speech_to_text_asset_bundle/`](speech_to_text_asset_bundle/) ([`.github/workflows/deploy_adb_dev.yml`](.github/workflows/deploy_adb_dev.yml), [`.github/workflows/deploy_adb_prod.yml`](.github/workflows/deploy_adb_prod.yml)).

### Prerequisites (must do before the workflow can run as the SP)

- [ ] **Service-principal write access to bundle staging.** Add `workspace.root_path: /Workspace/Shared/.bundle/${bundle.name}/${bundle.target}` to [`stt-appkit-lakebase/databricks.yml`](stt-appkit-lakebase/databricks.yml). The bundle currently resolves to `fkong`'s home folder, which the SP `sp-speech-to-text` cannot write to. Mirrors the asset bundle's pattern.
- [ ] **Grant SP `CAN_MANAGE` on the app.** Either declare in the app's `permissions:` block inside `databricks.yml`, or grant once via UI/CLI. The app was created by `fkong`, so the SP has no manage rights yet.

### Design decisions to pick

- [ ] **Dev-only or Dev + Prod from day one?**
  - **Option a** (simpler): rename target `default` → `dev` in `databricks.yml`, write a single `deploy_app_dev.yml`. Defer prod.
  - **Option b** (mirrors asset bundle): rename `default` → `dev`, add a `prod` target with a different app name (e.g. `stt-appkit-lakebase-prod`) + separate Postgres branch + a second workflow.
- [ ] **Dev's Postgres binding.** Today the bundle's dev target binds to `projects/speech-to-text/branches/production`. If splitting dev/prod, pick or create a non-prod Lakebase branch for dev so prod data isn't touched on every dev deploy.

### Workflow skeleton (apply after prerequisites resolved)

New file `.github/workflows/deploy_app_dev.yml` (and `_prod.yml` if option b). Reuses the same GitHub Environments (`Dev`/`Prod`) and secrets/vars (`DATABRICKS_HOST`, `DATABRICKS_CLIENT_ID`) already configured for the asset bundle.

```yaml
name: Deploy App Dev
concurrency: app_dev_environment
on:
  push:
    branches: [dev]
    paths:
      - 'stt-appkit-lakebase/**'
      - '.github/workflows/deploy_app_*.yml'
permissions: { id-token: write, contents: read }
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: Dev
    env:
      DATABRICKS_AUTH_TYPE: github-oidc
      DATABRICKS_HOST:       ${{ vars.DATABRICKS_HOST }}
      DATABRICKS_CLIENT_ID:  ${{ secrets.DATABRICKS_CLIENT_ID }}
    steps:
      - uses: actions/checkout@v3
      - uses: databricks/setup-cli@main
      - working-directory: ./stt-appkit-lakebase
        run: databricks bundle validate
      - working-directory: ./stt-appkit-lakebase
        run: databricks bundle deployment bind app stt-appkit-lakebase --auto-approve || true
      - working-directory: ./stt-appkit-lakebase
        run: databricks bundle deploy --auto-approve
      - working-directory: ./stt-appkit-lakebase
        run: databricks bundle run app
```

Notes:

- No Node setup needed on the runner — Databricks Apps installs Node and runs `npm install`/`build`/`start` on the app's compute per `app.yaml`.
- No `--var` flags needed; Postgres values are inline in `databricks.yml`.
- `bundle run app` blocks until the new app version starts (or fails) — so a failed deploy fails the workflow.
