"""
ComfyUI Image Generation — Local image generation via ComfyUI REST API.

Sends workflow prompts to a locally running ComfyUI server and retrieves
generated images. Runs on your GPU (ROCm RX 7900 XT compatible).
No external API keys required.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import tempfile
import uuid
from pathlib import Path

import httpx

from app.tools._mcp_wrapper import _error, _get_setting

logger = logging.getLogger(__name__)

TOOL_DEF = {
    "name": "comfyui_generate",
    "description": (
        "Generate images using a locally running ComfyUI server. Supports text-to-image, "
        "image-to-image, and custom workflow execution. Requires ComfyUI running on "
        "localhost:8188 (default). Uses your local GPU for generation — no API costs."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "prompt": {
                "type": "string",
                "description": "Text prompt describing the image to generate",
            },
            "negative_prompt": {
                "type": "string",
                "description": "Negative prompt (things to avoid in the image)",
                "default": "",
            },
            "workflow": {
                "type": "object",
                "description": (
                    "Full ComfyUI workflow JSON (advanced). If provided, prompt/negative_prompt "
                    "are ignored and this workflow is sent directly."
                ),
            },
            "model": {
                "type": "string",
                "description": "Checkpoint model name (e.g. 'flux1-dev.safetensors'). Uses server default if omitted.",
            },
            "width": {
                "type": "integer",
                "description": "Image width in pixels (default: 1024)",
                "default": 1024,
            },
            "height": {
                "type": "integer",
                "description": "Image height in pixels (default: 1024)",
                "default": 1024,
            },
            "steps": {
                "type": "integer",
                "description": "Number of sampling steps (default: 20)",
                "default": 20,
            },
            "cfg_scale": {
                "type": "number",
                "description": "CFG scale / guidance scale (default: 7.0)",
                "default": 7.0,
            },
            "seed": {
                "type": "integer",
                "description": "Random seed (-1 for random)",
                "default": -1,
            },
            "sampler": {
                "type": "string",
                "description": "Sampler name (default: euler)",
                "default": "euler",
            },
            "scheduler": {
                "type": "string",
                "description": "Scheduler name (default: normal)",
                "default": "normal",
            },
            "server_url": {
                "type": "string",
                "description": "ComfyUI server URL (default: http://127.0.0.1:8188)",
                "default": "http://127.0.0.1:8188",
            },
            "output_path": {
                "type": "string",
                "description": "Where to save the generated image (auto-generated if omitted)",
            },
        },
        "required": ["prompt"],
    },
}


def _build_txt2img_workflow(inputs: dict) -> dict:
    """Build a standard txt2img workflow for ComfyUI."""
    seed = inputs.get("seed", -1)
    if seed == -1:
        import random
        seed = random.randint(0, 2**32 - 1)

    model = inputs.get("model", "")

    workflow = {
        "3": {
            "class_type": "KSampler",
            "inputs": {
                "seed": seed,
                "steps": inputs.get("steps", 20),
                "cfg": inputs.get("cfg_scale", 7.0),
                "sampler_name": inputs.get("sampler", "euler"),
                "scheduler": inputs.get("scheduler", "normal"),
                "denoise": 1.0,
                "model": ["4", 0],
                "positive": ["6", 0],
                "negative": ["7", 0],
                "latent_image": ["5", 0],
            },
        },
        "4": {
            "class_type": "CheckpointLoaderSimple",
            "inputs": {
                "ckpt_name": model if model else "flux1-dev.safetensors",
            },
        },
        "5": {
            "class_type": "EmptyLatentImage",
            "inputs": {
                "width": inputs.get("width", 1024),
                "height": inputs.get("height", 1024),
                "batch_size": 1,
            },
        },
        "6": {
            "class_type": "CLIPTextEncode",
            "inputs": {
                "text": inputs.get("prompt", ""),
                "clip": ["4", 1],
            },
        },
        "7": {
            "class_type": "CLIPTextEncode",
            "inputs": {
                "text": inputs.get("negative_prompt", ""),
                "clip": ["4", 1],
            },
        },
        "8": {
            "class_type": "VAEDecode",
            "inputs": {
                "samples": ["3", 0],
                "vae": ["4", 2],
            },
        },
        "9": {
            "class_type": "SaveImage",
            "inputs": {
                "filename_prefix": "aura_gen",
                "images": ["8", 0],
            },
        },
    }
    return workflow


async def tool_handler(inputs: dict) -> dict:
    prompt_text = inputs.get("prompt", "")
    if not prompt_text and not inputs.get("workflow"):
        return _error("Either prompt or workflow is required")

    server_url = inputs.get("server_url", _get_setting("comfyui_url", "http://127.0.0.1:8188"))
    client_id = str(uuid.uuid4())

    # Build or use provided workflow
    workflow = inputs.get("workflow")
    if not workflow:
        workflow = _build_txt2img_workflow(inputs)

    payload = {"prompt": workflow, "client_id": client_id}

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            # Check if ComfyUI is running
            try:
                health = await client.get(f"{server_url}/system_stats")
                health.raise_for_status()
            except Exception:
                return _error(
                    f"ComfyUI server not reachable at {server_url}. "
                    "Start ComfyUI first: python main.py --listen 0.0.0.0"
                )

            # Queue the prompt
            r = await client.post(f"{server_url}/prompt", json=payload)
            r.raise_for_status()
            result = r.json()
            prompt_id = result.get("prompt_id", "")

            if not prompt_id:
                return _error(f"ComfyUI did not return a prompt_id: {result}")

        # Poll for completion (longer timeout for generation)
        async with httpx.AsyncClient(timeout=300.0) as client:
            for _ in range(600):  # 5 minutes max
                await asyncio.sleep(0.5)
                r = await client.get(f"{server_url}/history/{prompt_id}")
                r.raise_for_status()
                history = r.json()

                if prompt_id in history:
                    outputs = history[prompt_id].get("outputs", {})

                    # Find the SaveImage node output
                    for node_id, node_output in outputs.items():
                        images = node_output.get("images", [])
                        if images:
                            img_info = images[0]
                            filename = img_info.get("filename", "")
                            subfolder = img_info.get("subfolder", "")

                            # Download the image
                            params = {"filename": filename, "subfolder": subfolder, "type": "output"}
                            img_r = await client.get(f"{server_url}/view", params=params)
                            img_r.raise_for_status()

                            output_path = inputs.get("output_path", "")
                            if not output_path:
                                output_path = os.path.join(tempfile.gettempdir(), f"aura_comfyui_{filename}")

                            Path(output_path).write_bytes(img_r.content)

                            return {
                                "output_path": output_path,
                                "prompt_id": prompt_id,
                                "filename": filename,
                                "prompt": prompt_text,
                                "size_bytes": len(img_r.content),
                            }

                    return _error("Generation completed but no images found in output")

        return _error("Generation timed out after 5 minutes")

    except httpx.HTTPError as exc:
        logger.error("[comfyui] HTTP error: %s", exc)
        return _error(f"ComfyUI HTTP error: {exc}")
    except Exception as exc:
        logger.error("[comfyui] %s", exc)
        return _error(str(exc))
