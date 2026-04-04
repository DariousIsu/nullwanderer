"""
AURA NX-Alpha — Generic FTS5 Indexer
Indexes arbitrary columnar/text datasets into SQLite FTS5.

Used by:
    curator_service.py   — called after full dataset download
    build_generic_index.py (CLI script) — standalone invocation

SUPPORTED FORMATS:
    .parquet            — via pyarrow
    .jsonl / .ndjson    — newline-delimited JSON
    .json               — JSON array or object
    .csv                — comma-separated values
    .txt                — plain text, split by double-newline

OUTPUT SCHEMA:
    documents (rowid INTEGER PRIMARY KEY, <text_col_1> TEXT, ...)
    documents_fts (FTS5 virtual table, porter unicode61 tokenizer)

If text_cols is not specified, columns are auto-detected:
    Any column where >80% of sample values are strings with avg length >10 chars.
"""

from __future__ import annotations

import csv
import json
import logging
import sqlite3
from pathlib import Path
from typing import Iterator, List, Optional

logger = logging.getLogger(__name__)

_BATCH_SIZE = 500
_MAX_FIELD_CHARS = 20_000


# ─────────────────────────────────────────────────────────────────────────────
# COLUMN DETECTION
# ─────────────────────────────────────────────────────────────────────────────

def detect_text_columns(sample: List[dict]) -> List[str]:
    """
    Return column names that contain meaningful searchable text.
    A column qualifies when ≥80% of sample values are strings with avg length >10.
    """
    if not sample:
        return []
    cols = list(sample[0].keys())
    text_cols = []
    for col in cols:
        vals = [row.get(col) for row in sample[:20]]
        str_vals = [v for v in vals if isinstance(v, str)]
        if not str_vals:
            continue
        ratio = len(str_vals) / len(vals)
        avg_len = sum(len(v) for v in str_vals) / len(str_vals)
        if ratio >= 0.8 and avg_len > 10:
            text_cols.append(col)
    return text_cols


# ─────────────────────────────────────────────────────────────────────────────
# FORMAT LOADERS  (return iterators to keep memory low)
# ─────────────────────────────────────────────────────────────────────────────

def _iter_parquet(paths: List[Path]) -> Iterator[dict]:
    try:
        import pyarrow.parquet as pq
    except ImportError as exc:
        raise RuntimeError("pyarrow required for parquet: pip install pyarrow") from exc
    for p in paths:
        table = pq.read_table(str(p))
        for row in table.to_pylist():
            yield row


def _iter_jsonl(paths: List[Path]) -> Iterator[dict]:
    for p in paths:
        with p.open(encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if line:
                    try:
                        yield json.loads(line)
                    except json.JSONDecodeError:
                        continue


def _iter_csv(paths: List[Path]) -> Iterator[dict]:
    for p in paths:
        with p.open(encoding="utf-8", errors="replace", newline="") as fh:
            reader = csv.DictReader(fh)
            for row in reader:
                yield dict(row)


def _iter_txt(path: Path) -> Iterator[dict]:
    text = path.read_text(encoding="utf-8", errors="replace")
    for para in text.split("\n\n"):
        para = para.strip()
        if len(para) > 20:
            yield {"text": para}


def _iter_json_file(path: Path) -> Iterator[dict]:
    data = json.loads(path.read_text(encoding="utf-8", errors="replace"))
    if isinstance(data, list):
        for item in data:
            if isinstance(item, dict):
                yield item
    elif isinstance(data, dict):
        yield data


def _iter_source(data_path: Path) -> tuple[Iterator[dict], str]:
    """
    Return (row_iterator, detected_format) for a file or directory.
    Raises ValueError for unsupported formats.
    """
    if data_path.is_dir():
        parquet = sorted(data_path.glob("**/*.parquet"))
        jsonl   = sorted(data_path.glob("**/*.jsonl")) + sorted(data_path.glob("**/*.ndjson"))
        csvs    = sorted(data_path.glob("**/*.csv"))

        if parquet:
            return _iter_parquet(parquet), "parquet"
        if jsonl:
            return _iter_jsonl(jsonl), "jsonl"
        if csvs:
            return _iter_csv(csvs), "csv"
        raise ValueError(f"No supported files (.parquet/.jsonl/.csv) found in {data_path}")

    suffix = data_path.suffix.lower()
    if suffix == ".parquet":
        return _iter_parquet([data_path]), "parquet"
    if suffix in (".jsonl", ".ndjson"):
        return _iter_jsonl([data_path]), "jsonl"
    if suffix == ".json":
        return _iter_json_file(data_path), "json"
    if suffix == ".csv":
        return _iter_csv([data_path]), "csv"
    if suffix == ".txt":
        return _iter_txt(data_path), "txt"
    raise ValueError(f"Unsupported file format: {suffix}")


# ─────────────────────────────────────────────────────────────────────────────
# FTS5 SCHEMA
# ─────────────────────────────────────────────────────────────────────────────

def _create_schema(conn: sqlite3.Connection, text_cols: List[str]) -> None:
    cols_ddl   = ", ".join(f"{c} TEXT" for c in text_cols)
    cols_list  = ", ".join(text_cols)
    new_vals   = ", ".join(f"new.{c}" for c in text_cols)
    placeholders = ", ".join("?" * len(text_cols))

    conn.executescript(f"""
        CREATE TABLE IF NOT EXISTS documents (
            rowid  INTEGER PRIMARY KEY,
            {cols_ddl}
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
            {cols_list},
            content=documents,
            content_rowid=rowid,
            tokenize='porter unicode61'
        );

        CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
            INSERT INTO documents_fts(rowid, {cols_list})
            VALUES (new.rowid, {new_vals});
        END;
    """)
    conn.commit()


# ─────────────────────────────────────────────────────────────────────────────
# PUBLIC API
# ─────────────────────────────────────────────────────────────────────────────

def build_index(
    data_path: Path,
    db_path: Path,
    text_cols: Optional[List[str]] = None,
    source_id: str = "dataset",
) -> int:
    """
    Index data_path into an FTS5 SQLite database at db_path.

    Args:
        data_path:  File or directory containing the dataset.
        db_path:    Output SQLite database path (created if absent).
        text_cols:  Column names to index. Auto-detected if None.
        source_id:  Label for log messages.

    Returns:
        Number of rows indexed.

    Raises:
        ValueError if format unsupported or no text columns found.
    """
    data_path = Path(data_path).expanduser()
    db_path   = Path(db_path).expanduser()

    row_iter, fmt = _iter_source(data_path)
    logger.info("[generic_indexer] %s — format=%s → %s", source_id, fmt, db_path)

    # Auto-detect columns from first 50 rows if not specified
    if not text_cols:
        probe = []
        row_iter_2, _ = _iter_source(data_path)   # fresh iterator for probe
        for i, row in enumerate(row_iter_2):
            probe.append(row)
            if i >= 49:
                break
        text_cols = detect_text_columns(probe)
        logger.info("[generic_indexer] Auto-detected text columns: %s", text_cols)
        if not text_cols:
            raise ValueError(
                f"No indexable text columns found in {data_path}. "
                "Pass --cols explicitly."
            )
        # Restart main iterator since we consumed the probe
        row_iter, _ = _iter_source(data_path)

    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    _create_schema(conn, text_cols)

    cols_list    = ", ".join(text_cols)
    placeholders = ", ".join("?" * len(text_cols))
    insert_sql   = f"INSERT INTO documents({cols_list}) VALUES ({placeholders})"

    batch: list[tuple] = []
    indexed = 0
    skipped = 0

    for row in row_iter:
        vals = tuple(str(row.get(c) or "")[:_MAX_FIELD_CHARS] for c in text_cols)
        # Skip rows where all text cols are empty
        if not any(v.strip() for v in vals):
            skipped += 1
            continue
        batch.append(vals)
        indexed += 1

        if len(batch) >= _BATCH_SIZE:
            conn.executemany(insert_sql, batch)
            conn.commit()
            batch.clear()
            if indexed % 10_000 == 0:
                logger.info("[generic_indexer] %s — %d rows indexed...", source_id, indexed)

    if batch:
        conn.executemany(insert_sql, batch)
        conn.commit()

    conn.execute("INSERT INTO documents_fts(documents_fts) VALUES('optimize')")
    conn.commit()
    conn.close()

    logger.info(
        "[generic_indexer] Done. source=%s indexed=%d skipped=%d db=%s",
        source_id, indexed, skipped, db_path,
    )
    return indexed
