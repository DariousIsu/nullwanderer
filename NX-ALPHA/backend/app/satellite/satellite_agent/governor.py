"""
AURA Satellite Agent — Local Hardware Governor

Module-level state machine that enforces thermal, VRAM, and RAM limits
locally on the satellite. Mirrors threshold logic from the main AURA governor
(backend/app/service/satellite/governor.py) but runs independently.

The satellite governor is authoritative for its own machine.
AURA main's governor acts as a secondary check and aggregator.

No inference request may bypass this governor.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# THRESHOLDS  (mirrors GovernorThresholds in service/satellite/governor.py)
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class LocalThresholds:
    temp_nominal_max: float = 75.0
    temp_warm_max: float    = 82.0
    temp_hot_max: float     = 88.0
    vram_cap_pct: float     = 85.0
    vram_hard_cap_pct: float = 90.0
    ram_caution_pct: float  = 80.0
    ram_hard_cap_pct: float = 90.0
    is_laptop: bool         = False

    def __post_init__(self) -> None:
        if self.is_laptop:
            self.temp_nominal_max -= 5.0
            self.temp_warm_max    -= 5.0
            self.temp_hot_max     -= 5.0


# ─────────────────────────────────────────────────────────────────────────────
# MODULE STATE
# ─────────────────────────────────────────────────────────────────────────────

_thresholds: LocalThresholds = LocalThresholds()
_circuit_breaker: bool = False
_circuit_breaker_reason: str = ""
_queue_depth: int = 4       # Max concurrent inference requests (reduced on Warm)
_active_requests: int = 0   # Current inflight count


# ─────────────────────────────────────────────────────────────────────────────
# GOVERNOR LOGIC
# ─────────────────────────────────────────────────────────────────────────────

def check_and_enforce(metrics: dict) -> tuple[bool, str]:
    """
    Evaluate hardware metrics and decide whether inference is allowed.

    Returns:
        (allowed: bool, reason: str)
        allowed=False means the request should be rejected with HTTP 503.
    """
    global _circuit_breaker, _circuit_breaker_reason

    # Circuit breaker is absolute — no inference until manually reset
    if _circuit_breaker:
        return False, f"Circuit breaker active: {_circuit_breaker_reason}"

    # Battery check (laptops)
    if metrics.get("on_battery", False):
        bat_pct = metrics.get("battery_pct", 100.0)
        if bat_pct < 20.0:
            _trip_circuit_breaker(f"Battery critical ({bat_pct:.0f}%) — satellite suspended")
            return False, _circuit_breaker_reason
        return False, f"Running on battery ({bat_pct:.0f}%) — GPU inference suspended"

    gpu_temp = metrics.get("gpu_temp_c", 0.0)
    vram_used = metrics.get("vram_used_mb", 0.0)
    vram_total = max(metrics.get("vram_total_mb", 1.0), 1.0)
    ram_used = metrics.get("ram_used_gb", 0.0)
    ram_total = max(metrics.get("ram_total_gb", 1.0), 1.0)

    vram_pct = (vram_used / vram_total) * 100
    ram_pct  = (ram_used  / ram_total)  * 100

    # Critical temp → circuit breaker
    if gpu_temp >= _thresholds.temp_hot_max:
        _trip_circuit_breaker(
            f"Critical GPU temp: {gpu_temp:.1f}°C (threshold: {_thresholds.temp_hot_max:.0f}°C)"
        )
        return False, _circuit_breaker_reason

    # Simultaneous VRAM + RAM hard cap → circuit breaker
    if vram_pct > _thresholds.vram_hard_cap_pct and ram_pct > _thresholds.ram_hard_cap_pct:
        _trip_circuit_breaker(
            f"VRAM ({vram_pct:.0f}%) + RAM ({ram_pct:.0f}%) both at hard cap"
        )
        return False, _circuit_breaker_reason

    # Hot temp → pause new jobs (finish in-flight only)
    if gpu_temp >= _thresholds.temp_warm_max:
        return False, f"Hot GPU {gpu_temp:.1f}°C — pausing new inference"

    # VRAM hard cap alone
    if vram_pct > _thresholds.vram_hard_cap_pct:
        return False, f"VRAM hard cap: {vram_pct:.0f}%"

    # RAM hard cap alone
    if ram_pct > _thresholds.ram_hard_cap_pct:
        return False, f"RAM hard cap: {ram_pct:.0f}%"

    # Warm temp → reduce queue depth (still allow, but signal reduction)
    if gpu_temp >= _thresholds.temp_nominal_max:
        if _active_requests >= 1:
            return False, f"Warm GPU {gpu_temp:.1f}°C — queue depth reduced to 1"

    # Queue depth check
    if _active_requests >= _queue_depth:
        return False, f"Queue full ({_active_requests}/{_queue_depth})"

    return True, ""


def _trip_circuit_breaker(reason: str) -> None:
    global _circuit_breaker, _circuit_breaker_reason
    _circuit_breaker = True
    _circuit_breaker_reason = reason
    logger.critical("[satellite_governor] Circuit breaker tripped: %s", reason)


def reset_circuit_breaker() -> None:
    global _circuit_breaker, _circuit_breaker_reason
    _circuit_breaker = False
    _circuit_breaker_reason = ""
    logger.info("[satellite_governor] Circuit breaker manually reset")


def apply_config(config: dict) -> None:
    """
    Apply configuration from POST /configure.
    Respects is_laptop flag (auto-shifts temps -5°C).
    """
    global _thresholds, _queue_depth
    _thresholds = LocalThresholds(
        temp_nominal_max=float(config.get("temp_nominal_max", 75.0)),
        temp_warm_max=float(config.get("temp_warm_max", 82.0)),
        temp_hot_max=float(config.get("temp_hot_max", 88.0)),
        vram_cap_pct=float(config.get("vram_cap_pct", 85.0)),
        vram_hard_cap_pct=float(config.get("vram_hard_cap_pct", 90.0)),
        ram_caution_pct=float(config.get("ram_caution_pct", 80.0)),
        ram_hard_cap_pct=float(config.get("ram_hard_cap_pct", 90.0)),
        is_laptop=bool(config.get("is_laptop", False)),
    )
    _queue_depth = int(config.get("queue_depth", 4))
    logger.info(
        "[satellite_governor] Thresholds updated: laptop=%s hot=%.0f°C",
        _thresholds.is_laptop, _thresholds.temp_hot_max,
    )


def increment_requests() -> None:
    global _active_requests
    _active_requests += 1


def decrement_requests() -> None:
    global _active_requests
    _active_requests = max(0, _active_requests - 1)


def get_state() -> dict:
    return {
        "circuit_breaker": _circuit_breaker,
        "circuit_breaker_reason": _circuit_breaker_reason,
        "queue_depth": _queue_depth,
        "active_requests": _active_requests,
        "thresholds": {
            "temp_nominal_max": _thresholds.temp_nominal_max,
            "temp_warm_max": _thresholds.temp_warm_max,
            "temp_hot_max": _thresholds.temp_hot_max,
            "vram_cap_pct": _thresholds.vram_cap_pct,
            "vram_hard_cap_pct": _thresholds.vram_hard_cap_pct,
            "is_laptop": _thresholds.is_laptop,
        },
    }
