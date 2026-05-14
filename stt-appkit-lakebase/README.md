# NLP Verdict Workbench

Databricks App backed by Lakebase Postgres. Human-in-the-loop review tool for the speech-to-text pipeline: reviewers see calls where the two NLP implementations disagree (sentiment / topic / summary / entities), pick a winner per dimension, and the verdicts flow back to a Delta table that the MLflow evaluation consumes as human ground truth.

- **Operational reference** (working API bodies, GRANT recipe, troubleshooting): [../docs/LAKEHOUSE_LAKEBASE_INTEGRATION.md](../docs/LAKEHOUSE_LAKEBASE_INTEGRATION.md)
- **Design rationale**: [../docs/NLP_VERDICT_WORKBENCH_DESIGN.md](../docs/NLP_VERDICT_WORKBENCH_DESIGN.md)
- **Deployed at** (single instance): <https://stt-appkit-lakebase-7405611527540572.12.azure.databricksapps.com>

Built with [AppKit](https://databricks.github.io/appkit/) (Express + React + Tailwind). The bundle's app name stays `stt-appkit-lakebase` to keep the deployed URL stable.

## Prerequisites

- Node.js v22+ and npm
- Databricks CLI (for deployment)
- Access to a Databricks workspace

## Databricks Authentication

### Local Development

For local development, configure your environment variables by creating a `.env` file:

```bash
cp .env.example .env
```

Edit `.env` and set the environment variables you need:

```env
DATABRICKS_HOST=https://your-workspace.cloud.databricks.com
DATABRICKS_APP_PORT=8000
# ... other environment variables, depending on the plugins you use
```

#### Lakebase Configuration

The Lakebase plugin requires additional environment variables for PostgreSQL connectivity. To learn how to configure the Lakebase plugin, see the [Lakebase plugin documentation](https://databricks.github.io/appkit/docs/plugins/lakebase).

### CLI Authentication

The Databricks CLI requires authentication to deploy and manage apps. Configure authentication using one of these methods:

#### OAuth U2M

Interactive browser-based authentication with short-lived tokens:

```bash
databricks auth login --host https://your-workspace.cloud.databricks.com
```

This will open your browser to complete authentication. The CLI saves credentials to `~/.databrickscfg`.

#### Configuration Profiles

Use multiple profiles for different workspaces:

```ini
[DEFAULT]
host = https://dev-workspace.cloud.databricks.com

[production]
host = https://prod-workspace.cloud.databricks.com
client_id = prod-client-id
client_secret = prod-client-secret
```

Deploy using a specific profile:

```bash
databricks bundle deploy --profile production
```

**Note:** Personal Access Tokens (PATs) are legacy authentication. OAuth is strongly recommended for better security.

## Getting Started

### Install Dependencies

```bash
npm install
```

### Development

Run the app in development mode with hot reload:

```bash
npm run dev
```

The app will be available at the URL shown in the console output.

### Build

Build both client and server for production:

```bash
npm run build
```

This creates:

- `dist/server.js` - Compiled server bundle
- `client/dist/` - Bundled client assets

### Production

Run the production build:

```bash
npm start
```

## Code Quality

There are a few commands to help you with code quality:

```bash
# Type checking
npm run typecheck

# Linting
npm run lint
npm run lint:fix

# Formatting
npm run format
npm run format:fix
```

## Deployment

This app is managed as a **Databricks Asset Bundle**. The bundle owns the app resource and its Postgres binding; all code and config changes flow through `databricks bundle` commands. The bundle's staging path under `/Workspace/Users/<you>/.bundle/stt-appkit-lakebase/default/files/` is the canonical source the running app reads from.

Prefix all `databricks` commands below with `DATABRICKS_CONFIG_PROFILE=sandpit` (or your chosen profile) if your `~/.databrickscfg` `DEFAULT` profile does not point at the target workspace.

### First-time setup (per workspace)

Only required once. Subsequent deploys skip these steps.

1. **Set workspace host** in [databricks.yml](databricks.yml) under `targets.default.workspace.host`.
2. **Set Postgres variables** in `targets.default.variables` (`postgres_branch`, `postgres_database`) to the full Lakebase resource names:

   ```bash
   databricks postgres list-branches projects/<project-id>
   databricks postgres list-databases <branch-name>
   ```

3. **Validate** the bundle:

   ```bash
   databricks bundle validate
   ```

4. **Bind any pre-existing app** (e.g. one created via the Databricks UI) into the bundle's state so the bundle manages it instead of trying to create a parallel app:

   ```bash
   databricks bundle deployment bind app stt-appkit-lakebase --auto-approve
   ```

   Skip this step if the app does not yet exist — the next `bundle deploy` will create it.

### Standard workflow: deploy + run

Use this for any change to code or `databricks.yml`:

```bash
databricks bundle deploy   # upload files + reconcile resources (app, Postgres binding, permissions)
databricks bundle run app  # deploy a new running version from the bundle staging path
```

`bundle deploy` updates the app's configured `source_code_path` but does **not** restart the app. `bundle run app` creates a new immutable app version from the staging files and switches traffic to it.

### Fast iterate: sync + run (code-only changes)

For tight inner-loop iteration on app code (no `databricks.yml` changes), you can skip the bundle's resource reconciliation and push files directly into the same staging path the bundle uses:

```bash
# One-shot push (or use --watch for continuous live sync)
databricks sync . /Workspace/Users/fkong@synergygroup.net.au/.bundle/stt-appkit-lakebase/default/files

# Deploy a new running version from the same staging path
databricks bundle run app
```

Both workflows write to the same staging directory, so they don't fight each other. The app's `default_source_code_path` stays anchored to the bundle path.

> **Don't** call `databricks apps deploy stt-appkit-lakebase --source-code-path <elsewhere>` with a custom path while the bundle manages the app — it overwrites `default_source_code_path`, and the next `bundle run app` will flip it back, causing path churn.

**App URL** (stable across deploys, tied to app name + workspace ID — not the source path): <https://stt-appkit-lakebase-7405611527540572.12.azure.databricksapps.com>

### Deploy to other targets

Define additional targets in [databricks.yml](databricks.yml) (e.g. `prod`) and pass `-t <target>`:

```bash
databricks bundle deploy -t prod
databricks bundle run app -t prod
```

## Project Structure

```text
* client/                                   # React frontend
  * src/pages/lakebase/                     # Queue + diff/verdict pages
* server/                                   # Express backend
  * server.ts                               # Server entry point (AppKit bootstrap)
  * routes/lakebase/verdict-routes.ts       # Verdict workbench API (review queue, claim/release, verdicts)
* tests/                                    # Playwright smoke tests
* databricks.yml                            # Bundle configuration (app + Postgres binding)
* app.yaml                                  # Databricks App runtime configuration
* appkit.plugins.json                       # AppKit plugin manifest
```

## Tech Stack

- **Backend**: Node.js, Express
- **Frontend**: React.js, TypeScript, Vite, Tailwind CSS, React Router
- **UI Components**: Radix UI, shadcn/ui
- **Databricks**: AppKit SDK
