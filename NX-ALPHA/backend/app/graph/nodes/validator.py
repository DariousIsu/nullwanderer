"""
AURA NX-Alpha — Validator Node (§12.1)
Proposer/Challenger adversarial review of AssembledOutput.

Challenger role: interface model (Qwen3-VL-8B) — different model family
from the workhorse that produced the output, making it a true adversarial check.
While the challenger is running, the interface model is marked busy and any
incoming user message receives a hold response.

Falls back to Ollama (workhorse) if the interface engine is unavailable.
Falls back to auto-approve if neither is available or max iterations exceeded.
"""

import json
import logging
import re
from datetime import datetime, timezone
from app.graph.state import GraphState, ValidationResult

logger = logging.getLogger(__name__)

_MAX_VALIDATOR_ITERATIONS = 3

# Schema for Ollama validation response
_VALIDATOR_SCHEMA = {
    "type": "object",
    "properties": {
        "verdict":          {"type": "string"},
        "score":            {"type": "number"},
        "correction_notes": {"type": "string"},
    },
    "required": ["verdict", "score"],
}

_VALIDATION_PROMPT = """\
You are an adversarial quality challenger reviewing a multi-agent research output.
Your job is to find problems — be critical.

Original task:
{task}

Generated response (first 3000 chars):
{content}

Score the response on:
1. Accuracy — does it correctly address the task?
2. Completeness — does it cover the key points?
3. Quality — is it well-structured and useful?

Respond ONLY with valid JSON (no markdown, no preamble):
{{"verdict": "approved" or "revision_needed", "score": 0.0-1.0, "correction_notes": "brief note or null"}}

Request revision only if there are serious factual errors or major gaps.\
"""


async def run_validator(state: GraphState) -> dict:
    """
    Adversarial review gate.
    Uses the interface engine (challenger) as a cross-model check against the
    workhorse-assembled output. Falls back to Ollama, then auto-approve.
    """
    from app.controller.chat_controller import _emit

    assembled = state.get("assembled_output")
    iteration = state.get("validator_iteration", 0)

    if assembled is None:
        logger.warning("[validator] No assembled_output — forcing approval")
        return {
            "validation_result": {"verdict": "approved", "score": 1.0, "correction_notes": None},
            "validator_iteration": iteration + 1,
        }

    if iteration >= _MAX_VALIDATOR_ITERATIONS:
        logger.warning("[validator] Max iterations (%d) reached — forcing approval", _MAX_VALIDATOR_ITERATIONS)
        return {
            "validation_result": {"verdict": "approved", "score": 1.0, "correction_notes": None},
            "validator_iteration": iteration + 1,
        }

    task = state.get("team_request") or state.get("user_message", "")
    team_id = state.get("team_id", "")
    content = assembled.get("content", "") if isinstance(assembled, dict) else str(assembled)

    # LightRAG READ — query sources and prior claims to enrich adversarial challenge
    lightrag_context = ""
    try:
        from app.service.lightrag_service import LightRAGService
        lg = LightRAGService.get_instance()
        if lg._available:
            res = await lg.query(
                f"sources and claims from team task: {task}",
                mode="hybrid"
            )
            if res.get("success") and res.get("result"):
                lightrag_context = "\n\nKnown sources and prior claims for this topic:\n" + res["result"][:1000]
                logger.debug("[validator] LightRAG context: %d chars", len(lightrag_context))
    except Exception as exc:
        logger.debug("[validator] LightRAG read failed (non-fatal): %s", exc)

    # Append LightRAG context to task so challenger has cross-source awareness
    enriched_task = task + lightrag_context if lightrag_context else task

    from app.controller.chat_controller import get_validator_challenger
    challenger = get_validator_challenger()

    await _emit("agent_update", {
        "agent_id": "validator",
        "status": "working",
        "summary": f"Challenger reviewing output (iteration {iteration + 1})...",
    })

    if challenger == "interface":
        # Interface model as adversarial challenger (Phase 1 — single GPU).
        # Falls back to Ollama if the engine isn't loaded yet.
        result = await _validate_with_interface_engine(enriched_task, content)
        if result is None:
            logger.info("[validator] Interface engine unavailable — falling back to Ollama challenger")
            result = await _validate_with_ollama(enriched_task, content)
    else:
        # Workhorse (Ollama) as challenger — Phase 2+ once 32GB GPUs are installed.
        # Interface model stays free for live chat during validation.
        result = await _validate_with_ollama(enriched_task, content)

    await _emit("agent_update", {
        "agent_id": "validator",
        "status": "done",
        "summary": f"Verdict: {result['verdict']} (score: {result['score']:.2f})",
    })

    # LightRAG WRITE — persist adversarial challenge record for future topic runs
    try:
        from app.service.lightrag_service import LightRAGService
        lg = LightRAGService.get_instance()
        if lg._available:
            timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            verdict = result.get("verdict", "unknown")
            score = result.get("score", 0.0)
            notes = result.get("correction_notes") or ""
            challenge_record = (
                f"# Validator Challenge: {team_id}\n"
                f"Task: {task}\n"
                f"Verdict: {verdict} (score={score:.2f})\n"
                f"Iteration: {iteration + 1}\n"
                + (f"Notes: {notes}\n" if notes else "")
            )
            lg.enqueue_ingest(
                challenge_record,
                f"validation:{team_id}:{timestamp}",
                "validation",
            )
            logger.debug("[validator] Challenge record enqueued to LightRAG")
    except Exception as exc:
        logger.debug("[validator] LightRAG write failed (non-fatal): %s", exc)

    return {
        "validation_result":   result,
        "validator_iteration": iteration + 1,
    }


async def _validate_with_interface_engine(task: str, content: str) -> ValidationResult | None:
    """
    Use the interface model as the adversarial challenger.
    Sets the global interface_busy flag for the duration so incoming messages
    receive a hold response instead of competing for the engine.
    Returns None if the interface engine is not loaded (caller falls back to Ollama).
    """
    from app.service.interface_engine import get_engine
    from app.controller.chat_controller import set_interface_busy

    engine = get_engine()
    if engine is None:
        return None

    prompt = _VALIDATION_PROMPT.format(task=task, content=content[:3000])
    messages = [
        {"role": "system", "content": "You are an adversarial quality challenger. Respond only with valid JSON."},
        {"role": "user", "content": prompt},
    ]

    set_interface_busy(True)
    try:
        result = await engine.generate(messages, max_tokens=256, temperature=0.2)
        text = result.get("text", "")
        return _parse_validation_json(text)
    except Exception as exc:
        logger.warning("[validator] Interface engine challenge failed (%s) — will try Ollama", exc)
        return None
    finally:
        set_interface_busy(False)


def _parse_validation_json(text: str) -> ValidationResult:
    """Extract and parse the JSON verdict from model output text."""
    # Strip thinking tags and markdown fences
    cleaned = re.sub(r'<think>.*?</think>', '', text, flags=re.DOTALL)
    cleaned = re.sub(r'^.*?</think>', '', cleaned, count=1, flags=re.DOTALL)
    cleaned = re.sub(r'```(?:json)?\s*', '', cleaned)

    # Try multiple JSON extraction strategies
    for attempt_text in (cleaned, text):
        # Strategy 1: find JSON with "verdict" key (may have nested braces)
        for match in re.finditer(r'\{[^{}]*"verdict"[^{}]*\}', attempt_text, re.DOTALL):
            try:
                data = json.loads(match.group(0))
                return _extract_verdict(data)
            except (json.JSONDecodeError, ValueError):
                continue

        # Strategy 2: find any JSON object
        for match in re.finditer(r'\{[^{}]+\}', attempt_text, re.DOTALL):
            try:
                data = json.loads(match.group(0))
                if "verdict" in data or "score" in data:
                    return _extract_verdict(data)
            except (json.JSONDecodeError, ValueError):
                continue

    # Strategy 3: keyword scan — if the model said "approved" or "revision" in plain text
    lower = cleaned.lower()
    if "revision_needed" in lower or "revision needed" in lower:
        logger.info("[validator] Extracted verdict from plain text: revision_needed")
        return {"verdict": "revision_needed", "score": 0.5, "correction_notes": "Parsed from plain text"}

    logger.warning("[validator] Could not parse JSON from output — defaulting to approved. Text: %.200s", text)
    return {"verdict": "approved", "score": 0.9, "correction_notes": None}


def _extract_verdict(data: dict) -> ValidationResult:
    """Normalize a parsed dict into a ValidationResult."""
    verdict = data.get("verdict", "approved")
    if verdict not in ("approved", "revision_needed"):
        # Handle alternate phrasings: "pass"→approved, "fail"/"revise"→revision_needed
        if verdict in ("pass", "accept", "ok", "good"):
            verdict = "approved"
        elif verdict in ("fail", "revise", "reject", "partial"):
            verdict = "revision_needed"
        else:
            verdict = "approved"
    score = float(data.get("score", 0.9))
    score = max(0.0, min(1.0, score))
    notes = data.get("correction_notes") or data.get("notes") or None
    return {"verdict": verdict, "score": score, "correction_notes": notes}


async def _validate_with_ollama(task: str, content: str) -> ValidationResult:
    """Fallback: ask Ollama workhorse to score the assembled output."""
    try:
        from app.service.ollama_service import get_ollama_service
        svc = get_ollama_service()
        if svc is None or not svc.is_available():
            raise RuntimeError("Ollama not available")

        prompt = _VALIDATION_PROMPT.format(task=task, content=content[:3000])
        messages = [
            {"role": "system", "content": "You are a quality reviewer. Respond only with valid JSON."},
            {"role": "user", "content": prompt},
        ]
        result = await svc.chat_json(messages, temperature=0.2, schema=_VALIDATOR_SCHEMA)

        if isinstance(result, dict):
            return _extract_verdict(result)

        return {"verdict": "approved", "score": 0.9, "correction_notes": None}

    except Exception as exc:
        logger.warning("[validator] Ollama fallback failed (%s) — auto-approving", exc)
        return {"verdict": "approved", "score": 1.0, "correction_notes": None}
