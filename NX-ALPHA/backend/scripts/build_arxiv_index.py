"""
AURA NX-Alpha — arXiv FTS5 Index Builder
Reads the Cornell arXiv metadata dataset and indexes papers into SQLite FTS5.

REQUIREMENTS:
    pip install datasets tqdm pyarrow

USAGE:
    # Stream directly from HuggingFace (no pre-download needed):
    python scripts/build_arxiv_index.py \\
        --db ~/.aura/knowledge/arxiv/fts5.db \\
        --limit 0

    # Or index from locally downloaded parquet files:
    python scripts/build_arxiv_index.py \\
        --input ~/.aura/knowledge/arxiv/raw/ \\
        --db ~/.aura/knowledge/arxiv/fts5.db

DATA:
    HuggingFace: Cornell-University/arxiv
    ~4GB download, 2.4M+ papers (metadata only — titles, abstracts, categories)

    To pre-download:
        hf download --repo-type dataset Cornell-University/arxiv \\
            --local-dir ~/.aura/knowledge/arxiv/raw/

OUTPUT:
    SQLite with:
        papers(rowid, arxiv_id, title, abstract, categories, authors, year)
        papers_fts (FTS5 virtual table over title + abstract + categories)
"""

import argparse
import logging
import sqlite3
import sys
from pathlib import Path

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")


DDL = """
CREATE TABLE IF NOT EXISTS papers (
    rowid      INTEGER PRIMARY KEY,
    arxiv_id   TEXT UNIQUE,
    title      TEXT NOT NULL,
    abstract   TEXT NOT NULL,
    categories TEXT,
    authors    TEXT,
    year       INTEGER
);

CREATE VIRTUAL TABLE IF NOT EXISTS papers_fts USING fts5(
    title,
    abstract,
    categories,
    content=papers,
    content_rowid=rowid,
    tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS papers_ai AFTER INSERT ON papers BEGIN
    INSERT INTO papers_fts(rowid, title, abstract, categories)
    VALUES (new.rowid, new.title, new.abstract, new.categories);
END;
"""


def _extract_year(update_date: str | None) -> int | None:
    if not update_date:
        return None
    try:
        return int(update_date[:4])
    except (ValueError, TypeError):
        return None


def _flatten_authors(authors_parsed: list | None, authors_str: str | None) -> str:
    if authors_parsed:
        try:
            names = []
            for a in authors_parsed[:10]:  # cap at 10
                if isinstance(a, list) and len(a) >= 2:
                    names.append(f"{a[1]} {a[0]}".strip())
            if names:
                return "; ".join(names)
        except Exception:
            pass
    return (authors_str or "")[:500]


def build_from_hf(db_path: Path, limit: int) -> None:
    try:
        from datasets import load_dataset
    except ImportError:
        logger.error("datasets not installed. Run: pip install datasets")
        sys.exit(1)

    logger.info("Streaming Cornell-University/arxiv from HuggingFace...")
    ds = load_dataset("Cornell-University/arxiv", split="train", streaming=True, trust_remote_code=True)
    _index(db_path, ds, limit)


def build_from_local(input_path: Path, db_path: Path, limit: int) -> None:
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

    _index(db_path, ds, limit)


def _index(db_path: Path, dataset, limit: int) -> None:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    conn.executescript(DDL)

    batch: list[tuple] = []
    BATCH_SIZE = 1000
    indexed = 0
    skipped = 0

    try:
        from tqdm import tqdm
        rows = tqdm(dataset, unit="paper")
    except ImportError:
        rows = dataset

    for row in rows:
        if limit > 0 and indexed >= limit:
            break

        arxiv_id = row.get("id") or row.get("arxiv_id") or ""
        title    = (row.get("title") or "").strip().replace("\n", " ")
        abstract = (row.get("abstract") or "").strip().replace("\n", " ")

        if not title or not abstract:
            skipped += 1
            continue

        categories = (row.get("categories") or "").strip()
        authors    = _flatten_authors(row.get("authors_parsed"), row.get("authors"))
        year       = _extract_year(row.get("update_date"))

        batch.append((arxiv_id, title, abstract[:10_000], categories, authors, year))
        indexed += 1

        if len(batch) >= BATCH_SIZE:
            conn.executemany(
                "INSERT OR IGNORE INTO papers(arxiv_id, title, abstract, categories, authors, year) "
                "VALUES (?,?,?,?,?,?)", batch
            )
            conn.commit()
            batch.clear()
            logger.info("Indexed %d papers (%d skipped)...", indexed, skipped)

    if batch:
        conn.executemany(
            "INSERT OR IGNORE INTO papers(arxiv_id, title, abstract, categories, authors, year) "
            "VALUES (?,?,?,?,?,?)", batch
        )
        conn.commit()

    conn.execute("INSERT INTO papers_fts(papers_fts) VALUES('optimize')")
    conn.commit()
    conn.close()

    logger.info("Done. Indexed %d papers, skipped %d. DB: %s", indexed, skipped, db_path)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Build arXiv FTS5 index")
    parser.add_argument("--input",  default=None, help="Path to local parquet/JSON files (omit to stream from HF)")
    parser.add_argument("--db",     default="~/.aura/knowledge/arxiv/fts5.db", help="Output SQLite DB path")
    parser.add_argument("--limit",  type=int, default=0, help="Max papers (0=all)")
    args = parser.parse_args()

    db = Path(args.db).expanduser()

    if args.input:
        build_from_local(Path(args.input).expanduser(), db, args.limit)
    else:
        build_from_hf(db, args.limit)
