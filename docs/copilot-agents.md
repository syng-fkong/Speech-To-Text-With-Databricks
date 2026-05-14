# Copilot Custom Agents

Custom GitHub Copilot agents are stored under [`.github/agents/`](../.github/agents/). Each agent activates automatically based on the description in its frontmatter (`infer: true`).

## Agents overview

| Agent (file) | Purpose | Use it when… |
| --- | --- | --- |
| **Docs & Architecture Writer** ([`docs-writer.agent.md`](../.github/agents/docs-writer.agent.md)) | Maintains `README.md` and `/docs/*.md` so they match the real implementation in `speech_to_text_asset_bundle/` and the workflows. | You're updating documentation, especially when reconciling docs with what's actually deployed. |
| **Databricks Python App** ([`databricks-app-python.agent.md`](../.github/agents/databricks-app-python.agent.md)) | Builds Python-based Databricks apps (Dash, Streamlit, Gradio, Flask, FastAPI, Reflex). Covers OAuth, app resources, SQL warehouse + Lakebase connectivity, model serving, deployment. | You need to build or change a Python Databricks app, especially anything that talks to SQL warehouses, Lakebase, or Model Serving. |
| **Databricks APX App** ([`databricks-app-apx.agent.md`](../.github/agents/databricks-app-apx.agent.md)) | Builds full-stack Databricks apps using the APX framework (FastAPI + React). | You're working on (or scaffolding) a FastAPI + React app under the APX framework. The current `stt-appkit-lakebase` app uses AppKit (Express + React) — APX is a different framework. |
| **Databricks AI/BI Dashboards** ([`databricks-aibi-dashboards.agent.md`](../.github/agents/databricks-aibi-dashboards.agent.md)) | Creates Lakeview / AI/BI dashboards. Enforces SQL-query validation via `execute_sql` before deploying. | You're editing `src/dashboards/stt_analytics.lvdash.json` or adding new dashboard widgets. |
| **Databricks Agent Bricks** ([`databricks-agent-bricks.agent.md`](../.github/agents/databricks-agent-bricks.agent.md)) | Creates and manages Knowledge Assistants (KA), Genie Spaces, and Supervisor Agents (MAS) on Databricks. | You're extending the existing Genie Space, adding a Knowledge Assistant, or wiring multi-agent orchestration. |

## Repository documentation structure

| Area | Location | What it contains |
| --- | --- | --- |
| Main documentation | [`README.md`](../README.md) | Solution overview + setup pointers for DAB and GitHub Actions; links to `/docs`. |
| Per-component | [`speech_to_text_asset_bundle/README.md`](../speech_to_text_asset_bundle/README.md), [`stt-appkit-lakebase/README.md`](../stt-appkit-lakebase/README.md) | Pipeline / app implementation detail. |
| Cross-cutting docs | [`docs/`](.) | Architecture overview, setup deep-dives, integration reference, design rationale. |
| Backlog | [`BACKLOG.md`](../BACKLOG.md) | Deferred work + per-phase implementation tracking. |

## Adding a new agent

1. Create `.github/agents/<name>.agent.md` with frontmatter (`name`, `description`, `target: github-copilot`, `infer: true`).
2. Write the agent body — instructions, conventions, the surfaces it owns.
3. Add a row to the table above. Keep the description aligned with the frontmatter so Copilot's inference and the human-readable doc agree.
