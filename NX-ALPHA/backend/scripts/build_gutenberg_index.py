"""
AURA NX-Alpha — Project Gutenberg FTS5 Index Builder
Reads the Gutenberg dataset and indexes full texts into SQLite FTS5.

REQUIREMENTS:
    pip install datasets tqdm

USAGE:
    # Stream directly from HuggingFace (no pre-download needed):
    python scripts/build_gutenberg_index.py \\
        --db ~/.aura/knowledge/gutenberg/fts5.db \\
        --limit 0

    # Or index from locally downloaded parquet files:
    python scripts/build_gutenberg_index.py \\
        --input ~/.aura/knowledge/gutenberg/raw/ \\
        --db ~/.aura/knowledge/gutenberg/fts5.db

DATA:
    HuggingFace: manu/project_gutenberg
    ~23GB download, 70k+ public domain books (full text)

    To pre-download:
        hf download --repo-type dataset manu/project_gutenberg \\
            --local-dir ~/.aura/knowledge/gutenberg/raw/

OUTPUT:
    SQLite with:
        texts(rowid, gutenberg_id, title, author, subject, language, snippet)
        texts_fts (FTS5 virtual table over title + author + snippet)

NOTE:
    Full book texts can exceed 1MB each. The 'snippet' column stores the first
    50k characters for FTS indexing. The full text is not stored in SQLite to
    keep the index manageable (~8GB vs ~23GB raw).
    For full-text retrieval, read from the raw parquet files by gutenberg_id.
"""

import argparse
import logging
import sqlite3
import sys
from pathlib import Path

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")


DDL = """
CREATE TABLE IF NOT EXISTS texts (
    rowid        INTEGER PRIMARY KEY,
    gutenberg_id TEXT UNIQUE,
    title        TEXT NOT NULL,
    author       TEXT,
    subject      TEXT,
    language     TEXT,
    snippet      TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS texts_fts USING fts5(
    title,
    author,
    snippet,
    content=texts,
    content_rowid=rowid,
    tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS texts_ai AFTER INSERT ON texts BEGIN
    INSERT INTO texts_fts(rowid, title, author, snippet)
    VALUES (new.rowid, new.title, new.author, new.snippet);
END;
"""

SNIPPET_CHARS = 50_000  # First 50k chars indexed for FTS


def build_from_hf(db_path: Path, limit: int, language: str) -> None:
    try:
        from datasets import load_dataset
    except ImportError:
        logger.error("datasets not installed. Run: pip install datasets")
        sys.exit(1)

    logger.info("Streaming manu/project_gutenberg from HuggingFace...")
    ds = load_dataset("manu/project_gutenberg", split="train", streaming=True, trust_remote_code=True)
    _index(db_path, ds, limit, language)


def build_from_local(input_path: Path, db_path: Path, limit: int, language: str) -> None:
    try:
        from datasets import load_dataset
    except ImportError:
        logger.error("datasets not installed. Run: pip install datasets")
        sys.exit(1)

    parquet_files = list(input_path.glob("**/*.parquet"))
    json_files = list(input_path.glob("**/*.json")) + list(input_path.glob("**/*.jsonl"))

    if parquet_files:
        logger.info("Loading %d parquet file(s) from %s", len(parquet_files), input_path)
        ds = load_dataset("parquet", data_files=[str(f) for f in parquet_files], split="train", streaming=True)
    elif json_files:
        logger.info("Loading %d JSON file(s) from %s", len(json_files), input_path)
        ds = load_dataset("json", data_files=[str(f) for f in json_files], split="train", streaming=True)
    else:
        logger.error("No parquet or JSON files found at: %s", input_path)
        sys.exit(1)

    _index(db_path, ds, limit, language)


def _index(db_path: Path, dataset, limit: int, language: str) -> None:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    conn.executescript(DDL)

    batch: list[tuple] = []
    BATCH_SIZE = 200  # smaller — texts are large
    indexed = 0
    skipped = 0

    try:
        from tqdm import tqdm
        rows = tqdm(dataset, unit="book")
    except ImportError:
        rows = dataset

    for row in rows:
        if limit > 0 and indexed >= limit:
            break

        # Field names vary slightly across dataset versions — handle both
        gutenberg_id = str(row.get("id") or row.get("gutenberg_id") or "")
        title        = (row.get("title") or "").strip()
        author       = (row.get("author") or row.get("authors") or "").strip()
        subject      = (row.get("subject") or row.get("subjects") or "").strip()
        lang         = (row.get("language") or row.get("languages") or "en").strip()
        text         = (row.get("text") or row.get("content") or "").strip()

        if not title or not text:
            skipped += 1
            continue

        # Language filter
        if language and lang and language.lower() not in lang.lower():
            skipped += 1
            continue

        # Handle list fields
        if isinstance(author, list):
            author = "; ".join(author)
        if isinstance(subject, list):
            subject = "; ".join(subject)
        if isinstance(lang, list):
            lang = ", ".join(lang)

        snippet = text[:SNIPPET_CHARS]

        batch.append((gutenberg_id, title, author[:500], subject[:500], lang[:50], snippet))
        indexed += 1

        if len(batch) >= BATCH_SIZE:
            conn.executemany(
                "INSERT OR IGNORE INTO texts(gutenberg_id, title, author, subject, language, snippet) "
                "VALUES (?,?,?,?,?,?)", batch
            )
            conn.commit()
            batch.clear()
            logger.info("Indexed %d texts (%d skipped)...", indexed, skipped)

    if batch:
        conn.executemany(
            "INSERT OR IGNORE INTO texts(gutenberg_id, title, author, subject, language, snippet) "
            "VALUES (?,?,?,?,?,?)", batch
        )
        conn.commit()

    conn.execute("INSERT INTO texts_fts(texts_fts) VALUES('optimize')")
    conn.commit()
    conn.close()

    logger.info("Done. Indexed %d texts, skipped %d. DB: %s", indexed, skipped, db_path)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Build Project Gutenberg FTS5 index")
    parser.add_argument("--input",    default=None,   help="Path to local parquet/JSON files (omit to stream from HF)")
    parser.add_argument("--db",       default="~/.aura/knowledge/gutenberg/fts5.db", help="Output SQLite DB path")
    parser.add_argument("--limit",    type=int, default=0, help="Max texts (0=all)")
    parser.add_argument("--language", default="en",   help="Filter by language code (default: en, empty=all)")
    args = parser.parse_args()

    db = Path(args.db).expanduser()

    if args.input:
        build_from_local(Path(args.input).expanduser(), db, args.limit, args.language)
    else:
        build_from_hf(db, args.limit, args.language)
