"""
AURA NX-Alpha — Caselaw FTS5 Index Builder
Fetches and indexes case law from CourtListener API into SQLite FTS5.
Also supports Harvard Caselaw Access Project bulk download.

REQUIREMENTS:
    pip install httpx tqdm

USAGE — CourtListener API:
    python scripts/build_caselaw_index.py \\
        --source courtlistener \\
        --token YOUR_COURTLISTENER_TOKEN \\
        --db ~/.aura/knowledge/caselaw.db \\
        --courts scotus,ca9,ca2 \\
        --limit 5000

USAGE — Harvard Caselaw (bulk JSON):
    python scripts/build_caselaw_index.py \\
        --source harvard \\
        --input /path/to/caselaw/data/ \\
        --db ~/.aura/knowledge/caselaw.db

DATA:
    CourtListener: https://www.courtlistener.com/api/
    Harvard CAP:   https://case.law/bulk/download/ (free for non-commercial)

OUTPUT:
    SQLite with:
        cases(rowid, case_id, source, court, name, citation, date_decided, text)
        cases_fts (FTS5 virtual table over name + citation + text)
"""

import argparse
import json
import logging
import sqlite3
import sys
import time
from pathlib import Path

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")


DDL = """
CREATE TABLE IF NOT EXISTS cases (
    rowid         INTEGER PRIMARY KEY,
    case_id       TEXT UNIQUE,
    source        TEXT NOT NULL,
    court         TEXT,
    name          TEXT NOT NULL,
    citation      TEXT,
    date_decided  TEXT,
    text          TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS cases_fts USING fts5(
    name,
    citation,
    text,
    content=cases,
    content_rowid=rowid,
    tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS cases_ai AFTER INSERT ON cases BEGIN
    INSERT INTO cases_fts(rowid, name, citation, text)
    VALUES (new.rowid, new.name, new.citation, new.text);
END;
"""


# ─────────────────────────────────────────────────────────────────────────────
# COURTLISTENER SOURCE
# ─────────────────────────────────────────────────────────────────────────────

def build_from_courtlistener(token: str, db_path: str, courts: list[str], limit: int) -> None:
    try:
        import httpx
    except ImportError:
        logger.error("httpx not installed. Run: pip install httpx")
        sys.exit(1)

    db = Path(db_path).expanduser()
    db.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db))
    conn.executescript(DDL)

    headers = {"Authorization": f"Token {token}"}
    base_url = "https://www.courtlistener.com/api/rest/v4/opinions/"

    indexed = 0
    page_url = base_url + "?format=json&page_size=100"
    if courts:
        page_url += "&court__in=" + ",".join(courts)

    while page_url and (limit == 0 or indexed < limit):
        try:
            resp = httpx.get(page_url, headers=headers, timeout=30)
            resp.raise_for_status()
            data = resp.json()
        except Exception as exc:
            logger.error("API request failed: %s", exc)
            break

        results = data.get("results", [])
        if not results:
            break

        batch = []
        for opinion in results:
            if limit > 0 and indexed >= limit:
                break

            case_id = str(opinion.get("id", ""))
            cluster = opinion.get("cluster", {}) or {}
            name = cluster.get("case_name") or opinion.get("author_str") or "Unknown"
            citation = ", ".join(cluster.get("citations", []) or [])
            court = cluster.get("court_id", "")
            date_decided = cluster.get("date_filed", "")

            # Text: prefer plain_text, then html_with_citations stripped
            text = (
                opinion.get("plain_text")
                or opinion.get("html_with_citations")
                or opinion.get("html")
                or ""
            )
            if not text or len(text) < 50:
                continue

            # Strip HTML if needed
            if text.startswith("<"):
                import re, html as _html
                text = re.sub(r"<[^>]+>", " ", text)
                text = _html.unescape(text)

            batch.append((case_id, "courtlistener", court, name, citation or None, date_decided or None, text[:50_000]))
            indexed += 1

        if batch:
            conn.executemany(
                "INSERT OR IGNORE INTO cases(case_id,source,court,name,citation,date_decided,text) "
                "VALUES (?,?,?,?,?,?,?)", batch
            )
            conn.commit()
            logger.info("Indexed %d cases...", indexed)

        page_url = data.get("next")
        time.sleep(0.5)   # Respect rate limits

    conn.execute("INSERT INTO cases_fts(cases_fts) VALUES('optimize')")
    conn.commit()
    conn.close()
    logger.info("Done. Indexed %d cases. DB: %s", indexed, db)


# ─────────────────────────────────────────────────────────────────────────────
# HARVARD CASELAW SOURCE
# ─────────────────────────────────────────────────────────────────────────────

def build_from_harvard(input_path: str, db_path: str, limit: int) -> None:
    src = Path(input_path).expanduser()
    db = Path(db_path).expanduser()
    db.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db))
    conn.executescript(DDL)

    files = list(src.rglob("*.jsonl")) + list(src.rglob("*.json"))
    logger.info("Found %d input files in %s", len(files), src)

    indexed = 0
    batch = []
    BATCH_SIZE = 500

    for fpath in files:
        with open(fpath, "r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                if limit > 0 and indexed >= limit:
                    break
                line = line.strip()
                if not line:
                    continue
                try:
                    case = json.loads(line)
                    case_id = str(case.get("id", ""))
                    name = case.get("name_abbreviation") or case.get("name") or "Unknown"
                    court = (case.get("court") or {}).get("name_abbreviation", "")
                    citation = ", ".join(
                        c.get("cite", "") for c in (case.get("citations") or [])
                    )
                    date_decided = case.get("decision_date", "")
                    # Text from casebody opinions
                    casebody = case.get("casebody", {}) or {}
                    opinions = (casebody.get("data", {}) or {}).get("opinions", []) or []
                    text = " ".join(op.get("text", "") for op in opinions).strip()
                    if not text or len(text) < 50:
                        continue
                    batch.append((case_id, "harvard", court, name, citation or None, date_decided or None, text[:50_000]))
                    indexed += 1
                    if len(batch) >= BATCH_SIZE:
                        conn.executemany(
                            "INSERT OR IGNORE INTO cases(case_id,source,court,name,citation,date_decided,text) "
                            "VALUES (?,?,?,?,?,?,?)", batch
                        )
                        conn.commit()
                        batch.clear()
                        logger.info("Indexed %d cases...", indexed)
                except Exception as exc:
                    logger.debug("Skipping line: %s", exc)

        if limit > 0 and indexed >= limit:
            break

    if batch:
        conn.executemany(
            "INSERT OR IGNORE INTO cases(case_id,source,court,name,citation,date_decided,text) "
            "VALUES (?,?,?,?,?,?,?)", batch
        )
        conn.commit()

    conn.execute("INSERT INTO cases_fts(cases_fts) VALUES('optimize')")
    conn.commit()
    conn.close()
    logger.info("Done. Indexed %d cases. DB: %s", indexed, db)


# ─────────────────────────────────────────────────────────────────────────────
# ENTRY
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Build Caselaw FTS5 index")
    parser.add_argument("--source",  choices=["courtlistener", "harvard"], required=True)
    parser.add_argument("--db",      default="~/.aura/knowledge/caselaw.db")
    parser.add_argument("--token",   help="CourtListener API token (required for courtlistener source)")
    parser.add_argument("--courts",  default="", help="Comma-separated court IDs (courtlistener only)")
    parser.add_argument("--input",   help="Input path for harvard source (directory of .jsonl files)")
    parser.add_argument("--limit",   type=int, default=0)
    args = parser.parse_args()

    if args.source == "courtlistener":
        if not args.token:
            logger.error("--token required for courtlistener source")
            sys.exit(1)
        courts = [c.strip() for c in args.courts.split(",") if c.strip()]
        build_from_courtlistener(args.token, args.db, courts, args.limit)
    else:
        if not args.input:
            logger.error("--input required for harvard source")
            sys.exit(1)
        build_from_harvard(args.input, args.db, args.limit)
