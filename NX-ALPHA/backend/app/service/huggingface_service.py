"""
AURA NX-Alpha — HuggingFace Service
All model discovery and downloading routes through AURA.
No manual wget, no browser navigation, no terminal.

FEATURES:
    search_models()          — query HF model hub with filters
    get_model_info()         — files, sizes, license, tags for a specific model
    download_model_file()    — stream file to correct ~/.aura/models/ subdirectory
    download_model_snapshot()— download all files for a model (training base models)
    parse_hf_url()           — extract model ID from any HuggingFace URL or raw ID
    list_local_models()      — scan all ~/.aura/models/ paths
    list_training_models()   — scan C:/Users/*/Desktop/Training Models/ for safetensors
    delete_local_model()     — remove a downloaded file

SMART DESTINATION ROUTING:
    *.gguf               → ~/.aura/models/interface/   (llama-cpp-python)
    *piper*  *.onnx      → ~/.aura/models/voice/piper/
    *tts*    *.gguf      → ~/.aura/models/voice/
    *whisper*            → HuggingFace cache (faster-whisper manages this)
    sentence-transformer → ~/.aura/models/embeddings/
    safetensors (training)→ TRAINING_MODELS_ROOT / {model_name}/
    anything else        → ~/.aura/models/misc/

SSE EVENTS EMITTED:
    hf_download_progress  — { download_id, model_id, filename, pct, bytes_done, total_bytes }
    hf_download_complete  — { download_id, model_id, filename, dest_path }
    hf_download_error     — { download_id, model_id, filename, message }
    hf_snapshot_progress  — { download_id, model_id, file_index, file_total, filename, pct }
    hf_snapshot_complete  — { download_id, model_id, dest_dir, file_count, total_bytes }

FOLDER LAYOUT:
    Inference models  → ~/.aura/models/interface/        (GGUF, llama-cpp)
    Training models   → Desktop/Training Models/{name}/  (safetensors, HQQ+LoRA)
    Datasets          → HuggingFace ID only, loaded at runtime by Axolotl
"""

from __future__ import annotations

import asyncio
import logging
import re
import uuid
from pathlib import Path
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

# ── Model root (inference models) ─────────────────────────────────────────────
MODELS_ROOT = Path("~/.aura/models").expanduser()

# ── Training Models root (base models for fine-tuning, Windows Desktop) ───────
# WSL2 path: /mnt/c/Users/<user>/Desktop/Training Models/
# Windows path resolved via USERPROFILE or fallback
import os as _os
_win_user = _os.environ.get("USERPROFILE", "").replace("\\", "/")
if _win_user:
    # Running on Windows — use Desktop path directly
    TRAINING_MODELS_ROOT = Path(_win_user) / "Desktop" / "Training Models"
else:
    # Running in WSL2 — use /mnt/c mount
    TRAINING_MODELS_ROOT = Path("/mnt/c/Users") / _os.environ.get("USER", "azrae") / "Desktop" / "Training Models"

# ── Active downloads { download_id: { cancel_event, ... } } ──────────────────
_active_downloads: dict[str, dict] = {}


# ─────────────────────────────────────────────────────────────────────────────
# DESTINATION ROUTING
# ─────────────────────────────────────────────────────────────────────────────

def parse_hf_url(url_or_id: str) -> str:
    """
    Extract a HuggingFace model ID from a URL or return the raw ID unchanged.

    Handles:
        https://huggingface.co/Qwen/Qwen3.5-9B          → Qwen/Qwen3.5-9B
        https://huggingface.co/Qwen/Qwen3.5-9B/tree/main → Qwen/Qwen3.5-9B
        huggingface.co/Qwen/Qwen3.5-9B                  → Qwen/Qwen3.5-9B
        Qwen/Qwen3.5-9B                                  → Qwen/Qwen3.5-9B
    """
    s = url_or_id.strip()

    # Strip protocol
    s = re.sub(r"^https?://", "", s)

    # Strip huggingface.co/ prefix
    s = re.sub(r"^(?:www\.)?huggingface\.co/", "", s)

    # Strip trailing path segments (tree/main, blob/main/..., etc.)
    s = re.sub(r"/(tree|blob|resolve|discussions|files)/.*$", "", s)

    # Strip trailing slashes
    s = s.strip("/")

    return s


def _route_destination(model_id: str, filename: str, training: bool = False) -> Path:
    """
    Pick the correct local directory for a downloaded model file.
    Logic is filename + model_id pattern matching — no user input required.

    If training=True, safetensors files route to TRAINING_MODELS_ROOT/{model_name}/
    instead of ~/.aura/models/misc/.
    """
    name_lower = filename.lower()
    model_lower = model_id.lower()

    # Training base model — safetensors shards go to Training Models folder
    if training and name_lower.endswith(".safetensors"):
        model_name = model_id.split("/")[-1]
        return TRAINING_MODELS_ROOT / model_name

    # Piper TTS voice model
    if ".onnx" in name_lower and any(k in model_lower for k in ("piper", "voice", "tts")):
        return MODELS_ROOT / "voice" / "piper"

    # MOSS-TTS / voice GGUF
    if name_lower.endswith(".gguf") and any(k in model_lower for k in ("moss", "tts", "voice", "speech")):
        return MODELS_ROOT / "voice"

    # Standard GGUF — interface / workhorse models
    if name_lower.endswith(".gguf"):
        return MODELS_ROOT / "interface"

    # Sentence transformer / embedding model
    if any(k in model_lower for k in ("sentence-transformer", "embedding", "e5-", "bge-", "minilm")):
        return MODELS_ROOT / "embeddings"

    # Whisper — faster-whisper manages its own cache; we put raw files in voice/
    if "whisper" in model_lower:
        return MODELS_ROOT / "voice"

    # Fallback
    return MODELS_ROOT / "misc"


# ─────────────────────────────────────────────────────────────────────────────
# SEARCH
# ─────────────────────────────────────────────────────────────────────────────

TASK_FILTERS = [
    "text-generation",
    "text2text-generation",
    "automatic-speech-recognition",
    "text-to-speech",
    "feature-extraction",
    "image-to-text",
    "visual-question-answering",
]


# ─────────────────────────────────────────────────────────────────────────────
# SAFETY SCANNER
# Scans downloaded files for suspicious content before making them available.
# Focuses on pickle/Python serialisation attacks common in ML model files.
# ─────────────────────────────────────────────────────────────────────────────

# File extensions we consider safe (binary ML formats, no executable code)
_SAFE_EXTENSIONS = {
    ".gguf", ".ggml", ".bin", ".safetensors", ".onnx", ".onnx.json",
    ".json", ".txt", ".md", ".yaml", ".yml", ".csv",
    ".model", ".vocab", ".tiktoken", ".spm",
}

# Extensions that may contain executable code / pickled objects
_RISKY_EXTENSIONS = {
    ".py", ".pth", ".pt", ".pkl", ".pickle", ".joblib",
    ".exe", ".dll", ".so", ".sh", ".bat", ".cmd", ".ps1",
}

# Byte signatures for pickle-based serialisation attacks
_PICKLE_MAGIC = [
    b"\x80\x02",     # Pickle protocol 2
    b"\x80\x03",     # Pickle protocol 3
    b"\x80\x04",     # Pickle protocol 4
    b"\x80\x05",     # Pickle protocol 5
]

# Suspicious strings in pickle/Python payloads
_SUSPICIOUS_PATTERNS = [
    b"os.system",
    b"subprocess",
    b"__import__",
    b"exec(",
    b"eval(",
    b"builtins",
    b"__reduce__",
    b"__reduce_ex__",
    b"commands.getoutput",
    b"pty.spawn",
    b"socket.socket",
]


def _scan_downloaded_file(filepath: Path, filename: str) -> Optional[str]:
    """
    Scan a downloaded file for malicious content.

    Returns None if safe, or a string describing the threat if blocked.
    Safe model formats (GGUF, safetensors, ONNX) pass immediately.
    Pickle-based formats (.pth, .pt, .pkl) are scanned for exploit patterns.
    Executable files are always blocked.
    """
    ext = "".join(filepath.suffixes).lower()
    name_lower = filename.lower()

    # Known-safe binary formats — skip scan
    if ext in _SAFE_EXTENSIONS or name_lower.endswith(".safetensors"):
        return None

    # Block executables outright
    if ext in {".exe", ".dll", ".so", ".sh", ".bat", ".cmd", ".ps1"}:
        return f"Executable file type blocked: {ext}"

    # Scan pickle-based model files for suspicious payloads
    if ext in {".pth", ".pt", ".pkl", ".pickle", ".joblib"}:
        try:
            with open(filepath, "rb") as f:
                header = f.read(8192)  # Scan first 8KB
            for pattern in _SUSPICIOUS_PATTERNS:
                if pattern in header:
                    return f"Suspicious pattern in pickle file: {pattern.decode('ascii', errors='replace')}"
            logger.info("[hf_service] Pickle file %s passed safety scan (header clean)", filename)
        except Exception as exc:
            logger.warning("[hf_service] Could not scan %s: %s", filename, exc)
            return f"Scan failed: {exc}"

    # Scan Python files for obviously malicious code
    if ext == ".py":
        try:
            content = filepath.read_bytes()[:16384]
            for pattern in _SUSPICIOUS_PATTERNS:
                if pattern in content:
                    # Some patterns are normal in .py files (like __import__)
                    # but we flag the truly dangerous ones
                    if pattern in {b"os.system", b"subprocess", b"pty.spawn", b"socket.socket"}:
                        return f"Suspicious code in Python file: {pattern.decode()}"
        except Exception:
            pass

    return None


def search_models(
    query:  str,
    task:   Optional[str] = None,
    limit:  int = 20,
    sort:   str = "downloads",
) -> list[dict]:
    """
    Search the HuggingFace model hub.
    Returns a list of model card summaries safe to send as JSON.
    """
    try:
        from huggingface_hub import HfApi
        api = HfApi()

        kwargs: dict = {
            "search": query,
            "limit":  limit,
            "sort":   sort,
            "direction": -1,
        }
        if task:
            kwargs["pipeline_tag"] = task

        models = list(api.list_models(**kwargs))
        results = []
        for m in models:
            results.append({
                "id":         m.id,
                "author":     m.author or "",
                "name":       m.id.split("/")[-1],
                "task":       m.pipeline_tag or "",
                "downloads":  m.downloads or 0,
                "likes":      m.likes or 0,
                "tags":       list(m.tags or [])[:10],
                "updated_at": str(m.lastModified)[:10] if m.lastModified else "",
            })
        return results

    except ImportError:
        logger.error("[hf_service] huggingface_hub not installed")
        return []
    except Exception as exc:
        logger.error("[hf_service] search_models error: %s", exc)
        return []


# ─────────────────────────────────────────────────────────────────────────────
# MODEL INFO
# ─────────────────────────────────────────────────────────────────────────────

def get_model_info(model_id: str) -> dict:
    """
    Fetch metadata + file list for a specific model.
    Returns file names, sizes, and the suggested local destination for each.
    """
    try:
        from huggingface_hub import HfApi
        api = HfApi()
        info = api.model_info(model_id, files_metadata=True)

        files = []
        for f in (info.siblings or []):
            size = getattr(f, "size", None)
            filename = f.rfilename
            dest = str(_route_destination(model_id, filename))
            files.append({
                "filename":   filename,
                "size_bytes": size,
                "size_human": _fmt_size(size) if size else "unknown",
                "dest_dir":   dest,
                "suggested":  _is_suggested(filename),
            })

        # Sort: suggested files first, then by size descending
        files.sort(key=lambda x: (not x["suggested"], -(x["size_bytes"] or 0)))

        return {
            "id":          info.id,
            "author":      info.author or "",
            "task":        info.pipeline_tag or "",
            "license":     _extract_license(info),
            "tags":        list(info.tags or [])[:15],
            "description": (info.cardData or {}).get("language", ""),
            "files":       files,
        }

    except ImportError:
        return {"error": "huggingface_hub not installed"}
    except Exception as exc:
        logger.error("[hf_service] get_model_info error for %s: %s", model_id, exc)
        return {"error": str(exc)}


def _is_suggested(filename: str) -> bool:
    """True for files worth downloading (GGUF, ONNX, safetensors, config)."""
    name = filename.lower()
    return any(name.endswith(ext) for ext in (".gguf", ".onnx", ".bin", ".safetensors"))


def _extract_license(info) -> str:
    try:
        for tag in (info.tags or []):
            if tag.startswith("license:"):
                return tag.split(":", 1)[1]
    except Exception:
        pass
    return "unknown"


def _fmt_size(size_bytes: Optional[int]) -> str:
    if not size_bytes:
        return "?"
    for unit in ("B", "KB", "MB", "GB"):
        if size_bytes < 1024:
            return f"{size_bytes:.1f} {unit}"
        size_bytes /= 1024
    return f"{size_bytes:.1f} TB"


# ─────────────────────────────────────────────────────────────────────────────
# DOWNLOAD
# ─────────────────────────────────────────────────────────────────────────────

async def download_model_file(
    model_id:     str,
    filename:     str,
    dest_dir_override: Optional[str] = None,
) -> dict:
    """
    Start a background download of a single file from a HuggingFace model repo.
    Returns immediately with { download_id } — SSE events deliver progress.
    """
    download_id = str(uuid.uuid4())[:8]
    dest_dir = Path(dest_dir_override) if dest_dir_override else _route_destination(model_id, filename)
    dest_dir.mkdir(parents=True, exist_ok=True)

    cancel_event = asyncio.Event()
    _active_downloads[download_id] = {
        "model_id":  model_id,
        "filename":  filename,
        "dest_dir":  str(dest_dir),
        "cancel":    cancel_event,
        "status":    "downloading",
    }

    asyncio.create_task(
        _download_task(download_id, model_id, filename, dest_dir, cancel_event),
        name=f"hf_download_{download_id}",
    )

    return {
        "download_id": download_id,
        "model_id":    model_id,
        "filename":    filename,
        "dest_dir":    str(dest_dir),
        "status":      "started",
    }


async def _download_task(
    download_id:  str,
    model_id:     str,
    filename:     str,
    dest_dir:     Path,
    cancel_event: asyncio.Event,
) -> None:
    """Stream-download a file from HuggingFace CDN with SSE progress events."""
    from huggingface_hub import hf_hub_url

    dest_path = dest_dir / Path(filename).name
    tmp_path  = dest_path.with_suffix(dest_path.suffix + ".tmp")

    url = hf_hub_url(model_id, filename)
    logger.info("[hf_service] Download started: %s/%s → %s", model_id, filename, dest_path)

    # Include HF token for gated models
    headers = {}
    try:
        from huggingface_hub import HfFolder
        token = HfFolder.get_token()
        if token:
            headers["Authorization"] = f"Bearer {token}"
    except Exception:
        pass

    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=600) as client:
            async with client.stream("GET", url, headers=headers) as response:
                response.raise_for_status()
                total = int(response.headers.get("content-length", 0))
                done  = 0
                last_pct = -1

                with open(tmp_path, "wb") as f:
                    async for chunk in response.aiter_bytes(65536):
                        if cancel_event.is_set():
                            logger.info("[hf_service] Download cancelled: %s", download_id)
                            tmp_path.unlink(missing_ok=True)
                            await _emit_hf("hf_download_error", {
                                "download_id": download_id,
                                "model_id":    model_id,
                                "filename":    filename,
                                "message":     "Cancelled",
                            })
                            return

                        f.write(chunk)
                        done += len(chunk)

                        if total:
                            pct = int(done / total * 100)
                            if pct != last_pct and pct % 2 == 0:
                                last_pct = pct
                                await _emit_hf("hf_download_progress", {
                                    "download_id": download_id,
                                    "model_id":    model_id,
                                    "filename":    filename,
                                    "pct":         pct,
                                    "bytes_done":  done,
                                    "total_bytes": total,
                                })

        # ── Safety scan before finalising ──
        scan_result = _scan_downloaded_file(tmp_path, filename)
        if scan_result:
            tmp_path.unlink(missing_ok=True)
            _active_downloads.pop(download_id, None)
            logger.warning("[hf_service] Safety scan BLOCKED %s: %s", filename, scan_result)
            await _emit_hf("hf_download_error", {
                "download_id": download_id,
                "model_id":    model_id,
                "filename":    filename,
                "message":     f"Blocked by safety scan: {scan_result}",
            })
            return

        tmp_path.rename(dest_path)
        _active_downloads.pop(download_id, None)

        logger.info("[hf_service] Download complete: %s (%s)", filename, _fmt_size(done))
        await _emit_hf("hf_download_complete", {
            "download_id": download_id,
            "model_id":    model_id,
            "filename":    filename,
            "dest_path":   str(dest_path),
            "size_bytes":  done,
        })

    except Exception as exc:
        tmp_path.unlink(missing_ok=True)
        _active_downloads.pop(download_id, None)
        logger.error("[hf_service] Download failed %s/%s: %s", model_id, filename, exc)
        await _emit_hf("hf_download_error", {
            "download_id": download_id,
            "model_id":    model_id,
            "filename":    filename,
            "message":     str(exc),
        })


def cancel_download(download_id: str) -> bool:
    entry = _active_downloads.get(download_id)
    if entry:
        entry["cancel"].set()
        return True
    return False


def get_active_downloads() -> list[dict]:
    return [
        {"download_id": k, **{kk: vv for kk, vv in v.items() if kk != "cancel"}}
        for k, v in _active_downloads.items()
    ]


async def _emit_hf(event_type: str, data: dict) -> None:
    try:
        from app.controller.chat_controller import _emit
        await _emit(event_type, data)
    except Exception:
        pass


# ─────────────────────────────────────────────────────────────────────────────
# LOCAL MODEL INVENTORY
# ─────────────────────────────────────────────────────────────────────────────

def list_local_models() -> list[dict]:
    """
    Scan all ~/.aura/models/ subdirectories and return every model file.
    Groups by subdirectory. Includes size, path, and file type.
    """
    if not MODELS_ROOT.exists():
        return []

    results = []
    scan_exts = {".gguf", ".onnx", ".bin", ".safetensors", ".pt", ".pth"}

    for f in sorted(MODELS_ROOT.rglob("*")):
        if not f.is_file():
            continue
        if f.suffix.lower() not in scan_exts:
            continue
        if f.suffix.lower() == ".tmp":
            continue

        stat = f.stat()
        rel  = f.relative_to(MODELS_ROOT)
        category = rel.parts[0] if len(rel.parts) > 1 else "misc"

        results.append({
            "path":       str(f),
            "filename":   f.name,
            "category":   category,
            "size_bytes": stat.st_size,
            "size_human": _fmt_size(stat.st_size),
            "ext":        f.suffix.lower(),
        })

    return results


def delete_local_model(file_path: str) -> dict:
    """
    Delete a local model file. Only allows deletion within ~/.aura/models/.
    Returns { deleted: bool, message: str }.
    """
    try:
        target = Path(file_path).resolve()
        allowed_root = MODELS_ROOT.resolve()

        # Security: only allow deletion inside the models directory
        if not str(target).startswith(str(allowed_root)):
            return {"deleted": False, "message": "Path outside models directory — refused"}

        if not target.exists():
            return {"deleted": False, "message": "File not found"}

        size = target.stat().st_size
        target.unlink()
        logger.info("[hf_service] Deleted model: %s (%s)", target.name, _fmt_size(size))
        return {"deleted": True, "message": f"Deleted {target.name} ({_fmt_size(size)})"}

    except Exception as exc:
        logger.error("[hf_service] delete_local_model error: %s", exc)
        return {"deleted": False, "message": str(exc)}
