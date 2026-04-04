"""
AURA NX-Alpha — LLMFit Service

Smart model recommendation engine. Given detected GPU VRAM, returns:
    - All models that fit (interface + workhorse)
    - The single best pair recommendation
    - Already-downloaded models with registry metadata

Hardware modes:
    interface_only  — VRAM < 20 GB. Only GGUF interface models offered.
    full            — VRAM >= 20 GB. Both interface and Ollama workhorse offered.
"""

from __future__ import annotations

import logging
from dataclasses import asdict
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

# Safety buffer — always reserve this much VRAM for OS/desktop/drivers
SAFETY_BUFFER_MB: int = 500

# Workhorse threshold — imported from hardware_gate (single source of truth)
from app.service.hardware_gate import VRAM_THRESHOLD_MB as FULL_MODE_THRESHOLD_MB


# ─────────────────────────────────────────────────────────────────────────────
# FIT SUGGESTIONS
# ─────────────────────────────────────────────────────────────────────────────

def get_fit_suggestions(vram_mb: int, current_interface_vram: int = 0) -> dict:
    """
    Return all models that fit the detected VRAM.

    Parameters
    ----------
    vram_mb : int
        Total GPU VRAM in MB (from hardware_gate).
    current_interface_vram : int
        VRAM already consumed by the loaded interface model (for workhorse
        candidate calculation). 0 if nothing loaded yet.

    Returns
    -------
    dict with keys:
        vram_total_mb, vram_effective_mb, hardware_mode,
        interface_candidates, workhorse_candidates,
        workhorse_locked, workhorse_locked_reason
    """
    from app.data.llmfit_registry import (
        INTERFACE_MODELS, WORKHORSE_MODELS,
        interface_model_to_dict, workhorse_model_to_dict,
    )

    effective = vram_mb - SAFETY_BUFFER_MB
    hardware_mode = "full" if vram_mb >= FULL_MODE_THRESHOLD_MB else "interface_only"

    # ── Interface candidates ─────────────────────────────────────────────────
    interface_candidates = []
    for m in INTERFACE_MODELS:
        fits = m.total_vram_mb <= effective
        entry = interface_model_to_dict(m)
        entry["fits"] = fits
        entry["headroom_mb"] = effective - m.total_vram_mb if fits else 0
        interface_candidates.append(entry)

    # Sort: biggest that fits first
    interface_candidates.sort(key=lambda c: (-c["fits"], -c["total_vram_mb"]))

    # ── Workhorse candidates ─────────────────────────────────────────────────
    workhorse_candidates = []
    workhorse_locked = hardware_mode != "full"
    workhorse_locked_reason: Optional[str] = None

    if workhorse_locked:
        workhorse_locked_reason = (
            f"Workhorse requires >= 20 GB VRAM. Detected: {vram_mb} MB. "
            "Only interface models are available in this mode."
        )
    else:
        remaining = effective - current_interface_vram
        for m in WORKHORSE_MODELS:
            fits = m.vram_mb <= remaining
            entry = workhorse_model_to_dict(m)
            entry["fits"] = fits
            entry["headroom_mb"] = remaining - m.vram_mb if fits else 0
            workhorse_candidates.append(entry)

        workhorse_candidates.sort(key=lambda c: (-c["fits"], -c["total_vram_mb"]))

    return {
        "vram_total_mb": vram_mb,
        "vram_effective_mb": effective,
        "hardware_mode": hardware_mode,
        "interface_candidates": interface_candidates,
        "workhorse_candidates": workhorse_candidates,
        "workhorse_locked": workhorse_locked,
        "workhorse_locked_reason": workhorse_locked_reason,
    }


# ─────────────────────────────────────────────────────────────────────────────
# RECOMMENDED PAIR
# ─────────────────────────────────────────────────────────────────────────────

def get_recommended_pair(vram_mb: int) -> dict:
    """
    Pick the single best interface + workhorse pair for the given VRAM.

    Strategy:
        1. Pick the largest interface model that fits with > 500 MB headroom.
        2. For full mode, pick the largest workhorse that fits the remainder.

    Returns
    -------
    dict with keys: interface (dict | None), workhorse (dict | None)
    """
    from app.data.llmfit_registry import (
        INTERFACE_MODELS, WORKHORSE_MODELS,
        interface_model_to_dict, workhorse_model_to_dict,
    )

    effective = vram_mb - SAFETY_BUFFER_MB
    hardware_mode = "full" if vram_mb >= FULL_MODE_THRESHOLD_MB else "interface_only"

    # ── Best interface ───────────────────────────────────────────────────────
    # On small GPUs (<8GB) accept tighter headroom (200MB vs 500MB)
    min_headroom = 200 if vram_mb < 8192 else SAFETY_BUFFER_MB
    best_interface = None
    for m in sorted(INTERFACE_MODELS, key=lambda x: x.total_vram_mb, reverse=True):
        headroom = effective - m.total_vram_mb
        if headroom >= min_headroom:
            best_interface = m
            break

    interface_result = None
    if best_interface is not None:
        entry = interface_model_to_dict(best_interface)
        entry["fits"] = True
        entry["headroom_mb"] = effective - best_interface.total_vram_mb
        interface_result = entry

    # ── Best workhorse ───────────────────────────────────────────────────────
    workhorse_result = None
    if hardware_mode == "full" and best_interface is not None:
        remaining = effective - best_interface.total_vram_mb
        for m in sorted(WORKHORSE_MODELS, key=lambda x: x.vram_mb, reverse=True):
            if m.vram_mb <= remaining:
                entry = workhorse_model_to_dict(m)
                entry["fits"] = True
                entry["headroom_mb"] = remaining - m.vram_mb
                workhorse_result = entry
                break

    return {
        "interface": interface_result,
        "workhorse": workhorse_result,
    }


# ─────────────────────────────────────────────────────────────────────────────
# LOCAL MODEL DISCOVERY
# ─────────────────────────────────────────────────────────────────────────────

def get_local_models() -> dict:
    """
    Return already-downloaded models for both roles.

    Interface: scan ~/.aura/models/ for .gguf files, match against registry.
    Workhorse: query Ollama API for pulled models, match against registry.

    Returns
    -------
    dict with keys: interface (list), workhorse (list)
    Each entry includes registry metadata if matched, plus downloaded=True.
    """
    from app.data.llmfit_registry import (
        INTERFACE_MODELS, WORKHORSE_MODELS,
        interface_model_to_dict, workhorse_model_to_dict,
        get_interface_model, get_workhorse_model,
    )

    # ── Interface: query Ollama for pulled interface models ───────────────────
    interface_local: list[dict] = []
    try:
        from app.config import get_settings
        from app.service.ollama_service import get_ollama_service
        settings = get_settings()
        svc = get_ollama_service()
        if svc:
            client = svc._client
        else:
            import ollama
            client = ollama.Client(host=settings.interface_model.ollama_host)
        result = client.list()

        for m in result.models:
            model_name = m.model
            # Only include models that match the interface registry
            reg = get_interface_model(model_name)
            if reg is None:
                # Check prefix match (e.g. "qwen3.5:9b" matches "qwen3.5:9b-instruct-q4_k_m")
                base = model_name.split(":")[0]
                reg = next((r for r in INTERFACE_MODELS if r.ollama_name.split(":")[0] == base), None)
            if reg is None:
                continue

            entry = {
                "downloaded": True,
                "ollama_name": model_name,
                "size_bytes": m.size,
                "size_gb": round(m.size / 1e9, 1),
                "family": m.details.family if m.details else "",
                "parameters": m.details.parameter_size if m.details else "",
                "quantization": m.details.quantization_level if m.details else "",
            }
            entry.update(interface_model_to_dict(reg))
            interface_local.append(entry)

    except ImportError:
        logger.debug("[llmfit] ollama package not installed — skipping interface scan")
    except Exception as exc:
        logger.warning("[llmfit] Failed to query Ollama interface models: %s", exc)

    # ── Workhorse: query Ollama ──────────────────────────────────────────────
    workhorse_local: list[dict] = []
    try:
        from app.config import get_settings
        from app.service.ollama_service import get_ollama_service
        settings = get_settings()
        svc = get_ollama_service()
        if svc:
            client = svc._client
        else:
            import ollama
            client = ollama.Client(host=settings.workhorse.ollama_host)
        result = client.list()

        for m in result.models:
            model_name = m.model
            entry = {
                "downloaded": True,
                "ollama_name": model_name,
                "size_bytes": m.size,
                "size_gb": round(m.size / 1e9, 1),
                "family": m.details.family if m.details else "",
                "parameters": m.details.parameter_size if m.details else "",
                "quantization": m.details.quantization_level if m.details else "",
            }

            # Match against registry
            reg = get_workhorse_model(model_name)
            if reg:
                entry.update(workhorse_model_to_dict(reg))
            else:
                entry["display_name"] = model_name
                entry["params"] = entry.get("parameters", "")
                entry["quant"] = entry.get("quantization", "")
                entry["vram_mb"] = 0
                entry["total_vram_mb"] = 0
                entry["source"] = "ollama"
                entry["capabilities"] = []
                entry["notes"] = "Not in registry — unknown VRAM requirements."

            workhorse_local.append(entry)

    except ImportError:
        logger.debug("[llmfit] ollama package not installed — skipping workhorse scan")
    except Exception as exc:
        logger.warning("[llmfit] Failed to query Ollama models: %s", exc)

    return {
        "interface": interface_local,
        "workhorse": workhorse_local,
    }
