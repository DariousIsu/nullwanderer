"""
AURA NX-Alpha — System Controller
REST API for process management, model operations, and Ollama model management.

PROCESS ROUTES:
    GET  /system/services              — all service statuses
    GET  /system/services/{id}         — single service status
    POST /system/services/{id}/launch  — trigger manual launch

HUGGINGFACE ROUTES:
    GET  /hf/search                    — search model hub (?q=&task=&limit=)
    GET  /hf/model/{model_id:path}     — model info + file list
    POST /hf/download                  — start file download (returns download_id)
    DELETE /hf/download/{download_id}  — cancel active download
    GET  /hf/downloads                 — list active downloads
    GET  /hf/local                     — list all downloaded local models
    DELETE /hf/local                   — delete a local model file

OLLAMA ROUTES:
    GET  /ollama/models                — list all pulled Ollama models
    POST /ollama/pull                  — pull a new model from Ollama registry
    DELETE /ollama/models/{name}       — delete an Ollama model

MODEL ASSIGNMENT:
    GET  /models/assignments           — current interface + workhorse assignments
    PUT  /models/assign                — assign a model to a role (interface/workhorse)

LLMFIT ROUTES:
    GET    /llmfit/suggestions         — all fitting models for current GPU
    GET    /llmfit/recommend           — single best model pair recommendation
    POST   /llmfit/accept              — accept a model selection (triggers download)
    DELETE /llmfit/purge               — manually purge a downloaded model
"""

import logging
from typing import Optional

from fastapi import APIRouter
from pydantic import BaseModel

# Shared Ollama client cache — avoids socket leaks from creating a new Client per request
_ollama_clients: dict[str, "ollama.Client"] = {}


def _get_ollama_client(host: str):
    """Return a cached ollama.Client for the given host."""
    import ollama
    if host not in _ollama_clients:
        _ollama_clients[host] = ollama.Client(host=host)
    return _ollama_clients[host]

logger = logging.getLogger(__name__)

router = APIRouter(tags=["system"])


# ─────────────────────────────────────────────────────────────────────────────
# PROCESS MANAGER ROUTES
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/system/services")
async def get_all_services() -> dict:
    """Return current status of all managed services."""
    try:
        from app.service.process_manager import get_service_status
        return {"services": list(get_service_status().values())}
    except Exception as exc:
        logger.error("[system_controller] get_all_services error: %s", exc)
        return {"services": []}


@router.get("/system/services/{service_id}")
async def get_service(service_id: str) -> dict:
    """Return status for a single managed service."""
    try:
        from app.service.process_manager import get_service_status
        return get_service_status(service_id)
    except Exception as exc:
        return {"id": service_id, "status": "error", "message": str(exc)}


@router.post("/system/services/{service_id}/launch")
async def launch_service(service_id: str) -> dict:
    """
    Manually trigger launch of a stopped service.
    Returns immediately — SSE `service_status` events deliver the result.
    """
    try:
        from app.service.process_manager import launch_service as _launch
        return await _launch(service_id)
    except Exception as exc:
        logger.error("[system_controller] launch_service error: %s", exc)
        return {"status": "error", "message": str(exc)}


# ─────────────────────────────────────────────────────────────────────────────
# HUGGINGFACE ROUTES
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/hf/search")
async def hf_search(
    q:     str = "",
    task:  Optional[str] = None,
    limit: int = 20,
    sort:  str = "downloads",
) -> dict:
    """
    Search HuggingFace model hub.
    Returns list of model summaries with id, name, task, downloads, tags.
    """
    import asyncio
    try:
        from app.service.huggingface_service import search_models
        results = await asyncio.to_thread(search_models, q, task, limit, sort)
        return {"models": results, "count": len(results)}
    except Exception as exc:
        logger.error("[system_controller] hf_search error: %s", exc)
        return {"models": [], "count": 0, "error": str(exc)}


@router.get("/hf/model/{model_id:path}")
async def hf_model_info(model_id: str) -> dict:
    """
    Fetch metadata + file list for a HuggingFace model.
    Each file includes its suggested local destination directory.
    """
    import asyncio
    try:
        from app.service.huggingface_service import get_model_info
        return await asyncio.to_thread(get_model_info, model_id)
    except Exception as exc:
        logger.error("[system_controller] hf_model_info error: %s", exc)
        return {"error": str(exc)}


class DownloadRequest(BaseModel):
    model_id:          str
    filename:          str
    dest_dir_override: Optional[str] = None   # leave None for smart routing


@router.post("/hf/download")
async def hf_download(body: DownloadRequest) -> dict:
    """
    Start a background download of one file from a HuggingFace model repo.
    Returns { download_id } immediately.
    SSE events: hf_download_progress, hf_download_complete, hf_download_error.
    """
    try:
        from app.service.huggingface_service import download_model_file
        return await download_model_file(
            body.model_id,
            body.filename,
            body.dest_dir_override,
        )
    except Exception as exc:
        logger.error("[system_controller] hf_download error: %s", exc)
        return {"status": "error", "message": str(exc)}


@router.delete("/hf/download/{download_id}")
async def hf_cancel_download(download_id: str) -> dict:
    """Cancel an active download."""
    try:
        from app.service.huggingface_service import cancel_download
        cancelled = cancel_download(download_id)
        return {"cancelled": cancelled, "download_id": download_id}
    except Exception as exc:
        return {"cancelled": False, "message": str(exc)}


@router.get("/hf/downloads")
async def hf_active_downloads() -> dict:
    """List all currently active downloads."""
    try:
        from app.service.huggingface_service import get_active_downloads
        return {"downloads": get_active_downloads()}
    except Exception as exc:
        return {"downloads": [], "error": str(exc)}


@router.get("/hf/local")
async def hf_local_models() -> dict:
    """
    List all model files in ~/.aura/models/.
    Grouped by category (interface, voice, embeddings, misc).
    """
    import asyncio
    try:
        from app.service.huggingface_service import list_local_models
        models = await asyncio.to_thread(list_local_models)

        # Group by category
        groups: dict = {}
        total_bytes = 0
        for m in models:
            cat = m["category"]
            groups.setdefault(cat, []).append(m)
            total_bytes += m.get("size_bytes", 0)

        from app.service.huggingface_service import _fmt_size
        return {
            "groups":      groups,
            "total_files": len(models),
            "total_size":  _fmt_size(total_bytes),
        }
    except Exception as exc:
        logger.error("[system_controller] hf_local_models error: %s", exc)
        return {"groups": {}, "total_files": 0, "total_size": "0 B"}


class DeleteModelRequest(BaseModel):
    file_path: str


@router.delete("/hf/local")
async def hf_delete_local(body: DeleteModelRequest) -> dict:
    """
    Delete a local model file. Restricted to ~/.aura/models/ for safety.
    """
    import asyncio
    try:
        from app.service.huggingface_service import delete_local_model
        return await asyncio.to_thread(delete_local_model, body.file_path)
    except Exception as exc:
        return {"deleted": False, "message": str(exc)}


# ─────────────────────────────────────────────────────────────────────────────
# OLLAMA MODEL MANAGEMENT
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/ollama/models")
async def list_ollama_models() -> dict:
    """List all pulled Ollama models with size and details."""
    import asyncio
    try:
        from app.config import get_settings
        settings = get_settings()
        client = _get_ollama_client(settings.workhorse.ollama_host)
        result = client.list()
        models = []
        for m in result.models:
            details = m.details
            models.append({
                "name":        m.model,
                "model":       m.model,
                "size_bytes":  m.size,
                "size_gb":     round(m.size / 1e9, 1),
                "family":      details.family if details else "",
                "parameters":  details.parameter_size if details else "",
                "quantization": details.quantization_level if details else "",
                "modified_at": str(m.modified_at) if m.modified_at else "",
            })
        return {"models": models}
    except ImportError:
        return {"models": [], "error": "ollama package not installed"}
    except Exception as exc:
        logger.error("[system_controller] list_ollama_models error: %s", exc)
        return {"models": [], "error": str(exc)}


class OllamaPullRequest(BaseModel):
    model: str


@router.post("/ollama/pull")
async def pull_ollama_model(body: OllamaPullRequest) -> dict:
    """Pull a model from Ollama registry. Streams progress via SSE."""
    import asyncio
    try:
        from app.config import get_settings
        from app.controller.chat_controller import _emit

        settings = get_settings()
        client = _get_ollama_client(settings.workhorse.ollama_host)

        async def _do_pull():
            try:
                for progress in client.pull(body.model, stream=True):
                    status = progress.status or ""
                    total = progress.total or 0
                    completed = progress.completed or 0
                    pct = round((completed / total * 100)) if total > 0 else 0
                    await _emit("hf_download_progress", {
                        "model": body.model,
                        "status": status,
                        "pct": pct,
                        "completed": completed,
                        "total": total,
                    })
                await _emit("hf_download_complete", {"model": body.model})
            except Exception as exc:
                await _emit("hf_download_error", {"model": body.model, "error": str(exc)})

        asyncio.create_task(_do_pull())
        return {"status": "pulling", "model": body.model}
    except ImportError:
        return {"status": "error", "message": "ollama package not installed"}
    except Exception as exc:
        return {"status": "error", "message": str(exc)}


@router.delete("/ollama/models/{model_name:path}")
async def delete_ollama_model(model_name: str) -> dict:
    """Delete a pulled Ollama model."""
    try:
        from app.config import get_settings
        settings = get_settings()
        client = _get_ollama_client(settings.workhorse.ollama_host)
        client.delete(model_name)
        return {"deleted": True, "model": model_name}
    except Exception as exc:
        return {"deleted": False, "message": str(exc)}


# ─────────────────────────────────────────────────────────────────────────────
# MODEL ASSIGNMENT
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/models/assignments")
async def get_model_assignments() -> dict:
    """Return current model-to-role assignments + available models for each role."""
    import asyncio
    from app.config import get_settings
    settings = get_settings()

    # Current assignments
    assignments = {
        "interface": {
            "name": settings.interface_model_name,
            "type": "gguf",
            "gguf_path": settings.interface_model.gguf_path,
        },
        "workhorse": {
            "name": settings.workhorse_model_name,
            "type": "ollama",
            "model": settings.workhorse.model,
        },
    }

    # Available GGUF files
    gguf_models = []
    try:
        from app.service.huggingface_service import list_local_models
        for m in list_local_models():
            if m.get("ext") == ".gguf":
                gguf_models.append({
                    "path":     m["path"],
                    "filename": m["filename"],
                    "size_gb":  round(m.get("size_bytes", 0) / 1e9, 1),
                })
    except Exception:
        pass

    # Available Ollama models
    ollama_models = []
    try:
        client = _get_ollama_client(settings.workhorse.ollama_host)
        result = client.list()
        for m in result.models:
            ollama_models.append({
                "name":    m.model,
                "size_gb": round(m.size / 1e9, 1),
                "parameters": m.details.parameter_size if m.details else "",
            })
    except Exception:
        pass

    return {
        "assignments": assignments,
        "available_gguf": gguf_models,
        "available_ollama": ollama_models,
    }


class ModelAssignRequest(BaseModel):
    role: str                       # "interface" | "workhorse"
    model: str                      # Ollama model name


@router.put("/models/assign")
async def assign_model(body: ModelAssignRequest) -> dict:
    """
    Assign a model to a role. Persists to settings.json and .env.
    Requires restart to take effect for the interface engine.
    """
    from app.controller.chat_controller import _persist_settings_json, _emit
    import asyncio

    if body.role == "workhorse":
        # Hot-swap Ollama model (can be done at runtime)
        try:
            from app.service.ollama_service import get_ollama_service
            svc = get_ollama_service()
            if svc:
                svc._model = body.model
                logger.info("[system_controller] Workhorse model swapped to: %s", body.model)
        except Exception as exc:
            logger.warning("[system_controller] Ollama hot-swap failed: %s", exc)

        _persist_settings_json({"workhorse": {"model": body.model}})
        # Also update .env for next restart
        _update_env_var("AURA_WORKHORSE__MODEL", body.model)

        # Emit updated model_status
        try:
            from app.controller.chat_controller import models_status
            status = await models_status()
            await _emit("model_status", status)
        except Exception:
            pass

        return {"status": "assigned", "role": "workhorse", "model": body.model, "restart_required": False}

    elif body.role == "interface":
        # Hot-swap Ollama model name on the interface engine
        try:
            from app.service.interface_engine import get_engine
            engine = get_engine()
            if engine and engine._svc:
                engine._svc.model = body.model
                engine._cfg.model = body.model
                logger.info("[system_controller] Interface engine swapped to: %s", body.model)
        except Exception as exc:
            logger.warning("[system_controller] Interface swap failed: %s", exc)

        _persist_settings_json({"interface_model": {"model": body.model}})
        _update_env_var("AURA_INTERFACE_MODEL__MODEL", body.model)

        # Emit updated model_status
        try:
            from app.controller.chat_controller import models_status
            status = await models_status()
            await _emit("model_status", status)
        except Exception:
            pass

        return {"status": "assigned", "role": "interface", "model": body.model, "restart_required": False}

    return {"status": "error", "message": f"Unknown role: {body.role}"}


def _update_env_var(key: str, value: str) -> None:
    """Update a single variable in backend/.env."""
    from pathlib import Path as _Path
    env_path = _Path(__file__).parent.parent / ".env"
    try:
        if not env_path.exists():
            return
        lines = env_path.read_text(encoding="utf-8").splitlines()
        updated = False
        for i, line in enumerate(lines):
            stripped = line.strip()
            if stripped.startswith(f"{key}=") or stripped.startswith(f"# {key}="):
                lines[i] = f"{key}={value}"
                updated = True
                break
        if not updated:
            lines.append(f"{key}={value}")
        env_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        logger.info("[system_controller] .env updated: %s=%s", key, value)
    except Exception as exc:
        logger.warning("[system_controller] .env update failed: %s", exc)


# ─────────────────────────────────────────────────────────────────────────────
# LLMFIT — SMART MODEL RECOMMENDATIONS
# ─────────────────────────────────────────────────────────────────────────────

class LlmFitAcceptRequest(BaseModel):
    role: str           # "interface" | "workhorse"
    model_id: str       # HuggingFace repo ID or Ollama model name
    filename: Optional[str] = None   # Required for interface (GGUF filename)


class LlmFitPurgeRequest(BaseModel):
    role: str           # "interface" | "workhorse"
    model_id: str       # HuggingFace repo ID or Ollama model name


@router.get("/llmfit/suggestions")
async def llmfit_suggestions() -> dict:
    """Return all fitting models for current GPU, plus already-downloaded models."""
    try:
        from app.service.hardware_gate import get_vram_mb
        from app.service.llmfit_service import get_fit_suggestions, get_local_models

        vram = get_vram_mb()
        suggestions = get_fit_suggestions(vram)
        local = get_local_models()

        return {
            **suggestions,
            "local_models": local,
        }
    except Exception as exc:
        logger.error("[system_controller] llmfit_suggestions error: %s", exc)
        return {"error": str(exc)}


@router.get("/llmfit/recommend")
async def llmfit_recommend() -> dict:
    """Return the single best model pair recommendation for current GPU."""
    try:
        from app.service.hardware_gate import get_vram_mb
        from app.service.llmfit_service import get_recommended_pair

        vram = get_vram_mb()
        pair = get_recommended_pair(vram)

        return {
            "vram_mb": vram,
            **pair,
        }
    except Exception as exc:
        logger.error("[system_controller] llmfit_recommend error: %s", exc)
        return {"error": str(exc)}


@router.post("/llmfit/accept")
async def llmfit_accept(body: LlmFitAcceptRequest) -> dict:
    """
    Accept a model selection. Triggers download + assign.

    For interface (GGUF):
        - Downloads the GGUF file from HuggingFace via existing download service.
        - Progress emitted via SSE hf_download_progress / hf_download_complete.

    For workhorse (Ollama):
        - If a different model is currently assigned, deletes it first.
        - Pulls the new model. Progress via SSE.
        - Assigns on completion.
    """
    import asyncio

    if body.role == "interface":
        # Interface models are now Ollama — pull via Ollama registry
        try:
            from app.config import get_settings
            from app.controller.chat_controller import _emit, _persist_settings_json

            settings = get_settings()
            client = _get_ollama_client(settings.interface_model.ollama_host)

            async def _do_pull_interface():
                try:
                    for progress in client.pull(body.model_id, stream=True):
                        status = progress.status or ""
                        total = progress.total or 0
                        completed = progress.completed or 0
                        pct = round((completed / total * 100)) if total > 0 else 0
                        await _emit("hf_download_progress", {
                            "model": body.model_id,
                            "status": status,
                            "pct": pct,
                            "completed": completed,
                            "total": total,
                        })

                    # Auto-assign on completion
                    _persist_settings_json({"interface_model": {"model": body.model_id}})
                    _update_env_var("AURA_INTERFACE_MODEL__MODEL", body.model_id)

                    try:
                        from app.service.interface_engine import get_engine
                        engine = get_engine()
                        if engine and engine._svc:
                            engine._svc.model = body.model_id
                            engine._cfg.model = body.model_id
                    except Exception:
                        pass

                    await _emit("hf_download_complete", {"model": body.model_id})
                    logger.info("[system_controller] Interface model assigned: %s", body.model_id)
                except Exception as exc:
                    await _emit("hf_download_error", {"model": body.model_id, "error": str(exc)})

            asyncio.create_task(_do_pull_interface())
            return {"status": "pulling", "role": "interface", "model": body.model_id}

        except ImportError:
            return {"status": "error", "message": "ollama package not installed"}
        except Exception as exc:
            logger.error("[system_controller] llmfit_accept interface error: %s", exc)
            return {"status": "error", "message": str(exc)}

    elif body.role == "workhorse":
        try:
            from app.config import get_settings
            from app.controller.chat_controller import _emit

            settings = get_settings()
            client = _get_ollama_client(settings.workhorse.ollama_host)

            # Delete the currently assigned model if it differs
            current_model = settings.workhorse.model
            if current_model and current_model != body.model_id:
                try:
                    client.delete(current_model)
                    logger.info(
                        "[system_controller] Deleted old workhorse model: %s",
                        current_model,
                    )
                except Exception as del_exc:
                    logger.warning(
                        "[system_controller] Could not delete old workhorse %s: %s",
                        current_model, del_exc,
                    )

            # Pull the new model in background
            async def _do_pull_and_assign():
                try:
                    for progress in client.pull(body.model_id, stream=True):
                        status = progress.status or ""
                        total = progress.total or 0
                        completed = progress.completed or 0
                        pct = round((completed / total * 100)) if total > 0 else 0
                        await _emit("hf_download_progress", {
                            "model": body.model_id,
                            "status": status,
                            "pct": pct,
                            "completed": completed,
                            "total": total,
                        })

                    # Auto-assign on completion
                    from app.controller.chat_controller import _persist_settings_json
                    _persist_settings_json({"workhorse": {"model": body.model_id}})
                    _update_env_var("AURA_WORKHORSE__MODEL", body.model_id)

                    try:
                        from app.service.ollama_service import get_ollama_service
                        svc = get_ollama_service()
                        if svc:
                            svc._model = body.model_id
                    except Exception:
                        pass

                    await _emit("hf_download_complete", {"model": body.model_id})
                    logger.info("[system_controller] Workhorse assigned: %s", body.model_id)
                except Exception as exc:
                    await _emit("hf_download_error", {
                        "model": body.model_id,
                        "error": str(exc),
                    })

            asyncio.create_task(_do_pull_and_assign())
            return {"status": "pulling", "role": "workhorse", "model": body.model_id}

        except ImportError:
            return {"status": "error", "message": "ollama package not installed"}
        except Exception as exc:
            logger.error("[system_controller] llmfit_accept workhorse error: %s", exc)
            return {"status": "error", "message": str(exc)}

    return {"status": "error", "message": f"Unknown role: {body.role}"}


@router.delete("/llmfit/purge")
async def llmfit_purge(body: LlmFitPurgeRequest) -> dict:
    """
    Manually purge a downloaded model.

    For interface: delete via Ollama API.
    For workhorse: delete via Ollama API.
    """
    if body.role == "interface":
        try:
            from app.config import get_settings
            settings = get_settings()
            client = _get_ollama_client(settings.interface_model.ollama_host)
            client.delete(body.model_id)
            logger.info("[system_controller] Purged interface model: %s", body.model_id)
            return {"role": "interface", "model_id": body.model_id, "deleted": True}
        except Exception as exc:
            logger.error("[system_controller] llmfit_purge interface error: %s", exc)
            return {"deleted": False, "message": str(exc)}

    elif body.role == "workhorse":
        try:
            from app.config import get_settings
            settings = get_settings()
            client = _get_ollama_client(settings.workhorse.ollama_host)
            client.delete(body.model_id)
            logger.info("[system_controller] Purged workhorse model: %s", body.model_id)
            return {"role": "workhorse", "model_id": body.model_id, "deleted": True}
        except Exception as exc:
            logger.error("[system_controller] llmfit_purge workhorse error: %s", exc)
            return {"deleted": False, "message": str(exc)}

    return {"deleted": False, "message": f"Unknown role: {body.role}"}
