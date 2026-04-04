"""
ingest_knowledge_graph.py
──────────────────────────
Phase 3c — Populate Neo4j `aura_memory` with knowledge source entity pointers.

Strategy:
  For each FTS5 knowledge DB (wikipedia, pubmed, arxiv, stackexchange, gutenberg):
  - Sample top N titles from the FTS5 index
  - Feed representative topic chunks into LightRAG → entity extraction → Neo4j
  - Create (:KnowledgeSource)-[:HAS_CONCEPT]->(:Concept) pointers in Neo4j
  - Full article text stays in FTS5 — Neo4j stores only entity summaries + source_db pointer

This gives graph traversal capability WITHOUT reindexing the full 760GB dataset.
Only representative titles/summaries are processed (selective ingestion).

Run from project root:
    python backend/scripts/ingest_knowledge_graph.py
    python backend/scripts/ingest_knowledge_graph.py --source wikipedia --limit 500
    python backend/scripts/ingest_knowledge_graph.py --source all --limit 1000
    python backend/scripts/ingest_knowledge_graph.py --dry-run
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

# ── Add backend to sys.path ───────────────────────────────────────────────────
_REPO_ROOT = Path(__file__).parent.parent.parent
_BACKEND   = _REPO_ROOT / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

# ── Config ────────────────────────────────────────────────────────────────────
NEO4J_URI      = "bolt://localhost:7687"
NEO4J_USER     = "neo4j"
NEO4J_PASSWORD = "aurapassword"
NEO4J_DATABASE = "neo4j"
KNOWLEDGE_BASE = Path.home() / ".aura" / "knowledge"

# Per-source sampling config
# title_col = column to read as title/label; snippet_col = short text for LightRAG
SOURCE_META: dict[str, dict] = {
    "wikipedia": {
        "db_file":    "wikipedia/fts5.db",
        "table":      "articles_fts",
        "title_col":  "title",
        "text_col":   "content",
        "text_limit": 800,        # chars of content to feed LightRAG per entry
    },
    "pubmed": {
        "db_file":    "pubmed/fts5.db",
        "table":      "abstracts_fts",
        "title_col":  "title",
        "text_col":   "abstract",
        "text_limit": 600,
    },
    "arxiv": {
        "db_file":    "arxiv/fts5.db",
        "table":      "papers_fts",
        "title_col":  "title",
        "text_col":   "abstract",
        "text_limit": 600,
    },
    "stackexchange": {
        "db_file":    "stackexchange/fts5.db",
        "table":      "posts_fts",
        "title_col":  "title",
        "text_col":   "body",
        "text_limit": 500,
    },
    "gutenberg": {
        "db_file":    "gutenberg/fts5.db",
        "table":      "texts_fts",
        "title_col":  "title",
        "text_col":   "snippet",
        "text_limit": 400,
    },
}

# Default samples per source when --limit is provided as total
_DEFAULT_PER_SOURCE = 200


def _sample_titles(source: str, meta: dict, limit: int) -> list[dict]:
    """
    Sample top N rows from the FTS5 table.
    Returns list of {title, text} dicts.
    Skips source gracefully if DB not found.
    """
    import sqlite3
    db_path = KNOWLEDGE_BASE / meta["db_file"]
    if not db_path.exists():
        print(f"  [skip] {source}: DB not found at {db_path}")
        return []

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    title_col = meta["title_col"]
    text_col  = meta["text_col"]
    text_limit = meta["text_limit"]
    table      = meta["table"]

    try:
        rows = conn.execute(
            f"SELECT {title_col}, {text_col} FROM {table} LIMIT ?", (limit,)
        ).fetchall()
    except Exception as exc:
        print(f"  [skip] {source}: query failed — {exc}")
        conn.close()
        return []

    conn.close()
    results = []
    for row in rows:
        title = (row[title_col] or "").strip()
        text  = (row[text_col]  or "").strip()[:text_limit]
        if title:
            results.append({"title": title, "text": text or title})
    return results


async def _ingest_to_lightrag_and_neo4j(
    source: str, items: list[dict], dry_run: bool
) -> None:
    """
    For each sampled item:
    1. Feed to LightRAG (async queue) for entity extraction → Neo4j lightrag_knowledge
    2. Create (:KnowledgeSource)-[:HAS_CONCEPT]->(:Concept) pointer in aura_memory
    """
    if dry_run:
        print(f"  [dry-run] {source}: would ingest {len(items)} items into LightRAG")
        print(f"  [dry-run] {source}: would create {len(items)} (:KnowledgeSource)-[:HAS_CONCEPT] edges")
        return

    # ── LightRAG batch ingest ─────────────────────────────────────────────────
    try:
        from app.service.lightrag_service import LightRAGService
        svc = LightRAGService.get_instance()
        if not svc._available:
            print(f"  [warn] {source}: LightRAG not available — skipping entity extraction")
        else:
            enqueued = 0
            for item in items:
                source_id = f"knowledge:{source}:{item['title'][:80]}"
                if svc.enqueue_ingest(item["text"], source_id=source_id, source_type="knowledge"):
                    enqueued += 1
            print(f"  [lightrag] {source}: enqueued {enqueued}/{len(items)} items")
    except Exception as exc:
        print(f"  [warn] {source}: LightRAG enqueue failed — {exc}")

    # ── Neo4j source pointers ─────────────────────────────────────────────────
    try:
        from neo4j import GraphDatabase
        driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
        with driver.session(database=NEO4J_DATABASE) as session:
            # Ensure KnowledgeSource node
            session.run(
                "MERGE (:KnowledgeSource {name: $name, source_db: $source})",
                name=source, source=source,
            )
            # Batch upsert Concept nodes + edges
            concept_rows = [{"source": source, "title": item["title"]} for item in items]
            for i in range(0, len(concept_rows), 500):
                chunk = concept_rows[i:i+500]
                session.run(
                    """
                    UNWIND $rows AS row
                    MERGE (c:Concept {name: row.title})
                    SET c.source_db = row.source
                    WITH c, row
                    MATCH (ks:KnowledgeSource {name: row.source})
                    MERGE (ks)-[:HAS_CONCEPT]->(c)
                    """,
                    rows=chunk,
                )
        driver.close()
        print(f"  [neo4j] {source}: {len(items)} Concept nodes + HAS_CONCEPT edges")
    except Exception as exc:
        print(f"  [warn] {source}: Neo4j write failed — {exc}")


async def _run(sources: list[str], per_source_limit: int, dry_run: bool) -> None:
    """Main async runner."""
    # Initialize LightRAG service if available
    if not dry_run:
        try:
            from app.service.lightrag_service import LightRAGService
            svc = LightRAGService.get_instance()
            await svc.initialize()
        except Exception as exc:
            print(f"[warn] LightRAG init failed (continuing without entity extraction): {exc}")

    for source in sources:
        meta = SOURCE_META.get(source)
        if not meta:
            print(f"[warn] Unknown source: {source}")
            continue

        print(f"\n[{source}] Sampling up to {per_source_limit} entries...")
        items = _sample_titles(source, meta, per_source_limit)
        if not items:
            continue
        print(f"[{source}] Got {len(items)} items")

        await _ingest_to_lightrag_and_neo4j(source, items, dry_run)

    print("\n[done] Knowledge graph ingestion complete")


def main() -> None:
    parser = argparse.ArgumentParser(description="Ingest knowledge source entity pointers into Neo4j graph")
    parser.add_argument(
        "--source", default="all",
        choices=["all"] + list(SOURCE_META.keys()),
        help="Which knowledge source to ingest (default: all)",
    )
    parser.add_argument("--limit", type=int, default=_DEFAULT_PER_SOURCE,
                        help=f"Max entries per source (default: {_DEFAULT_PER_SOURCE})")
    parser.add_argument("--dry-run", action="store_true", help="Preview without writing")
    args = parser.parse_args()

    sources = list(SOURCE_META.keys()) if args.source == "all" else [args.source]

    print(f"[ingest_knowledge_graph] Sources: {', '.join(sources)}")
    print(f"[ingest_knowledge_graph] Per-source limit: {args.limit}")
    print(f"[ingest_knowledge_graph] Knowledge base: {KNOWLEDGE_BASE}")

    asyncio.run(_run(sources, args.limit, args.dry_run))


if __name__ == "__main__":
    main()
