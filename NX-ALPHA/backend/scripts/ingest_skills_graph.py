"""
ingest_skills_graph.py
───────────────────────
Phase 3e — Ingest skills KB chunks into LightRAG for entity extraction.

Reads all .md chunk files from backend/app/knowledge/skills_kb/**/*.md
and feeds them into LightRAG's async ingest queue. Entities and relationships
land in Neo4j `lightrag_knowledge` database automatically.

Must be run AFTER Phase 4 completes (skills_kb/ directory must exist).

Skills directories expected:
  backend/app/knowledge/skills_kb/ai_ml/
  backend/app/knowledge/skills_kb/business/
  backend/app/knowledge/skills_kb/engineering/
  backend/app/knowledge/skills_kb/infra/

Run from project root:
    python backend/scripts/ingest_skills_graph.py
    python backend/scripts/ingest_skills_graph.py --domain ai_ml
    python backend/scripts/ingest_skills_graph.py --dry-run
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

# ── Add backend to sys.path ───────────────────────────────────────────────────
_REPO_ROOT  = Path(__file__).parent.parent.parent
_BACKEND    = _REPO_ROOT / "backend"
_SKILLS_DIR = _BACKEND / "app" / "knowledge" / "skills_kb"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

KNOWN_DOMAINS = ["ai_ml", "business", "engineering", "infra"]

# Yield to event loop every N enqueues
_YIELD_EVERY = 50


def _collect_chunks(domain: str | None) -> list[dict]:
    """
    Scan skills_kb directory and return list of {domain, file, text} dicts.
    """
    if not _SKILLS_DIR.exists():
        print(f"[error] Skills KB directory not found at {_SKILLS_DIR}")
        print("  Run Phase 4 (build_skills_index.py) first to create the skills KB.")
        sys.exit(1)

    domains = [domain] if domain else KNOWN_DOMAINS
    chunks = []

    for d in domains:
        domain_dir = _SKILLS_DIR / d
        if not domain_dir.exists():
            print(f"  [skip] Domain directory not found: {domain_dir}")
            continue
        md_files = sorted(domain_dir.glob("*.md"))
        for f in md_files:
            text = f.read_text(encoding="utf-8").strip()
            if text:
                chunks.append({
                    "domain": d,
                    "file":   str(f.relative_to(_BACKEND)),
                    "stem":   f.stem,
                    "text":   text,
                })

    return chunks


async def _ingest(chunks: list[dict], dry_run: bool) -> None:
    if dry_run:
        by_domain: dict[str, int] = {}
        for c in chunks:
            by_domain[c["domain"]] = by_domain.get(c["domain"], 0) + 1
        print(f"\n[dry-run] Would enqueue {len(chunks)} skill chunks into LightRAG:")
        for d, count in sorted(by_domain.items()):
            print(f"  {d}: {count} chunks")
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

    processed = 0
    skipped   = 0
    errors    = 0
    for i, chunk in enumerate(chunks):
        source_id = f"skill:{chunk['domain']}:{chunk['stem']}"
        result = await svc.ingest_document(chunk["text"], source_id=source_id, source_type="skill")
        if result.get("skipped"):
            skipped += 1
        elif result.get("success"):
            processed += 1
        else:
            errors += 1
        print(f"  [{i+1}/{len(chunks)}] {chunk['domain']}/{chunk['stem']} — {'ok' if result.get('success') else 'skip' if result.get('skipped') else 'err'}")

    print(f"\n[done] Skills graph ingestion complete")
    print(f"  Processed: {processed} | Skipped (dedup): {skipped} | Errors: {errors}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Ingest skills KB chunks into LightRAG")
    parser.add_argument(
        "--domain", default=None,
        choices=KNOWN_DOMAINS,
        help="Ingest a single domain only (default: all domains)",
    )
    parser.add_argument("--dry-run", action="store_true", help="Preview without writing")
    args = parser.parse_args()

    print(f"[ingest_skills_graph] Skills KB: {_SKILLS_DIR}")
    chunks = _collect_chunks(args.domain)
    print(f"[ingest_skills_graph] Found {len(chunks)} skill chunks across {len({c['domain'] for c in chunks})} domains")

    if not chunks:
        print("[warn] No chunks found — has Phase 4 been run?")
        sys.exit(1)

    asyncio.run(_ingest(chunks, args.dry_run))


if __name__ == "__main__":
    main()
