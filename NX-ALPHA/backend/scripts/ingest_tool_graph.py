"""
ingest_tool_graph.py
────────────────────
Phase 3a — Populate Neo4j `aura_memory` with tool entities.

Scans all TOOL_DEF exports from backend/app/tools/*.py and writes:
  (:Tool {name, description, domain, requires_key, file, status})
  (:Domain {name})
  (:Tool)-[:BELONGS_TO]->(:Domain)
  (:Tool)-[:RELATED_TO]->(:Tool)   # intra-domain cross-links

Run from project root:
    python backend/scripts/ingest_tool_graph.py

Or with --dry-run to preview without writing.
"""

from __future__ import annotations

import argparse
import importlib
import sys
from pathlib import Path

# ── Add backend to sys.path ───────────────────────────────────────────────────
_REPO_ROOT = Path(__file__).parent.parent.parent
_BACKEND = _REPO_ROOT / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

# ── Neo4j config ──────────────────────────────────────────────────────────────
NEO4J_URI      = "bolt://localhost:7687"
NEO4J_USER     = "neo4j"
NEO4J_PASSWORD = "aurapassword"
NEO4J_DATABASE = "neo4j"

# ── Domain taxonomy ───────────────────────────────────────────────────────────
# Maps tool filename stem → domain label.
# Unlisted tools fall into "general".
_DOMAIN_MAP: dict[str, str] = {
    # Search & Discovery
    "web_search":       "search",
    "browser":          "search",
    "exa_search":       "search",
    "jina_search":      "search",
    # Development
    "github_api":       "development",
    "git_tool":         "development",
    "bash_tool":        "development",
    "file_write_tool":  "development",
    # Knowledge & RAG
    "knowledge_mcp":    "knowledge",
    "legislation_mcp":  "knowledge",
    "lightrag_tool":    "knowledge",
    # Finance & Markets
    "sec_edgar":        "finance",
    "polygon_io":       "finance",
    "fmp_data":         "finance",
    "goat_defi":        "finance",
    # Science & Environment
    "openweathermap":   "science",
    "nasa_api":         "science",
    # Productivity & Collaboration
    "slack_api":        "productivity",
    "notion_api":       "productivity",
    "google_workspace": "productivity",
    "composio_gateway": "productivity",
    # Research & Analysis
    "citation_verifier":"research",
    "plan_tools":       "research",
    # Data Processing
    "bodo_dataframes":  "data",
    "apify_actors":     "data",
    # Automation & Scheduling
    "cron_tools":       "automation",
    "todo_tools":       "automation",
    "openapi_consumer": "automation",
    # System Utilities
    "system_tools":     "system",
    "snip_tool":        "system",
    "sleep_tool":       "system",
    "human_input":      "system",
}

# Tools that require an API key (graceful-fail on missing key)
_REQUIRES_KEY: set[str] = {
    "exa_search", "jina_search", "polygon_io", "fmp_data",
    "nasa_api", "github_api", "slack_api", "notion_api",
    "composio_gateway", "apify_actors", "openweathermap",
    "goat_defi",
}


def _collect_tool_defs() -> list[dict]:
    """Import all tool modules and collect their TOOL_DEF metadata."""
    tools_dir = _BACKEND / "app" / "tools"
    collected = []

    for py_file in sorted(tools_dir.glob("*.py")):
        if py_file.name.startswith("_"):
            continue
        stem = py_file.stem
        module_name = f"app.tools.{stem}"
        try:
            mod = importlib.import_module(module_name)
            tool_def = getattr(mod, "TOOL_DEF", None)
            if tool_def and isinstance(tool_def, dict):
                collected.append({
                    "name":         tool_def.get("name", stem),
                    "description":  tool_def.get("description", ""),
                    "domain":       _DOMAIN_MAP.get(stem, "general"),
                    "requires_key": stem in _REQUIRES_KEY,
                    "file":         str(py_file.relative_to(_BACKEND)),
                    "status":       "active",
                })
        except Exception as exc:
            print(f"  [skip] {module_name}: {exc}")

    return collected


def _ingest(tools: list[dict], dry_run: bool) -> None:
    """Write tool entities and domain relationships to Neo4j."""
    if dry_run:
        print(f"\n[dry-run] Would write {len(tools)} tool nodes:\n")
        for t in tools:
            print(f"  (:Tool {{name: {t['name']!r}, domain: {t['domain']!r}, requires_key: {t['requires_key']}}})")
        print()
        _preview_relations(tools)
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
        # ── Constraints + indexes ──────────────────────────────────────────────
        session.run("CREATE CONSTRAINT tool_name_unique IF NOT EXISTS FOR (t:Tool) REQUIRE t.name IS UNIQUE")
        session.run("CREATE CONSTRAINT domain_name_unique IF NOT EXISTS FOR (d:Domain) REQUIRE d.name IS UNIQUE")

        # ── Upsert domains ────────────────────────────────────────────────────
        domains = {t["domain"] for t in tools}
        for domain in domains:
            session.run("MERGE (:Domain {name: $name})", name=domain)
        print(f"  [neo4j] Upserted {len(domains)} Domain nodes")

        # ── Upsert tool nodes + BELONGS_TO edges ─────────────────────────────
        for t in tools:
            session.run(
                """
                MERGE (tool:Tool {name: $name})
                SET tool.description  = $description,
                    tool.domain       = $domain,
                    tool.requires_key = $requires_key,
                    tool.file         = $file,
                    tool.status       = $status
                WITH tool
                MATCH (d:Domain {name: $domain})
                MERGE (tool)-[:BELONGS_TO]->(d)
                """,
                **t,
            )
        print(f"  [neo4j] Upserted {len(tools)} Tool nodes with BELONGS_TO edges")

        # ── RELATED_TO edges — tools in same domain ───────────────────────────
        rel_count = session.run(
            """
            MATCH (a:Tool)-[:BELONGS_TO]->(d:Domain)<-[:BELONGS_TO]-(b:Tool)
            WHERE a.name < b.name
            MERGE (a)-[:RELATED_TO]->(b)
            RETURN count(*) AS cnt
            """
        ).single()["cnt"]
        print(f"  [neo4j] Created/verified {rel_count} RELATED_TO edges")

    driver.close()
    print(f"\n[done] {len(tools)} tools ingested into Neo4j ({NEO4J_DATABASE})")


def _preview_relations(tools: list[dict]) -> None:
    from collections import defaultdict
    by_domain: dict[str, list[str]] = defaultdict(list)
    for t in tools:
        by_domain[t["domain"]].append(t["name"])
    print("[dry-run] Domain groupings (RELATED_TO candidates):")
    for domain, names in sorted(by_domain.items()):
        if len(names) > 1:
            print(f"  {domain}: {', '.join(sorted(names))}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Ingest AURA tool registry into Neo4j graph")
    parser.add_argument("--dry-run", action="store_true", help="Preview without writing to Neo4j")
    args = parser.parse_args()

    print(f"[ingest_tool_graph] Scanning tools in {_BACKEND / 'app' / 'tools'}")
    tools = _collect_tool_defs()
    print(f"[ingest_tool_graph] Found {len(tools)} tools with TOOL_DEF")

    if not tools:
        print("[warn] No tools found — check that backend is in sys.path")
        sys.exit(1)

    _ingest(tools, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
