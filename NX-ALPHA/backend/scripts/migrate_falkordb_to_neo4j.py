"""
migrate_falkordb_to_neo4j.py
────────────────────────────
Migrates AURA's Layer 3 memory from FalkorDB to Neo4j.

Modes:
  export  — dump all :Fact nodes from FalkorDB → JSON backup
  import  — load JSON backup → write :Fact nodes to Neo4j
  both    — export then import in one pass (requires both DBs running)

Usage:
  # Step 1: while FalkorDB is still running
  python scripts/migrate_falkordb_to_neo4j.py export

  # Step 2: swap Docker services (docker compose down && update compose && docker compose up -d)

  # Step 3: once Neo4j is healthy
  python scripts/migrate_falkordb_to_neo4j.py import

  # Or do both at once if both DBs are running simultaneously
  python scripts/migrate_falkordb_to_neo4j.py both
"""

import argparse
import json
import sys
import time
from pathlib import Path

# ── Config ────────────────────────────────────────────────────────────────────
FALKORDB_HOST = "localhost"
FALKORDB_PORT = 6380
FALKORDB_GRAPH = "aura_knowledge"

NEO4J_URI      = "bolt://localhost:7687"
NEO4J_USER     = "neo4j"
NEO4J_PASSWORD = "aurapassword"
NEO4J_DATABASE = "neo4j"

BACKUP_PATH = Path.home() / ".aura" / "falkordb_export.json"


# ── Export ────────────────────────────────────────────────────────────────────

def do_export() -> list[dict]:
    try:
        import falkordb
    except ImportError:
        print("ERROR: falkordb package not installed. Run: pip install falkordb")
        sys.exit(1)

    print(f"Connecting to FalkorDB at {FALKORDB_HOST}:{FALKORDB_PORT} graph='{FALKORDB_GRAPH}' ...")
    client = falkordb.FalkorDB(host=FALKORDB_HOST, port=FALKORDB_PORT)
    graph  = client.select_graph(FALKORDB_GRAPH)

    result = graph.query("MATCH (f:Fact) RETURN f.id, f.content, f.thread_id, f.source, f.timestamp")
    rows   = result.result_set or []

    facts = []
    for row in rows:
        facts.append({
            "id":        row[0] or "",
            "content":   row[1] or "",
            "thread_id": row[2] or "",
            "source":    row[3] or "",
            "timestamp": float(row[4]) if row[4] is not None else time.time(),
        })

    BACKUP_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(BACKUP_PATH, "w", encoding="utf-8") as f:
        json.dump(facts, f, indent=2)

    print(f"Exported {len(facts)} :Fact nodes → {BACKUP_PATH}")
    return facts


# ── Import ────────────────────────────────────────────────────────────────────

def do_import(facts: list[dict] | None = None) -> None:
    try:
        from neo4j import GraphDatabase
    except ImportError:
        print("ERROR: neo4j package not installed. Run: pip install neo4j")
        sys.exit(1)

    if facts is None:
        if not BACKUP_PATH.exists():
            print(f"ERROR: Backup file not found at {BACKUP_PATH}. Run export first.")
            sys.exit(1)
        with open(BACKUP_PATH, encoding="utf-8") as f:
            facts = json.load(f)
        print(f"Loaded {len(facts)} facts from {BACKUP_PATH}")

    print(f"Connecting to Neo4j at {NEO4J_URI} database='{NEO4J_DATABASE}' ...")
    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))

    try:
        driver.verify_connectivity()
    except Exception as exc:
        print(f"ERROR: Cannot connect to Neo4j: {exc}")
        print("Make sure Neo4j is running: docker compose up -d neo4j")
        sys.exit(1)

    with driver.session(database=NEO4J_DATABASE) as session:
        # Create index first
        session.run(
            "CREATE INDEX fact_thread_id IF NOT EXISTS FOR (n:Fact) ON (n.thread_id)"
        )

        # Batch import in chunks of 500
        CHUNK = 500
        imported = 0
        for i in range(0, len(facts), CHUNK):
            chunk = facts[i : i + CHUNK]
            session.run(
                """
                UNWIND $facts AS f
                MERGE (n:Fact {id: f.id})
                SET n.content   = f.content,
                    n.thread_id = f.thread_id,
                    n.source    = f.source,
                    n.timestamp = f.timestamp
                """,
                {"facts": chunk},
            )
            imported += len(chunk)
            print(f"  Imported {imported}/{len(facts)} facts ...")

        # Verify
        count = session.run("MATCH (f:Fact) RETURN count(f) AS c").single()["c"]

    driver.close()
    print(f"\nDone. Neo4j '{NEO4J_DATABASE}' now has {count} :Fact nodes.")
    if count != len(facts):
        print(f"WARNING: expected {len(facts)}, got {count} — some facts may have duplicate IDs (MERGE deduplication).")


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description="Migrate FalkorDB Layer 3 memory to Neo4j")
    parser.add_argument(
        "mode",
        choices=["export", "import", "both"],
        help="export: dump FalkorDB → JSON | import: JSON → Neo4j | both: do both",
    )
    args = parser.parse_args()

    if args.mode == "export":
        do_export()
    elif args.mode == "import":
        do_import()
    elif args.mode == "both":
        facts = do_export()
        print()
        do_import(facts)


if __name__ == "__main__":
    main()
