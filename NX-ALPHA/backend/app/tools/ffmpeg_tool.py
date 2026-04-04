"""
FFmpeg Video Editor — Natural language video editing via FFmpeg.

Generates and executes FFmpeg commands for video/audio manipulation.
Runs fully local using the system FFmpeg binary.
"""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
from pathlib import Path

from app.tools._mcp_wrapper import _error

logger = logging.getLogger(__name__)

TOOL_DEF = {
    "name": "ffmpeg_editor",
    "description": (
        "Edit, convert, and manipulate video and audio files using FFmpeg. "
        "Supports: trim/cut, merge, transcode, extract audio, add subtitles, "
        "resize, adjust speed, convert formats, generate thumbnails, and more. "
        "Provide either a pre-built FFmpeg command or describe the operation."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": [
                    "trim", "merge", "transcode", "extract_audio", "add_subtitles",
                    "resize", "speed", "thumbnail", "info", "custom",
                ],
                "description": "Video editing operation to perform",
            },
            "input_path": {
                "type": "string",
                "description": "Absolute path to the input video/audio file",
            },
            "output_path": {
                "type": "string",
                "description": "Absolute path for the output file (auto-generated if omitted)",
            },
            "start_time": {
                "type": "string",
                "description": "Start time for trim (HH:MM:SS or seconds)",
            },
            "end_time": {
                "type": "string",
                "description": "End time for trim (HH:MM:SS or seconds)",
            },
            "duration": {
                "type": "string",
                "description": "Duration for trim (HH:MM:SS or seconds)",
            },
            "format": {
                "type": "string",
                "description": "Output format (mp4, webm, mp3, wav, gif, etc.)",
            },
            "resolution": {
                "type": "string",
                "description": "Target resolution for resize (e.g. 1920x1080, 720p)",
            },
            "speed_factor": {
                "type": "number",
                "description": "Speed multiplier (0.5 = half speed, 2.0 = double speed)",
            },
            "custom_args": {
                "type": "string",
                "description": "Raw FFmpeg arguments for custom action (e.g. '-vf hue=s=0')",
            },
            "file_list": {
                "type": "array",
                "items": {"type": "string"},
                "description": "List of file paths for merge action",
            },
            "subtitle_path": {
                "type": "string",
                "description": "Path to subtitle file (.srt, .ass) for add_subtitles action",
            },
        },
        "required": ["action"],
    },
}


def _ffmpeg_bin() -> str:
    """Locate ffmpeg binary."""
    path = shutil.which("ffmpeg")
    if not path:
        return ""
    return path


def _auto_output(input_path: str, suffix: str) -> str:
    """Generate an output path next to the input file."""
    p = Path(input_path)
    return str(p.parent / f"{p.stem}_edited{suffix}")


def _resolution_to_scale(res: str) -> str:
    """Convert resolution string to FFmpeg scale filter."""
    presets = {"360p": "640:360", "480p": "854:480", "720p": "1280:720", "1080p": "1920:1080", "4k": "3840:2160"}
    if res.lower() in presets:
        return presets[res.lower()]
    if "x" in res:
        return res.replace("x", ":")
    return res


async def _run_ffmpeg(args: list[str]) -> dict:
    """Execute an FFmpeg command and return result."""
    ffmpeg = _ffmpeg_bin()
    if not ffmpeg:
        return _error("FFmpeg not found. Install via: apt install ffmpeg")

    cmd = [ffmpeg] + args
    logger.info("[ffmpeg] Running: %s", " ".join(cmd))

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=300)

        if proc.returncode != 0:
            return _error(f"FFmpeg failed (exit {proc.returncode}): {stderr.decode(errors='replace')[:1000]}")

        return {
            "success": True,
            "command": " ".join(cmd),
            "stderr": stderr.decode(errors="replace")[:500],
        }
    except asyncio.TimeoutError:
        return _error("FFmpeg timed out after 300 seconds")
    except Exception as exc:
        logger.error("[ffmpeg] %s", exc)
        return _error(str(exc))


async def tool_handler(inputs: dict) -> dict:
    action = inputs.get("action", "")
    if not action:
        return _error("action is required")

    input_path = inputs.get("input_path", "")

    if action == "info":
        if not input_path:
            return _error("input_path is required for info")
        ffprobe = shutil.which("ffprobe")
        if not ffprobe:
            return _error("ffprobe not found. Install via: apt install ffmpeg")
        try:
            proc = await asyncio.create_subprocess_exec(
                ffprobe, "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", input_path,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            )
            stdout, _ = await proc.communicate()
            import json
            return {"info": json.loads(stdout.decode()), "path": input_path}
        except Exception as exc:
            return _error(str(exc))

    if action == "custom":
        custom_args = inputs.get("custom_args", "")
        if not custom_args:
            return _error("custom_args required for custom action")
        args = custom_args.split()
        result = await _run_ffmpeg(args)
        return result

    if not input_path:
        return _error("input_path is required")
    if not Path(input_path).is_file():
        return _error(f"Input file not found: {input_path}")

    output_path = inputs.get("output_path", "")

    if action == "trim":
        if not output_path:
            output_path = _auto_output(input_path, Path(input_path).suffix)
        args = ["-i", input_path]
        if inputs.get("start_time"):
            args += ["-ss", inputs["start_time"]]
        if inputs.get("end_time"):
            args += ["-to", inputs["end_time"]]
        elif inputs.get("duration"):
            args += ["-t", inputs["duration"]]
        args += ["-c", "copy", "-y", output_path]
        result = await _run_ffmpeg(args)
        if result.get("success"):
            result["output_path"] = output_path
        return result

    elif action == "merge":
        file_list = inputs.get("file_list", [])
        if not file_list:
            return _error("file_list required for merge action")
        if not output_path:
            output_path = _auto_output(input_path, Path(input_path).suffix)
        import tempfile
        concat_file = tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False)
        for f in file_list:
            concat_file.write(f"file '{f}'\n")
        concat_file.close()
        args = ["-f", "concat", "-safe", "0", "-i", concat_file.name, "-c", "copy", "-y", output_path]
        result = await _run_ffmpeg(args)
        os.unlink(concat_file.name)
        if result.get("success"):
            result["output_path"] = output_path
        return result

    elif action == "transcode":
        fmt = inputs.get("format", "mp4")
        if not output_path:
            output_path = _auto_output(input_path, f".{fmt}")
        args = ["-i", input_path, "-y", output_path]
        result = await _run_ffmpeg(args)
        if result.get("success"):
            result["output_path"] = output_path
        return result

    elif action == "extract_audio":
        fmt = inputs.get("format", "mp3")
        if not output_path:
            output_path = _auto_output(input_path, f".{fmt}")
        args = ["-i", input_path, "-vn", "-acodec", "libmp3lame" if fmt == "mp3" else "copy", "-y", output_path]
        result = await _run_ffmpeg(args)
        if result.get("success"):
            result["output_path"] = output_path
        return result

    elif action == "add_subtitles":
        sub_path = inputs.get("subtitle_path", "")
        if not sub_path:
            return _error("subtitle_path required for add_subtitles")
        if not output_path:
            output_path = _auto_output(input_path, Path(input_path).suffix)
        args = ["-i", input_path, "-vf", f"subtitles={sub_path}", "-y", output_path]
        result = await _run_ffmpeg(args)
        if result.get("success"):
            result["output_path"] = output_path
        return result

    elif action == "resize":
        res = inputs.get("resolution", "720p")
        scale = _resolution_to_scale(res)
        if not output_path:
            output_path = _auto_output(input_path, Path(input_path).suffix)
        args = ["-i", input_path, "-vf", f"scale={scale}", "-y", output_path]
        result = await _run_ffmpeg(args)
        if result.get("success"):
            result["output_path"] = output_path
        return result

    elif action == "speed":
        factor = inputs.get("speed_factor", 1.0)
        if factor <= 0:
            return _error("speed_factor must be positive")
        if not output_path:
            output_path = _auto_output(input_path, Path(input_path).suffix)
        vf = f"setpts={1.0/factor}*PTS"
        af = f"atempo={factor}" if 0.5 <= factor <= 2.0 else f"atempo={min(factor, 2.0)}"
        args = ["-i", input_path, "-vf", vf, "-af", af, "-y", output_path]
        result = await _run_ffmpeg(args)
        if result.get("success"):
            result["output_path"] = output_path
        return result

    elif action == "thumbnail":
        if not output_path:
            output_path = _auto_output(input_path, ".jpg")
        time = inputs.get("start_time", "00:00:01")
        args = ["-i", input_path, "-ss", time, "-vframes", "1", "-y", output_path]
        result = await _run_ffmpeg(args)
        if result.get("success"):
            result["output_path"] = output_path
        return result

    return _error(f"Unknown action: {action}")
