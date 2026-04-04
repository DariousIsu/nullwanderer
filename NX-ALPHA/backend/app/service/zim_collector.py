"""
AURA NX-Alpha — ZIM Collection Folder Service

Monitors a configurable "collection folder" for new ZIM files dropped in by the
user.  ZIMs are the only accepted format — everything else is ignored.

SWEEP TRIGGERS:
    - On backend startup (automatic)
    - Manual trigger via POST /data/knowledge/sweep  (UI button)

CLASSIFICATION:
    For each .zim found in the collection folder:
      NEW       — no matching source exists   → create folder, move, index
      UPDATE    — matching source exists, new date is newer → replace old, re-index
      DUPLICATE — matching source exists, same or older date → delete inbox copy

FILENAME MATCHING:
    Kiwix ZIMs follow predictable naming patterns:
      wikipedia_en_mathematics_maxi_2026-03.zim
      stackoverflow.com_en_all_2023-11.zim
      devdocs_en_python_2026-02.zim
    We match against the SOURCES registry URLs first (exact filename match).
    Fallback: derive a source_id from the filename stem.

SETTINGS:
    collection_folder path is stored in ~/.aura/settings.json under
    "collection_folder" key.  Defaults to ~/.aura/knowledge/_inbox/.
"""

from __future__ import annotations

import json
import logging
import re
import shutil
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

_KNOWLEDGE_ROOT = Path.home() / ".aura" / "knowledge"
_DEFAULT_INBOX = _KNOWLEDGE_ROOT / "_inbox"
_SETTINGS_PATH = Path.home() / ".aura" / "settings.json"


# ─────────────────────────────────────────────────────────────────────────────
# FILENAME → SOURCE ID MAPPING
# ─────────────────────────────────────────────────────────────────────────────

def _build_filename_map() -> dict[str, str]:
    """
    Build a mapping from ZIM filename (without date suffix) → source_id
    using the SOURCES registry in knowledge_downloader.
    """
    try:
        from app.service.knowledge_downloader import SOURCES
    except ImportError:
        return {}

    mapping: dict[str, str] = {}
    for source_id, meta in SOURCES.items():
        url = meta.get("url", "")
        if not url.endswith(".zim"):
            continue
        # Extract filename from URL, strip the date suffix
        # e.g. "wikipedia_en_mathematics_maxi_2026-03.zim" → "wikipedia_en_mathematics_maxi"
        filename = url.rsplit("/", 1)[-1]
        stem = filename.removesuffix(".zim")
        # Also store the exact filename for direct match
        mapping[filename] = source_id
        # Strip date suffix (pattern: _YYYY-MM or _YYYY-MM-DD at end)
        base = re.sub(r"_\d{4}-\d{2}(-\d{2})?$", "", stem)
        mapping[base] = source_id

    return mapping


def _extract_date(filename: str) -> Optional[str]:
    """
    Extract the date suffix from a ZIM filename.
    Returns date string like "2026-03" or None.
    """
    stem = Path(filename).stem
    match = re.search(r"(\d{4}-\d{2}(-\d{2})?)$", stem)
    return match.group(1) if match else None


def _match_source_id(filename: str) -> str:
    """
    Map a ZIM filename to a source_id.
    First tries exact match against SOURCES registry, then derives from filename.
    """
    mapping = _build_filename_map()

    # Try exact filename match
    if filename in mapping:
        return mapping[filename]

    # Try base name match (without date)
    stem = Path(filename).stem
    base = re.sub(r"_\d{4}-\d{2}(-\d{2})?$", "", stem)
    if base in mapping:
        return mapping[base]

    # Fallback: derive source_id from filename
    # "wikipedia_en_chemistry_maxi_2026-01.zim" → "wikipedia_chemistry"
    # "stackoverflow.com_en_all_2023-11.zim" → "stackoverflow"
    # "devdocs_en_python_2026-02.zim" → "devdocs_python"
    source_id = _derive_source_id(stem)
    return source_id


def _derive_source_id(stem: str) -> str:
    """
    Best-effort derivation of a source_id from a ZIM filename stem.
    Strips dates, language codes, size markers, and domain suffixes.
    """
    # Remove date suffix
    clean = re.sub(r"_\d{4}-\d{2}(-\d{2})?$", "", stem)
    # Remove .com / .org domain suffixes (stackoverflow.com → stackoverflow)
    clean = re.sub(r"\.(com|org|net|io)", "", clean)
    # Remove common Kiwix suffixes: _en_all, _en_all_nopic, _maxi, _mini, _nopic
    clean = re.sub(r"_en(_all)?(_nopic|_maxi|_mini)?", "", clean)
    # Collapse multiple underscores
    clean = re.sub(r"_+", "_", clean).strip("_")
    return clean or stem


# ─────────────────────────────────────────────────────────────────────────────
# SWEEP RESULT
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class SweepAction:
    filename: str
    source_id: str
    action: str          # "new", "update", "duplicate", "error"
    detail: str = ""


# ─────────────────────────────────────────────────────────────────────────────
# COLLECTION FOLDER PATH
# ─────────────────────────────────────────────────────────────────────────────

def get_collection_folder() -> Path:
    """Read the collection folder path from settings, or return default."""
    try:
        if _SETTINGS_PATH.exists():
            settings = json.loads(_SETTINGS_PATH.read_text(encoding="utf-8"))
            custom = settings.get("collection_folder")
            if custom:
                p = Path(custom).expanduser()
                if p.exists() and p.is_dir():
                    return p
    except Exception as exc:
        logger.warning("[zim_collector] Failed to read collection_folder from settings: %s", exc)

    return _DEFAULT_INBOX


def set_collection_folder(path: str) -> Path:
    """
    Persist a new collection folder path to settings.json.
    Creates the directory if it doesn't exist.
    """
    from app.controller.chat_controller import _persist_settings_json
    resolved = Path(path).expanduser().resolve()
    resolved.mkdir(parents=True, exist_ok=True)
    _persist_settings_json({"collection_folder": str(resolved)})
    logger.info("[zim_collector] Collection folder set to: %s", resolved)
    return resolved


# ─────────────────────────────────────────────────────────────────────────────
# SWEEP
# ─────────────────────────────────────────────────────────────────────────────

async def sweep_collection_folder() -> list[dict]:
    """
    Scan the collection folder for .zim files and process them.

    Returns a list of action dicts:
      {"filename": str, "source_id": str, "action": str, "detail": str}
    """
    inbox = get_collection_folder()
    if not inbox.exists():
        inbox.mkdir(parents=True, exist_ok=True)
        logger.info("[zim_collector] Created collection folder: %s", inbox)
        return []

    zim_files = sorted(inbox.glob("*.zim"))
    if not zim_files:
        logger.debug("[zim_collector] No ZIM files in collection folder: %s", inbox)
        return []

    logger.info("[zim_collector] Found %d ZIM file(s) in %s", len(zim_files), inbox)
    results: list[dict] = []

    for zim_path in zim_files:
        try:
            action = _classify_and_process(zim_path)
            results.append({
                "filename": action.filename,
                "source_id": action.source_id,
                "action": action.action,
                "detail": action.detail,
            })
        except Exception as exc:
            logger.error("[zim_collector] Error processing %s: %s", zim_path.name, exc)
            results.append({
                "filename": zim_path.name,
                "source_id": "unknown",
                "action": "error",
                "detail": str(exc),
            })

    # Trigger indexing for any new/updated sources
    sources_to_index = [
        r["source_id"] for r in results if r["action"] in ("new", "update")
    ]
    if sources_to_index:
        logger.info("[zim_collector] Queuing indexing for: %s", sources_to_index)
        await _trigger_indexing(sources_to_index)

    return results


def _classify_and_process(zim_path: Path) -> SweepAction:
    """
    Classify a single ZIM file and take the appropriate action.
    """
    filename = zim_path.name
    source_id = _match_source_id(filename)
    new_date = _extract_date(filename)
    dest_dir = _KNOWLEDGE_ROOT / source_id

    logger.info(
        "[zim_collector] Processing: %s → source_id=%s, date=%s",
        filename, source_id, new_date or "unknown",
    )

    if not dest_dir.exists():
        # ── NEW SOURCE ──
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest_file = dest_dir / filename
        shutil.move(str(zim_path), str(dest_file))
        logger.info("[zim_collector] NEW: %s → %s", filename, dest_dir)
        return SweepAction(
            filename=filename,
            source_id=source_id,
            action="new",
            detail=f"Moved to {dest_dir.name}/, queued for indexing",
        )

    # Folder exists — check for existing ZIM
    existing_zims = list(dest_dir.glob("*.zim"))

    if not existing_zims:
        # Folder exists but no ZIM (maybe only fts5.db from a previous run)
        dest_file = dest_dir / filename
        shutil.move(str(zim_path), str(dest_file))
        # Remove stale index
        old_db = dest_dir / "fts5.db"
        if old_db.exists():
            old_db.unlink()
            logger.info("[zim_collector] Removed stale fts5.db for %s", source_id)
        logger.info("[zim_collector] NEW (empty folder): %s → %s", filename, dest_dir)
        return SweepAction(
            filename=filename,
            source_id=source_id,
            action="new",
            detail=f"Moved to {dest_dir.name}/ (folder existed but was empty), queued for indexing",
        )

    # Compare dates
    existing_zim = existing_zims[0]
    existing_date = _extract_date(existing_zim.name)

    if new_date and existing_date and new_date > existing_date:
        # ── UPDATE — new file is newer ──
        # Delete old ZIM + old index
        existing_zim.unlink()
        old_db = dest_dir / "fts5.db"
        if old_db.exists():
            old_db.unlink()
        dest_file = dest_dir / filename
        shutil.move(str(zim_path), str(dest_file))
        logger.info(
            "[zim_collector] UPDATE: %s replaces %s (date %s → %s)",
            filename, existing_zim.name, existing_date, new_date,
        )
        return SweepAction(
            filename=filename,
            source_id=source_id,
            action="update",
            detail=f"Replaced {existing_zim.name} ({existing_date} → {new_date}), queued for re-indexing",
        )

    # ── DUPLICATE — same or older date ──
    zim_path.unlink()
    logger.info(
        "[zim_collector] DUPLICATE: deleted %s (existing: %s, date %s ≥ %s)",
        filename, existing_zim.name, existing_date, new_date,
    )
    return SweepAction(
        filename=filename,
        source_id=source_id,
        action="duplicate",
        detail=f"Deleted — {existing_zim.name} (date {existing_date}) already exists",
    )


# ─────────────────────────────────────────────────────────────────────────────
# INDEX TRIGGER
# ─────────────────────────────────────────────────────────────────────────────

async def _trigger_indexing(source_ids: list[str]) -> None:
    """
    Kick off FTS5 indexing for each source in a background task.
    Uses the same indexer as knowledge_downloader.
    """
    import asyncio

    for source_id in source_ids:
        source_dir = _KNOWLEDGE_ROOT / source_id
        zim_files = list(source_dir.glob("*.zim"))
        if not zim_files:
            continue

        zim_path = zim_files[0]
        db_path = source_dir / "fts5.db"

        logger.info("[zim_collector] Starting FTS5 indexing: %s", source_id)

        try:
            from app.controller.chat_controller import _emit
            await _emit("storage_update", {
                "source_id": source_id,
                "status": "indexing",
                "detail": f"Building FTS5 index from {zim_path.name}...",
            })
        except Exception:
            pass

        # Run indexer in thread pool
        try:
            import importlib.util
            spec = importlib.util.spec_from_file_location(
                "build_zim_index",
                str(Path(__file__).resolve().parent.parent.parent / "scripts" / "build_zim_index.py"),
            )
            zim_indexer = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(zim_indexer)

            loop = asyncio.get_running_loop()
            result = await loop.run_in_executor(
                None,
                lambda sid=source_id, zp=str(zim_path), dp=str(db_path): zim_indexer.index_zim(zp, dp),
            )

            if "error" in result:
                logger.error("[zim_collector] Indexing failed for %s: %s", source_id, result["error"])
                try:
                    await _emit("storage_update", {
                        "source_id": source_id,
                        "status": "error",
                        "error": result["error"],
                    })
                except Exception:
                    pass
                continue

            logger.info(
                "[zim_collector] Indexed %s: %d articles in %.0fs",
                source_id, result.get("indexed", 0), result.get("elapsed_s", 0),
            )

            # Register in LocalSearch
            try:
                from app.knowledge.local_search import SOURCE_CONFIG
                if source_id not in SOURCE_CONFIG:
                    SOURCE_CONFIG[source_id] = {
                        "db_file": f"{source_id}/fts5.db",
                        "table": "articles_fts",
                        "cols": ("title", "content"),
                        "limit": 5,
                    }
            except Exception:
                pass

            # Update download status
            try:
                from app.service.knowledge_downloader import get_knowledge_downloader
                dl = get_knowledge_downloader()
                if dl:
                    st = dl._statuses.get(source_id)
                    if st:
                        st.status = "ready"
                        st.progress_pct = 100.0
                        dl._save_status()
            except Exception:
                pass

            try:
                await _emit("knowledge_ingested", {
                    "source_id": source_id,
                    "status": "ready",
                    "indexed": result.get("indexed", 0),
                })
            except Exception:
                pass

        except Exception as exc:
            logger.exception("[zim_collector] Indexing crashed for %s: %s", source_id, exc)


# ─────────────────────────────────────────────────────────────────────────────
# STARTUP HOOK
# ─────────────────────────────────────────────────────────────────────────────

async def startup_sweep() -> None:
    """Called once at backend startup to check the collection folder."""
    try:
        results = await sweep_collection_folder()
        if results:
            actions = [f"{r['action']}: {r['filename']}" for r in results]
            logger.info("[zim_collector] Startup sweep results: %s", actions)
        else:
            logger.info("[zim_collector] Startup sweep: collection folder empty")
    except Exception as exc:
        logger.error("[zim_collector] Startup sweep failed: %s", exc)
