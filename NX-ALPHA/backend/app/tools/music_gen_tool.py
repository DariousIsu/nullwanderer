"""
ACE Music Generator — AI music generation via ACE-Step 1.5 free API.

Generates music from text prompts using the ACE Music API.
Free API key required from acemusic.ai — no usage costs.
"""

from __future__ import annotations

import asyncio
import logging
import os
import tempfile
from pathlib import Path

import httpx

from app.tools._mcp_wrapper import _error, _get_setting

logger = logging.getLogger(__name__)

TOOL_DEF = {
    "name": "music_gen",
    "description": (
        "Generate AI music from text descriptions using ACE-Step 1.5. "
        "Describe the style, mood, instruments, and tempo to get a generated "
        "audio file. Free API with no usage costs. Requires a free API key "
        "from acemusic.ai configured as ace_music_api_key."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "prompt": {
                "type": "string",
                "description": (
                    "Text description of the music to generate. Include style, mood, "
                    "instruments, tempo. Example: 'Upbeat electronic dance track with "
                    "synth pads and a driving bass line, 128 BPM'"
                ),
            },
            "duration": {
                "type": "integer",
                "description": "Duration in seconds (default: 30, max: 60)",
                "default": 30,
            },
            "output_path": {
                "type": "string",
                "description": "Absolute path for the output audio file (auto-generated if omitted)",
            },
        },
        "required": ["prompt"],
    },
}

_BASE_URL = "https://api.acemusic.ai/v1"


async def tool_handler(inputs: dict) -> dict:
    prompt = inputs.get("prompt", "")
    if not prompt:
        return _error("prompt is required — describe the music you want to generate")

    api_key = _get_setting("ace_music_api_key")
    if not api_key:
        return _error(
            "ace_music_api_key not configured. Get a free key at https://acemusic.ai "
            "and add it to AURA settings."
        )

    duration = min(inputs.get("duration", 30), 60)
    output_path = inputs.get("output_path", "")
    if not output_path:
        output_path = os.path.join(tempfile.gettempdir(), "aura_music.mp3")

    try:
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }

        async with httpx.AsyncClient(timeout=60.0, headers=headers) as client:
            # Submit generation request
            r = await client.post(
                f"{_BASE_URL}/generate",
                json={
                    "prompt": prompt,
                    "duration": duration,
                },
            )
            r.raise_for_status()
            result = r.json()

            # Check if result contains direct audio URL or needs polling
            audio_url = result.get("audio_url") or result.get("url")
            task_id = result.get("task_id") or result.get("id")

            if not audio_url and task_id:
                # Poll for completion
                for _ in range(120):  # 2 minutes max
                    await asyncio.sleep(1)
                    status_r = await client.get(f"{_BASE_URL}/status/{task_id}")
                    status_r.raise_for_status()
                    status = status_r.json()

                    if status.get("status") == "completed":
                        audio_url = status.get("audio_url") or status.get("url")
                        break
                    elif status.get("status") == "failed":
                        return _error(f"Generation failed: {status.get('error', 'unknown')}")

            if not audio_url:
                return _error("Generation timed out or no audio URL returned")

            # Download the audio file
            audio_r = await client.get(audio_url)
            audio_r.raise_for_status()
            Path(output_path).write_bytes(audio_r.content)

            return {
                "output_path": output_path,
                "prompt": prompt,
                "duration": duration,
                "size_bytes": len(audio_r.content),
            }

    except httpx.HTTPStatusError as exc:
        logger.error("[music_gen] HTTP %s: %s", exc.response.status_code, exc.response.text[:200])
        return _error(f"ACE Music API error: {exc.response.status_code}")
    except Exception as exc:
        logger.error("[music_gen] %s", exc)
        return _error(str(exc))
