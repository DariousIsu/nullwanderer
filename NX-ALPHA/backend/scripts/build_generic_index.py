"""
AURA NX-Alpha — Generic FTS5 Index Builder
Indexes any columnar or plain-text dataset into SQLite FTS5.

Delegates all logic to app.service.generic_indexer.

SUPPORTED FORMATS:
    .parquet            — via pyarrow
    .jsonl / .ndjson    — newline-delimited JSON
    .json               — JSON array
    .csv                — comma-separated values
    .txt                — plain text, split by double-newline

USAGE:
    # Auto-detect text columns:
    python scripts/build_generic_index.py \\
        --input ~/.aura/knowledge/my_dataset/staging/ \\
        --db    ~/.aura/knowledge/my_dataset/fts5.db

    # Specify columns explicitly:
    python scripts/build_generic_index.py \\
        --input ~/.aura/knowledge/my_dataset/staging/data.parquet \\
        --db    ~/.aura/knowledge/my_dataset/fts5.db \\
        --cols  title abstract

    # HuggingFace dataset (download first):
    hf download --repo-type dataset org/dataset \\
        --local-dir ~/.aura/knowledge/my_dataset/staging/

    python scripts/build_generic_index.py \\
        --input ~/.aura/knowledge/my_dataset/staging/ \\
        --db    ~/.aura/knowledge/my_dataset/fts5.db \\
        --source-id my_dataset

OUTPUT:
    SQLite with:
        documents (rowid INTEGER PRIMARY KEY, <col1> TEXT, ...)
        documents_fts (FTS5 virtual table, porter unicode61 tokenizer)
"""

import argparse
import logging
import sys
from pathlib import Path

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
logger = logging.getLogger(__name__)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Build a generic FTS5 index from any columnar dataset"
    )
    parser.add_argument(
        "--input",
        required=True,
        help="Path to input file or directory (.parquet, .jsonl, .csv, .txt)",
    )
    parser.add_argument(
        "--db",
        required=True,
        help="Output SQLite FTS5 database path",
    )
    parser.add_argument(
        "--cols",
        nargs="*",
        default=None,
        help="Column names to index (auto-detected if omitted)",
    )
    parser.add_argument(
        "--source-id",
        default="dataset",
        help="Label for log output (default: dataset)",
    )
    args = parser.parse_args()

    # Add backend/ to sys.path so the service module is importable
    backend_dir = Path(__file__).parent.parent
    if str(backend_dir) not in sys.path:
        sys.path.insert(0, str(backend_dir))

    try:
        from app.service.generic_indexer import build_index
    except ImportError as exc:
        logger.error("Could not import generic_indexer: %s", exc)
        logger.error("Run this script from the backend/ directory, or ensure backend/ is on PYTHONPATH.")
        sys.exit(1)

    input_path = Path(args.input).expanduser()
    db_path    = Path(args.db).expanduser()

    if not input_path.exists():
        logger.error("Input path does not exist: %s", input_path)
        sys.exit(1)

    try:
        count = build_index(
            data_path  = input_path,
            db_path    = db_path,
            text_cols  = args.cols or None,
            source_id  = args.source_id,
        )
        logger.info("Done. %d rows indexed → %s", count, db_path)
    except Exception as exc:
        logger.error("Indexing failed: %s", exc)
        sys.exit(1)


if __name__ == "__main__":
    main()
