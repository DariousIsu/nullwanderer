"""
AURA NX-Alpha — LLMFit Model Registry

Curated registry of known-good models for both roles:
    Interface  — Ollama models (keep_alive=-1, always loaded, vision-capable)
    Workhorse  — Ollama models (keep_alive=5m, cold-start, analytics/reasoning)

Each entry carries VRAM requirements so the fit engine can recommend models
that actually fit the user's hardware without guesswork.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List


# ─────────────────────────────────────────────────────────────────────────────
# DATA CLASSES
# ─────────────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class InterfaceModel:
    """An Ollama model for the Interface Engine role (always-on, vision-capable)."""
    ollama_name: str            # e.g. "qwen3.5:9b"
    display_name: str
    family: str                 # qwen3.5, gemma3, ...
    params: str                 # "9B", "12B", etc.
    quant: str                  # Ollama default quant (usually Q4_K_M)
    vram_mb: int                # Approx VRAM for model weights
    total_vram_mb: int          # Model + KV cache
    source: str = "ollama"
    capabilities: List[str] = field(default_factory=list)
    notes: str = ""


@dataclass(frozen=True)
class WorkhorseModel:
    """An Ollama-native model."""
    ollama_name: str            # e.g. "gemma3:4b"
    display_name: str
    family: str
    params: str
    quant: str                  # Ollama default quant (usually Q4_K_M)
    vram_mb: int                # Approx VRAM for model weights
    total_vram_mb: int          # Model + KV cache
    source: str = "ollama"
    capabilities: List[str] = field(default_factory=list)
    notes: str = ""


# ─────────────────────────────────────────────────────────────────────────────
# INTERFACE MODELS  (Ollama — always-on, vision-capable)
# ─────────────────────────────────────────────────────────────────────────────

INTERFACE_MODELS: list[InterfaceModel] = [
    InterfaceModel(
        ollama_name="gemma3:4b",
        display_name="Gemma 3 4B",
        family="gemma3",
        params="4B",
        quant="Q4_K_M",
        vram_mb=3200,
        total_vram_mb=4200,
        capabilities=["chat", "instruct", "vision"],
        notes="Compact always-on. 6 GB+ cards.",
    ),
    InterfaceModel(
        ollama_name="qwen3:8b",
        display_name="Qwen3 8B",
        family="qwen3",
        params="8B",
        quant="Q4_K_M",
        vram_mb=5200,
        total_vram_mb=6700,
        capabilities=["chat", "instruct", "code", "reasoning"],
        notes="Qwen3 generation. 8 GB+ cards.",
    ),
    InterfaceModel(
        ollama_name="qwen3.5:9b",
        display_name="Qwen3.5 9B",
        family="qwen3.5",
        params="9B",
        quant="Q4_K_M",
        vram_mb=5800,
        total_vram_mb=6600,
        capabilities=["chat", "instruct", "code", "reasoning", "vision", "thinking"],
        notes="Default for Phase 1. Vision-native, thinking toggle, 256K context.",
    ),
    InterfaceModel(
        ollama_name="gemma3:12b",
        display_name="Gemma 3 12B",
        family="gemma3",
        params="12B",
        quant="Q4_K_M",
        vram_mb=7800,
        total_vram_mb=9500,
        capabilities=["chat", "instruct", "vision", "reasoning"],
        notes="Strong vision + reasoning. 12 GB+ free VRAM.",
    ),
    InterfaceModel(
        ollama_name="qwen3:14b",
        display_name="Qwen3 14B",
        family="qwen3",
        params="14B",
        quant="Q4_K_M",
        vram_mb=9000,
        total_vram_mb=11000,
        capabilities=["chat", "instruct", "code", "reasoning"],
        notes="Large always-on. 14 GB+ free VRAM.",
    ),
]


# ─────────────────────────────────────────────────────────────────────────────
# WORKHORSE MODELS  (Ollama — requires >= 20 GB VRAM)
# ─────────────────────────────────────────────────────────────────────────────

WORKHORSE_MODELS: list[WorkhorseModel] = [
    WorkhorseModel(
        ollama_name="gemma3:4b",
        display_name="Gemma 3 4B",
        family="gemma",
        params="4B",
        quant="Q4_K_M",
        vram_mb=3300,
        total_vram_mb=4500,
        capabilities=["chat", "instruct", "vision"],
        notes="Lightweight workhorse. Leaves room for large interface model.",
    ),
    WorkhorseModel(
        ollama_name="qwen3:8b",
        display_name="Qwen3 8B",
        family="qwen3",
        params="8B",
        quant="Q4_K_M",
        vram_mb=5500,
        total_vram_mb=7000,
        capabilities=["chat", "instruct", "code", "reasoning"],
        notes="Good balance of quality and VRAM.",
    ),
    WorkhorseModel(
        ollama_name="qwen3.5:9b",
        display_name="Qwen3.5 9B",
        family="qwen3.5",
        params="9B",
        quant="Q4_K_M",
        vram_mb=6600,
        total_vram_mb=8200,
        capabilities=["chat", "instruct", "code", "reasoning"],
        notes="Latest Qwen generation. Strong reasoning.",
    ),
    WorkhorseModel(
        ollama_name="gemma3:12b",
        display_name="Gemma 3 12B",
        family="gemma",
        params="12B",
        quant="Q4_K_M",
        vram_mb=8000,
        total_vram_mb=10000,
        capabilities=["chat", "instruct", "vision"],
        notes="Default workhorse for Phase 1. Vision-capable.",
    ),
    WorkhorseModel(
        ollama_name="qwen3:14b",
        display_name="Qwen3 14B",
        family="qwen3",
        params="14B",
        quant="Q4_K_M",
        vram_mb=9000,
        total_vram_mb=11500,
        capabilities=["chat", "instruct", "code", "reasoning"],
        notes="Strong reasoning. Needs 12 GB+ remaining after interface.",
    ),
    WorkhorseModel(
        ollama_name="qwen3:32b",
        display_name="Qwen3 32B",
        family="qwen3",
        params="32B",
        quant="Q4_K_M",
        vram_mb=20000,
        total_vram_mb=24000,
        capabilities=["chat", "instruct", "code", "reasoning"],
        notes="Flagship workhorse. 24 GB+ remaining after interface.",
    ),
]


# ─────────────────────────────────────────────────────────────────────────────
# LOOKUP HELPERS
# ─────────────────────────────────────────────────────────────────────────────

_INTERFACE_BY_NAME: dict[str, InterfaceModel] = {m.ollama_name: m for m in INTERFACE_MODELS}
_WORKHORSE_BY_NAME: dict[str, WorkhorseModel] = {m.ollama_name: m for m in WORKHORSE_MODELS}


def get_interface_model(ollama_name: str) -> InterfaceModel | None:
    """Lookup an interface model by Ollama name."""
    return _INTERFACE_BY_NAME.get(ollama_name)


def get_workhorse_model(ollama_name: str) -> WorkhorseModel | None:
    """Lookup a workhorse model by Ollama name."""
    return _WORKHORSE_BY_NAME.get(ollama_name)


def interface_model_to_dict(m: InterfaceModel) -> dict:
    """Serialize an InterfaceModel for JSON responses."""
    return {
        "ollama_name": m.ollama_name,
        "display_name": m.display_name,
        "family": m.family,
        "params": m.params,
        "quant": m.quant,
        "vram_mb": m.vram_mb,
        "total_vram_mb": m.total_vram_mb,
        "source": m.source,
        "capabilities": list(m.capabilities),
        "notes": m.notes,
    }


def workhorse_model_to_dict(m: WorkhorseModel) -> dict:
    """Serialize a WorkhorseModel for JSON responses."""
    return {
        "ollama_name": m.ollama_name,
        "display_name": m.display_name,
        "family": m.family,
        "params": m.params,
        "quant": m.quant,
        "vram_mb": m.vram_mb,
        "total_vram_mb": m.total_vram_mb,
        "source": m.source,
        "capabilities": list(m.capabilities),
        "notes": m.notes,
    }
