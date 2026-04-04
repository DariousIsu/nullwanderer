"""
AURA NX-Alpha — Wikipedia FTS5 Index Builder
Reads a Wikipedia ZIM archive and indexes articles into SQLite FTS5.

REQUIREMENTS:
    pip install libzim          # ZIM reader
    pip install tqdm            # Progress bar
    pip install html2text       # Strip HTML to plain text

USAGE:
    python scripts/build_wikipedia_index.py \\
        --zim /path/to/wikipedia.zim \\
        --db ~/.aura/knowledge/wikipedia.db \\
        --limit 0               # 0 = all articles

OUTPUT:
    ~/.aura/knowledge/wikipedia.db  — SQLite with:
        articles(rowid, title, url, content)
        articles_fts (FTS5 virtual table over title + content)

DOWNLOAD:
    ZIM archives: https://download.kiwix.org/zim/wikipedia/
    Recommended: wikipedia_en_wp_2024-11.zim (~90GB) or
                 wikipedia_en_top_2024-11.zim  (~8GB, top articles only)
"""

import argparse
import logging
import sqlite3
import sys
from pathlib import Path

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")


# ─────────────────────────────────────────────────────────────────────────────
# SCHEMA
# ─────────────────────────────────────────────────────────────────────────────

DDL = """
CREATE TABLE IF NOT EXISTS articles (
    rowid    INTEGER PRIMARY KEY,
    title    TEXT NOT NULL,
    url      TEXT,
    content  TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS articles_fts USING fts5(
    title,
    content,
    content=articles,
    content_rowid=rowid,
    tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS articles_ai AFTER INSERT ON articles BEGIN
    INSERT INTO articles_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
END;
"""


# ─────────────────────────────────────────────────────────────────────────────
# BUILDER
# ─────────────────────────────────────────────────────────────────────────────

def build_index(zim_path: str, db_path: str, limit: int = 0) -> None:
    try:
        from libzim.reader import Archive
    except ImportError:
        logger.error("libzim not installed. Run: pip install libzim")
        sys.exit(1)

    try:
        import html2text
        h = html2text.HTML2Text()
        h.ignore_links = True
        h.ignore_images = True
    except ImportError:
        logger.error("html2text not installed. Run: pip install html2text")
        sys.exit(1)

    db = Path(db_path).expanduser()
    db.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db))
    conn.executescript(DDL)

    logger.info("Opening ZIM: %s", zim_path)
    archive = Archive(zim_path)
    total = archive.entry_count
    logger.info("ZIM has %d entries. Starting index...", total)

    batch: list[tuple] = []
    BATCH_SIZE = 500
    indexed = 0
    skipped = 0

    try:
        from tqdm import tqdm
        entries = tqdm(archive, total=total, unit="art")
    except ImportError:
        entries = archive

    for entry in entries:
        if limit > 0 and indexed >= limit:
            break

        if entry.is_redirect:
            skipped += 1
            continue

        try:
            item = entry.get_item()
            if item.mimetype not in ("text/html", "text/html; charset=utf-8"):
                skipped += 1
                continue

            raw = bytes(item.content).decode("utf-8", errors="replace")
            text = h.handle(raw).strip()
            if len(text) < 50:
                skipped += 1
                continue

            batch.append((entry.title, entry.path, text[:50_000]))
            indexed += 1

            if len(batch) >= BATCH_SIZE:
                conn.executemany(
                    "INSERT INTO articles(title, url, content) VALUES (?, ?, ?)", batch
                )
                conn.commit()
                batch.clear()
                logger.info("Indexed %d articles (%d skipped)...", indexed, skipped)

        except Exception as exc:
            logger.debug("Skipping entry %s: %s", getattr(entry, 'path', '?'), exc)
            skipped += 1

    if batch:
        conn.executemany(
            "INSERT INTO articles(title, url, content) VALUES (?, ?, ?)", batch
        )
        conn.commit()

    conn.execute("INSERT INTO articles_fts(articles_fts) VALUES('optimize')")
    conn.commit()
    conn.close()

    logger.info("Done. Indexed %d articles, skipped %d. DB: %s", indexed, skipped, db)


# ─────────────────────────────────────────────────────────────────────────────
# ENTRY
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Build Wikipedia FTS5 index from ZIM archive")
    parser.add_argument("--zim",   required=True, help="Path to Wikipedia ZIM file")
    parser.add_argument("--db",    default="~/.aura/knowledge/wikipedia.db", help="Output SQLite DB path")
    parser.add_argument("--limit", type=int, default=0, help="Max articles (0=all)")
    args = parser.parse_args()

    build_index(args.zim, args.db, args.limit)
