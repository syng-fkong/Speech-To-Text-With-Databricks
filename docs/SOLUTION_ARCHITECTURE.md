# Solution Architecture

**Purpose:** Single-page architectural overview of the Speech-to-Text solution. For component-level detail, follow the links into the per-component references.

**Scope:** Medallion layout, end-to-end data flow, Lakehouse ↔ Lakebase integration, deployment topology. Operational specifics (config, troubleshooting, API bodies) live in the per-component docs.

---

## High-level shape

Two deployment units share one Unity Catalog catalog (`speech_to_text`) and one Lakebase Postgres branch:

| Unit | Purpose | Owns | Doc |
| --- | --- | --- | --- |
| [speech_to_text_asset_bundle/](../speech_to_text_asset_bundle/) | Analytical pipeline (Bronze → Silver → Gold) and MLflow evaluation | Schemas, volumes, SDP pipelines, jobs, dashboard, Genie Space | [bundle README](../speech_to_text_asset_bundle/README.md) |
| [stt-appkit-lakebase/](../stt-appkit-lakebase/) | NLP Verdict Workbench Databricks App | Postgres tables `app.review_state`, `app.nlp_verdicts`; reads sync-owned `app.review_queue` | [app README](../stt-appkit-lakebase/README.md) |

The integration between them is the subject of [LAKEHOUSE_LAKEBASE_INTEGRATION.md](LAKEHOUSE_LAKEBASE_INTEGRATION.md).

---

## End-to-end data flow

![Pipeline](images/DataflowDiagram.png)

1. **Bronze (ingestion)** — Auto Loader watches `/Volumes/{catalog}/{schema}/files/`, writes file metadata to `bronze_audio_files_raw`. Supported extensions: `.wav .mp3 .flac .m4a .ogg .mp4`.
2. **Silver (transcription)** — Whisper Large V3 transcribes via Model Serving (`ai_query()`), writes `silver_audio_transcription`.
3. **Silver (NLP enrichment, dual implementation)** — Each transcription is enriched twice:
   - `silver_audio_nlp_ai_func` via Databricks AI SQL functions (`ai_analyze_sentiment`, `ai_summarize`, `ai_extract`, `ai_classify`, `ai_translate`)
   - `silver_audio_nlp_ai_query` via Foundation Model API (`databricks-meta-llama-3-3-70b-instruct` through `ai_query()`)
4. **Gold (analysis tables)** — `gold_audio_sentiment_analysis` (detail), `gold_audio_daily_stats`, `gold_audio_sentiment_by_topic` (aggregates), `gold_nlp_disagreements` (verdict workbench feed), `gold_nlp_human_verdicts` (federated from Lakebase).
5. **MLflow evaluation** — `nlp_quality_evaluation.ipynb` scores both NLP implementations with deterministic validators and LLM judges, plus per-dimension human-verdict win rates from `gold_nlp_human_verdicts`. Logs to `/Shared/nlp-quality-evaluation`.

The `stt_main` job orchestrates these steps. Evaluation depends on the gold layer (not parallel to it) so human-verdict metrics reflect the latest snapshot.

---

## Lakehouse ↔ Lakebase integration

Closes the loop between the analytical pipeline and the OLTP review app:

- **Lakehouse → Lakebase:** Lakebase Sync (SNAPSHOT mode) materialises `gold_nlp_disagreements` into Postgres `app.review_queue`. SNAPSHOT is required because the source is a DLT MATERIALIZED_VIEW.
- **App workflow:** reviewers claim a row (atomic `INSERT ... ON CONFLICT DO UPDATE` on `app.review_state`), pick a winner per dimension (sentiment/topic/summary/entities), and submit a verdict (single CTE writes both `app.nlp_verdicts` and `app.review_state`).
- **Lakebase → Lakehouse:** UC foreign catalog `lakebase_stt` federates the Postgres tables; the `gold_nlp_human_verdicts` table reads `lakebase_stt.app.nlp_verdicts` via federation, dedupes to the latest per `(path, dimension)`, joins with gold context. MLflow evaluation reads it for win-rate metrics.

The integration is anchored to a **single Lakebase branch + single deployed app + `audio_prod` schema** by design. See [NLP_VERDICT_WORKBENCH_DESIGN.md](NLP_VERDICT_WORKBENCH_DESIGN.md) for the rationale; see [LAKEHOUSE_LAKEBASE_INTEGRATION.md](LAKEHOUSE_LAKEBASE_INTEGRATION.md) for the operational reference (working API bodies, GRANT recipe, troubleshooting).

---

## Unity Catalog layout

```text
speech_to_text (catalog)
├── audio_dev    (CI/CD dev — owned by service principal)
├── audio_prod   (CI/CD prod — owned by service principal; source of Lakebase Sync)
├── audio_<shortname>  (per-developer local dev — owned by the developer)
└── lakebase_stt (foreign catalog over the production Lakebase branch)
    └── app.review_queue / app.review_state / app.nlp_verdicts
```

Each `audio_*` schema contains the full bronze / silver / gold table set plus a managed `files` volume.

---

## Deployment topology

| Path | Identity | When |
| --- | --- | --- |
| Local bundle deploy | Human user, schema `audio_<shortname>` | Developer workflow |
| GitHub Actions push to `dev` | Service principal via OIDC, schema `audio_dev` | [deploy_adb_dev.yml](../.github/workflows/deploy_adb_dev.yml) |
| GitHub Actions push to `main` | Service principal via OIDC, schema `audio_prod` | [deploy_adb_prod.yml](../.github/workflows/deploy_adb_prod.yml) |
| App deploy | Currently manual (`databricks bundle deploy` in `stt-appkit-lakebase/`) | CI/CD deferred — see [BACKLOG.md](../BACKLOG.md) |

Shared resources (Whisper Model Serving endpoint, Genie Space, Lakebase foreign catalog, Lakebase Sync) live outside the bundle lifecycle and are provisioned by dedicated jobs or one-off API calls; see the bundle README and the integration doc.

---

## Where to go next

- **Pipeline / table / job detail:** [speech_to_text_asset_bundle/README.md](../speech_to_text_asset_bundle/README.md)
- **App / verdict workbench detail:** [stt-appkit-lakebase/README.md](../stt-appkit-lakebase/README.md)
- **Integration as-built reference:** [LAKEHOUSE_LAKEBASE_INTEGRATION.md](LAKEHOUSE_LAKEBASE_INTEGRATION.md)
- **Integration design rationale:** [NLP_VERDICT_WORKBENCH_DESIGN.md](NLP_VERDICT_WORKBENCH_DESIGN.md)
- **Setup (Databricks side):** [DATABRICKS_SETUP.md](DATABRICKS_SETUP.md)
- **Setup (GitHub side):** [GITHUB_ACTIONS_SETUP.md](GITHUB_ACTIONS_SETUP.md)
- **Backlog and per-phase implementation notes:** [BACKLOG.md](../BACKLOG.md)
