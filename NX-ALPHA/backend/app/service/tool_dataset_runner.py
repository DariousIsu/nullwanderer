"""
AURA NX-Alpha — Tool Dataset Runner

Tool-scoped training loop. Pulls data from two pools:
  Pool A — Phoenix eval_raw.jsonl (all records, null-tier included)
  Pool B — training_candidates (adversarial) matched by tool tag or ChromaDB semantic search

Judges answers with Workhorse, writes golden set to ~/.aura/mcp_tools/{id}/golden_set.jsonl.

GPU queue: module-level asyncio.Queue shared with EvalRunner — one training job at a time.
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
_MCP_BASE     = Path.home() / ".aura" / "mcp_tools"

_MIN_RESPONSE_LEN = 20
_GOLDEN_THRESHOLD = 0.8
_SEMSEARCH_K      = 500
_SEMSEARCH_COS    = 0.65

# Shared GPU queue (singleton)
_training_queue: asyncio.Queue = asyncio.Queue(maxsize=1)


# ─────────────────────────────────────────────────────────────────────────────
# SSE + SERVICE HELPERS
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


def _get_mem():
    try:
        from app.service.memory_service import get_memory_service
        return get_memory_service()
    except Exception:
        return None


# ─────────────────────────────────────────────────────────────────────────────
# POOL LOADING
# ─────────────────────────────────────────────────────────────────────────────

def _prompt_hash(prompt: str) -> str:
    return hashlib.sha256(prompt.encode("utf-8")).hexdigest()


def _load_pool_a(categories: list[str]) -> list[dict]:
    """Load Phoenix records from eval_raw.jsonl. Include all (null-tier pass-through)."""
    records: list[dict] = []
    if not _RAW_PATH.exists():
        return records
    try:
        with _RAW_PATH.open("r", encoding="utf-8") as f:
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
                if not prompt or not response or len(response) < _MIN_RESPONSE_LEN:
                    continue
                if response.lower()[:60].startswith("error"):
                    continue
                records.append({
                    "prompt":     prompt,
                    "reference":  response,
                    "tier":       rec.get("tier"),
                    "route_type": rec.get("route_type"),
                    "source":     "phoenix",
                })
    except Exception as exc:
        logger.warning("[tool_dataset] Pool A load failed: %s", exc)
    return records


def _load_pool_b(tool_id: str, tool_description: str, categories: list[str], mem) -> list[dict]:
    """Load adversarial training_candidates — tagged by tool_id or semantically matched."""
    records: list[dict] = []
    if not mem:
        return records
    try:
        with sqlite3.connect(str(mem._l1_path)) as db:
            db.row_factory = sqlite3.Row
            rows = db.execute("""
                SELECT input_text, output_text, quality_signal, markers
                FROM training_candidates
                WHERE source_type IN ('adversarial_approved', 'adversarial_corrected')
            """).fetchall()
    except Exception as exc:
        logger.warning("[tool_dataset] Pool B DB read failed: %s", exc)
        return records

    tagged: list[dict] = []
    untagged: list[dict] = []

    for row in rows:
        prompt    = (row["input_text"] or "").strip()
        reference = (row["output_text"] or "").strip()
        if not prompt or not reference or len(reference) < _MIN_RESPONSE_LEN:
            continue

        markers: dict = {}
        try:
            markers = json.loads(row["markers"] or "{}")
        except Exception:
            pass

        tool_ids = markers.get("tool_ids", [])
        entry = {
            "prompt":     prompt,
            "reference":  reference,
            "tier":       markers.get("tier"),
            "route_type": markers.get("route_type"),
            "source":     "adversarial",
        }
        if tool_id in tool_ids:
            tagged.append(entry)
        else:
            untagged.append(entry)

    records.extend(tagged)

    # Semantic search on untagged records
    if len(records) < _SEMSEARCH_K and untagged:
        try:
            from app.service.memory_service import get_memory_service
            query = f"{tool_description} {' '.join(categories)}"
            # Simple keyword filter as fallback (ChromaDB semantic if available)
            query_words = set(query.lower().split())
            scored = []
            for entry in untagged:
                text_words = set(entry["prompt"].lower().split())
                overlap = len(query_words & text_words) / max(len(query_words), 1)
                if overlap >= 0.1:  # basic relevance threshold
                    scored.append((overlap, entry))
            scored.sort(key=lambda x: -x[0])
            records.extend(e for _, e in scored[:_SEMSEARCH_K])
        except Exception as exc:
            logger.debug("[tool_dataset] Semantic search fallback: %s", exc)

    return records


# ─────────────────────────────────────────────────────────────────────────────
# TRAINING LOOP
# ─────────────────────────────────────────────────────────────────────────────

async def _run_training(tool_id: str, session_id: str) -> None:
    from app.service.mcp_tool_store import get_mcp_tool_store
    from app.service.eval_runner import _get_interface_answer, _judge_answer

    store   = get_mcp_tool_store()
    tool    = store.get_tool(tool_id)
    ollama  = _get_ollama()
    mem     = _get_mem()

    if not tool or not ollama:
        await _emit("tool_run_complete", {
            "tool_id": tool_id, "session_id": session_id,
            "golden_set_size": 0, "win_rate": 0, "status": "error",
        })
        return

    await _emit("tool_run_start", {"tool_id": tool_id, "session_id": session_id})

    # Load pools
    pool_a = _load_pool_a(tool.categories)
    pool_b = _load_pool_b(tool_id, tool.description, tool.categories, mem)

    # Merge + deduplicate
    seen: set[str] = set()
    combined: list[dict] = []
    for rec in pool_a + pool_b:
        h = _prompt_hash(rec["prompt"])
        if h not in seen:
            seen.add(h)
            combined.append(rec)

    if not combined:
        await _emit("tool_run_complete", {
            "tool_id": tool_id, "session_id": session_id,
            "golden_set_size": 0, "win_rate": 0, "status": "no_data",
        })
        return

    total    = len(combined)
    done     = 0
    approved = 0
    new_golden: list[dict] = []

    # System prompt = tool's base_prompt
    system_prompt = tool.base_prompt or (
        f"You are an AI assistant. Help with: {tool.description}"
    )

    for rec in combined:
        prompt    = rec["prompt"]
        reference = rec["reference"]
        tier      = rec.get("tier")
        route     = rec.get("route_type")

        # Get answer using tool's base_prompt as system context
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": prompt},
        ]
        try:
            answer = str(await ollama.chat(messages, temperature=0.7)).strip()
        except Exception:
            answer = "[generation failed]"

        # Judge
        judgment = await _judge_answer(prompt, reference, answer, 6, ollama)
        score    = judgment["score"]
        quality  = score / 10.0

        # Store to training_candidates
        if mem:
            try:
                with sqlite3.connect(str(mem._l1_path)) as db:
                    db.execute(
                        """INSERT INTO training_candidates
                           (source_type, input_text, output_text, quality_signal, markers, created_at)
                           VALUES (?, ?, ?, ?, ?, ?)""",
                        (
                            "tool_training", prompt, answer, quality,
                            json.dumps({"tool_id": tool_id, "tier": tier, "route_type": route}),
                            time.time(),
                        ),
                    )
                    db.commit()
            except Exception as exc:
                logger.warning("[tool_dataset] training_candidates insert failed: %s", exc)

        if quality >= _GOLDEN_THRESHOLD:
            new_golden.append({
                "messages": [
                    {"role": "user",      "content": prompt},
                    {"role": "assistant", "content": answer},
                ],
                "quality_signal": quality,
                "prompt_hash":    _prompt_hash(prompt),
            })
            approved += 1

        done += 1
        await _emit("tool_run_progress", {
            "tool_id": tool_id, "session_id": session_id,
            "done": done, "total": total, "golden_count": len(new_golden),
        })
        await _emit("tool_run_result", {
            "tool_id":       tool_id,
            "prompt_preview": prompt[:120],
            "score":          score,
            "approved":       judgment["approved"],
        })

    # Merge golden set — deduplicate by prompt hash
    golden_path = _MCP_BASE / tool_id / "golden_set.jsonl"
    golden_path.parent.mkdir(parents=True, exist_ok=True)

    existing_golden: list[dict] = []
    if golden_path.exists():
        with golden_path.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        existing_golden.append(json.loads(line))
                    except Exception:
                        pass

    existing_hashes = {e.get("prompt_hash", "") for e in existing_golden}
    merged = existing_golden + [g for g in new_golden if g["prompt_hash"] not in existing_hashes]

    with golden_path.open("w", encoding="utf-8") as f:
        for entry in merged:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")

    golden_size = len(merged)
    win_rate    = round(approved / max(done, 1), 3)

    store.update_fields(tool_id, golden_set_size=golden_size, stage="optimizing")

    await _emit("tool_run_complete", {
        "tool_id":        tool_id,
        "session_id":     session_id,
        "done":           done,
        "total":          total,
        "golden_set_size": golden_size,
        "win_rate":       win_rate,
        "status":         "complete",
    })


# ─────────────────────────────────────────────────────────────────────────────
# RUNNER CLASS
# ─────────────────────────────────────────────────────────────────────────────

class ToolDatasetRunner:
    def __init__(self) -> None:
        self._task: Optional[asyncio.Task] = None
        self._running  = False
        self._tool_id: Optional[str] = None
        self._session_id: Optional[str] = None
        self._start_time: Optional[float] = None

    async def start(self, tool_id: str) -> dict:
        session_id = str(uuid.uuid4())[:8]

        if not _training_queue.empty():
            position = _training_queue.qsize() + 1
            await _emit("tool_run_queued", {"tool_id": tool_id, "session_id": session_id, "position": position})

        self._tool_id    = tool_id
        self._session_id = session_id
        self._running    = True
        self._start_time = time.time()

        self._task = asyncio.create_task(
            self._queued_run(tool_id, session_id),
            name=f"tool_dataset_{session_id}",
        )
        self._task.add_done_callback(lambda _: setattr(self, "_running", False))
        return {"started": True, "session_id": session_id, "tool_id": tool_id}

    async def _queued_run(self, tool_id: str, session_id: str) -> None:
        await _training_queue.put(session_id)
        try:
            await _run_training(tool_id, session_id)
        finally:
            try:
                _training_queue.get_nowait()
                _training_queue.task_done()
            except Exception:
                pass

    async def stop(self) -> dict:
        if not self._running or not self._task:
            return {"stopped": False}
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass
        return {"stopped": True, "tool_id": self._tool_id}

    def get_status(self) -> dict:
        return {
            "running":    self._running,
            "tool_id":    self._tool_id,
            "session_id": self._session_id,
            "elapsed_s":  round(time.time() - self._start_time, 1) if self._start_time else 0,
        }


# ─────────────────────────────────────────────────────────────────────────────
# SINGLETON
# ─────────────────────────────────────────────────────────────────────────────

_runner: Optional[ToolDatasetRunner] = None


def get_tool_dataset_runner() -> ToolDatasetRunner:
    global _runner
    if _runner is None:
        _runner = ToolDatasetRunner()
    return _runner
