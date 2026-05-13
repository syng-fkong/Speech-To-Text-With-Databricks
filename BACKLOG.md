# Backlog

Deferred work and open design decisions. Add new sections at the top; oldest at the bottom.

## NLP Verdict Workbench — replace todo template with a real use case

**Deferred:** 2026-05-13.
**Design doc:** [docs/NLP_VERDICT_WORKBENCH_DESIGN.md](docs/NLP_VERDICT_WORKBENCH_DESIGN.md).

The current `stt-appkit-lakebase` app is the AppKit todo CRUD template — it doesn't use any of the analytical data from `speech_to_text_asset_bundle`. Proposed replacement: a human-in-the-loop review tool where reviewers pick winners between the two NLP implementations (`silver_audio_nlp_ai_query` vs `silver_audio_nlp_ai_func`), and verdicts feed back into the existing MLflow evaluation as ground truth.

Demonstrates Lakehouse ↔ Lakebase end-to-end:

- **Lakehouse → Lakebase:** new `gold_nlp_disagreements` view → Lakebase Sync → Postgres `review_queue`
- **Lakebase → Lakehouse:** Postgres `nlp_verdicts` → UC foreign catalog → new `stt_human_verdicts` SDP pipeline → Delta `gold_nlp_human_verdicts` → consumed by `stt_nlp_evaluation` MLflow notebook

Anchored to a **single Lakebase branch + single deployed app + `audio_prod` schema** — both Lakebase Sync (read) and the federation pipeline (write) live in the prod bundle target only. Multi-environment scaling (per-developer branches, per-env UC catalogs, per-developer apps) deliberately deferred because the operational complexity isn't justified for current team size; the multi-branch design is preserved at commit `bf81348` and remains the upgrade path. The asset bundle's existing multi-schema pattern for transcription/NLP is unchanged.

Six independently-shippable phases:

0. **Provisioning** (one-time, short) — register UC connection + foreign catalog `lakebase_stt` for the production Lakebase database; run `CREATE TABLE nlp_verdicts` migration.
   - 0.1 UC catalog registration — **DEFERRED**. The `databricks postgres create-catalog` API rejected every JSON body shape probed on 2026-05-13; the correct schema for the request body wasn't discoverable from the CLI help, REST error messages, or generic field-name probing. Will pick up when Phase 4 (federation pipeline) actually needs the catalog and we can get authoritative API docs.
   - 0.2 Postgres `nlp_verdicts` migration — folded into Phase 3 (the app provisions its own tables at startup via `CREATE TABLE IF NOT EXISTS`, matching the existing todo-routes pattern).
1. **Disagreements view** — **DONE** (commit pending). `gold_nlp_disagreements` added at [speech_to_text_asset_bundle/src/stt_gold_layer/transformations/gold_nlp_disagreements.py](speech_to_text_asset_bundle/src/stt_gold_layer/transformations/gold_nlp_disagreements.py). Uses entity Jaccard + sentiment/topic categorical mismatch as disagreement triggers. `summary_cosine_similarity` deferred (NULL placeholder column) — would need an embedding lookup.
2. **Lakebase Sync** — single sync resource, prod target only, reads `audio_prod.gold_nlp_disagreements` → Postgres `review_queue`. **Naming decision pending**: upstream uses `path` (file path) as the natural primary key; should Postgres `review_queue` keep the column name `path` (lossless) or rename to `call_id` (more domain-like)? Decide before writing the sync resource.
3. **App rewrite** — **DONE** (deployed). Verdict workbench replaces the todo CRUD: queue list + diff-and-verdict detail page. App auto-provisions `app.review_queue` and `app.nlp_verdicts` at startup (note: Postgres schema is `app`, not `public` — SP lacks CREATE on `public`. Phase 2 sync target needs to use `app.review_queue` accordingly). Reviewer identity from `X-Forwarded-Email`. End-to-end queue→verdict flow not yet exercised against real data — waits for Phase 2 to produce rows (or manual psql seed if testing sooner).
4. **Federation pipeline** — `stt_human_verdicts` reads `lakebase_stt.public.nlp_verdicts`, writes `audio_prod.gold_nlp_human_verdicts`. Prod target only. Blocked on Phase 0.1.
5. **MLflow eval integration** — verdict-based metrics in the existing eval notebook; gracefully skipped in dev runs.

Full schemas, route shapes, wiring rule, open questions, alternatives, and the deferred multi-environment design in [docs/NLP_VERDICT_WORKBENCH_DESIGN.md](docs/NLP_VERDICT_WORKBENCH_DESIGN.md).

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
