"""
AURA NX-Alpha — Prompt Optimizer

Promptim-style optimization loop. 5 iterations per cycle, Workhorse as judge.
Appends failures to ~/.aura/mcp_tools/{id}/opt_failures.jsonl for reevaluation.

OUTCOME PATHS:
    score >= 0.95 → auto-generate server.py → stage = 'sandbox'
    score < 0.95 AND cycles < 5 → stage stays 'optimizing'
    score < 0.95 AND cycles >= 5 → stage = 'reevaluation'
"""
from __future__ import annotations

import asyncio
import json
import logging
import random
import time
import uuid
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

_MCP_BASE   = Path.home() / ".aura" / "mcp_tools"
_MAX_CYCLES = 5
_SAMPLE_SIZE = 20
_TARGET_SCORE = 0.95

_IMPROVEMENT_SCHEMA = {
    "type": "object",
    "properties": {
        "improved_prompt": {"type": "string"},
        "reasoning":       {"type": "string"},
    },
    "required": ["improved_prompt", "reasoning"],
}

_REEVAL_SCHEMA = {
    "type": "object",
    "properties": {
        "root_cause":  {"type": "string"},
        "suggestions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "type":   {"type": "string"},
                    "change": {"type": "string"},
                },
            },
        },
        "confidence": {"type": "string"},
    },
    "required": ["root_cause", "suggestions", "confidence"],
}


# ─────────────────────────────────────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────────────────────────────────────

async def _emit(event_type: str, data: dict) -> None:
    try:
        from app.controller.chat_controller import _emit as _chat_emit
        await _chat_emit(event_type, data)
    except Exception:
        pass


def _get_ollama():
    try:
        from app.service.ollama_service import get_ollama_service
        return get_ollama_service()
    except Exception:
        return None


def _load_golden_set(tool_id: str) -> list[dict]:
    path = _MCP_BASE / tool_id / "golden_set.jsonl"
    entries: list[dict] = []
    if not path.exists():
        return entries
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    entries.append(json.loads(line))
                except Exception:
                    pass
    return entries


def _append_failures(tool_id: str, cycle: int, iteration: int, failures: list[dict]) -> None:
    path = _MCP_BASE / tool_id / "opt_failures.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        for fail in failures:
            f.write(json.dumps({
                "cycle":     cycle,
                "iteration": iteration,
                **fail,
            }, ensure_ascii=False) + "\n")


def _load_failures(tool_id: str) -> list[dict]:
    path = _MCP_BASE / tool_id / "opt_failures.jsonl"
    entries: list[dict] = []
    if not path.exists():
        return entries
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    entries.append(json.loads(line))
                except Exception:
                    pass
    return entries


def _clear_failures(tool_id: str) -> None:
    path = _MCP_BASE / tool_id / "opt_failures.jsonl"
    if path.exists():
        path.unlink()


# ─────────────────────────────────────────────────────────────────────────────
# CORE OPTIMIZATION
# ─────────────────────────────────────────────────────────────────────────────

async def run_optimization_cycle(tool_id: str) -> dict:
    """
    Run one optimization cycle (5 iterations) for the given tool.
    Returns {best_score, optimization_cycles, stage}.
    """
    from app.service.mcp_tool_store import get_mcp_tool_store
    from app.service.eval_runner import _judge_answer

    store  = get_mcp_tool_store()
    tool   = store.get_tool(tool_id)
    ollama = _get_ollama()

    if not tool or not ollama:
        return {"error": "tool or ollama unavailable"}

    # Bootstrap gate — need at least 15 golden examples
    golden_set = _load_golden_set(tool_id)
    if len(golden_set) < 15:
        store.update_fields(
            tool_id,
            blocking_reason=(
                f"Golden set too small ({len(golden_set)} examples). "
                "Revise base_prompt or add more training data first."
            ),
        )
        return {"error": "golden_set_too_small", "size": len(golden_set)}

    cycle = tool.optimization_cycles + 1
    candidate = tool.optimized_prompt or tool.base_prompt
    best_prompt = candidate
    best_score  = 0.0
    session_id  = str(uuid.uuid4())[:8]

    for i in range(1, 6):  # 5 iterations
        sample = random.sample(golden_set, min(_SAMPLE_SIZE, len(golden_set)))
        approved_count = 0
        failures: list[dict] = []

        for ex in sample:
            messages_list = ex.get("messages", [])
            prompt    = next((m["content"] for m in messages_list if m["role"] == "user"), "")
            reference = next((m["content"] for m in messages_list if m["role"] == "assistant"), "")
            if not prompt:
                continue

            # Generate answer with current candidate prompt
            gen_messages = [
                {"role": "system", "content": candidate},
                {"role": "user",   "content": prompt},
            ]
            try:
                answer = str(await ollama.chat(gen_messages, temperature=0.7)).strip()
            except Exception:
                answer = "[generation failed]"

            judgment = await _judge_answer(prompt, reference, answer, 6, ollama)
            if judgment["approved"]:
                approved_count += 1
            else:
                failures.append({
                    "prompt":           prompt,
                    "reference":        reference[:500],
                    "actual_answer":    answer[:500],
                    "score":            judgment["score"],
                    "judgment_reasoning": judgment["reasoning"],
                })

        win_rate  = approved_count / max(len(sample), 1)
        score_val = round(win_rate, 4)

        if score_val > best_score:
            best_score  = score_val
            best_prompt = candidate

        _append_failures(tool_id, cycle, i, failures)

        delta = round(score_val - best_score, 4)
        await _emit("opt_iteration", {
            "tool_id":    tool_id,
            "session_id": session_id,
            "iteration":  i,
            "win_rate":   score_val,
            "score_delta": delta,
        })

        # If perfect, stop early
        if best_score >= _TARGET_SCORE:
            break

        # Ask Workhorse for an improved prompt
        if failures:
            improvement_messages = [{
                "role": "user",
                "content": (
                    f"You are optimizing a system prompt for an AI tool called '{tool.name}'.\n"
                    f"Current system prompt:\n{candidate}\n\n"
                    f"These examples FAILED (score < 6/10):\n"
                    + json.dumps(failures[:10], indent=2) + "\n\n"
                    "Suggest an improved system prompt that addresses these failures. "
                    "Return JSON: {improved_prompt: str, reasoning: str}"
                ),
            }]
            try:
                improvement = await ollama.chat_json(
                    improvement_messages, temperature=0.4,
                    schema=_IMPROVEMENT_SCHEMA, timeout=45,
                )
                candidate = improvement.get("improved_prompt", candidate)
            except Exception as exc:
                logger.warning("[optimizer] improvement call failed: %s", exc)

    # Save best prompt + push to Phoenix
    store.update_fields(
        tool_id,
        optimized_prompt=best_prompt,
        optimization_score=best_score,
        optimization_cycles=cycle,
    )
    _push_to_phoenix(tool_id, best_prompt)

    await _emit("opt_complete", {
        "tool_id":    tool_id,
        "session_id": session_id,
        "best_score": best_score,
        "cycles":     cycle,
    })

    # Determine outcome
    if best_score >= _TARGET_SCORE:
        # Auto-generate server.py and advance to sandbox
        _auto_generate(tool_id)
        store.update_stage(tool_id, "sandbox", blocking_reason=None)
        return {"best_score": best_score, "optimization_cycles": cycle, "stage": "sandbox"}

    elif cycle >= _MAX_CYCLES:
        # Trigger reevaluation
        report = await _run_reevaluation(tool_id, ollama)
        store.update_fields(
            tool_id,
            stage="reevaluation",
            blocking_reason=f"5 optimization cycles failed to reach 95%",
            reevaluation_report=report,
        )
        await _emit("opt_reevaluation", {"tool_id": tool_id, "session_id": session_id, "report": report})
        return {"best_score": best_score, "optimization_cycles": cycle, "stage": "reevaluation"}

    else:
        store.update_stage(
            tool_id, "optimizing",
            blocking_reason=f"Score {best_score:.0%} — run optimization again",
        )
        return {"best_score": best_score, "optimization_cycles": cycle, "stage": "optimizing"}


async def _run_reevaluation(tool_id: str, ollama) -> dict:
    """Workhorse reads opt_failures.jsonl and diagnoses root causes."""
    failures = _load_failures(tool_id)
    if not failures:
        return {"root_cause": "No failure data available", "suggestions": [], "confidence": "low"}

    # Sample recent failures across cycles
    sample = failures[-50:] if len(failures) > 50 else failures

    messages = [{
        "role": "user",
        "content": (
            f"These are optimization failures for an AI tool across multiple cycles:\n"
            + json.dumps(sample, indent=2) + "\n\n"
            "Diagnose the root cause of the persistent failures. "
            "Suggest concrete changes (tool_definition | dataset_strategy | composition). "
            "Return JSON: {root_cause: str, suggestions: [{type: str, change: str}], confidence: 'low'|'medium'|'high'}"
        ),
    }]
    try:
        return await ollama.chat_json(messages, temperature=0.3, schema=_REEVAL_SCHEMA, timeout=60)
    except Exception as exc:
        logger.warning("[optimizer] reevaluation failed: %s", exc)
        return {"root_cause": str(exc), "suggestions": [], "confidence": "low"}


def _push_to_phoenix(tool_id: str, prompt: str) -> None:
    """Push optimized prompt to Phoenix Prompts API (best-effort)."""
    try:
        from app.service.phoenix_exporter import _load_config
        import httpx as _httpx
        cfg  = _load_config()
        host = cfg["host"].rstrip("/")
        _httpx.post(
            f"{host}/v1/prompts",
            json={"name": f"tool_{tool_id}", "template": prompt},
            timeout=5.0,
        )
    except Exception:
        pass


def _auto_generate(tool_id: str) -> None:
    """Trigger mcp_generator to build server.py now that 0.95 is reached."""
    try:
        from app.service.mcp_generator import generate_server_py
        generate_server_py(tool_id)
    except Exception as exc:
        logger.warning("[optimizer] auto-generate server.py failed: %s", exc)


def apply_reevaluation(tool_id: str) -> dict:
    """Apply reevaluation suggestions — reset cycles, clear failures, back to dataset."""
    from app.service.mcp_tool_store import get_mcp_tool_store
    store = get_mcp_tool_store()
    _clear_failures(tool_id)
    store.update_fields(
        tool_id,
        optimization_cycles=0,
        stage="dataset",
        blocking_reason=None,
    )
    return {"applied": True, "stage": "dataset"}


# ─────────────────────────────────────────────────────────────────────────────
# RUNNER
# ─────────────────────────────────────────────────────────────────────────────

class PromptOptimizerRunner:
    def __init__(self) -> None:
        self._task: Optional[asyncio.Task] = None
        self._running = False
        self._tool_id: Optional[str] = None

    async def start(self, tool_id: str) -> dict:
        if self._running:
            return {"started": False, "reason": "already running"}
        self._running = True
        self._tool_id = tool_id
        self._task = asyncio.create_task(
            self._run(tool_id),
            name=f"opt_{tool_id}",
        )
        self._task.add_done_callback(lambda _: setattr(self, "_running", False))
        return {"started": True, "tool_id": tool_id}

    async def _run(self, tool_id: str) -> None:
        try:
            await run_optimization_cycle(tool_id)
        except asyncio.CancelledError:
            pass
        except Exception as exc:
            logger.error("[optimizer] Run failed for %s: %s", tool_id, exc)

    async def stop(self) -> dict:
        if not self._running or not self._task:
            return {"stopped": False}
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass
        return {"stopped": True}

    def get_status(self) -> dict:
        return {"running": self._running, "tool_id": self._tool_id}


_runners: dict[str, PromptOptimizerRunner] = {}


def get_optimizer_runner(tool_id: str) -> PromptOptimizerRunner:
    if tool_id not in _runners:
        _runners[tool_id] = PromptOptimizerRunner()
    return _runners[tool_id]
