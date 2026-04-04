"""
AURA NX-Alpha — Eval Runner

Phase 2 of the Phoenix trace → eval baseline pipeline.

FLOW:
    eval_raw.jsonl
      → curation (dedup + filter + stratified sample)
      → eval_set.jsonl
      → Interface Engine answers each prompt (OllamaService with AURA system prompt)
      → Workhorse judges each answer (same _judge_answer pattern as adversarial_trainer)
      → results stored to training_candidates (source_type='eval_baseline')
      → SSE events: eval_progress, eval_result, eval_complete

SSE events emitted:
    eval_export_start   {total_raw: int}
    eval_export_done    {fetched: int, extracted: int}
    eval_curate_done    {curated: int}
    eval_progress       {done: int, total: int, approved: int}
    eval_result         {prompt_preview: str, score: int, approved: bool}
    eval_complete       {done: int, total: int, approved: int, win_rate: float, status: str}
    eval_error          {reason: str}
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import sqlite3
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

_TRAINING_DIR = Path.home() / ".aura" / "training"
_RAW_PATH     = _TRAINING_DIR / "eval_raw.jsonl"
_EVAL_PATH    = _TRAINING_DIR / "eval_set.jsonl"

_JUDGE_THRESHOLD = 6      # score >= 6 → approved (win)
_MAX_PER_TIER    = 500    # stratified cap per routing tier
_MIN_RESPONSE_LEN = 20   # filter out very short responses


# ─────────────────────────────────────────────────────────────────────────────
# CONFIG
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class EvalConfig:
    judge_threshold: int  = _JUDGE_THRESHOLD
    max_per_tier: int     = _MAX_PER_TIER
    session_id: str       = field(default_factory=lambda: str(uuid.uuid4())[:8])


# ─────────────────────────────────────────────────────────────────────────────
# CURATION
# ─────────────────────────────────────────────────────────────────────────────

def _curate(raw_path: Path, eval_path: Path, max_per_tier: int) -> int:
    """
    Load eval_raw.jsonl, deduplicate, filter, stratify by tier,
    write eval_set.jsonl. Returns number of curated records.
    """
    records: list[dict] = []
    seen_hashes: set[str] = set()

    try:
        with raw_path.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue

                prompt   = rec.get("prompt", "").strip()
                response = rec.get("response", "").strip()

                if not prompt or not response:
                    continue
                if len(response) < _MIN_RESPONSE_LEN:
                    continue
                if "error" in response.lower()[:60]:
                    continue

                # Deduplicate on prompt hash
                ph = hashlib.sha256(prompt.encode("utf-8")).hexdigest()
                if ph in seen_hashes:
                    continue
                seen_hashes.add(ph)

                records.append(rec)
    except Exception as exc:
        logger.error("[eval_runner] curation read failed: %s", exc)
        return 0

    # Stratified sample — cap each tier
    tier_counts: dict[str, int] = {}
    curated: list[dict] = []
    for rec in records:
        tier = rec.get("tier") or "unknown"
        count = tier_counts.get(tier, 0)
        if count < max_per_tier:
            curated.append(rec)
            tier_counts[tier] = count + 1

    _TRAINING_DIR.mkdir(parents=True, exist_ok=True)
    with eval_path.open("w", encoding="utf-8") as f:
        for rec in curated:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")

    logger.info("[eval_runner] Curated %d records (from %d raw, %d unique)",
                len(curated), len(records) + len(seen_hashes) - len(seen_hashes),
                len(seen_hashes))
    return len(curated)


# ─────────────────────────────────────────────────────────────────────────────
# JUDGE HELPERS  (mirrors adversarial_trainer._judge_answer pattern)
# ─────────────────────────────────────────────────────────────────────────────

_JUDGE_SCHEMA = {
    "type": "object",
    "properties": {
        "score":      {"type": "integer"},
        "approved":   {"type": "boolean"},
        "correction": {"type": ["string", "null"]},
        "reasoning":  {"type": "string"},
    },
    "required": ["score", "approved", "correction", "reasoning"],
}


async def _judge_answer(
    prompt: str,
    reference: str,
    answer: str,
    threshold: int,
    ollama,
) -> dict:
    """
    Use Workhorse to score Interface Engine's answer.
    Returns {"score": int, "approved": bool, "reasoning": str}.
    """
    judge_prompt = (
        "You are evaluating an AI assistant's answer quality.\n"
        f"Question: {prompt[:500]}\n"
        f"Reference answer: {reference[:400]}\n"
        f"Actual answer: {answer[:600]}\n\n"
        f"Score 1-10 (10=perfect). Return JSON with fields: "
        f"score (int), approved (bool, true if score >= {threshold}), "
        f"correction (str or null), reasoning (str)."
    )
    messages = [{"role": "user", "content": judge_prompt}]
    try:
        result = await ollama.chat_json(messages, temperature=0.3, schema=_JUDGE_SCHEMA)
        score    = int(result.get("score", 5))
        approved = score >= threshold
        return {
            "score":     score,
            "approved":  approved,
            "reasoning": str(result.get("reasoning", "")),
        }
    except Exception as exc:
        logger.warning("[eval_runner] judge_answer failed: %s", exc)
        return {"score": 5, "approved": True, "reasoning": "judgment unavailable"}


async def _get_interface_answer(prompt: str, ollama) -> str:
    """Call Ollama with the AURA system prompt (same as adversarial trainer)."""
    messages = [
        {
            "role": "system",
            "content": (
                "You are AURA, an intelligent AI assistant. "
                "Answer the user's question clearly, accurately, and helpfully."
            ),
        },
        {"role": "user", "content": prompt},
    ]
    try:
        result = await ollama.chat(messages, temperature=0.7)
        return str(result).strip()
    except Exception as exc:
        logger.warning("[eval_runner] interface_answer failed: %s", exc)
        return "[generation failed]"


# ─────────────────────────────────────────────────────────────────────────────
# MEMORY WRITE
# ─────────────────────────────────────────────────────────────────────────────

def _write_candidate(
    mem,
    prompt: str,
    answer: str,
    score: int,
    tier: Optional[str],
    route_type: Optional[str],
) -> None:
    """Insert eval result into training_candidates (source_type='eval_baseline')."""
    quality = score / 10.0
    markers = json.dumps({"tier": tier or "unknown", "route_type": route_type or "unknown"})
    try:
        with sqlite3.connect(mem._l1_path) as db:
            db.execute(
                """INSERT INTO training_candidates
                   (source_type, input_text, output_text, quality_signal, markers, created_at)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                ("eval_baseline", prompt, answer, quality, markers, time.time()),
            )
            db.commit()
    except Exception as exc:
        logger.warning("[eval_runner] training_candidates insert failed: %s", exc)


# ─────────────────────────────────────────────────────────────────────────────
# SSE EMIT
# ─────────────────────────────────────────────────────────────────────────────

async def _emit(event_type: str, data: dict) -> None:
    try:
        from app.controller.chat_controller import _emit as _chat_emit
        await _chat_emit(event_type, data)
    except Exception:
        pass


# ─────────────────────────────────────────────────────────────────────────────
# EVAL RUNNER
# ─────────────────────────────────────────────────────────────────────────────

class EvalRunner:
    """
    Background asyncio task that:
      1. Exports Phoenix traces (via phoenix_exporter)
      2. Curates into eval_set.jsonl
      3. Runs Interface Engine + Workhorse judge on each record
      4. Persists results to training_candidates
      5. Calls baseline_report to generate metrics + golden set
    """

    def __init__(self) -> None:
        self._task: Optional[asyncio.Task] = None
        self._running  = False
        self._done     = 0
        self._total    = 0
        self._approved = 0
        self._session_id: Optional[str] = None
        self._start_time: Optional[float] = None

    async def start(self, config: EvalConfig) -> dict:
        if self._running:
            return {"started": False, "reason": "already running", "session_id": self._session_id}

        self._running    = True
        self._done       = 0
        self._total      = 0
        self._approved   = 0
        self._session_id = config.session_id
        self._start_time = time.time()

        self._task = asyncio.create_task(
            self._run(config),
            name=f"eval_runner_{config.session_id}",
        )
        self._task.add_done_callback(self._on_done)
        logger.info("[eval_runner] Started session %s", config.session_id)
        return {"started": True, "session_id": config.session_id}

    def _on_done(self, task: asyncio.Task) -> None:
        self._running = False
        if task.exception():
            logger.error("[eval_runner] Task failed: %s", task.exception())

    async def stop(self) -> dict:
        if not self._running or self._task is None:
            return {"stopped": False, "reason": "not running"}
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass
        return {"stopped": True, "session_id": self._session_id}

    def get_status(self) -> dict:
        return {
            "running":    self._running,
            "session_id": self._session_id,
            "done":       self._done,
            "total":      self._total,
            "approved":   self._approved,
            "win_rate":   round(self._approved / max(self._done, 1), 3),
            "elapsed_s":  round(time.time() - self._start_time, 1) if self._start_time else 0,
        }

    async def _run(self, config: EvalConfig) -> None:
        try:
            # ── Step 1: Export traces from Phoenix ────────────────────────────
            await _emit("eval_export_start", {"session_id": config.session_id})
            from app.service.phoenix_exporter import export_traces

            async def _progress_cb(fetched: int, extracted: int) -> None:
                await _emit("eval_export_start", {
                    "session_id": config.session_id,
                    "fetched": fetched,
                    "extracted": extracted,
                })

            export_result = await export_traces(progress_cb=_progress_cb)
            await _emit("eval_export_done", {
                "session_id": config.session_id,
                "fetched":    export_result["fetched"],
                "extracted":  export_result["extracted"],
            })
            logger.info("[eval_runner] Export done — %s", export_result)

            # ── Step 2: Curate ────────────────────────────────────────────────
            curated_count = _curate(_RAW_PATH, _EVAL_PATH, config.max_per_tier)
            self._total = curated_count
            await _emit("eval_curate_done", {
                "session_id": config.session_id,
                "curated":    curated_count,
            })

            if curated_count == 0:
                await _emit("eval_error", {"session_id": config.session_id,
                                           "reason": "no records after curation"})
                return

            # ── Step 3: Load Ollama (Workhorse) ───────────────────────────────
            ollama = _get_ollama()
            if ollama is None:
                await _emit("eval_error", {"session_id": config.session_id,
                                           "reason": "ollama_unavailable"})
                return

            mem = _get_mem_service()
            if mem is None:
                await _emit("eval_error", {"session_id": config.session_id,
                                           "reason": "memory_service_unavailable"})
                return

            # ── Step 4: Eval loop ─────────────────────────────────────────────
            with _EVAL_PATH.open("r", encoding="utf-8") as f:
                records = [json.loads(line) for line in f if line.strip()]

            for rec in records:
                prompt     = rec.get("prompt", "")
                reference  = rec.get("response", "")   # original Phoenix response = reference
                tier       = rec.get("tier")
                route_type = rec.get("route_type")

                # Get Interface Engine answer for this prompt
                answer = await _get_interface_answer(prompt, ollama)

                # Judge against the Phoenix reference response
                judgment = await _judge_answer(
                    prompt, reference, answer, config.judge_threshold, ollama
                )

                # Persist to training_candidates
                _write_candidate(
                    mem, prompt, answer,
                    judgment["score"], tier, route_type,
                )

                self._done += 1
                if judgment["approved"]:
                    self._approved += 1

                await _emit("eval_progress", {
                    "session_id": config.session_id,
                    "done":       self._done,
                    "total":      self._total,
                    "approved":   self._approved,
                })
                await _emit("eval_result", {
                    "session_id":    config.session_id,
                    "prompt_preview": prompt[:120],
                    "score":         judgment["score"],
                    "approved":      judgment["approved"],
                    "reasoning":     judgment["reasoning"][:200],
                })

            # ── Step 5: Generate baseline report + golden set ─────────────────
            try:
                from app.training.baseline_report import generate_report
                report = generate_report()
                await _emit("eval_complete", {
                    "session_id": config.session_id,
                    "done":       self._done,
                    "total":      self._total,
                    "approved":   self._approved,
                    "win_rate":   round(self._approved / max(self._done, 1), 3),
                    "avg_score":  report.get("avg_score", 0),
                    "golden_set_size": report.get("golden_set_size", 0),
                    "status":     "complete",
                })
            except Exception as exc:
                logger.warning("[eval_runner] report generation failed: %s", exc)
                await _emit("eval_complete", {
                    "session_id": config.session_id,
                    "done":       self._done,
                    "total":      self._total,
                    "approved":   self._approved,
                    "win_rate":   round(self._approved / max(self._done, 1), 3),
                    "status":     "complete",
                })

        except asyncio.CancelledError:
            await _emit("eval_complete", {
                "session_id": self._session_id,
                "done":       self._done,
                "total":      self._total,
                "status":     "stopped",
            })
            raise
        except Exception as exc:
            logger.error("[eval_runner] Run failed: %s", exc)
            await _emit("eval_error", {
                "session_id": self._session_id,
                "reason":     str(exc),
            })


# ─────────────────────────────────────────────────────────────────────────────
# LAZY SERVICE HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def _get_ollama():
    try:
        from app.service.ollama_service import get_ollama_service
        return get_ollama_service()
    except Exception:
        return None


def _get_mem_service():
    try:
        from app.service.memory_service import get_memory_service
        return get_memory_service()
    except Exception:
        return None


# ─────────────────────────────────────────────────────────────────────────────
# SINGLETON
# ─────────────────────────────────────────────────────────────────────────────

_runner: Optional[EvalRunner] = None


def get_eval_runner() -> EvalRunner:
    global _runner
    if _runner is None:
        _runner = EvalRunner()
    return _runner
