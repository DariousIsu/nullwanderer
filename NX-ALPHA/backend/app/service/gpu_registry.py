"""
AURA NX-Alpha — GPU Registry

Centralized, vendor-agnostic GPU detection. Single source of truth for
all GPU information in the system.

DETECTION FLOW:
    Phase 1 — Enumerate all GPUs (Windows registry + wmic, any vendor)
    Phase 2 — Identify vendor per GPU from name string
    Phase 3 — Enrich with live metrics via vendor-appropriate tooling:
              NVIDIA  → pynvml
              AMD/Win → ADLXPybind (official AMD ADLX SDK)
              AMD/Lin → rocm-smi
              Other   → static only (no live usage/temp)

ALL OTHER SERVICES read from this module. No other file should probe
GPU hardware directly.
"""

from __future__ import annotations

import asyncio
import logging
import platform
import subprocess
import sys
from dataclasses import dataclass, field
from typing import Optional

logger = logging.getLogger(__name__)

_IS_WINDOWS = platform.system() == "Windows"

# ── Vendor metric backends (soft imports) ────────────────────────────────────

_PYNVML_AVAILABLE = False
try:
    import pynvml
    _PYNVML_AVAILABLE = True
except ImportError:
    pynvml = None  # type: ignore[assignment]

_ADLX_AVAILABLE = False
_adlx = None
_adlx_helper = None       # singleton — init once, never terminate (segfault bug)
_adlx_system = None
_adlx_perf = None
try:
    if _IS_WINDOWS:
        import ADLXPybind as _adlx_mod
        _adlx = _adlx_mod
        _ADLX_AVAILABLE = True
except ImportError:
    pass
except Exception as exc:
    logger.debug("[gpu_registry] ADLXPybind import failed: %s", exc)


def _get_adlx_perf():
    """Return cached ADLX perf monitoring service (init once)."""
    global _adlx_helper, _adlx_system, _adlx_perf
    if _adlx_perf is not None:
        return _adlx_perf
    if not _ADLX_AVAILABLE or _adlx is None:
        return None
    try:
        _adlx_helper = _adlx.ADLXHelper()
        result = _adlx_helper.Initialize()
        if "ADLX_OK" not in str(result):
            logger.debug("[gpu_registry] ADLXPybind init: %s", result)
            return None
        _adlx_system = _adlx_helper.GetSystemServices()
        _adlx_perf = _adlx_system.GetPerformanceMonitoringServices()
        return _adlx_perf
    except Exception as exc:
        logger.debug("[gpu_registry] ADLXPybind init failed: %s", exc)
        return None


# ─────────────────────────────────────────────────────────────────────────────
# DATA
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class GPUInfo:
    """Detected GPU with optional live metrics."""
    index: int
    name: str
    vendor: str                     # "nvidia", "amd", "intel", "unknown"
    vram_total_mb: float
    vram_used_mb: float  = 0.0     # 0 if no live metrics
    vram_free_mb: float  = 0.0     # equals vram_total_mb if no live metrics
    util_pct: float      = 0.0
    temp_c: float        = 0.0
    power_w: float       = 0.0
    has_live_metrics: bool = False

    def to_dict(self) -> dict:
        return {
            "index": self.index,
            "name": self.name,
            "vendor": self.vendor,
            "vram_total_mb": self.vram_total_mb,
            "vram_used_mb": self.vram_used_mb,
            "vram_free_mb": self.vram_free_mb,
            "util_pct": self.util_pct,
            "temp_c": self.temp_c,
            "power_w": self.power_w,
            "has_live_metrics": self.has_live_metrics,
        }


# ─────────────────────────────────────────────────────────────────────────────
# MODULE STATE
# ─────────────────────────────────────────────────────────────────────────────

_gpus: list[GPUInfo] = []
_initialized: bool = False


# ─────────────────────────────────────────────────────────────────────────────
# PHASE 1: ENUMERATE (vendor-agnostic)
# ─────────────────────────────────────────────────────────────────────────────

def _enumerate_gpus_windows() -> list[dict]:
    """
    Detect all GPUs on Windows via registry (DriverDesc + qwMemorySize).
    Falls back to PowerShell Get-CimInstance if registry is empty.
    Returns list of { name, vram_bytes } dicts.
    """
    gpus: list[dict] = []

    # ── Primary: Windows registry (has both name + 64-bit VRAM) ──────────
    try:
        import winreg
        base_path = (
            r"SYSTEM\ControlSet001\Control\Class"
            r"\{4d36e968-e325-11ce-bfc1-08002be10318}"
        )
        key = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, base_path)
        seen: dict[str, int] = {}  # name → best vram
        i = 0
        while True:
            try:
                subkey_name = winreg.EnumKey(key, i)
                i += 1
            except OSError:
                break
            try:
                subkey = winreg.OpenKey(key, subkey_name)
                desc = winreg.QueryValueEx(subkey, "DriverDesc")[0]
                vram = int(winreg.QueryValueEx(
                    subkey, "HardwareInformation.qwMemorySize",
                )[0])
                if desc not in seen or vram > seen[desc]:
                    seen[desc] = vram
                winreg.CloseKey(subkey)
            except OSError:
                continue
        winreg.CloseKey(key)

        for name, vram_bytes in seen.items():
            gpus.append({"name": name, "vram_bytes": vram_bytes})
    except Exception as exc:
        logger.debug("[gpu_registry] registry GPU read failed: %s", exc)

    if gpus:
        return gpus

    # ── Fallback: PowerShell (wmic is deprecated on Win 11 24H2+) ────────
    try:
        result = subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             "Get-CimInstance Win32_VideoController | "
             "Select-Object Name,AdapterRAM | ConvertTo-Json -Compress"],
            capture_output=True, text=True, timeout=10,
        )
        if result.returncode == 0 and result.stdout.strip():
            import json as _json
            data = _json.loads(result.stdout)
            if isinstance(data, dict):
                data = [data]
            for entry in data:
                name = entry.get("Name", "Unknown GPU")
                vram = int(entry.get("AdapterRAM", 0))
                gpus.append({"name": name, "vram_bytes": vram})
    except Exception as exc:
        logger.warning("[gpu_registry] PowerShell GPU query failed: %s", exc)

    return gpus


def _enumerate_gpus_linux() -> list[dict]:
    """
    Detect GPUs on Linux via /proc or lspci.
    Returns list of { name, vram_bytes } dicts.
    """
    # TODO: implement for Linux (lspci + sysfs for VRAM)
    return []


def _enumerate_gpus() -> list[dict]:
    """Platform-dispatched GPU enumeration."""
    if _IS_WINDOWS:
        return _enumerate_gpus_windows()
    return _enumerate_gpus_linux()


# ─────────────────────────────────────────────────────────────────────────────
# PHASE 2: IDENTIFY VENDOR
# ─────────────────────────────────────────────────────────────────────────────

_NVIDIA_KEYWORDS = {"nvidia", "geforce", "quadro", "tesla", "rtx", "gtx"}
_AMD_KEYWORDS = {"amd", "radeon", "rx "}
_INTEL_KEYWORDS = {"intel", "uhd", "iris", "arc"}


def _identify_vendor(name: str) -> str:
    """Identify GPU vendor from its name string."""
    lower = name.lower()
    for kw in _NVIDIA_KEYWORDS:
        if kw in lower:
            return "nvidia"
    for kw in _AMD_KEYWORDS:
        if kw in lower:
            return "amd"
    for kw in _INTEL_KEYWORDS:
        if kw in lower:
            return "intel"
    return "unknown"


# ─────────────────────────────────────────────────────────────────────────────
# PHASE 3: ENRICH WITH LIVE METRICS
# ─────────────────────────────────────────────────────────────────────────────

def _enrich_nvidia(gpus: list[GPUInfo]) -> None:
    """Enrich NVIDIA GPUs with live metrics via pynvml."""
    if not _PYNVML_AVAILABLE:
        return
    nvidia_gpus = [g for g in gpus if g.vendor == "nvidia"]
    if not nvidia_gpus:
        return

    try:
        pynvml.nvmlInit()
        count = pynvml.nvmlDeviceGetCount()

        for gpu in nvidia_gpus:
            # Match by index (pynvml index may differ from our index)
            # Try matching by name instead
            for i in range(count):
                try:
                    handle = pynvml.nvmlDeviceGetHandleByIndex(i)
                    nv_name = pynvml.nvmlDeviceGetName(handle)
                    if isinstance(nv_name, bytes):
                        nv_name = nv_name.decode("utf-8", errors="replace")

                    if nv_name.strip() == gpu.name.strip():
                        mem = pynvml.nvmlDeviceGetMemoryInfo(handle)
                        gpu.vram_used_mb = round(mem.used / (1024 ** 2), 1)
                        gpu.vram_free_mb = round(mem.free / (1024 ** 2), 1)

                        try:
                            util = pynvml.nvmlDeviceGetUtilizationRates(handle)
                            gpu.util_pct = float(util.gpu)
                        except Exception:
                            pass

                        try:
                            gpu.temp_c = float(pynvml.nvmlDeviceGetTemperature(
                                handle, pynvml.NVML_TEMPERATURE_GPU,
                            ))
                        except Exception:
                            pass

                        try:
                            gpu.power_w = round(
                                pynvml.nvmlDeviceGetPowerUsage(handle) / 1000.0, 1,
                            )
                        except Exception:
                            pass

                        gpu.has_live_metrics = True
                        break
                except Exception:
                    continue

        pynvml.nvmlShutdown()
    except Exception as exc:
        logger.debug("[gpu_registry] pynvml enrichment failed: %s", exc)


def _enrich_amd_windows(gpus: list[GPUInfo]) -> None:
    """Enrich AMD GPUs with live metrics via ADLXPybind on Windows."""
    if not _ADLX_AVAILABLE or _adlx is None:
        for gpu in gpus:
            if gpu.vendor == "amd":
                gpu.vram_free_mb = gpu.vram_total_mb
        return

    amd_gpus = [g for g in gpus if g.vendor == "amd"]
    if not amd_gpus:
        return

    try:
        perf = _get_adlx_perf()
        if perf is None:
            for gpu in amd_gpus:
                gpu.vram_free_mb = gpu.vram_total_mb
            return

        adlx_gpus = _adlx_system.GetGPUs()

        for adlx_gpu in adlx_gpus:
            adlx_name = adlx_gpu.Name()

            for gpu in amd_gpus:
                if gpu.name.strip() == adlx_name.strip():
                    try:
                        support = perf.GetSupportedGPUMetrics(adlx_gpu)
                        current = perf.GetCurrentGPUMetrics(adlx_gpu)

                        if support.IsSupportedGPUVRAM():
                            vram_used = current.GPUVRAM()
                            gpu.vram_used_mb = round(float(vram_used), 1)
                            gpu.vram_free_mb = round(gpu.vram_total_mb - gpu.vram_used_mb, 1)

                        if support.IsSupportedGPUUsage():
                            gpu.util_pct = round(float(current.GPUUsage()), 1)

                        if support.IsSupportedGPUTemperature():
                            gpu.temp_c = round(float(current.GPUTemperature()), 1)

                        if support.IsSupportedGPUTotalBoardPower():
                            gpu.power_w = round(float(current.GPUTotalBoardPower()), 1)

                        gpu.has_live_metrics = True
                    except Exception as exc:
                        logger.debug("[gpu_registry] ADLX metrics for %s: %s",
                                     gpu.name, exc)
                    break

    except Exception as exc:
        logger.debug("[gpu_registry] ADLXPybind enrichment failed: %s", exc)
        for gpu in amd_gpus:
            if not gpu.has_live_metrics:
                gpu.vram_free_mb = gpu.vram_total_mb


def _enrich_amd_linux(gpus: list[GPUInfo]) -> None:
    """Enrich AMD GPUs with live metrics via rocm-smi on Linux."""
    amd_gpus = [g for g in gpus if g.vendor == "amd"]
    if not amd_gpus:
        return

    try:
        import json as _json
        result = subprocess.run(
            ["rocm-smi", "--json"],
            capture_output=True, text=True, timeout=8,
        )
        if result.returncode != 0:
            return

        data = _json.loads(result.stdout)
        # rocm-smi JSON keys vary by version — best-effort parse
        for card_key, card_data in data.items():
            if not isinstance(card_data, dict):
                continue
            card_name = card_data.get("Card series", card_data.get("Card model", ""))
            for gpu in amd_gpus:
                if card_name and card_name in gpu.name:
                    try:
                        vram_used_str = card_data.get("VRAM Total Used Memory (B)",
                                                       card_data.get("vram_used", "0"))
                        gpu.vram_used_mb = round(int(vram_used_str) / (1024 ** 2), 1)
                        gpu.vram_free_mb = round(gpu.vram_total_mb - gpu.vram_used_mb, 1)
                    except (ValueError, TypeError):
                        pass
                    try:
                        gpu.temp_c = float(card_data.get("Temperature (Sensor edge) (C)",
                                                          card_data.get("temperature", 0)))
                    except (ValueError, TypeError):
                        pass
                    try:
                        gpu.util_pct = float(card_data.get("GPU use (%)",
                                                            card_data.get("gpu_use", 0)))
                    except (ValueError, TypeError):
                        pass
                    gpu.has_live_metrics = True
                    break
    except FileNotFoundError:
        pass
    except Exception as exc:
        logger.debug("[gpu_registry] rocm-smi enrichment failed: %s", exc)


def _enrich_all(gpus: list[GPUInfo]) -> None:
    """Run vendor-appropriate enrichment for all detected GPUs."""
    _enrich_nvidia(gpus)
    if _IS_WINDOWS:
        _enrich_amd_windows(gpus)
    else:
        _enrich_amd_linux(gpus)

    # For any GPU still without live metrics, set free = total
    for gpu in gpus:
        if not gpu.has_live_metrics and gpu.vram_free_mb == 0.0:
            gpu.vram_free_mb = gpu.vram_total_mb


# ─────────────────────────────────────────────────────────────────────────────
# PUBLIC API
# ─────────────────────────────────────────────────────────────────────────────

async def init_gpu_registry() -> list[GPUInfo]:
    """
    Detect all GPUs. Called once at startup from boot_sequence.
    Must complete before hardware_gate or interface_engine init.
    """
    global _gpus, _initialized

    raw = await asyncio.to_thread(_enumerate_gpus)

    _gpus = []
    for idx, entry in enumerate(raw):
        name = entry["name"]
        vram_bytes = entry["vram_bytes"]
        vram_mb = round(vram_bytes / (1024 * 1024), 1) if vram_bytes else 0.0

        gpu = GPUInfo(
            index=idx,
            name=name,
            vendor=_identify_vendor(name),
            vram_total_mb=vram_mb,
        )
        _gpus.append(gpu)

    # Enrich with live metrics (vendor-specific)
    await asyncio.to_thread(_enrich_all, _gpus)

    _initialized = True

    for gpu in _gpus:
        logger.info(
            "[gpu_registry] GPU %d: %s (%s) — %.0f MB VRAM%s",
            gpu.index, gpu.name, gpu.vendor, gpu.vram_total_mb,
            " [live metrics]" if gpu.has_live_metrics else "",
        )

    return list(_gpus)


def get_all_gpus() -> list[GPUInfo]:
    """Return all detected GPUs."""
    return list(_gpus)


def get_best_gpu() -> Optional[GPUInfo]:
    """Return the GPU with the most VRAM (discrete GPUs preferred)."""
    if not _gpus:
        return None
    # Filter out tiny integrated GPUs (< 1 GB) if a discrete one exists
    discrete = [g for g in _gpus if g.vram_total_mb >= 1024]
    pool = discrete if discrete else _gpus
    return max(pool, key=lambda g: g.vram_total_mb)


def get_gpus_by_vendor(vendor: str) -> list[GPUInfo]:
    """Return GPUs matching a specific vendor."""
    return [g for g in _gpus if g.vendor == vendor]


def has_any_gpu() -> bool:
    """True if at least one GPU with usable VRAM was detected."""
    return any(g.vram_total_mb > 0 for g in _gpus)


def get_total_vram_mb() -> float:
    """Total VRAM across all GPUs."""
    return sum(g.vram_total_mb for g in _gpus)


def is_initialized() -> bool:
    """True after init_gpu_registry() has completed."""
    return _initialized


def refresh_metrics() -> list[GPUInfo]:
    """
    Re-query live metrics (usage, temp, power) for all GPUs.
    Does NOT re-enumerate — GPU list is fixed at startup.
    Called by system_monitor_service each poll cycle.
    """
    if not _gpus:
        return []
    _enrich_all(_gpus)
    return list(_gpus)
