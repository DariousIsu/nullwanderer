"""
AURA NX-Alpha — Tool Auto-Updater

Background service that periodically checks whether published tools have accumulated
enough new golden-set data to warrant a re-optimization and re-publish.

Lifecycle:
  - Starts automatically in lifespan (non-fatal if anything fails)
  - Runs every AUTO_UPDATE_INTERVAL_HOURS (default 6)
  - For each published tool with auto_update=True:
      1. Check golden_set_size > last_golden_size_at_optimize + MIN_NEW_EXAMPLES
      2. Re-run prompt optimizer (one cycle)
      3. Safety gate: only publish if new_score > current optimization_score
      4. Bump patch version, re-publish to existing targets
      5. Emit tool_auto_updated SSE event
"""

from __future__ import annotations

import asyncio
import logging
import re
import time

logger = logging.getLogger(__name__)

AUTO_UPDATE_INTERVAL_HOURS = 6
MIN_NEW_EXAMPLES           = 10   # minimum new golden examples before triggering


# ─────────────────────────────────────────────────────────────────────────────
# VERSION BUMP
# ─────────────────────────────────────────────────────────────────────────────

def _bump_patch(version_tag: str) -> str:
    """Increment patch: '1.0.2' → '1.0.3'."""
    parts = version_tag.split(".")
    if len(parts) == 3 and all(p.isdigit() for p in parts):
        parts[2] = str(int(parts[2]) + 1)
        return ".".join(parts)
    return version_tag + ".1"


# ─────────────────────────────────────────────────────────────────────────────
# PER-TOOL UPDATE LOGIC
# ─────────────────────────────────────────────────────────────────────────────

async def _update_one_tool(tool_id: str) -> None:
    from app.service.mcp_tool_store import get_mcp_tool_store

    store = get_mcp_tool_store()
    tool  = store.get_tool(tool_id)
    if not tool or not tool.published or not tool.auto_update:
        return

    new_examples = tool.golden_set_size - tool.last_golden_size_at_optimize
    if new_examples < MIN_NEW_EXAMPLES:
        logger.debug(
            "[auto_updater] %s: only %d new golden examples (need %d), skipping",
            tool_id, new_examples, MIN_NEW_EXAMPLES,
        )
        return

    logger.info(
        "[auto_updater] %s: %d new golden examples — running optimization cycle",
        tool_id, new_examples,
    )

    # ── Try to run one optimization cycle ────────────────────────────────────
    new_score: float | None = None
    try:
        from app.service.prompt_optimizer import run_optimization_cycle
        result    = await run_optimization_cycle(tool_id)
        new_score = result.get("best_score")
    except ImportError:
        logger.warning("[auto_updater] prompt_optimizer not available yet — skipping %s", tool_id)
        return
    except Exception as exc:
        logger.error("[auto_updater] Optimization failed for %s: %s", tool_id, exc)
        return

    if new_score is None:
        return

    # ── Safety gate: only publish if score improved ───────────────────────────
    if new_score <= tool.optimization_score:
        logger.info(
            "[auto_updater] %s: no improvement (%.3f → %.3f), skipping re-publish",
            tool_id, tool.optimization_score, new_score,
        )
        # Still record that we checked at this golden set size
        store.update_fields(tool_id, last_golden_size_at_optimize=tool.golden_set_size)
        return

    logger.info(
        "[auto_updater] %s: score improved %.3f → %.3f — re-publishing",
        tool_id, tool.optimization_score, new_score,
    )

    # ── Bump patch version ────────────────────────────────────────────────────
    new_tag  = _bump_patch(tool.version_tag)
    new_ver  = tool.version + 1

    # ── Re-generate packages for existing targets ─────────────────────────────
    try:
        from app.service.mcp_generator import generate_mcp_package
        await generate_mcp_package(tool_id, targets=tool.publish_targets)
    except ImportError:
        logger.warning("[auto_updater] mcp_generator not available yet")
    except Exception as exc:
        logger.error("[auto_updater] Package generation failed for %s: %s", tool_id, exc)
        return

    # ── Persist updated fields ────────────────────────────────────────────────
    store.update_fields(
        tool_id,
        optimization_score=new_score,
        version=new_ver,
        version_tag=new_tag,
        last_golden_size_at_optimize=tool.golden_set_size,
    )

    # ── Emit SSE notification ─────────────────────────────────────────────────
    try:
        from app.controller.chat_controller import _emit
        await _emit("tool_auto_updated", {
            "tool_id":    tool_id,
            "tool_name":  tool.name,
            "old_score":  round(tool.optimization_score, 4),
            "new_score":  round(new_score, 4),
            "version":    new_tag,
            "targets":    tool.publish_targets,
            "timestamp":  time.time(),
        })
    except Exception as exc:
        logger.warning("[auto_updater] SSE emit failed for %s: %s", tool_id, exc)

    logger.info("[auto_updater] %s auto-updated to v%s (score %.3f)", tool_id, new_tag, new_score)


# ─────────────────────────────────────────────────────────────────────────────
# BACKGROUND LOOP
# ─────────────────────────────────────────────────────────────────────────────

async def _auto_update_loop() -> None:
    """Check all auto_update=True published tools every AUTO_UPDATE_INTERVAL_HOURS."""
    interval = AUTO_UPDATE_INTERVAL_HOURS * 3600

    # Stagger initial run by 2 minutes so startup isn't front-loaded
    await asyncio.sleep(120)

    while True:
        try:
            from app.service.mcp_tool_store import get_mcp_tool_store
            store = get_mcp_tool_store()
            candidates = [t for t in store.list_published() if t.auto_update]

            if candidates:
                logger.info("[auto_updater] Checking %d tool(s) for auto-update", len(candidates))
                for tool in candidates:
                    try:
                        await _update_one_tool(tool.id)
                    except Exception as exc:
                        logger.error("[auto_updater] Unhandled error for %s: %s", tool.id, exc)
            else:
                logger.debug("[auto_updater] No tools with auto_update=True")

        except Exception as exc:
            logger.error("[auto_updater] Loop error: %s", exc)

        await asyncio.sleep(interval)


# ─────────────────────────────────────────────────────────────────────────────
# PUBLIC API
# ─────────────────────────────────────────────────────────────────────────────

_task: asyncio.Task | None = None


def start_auto_updater() -> None:
    """Start the background auto-update loop. Called from lifespan startup."""
    global _task
    if _task is None or _task.done():
        _task = asyncio.create_task(_auto_update_loop())
        logger.info("[auto_updater] Background auto-update service started (interval=%dh)", AUTO_UPDATE_INTERVAL_HOURS)


def stop_auto_updater() -> None:
    """Cancel the background task. Called from lifespan shutdown."""
    global _task
    if _task and not _task.done():
        _task.cancel()
        logger.info("[auto_updater] Background auto-update service stopped")
