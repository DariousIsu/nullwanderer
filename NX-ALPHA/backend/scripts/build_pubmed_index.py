"""
AURA NX-Alpha — PubMed FTS5 Index Builder
Reads PubMed baseline XML files and indexes article abstracts into SQLite FTS5.

REQUIREMENTS:
    pip install tqdm

USAGE:
    python scripts/build_pubmed_index.py \\
        --input /path/to/pubmed/baseline/ \\
        --db ~/.aura/knowledge/pubmed.db \\
        --limit 0

DATA DOWNLOAD:
    FTP: https://ftp.ncbi.nlm.nih.gov/pubmed/baseline/
    Files: pubmed24n*.xml.gz  (~1200 files, ~300GB uncompressed)
    Abstracts only (~30GB compressed). Download selectively by year or topic.

    To download all baseline files:
        wget -r -nd -P /data/pubmed ftp://ftp.ncbi.nlm.nih.gov/pubmed/baseline/

OUTPUT:
    SQLite with:
        articles(rowid, pmid, title, abstract, year, journal, mesh_terms)
        articles_fts (FTS5 virtual table over title + abstract + mesh_terms)
"""

import argparse
import gzip
import logging
import sqlite3
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")


DDL = """
CREATE TABLE IF NOT EXISTS articles (
    rowid      INTEGER PRIMARY KEY,
    pmid       TEXT UNIQUE,
    title      TEXT,
    abstract   TEXT NOT NULL,
    year       INTEGER,
    journal    TEXT,
    mesh_terms TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS articles_fts USING fts5(
    title,
    abstract,
    mesh_terms,
    content=articles,
    content_rowid=rowid,
    tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS articles_ai AFTER INSERT ON articles BEGIN
    INSERT INTO articles_fts(rowid, title, abstract, mesh_terms)
    VALUES (new.rowid, new.title, new.abstract, new.mesh_terms);
END;
"""


def _text(elem, tag: str, default: str = "") -> str:
    found = elem.find(tag)
    return (found.text or default) if found is not None else default


def parse_xml_file(path: Path):
    """Yield (pmid, title, abstract, year, journal, mesh_terms) from a PubMed XML file."""
    opener = gzip.open if path.suffix == ".gz" else open
    try:
        with opener(str(path), "rt", encoding="utf-8", errors="replace") as fh:
            context = ET.iterparse(fh, events=("end",))
            for event, elem in context:
                if elem.tag != "PubmedArticle":
                    continue

                medline = elem.find(".//MedlineCitation")
                if medline is None:
                    elem.clear()
                    continue

                pmid_elem = medline.find("PMID")
                pmid = pmid_elem.text if pmid_elem is not None else None

                article = medline.find("Article")
                if article is None:
                    elem.clear()
                    continue

                title = _text(article, "ArticleTitle")

                abstract_elem = article.find("Abstract")
                abstract_parts = []
                if abstract_elem is not None:
                    for at in abstract_elem.findall("AbstractText"):
                        label = at.get("Label", "")
                        text = at.text or ""
                        if label:
                            abstract_parts.append(f"{label}: {text}")
                        else:
                            abstract_parts.append(text)
                abstract = " ".join(abstract_parts).strip()

                if not abstract:
                    elem.clear()
                    continue

                # Year
                year = None
                pub_date = article.find(".//PubDate")
                if pub_date is not None:
                    year_elem = pub_date.find("Year")
                    if year_elem is not None:
                        try:
                            year = int(year_elem.text)
                        except (ValueError, TypeError):
                            pass

                # Journal
                journal_elem = article.find(".//Journal/Title")
                journal = journal_elem.text if journal_elem is not None else None

                # MeSH terms
                mesh_list = medline.find("MeshHeadingList")
                mesh_terms = ""
                if mesh_list is not None:
                    terms = []
                    for mh in mesh_list.findall("MeshHeading"):
                        desc = mh.find("DescriptorName")
                        if desc is not None and desc.text:
                            terms.append(desc.text)
                    mesh_terms = "; ".join(terms)

                yield (pmid, title, abstract[:20_000], year, journal, mesh_terms)
                elem.clear()

    except Exception as exc:
        logger.warning("Error parsing %s: %s", path.name, exc)


def build_index(input_path: str, db_path: str, limit: int) -> None:
    src = Path(input_path).expanduser()
    db = Path(db_path).expanduser()
    db.parent.mkdir(parents=True, exist_ok=True)

    # Collect input files
    if src.is_dir():
        files = sorted(src.glob("*.xml.gz")) + sorted(src.glob("*.xml"))
    else:
        files = [src]

    if not files:
        logger.error("No XML files found at: %s", src)
        sys.exit(1)

    logger.info("Found %d input files", len(files))

    conn = sqlite3.connect(str(db))
    conn.executescript(DDL)

    batch: list[tuple] = []
    BATCH_SIZE = 1000
    indexed = 0
    skipped = 0

    for file_path in files:
        logger.info("Processing: %s", file_path.name)
        for row in parse_xml_file(file_path):
            if limit > 0 and indexed >= limit:
                break

            pmid, title, abstract, year, journal, mesh_terms = row
            if not abstract:
                skipped += 1
                continue

            batch.append((pmid, title, abstract, year, journal, mesh_terms))
            indexed += 1

            if len(batch) >= BATCH_SIZE:
                conn.executemany(
                    "INSERT OR IGNORE INTO articles(pmid,title,abstract,year,journal,mesh_terms) "
                    "VALUES (?,?,?,?,?,?)", batch
                )
                conn.commit()
                batch.clear()
                logger.info("Indexed %d articles (%d skipped)...", indexed, skipped)

        if limit > 0 and indexed >= limit:
            break

    if batch:
        conn.executemany(
            "INSERT OR IGNORE INTO articles(pmid,title,abstract,year,journal,mesh_terms) "
            "VALUES (?,?,?,?,?,?)", batch
        )
        conn.commit()

    conn.execute("INSERT INTO articles_fts(articles_fts) VALUES('optimize')")
    conn.commit()
    conn.close()

    logger.info("Done. Indexed %d articles, skipped %d. DB: %s", indexed, skipped, db)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Build PubMed FTS5 index from XML baseline files")
    parser.add_argument("--input",  required=True, help="Path to PubMed XML file or directory of .xml/.xml.gz files")
    parser.add_argument("--db",     default="~/.aura/knowledge/pubmed.db")
    parser.add_argument("--limit",  type=int, default=0, help="Max articles (0=all)")
    args = parser.parse_args()

    build_index(args.input, args.db, args.limit)
