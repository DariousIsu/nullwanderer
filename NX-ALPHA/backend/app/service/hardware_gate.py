"""
AURA NX-Alpha — Hardware Gate Service

Mode is determined entirely by detected GPU VRAM.
Ollama is never consulted — hardware is the source of truth.

THRESHOLD: 20 GB (20480 MB)
    < 20 GB  → interface_only  Team gate locked. Queue offered for team tasks.
    ≥ 20 GB  → full            Team gate can be opened. Ollama used normally.

VRAM DETECTION (in order):
    1. Windows registry qwMemorySize (64-bit, works for any GPU vendor)
    2. torch.cuda (if PyTorch with GPU support is installed)
    3. WMI AdapterRAM fallback (uint32, caps at ~4 GB — kept for edge cases)
    Returns 0 if all methods fail — treated as interface_only.

POLLING:
    Checks VRAM every 60s. If a new GPU is seated (VRAM crosses threshold),
    mode updates, SSE is emitted, and the task queue drains automatically.
"""

from __future__ import annotations

import asyncio
import logging
import subprocess
import sys

logger = logging.getLogger(__name__)

# ── Config ────────────────────────────────────────────────────────────────────

VRAM_THRESHOLD_MB: int = 20 * 1000   # ~20 GB (uses 1000 to allow for driver-reserved VRAM)

# ── State ─────────────────────────────────────────────────────────────────────

_mode: str = "interface_only"
_vram_mb: int = 0


# ── Public API ────────────────────────────────────────────────────────────────

def get_hardware_mode() -> str:
    """Return current mode: 'interface_only' or 'full'."""
    return _mode


def is_team_available() -> bool:
    """True when detected VRAM meets the 20 GB threshold."""
    return _mode == "full"


def get_vram_mb() -> int:
    """Detected GPU VRAM in MB (0 if undetectable)."""
    return _vram_mb


# ── VRAM detection ────────────────────────────────────────────────────────────

def _read_vram_mb() -> int:
    """
    Read total GPU VRAM in MB. Vendor-agnostic — works for NVIDIA, AMD, Intel.
    Returns the largest value found (multi-GPU → biggest card).
    Returns 0 if nothing is detectable.
    """
    best = 0

    # ── Method 1: Windows registry qwMemorySize (64-bit, any GPU vendor) ─────
    if sys.platform == "win32":
        try:
            import winreg
            base_path = (
                r"SYSTEM\ControlSet001\Control\Class"
                r"\{4d36e968-e325-11ce-bfc1-08002be10318}"
            )
            key = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, base_path)
            i = 0
            while True:
                try:
                    subkey_name = winreg.EnumKey(key, i)
                    i += 1
                except OSError:
                    break
                try:
                    subkey = winreg.OpenKey(key, subkey_name)
                    val, vtype = winreg.QueryValueEx(
                        subkey, "HardwareInformation.qwMemorySize",
                    )
                    # val is a 64-bit int (REG_QWORD) — bytes
                    mb = int(val) // (1024 * 1024)
                    if mb > best:
                        best = mb
                    winreg.CloseKey(subkey)
                except OSError:
                    continue
            winreg.CloseKey(key)
            if best > 0:
                logger.info("[hardware_gate] registry qwMemorySize detected %d MB VRAM", best)
                return best
        except Exception as exc:
            logger.debug("[hardware_gate] registry qwMemorySize failed: %s", exc)

    # ── Method 2: torch.cuda (works if PyTorch has GPU support) ──────────────
    try:
        import torch
        if torch.cuda.is_available():
            for i in range(torch.cuda.device_count()):
                props = torch.cuda.get_device_properties(i)
                mb = props.total_mem // (1024 * 1024)
                if mb > best:
                    best = mb
            if best > 0:
                logger.info("[hardware_gate] torch.cuda detected %d MB VRAM", best)
                return best
    except Exception as exc:
        logger.debug("[hardware_gate] torch.cuda failed: %s", exc)

    # ── Method 3: WMI AdapterRAM fallback (uint32, caps ~4 GB) ───────────────
    if sys.platform == "win32":
        try:
            result = subprocess.run(
                ["wmic", "path", "Win32_VideoController", "get",
                 "AdapterRAM", "/format:value"],
                capture_output=True, text=True, timeout=8,
            )
            for line in result.stdout.splitlines():
                line = line.strip()
                if line.lower().startswith("adapterram="):
                    raw = line.split("=", 1)[1].strip()
                    if raw.isdigit():
                        mb = int(raw) // (1024 * 1024)
                        if mb > best:
                            best = mb
            if best > 0:
                logger.info("[hardware_gate] wmic AdapterRAM detected %d MB VRAM (may be capped at 4 GB)", best)
                return best
        except Exception as exc:
            logger.debug("[hardware_gate] wmic failed: %s", exc)

    logger.warning("[hardware_gate] Could not detect GPU VRAM — defaulting to interface_only")
    return 0


# ── Mode update + SSE ─────────────────────────────────────────────────────────

async def _set_mode(new_mode: str) -> None:
    """Update mode and emit SSE if it changed. Drains queue on full transition."""
    global _mode
    if _mode == new_mode:
        return
    old = _mode
    _mode = new_mode
    logger.info(
        "[hardware_gate] Mode: %s → %s  (vram=%d MB, threshold=%d MB)",
        old, new_mode, _vram_mb, VRAM_THRESHOLD_MB,
    )

    try:
        from app.controller.chat_controller import _emit
        await _emit("hardware_mode", {
            "mode":           new_mode,
            "vram_mb":        _vram_mb,
            "threshold_mb":   VRAM_THRESHOLD_MB,
        })
    except Exception as exc:
        logger.warning("[hardware_gate] SSE emit failed: %s", exc)

    if new_mode == "full":
        try:
            from app.service.task_queue_service import get_task_queue_service
            svc = get_task_queue_service()
            if svc:
                asyncio.create_task(svc.drain_queue())
        except Exception as exc:
            logger.warning("[hardware_gate] Queue drain trigger failed: %s", exc)


# ── Init ─────────────────────────────────────────────────────────────────────

async def init_hardware_gate(**_kwargs) -> str:
    """
    Read VRAM once at startup and set mode. No polling — GPU can't change
    while the system is running. Restart required to detect new hardware.
    Returns the detected mode string.
    """
    global _vram_mb, _mode

    _vram_mb = await asyncio.to_thread(_read_vram_mb)
    _mode = "full" if _vram_mb >= VRAM_THRESHOLD_MB else "interface_only"

    logger.info(
        "[hardware_gate] mode=%s  vram=%d MB  threshold=%d MB",
        _mode, _vram_mb, VRAM_THRESHOLD_MB,
    )
    return _mode
