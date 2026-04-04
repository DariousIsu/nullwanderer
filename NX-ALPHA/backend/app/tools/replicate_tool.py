"""
replicate_tool.py
──────────────────
AURA MCP tool — Run AI models via Replicate API.

Access image generation (Flux, SDXL), video, audio, speech, and other
hosted models via Replicate. Returns output URLs.

Requires API key: set AURA_REPLICATE_API_KEY in .env
Get key: https://replicate.com
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

TOOL_DEF = {
    "name": "replicate",
    "description": (
        "Run AI models via Replicate API. "
        "Operations: run (execute any model by version ID), "
        "list_models (search available models), "
        "get_model (info and versions for a specific model). "
        "Supports image generation (Flux, SDXL, DALL-E), video, audio, code, and more. "
        "Returns output file URLs."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "operation": {
                "type": "string",
                "enum": ["run", "list_models", "get_model"],
                "description": "Operation to perform",
            },
            "model": {
                "type": "string",
                "description": "Model identifier: 'owner/model' or 'owner/model:version' (for run, get_model)",
            },
            "inputs": {
                "type": "object",
                "description": "Model-specific input parameters (for run). E.g. {'prompt': 'a cat', 'num_outputs': 1}",
            },
            "query": {
                "type": "string",
                "description": "Search query for list_models",
            },
            "limit": {
                "type": "integer",
                "description": "Max models to return for list_models (default: 10)",
                "default": 10,
            },
        },
        "required": ["operation"],
    },
}


async def tool_handler(inputs: dict) -> dict:
    operation = inputs.get("operation", "")

    try:
        from app.tools._mcp_wrapper import _get_setting
        api_key = _get_setting("replicate_api_key") or ""
    except Exception:
        import os
        api_key = os.environ.get("REPLICATE_API_TOKEN", "")

    if not api_key and operation in ("run", "list_models", "get_model"):
        return {
            "error": "Replicate API key not configured",
            "hint":  "Set AURA_REPLICATE_API_KEY in .env",
        }

    try:
        import httpx
    except ImportError:
        return {"error": "httpx not installed"}

    base    = "https://api.replicate.com/v1"
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}

    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            if operation == "run":
                model  = inputs.get("model", "")
                params = inputs.get("inputs", {})
                if not model:
                    return {"error": "model required"}

                # Split model:version if provided
                if ":" in model:
                    owner_model, version = model.rsplit(":", 1)
                    payload = {"version": version, "input": params}
                    resp = await client.post(f"{base}/predictions", headers=headers, json=payload)
                else:
                    owner, name = (model.split("/", 1) + [""])[:2]
                    resp = await client.post(
                        f"{base}/models/{owner}/{name}/predictions",
                        headers=headers,
                        json={"input": params},
                    )

                resp.raise_for_status()
                prediction = resp.json()
                pred_id    = prediction.get("id", "")

                # Poll for completion (max 120s)
                import asyncio
                for _ in range(60):
                    await asyncio.sleep(2)
                    poll = await client.get(f"{base}/predictions/{pred_id}", headers=headers)
                    data = poll.json()
                    if data.get("status") == "succeeded":
                        return {"success": True, "output": data.get("output"), "model": model}
                    if data.get("status") in ("failed", "canceled"):
                        return {"error": f"Prediction {data['status']}", "logs": data.get("logs", "")[-500:]}

                return {"error": "Prediction timed out", "prediction_id": pred_id}

            elif operation == "list_models":
                query  = inputs.get("query", "")
                limit  = int(inputs.get("limit", 10))
                url    = f"{base}/models" + (f"?query={query}" if query else "")
                resp   = await client.get(url, headers=headers)
                resp.raise_for_status()
                data   = resp.json()
                models = data.get("results", [])[:limit]
                return {
                    "models": [
                        {
                            "id":          f"{m['owner']}/{m['name']}",
                            "description": m.get("description", ""),
                            "runs":        m.get("run_count", 0),
                        }
                        for m in models
                    ]
                }

            elif operation == "get_model":
                model = inputs.get("model", "")
                if not model or "/" not in model:
                    return {"error": "model required in 'owner/name' format"}
                owner, name = model.split("/", 1)
                resp = await client.get(f"{base}/models/{owner}/{name}", headers=headers)
                resp.raise_for_status()
                m = resp.json()
                return {
                    "id":          model,
                    "description": m.get("description", ""),
                    "runs":        m.get("run_count", 0),
                    "url":         m.get("url", ""),
                    "latest_version": m.get("latest_version", {}).get("id", ""),
                }

    except Exception as exc:
        logger.error("[replicate_tool] %s failed: %s", operation, exc)
        return {"error": str(exc)}
