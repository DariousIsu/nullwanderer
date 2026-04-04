"""
AURA Satellite Agent — Hardware Metrics Collector

Collects live hardware metrics for the /health endpoint.
Strategy (in priority order):
    1. nvidia-smi (NVIDIA GPUs)
    2. rocm-smi (AMD GPUs)
    3. psutil fallback (CPU/RAM always; GPU monitoring flagged unavailable)

All subprocess calls have 3s timeout. GPU metrics are cached for 10s to
keep /health response under 500ms. Power state is cached for 30s.
"""

from __future__ import annotations

import logging
import re
import subprocess
import time
from typing import Any

try:
    import psutil
    _PSUTIL = True
except ImportError:
    _PSUTIL = False

logger = logging.getLogger(__name__)

_start_time = time.time()

# ─────────────────────────────────────────────────────────────────────────────
# CACHES
# ─────────────────────────────────────────────────────────────────────────────

_gpu_cache: dict[str, Any] = {}
_gpu_cache_ts: float = 0.0
_GPU_CACHE_TTL = 10.0

_power_cache: dict[str, Any] = {}
_power_cache_ts: float = 0.0
_POWER_CACHE_TTL = 30.0

_gpu_warned = False   # Log GPU monitoring warning only once


def _run(cmd: list[str], timeout: int = 3) -> str:
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.stdout.strip()
    except Exception:
        return ""


def _ps(command: str, timeout: int = 3) -> str:
    try:
        r = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", command],
            capture_output=True, text=True, timeout=timeout,
        )
        return r.stdout.strip()
    except Exception:
        return ""


# ─────────────────────────────────────────────────────────────────────────────
# GPU METRICS
# ─────────────────────────────────────────────────────────────────────────────

def _collect_nvidia() -> dict[str, Any] | None:
    """Try nvidia-smi. Returns metrics dict or None."""
    out = _run(
        ["nvidia-smi",
         "--query-gpu=temperature.gpu,utilization.gpu,memory.used,memory.total",
         "--format=csv,noheader,nounits"],
    )
    if not out:
        return None
    parts = [p.strip() for p in out.split(",")]
    if len(parts) < 4:
        return None
    try:
        return {
            "gpu_temp_c": float(parts[0]),
            "gpu_util_pct": float(parts[1]),
            "vram_used_mb": int(parts[2]),
            "vram_total_mb": int(parts[3]),
            "gpu_monitoring": True,
        }
    except (ValueError, IndexError):
        return None


def _collect_rocm() -> dict[str, Any] | None:
    """Try rocm-smi. Returns metrics dict or None."""
    # Temperature
    temp_out = _run(["rocm-smi", "--showtemp", "--csv"])
    vram_out = _run(["rocm-smi", "--showmeminfo", "vram", "--csv"])
    util_out = _run(["rocm-smi", "--showuse", "--csv"])

    if not temp_out:
        return None

    temp_c = 0.0
    for line in temp_out.splitlines():
        m = re.search(r"(\d+\.?\d*)", line)
        if m:
            try:
                temp_c = float(m.group(1))
                break
            except ValueError:
                pass

    vram_used = 0
    vram_total = 0
    if vram_out:
        nums = re.findall(r"\d+", vram_out)
        if len(nums) >= 2:
            try:
                vram_used = int(nums[0]) // (1024 * 1024)
                vram_total = int(nums[1]) // (1024 * 1024)
            except (ValueError, IndexError):
                pass

    gpu_util = 0.0
    if util_out:
        m = re.search(r"(\d+\.?\d*)", util_out)
        if m:
            try:
                gpu_util = float(m.group(1))
            except ValueError:
                pass

    if temp_c == 0.0 and vram_total == 0:
        return None

    return {
        "gpu_temp_c": temp_c,
        "gpu_util_pct": gpu_util,
        "vram_used_mb": vram_used,
        "vram_total_mb": vram_total,
        "gpu_monitoring": True,
    }


def _get_gpu_metrics() -> dict[str, Any]:
    """Return cached or freshly collected GPU metrics."""
    global _gpu_cache, _gpu_cache_ts, _gpu_warned
    now = time.time()
    if now - _gpu_cache_ts < _GPU_CACHE_TTL and _gpu_cache:
        return _gpu_cache

    metrics = _collect_nvidia()
    if metrics is None:
        metrics = _collect_rocm()
    if metrics is None:
        if not _gpu_warned:
            logger.warning("[satellite_health] GPU monitoring unavailable — no nvidia-smi or rocm-smi")
            _gpu_warned = True
        metrics = {
            "gpu_temp_c": 0.0,
            "gpu_util_pct": 0.0,
            "vram_used_mb": 0,
            "vram_total_mb": 0,
            "gpu_monitoring": False,
        }

    _gpu_cache = metrics
    _gpu_cache_ts = now
    return metrics


# ─────────────────────────────────────────────────────────────────────────────
# POWER STATE
# ─────────────────────────────────────────────────────────────────────────────

def _get_power_state() -> dict[str, Any]:
    """Return cached power state metrics."""
    global _power_cache, _power_cache_ts
    now = time.time()
    if now - _power_cache_ts < _POWER_CACHE_TTL and _power_cache:
        return _power_cache

    power_state = "unknown"
    on_battery = False
    battery_pct = -1.0

    if _PSUTIL:
        try:
            bat = psutil.sensors_battery()
            if bat is not None:
                battery_pct = round(bat.percent, 1)
                on_battery = not bat.power_plugged
                power_state = "battery" if on_battery else "ac"
            else:
                power_state = "ac"  # No battery = desktop = always AC
        except Exception:
            pass
    else:
        # WMI fallback
        raw = _ps("(Get-WmiObject Win32_Battery).BatteryStatus", timeout=3)
        if raw:
            try:
                status = int(raw.strip())
                on_battery = status == 1
                power_state = "battery" if on_battery else "ac"
            except ValueError:
                pass
        else:
            power_state = "ac"

    result = {
        "power_state": power_state,
        "on_battery": on_battery,
        "battery_pct": battery_pct,
    }
    _power_cache = result
    _power_cache_ts = now
    return result


# ─────────────────────────────────────────────────────────────────────────────
# RAM / CPU
# ─────────────────────────────────────────────────────────────────────────────

def _get_ram_metrics() -> dict[str, Any]:
    if _PSUTIL:
        mem = psutil.virtual_memory()
        return {
            "ram_used_gb": round(mem.used / (1024 ** 3), 2),
            "ram_total_gb": round(mem.total / (1024 ** 3), 2),
        }
    # WMI fallback
    free_raw = _ps("(Get-WmiObject Win32_OperatingSystem).FreePhysicalMemory")
    total_raw = _ps("(Get-WmiObject Win32_OperatingSystem).TotalVisibleMemorySize")
    try:
        free_mb = int(free_raw) // 1024
        total_mb = int(total_raw) // 1024
        used_mb = total_mb - free_mb
        return {
            "ram_used_gb": round(used_mb / 1024, 2),
            "ram_total_gb": round(total_mb / 1024, 2),
        }
    except (ValueError, TypeError):
        return {"ram_used_gb": 0.0, "ram_total_gb": 0.0}


def _get_cpu_util() -> float:
    if _PSUTIL:
        try:
            return round(psutil.cpu_percent(interval=0.1), 1)
        except Exception:
            return 0.0
    return 0.0


# ─────────────────────────────────────────────────────────────────────────────
# MAIN ENTRY
# ─────────────────────────────────────────────────────────────────────────────

def get_health_metrics() -> dict[str, Any]:
    """
    Collect all hardware metrics. Never raises.
    Cached where appropriate to keep response < 500ms.
    """
    gpu = _get_gpu_metrics()
    ram = _get_ram_metrics()
    power = _get_power_state()
    cpu_util = _get_cpu_util()

    return {
        "gpu_temp_c": gpu["gpu_temp_c"],
        "gpu_util_pct": gpu["gpu_util_pct"],
        "vram_used_mb": gpu["vram_used_mb"],
        "vram_total_mb": gpu["vram_total_mb"],
        "gpu_monitoring": gpu["gpu_monitoring"],
        "ram_used_gb": ram["ram_used_gb"],
        "ram_total_gb": ram["ram_total_gb"],
        "cpu_util_pct": cpu_util,
        "power_state": power["power_state"],
        "on_battery": power["on_battery"],
        "battery_pct": power["battery_pct"],
        "uptime_s": round(time.time() - _start_time, 1),
    }
