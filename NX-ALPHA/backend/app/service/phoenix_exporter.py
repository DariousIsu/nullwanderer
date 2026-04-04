"""
AURA NX-Alpha — Phoenix Trace Exporter

Exports LLM spans from Arize Phoenix into eval_raw.jsonl using cursor-based
pagination on the correct endpoint: GET /v1/projects/{project_id}/spans

OUTPUT FORMAT (one JSON object per line in eval_raw.jsonl):
    {
        "span_id":    str,
        "prompt":     str,
        "response":   str,
        "tier":       str | null,
        "route_type": str | null,
        "timestamp":  float
    }

Also writes ~/.aura/training/dataset_catalog.json after each export:
    {
        "generated_at": float,
        "total": int,
        "categories": {"tier_name": {"count": int, "golden_count": int}, ...}
    }
"""

from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

_CONFIG_PATH    = Path.home() / ".aura" / "phoenix_config.json"
_TRAINING_DIR   = Path.home() / ".aura" / "training"
_RAW_PATH       = _TRAINING_DIR / "eval_raw.jsonl"
_CATALOG_PATH   = _TRAINING_DIR / "dataset_catalog.json"

_DEFAULT_HOST   = "http://localhost:6006"
_PAGE_SIZE      = 1000

# OpenTelemetry / OpenInference attribute keys to try for prompt/response
_INPUT_KEYS  = ["input.value", "llm.input_messages", "message.content", "prompt"]
_OUTPUT_KEYS = ["output.value", "llm.output_messages", "completion", "response"]


# ─────────────────────────────────────────────────────────────────────────────
# INTERNAL HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def _load_config() -> dict:
    try:
        if _CONFIG_PATH.exists():
            data = json.loads(_CONFIG_PATH.read_text(encoding="utf-8"))
            return {"host": _DEFAULT_HOST, **data}
    except Exception:
        pass
    return {"host": _DEFAULT_HOST}


def _extract_text(attrs: dict, keys: list[str]) -> str:
    """Try each attribute key in order; return first non-empty string found."""
    for key in keys:
        val = attrs.get(key)
        if val is None:
            continue
        if isinstance(val, str) and val.strip():
            return val.strip()
        # Structured message arrays (OpenInference): extract content from first message
        if isinstance(val, list) and val:
            first = val[0]
            if isinstance(first, dict):
                content = first.get("message", {}).get("content") or first.get("content", "")
                if isinstance(content, str) and content.strip():
                    return content.strip()
            if isinstance(first, str) and first.strip():
                return first.strip()
        # JSON-encoded string
        if isinstance(val, str):
            try:
                decoded = json.loads(val)
                if isinstance(decoded, str) and decoded.strip():
                    return decoded.strip()
                if isinstance(decoded, list) and decoded:
                    item = decoded[0]
                    if isinstance(item, dict):
                        c = item.get("content", "")
                        if isinstance(c, str) and c.strip():
                            return c.strip()
            except (json.JSONDecodeError, TypeError):
                pass
    return ""


def _span_to_record(span: dict) -> Optional[dict]:
    """
    Convert a Phoenix span dict to an eval record.
    Returns None if the span lacks usable prompt/response.
    """
    attrs = span.get("attributes") or {}
    if isinstance(attrs, str):
        try:
            attrs = json.loads(attrs)
        except (json.JSONDecodeError, TypeError):
            attrs = {}

    prompt   = _extract_text(attrs, _INPUT_KEYS)
    response = _extract_text(attrs, _OUTPUT_KEYS)

    if not prompt or not response:
        return None

    # Routing metadata (best-effort)
    tier       = str(attrs.get("tier", "")) or None
    route_type = str(attrs.get("route", "")) or None

    # Timestamp — Phoenix stores start_time as ISO string or epoch float
    raw_ts = span.get("start_time") or span.get("startTime") or span.get("timestamp")
    try:
        if isinstance(raw_ts, (int, float)):
            timestamp = float(raw_ts)
        elif isinstance(raw_ts, str):
            from datetime import datetime, timezone
            dt = datetime.fromisoformat(raw_ts.replace("Z", "+00:00"))
            timestamp = dt.timestamp()
        else:
            timestamp = time.time()
    except Exception:
        timestamp = time.time()

    return {
        "span_id":    str(span.get("context", {}).get("span_id") or span.get("span_id") or ""),
        "prompt":     prompt,
        "response":   response,
        "tier":       tier,
        "route_type": route_type,
        "timestamp":  timestamp,
    }


# ─────────────────────────────────────────────────────────────────────────────
# PUBLIC API
# ─────────────────────────────────────────────────────────────────────────────

async def export_traces(progress_cb=None) -> dict:
    """
    Fetch all spans from Phoenix, extract conversation pairs, and write
    ~/.aura/training/eval_raw.jsonl.

    Args:
        progress_cb: Optional async callable(fetched: int, extracted: int)
                     called after each page is processed.

    Returns:
        {
            "fetched":   int,   # total spans fetched
            "extracted": int,   # spans with valid prompt+response
            "output":    str,   # path to eval_raw.jsonl
        }
    """
    cfg  = _load_config()
    host = cfg["host"].rstrip("/")

    _TRAINING_DIR.mkdir(parents=True, exist_ok=True)

    fetched   = 0
    extracted = 0

    tier_counts: dict[str, int] = {}

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            # Resolve project
            pr = await client.get(f"{host}/v1/projects")
            if pr.status_code != 200:
                raise RuntimeError(f"Phoenix unreachable — GET /v1/projects returned {pr.status_code}")

            projects = pr.json().get("data", [])
            if not projects:
                logger.warning("[phoenix_exporter] No projects found in Phoenix")
                _RAW_PATH.write_text("", encoding="utf-8")
                _write_catalog(0, {})
                return {"fetched": 0, "extracted": 0, "output": str(_RAW_PATH)}

            project_id = projects[0]["id"]
            logger.info("[phoenix_exporter] Project id=%s, fetching LLM spans…", project_id)

            # Cursor-based pagination on /v1/projects/{id}/spans with span_kind=LLM
            cursor: Optional[str] = None
            with _RAW_PATH.open("w", encoding="utf-8") as fout:
                while True:
                    params: dict = {"limit": _PAGE_SIZE, "span_kind": "LLM"}
                    if cursor:
                        params["cursor"] = cursor

                    sp = await client.get(
                        f"{host}/v1/projects/{project_id}/spans",
                        params=params,
                    )
                    if sp.status_code != 200:
                        logger.warning(
                            "[phoenix_exporter] /v1/projects/%s/spans returned %d — stopping",
                            project_id, sp.status_code,
                        )
                        break

                    body   = sp.json()
                    page   = body.get("data", [])
                    cursor = body.get("next_cursor")

                    if not page:
                        break

                    fetched += len(page)

                    for span in page:
                        record = _span_to_record(span)
                        if record:
                            fout.write(json.dumps(record, ensure_ascii=False) + "\n")
                            extracted += 1
                            tier = record.get("tier") or "untagged"
                            tier_counts[tier] = tier_counts.get(tier, 0) + 1

                    if progress_cb:
                        await progress_cb(fetched, extracted)

                    logger.debug(
                        "[phoenix_exporter] cursor=%s — fetched=%d extracted=%d",
                        cursor, fetched, extracted,
                    )

                    if not cursor:
                        break  # last page

    except Exception as exc:
        logger.error("[phoenix_exporter] Export failed: %s", exc)
        raise

    _write_catalog(extracted, tier_counts)

    logger.info("[phoenix_exporter] Done — fetched=%d extracted=%d → %s",
                fetched, extracted, _RAW_PATH)
    return {
        "fetched":   fetched,
        "extracted": extracted,
        "output":    str(_RAW_PATH),
    }


def _write_catalog(total: int, tier_counts: dict[str, int]) -> None:
    """Write dataset_catalog.json so the Tool Workspace knows what data is available."""
    _TRAINING_DIR.mkdir(parents=True, exist_ok=True)
    categories = {
        tier: {"count": count, "golden_count": 0}
        for tier, count in tier_counts.items()
    }
    catalog = {
        "generated_at": time.time(),
        "total":        total,
        "categories":   categories,
    }
    _CATALOG_PATH.write_text(
        json.dumps(catalog, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    logger.info("[phoenix_exporter] Catalog written — %d categories, %d total", len(categories), total)
