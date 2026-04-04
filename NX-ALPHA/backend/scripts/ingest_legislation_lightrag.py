"""
ingest_legislation_lightrag.py
───────────────────────────────
Feed bill abstracts through LightRAG for concept entity extraction → Neo4j.

Bridges the keyword gap in FTS5 bill search: after this runs, queries like
"school funding" will find bills about "per-pupil allocation" and "Title I"
via semantic concept entity traversal, not just string matching.

Strategy:
  - Reads bills with non-empty abstracts from ~/.aura/legislation.db
  - Feeds each abstract through LightRAG → entity extraction → Neo4j
  - Tracks progress in ~/.aura/lightrag_leg_progress.json (resumable)
  - Default: current year only (manageable overnight run)
  - Use --all-years for full historical corpus (multi-day run)

Requires: Ollama running with qwen3:8b + nomic-embed-text loaded

Run from project root:
    python backend/scripts/ingest_legislation_lightrag.py
    python backend/scripts/ingest_legislation_lightrag.py --state FL
    python backend/scripts/ingest_legislation_lightrag.py --state FL --year 2026
    python backend/scripts/ingest_legislation_lightrag.py --year 2026
    python backend/scripts/ingest_legislation_lightrag.py --all-years --limit 5000
    python backend/scripts/ingest_legislation_lightrag.py --dry-run
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sqlite3
import sys
import time
from datetime import datetime
from pathlib import Path

# ── Add backend to sys.path ───────────────────────────────────────────────────
_REPO_ROOT = Path(__file__).parent.parent.parent
_BACKEND   = _REPO_ROOT / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

# ── Config ────────────────────────────────────────────────────────────────────
LEGISLATION_DB  = Path.home() / ".aura" / "legislation.db"
PROGRESS_FILE   = Path.home() / ".aura" / "lightrag_leg_progress.json"

# Max concurrent LightRAG ingest calls — Ollama handles 1 at a time anyway
_CONCURRENCY = 2

# Text template fed to LightRAG per bill — keeps context focused
_BILL_TEMPLATE = (
    "Legislative bill: {identifier} ({state}, {chamber})\n"
    "Title: {title}\n"
    "Status: {status}\n"
    "Subjects: {subjects}\n"
    "Abstract: {abstract}"
)


def _load_progress() -> set[str]:
    """Load set of already-processed bill IDs."""
    if PROGRESS_FILE.exists():
        try:
            with open(PROGRESS_FILE, encoding="utf-8") as f:
                return set(json.load(f))
        except Exception:
            pass
    return set()


def _save_progress(done_ids: set[str]) -> None:
    """Persist processed bill IDs to disk."""
    PROGRESS_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(PROGRESS_FILE, "w", encoding="utf-8") as f:
        json.dump(list(done_ids), f)


def _load_bills(
    state: str | None,
    year: int | None,
    all_years: bool,
    limit: int | None,
) -> list[dict]:
    """
    Load bills with non-empty abstracts from SQLite.
    Orders by last_action_date DESC — most recent bills first.
    """
    if not LEGISLATION_DB.exists():
        print(f"[error] Legislation DB not found at {LEGISLATION_DB}")
        print("  Run the legislation downloader first.")
        sys.exit(1)

    conn = sqlite3.connect(str(LEGISLATION_DB))
    conn.row_factory = sqlite3.Row

    clauses: list[str] = [
        "abstract IS NOT NULL",
        "TRIM(abstract) != ''",
        "LENGTH(abstract) > 50",  # skip trivial one-liners
    ]
    params: list = []

    if state:
        clauses.append("state_code = ?")
        params.append(state.upper())

    if not all_years:
        target_year = year or datetime.now().year
        clauses.append("last_action_date LIKE ?")
        params.append(f"{target_year}%")
    elif year:
        clauses.append("last_action_date LIKE ?")
        params.append(f"{year}%")

    where = "WHERE " + " AND ".join(clauses)
    limit_clause = f"LIMIT {limit}" if limit else ""

    try:
        rows = conn.execute(
            f"""SELECT id, state_code, identifier, title, chamber,
                       status, subjects, abstract, last_action_date
                FROM bills
                {where}
                ORDER BY last_action_date DESC
                {limit_clause}""",
            params,
        ).fetchall()
    except Exception as exc:
        print(f"[error] Query failed: {exc}")
        conn.close()
        sys.exit(1)

    conn.close()
    return [dict(r) for r in rows]


def _format_bill_text(bill: dict) -> str:
    """Format bill fields into a text chunk for LightRAG."""
    subjects = ""
    try:
        subj_list = json.loads(bill.get("subjects") or "[]")
        if isinstance(subj_list, list):
            subjects = ", ".join(str(s) for s in subj_list[:10])
    except (json.JSONDecodeError, TypeError):
        pass

    return _BILL_TEMPLATE.format(
        identifier = bill.get("identifier") or "",
        state      = bill.get("state_code") or "",
        chamber    = bill.get("chamber") or "",
        title      = bill.get("title") or "",
        status     = bill.get("status") or "",
        subjects   = subjects or "N/A",
        abstract   = (bill.get("abstract") or "")[:800],
    )


async def _run(
    bills: list[dict],
    dry_run: bool,
    resume: bool,
) -> None:
    """Main async runner."""
    # ── LightRAG init ─────────────────────────────────────────────────────────
    from app.service.lightrag_service import LightRAGService
    svc = LightRAGService.get_instance()
    await svc.initialize()

    if not svc._available:
        print("[error] LightRAG not available — check Ollama is running:")
        print("  ollama pull qwen3:8b")
        print("  ollama pull nomic-embed-text")
        sys.exit(1)

    # ── Progress tracking ─────────────────────────────────────────────────────
    done_ids = _load_progress() if resume else set()
    pending  = [b for b in bills if b["id"] not in done_ids]

    print(f"  Total bills with abstracts: {len(bills):,}")
    print(f"  Already processed:          {len(done_ids):,}")
    print(f"  To process this run:        {len(pending):,}")

    if dry_run:
        print("\n[dry-run] Would ingest:")
        for bill in pending[:5]:
            print(f"  {bill['state_code']} | {bill['identifier']} | {bill['title'][:60]}")
        if len(pending) > 5:
            print(f"  ... and {len(pending)-5} more")
        return

    if not pending:
        print("\n[done] Nothing new to process.")
        return

    # ── Concurrent ingest ─────────────────────────────────────────────────────
    sem        = asyncio.Semaphore(_CONCURRENCY)
    processed  = 0
    skipped    = 0
    errors     = 0
    start_time = time.time()

    async def _ingest_one(bill: dict) -> None:
        nonlocal processed, skipped, errors
        async with sem:
            source_id = f"legislation:{bill['state_code']}:{bill['id']}"
            text      = _format_bill_text(bill)
            result    = await svc.ingest_document(text, source_id=source_id, source_type="legislation")

            if result.get("skipped"):
                skipped += 1
            elif result.get("success"):
                processed += 1
                done_ids.add(bill["id"])
            else:
                errors += 1
                print(f"  [warn] {bill['id']}: {result.get('error','unknown error')}")

            total_done = processed + skipped + errors
            if total_done % 50 == 0:
                elapsed   = time.time() - start_time
                rate      = total_done / elapsed if elapsed > 0 else 0
                remaining = (len(pending) - total_done) / rate if rate > 0 else 0
                print(
                    f"  [{total_done}/{len(pending)}] "
                    f"processed={processed} skipped={skipped} errors={errors} "
                    f"rate={rate:.1f}/s eta={remaining/60:.0f}m"
                )
                _save_progress(done_ids)

    # Run all tasks, save progress on interrupt
    tasks = [asyncio.create_task(_ingest_one(b)) for b in pending]
    try:
        await asyncio.gather(*tasks)
    except (KeyboardInterrupt, asyncio.CancelledError):
        print("\n[interrupted] Saving progress...")
    finally:
        _save_progress(done_ids)

    elapsed = time.time() - start_time
    print(f"\n[done] Legislation LightRAG ingest complete")
    print(f"  Processed: {processed:,} | Skipped (dedup): {skipped:,} | Errors: {errors:,}")
    print(f"  Time: {elapsed/60:.1f} min | Rate: {(processed+skipped)/elapsed:.1f} bills/s")
    print(f"  Progress saved to {PROGRESS_FILE}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Feed bill abstracts through LightRAG for concept entity extraction"
    )
    parser.add_argument("--state",      default=None,  help="Filter to one state (e.g. FL, CA)")
    parser.add_argument("--year",       type=int, default=None,
                        help="Filter to a specific year (default: current year)")
    parser.add_argument("--all-years",  action="store_true",
                        help="Process all years — long-running, use with --limit first")
    parser.add_argument("--limit",      type=int, default=None,
                        help="Max bills to process (default: all matching)")
    parser.add_argument("--no-resume",  action="store_true",
                        help="Ignore previous progress, reprocess everything")
    parser.add_argument("--dry-run",    action="store_true",
                        help="Preview without writing")
    args = parser.parse_args()

    # Determine effective year label for display
    if args.all_years:
        year_label = "all years"
    else:
        year_label = str(args.year or datetime.now().year)

    print(f"[ingest_legislation_lightrag] State:  {args.state or 'all'}")
    print(f"[ingest_legislation_lightrag] Year:   {year_label}")
    print(f"[ingest_legislation_lightrag] Limit:  {args.limit or 'none'}")
    print(f"[ingest_legislation_lightrag] Resume: {not args.no_resume}")

    bills = _load_bills(
        state     = args.state,
        year      = args.year,
        all_years = args.all_years,
        limit     = args.limit,
    )
    print(f"[ingest_legislation_lightrag] Loaded {len(bills):,} bills with abstracts")

    if not bills:
        print("[warn] No bills found matching filters. Check --state / --year values.")
        sys.exit(0)

    asyncio.run(_run(bills, dry_run=args.dry_run, resume=not args.no_resume))


if __name__ == "__main__":
    main()
