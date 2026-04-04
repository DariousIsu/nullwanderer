"""
ingest_legislation_graph.py
────────────────────────────
Phase 3b — Populate Neo4j `aura_memory` with legislation graph.

Reads from the AURA legislation SQLite DB (~/.aura/legislation.db) and writes:
  (:Bill   {id, identifier, title, status, chamber, state_code, session_id, last_action_date, abstract})
  (:Legislator {name})
  (:Subject    {name})
  (:Action     {id, date, description, classification})
  (:State      {code})
  (:Session    {id, identifier, start_date, end_date})

  (:Bill)-[:SPONSORED_BY {primary: bool}]->(:Legislator)
  (:Bill)-[:COVERS_SUBJECT]->(:Subject)
  (:Bill)-[:HAS_ACTION]->(:Action)
  (:Bill)-[:IN_SESSION]->(:Session)
  (:Session)-[:FOR_STATE]->(:State)

NOTE: FTS5 full-text search is intentionally left in SQLite.
      Neo4j only stores the relational structure (traversal layer).

Run from project root:
    python backend/scripts/ingest_legislation_graph.py
    python backend/scripts/ingest_legislation_graph.py --limit 5000   # subset
    python backend/scripts/ingest_legislation_graph.py --dry-run
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path

# ── Config ────────────────────────────────────────────────────────────────────
NEO4J_URI      = "bolt://localhost:7687"
NEO4J_USER     = "neo4j"
NEO4J_PASSWORD = "aurapassword"
NEO4J_DATABASE = "neo4j"
LEGISLATION_DB  = Path.home() / ".aura" / "legislation.db"

# Batch size for UNWIND merges — keeps memory bounded
BATCH_SIZE = 500


def _check_db() -> None:
    if not LEGISLATION_DB.exists():
        print(f"[error] Legislation DB not found at {LEGISLATION_DB}")
        print("  Run the legislation downloader first to populate data.")
        sys.exit(1)


def _load_sqlite(limit: int | None) -> dict:
    """Load all relevant tables from SQLite. Returns dict of lists."""
    conn = sqlite3.connect(str(LEGISLATION_DB))
    conn.row_factory = sqlite3.Row

    def q(sql, params=()):
        return [dict(row) for row in conn.execute(sql, params).fetchall()]

    states   = q("SELECT code, name FROM states")
    sessions = q("SELECT id, state_code, identifier, start_date, end_date FROM sessions")

    limit_clause = f"LIMIT {limit}" if limit else ""
    bills = q(f"""
        SELECT id, session_id, state_code, identifier, title, chamber,
               status, subjects, last_action_date, abstract
        FROM bills
        ORDER BY last_action_date DESC
        {limit_clause}
    """)

    bill_ids = tuple(b["id"] for b in bills)
    if not bill_ids:
        conn.close()
        return {"states": states, "sessions": sessions, "bills": [], "sponsors": [], "actions": []}

    # Parameterize to avoid SQL injection — split into chunks for large sets
    sponsors = []
    actions  = []
    for i in range(0, len(bill_ids), 900):
        chunk = bill_ids[i:i+900]
        placeholders = ",".join("?" * len(chunk))
        sponsors.extend(q(
            f"SELECT bill_id, name, primary_sponsor FROM bill_sponsors WHERE bill_id IN ({placeholders})",
            chunk,
        ))
        actions.extend(q(
            f"SELECT id, bill_id, date, description, norm_classification FROM bill_actions WHERE bill_id IN ({placeholders})",
            chunk,
        ))

    conn.close()
    return {"states": states, "sessions": sessions, "bills": bills, "sponsors": sponsors, "actions": actions}


def _ingest(data: dict, dry_run: bool) -> None:
    bills    = data["bills"]
    sponsors = data["sponsors"]
    actions  = data["actions"]
    states   = data["states"]
    sessions = data["sessions"]

    if dry_run:
        print(f"\n[dry-run] Would write:")
        print(f"  {len(states)} State nodes")
        print(f"  {len(sessions)} Session nodes")
        print(f"  {len(bills)} Bill nodes")
        print(f"  {len({s['name'] for s in sponsors})} Legislator nodes")
        subjects_set = set()
        for b in bills:
            try:
                subjects_set.update(json.loads(b.get("subjects") or "[]"))
            except (json.JSONDecodeError, TypeError):
                pass
        print(f"  {len(subjects_set)} Subject nodes")
        print(f"  {len(actions)} Action nodes")
        return

    try:
        from neo4j import GraphDatabase
    except ImportError:
        print("[error] neo4j driver not installed — run: pip install neo4j>=5.0.0")
        sys.exit(1)

    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
    try:
        driver.verify_connectivity()
    except Exception as exc:
        print(f"[error] Cannot connect to Neo4j at {NEO4J_URI}: {exc}")
        sys.exit(1)

    with driver.session(database=NEO4J_DATABASE) as session:
        # ── Constraints ───────────────────────────────────────────────────────
        for constraint in [
            "CREATE CONSTRAINT bill_id_unique IF NOT EXISTS FOR (b:Bill) REQUIRE b.id IS UNIQUE",
            "CREATE CONSTRAINT state_code_unique IF NOT EXISTS FOR (s:State) REQUIRE s.code IS UNIQUE",
            "CREATE CONSTRAINT session_id_unique IF NOT EXISTS FOR (s:LegSession) REQUIRE s.id IS UNIQUE",
            "CREATE CONSTRAINT subject_name_unique IF NOT EXISTS FOR (s:Subject) REQUIRE s.name IS UNIQUE",
            "CREATE CONSTRAINT legislator_name_unique IF NOT EXISTS FOR (l:Legislator) REQUIRE l.name IS UNIQUE",
        ]:
            session.run(constraint)
        print("  [neo4j] Constraints ensured")

        # ── States ────────────────────────────────────────────────────────────
        session.run(
            "UNWIND $rows AS row MERGE (n:State {code: row.code}) SET n.name = row.name",
            rows=[{"code": s["code"], "name": s.get("name", "")} for s in states],
        ) if states else None
        print(f"  [neo4j] {len(states)} State nodes")

        # ── Sessions ──────────────────────────────────────────────────────────
        for i in range(0, len(sessions), BATCH_SIZE):
            chunk = sessions[i:i+BATCH_SIZE]
            session.run(
                """
                UNWIND $rows AS row
                MERGE (s:LegSession {id: row.id})
                SET s.identifier  = row.identifier,
                    s.start_date  = row.start_date,
                    s.end_date    = row.end_date
                WITH s, row
                MATCH (st:State {code: row.state_code})
                MERGE (s)-[:FOR_STATE]->(st)
                """,
                rows=chunk,
            )
        print(f"  [neo4j] {len(sessions)} LegSession nodes")

        # ── Bills ─────────────────────────────────────────────────────────────
        bill_rows = []
        bill_subject_pairs = []  # (bill_id, subject_name)
        for b in bills:
            bill_rows.append({
                "id":               b["id"],
                "identifier":       b.get("identifier", ""),
                "title":            b.get("title", ""),
                "status":           b.get("status", ""),
                "chamber":          b.get("chamber", ""),
                "state_code":       b.get("state_code", ""),
                "session_id":       b.get("session_id", ""),
                "last_action_date": b.get("last_action_date", ""),
                "abstract":         (b.get("abstract") or "")[:1000],
            })
            try:
                subjects = json.loads(b.get("subjects") or "[]")
                if isinstance(subjects, list):
                    for subj in subjects:
                        if subj:
                            bill_subject_pairs.append({"bill_id": b["id"], "subject": str(subj)})
            except (json.JSONDecodeError, TypeError):
                pass

        for i in range(0, len(bill_rows), BATCH_SIZE):
            chunk = bill_rows[i:i+BATCH_SIZE]
            session.run(
                """
                UNWIND $rows AS row
                MERGE (b:Bill {id: row.id})
                SET b.identifier       = row.identifier,
                    b.title            = row.title,
                    b.status           = row.status,
                    b.chamber          = row.chamber,
                    b.state_code       = row.state_code,
                    b.last_action_date = row.last_action_date,
                    b.abstract         = row.abstract
                WITH b, row
                MATCH (s:LegSession {id: row.session_id})
                MERGE (b)-[:IN_SESSION]->(s)
                """,
                rows=chunk,
            )
        print(f"  [neo4j] {len(bill_rows)} Bill nodes")

        # ── Subjects ──────────────────────────────────────────────────────────
        for i in range(0, len(bill_subject_pairs), BATCH_SIZE):
            chunk = bill_subject_pairs[i:i+BATCH_SIZE]
            session.run(
                """
                UNWIND $rows AS row
                MERGE (subj:Subject {name: row.subject})
                WITH subj, row
                MATCH (b:Bill {id: row.bill_id})
                MERGE (b)-[:COVERS_SUBJECT]->(subj)
                """,
                rows=chunk,
            )
        print(f"  [neo4j] {len(bill_subject_pairs)} COVERS_SUBJECT edges")

        # ── Sponsors ──────────────────────────────────────────────────────────
        sponsor_rows = [
            {
                "bill_id": s["bill_id"],
                "name":    s["name"],
                "primary": bool(s.get("primary_sponsor", 0)),
            }
            for s in sponsors if s.get("name")
        ]
        for i in range(0, len(sponsor_rows), BATCH_SIZE):
            chunk = sponsor_rows[i:i+BATCH_SIZE]
            session.run(
                """
                UNWIND $rows AS row
                MERGE (l:Legislator {name: row.name})
                WITH l, row
                MATCH (b:Bill {id: row.bill_id})
                MERGE (b)-[r:SPONSORED_BY]->(l)
                SET r.primary = row.primary
                """,
                rows=chunk,
            )
        print(f"  [neo4j] {len(sponsor_rows)} SPONSORED_BY edges")

        # ── Actions ───────────────────────────────────────────────────────────
        action_rows = [
            {
                "id":             a["id"],
                "bill_id":        a["bill_id"],
                "date":           a.get("date", ""),
                "description":    (a.get("description") or "")[:500],
                "classification": a.get("norm_classification") or "",
            }
            for a in actions
        ]
        for i in range(0, len(action_rows), BATCH_SIZE):
            chunk = action_rows[i:i+BATCH_SIZE]
            session.run(
                """
                UNWIND $rows AS row
                MERGE (act:Action {id: row.id})
                SET act.date           = row.date,
                    act.description    = row.description,
                    act.classification = row.classification
                WITH act, row
                MATCH (b:Bill {id: row.bill_id})
                MERGE (b)-[:HAS_ACTION]->(act)
                """,
                rows=chunk,
            )
        print(f"  [neo4j] {len(action_rows)} Action nodes with HAS_ACTION edges")

    driver.close()
    print(f"\n[done] Legislation graph ingested into Neo4j ({NEO4J_DATABASE})")
    print(f"  Bills: {len(bill_rows)} | Sponsors: {len(sponsor_rows)} | Actions: {len(action_rows)}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Ingest legislation SQLite DB into Neo4j graph")
    parser.add_argument("--dry-run", action="store_true", help="Preview without writing")
    parser.add_argument("--limit",   type=int, default=None, help="Max bills to ingest (default: all)")
    args = parser.parse_args()

    _check_db()

    print(f"[ingest_legislation_graph] Reading from {LEGISLATION_DB}")
    data = _load_sqlite(args.limit)
    bills = data["bills"]
    print(f"[ingest_legislation_graph] Loaded {len(bills)} bills, "
          f"{len(data['sponsors'])} sponsors, {len(data['actions'])} actions")

    _ingest(data, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
