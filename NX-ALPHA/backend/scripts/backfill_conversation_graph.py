"""
backfill_conversation_graph.py
────────────────────────────────
Phase 3d — Backfill historical L1 conversation content into LightRAG.

Reads from AURA's L1 SQLite memory DB (~/.aura/memory.db):
  - memory_fts: all conversation memory fragments (doc_id, content, thread_id, timestamp)
  - sliding_window: recent conversation turns (thread_id, role, content)

Feeds each fragment into LightRAG's async ingest queue for entity extraction.
Entities land in Neo4j `lightrag_knowledge` database automatically.

Deduplication: LightRAG uses doc_id/source_id SHA256 hashing — re-running is safe.

Run from project root:
    python backend/scripts/backfill_conversation_graph.py
    python backend/scripts/backfill_conversation_graph.py --limit 2000   # recent N records
    python backend/scripts/backfill_conversation_graph.py --dry-run
    python backend/scripts/backfill_conversation_graph.py --source fts    # only memory_fts
    python backend/scripts/backfill_conversation_graph.py --source window # only sliding_window
"""

from __future__ import annotations

import argparse
import asyncio
import sqlite3
import sys
from pathlib import Path

# ── Add backend to sys.path ───────────────────────────────────────────────────
_REPO_ROOT = Path(__file__).parent.parent.parent
_BACKEND   = _REPO_ROOT / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

# ── Config ────────────────────────────────────────────────────────────────────
MEMORY_DB = Path.home() / ".aura" / "memory.db"

# Drain interval — yield to event loop every N enqueues to avoid blocking
_YIELD_EVERY = 100


def _load_fts_records(conn: sqlite3.Connection, limit: int | None) -> list[dict]:
    """Read memory_fts content — most semantic-rich records."""
    conn.row_factory = sqlite3.Row
    limit_clause = f"LIMIT {limit}" if limit else ""
    try:
        rows = conn.execute(
            f"""
            SELECT doc_id, content, thread_id, timestamp
            FROM memory_fts
            ORDER BY timestamp DESC
            {limit_clause}
            """
        ).fetchall()
    except Exception as exc:
        print(f"  [skip] memory_fts query failed: {exc}")
        return []
    return [dict(r) for r in rows]


def _load_window_records(conn: sqlite3.Connection, limit: int | None) -> list[dict]:
    """Read sliding_window turns — recent short-form conversation context."""
    conn.row_factory = sqlite3.Row
    limit_clause = f"LIMIT {limit}" if limit else ""
    try:
        rows = conn.execute(
            f"""
            SELECT id, thread_id, role, content, timestamp
            FROM sliding_window
            WHERE length(content) > 80
            ORDER BY timestamp DESC
            {limit_clause}
            """
        ).fetchall()
    except Exception as exc:
        print(f"  [skip] sliding_window query failed: {exc}")
        return []
    return [dict(r) for r in rows]


async def _enqueue_all(
    fts_records: list[dict],
    window_records: list[dict],
    dry_run: bool,
) -> None:
    if dry_run:
        print(f"\n[dry-run] Would enqueue into LightRAG:")
        print(f"  memory_fts records:      {len(fts_records)}")
        print(f"  sliding_window records:  {len(window_records)}")
        return

    # ── Init LightRAG ─────────────────────────────────────────────────────────
    try:
        from app.service.lightrag_service import LightRAGService
        svc = LightRAGService.get_instance()
        await svc.initialize()
    except Exception as exc:
        print(f"[error] LightRAG init failed: {exc}")
        sys.exit(1)

    if not svc._available:
        print("[error] LightRAG not available (check Ollama is running with qwen3:8b + nomic-embed-text)")
        sys.exit(1)

    all_records = []
    for i, rec in enumerate(fts_records):
        doc_id  = rec.get("doc_id", f"fts_{i}")
        content = (rec.get("content") or "").strip()
        if content and len(content) >= 30:
            all_records.append(("mem_fts", f"mem_fts:{doc_id}", content))

    for i, rec in enumerate(window_records):
        row_id    = rec.get("id", f"sw_{i}")
        thread_id = rec.get("thread_id", "unknown")
        content   = (rec.get("content") or "").strip()
        if content and len(content) >= 80:
            all_records.append(("mem_sw", f"mem_sw:{thread_id}:{row_id}", content))

    print(f"  [lightrag] {len(all_records)} records to process (awaiting each — this will take a while)")

    processed = 0
    skipped   = 0
    errors    = 0
    for i, (src_type, source_id, content) in enumerate(all_records):
        result = await svc.ingest_document(content, source_id=source_id, source_type="conversation")
        if result.get("skipped"):
            skipped += 1
        elif result.get("success"):
            processed += 1
        else:
            errors += 1
        if (i + 1) % 25 == 0:
            print(f"  [{i+1}/{len(all_records)}] processed={processed} skipped={skipped} errors={errors}")

    print(f"\n[done] Conversation backfill complete")
    print(f"  Processed: {processed} | Skipped (dedup): {skipped} | Errors: {errors}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Backfill historical conversation memory into LightRAG")
    parser.add_argument("--dry-run", action="store_true", help="Preview without writing")
    parser.add_argument("--limit",   type=int, default=None, help="Max records per source (default: all)")
    parser.add_argument(
        "--source", default="both",
        choices=["both", "fts", "window"],
        help="Which L1 table to backfill (default: both)",
    )
    args = parser.parse_args()

    if not MEMORY_DB.exists():
        print(f"[error] Memory DB not found at {MEMORY_DB}")
        print("  AURA must have been run at least once to create the memory database.")
        sys.exit(1)

    print(f"[backfill_conversation_graph] Reading from {MEMORY_DB}")
    conn = sqlite3.connect(str(MEMORY_DB))

    fts_records    = []
    window_records = []

    if args.source in ("both", "fts"):
        fts_records = _load_fts_records(conn, args.limit)
        print(f"  memory_fts records loaded:     {len(fts_records)}")

    if args.source in ("both", "window"):
        window_records = _load_window_records(conn, args.limit)
        print(f"  sliding_window records loaded: {len(window_records)}")

    conn.close()

    asyncio.run(_enqueue_all(fts_records, window_records, args.dry_run))


if __name__ == "__main__":
    main()
