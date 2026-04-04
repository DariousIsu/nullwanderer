"""
AURA NX-Alpha — Eval Baseline Report Generator (§33)

Reads eval_baseline rows from training_candidates (SQLite L1),
computes performance metrics, and writes:
    ~/.aura/training/baseline_report.json   — full metrics
    ~/.aura/training/golden_set.jsonl       — top-scoring records as multi-turn chat JSONL

METRICS:
    win_rate         = count(quality_signal >= 0.6) / total
    avg_score        = mean(quality_signal) * 10
    score_by_tier    = {tier: avg_score}
    score_by_route   = {solo/team: avg_score}
    gap_domains      = records with quality_signal < 0.4

GOLDEN SET FORMAT (per §33 spec — multi-turn chat JSONL):
    {"messages": [{"role": "user", "content": "..."}, {"role": "assistant", "content": "..."}]}
"""

from __future__ import annotations

import json
import logging
import sqlite3
import time
from pathlib import Path

logger = logging.getLogger(__name__)

_TRAINING_DIR    = Path.home() / ".aura" / "training"
_REPORT_PATH     = _TRAINING_DIR / "baseline_report.json"
_GOLDEN_PATH     = _TRAINING_DIR / "golden_set.jsonl"

_WIN_THRESHOLD    = 0.6   # quality_signal >= 0.6 → win
_GOLDEN_THRESHOLD = 0.8   # quality_signal >= 0.8 → golden
_GAP_THRESHOLD    = 0.4   # quality_signal < 0.4  → gap domain
_GOLDEN_MAX       = 100   # cap golden set size


# ─────────────────────────────────────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def _get_db_path() -> str | None:
    try:
        from app.service.memory_service import get_memory_service
        mem = get_memory_service()
        return str(mem._l1_path) if mem else None
    except Exception:
        return None


def _safe_avg(values: list[float]) -> float:
    return round(sum(values) / len(values), 4) if values else 0.0


# ─────────────────────────────────────────────────────────────────────────────
# PUBLIC API
# ─────────────────────────────────────────────────────────────────────────────

def generate_report() -> dict:
    """
    Read training_candidates (source_type='eval_baseline'), compute metrics,
    write baseline_report.json and golden_set.jsonl.
    Returns the report dict.
    """
    db_path = _get_db_path()
    if db_path is None:
        raise RuntimeError("memory_service not available — cannot read training_candidates")

    rows: list[dict] = []
    try:
        with sqlite3.connect(db_path) as db:
            db.row_factory = sqlite3.Row
            rows = [
                dict(r) for r in db.execute(
                    """SELECT input_text, output_text, quality_signal, markers
                       FROM training_candidates
                       WHERE source_type = 'eval_baseline'
                       ORDER BY created_at ASC"""
                ).fetchall()
            ]
    except Exception as exc:
        logger.error("[baseline_report] DB read failed: %s", exc)
        raise

    if not rows:
        logger.warning("[baseline_report] No eval_baseline rows found")
        report: dict = {
            "generated_at": time.time(),
            "total": 0,
            "win_rate": 0.0,
            "avg_score": 0.0,
            "score_by_tier": {},
            "score_by_route": {},
            "gap_count": 0,
            "golden_set_size": 0,
        }
        _write_outputs(report, [])
        return report

    total = len(rows)
    wins  = 0
    all_scores: list[float] = []

    tier_scores:  dict[str, list[float]] = {}
    route_scores: dict[str, list[float]] = {}
    gap_rows:     list[dict] = []
    golden_rows:  list[dict] = []

    for row in rows:
        q = float(row.get("quality_signal") or 0.0)
        all_scores.append(q)

        if q >= _WIN_THRESHOLD:
            wins += 1

        # Parse markers JSON for tier/route
        markers: dict = {}
        raw_markers = row.get("markers")
        if raw_markers:
            try:
                markers = json.loads(raw_markers)
            except (json.JSONDecodeError, TypeError):
                pass

        tier       = markers.get("tier") or "unknown"
        route_type = markers.get("route_type") or "unknown"

        tier_scores.setdefault(tier, []).append(q)
        route_scores.setdefault(route_type, []).append(q)

        if q < _GAP_THRESHOLD:
            gap_rows.append(row)

        if q >= _GOLDEN_THRESHOLD and len(golden_rows) < _GOLDEN_MAX:
            golden_rows.append(row)

    win_rate    = round(wins / total, 4)
    avg_score   = round(_safe_avg(all_scores) * 10, 2)

    score_by_tier  = {t: round(_safe_avg(s) * 10, 2) for t, s in tier_scores.items()}
    score_by_route = {r: round(_safe_avg(s) * 10, 2) for r, s in route_scores.items()}

    # Gap domain summary — top 20 worst prompts
    gap_sample = sorted(gap_rows, key=lambda r: float(r.get("quality_signal") or 0.0))[:20]
    gap_summary = [
        {
            "prompt_preview": r.get("input_text", "")[:120],
            "score": round(float(r.get("quality_signal") or 0.0) * 10, 1),
        }
        for r in gap_sample
    ]

    report = {
        "generated_at":    time.time(),
        "total":           total,
        "win_rate":        win_rate,
        "avg_score":       avg_score,
        "score_by_tier":   score_by_tier,
        "score_by_route":  score_by_route,
        "gap_count":       len(gap_rows),
        "gap_sample":      gap_summary,
        "golden_set_size": len(golden_rows),
    }

    _write_outputs(report, golden_rows)

    logger.info(
        "[baseline_report] Done — total=%d win_rate=%.2f avg_score=%.1f golden=%d gaps=%d",
        total, win_rate, avg_score, len(golden_rows), len(gap_rows),
    )
    return report


def _write_outputs(report: dict, golden_rows: list[dict]) -> None:
    """Write baseline_report.json and golden_set.jsonl to ~/.aura/training/."""
    _TRAINING_DIR.mkdir(parents=True, exist_ok=True)

    # baseline_report.json
    _REPORT_PATH.write_text(
        json.dumps(report, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

    # golden_set.jsonl — multi-turn chat format per §33
    with _GOLDEN_PATH.open("w", encoding="utf-8") as f:
        for row in golden_rows:
            entry = {
                "messages": [
                    {"role": "user",      "content": row.get("input_text", "")},
                    {"role": "assistant", "content": row.get("output_text", "")},
                ],
                "quality_signal": float(row.get("quality_signal") or 0.0),
            }
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")

    logger.info("[baseline_report] Wrote %s and %s", _REPORT_PATH, _GOLDEN_PATH)


def load_report() -> dict | None:
    """Load the most recent baseline_report.json, or None if not generated yet."""
    try:
        if _REPORT_PATH.exists():
            return json.loads(_REPORT_PATH.read_text(encoding="utf-8"))
    except Exception as exc:
        logger.warning("[baseline_report] load_report failed: %s", exc)
    return None


def load_golden_set() -> list[dict]:
    """Load golden_set.jsonl entries as a list of dicts."""
    entries: list[dict] = []
    try:
        if _GOLDEN_PATH.exists():
            with _GOLDEN_PATH.open("r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line:
                        entries.append(json.loads(line))
    except Exception as exc:
        logger.warning("[baseline_report] load_golden_set failed: %s", exc)
    return entries
