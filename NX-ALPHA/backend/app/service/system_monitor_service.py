"""
AURA NX-Alpha — System Monitor Service
Full hardware telemetry: CPU, RAM, GPU (NVIDIA + AMD), and disk.

SINGLETON PATTERN:
    Call init_system_monitor() once at startup.
    Callers use get_system_monitor() to get the instance.

POLLING:
    Call start_polling(interval_s=5) to begin background collection.
    Snapshots are emitted as "system_status" SSE events via the
    chat_controller's _emit function.
    Call stop_polling() to cancel the background task.

DEPENDENCIES:
    psutil  — CPU / RAM / disk (guarded import)
    pynvml  — NVIDIA GPU metrics (guarded import)
    subprocess — AMD ROCm fallback via `rocm-smi --json`
"""

from __future__ import annotations

import asyncio
import json
import logging
import subprocess
import time
from typing import Any

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# OPTIONAL IMPORTS
# ─────────────────────────────────────────────────────────────────────────────

try:
    import psutil
    _PSUTIL_AVAILABLE = True
except ImportError:
    psutil = None  # type: ignore[assignment]
    _PSUTIL_AVAILABLE = False
    logger.warning("[system_monitor] psutil not installed — system metrics will return stub zeros")

try:
    import pynvml
    _NVML_AVAILABLE = True
except ImportError:
    pynvml = None  # type: ignore[assignment]
    _NVML_AVAILABLE = False
    # Soft failure — AMD / CPU-only machines are valid
    logger.debug("[system_monitor] pynvml not installed — NVIDIA GPU metrics unavailable")

# ─────────────────────────────────────────────────────────────────────────────
# PLATFORM HELPERS
# ─────────────────────────────────────────────────────────────────────────────

import platform as _platform
_IS_WINDOWS = _platform.system() == "Windows"

# Filesystem prefixes to exclude on Linux
_LINUX_EXCLUDE_PREFIXES = ("/proc", "/sys", "/dev", "/run")

# ─────────────────────────────────────────────────────────────────────────────
# MODULE-LEVEL SNAPSHOT CACHE
# ─────────────────────────────────────────────────────────────────────────────

_latest_snapshot: dict = {}


def get_latest_snapshot() -> dict:
    """Return the most recently collected system snapshot (may be empty at startup)."""
    return _latest_snapshot

# ─────────────────────────────────────────────────────────────────────────────
# SINGLETON
# ─────────────────────────────────────────────────────────────────────────────

_instance: "SystemMonitorService | None" = None


def init_system_monitor() -> "SystemMonitorService":
    """Instantiate and register the global SystemMonitorService singleton."""
    global _instance
    _instance = SystemMonitorService()
    logger.info("[system_monitor] SystemMonitorService initialised")
    return _instance


def get_system_monitor() -> "SystemMonitorService":
    """Return the global SystemMonitorService singleton. Raises if not yet initialised."""
    if _instance is None:
        raise RuntimeError(
            "SystemMonitorService has not been initialised. Call init_system_monitor() first."
        )
    return _instance


# ─────────────────────────────────────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def _bytes_to_gb(b: int | float) -> float:
    """Convert bytes to gigabytes, rounded to 2 decimal places."""
    return round(b / (1024 ** 3), 2)


def _safe_float(val: Any, default: float = 0.0) -> float:
    try:
        return float(val)
    except (TypeError, ValueError):
        return default


# ─────────────────────────────────────────────────────────────────────────────
# GPU BACKENDS
# ─────────────────────────────────────────────────────────────────────────────

def _collect_nvidia_gpus() -> list[dict]:
    """
    Collect NVIDIA GPU metrics via pynvml.

    Returns an empty list if pynvml is unavailable or no NVIDIA devices are found.
    """
    if not _NVML_AVAILABLE:
        return []

    try:
        pynvml.nvmlInit()
        count = pynvml.nvmlDeviceGetCount()
        gpus: list[dict] = []

        for i in range(count):
            handle = pynvml.nvmlDeviceGetHandleByIndex(i)
            name   = pynvml.nvmlDeviceGetName(handle)
            if isinstance(name, bytes):
                name = name.decode("utf-8", errors="replace")

            mem = pynvml.nvmlDeviceGetMemoryInfo(handle)

            try:
                util = pynvml.nvmlDeviceGetUtilizationRates(handle)
                util_pct = float(util.gpu)
            except pynvml.NVMLError:
                util_pct = 0.0

            try:
                temp_c = float(
                    pynvml.nvmlDeviceGetTemperature(handle, pynvml.NVML_TEMPERATURE_GPU)
                )
            except pynvml.NVMLError:
                temp_c = 0.0

            gpus.append({
                "index":        i,
                "name":         name,
                "vram_total_mb": round(mem.total  / (1024 ** 2), 1),
                "vram_used_mb":  round(mem.used   / (1024 ** 2), 1),
                "vram_free_mb":  round(mem.free   / (1024 ** 2), 1),
                "util_pct":     util_pct,
                "temp_c":       temp_c,
            })

        pynvml.nvmlShutdown()
        return gpus

    except Exception as exc:
        logger.debug("[system_monitor] NVIDIA GPU collection error: %s", exc)
        return []


def _collect_wmic_gpus() -> list[dict]:
    """
    Fallback GPU detection on Windows. Gets name via wmic and VRAM from
    the registry (qwMemorySize — 64-bit, no 4 GB cap). Works for any GPU
    vendor. No utilization or temp — those require vendor-specific tools.
    """
    if not _IS_WINDOWS:
        return []
    try:
        # Get GPU names via wmic
        name_result = subprocess.run(
            ["wmic", "path", "Win32_VideoController", "get", "Name", "/format:value"],
            capture_output=True, text=True, timeout=8,
        )
        names = [
            l.split("=", 1)[1].strip()
            for l in name_result.stdout.splitlines()
            if l.strip().lower().startswith("name=")
        ]

        # Get accurate VRAM from registry (64-bit qwMemorySize, no 4 GB cap)
        # Keyed by DriverDesc so we can match to wmic names
        registry_vram_by_name: dict[str, int] = {}
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
                    desc = winreg.QueryValueEx(subkey, "DriverDesc")[0]
                    vram = winreg.QueryValueEx(
                        subkey, "HardwareInformation.qwMemorySize",
                    )[0]
                    # Keep the largest value per name (handles duplicates)
                    if desc not in registry_vram_by_name or int(vram) > registry_vram_by_name[desc]:
                        registry_vram_by_name[desc] = int(vram)
                    winreg.CloseKey(subkey)
                except OSError:
                    continue
            winreg.CloseKey(key)
        except Exception:
            pass

        # Fallback to wmic AdapterRAM (uint32, caps at ~4 GB) if registry failed
        if not registry_vram_by_name:
            ram_result = subprocess.run(
                ["wmic", "path", "Win32_VideoController", "get", "AdapterRAM", "/format:value"],
                capture_output=True, text=True, timeout=8,
            )
            wmic_rams = [
                int(l.split("=", 1)[1].strip())
                for l in ram_result.stdout.splitlines()
                if l.strip().lower().startswith("adapterram=") and l.split("=", 1)[1].strip().isdigit()
            ]
            for idx, name in enumerate(names):
                if idx < len(wmic_rams):
                    registry_vram_by_name[name] = wmic_rams[idx]

        gpus: list[dict] = []
        for idx, name in enumerate(names):
            ram_bytes = registry_vram_by_name.get(name, 0)
            vram_mb = ram_bytes / (1024 * 1024)
            gpus.append({
                "index":        idx,
                "name":         name,
                "vram_total_mb": round(vram_mb, 1),
                "vram_used_mb":  0.0,
                "vram_free_mb":  round(vram_mb, 1),
                "util_pct":     0.0,
                "temp_c":       0.0,
            })
        if gpus:
            logger.debug("[system_monitor] detected %d GPU(s): %s",
                         len(gpus), ", ".join(f"{g['name']} ({g['vram_total_mb']:.0f}MB)" for g in gpus))
        return gpus
    except Exception as exc:
        logger.debug("[system_monitor] GPU collection error: %s", exc)
        return []


def _collect_amd_gpus() -> list[dict]:
    """
    Collect AMD GPU metrics by calling `rocm-smi --json` as a subprocess.

    rocm-smi is only available on Linux with ROCm installed.
    Returns an empty list on any failure.
    """
    if _IS_WINDOWS:
        return []

    try:
        proc = subprocess.run(
            ["rocm-smi", "--json"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if proc.returncode != 0:
            return []

        raw: dict = json.loads(proc.stdout)
        gpus: list[dict] = []

        for idx, (card_key, card_data) in enumerate(raw.items()):
            if not isinstance(card_data, dict):
                continue

            # Field names vary by ROCm version; try common variants
            name = card_data.get("Card series") or card_data.get("Card model") or card_key

            vram_total_mb = _safe_float(
                card_data.get("VRAM Total Memory (B)", card_data.get("vram_total", 0))
            ) / (1024 ** 2)

            vram_used_mb = _safe_float(
                card_data.get("VRAM Total Used Memory (B)", card_data.get("vram_used", 0))
            ) / (1024 ** 2)

            vram_free_mb = max(0.0, vram_total_mb - vram_used_mb)

            util_pct = _safe_float(
                card_data.get("GPU use (%)", card_data.get("GPU Use (%)", 0))
            )

            temp_c = _safe_float(
                card_data.get("Temperature (Sensor edge) (C)", card_data.get("temp_edge", 0))
            )

            gpus.append({
                "index":        idx,
                "name":         name,
                "vram_total_mb": round(vram_total_mb, 1),
                "vram_used_mb":  round(vram_used_mb, 1),
                "vram_free_mb":  round(vram_free_mb, 1),
                "util_pct":     util_pct,
                "temp_c":       temp_c,
            })

        return gpus

    except FileNotFoundError:
        # rocm-smi not installed — expected on non-AMD systems
        return []
    except Exception as exc:
        logger.debug("[system_monitor] AMD GPU collection error: %s", exc)
        return []


def _collect_gpus() -> list[dict]:
    """
    Collect GPU info from centralized gpu_registry (vendor-agnostic).
    Falls back to direct wmic detection if registry not yet initialized.
    """
    try:
        from app.service.gpu_registry import is_initialized, refresh_metrics
        if is_initialized():
            gpus = refresh_metrics()
            return [g.to_dict() for g in gpus]
    except Exception:
        pass

    # Registry not ready — fall back to wmic
    return _collect_wmic_gpus()


# ─────────────────────────────────────────────────────────────────────────────
# SERVICE CLASS
# ─────────────────────────────────────────────────────────────────────────────

class SystemMonitorService:
    """
    Full system hardware monitor.

    Collects CPU, RAM, GPU (NVIDIA preferred, AMD fallback), and disk metrics
    via psutil and pynvml. Background polling can be started/stopped independently.
    """

    def __init__(self) -> None:
        self._poll_task:    asyncio.Task | None = None
        self._boot_time:    float = psutil.boot_time() if _PSUTIL_AVAILABLE else time.time()

    # ─────────────────────────────────────────────────────────────────────────
    # SNAPSHOT
    # ─────────────────────────────────────────────────────────────────────────

    async def get_snapshot(self) -> dict:
        """
        Return a complete system snapshot collected from all available sources.

        Shape:
            {
                cpu:      { usage_pct, cores_physical, cores_logical, freq_mhz, temp_c },
                ram:      { total_gb, used_gb, available_gb, usage_pct },
                gpu:      list[{ index, name, vram_total_mb, vram_used_mb,
                                  vram_free_mb, util_pct, temp_c }],
                disk:     list[{ mount, total_gb, used_gb, free_gb, usage_pct }],
                uptime_s: float,
                timestamp: float
            }

        Returns a stub-zero snapshot if psutil is unavailable.
        """
        snapshot = await asyncio.to_thread(self._collect_sync)
        global _latest_snapshot
        _latest_snapshot = snapshot
        return snapshot

    def _collect_sync(self) -> dict:
        """Blocking collection call — run inside asyncio.to_thread."""
        return {
            "cpu":       self._collect_cpu(),
            "ram":       self._collect_ram(),
            "gpu":       _collect_gpus(),
            "disk":      self._collect_disks(),
            "uptime_s":  round(time.time() - self._boot_time, 1),
            "timestamp": time.time(),
        }

    # ─── CPU ─────────────────────────────────────────────────────────────────

    def _collect_cpu(self) -> dict:
        """Collect CPU metrics via psutil."""
        if not _PSUTIL_AVAILABLE:
            return {
                "usage_pct":      0.0,
                "cores_physical": 0,
                "cores_logical":  0,
                "freq_mhz":       0.0,
                "temp_c":         None,
            }

        usage_pct      = psutil.cpu_percent(interval=0.1)
        cores_physical = psutil.cpu_count(logical=False) or 0
        cores_logical  = psutil.cpu_count(logical=True)  or 0

        freq_info = psutil.cpu_freq()
        freq_mhz  = round(freq_info.current, 1) if freq_info else 0.0

        # CPU temperature — not available on all platforms
        temp_c: float | None = None
        try:
            temps = psutil.sensors_temperatures()
            if temps:
                # Prefer "coretemp" (Intel), fall back to first available key
                for key in ("coretemp", "k10temp", "acpitz"):
                    if key in temps and temps[key]:
                        temp_c = round(temps[key][0].current, 1)
                        break
                if temp_c is None:
                    first_key = next(iter(temps))
                    if temps[first_key]:
                        temp_c = round(temps[first_key][0].current, 1)
        except (AttributeError, NotImplementedError):
            # Windows: psutil.sensors_temperatures() not implemented
            pass
        except Exception as exc:
            logger.debug("[system_monitor] CPU temp read error: %s", exc)

        return {
            "usage_pct":      round(usage_pct, 1),
            "cores_physical": cores_physical,
            "cores_logical":  cores_logical,
            "freq_mhz":       freq_mhz,
            "temp_c":         temp_c,
        }

    # ─── RAM ─────────────────────────────────────────────────────────────────

    def _collect_ram(self) -> dict:
        """Collect RAM metrics via psutil."""
        if not _PSUTIL_AVAILABLE:
            return {
                "total_gb":     0.0,
                "used_gb":      0.0,
                "available_gb": 0.0,
                "usage_pct":    0.0,
            }

        vm = psutil.virtual_memory()
        return {
            "total_gb":     _bytes_to_gb(vm.total),
            "used_gb":      _bytes_to_gb(vm.used),
            "available_gb": _bytes_to_gb(vm.available),
            "usage_pct":    round(vm.percent, 1),
        }

    # ─── DISK ────────────────────────────────────────────────────────────────

    def _collect_disks(self) -> list[dict]:
        """
        Collect per-partition disk usage via psutil.

        On Linux, partitions whose mountpoint starts with any of
        /proc, /sys, /dev, /run are skipped.
        On Windows, all physical drives are returned.
        """
        if not _PSUTIL_AVAILABLE:
            return []

        disks: list[dict] = []

        try:
            partitions = psutil.disk_partitions(all=False)
        except Exception as exc:
            logger.warning("[system_monitor] disk_partitions() failed: %s", exc)
            return []

        for part in partitions:
            mount = part.mountpoint

            # Filter pseudo-filesystems on Linux
            if not _IS_WINDOWS:
                if any(mount.startswith(prefix) for prefix in _LINUX_EXCLUDE_PREFIXES):
                    continue

            try:
                usage = psutil.disk_usage(mount)
            except PermissionError:
                continue
            except Exception as exc:
                logger.debug("[system_monitor] disk_usage(%s) error: %s", mount, exc)
                continue

            disks.append({
                "mount":     mount,
                "total_gb":  _bytes_to_gb(usage.total),
                "used_gb":   _bytes_to_gb(usage.used),
                "free_gb":   _bytes_to_gb(usage.free),
                "usage_pct": round(usage.percent, 1),
            })

        return disks

    # ─────────────────────────────────────────────────────────────────────────
    # BACKGROUND POLLING
    # ─────────────────────────────────────────────────────────────────────────

    def start_polling(self, interval_s: float = 5.0) -> None:
        """
        Start a background asyncio task that collects a snapshot every
        *interval_s* seconds and emits it as a "system_status" SSE event.

        Safe to call multiple times — a second call cancels the existing task
        and starts a fresh one.
        """
        if self._poll_task and not self._poll_task.done():
            logger.debug("[system_monitor] Cancelling existing poll task before restart")
            self._poll_task.cancel()

        self._poll_task = asyncio.create_task(
            self._poll_loop(interval_s),
            name="system_monitor_poll",
        )
        logger.info("[system_monitor] Polling started (interval=%.1fs)", interval_s)

    def stop_polling(self) -> None:
        """Cancel the background polling task if it is running."""
        if self._poll_task and not self._poll_task.done():
            self._poll_task.cancel()
            logger.info("[system_monitor] Polling stopped")
        self._poll_task = None

    async def _poll_loop(self, interval_s: float) -> None:
        """Internal polling loop — runs until cancelled."""
        # Lazy import to avoid circular dependency at module load time.
        # chat_controller imports nothing from this module, so this is safe.
        from app.controller.chat_controller import _emit  # type: ignore[attr-defined]

        logger.debug("[system_monitor] Poll loop started")
        try:
            while True:
                try:
                    snapshot = await self.get_snapshot()
                    await _emit("system_status", snapshot)
                except Exception as exc:
                    logger.warning("[system_monitor] Snapshot/emit error: %s", exc)

                await asyncio.sleep(interval_s)

        except asyncio.CancelledError:
            logger.debug("[system_monitor] Poll loop cancelled")
            raise
