"""
AURA NX-Alpha — Stack Exchange FTS5 Index Builder
Reads Stack Exchange data dump XML files and indexes Q&A pairs into SQLite FTS5.

REQUIREMENTS:
    pip install tqdm

USAGE:
    python scripts/build_stackexchange_index.py \\
        --posts /path/to/Posts.xml \\
        --db ~/.aura/knowledge/stackexchange.db \\
        --site stackoverflow \\
        --min-score 5 \\
        --limit 0

DATA DOWNLOAD:
    Archive.org data dump: https://archive.org/details/stackexchange
    Recommended: stackoverflow.com.7z (~20GB), or topic-specific dumps
    (e.g., stats.stackexchange.com.7z for stats/ML, serverfault.com.7z for sysadmin)

    Extract to get Posts.xml, then run this script.

OUTPUT:
    SQLite with:
        posts(rowid, site, post_type, score, title, body, tags, accepted_answer_id)
        posts_fts (FTS5 virtual table over title + body)
"""

import argparse
import logging
import sqlite3
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")


DDL = """
CREATE TABLE IF NOT EXISTS posts (
    rowid            INTEGER PRIMARY KEY,
    site             TEXT NOT NULL,
    post_type        INTEGER,          -- 1=Question, 2=Answer
    score            INTEGER,
    title            TEXT,
    body             TEXT NOT NULL,
    tags             TEXT,
    accepted_answer_id INTEGER
);

CREATE VIRTUAL TABLE IF NOT EXISTS posts_fts USING fts5(
    title,
    body,
    tags,
    content=posts,
    content_rowid=rowid,
    tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS posts_ai AFTER INSERT ON posts BEGIN
    INSERT INTO posts_fts(rowid, title, body, tags)
    VALUES (new.rowid, new.title, new.body, new.tags);
END;
"""


def strip_html(text: str) -> str:
    """Minimal HTML stripper — removes tags, preserves content."""
    try:
        import html
        import re
        text = re.sub(r"<[^>]+>", " ", text)
        text = html.unescape(text)
        text = re.sub(r"\s+", " ", text)
        return text.strip()
    except Exception:
        return text


def build_index(posts_xml: str, db_path: str, site: str, min_score: int, limit: int) -> None:
    db = Path(db_path).expanduser()
    db.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db))
    conn.executescript(DDL)

    logger.info("Parsing: %s (site=%s, min_score=%d)", posts_xml, site, min_score)

    batch: list[tuple] = []
    BATCH_SIZE = 500
    indexed = 0
    skipped = 0

    context = ET.iterparse(posts_xml, events=("end",))
    for event, elem in context:
        if elem.tag != "row":
            continue

        if limit > 0 and indexed >= limit:
            break

        try:
            post_type = int(elem.get("PostTypeId", 0))
            score = int(elem.get("Score", 0))

            if post_type not in (1, 2):
                skipped += 1
                elem.clear()
                continue

            if score < min_score:
                skipped += 1
                elem.clear()
                continue

            title = elem.get("Title", "") or ""
            body_raw = elem.get("Body", "") or ""
            body = strip_html(body_raw)[:30_000]
            tags = elem.get("Tags", "") or ""
            accepted_id_str = elem.get("AcceptedAnswerId")
            accepted_id = int(accepted_id_str) if accepted_id_str else None

            if len(body) < 30:
                skipped += 1
                elem.clear()
                continue

            batch.append((site, post_type, score, title or None, body, tags or None, accepted_id))
            indexed += 1

            if len(batch) >= BATCH_SIZE:
                conn.executemany(
                    "INSERT INTO posts(site,post_type,score,title,body,tags,accepted_answer_id) "
                    "VALUES (?,?,?,?,?,?,?)", batch
                )
                conn.commit()
                batch.clear()
                logger.info("Indexed %d posts (%d skipped)...", indexed, skipped)

        except Exception as exc:
            logger.debug("Skipping row: %s", exc)
            skipped += 1
        finally:
            elem.clear()

    if batch:
        conn.executemany(
            "INSERT INTO posts(site,post_type,score,title,body,tags,accepted_answer_id) "
            "VALUES (?,?,?,?,?,?,?)", batch
        )
        conn.commit()

    conn.execute("INSERT INTO posts_fts(posts_fts) VALUES('optimize')")
    conn.commit()
    conn.close()

    logger.info("Done. Indexed %d posts, skipped %d. DB: %s", indexed, skipped, db)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Build Stack Exchange FTS5 index from Posts.xml")
    parser.add_argument("--posts",     required=True, help="Path to Posts.xml")
    parser.add_argument("--db",        default="~/.aura/knowledge/stackexchange.db")
    parser.add_argument("--site",      default="stackoverflow", help="Site label for filtering")
    parser.add_argument("--min-score", type=int, default=5, help="Minimum post score")
    parser.add_argument("--limit",     type=int, default=0, help="Max posts (0=all)")
    args = parser.parse_args()

    build_index(args.posts, args.db, args.site, args.min_score, args.limit)
