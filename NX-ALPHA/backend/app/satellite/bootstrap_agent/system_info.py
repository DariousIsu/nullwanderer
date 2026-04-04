"""
AURA Bootstrap Agent — Hardware Assessment

Runs PowerShell queries via subprocess to collect a full hardware snapshot.
Used by GET /status to produce the assessment JSON.

All calls are synchronous and wrapped in try/except — this function never raises.
Call from FastAPI via run_in_executor() to avoid blocking the async event loop.
"""

from __future__ import annotations

import logging
import re
import shutil
import socket
import subprocess
import sys
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# Chassis type IDs that indicate a laptop/notebook
_LAPTOP_CHASSIS_TYPES = {8, 9, 10, 11, 12, 14}


def _ps(command: str, timeout: int = 15) -> str:
    """Run a PowerShell command, return stripped stdout. Returns '' on any failure."""
    try:
        result = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", command],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return result.stdout.strip()
    except Exception as exc:
        logger.debug("[system_info] PowerShell failed for command %r: %s", command[:60], exc)
        return ""


def _run(cmd: list[str], timeout: int = 10) -> str:
    """Run a subprocess command, return stripped stdout. Returns '' on any failure."""
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return result.stdout.strip()
    except Exception as exc:
        logger.debug("[system_info] Subprocess failed %s: %s", cmd[0], exc)
        return ""


# ─────────────────────────────────────────────────────────────────────────────
# CHASSIS
# ─────────────────────────────────────────────────────────────────────────────

def _get_chassis() -> str:
    raw = _ps("(Get-WmiObject Win32_SystemEnclosure).ChassisTypes")
    if not raw:
        return "desktop"
    # Output may be like "{8}" or "8" or "{8, 9}"
    nums = set(int(n) for n in re.findall(r"\d+", raw))
    if nums & _LAPTOP_CHASSIS_TYPES:
        return "notebook"
    tablet_types = {30, 31, 32}
    if nums & tablet_types:
        return "tablet"
    return "desktop"


# ─────────────────────────────────────────────────────────────────────────────
# CPU
# ─────────────────────────────────────────────────────────────────────────────

def _get_cpu() -> dict[str, Any]:
    raw = _ps(
        "(Get-WmiObject Win32_Processor | Select-Object -First 1 "
        "Name,NumberOfCores,MaxClockSpeed | ConvertTo-Json)"
    )
    if not raw:
        return {"name": "Unknown", "cores": 0, "clock_mhz": 0}
    try:
        import json
        data = json.loads(raw)
        return {
            "name": data.get("Name", "Unknown").strip(),
            "cores": int(data.get("NumberOfCores", 0)),
            "clock_mhz": int(data.get("MaxClockSpeed", 0)),
        }
    except Exception:
        return {"name": "Unknown", "cores": 0, "clock_mhz": 0}


# ─────────────────────────────────────────────────────────────────────────────
# RAM
# ─────────────────────────────────────────────────────────────────────────────

def _get_ram_mb() -> int:
    raw = _ps("(Get-WmiObject Win32_OperatingSystem).TotalVisibleMemorySize")
    try:
        return int(raw) // 1024  # KB → MB
    except (ValueError, TypeError):
        return 0


# ─────────────────────────────────────────────────────────────────────────────
# DISK
# ─────────────────────────────────────────────────────────────────────────────

def _get_disk_free_gb() -> float:
    raw = _ps("(Get-PSDrive -Name C).Free")
    try:
        return round(int(raw) / (1024 ** 3), 1)
    except (ValueError, TypeError):
        return 0.0


# ─────────────────────────────────────────────────────────────────────────────
# GPU
# ─────────────────────────────────────────────────────────────────────────────

def _classify_gpu(name: str) -> tuple[str, str]:
    """Returns (type, class): type in nvidia|amd|intel|unknown, class in discrete|integrated|intel_arc|cpu_only."""
    name_lower = name.lower()
    if "nvidia" in name_lower or "geforce" in name_lower or "quadro" in name_lower or "rtx" in name_lower or "gtx" in name_lower:
        return "nvidia", "discrete"
    if "arc" in name_lower and "intel" in name_lower:
        return "intel", "intel_arc"
    if "intel" in name_lower:
        return "intel", "integrated"
    if "amd" in name_lower or "radeon" in name_lower:
        # Distinguish integrated (Vega, 780M, etc.) from discrete
        if any(x in name_lower for x in ["vega", "780m", "760m", "radeon graphics"]):
            return "amd", "integrated"
        return "amd", "discrete"
    return "unknown", "cpu_only"


def _get_gpus() -> list[dict[str, Any]]:
    # WMI query for all video controllers
    raw = _ps(
        "Get-WmiObject Win32_VideoController | "
        "Select-Object Name, AdapterRAM, DriverVersion | "
        "ConvertTo-Json -Compress"
    )
    wmi_gpus: list[dict] = []
    if raw:
        try:
            import json
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                parsed = [parsed]
            wmi_gpus = parsed
        except Exception:
            pass

    gpus: list[dict[str, Any]] = []

    for g in wmi_gpus:
        name = g.get("Name", "Unknown").strip()
        gpu_type, gpu_class = _classify_gpu(name)
        driver = str(g.get("DriverVersion", "")).strip()

        # WMI AdapterRAM caps at 0xFFFFFFFF on 64-bit GPUs (reports ~4GB)
        wmi_vram_bytes = int(g.get("AdapterRAM") or 0)
        vram_mb = wmi_vram_bytes // (1024 * 1024) if wmi_vram_bytes else 0

        cuda_available = False
        rocm_available = False
        nvidia_smi_name = ""
        rocm_vram_mb = 0

        if gpu_type == "nvidia":
            # Prefer nvidia-smi for accurate VRAM
            nsmi = _run(
                ["nvidia-smi",
                 "--query-gpu=name,memory.total,driver_version",
                 "--format=csv,noheader,nounits"],
                timeout=8,
            )
            if nsmi:
                parts = [p.strip() for p in nsmi.split(",")]
                if len(parts) >= 2:
                    nvidia_smi_name = parts[0]
                    try:
                        vram_mb = int(parts[1])
                    except ValueError:
                        pass
                    if len(parts) >= 3:
                        driver = parts[2]
                cuda_available = True

        elif gpu_type == "amd" and gpu_class == "discrete":
            # Try rocm-smi for VRAM
            rsmi = _run(["rocm-smi", "--showmeminfo", "vram", "--csv"], timeout=8)
            if rsmi:
                for line in rsmi.splitlines():
                    m = re.search(r"(\d+)", line)
                    if m:
                        rocm_vram_mb = int(m.group(1)) // (1024 * 1024)
                        if rocm_vram_mb > 0:
                            vram_mb = rocm_vram_mb
                        break
                rocm_available = True

        gpus.append({
            "name": name,
            "vram_dedicated_mb": vram_mb,
            "driver_version": driver,
            "type": gpu_type,
            "class": gpu_class,
            "cuda_available": cuda_available,
            "rocm_available": rocm_available,
            "nvidia_smi_name": nvidia_smi_name,
            "rocm_vram_mb": rocm_vram_mb,
        })

    # Sort discrete before integrated
    gpus.sort(key=lambda g: (0 if g["class"] == "discrete" else 1))
    return gpus


# ─────────────────────────────────────────────────────────────────────────────
# TOOLING PRESENCE
# ─────────────────────────────────────────────────────────────────────────────

def _check_ollama() -> tuple[bool, str]:
    """Returns (installed, version_str)."""
    if not shutil.which("ollama"):
        return False, ""
    ver = _run(["ollama", "--version"], timeout=5)
    return True, ver


def _check_hip_sdk() -> bool:
    """Check if AMD HIP SDK is installed (ROCm for Windows)."""
    hip_path = Path("C:/Program Files/AMD/ROCm")
    return hip_path.exists()


# ─────────────────────────────────────────────────────────────────────────────
# NETWORK
# ─────────────────────────────────────────────────────────────────────────────

def _get_lan_ip() -> str:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
    except Exception:
        return socket.gethostbyname(socket.gethostname())


# ─────────────────────────────────────────────────────────────────────────────
# MAIN ENTRY
# ─────────────────────────────────────────────────────────────────────────────

def get_system_info() -> dict[str, Any]:
    """
    Collect full hardware assessment. Never raises — all errors produce safe defaults.
    Call via asyncio.get_event_loop().run_in_executor(None, get_system_info) from async code.
    """
    hostname = socket.gethostname()
    ip = _get_lan_ip()
    chassis = _get_chassis()
    cpu = _get_cpu()
    ram_total_mb = _get_ram_mb()
    disk_free_gb = _get_disk_free_gb()
    gpus = _get_gpus()
    ollama_installed, ollama_version = _check_ollama()

    return {
        "hostname": hostname,
        "ip": ip,
        "os": _ps("(Get-WmiObject Win32_OperatingSystem).Caption") or "Windows",
        "chassis": chassis,
        "cpu": cpu,
        "ram_total_mb": ram_total_mb,
        "disk_free_gb": disk_free_gb,
        "python_version": sys.version.split()[0],
        "ollama_installed": ollama_installed,
        "ollama_version": ollama_version,
        "rocm_smi": bool(shutil.which("rocm-smi")),
        "nvidia_smi": bool(shutil.which("nvidia-smi")),
        "hip_sdk": _check_hip_sdk(),
        "gpus": gpus,
    }
