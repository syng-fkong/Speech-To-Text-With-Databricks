# Databricks notebook source
# One-time infrastructure setup: creates the Whisper Model Serving endpoint and
# grants CAN_QUERY to all workspace users.
#
# The endpoint is shared across all environments (dev, prod) and all developers
# in the same workspace — it is NOT managed by the bundle lifecycle to avoid
# ownership conflicts. Run this notebook once after the first deployment, and
# re-run it only when the endpoint configuration needs to change.
#
# Idempotent: if the endpoint already exists its config is updated in-place;
# if it does not exist it is created from scratch.

# COMMAND ----------

dbutils.widgets.text("endpoint_name",  "stt-whisper-large-v3", "Endpoint Name")
dbutils.widgets.text("catalog",        "speech_to_text",        "Inference Table Catalog")
dbutils.widgets.text("schema",         "audio",                 "Inference Table Schema")

# COMMAND ----------

endpoint_name = dbutils.widgets.get("endpoint_name")
catalog       = dbutils.widgets.get("catalog")
schema        = dbutils.widgets.get("schema")

print(f"Endpoint name:          {endpoint_name}")
print(f"Inference table target: {catalog}.{schema}.{endpoint_name}_payload")

# COMMAND ----------

from databricks.sdk import WorkspaceClient
from databricks.sdk.service.serving import (
    EndpointCoreConfigInput,
    ServedEntityInput,
    ServingEndpointAccessControlRequest,
    ServingEndpointPermissionLevel,
)

w = WorkspaceClient()

# ── Endpoint configuration ────────────────────────────────────────────────────
# Whisper Large V3 from system.ai (Databricks-managed Foundation Model catalog).
# GPU_SMALL (1x T4) is sufficient for Whisper inference at small-to-medium scale.
# scale_to_zero_enabled avoids idle GPU costs between pipeline runs.

endpoint_config = EndpointCoreConfigInput(
    served_entities=[
        ServedEntityInput(
            entity_name="system.ai.whisper_large_v3",
            entity_version="3",
            workload_type="GPU_SMALL",
            workload_size="Small",
            scale_to_zero_enabled=True,
        )
    ]
)

# COMMAND ----------
# Create or update the endpoint.

existing = None
try:
    existing = w.serving_endpoints.get(endpoint_name)
    print(f"Endpoint '{endpoint_name}' already exists — updating config.")
except Exception:
    print(f"Endpoint '{endpoint_name}' not found — creating.")

if existing is None:
    endpoint = w.serving_endpoints.create_and_wait(
        name=endpoint_name,
        config=endpoint_config,
    )
    print(f"Created endpoint '{endpoint_name}' (id: {endpoint.id})")
else:
    w.serving_endpoints.update_config_and_wait(
        name=endpoint_name,
        served_entities=endpoint_config.served_entities,
    )
    endpoint = w.serving_endpoints.get(endpoint_name)
    print(f"Updated endpoint '{endpoint_name}' (id: {endpoint.id})")

# COMMAND ----------
# Apply AI Gateway only on first creation — skip if the endpoint already existed.
# Re-configuring on an existing endpoint fails if the inference table already
# exists in Unity Catalog (the table is created once and is immutable).

if existing is None:
    w.api_client.do(
        "PUT",
        f"/api/2.0/serving-endpoints/{endpoint_name}/ai-gateway",
        body={
            "inference_table_config": {
                "enabled": True,
                "catalog_name": catalog,
                "schema_name": schema,
                "table_name_prefix": endpoint_name,
            },
            "usage_tracking_config": {"enabled": True},
        },
    )
    print("AI Gateway configured.")
else:
    print("AI Gateway skipped — endpoint already exists with existing inference table config.")

# COMMAND ----------
# Grant CAN_QUERY to all workspace users.
# This covers every developer, the service principal, and all pipeline contexts
# without any per-user or per-environment grants.

w.serving_endpoints.set_permissions(
    serving_endpoint_id=endpoint.id,
    access_control_list=[
        ServingEndpointAccessControlRequest(
            group_name="users",
            permission_level=ServingEndpointPermissionLevel.CAN_QUERY,
        )
    ],
)
print("Granted CAN_QUERY to group 'users'.")

# COMMAND ----------

dbutils.notebook.exit(endpoint.id)
