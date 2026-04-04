"""
AURA NX-Alpha — Hardware Governor
Mandatory background service that enforces thermal, VRAM, and RAM limits.
Cannot be disabled. Has override authority over all inference jobs.

Temperature Tiers (Desktop / Laptop):
    Nominal:  < 75°C / < 70°C   — Full operation
    Warm:     75-82°C / 70-77°C  — Reduce queue depth to 1, log warning
    Hot:      82-88°C / 77-83°C  — Pause new jobs, finish current only
    Critical: > 88°C / > 83°C    — Emergency stop, circuit breaker fires

VRAM Tiers:
    Safe:     < cap              — Full operation
    Caution:  cap to 90%         — No new model loads
    Hard cap: > 90%              — Refuse all requests until headroom recovers

RAM Tiers:
    Safe:     < 80%              — Full operation
    Caution:  80-90%             — Block model loads that require RAM overflow
    Hard cap: > 90%              — Pause all inference until RAM recovers

Circuit Breaker:
    Triggered on: Critical temp OR (Hard cap VRAM + Hard cap RAM simultaneously)
    No auto-reset — requires manual reset via API
    5-minute cooldown at reduced queue depth post-reset
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# ENUMS
# ─────────────────────────────────────────────────────────────────────────────

class TempTier(str, Enum):
    NOMINAL = "nominal"
    WARM = "warm"
    HOT = "hot"
    CRITICAL = "critical"


class VRAMTier(str, Enum):
    SAFE = "safe"
    CAUTION = "caution"
    HARD_CAP = "hard_cap"


class RAMTier(str, Enum):
    SAFE = "safe"
    CAUTION = "caution"
    HARD_CAP = "hard_cap"


class GovernorAction(str, Enum):
    """Recommended action from governor check."""
    ALLOW = "allow"                  # Full operation
    REDUCE_QUEUE = "reduce_queue"    # Reduce queue depth to 1
    PAUSE_NEW = "pause_new"          # Pause new job acceptance
    CIRCUIT_BREAK = "circuit_break"  # Emergency stop


# ─────────────────────────────────────────────────────────────────────────────
# THRESHOLDS
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class GovernorThresholds:
    """Configurable thresholds per machine. Defaults from SATELLITE_SPEC."""
    # GPU Temperature (°C)
    temp_nominal_max: float = 75.0
    temp_warm_max: float = 82.0
    temp_hot_max: float = 88.0
    # Above temp_hot_max = Critical

    # VRAM cap percentage (of total VRAM)
    vram_cap_pct: float = 85.0      # Per GPU class default
    vram_hard_cap_pct: float = 90.0

    # RAM percentages
    ram_caution_pct: float = 80.0
    ram_hard_cap_pct: float = 90.0

    # Laptop flag — when True, all temp thresholds shift down 5°C
    is_laptop: bool = False

    def __post_init__(self):
        if self.is_laptop:
            self.temp_nominal_max -= 5.0
            self.temp_warm_max -= 5.0
            self.temp_hot_max -= 5.0


# ─────────────────────────────────────────────────────────────────────────────
# GOVERNOR CHECK RESULT
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class GovernorResult:
    """Result of a governor health check."""
    action: GovernorAction
    temp_tier: TempTier
    vram_tier: VRAMTier
    ram_tier: RAMTier
    gpu_temp_c: float = 0.0
    vram_used_pct: float = 0.0
    ram_used_pct: float = 0.0
    reasons: list[str] = field(default_factory=list)
    circuit_break_reason: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "action": self.action.value,
            "temp_tier": self.temp_tier.value,
            "vram_tier": self.vram_tier.value,
            "ram_tier": self.ram_tier.value,
            "gpu_temp_c": self.gpu_temp_c,
            "vram_used_pct": round(self.vram_used_pct, 1),
            "ram_used_pct": round(self.ram_used_pct, 1),
            "reasons": self.reasons,
            "circuit_break_reason": self.circuit_break_reason,
        }


# ─────────────────────────────────────────────────────────────────────────────
# SINGLETON
# ─────────────────────────────────────────────────────────────────────────────

_instance: Optional["HardwareGovernor"] = None


def init_hardware_governor() -> "HardwareGovernor":
    global _instance
    _instance = HardwareGovernor()
    return _instance


def get_hardware_governor() -> Optional["HardwareGovernor"]:
    return _instance


# ─────────────────────────────────────────────────────────────────────────────
# HARDWARE GOVERNOR
# ─────────────────────────────────────────────────────────────────────────────

class HardwareGovernor:
    """
    Evaluates hardware metrics and returns action recommendations.
    Conservative by design — safety first.
    """

    def __init__(self):
        # Per-satellite threshold overrides: { satellite_id: GovernorThresholds }
        self._overrides: dict[str, GovernorThresholds] = {}
        self._default_thresholds = GovernorThresholds()
        logger.info("[governor] Hardware governor initialized")

    def set_thresholds(self, satellite_id: str, thresholds: GovernorThresholds) -> None:
        """Set per-machine threshold overrides."""
        self._overrides[satellite_id] = thresholds
        logger.info("[governor] Custom thresholds set for %s (laptop=%s)", satellite_id, thresholds.is_laptop)

    def get_thresholds(self, satellite_id: str | None = None) -> GovernorThresholds:
        """Get thresholds for a satellite (or defaults)."""
        if satellite_id and satellite_id in self._overrides:
            return self._overrides[satellite_id]
        return self._default_thresholds

    def check_health(
        self,
        metrics: dict[str, Any],
        satellite_id: str | None = None,
    ) -> GovernorResult:
        """
        Evaluate hardware metrics and return an action recommendation.

        Expected metrics dict:
            gpu_temp_c: float       — GPU temperature in Celsius
            vram_used_mb: float     — VRAM currently used (MB)
            vram_total_mb: float    — Total VRAM (MB)
            ram_used_gb: float      — System RAM used (GB)
            ram_total_gb: float     — Total system RAM (GB)
            is_laptop: bool         — Whether this is a laptop
            on_battery: bool        — Whether running on battery (laptop)
            battery_pct: float      — Battery percentage (laptop)
        """
        thresholds = self.get_thresholds(satellite_id)

        # If laptop flag comes from metrics, create adjusted thresholds
        is_laptop = metrics.get("is_laptop", thresholds.is_laptop)
        if is_laptop and not thresholds.is_laptop:
            thresholds = GovernorThresholds(is_laptop=True)

        gpu_temp = metrics.get("gpu_temp_c", 0.0)
        vram_used = metrics.get("vram_used_mb", 0.0)
        vram_total = metrics.get("vram_total_mb", 1.0)  # Avoid div/0
        ram_used = metrics.get("ram_used_gb", 0.0)
        ram_total = metrics.get("ram_total_gb", 1.0)  # Avoid div/0

        vram_pct = (vram_used / vram_total * 100) if vram_total > 0 else 0
        ram_pct = (ram_used / ram_total * 100) if ram_total > 0 else 0

        # ── Classify temperature tier ────────────────────────────────────
        if gpu_temp >= thresholds.temp_hot_max:
            temp_tier = TempTier.CRITICAL
        elif gpu_temp >= thresholds.temp_warm_max:
            temp_tier = TempTier.HOT
        elif gpu_temp >= thresholds.temp_nominal_max:
            temp_tier = TempTier.WARM
        else:
            temp_tier = TempTier.NOMINAL

        # ── Classify VRAM tier ───────────────────────────────────────────
        if vram_pct > thresholds.vram_hard_cap_pct:
            vram_tier = VRAMTier.HARD_CAP
        elif vram_pct > thresholds.vram_cap_pct:
            vram_tier = VRAMTier.CAUTION
        else:
            vram_tier = VRAMTier.SAFE

        # ── Classify RAM tier ────────────────────────────────────────────
        if ram_pct > thresholds.ram_hard_cap_pct:
            ram_tier = RAMTier.HARD_CAP
        elif ram_pct > thresholds.ram_caution_pct:
            ram_tier = RAMTier.CAUTION
        else:
            ram_tier = RAMTier.SAFE

        # ── Determine action ─────────────────────────────────────────────
        reasons: list[str] = []
        action = GovernorAction.ALLOW
        circuit_reason = ""

        # Laptop battery checks
        if is_laptop:
            on_battery = metrics.get("on_battery", False)
            battery_pct = metrics.get("battery_pct", 100.0)
            if on_battery:
                if battery_pct < 20:
                    action = GovernorAction.CIRCUIT_BREAK
                    circuit_reason = f"Battery critical ({battery_pct:.0f}%) — satellite suspended"
                    reasons.append(circuit_reason)
                else:
                    action = GovernorAction.PAUSE_NEW
                    reasons.append(f"Running on battery ({battery_pct:.0f}%) — GPU inference suspended")

        # Circuit breaker: Critical temp
        if temp_tier == TempTier.CRITICAL:
            action = GovernorAction.CIRCUIT_BREAK
            circuit_reason = f"Critical GPU temp: {gpu_temp:.1f}°C (threshold: {thresholds.temp_hot_max:.0f}°C)"
            reasons.append(circuit_reason)

        # Circuit breaker: Simultaneous Hard cap VRAM + RAM
        elif vram_tier == VRAMTier.HARD_CAP and ram_tier == RAMTier.HARD_CAP:
            action = GovernorAction.CIRCUIT_BREAK
            circuit_reason = f"VRAM ({vram_pct:.0f}%) + RAM ({ram_pct:.0f}%) both at hard cap"
            reasons.append(circuit_reason)

        # Hot temp — pause new jobs
        elif temp_tier == TempTier.HOT:
            action = max(action, GovernorAction.PAUSE_NEW, key=lambda a: list(GovernorAction).index(a))
            reasons.append(f"Hot GPU: {gpu_temp:.1f}°C — pausing new job acceptance")

        # Warm temp — reduce queue
        elif temp_tier == TempTier.WARM:
            if action.value == GovernorAction.ALLOW.value:
                action = GovernorAction.REDUCE_QUEUE
            reasons.append(f"Warm GPU: {gpu_temp:.1f}°C — reducing queue depth")

        # VRAM hard cap alone
        if vram_tier == VRAMTier.HARD_CAP and action != GovernorAction.CIRCUIT_BREAK:
            action = max(action, GovernorAction.PAUSE_NEW, key=lambda a: list(GovernorAction).index(a))
            reasons.append(f"VRAM hard cap: {vram_pct:.0f}%")

        # RAM hard cap alone
        if ram_tier == RAMTier.HARD_CAP and action != GovernorAction.CIRCUIT_BREAK:
            action = max(action, GovernorAction.PAUSE_NEW, key=lambda a: list(GovernorAction).index(a))
            reasons.append(f"RAM hard cap: {ram_pct:.0f}%")

        # VRAM caution
        if vram_tier == VRAMTier.CAUTION:
            reasons.append(f"VRAM caution: {vram_pct:.0f}% — no new model loads")

        # RAM caution
        if ram_tier == RAMTier.CAUTION:
            reasons.append(f"RAM caution: {ram_pct:.0f}% — blocking heavy model loads")

        return GovernorResult(
            action=action,
            temp_tier=temp_tier,
            vram_tier=vram_tier,
            ram_tier=ram_tier,
            gpu_temp_c=gpu_temp,
            vram_used_pct=vram_pct,
            ram_used_pct=ram_pct,
            reasons=reasons,
            circuit_break_reason=circuit_reason,
        )
