# Speech-to-Text Databricks Asset Bundle

[![Databricks](https://img.shields.io/badge/Databricks-FF3621?style=for-the-badge&logo=databricks&logoColor=white)](https://databricks.com)
[![Whisper Large V3](https://img.shields.io/badge/Whisper_Large_V3-412991?style=for-the-badge&logo=openai&logoColor=white)](https://openai.com/research/whisper)
[![LLaMA 3.3 70B](https://img.shields.io/badge/LLaMA_3.3_70B-0467DF?style=for-the-badge&logo=meta&logoColor=white)](https://ai.meta.com/blog/llama-3-3/)
[![MLflow](https://img.shields.io/badge/MLflow-0194E2?style=for-the-badge&logo=mlflow&logoColor=white)](https://mlflow.org)
[![Apache Spark](https://img.shields.io/badge/Apache_Spark-E25A1C?style=for-the-badge&logo=apachespark&logoColor=white)](https://spark.apache.org)

## Overview

This Databricks Asset Bundle implements an end-to-end speech-to-text processing solution using the Databricks Lakehouse platform. The solution ingests audio files from contact center recordings, tracks them through a Bronze → Silver medallion pipeline, and prepares the data for downstream transcription and analysis.

### Data Source

The audio files used in this solution are sourced from:

- **Dataset**: [AxonData English Contact Center Audio Dataset](https://huggingface.co/datasets/AxonData/english-contact-center-audio-dataset/tree/main)
- **Storage**: Files have been downloaded from HuggingFace and uploaded to the Databricks **`files` volume** in the catalog

This dataset contains English language audio recordings from contact center scenarios, providing realistic use cases for speech-to-text analysis.

---

## Solution Architecture

![Databricks Audio Intelligence Pipeline](../docs/images/DataflowDiagram.png)

The solution follows a medallion architecture to process audio files through multiple stages:

### Processing Flow

1. **Data Ingestion — Bronze** ✅
   - Audio files stored in `/Volumes/{catalog}/{schema}/files/` are continuously tracked via Auto Loader
   - File metadata (path, size, modification time) is captured as a streaming Delta table: `bronze_audio_files_raw`
   - Supported formats: `wav`, `mp3`, `flac`, `m4a`, `ogg`, `mp4`

2. **Transcription — Silver** ✅
   - Bronze records are transcribed via the Whisper Large V3 Model Serving endpoint using `ai_query()`
   - Output: `silver_audio_transcription` with `transcription_text` per file

3. **NLP Enrichment — Silver** ✅
   - Each transcription is enriched with sentiment, summary, named entities, topic classification, and Italian translation
   - Two parallel implementations are produced for quality comparison:
     - `silver_audio_nlp_ai_func` — Databricks built-in AI SQL functions
     - `silver_audio_nlp_ai_query` — Foundation Model API via `ai_query()`

4. **Gold Layer — Analysis-Ready Tables** ✅
   - Joins NLP enrichment with transcription metadata, flattens entity structs, adds derived metrics
   - Three output tables for dashboards and ad-hoc analysis:
     - `gold_audio_sentiment_analysis` — full detail table (one row per transcription)
     - `gold_audio_daily_stats` — daily aggregation by date × topic × sentiment
     - `gold_audio_sentiment_by_topic` — sentiment distribution cross-tab per business domain

5. **NLP Quality Evaluation** ✅
   - MLflow GenAI evaluation notebook compares both silver NLP implementations with deterministic validators and LLM judges
   - Results logged to `/Shared/nlp-quality-evaluation` experiment

6. **AI/BI Dashboard** ✅
   - Lakeview dashboard deployed via Asset Bundle on top of the gold layer tables
   - Two pages: **Overview** (KPIs, sentiment × topic bar chart, daily volume, detail table) and **Global Filters** (date range, topic, sentiment)
   - Dashboard file: `src/dashboards/stt_analytics.lvdash.json`

7. **Genie Space** ✅
   - Natural language interface for querying the gold layer tables
   - Genie Space is not yet a native DABs resource type; it is provisioned by the `stt_genie_setup` job which calls the Databricks REST API via the Python SDK
   - Setup notebook: `src/stt_genie/create_genie_space.py` (idempotent — safe to re-run)

---

## Project Structure

```text
speech_to_text_asset_bundle/
├── databricks.yml                                  # Bundle config: variables, targets (dev/prod)
├── databricks.local.yml.example                    # Template for per-developer local overrides (committed)
├── databricks.local.yml                            # Your local overrides — git-ignored, not committed
├── pyproject.toml                                  # Python project config and dev dependencies
├── resources/
│   ├── stt_audio_transcription.pipeline.yml        # Bronze + Silver transcription pipeline
│   ├── stt_nlp_enrichment.pipeline.yml             # Silver NLP enrichment pipeline
│   ├── stt_gold_layer.pipeline.yml                 # Gold aggregation pipeline
│   ├── stt_dashboard.dashboard.yml                 # AI/BI dashboard resource
│   ├── stt_infrastructure.job.yml                  # One-time job: create shared Whisper endpoint
│   ├── stt_genie.job.yml                           # Genie Space setup job
│   └── stt_main.job.yml                            # Orchestration job
└── src/
    ├── stt_audio_transcription/transformations/
    │   ├── bronze_audio_files.py                   # Auto Loader → bronze_audio_files_raw
    │   └── silver_audio_files.py                   # Whisper → silver_audio_transcription
    ├── stt_nlp_enrichment/transformations/
    │   ├── silver_audio_nlp_ai_func.py             # NLP via AI SQL functions
    │   └── silver_audio_nlp_ai_query.py            # NLP via Foundation Model (ai_query)
    ├── stt_gold_layer/transformations/
    │   ├── gold_audio_sentiment_analysis.py        # Gold detail table (flattened entities, metrics)
    │   └── gold_aggregates.py                      # gold_audio_daily_stats + gold_audio_sentiment_by_topic
    ├── dashboards/
    │   └── stt_analytics.lvdash.json               # AI/BI dashboard definition (Lakeview format)
    ├── stt_infrastructure/
    │   └── create_whisper_endpoint.py              # Notebook: create/update shared Whisper endpoint
    ├── stt_genie/
    │   └── create_genie_space.py                   # Notebook: create/update Genie Space via SDK
    └── stt_nlp_evaluation/evaluation/
        └── nlp_quality_evaluation.ipynb            # MLflow GenAI evaluation notebook
```

### `/resources/`

Contains YAML definitions for all Databricks resources:

- **`stt_audio_transcription.pipeline.yml`** — Serverless SDP pipeline: Bronze (Auto Loader) → Silver (Whisper transcription via `ai_query()`).
- **`stt_nlp_enrichment.pipeline.yml`** — Serverless SDP pipeline: enriches `silver_audio_transcription` with sentiment, summary, entities, topic, and translation. Produces two implementations for quality comparison.
- **`stt_gold_layer.pipeline.yml`** — Serverless SDP pipeline: builds analysis-ready gold tables from the NLP-enriched silver data. Flattens entity structs, adds derived metrics, and produces daily and topic/sentiment aggregations.
- **`stt_dashboard.dashboard.yml`** — AI/BI (Lakeview) dashboard resource. Points to `src/dashboards/stt_analytics.lvdash.json` and resolves the catalog/schema at deploy time via `dataset_catalog` / `dataset_schema`, so the same JSON works in both dev and prod.
- **`stt_infrastructure.job.yml`** — One-time job that creates or updates the shared Whisper Model Serving endpoint and grants `CAN_QUERY` to all workspace users. The endpoint is **not** managed by the bundle lifecycle (to avoid ownership conflicts between developers and the CI/CD service principal) — run this job once after the first deployment and whenever the endpoint configuration needs to change. Idempotent.
- **`stt_genie.job.yml`** — One-time setup job that creates or updates the Genie Space by running `src/stt_genie/create_genie_space.py`. Idempotent: matches by display name and updates if found, creates otherwise. Run after the first deployment and whenever the space configuration changes.
- **`stt_main.job.yml`** — Orchestration job that chains all three pipelines in sequence, then runs the MLflow evaluation notebook in parallel with the gold layer update.

### `/src/stt_gold_layer/transformations/`

- **`gold_audio_sentiment_analysis.py`** — Gold detail table. Joins `silver_audio_nlp_ai_query` (selected for its richer, more contextual summaries) with `silver_audio_transcription`, normalises `sentiment` and `topic` to lowercase, flattens the `entities` STRUCT into individual columns (`entities_person`, `entities_organization`, `entities_location`, `entities_date`, `entities_amount`), and derives `transcription_length` and `transcription_word_count`. Clustered by `_ingested_date`, `topic`, `sentiment`.
- **`gold_aggregates.py`** — Two aggregate tables:
  - `gold_audio_daily_stats` — counts, unique files, avg length/word count grouped by `_ingested_date × topic × sentiment`
  - `gold_audio_sentiment_by_topic` — pivot table with topics as rows and sentiment labels as columns (counts per cell)

#### Auto Loader Schema Metadata

Schema inference metadata for Auto Loader is stored at:

```text
/Volumes/{catalog}/{schema}/files/_schema_metadata/bronze_audio_files
```

This path is configured via the `schema_location_base` pipeline parameter and is kept separate from the source audio files to avoid permission conflicts.

---

## Configuration & Deployment

### Prerequisites

Before deploying, ensure you have:

1. Databricks workspace access with appropriate permissions
2. Databricks CLI installed and configured
3. Required catalog created: `speech_to_text` (must be created manually in Databricks)
4. Service principal configured (for production deployments via GitHub Actions)

### Environment Targets

The bundle supports two deployment targets:

#### **Dev Target** (Default)

- **Catalog**: `speech_to_text`
- **Schema**: `audio` (CI/CD) · `audio_<shortname>` (local developer override — see below)
- **Mode**: Development (pipelines run in development mode)
- **Deployment path**: `/Workspace/Shared/.bundle/speech_to_text_asset_bundle/dev` (CI/CD) · `/Workspace/Users/<email>/.bundle/…` (local)
- **Resources created**: schema + `files` managed volume

#### **Prod Target**

- **Catalog**: `speech_to_text`
- **Schema**: `audio`
- **Mode**: Production
- **Deployment path**: `/Workspace/Shared/.bundle/speech_to_text_asset_bundle/prod`
- **Resources created**: schema (volume is not re-created in prod)

### Variables

| Variable                | Description                                                                                 | Default                                  |
|-------------------------|---------------------------------------------------------------------------------------------|------------------------------------------|
| `catalog`               | Unity Catalog name                                                                          | `speech_to_text`                         |
| `schema`                | Schema within the catalog                                                                   | `audio`                                  |
| `service_principal_id`  | Application ID (UUID) of the service principal                                              | _(required)_                             |
| `stt_model`             | Whisper Model Serving endpoint used for audio transcription via `ai_query()`                | `stt-whisper-large-v3`                   |
| `nlp_model`             | Foundation Model API endpoint used for NLP tasks via `ai_query()`                           | `databricks-meta-llama-3-3-70b-instruct` |
| `gold_nlp_source_table` | Silver NLP table used as gold layer source (`silver_audio_nlp_ai_query` or `_ai_func`)      | `silver_audio_nlp_ai_query`              |
| `warehouse_id`          | SQL warehouse for dashboard queries (resolved by warehouse name lookup)                     | _(lookup: Serverless Starter Warehouse)_ |
| `genie_space_name`      | Display name of the Genie Space                                                             | `Speech to Text Analytics`               |

### Deployment

#### Local development

Local deployment runs as **your human user** (not the service principal) and uses an isolated schema so your data never collides with other developers or the CI/CD environment.

**One-time setup**:

```bash
cp databricks.local.yml.example databricks.local.yml
# Edit databricks.local.yml: fill in workspace host, your email, and the SP UUID
```

After that, no `--var` flags are needed — `databricks.local.yml` is picked up automatically:

```bash
# Validate
databricks bundle validate --target dev

# Deploy (schema resolves to audio_<your-short-name>)
databricks bundle deploy --target dev

# Run the full pipeline
databricks bundle run stt_main --target dev
```

See `databricks.local.yml.example` for the full template and comments.

**First deployment only**: run the `stt_infrastructure_setup` job once to create the shared Whisper endpoint:

```bash
databricks bundle run stt_infrastructure_setup --target dev
```

This job is idempotent — safe to re-run if the endpoint configuration changes.

#### CI/CD (GitHub Actions)

CI/CD authenticates as the service principal via GitHub OIDC. `databricks.local.yml` is never present in the CI runner — the bundle uses only `databricks.yml` defaults.

| Event          | Workflow                                    | What it does                                                                                              |
|----------------|---------------------------------------------|-----------------------------------------------------------------------------------------------------------|
| Push to `dev`  | `sync_git_folder_and_deploy_adb_dev.yml`    | Syncs Git folder in workspace → validates → plans → binds pre-existing resources → deploys to dev target  |
| Push to `main` | `sync_git_folder_and_deploy_adb_prod.yml`   | Deploys to prod target (no Git folder sync)                                                               |

The **bind** step (`databricks bundle deployment bind`) imports pre-existing Unity Catalog resources (schema, volume) into the bundle's Terraform state so they are managed in-place rather than re-created. It runs with `|| true` so a first-time deployment (where those resources don't exist yet) is non-fatal.

See [docs/GITHUB_ACTIONS_SETUP.md](../docs/GITHUB_ACTIONS_SETUP.md) for environment and secret configuration.

---

## Development Workflow

### Local Development Setup

1. **Copy and fill in the local config template**

   ```bash
   cp databricks.local.yml.example databricks.local.yml
   ```

   Edit `databricks.local.yml` and set:
   - `workspace.host` — your Databricks workspace URL
   - `workspace.root_path` — your personal path (e.g. `/Workspace/Users/<your-email>/.bundle/…`)
   - `service_principal_id` — the project SP UUID (ask your team lead)

   The `schema` variable resolves automatically to `audio_<your-short-name>` via `${workspace.current_user.short_name}` — no manual editing needed.

2. **Install dependencies**

   ```bash
   pip install uv
   uv sync
   ```

3. **Deploy to dev**

   ```bash
   cd speech_to_text_asset_bundle
   databricks bundle deploy --target dev
   ```

4. **First-time only: provision the shared Whisper endpoint**

   ```bash
   databricks bundle run stt_infrastructure_setup --target dev
   ```

5. **Upload audio files to your personal volume**

   ```bash
   databricks fs cp <local-audio-file.mp3> \
     dbfs:/Volumes/speech_to_text/audio_<your-short-name>/files/
   ```

6. **Run the pipeline**

   ```bash
   databricks bundle run stt_main --target dev
   ```

### Running Tests & Linting

```bash
pytest tests/
ruff check .
ruff check --fix .
```

### Working with the Pipeline

Transformation files are in `src/<pipeline>/transformations/`. Each file uses the Spark Declarative Pipelines (SDP) API:

```python
from pyspark import pipelines as dp

@dp.table(name="my_table", cluster_by=["date_column"])
def my_table():
    return spark.readStream.table("upstream_table")
```

**Add a new transformation:**

1. Create a new `.py` file in the appropriate `transformations/` folder
2. Use `@dp.table()` or `@dp.materialized_view()` decorators
3. Access pipeline parameters with `spark.conf.get("catalog")` etc.
4. Deploy and run the relevant pipeline:

   ```bash
   databricks bundle deploy --target dev
   databricks bundle run stt_audio_transcription --target dev
   ```

**View pipelines in Databricks:**

- Navigate to **Workflows** > **Pipelines**
- Find the pipeline by name (e.g. `stt_audio_transcription`)

---

## Data Storage & Unity Catalog

### Catalog Structure

```text
speech_to_text (catalog)
├── audio (schema — CI/CD dev + prod environment)
│   ├── files (volume — managed)
│   │   ├── [audio files: .wav, .mp3, .flac, .m4a, .ogg, .mp4]
│   │   └── _schema_metadata/              <- Auto Loader schema inference metadata
│   ├── bronze_audio_files_raw             <- stt_audio_transcription pipeline
│   ├── silver_audio_transcription         <- stt_audio_transcription pipeline
│   ├── silver_audio_nlp_ai_func           <- stt_nlp_enrichment pipeline
│   ├── silver_audio_nlp_ai_query          <- stt_nlp_enrichment pipeline
│   ├── gold_audio_sentiment_analysis      <- stt_gold_layer pipeline
│   ├── gold_audio_daily_stats             <- stt_gold_layer pipeline
│   ├── gold_audio_sentiment_by_topic      <- stt_gold_layer pipeline
│   └── stt-whisper-large-v3_payload       <- Whisper AI gateway inference table
└── audio_<shortname> (schema — per-developer local dev)
    ├── files (volume — managed, personal copy)
    └── [same pipeline tables, developer's data]
```

### Volumes

The **`files` volume** stores:

- Raw audio files downloaded from HuggingFace
- Auto Loader schema metadata (under `_schema_metadata/`)
- Volume type: MANAGED

### Pipeline Tables

| Table                            | Layer  | Pipeline                  | Description                                                       |
|----------------------------------|--------|---------------------------|-------------------------------------------------------------------|
| `bronze_audio_files_raw`         | Bronze | stt_audio_transcription   | Raw audio file metadata from Auto Loader, append-only             |
| `silver_audio_transcription`     | Silver | stt_audio_transcription   | Transcription text produced by Whisper via `ai_query()`           |
| `silver_audio_nlp_ai_func`       | Silver | stt_nlp_enrichment        | NLP enrichment via Databricks AI SQL functions                    |
| `silver_audio_nlp_ai_query`      | Silver | stt_nlp_enrichment        | NLP enrichment via Foundation Model API (`ai_query()`)            |
| `gold_audio_sentiment_analysis`  | Gold   | stt_gold_layer            | Full detail: joined NLP + metadata, flattened entities, metrics   |
| `gold_audio_daily_stats`         | Gold   | stt_gold_layer            | Daily aggregation by date × topic × sentiment                     |
| `gold_audio_sentiment_by_topic`  | Gold   | stt_gold_layer            | Sentiment cross-tab per business domain (pivot table)             |

---

## Security & Best Practices

### Authentication

- **Dev**: Uses service principal for automated deployments
- **Prod**: Requires service principal with restricted permissions
- **Local**: Uses Databricks CLI authentication profiles

### Permissions

Ensure the service principal has:

- `USE CATALOG` on `speech_to_text` catalog
- `USE SCHEMA` on target schema (`default` or `prod`)
- `CREATE TABLE` for pipeline table outputs
- `READ VOLUME` and `WRITE VOLUME` on the `files` volume

### Security Notes

- Never commit secrets or credentials to the repository — `databricks.local.yml` is git-ignored for this reason
- Use GitHub Environments for managing secrets in CI/CD
- Service principal federation with GitHub OIDC eliminates long-lived tokens
- The Whisper endpoint is shared across all environments; access is controlled by the `CAN_QUERY` grant on the `users` group (set by the `stt_infrastructure_setup` job)

---

## Troubleshooting

### Bundle Validation Fails

**Solution:**

1. Check YAML syntax in `databricks.yml` and resource files
2. Ensure all required variables are defined
3. Verify catalog and schema exist in the target workspace
4. Run `databricks bundle validate --target <target>` for a specific target

### Pipeline Fails to Start

**Solution:**

1. Verify the catalog and schema exist and the service principal has permissions
2. Check that the `files` volume exists and audio files are present
3. Review pipeline logs in **Workflows > Delta Live Tables**
4. Confirm transformation files have no syntax errors

### Auto Loader: Schema Location Errors

**Solution:**

1. Ensure the `_schema_metadata` folder is not inside the audio file source path
2. Verify `schema_location_base` is set correctly in `stt_audio_ingestion.pipeline.yml`
3. The service principal needs `WRITE VOLUME` permission on the `files` volume

### Volume Access Issues

**Solution:**

1. Verify the volume exists: `/Volumes/{catalog}/{schema}/files/`
2. Ensure the service principal has `READ VOLUME` permission
3. For dev environment, confirm the volume is created during `databricks bundle deploy`

---

## Additional Resources

- **Root README**: [../README.md](../README.md) — Overall project setup and CI/CD configuration
- **Spark Declarative Pipelines**: [Databricks SDP Documentation](https://docs.databricks.com/aws/en/ldp/)
- **Asset Bundles Guide**: [Databricks Asset Bundles](https://docs.databricks.com/dev-tools/bundles/index.html)
- **Unity Catalog**: [Unity Catalog Documentation](https://docs.databricks.com/data-governance/unity-catalog/index.html)

---

## What's Implemented

1. ✅ **Bronze & Silver Transcription** — Auto Loader ingests audio, Whisper transcribes via Model Serving
2. ✅ **NLP Enrichment** — Sentiment, summary, entities, topic, and translation (two parallel implementations)
3. ✅ **Gold Layer** — Analysis-ready detail and aggregate tables built from the enriched silver data
4. ✅ **NLP Quality Evaluation** — MLflow GenAI evaluation comparing both NLP implementations
5. ✅ **Dashboard** — AI/BI Lakeview dashboard deployed via Asset Bundle on top of the gold layer tables
6. ✅ **Genie Space** — Natural language interface for querying `gold_audio_sentiment_analysis`
7. ✅ **Shared Infrastructure** — Whisper endpoint provisioned once via `stt_infrastructure_setup` (outside bundle lifecycle)
