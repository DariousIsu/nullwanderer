"""
fal_tool.py
────────────
AURA MCP tool — Image, video, audio, and 3D generation via fal.ai.

fal.ai hosts fast GPU inference for generative media models.
Returns output file URLs. Supports async queue for long jobs.

Requires API key: set AURA_FAL_API_KEY in .env
Get key: https://fal.ai
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

TOOL_DEF = {
    "name": "fal_generate",
    "description": (
        "Generate images, video, audio, and 3D models via fal.ai fast inference. "
        "Operations: generate (run any fal model by ID), list_models (common model IDs). "
        "Popular models: fal-ai/flux/dev (images), fal-ai/fast-sdxl (fast images), "
        "fal-ai/stable-video-diffusion (video from image), fal-ai/whisper (transcription). "
        "Returns output file URLs."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "operation": {
                "type": "string",
                "enum": ["generate", "list_models"],
                "description": "Operation to perform",
            },
            "model_id": {
                "type": "string",
                "description": "fal.ai model ID, e.g. 'fal-ai/flux/dev' (for generate)",
            },
            "inputs": {
                "type": "object",
                "description": "Model-specific inputs. For image models: {'prompt': '...', 'image_size': 'landscape_4_3'}",
            },
        },
        "required": ["operation"],
    },
}

_COMMON_MODELS = [
    {"id": "fal-ai/flux/dev",              "description": "FLUX.1 dev — high quality image generation"},
    {"id": "fal-ai/flux/schnell",           "description": "FLUX.1 schnell — fast image generation (4 steps)"},
    {"id": "fal-ai/fast-sdxl",             "description": "Fast SDXL — stable diffusion XL, ~3s"},
    {"id": "fal-ai/stable-video-diffusion", "description": "Stable Video Diffusion — image to video"},
    {"id": "fal-ai/cogvideox-5b",           "description": "CogVideoX-5B — text to video"},
    {"id": "fal-ai/whisper",               "description": "Whisper — speech transcription"},
    {"id": "fal-ai/f5-tts",               "description": "F5-TTS — voice cloning TTS"},
    {"id": "fal-ai/triposr",              "description": "TripoSR — image to 3D mesh"},
]


async def tool_handler(inputs: dict) -> dict:
    operation = inputs.get("operation", "list_models")

    if operation == "list_models":
        return {"models": _COMMON_MODELS}

    if operation != "generate":
        return {"error": f"Unknown operation: {operation}"}

    model_id    = inputs.get("model_id", "")
    model_input = inputs.get("inputs", {})

    if not model_id:
        return {"error": "model_id required for generate"}

    try:
        from app.tools._mcp_wrapper import _get_setting
        api_key = _get_setting("fal_api_key") or ""
    except Exception:
        import os
        api_key = os.environ.get("FAL_KEY", "")

    if not api_key:
        return {
            "error": "fal.ai API key not configured",
            "hint":  "Set AURA_FAL_API_KEY in .env",
        }

    try:
        import httpx, asyncio
    except ImportError:
        return {"error": "httpx not installed"}

    base    = "https://queue.fal.run"
    headers = {"Authorization": f"Key {api_key}", "Content-Type": "application/json"}

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            # Submit to queue
            resp = await client.post(
                f"{base}/{model_id}",
                headers=headers,
                json={"input": model_input} if model_input else {},
            )
            resp.raise_for_status()
            job = resp.json()
            request_id = job.get("request_id", "")

            if not request_id:
                # Sync response (some models)
                return {"success": True, "output": job}

            # Poll for result
            for _ in range(60):
                await asyncio.sleep(2)
                status_resp = await client.get(
                    f"{base}/{model_id}/requests/{request_id}/status",
                    headers=headers,
                )
                status_data = status_resp.json()
                if status_data.get("status") == "COMPLETED":
                    result_resp = await client.get(
                        f"{base}/{model_id}/requests/{request_id}",
                        headers=headers,
                    )
                    return {"success": True, "output": result_resp.json(), "model": model_id}
                if status_data.get("status") == "FAILED":
                    return {"error": "Generation failed", "details": status_data}

            return {"error": "Generation timed out", "request_id": request_id}

    except Exception as exc:
        logger.error("[fal_tool] generate failed: %s", exc)
        return {"error": str(exc)}
