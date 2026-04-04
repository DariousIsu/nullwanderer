"""
mlflow_tool.py
───────────────
AURA MCP tool — MLflow experiment tracking.

Tracks ML experiments: log parameters, metrics, and artifacts to a local
MLflow tracking server or file store. List and compare runs across experiments.

No API key required. Requires: pip install mlflow
Default tracking URI: ~/.aura/mlflow (file store, no server needed)
"""

from __future__ import annotations

import logging
from pathlib import Path

logger = logging.getLogger(__name__)

_TRACKING_URI = str(Path.home() / ".aura" / "mlflow")

TOOL_DEF = {
    "name": "mlflow",
    "description": (
        "Track ML experiments with MLflow. Operations: start_run, log_params, log_metrics, "
        "log_artifact, list_experiments, list_runs, get_run, set_tag. "
        "Stores locally at ~/.aura/mlflow (no server required). "
        "Use for comparing model configurations, tracking fine-tuning runs, and evaluating experiments."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "operation": {
                "type": "string",
                "enum": ["start_run", "log_params", "log_metrics", "log_artifact",
                         "list_experiments", "list_runs", "get_run", "set_tag", "end_run"],
                "description": "MLflow operation to perform",
            },
            "experiment_name": {
                "type": "string",
                "description": "Experiment name (required for start_run)",
            },
            "run_id": {
                "type": "string",
                "description": "Run ID (required for log_params, log_metrics, log_artifact, get_run, set_tag)",
            },
            "params": {
                "type": "object",
                "description": "Dict of param_name: value to log (for log_params)",
            },
            "metrics": {
                "type": "object",
                "description": "Dict of metric_name: float_value to log (for log_metrics)",
            },
            "artifact_path": {
                "type": "string",
                "description": "Local file path to log as artifact (for log_artifact)",
            },
            "tag_key": {
                "type": "string",
                "description": "Tag key (for set_tag)",
            },
            "tag_value": {
                "type": "string",
                "description": "Tag value (for set_tag)",
            },
            "max_results": {
                "type": "integer",
                "description": "Max runs to return for list_runs (default: 20)",
                "default": 20,
            },
        },
        "required": ["operation"],
    },
}


async def tool_handler(inputs: dict) -> dict:
    operation = inputs.get("operation", "")

    try:
        import mlflow
        mlflow.set_tracking_uri(_TRACKING_URI)
    except ImportError:
        return {"error": "mlflow not installed — run: pip install mlflow"}

    try:
        if operation == "start_run":
            exp_name = inputs.get("experiment_name", "default")
            mlflow.set_experiment(exp_name)
            run = mlflow.start_run()
            return {"run_id": run.info.run_id, "experiment": exp_name, "status": "started"}

        elif operation == "end_run":
            mlflow.end_run()
            return {"success": True}

        elif operation == "log_params":
            run_id = inputs.get("run_id")
            params = inputs.get("params", {})
            if not run_id or not params:
                return {"error": "run_id and params required"}
            with mlflow.start_run(run_id=run_id):
                mlflow.log_params(params)
            return {"success": True, "logged": list(params.keys())}

        elif operation == "log_metrics":
            run_id  = inputs.get("run_id")
            metrics = inputs.get("metrics", {})
            if not run_id or not metrics:
                return {"error": "run_id and metrics required"}
            with mlflow.start_run(run_id=run_id):
                mlflow.log_metrics({k: float(v) for k, v in metrics.items()})
            return {"success": True, "logged": list(metrics.keys())}

        elif operation == "log_artifact":
            run_id        = inputs.get("run_id")
            artifact_path = inputs.get("artifact_path", "")
            if not run_id or not artifact_path:
                return {"error": "run_id and artifact_path required"}
            from pathlib import Path as _Path
            if not _Path(artifact_path).exists():
                return {"error": f"File not found: {artifact_path}"}
            with mlflow.start_run(run_id=run_id):
                mlflow.log_artifact(artifact_path)
            return {"success": True, "artifact": artifact_path}

        elif operation == "set_tag":
            run_id    = inputs.get("run_id")
            tag_key   = inputs.get("tag_key")
            tag_value = inputs.get("tag_value", "")
            if not run_id or not tag_key:
                return {"error": "run_id and tag_key required"}
            with mlflow.start_run(run_id=run_id):
                mlflow.set_tag(tag_key, tag_value)
            return {"success": True}

        elif operation == "list_experiments":
            experiments = mlflow.search_experiments()
            return {
                "experiments": [
                    {"id": e.experiment_id, "name": e.name, "artifact_location": e.artifact_location}
                    for e in experiments
                ]
            }

        elif operation == "list_runs":
            exp_name    = inputs.get("experiment_name", "")
            max_results = int(inputs.get("max_results", 20))
            exp_filter  = f"name = '{exp_name}'" if exp_name else None
            runs = mlflow.search_runs(
                experiment_names=[exp_name] if exp_name else None,
                max_results=max_results,
            )
            if runs.empty:
                return {"runs": []}
            cols = ["run_id", "status", "start_time"] + [c for c in runs.columns if c.startswith("metrics.") or c.startswith("params.")]
            return {"runs": runs[cols].fillna("").to_dict(orient="records")}

        elif operation == "get_run":
            run_id = inputs.get("run_id")
            if not run_id:
                return {"error": "run_id required"}
            run = mlflow.get_run(run_id)
            return {
                "run_id":   run.info.run_id,
                "status":   run.info.status,
                "params":   dict(run.data.params),
                "metrics":  dict(run.data.metrics),
                "tags":     dict(run.data.tags),
            }

        return {"error": f"Unknown operation: {operation}"}

    except Exception as exc:
        logger.error("[mlflow_tool] %s failed: %s", operation, exc)
        return {"error": str(exc)}
