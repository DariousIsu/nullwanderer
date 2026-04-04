"""
build_skills_index.py
──────────────────────
Phase 4 — Build FTS5 index from skills KB .md chunk files.

Reads all .md files from backend/app/knowledge/skills_kb/**/*.md and writes
them into a SQLite FTS5 database at ~/.aura/knowledge/skills/fts5.db

Schema:
    skills_fts (title TEXT, content TEXT, domain TEXT UNINDEXED, file TEXT UNINDEXED)

The `title` is derived from the file stem (e.g., rag_chroma_setup → "rag chroma setup").
The `content` is the full file text.
The `domain` is the parent directory name (ai_ml, business, engineering, infra).

Run from project root:
    python backend/scripts/build_skills_index.py
    python backend/scripts/build_skills_index.py --domain ai_ml  # single domain
    python backend/scripts/build_skills_index.py --output ~/.aura/knowledge/skills/fts5.db
"""

from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path

_BACKEND    = Path(__file__).parent.parent
_SKILLS_DIR = _BACKEND / "app" / "knowledge" / "skills_kb"
_DEFAULT_DB = Path.home() / ".aura" / "knowledge" / "skills" / "fts5.db"

KNOWN_DOMAINS = ["ai_ml", "business", "engineering", "infra"]


def _collect_chunks(domain: str | None) -> list[dict]:
    if not _SKILLS_DIR.exists():
        print(f"[error] Skills KB not found at {_SKILLS_DIR}")
        print("  Run Phase 4 to create the skills KB files first.")
        sys.exit(1)

    domains = [domain] if domain else KNOWN_DOMAINS
    chunks = []
    for d in domains:
        domain_dir = _SKILLS_DIR / d
        if not domain_dir.exists():
            print(f"  [skip] {d}: directory not found")
            continue
        for f in sorted(domain_dir.glob("*.md")):
            text = f.read_text(encoding="utf-8").strip()
            if not text:
                continue
            # Convert filename to readable title: rag_chroma_setup → rag chroma setup
            title = f.stem.replace("_", " ")
            chunks.append({
                "title":   title,
                "content": text,
                "domain":  d,
                "file":    str(f.relative_to(_BACKEND)),
            })
    return chunks


def _build_db(chunks: list[dict], db_path: Path) -> int:
    db_path.parent.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(str(db_path))
    conn.executescript("""
        DROP TABLE IF EXISTS skills_fts;
        CREATE VIRTUAL TABLE skills_fts USING fts5(
            title,
            content,
            domain     UNINDEXED,
            file       UNINDEXED,
            tokenize='porter unicode61'
        );
    """)

    conn.executemany(
        "INSERT INTO skills_fts(title, content, domain, file) VALUES (?, ?, ?, ?)",
        [(c["title"], c["content"], c["domain"], c["file"]) for c in chunks],
    )
    conn.commit()
    conn.close()
    return len(chunks)


def main() -> None:
    parser = argparse.ArgumentParser(description="Build FTS5 index from skills KB .md files")
    parser.add_argument("--domain", default=None, choices=KNOWN_DOMAINS,
                        help="Build index for a single domain only")
    parser.add_argument("--output", default=str(_DEFAULT_DB),
                        help=f"Output SQLite path (default: {_DEFAULT_DB})")
    args = parser.parse_args()

    db_path = Path(args.output).expanduser()

    print(f"[build_skills_index] Source: {_SKILLS_DIR}")
    chunks = _collect_chunks(args.domain)
    print(f"[build_skills_index] Found {len(chunks)} chunks")

    if not chunks:
        print("[warn] No chunks found — check skills_kb/ directory")
        sys.exit(1)

    count = _build_db(chunks, db_path)
    print(f"[build_skills_index] Done — {count} rows → {db_path}")

    # Spot-check
    conn = sqlite3.connect(str(db_path))
    sample = conn.execute(
        "SELECT title, domain FROM skills_fts ORDER BY rowid LIMIT 3"
    ).fetchall()
    conn.close()
    print("[build_skills_index] Sample rows:")
    for row in sample:
        print(f"  {row[1]} | {row[0]}")


if __name__ == "__main__":
    main()
