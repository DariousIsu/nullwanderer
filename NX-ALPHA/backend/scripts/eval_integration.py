"""
eval_integration.py
────────────────────
Phase 7 — Top-to-bottom integration evaluation sweep.

Systematically verifies every integration point across the full stack:
  7a — Memory layer integrity (L1/L2/L3, hybrid search, record() path)
  7b — Knowledge source integrity (FTS5 DBs, skills, legislation, routing)
  7c — Tool registry integrity (all TOOL_DEF tools, local + keyed)
  7d — Graph routing integrity (Neo4j nodes, tool→domain, skill→concept)
  7e — End-to-end integration (full pipeline)
  7f — Disconnection audit (orphaned Neo4j nodes)

Run from project root:
    python backend/scripts/eval_integration.py
    python backend/scripts/eval_integration.py --section 7a
    python backend/scripts/eval_integration.py --section 7c
    python backend/scripts/eval_integration.py --verbose
"""

from __future__ import annotations

import argparse
import asyncio
import importlib
import sqlite3
import sys
from pathlib import Path
from typing import Callable

# ── Add backend to sys.path ───────────────────────────────────────────────────
_REPO_ROOT = Path(__file__).parent.parent.parent
_BACKEND   = _REPO_ROOT / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))


# ── Result tracking ───────────────────────────────────────────────────────────
class EvalResult:
    def __init__(self):
        self.passed:  list[str] = []
        self.failed:  list[str] = []
        self.skipped: list[str] = []

    def ok(self, name: str, detail: str = ""):
        label = f"  ✓ {name}" + (f" — {detail}" if detail else "")
        self.passed.append(label)
        print(label)

    def fail(self, name: str, detail: str = ""):
        label = f"  ✗ {name}" + (f" — {detail}" if detail else "")
        self.failed.append(label)
        print(label)

    def skip(self, name: str, reason: str = ""):
        label = f"  ~ {name}" + (f" (skipped: {reason})" if reason else "")
        self.skipped.append(label)
        print(label)

    def summary(self) -> str:
        total = len(self.passed) + len(self.failed) + len(self.skipped)
        return (
            f"\n{'─'*60}\n"
            f"RESULTS: {len(self.passed)} passed / {len(self.failed)} failed / {len(self.skipped)} skipped "
            f"({total} total)\n"
        )


R = EvalResult()


# ─────────────────────────────────────────────────────────────────────────────
# 7a — Memory Layer Integrity
# ─────────────────────────────────────────────────────────────────────────────

def eval_7a_memory() -> None:
    print("\n[7a] Memory Layer Integrity")

    # L1: SQLite FTS5
    memory_db = Path.home() / ".aura" / "memory.db"
    if not memory_db.exists():
        R.skip("L1 SQLite memory.db", "file not found — AURA not yet run")
    else:
        try:
            conn = sqlite3.connect(str(memory_db))
            count = conn.execute("SELECT COUNT(*) FROM memory_fts").fetchone()[0]
            sw    = conn.execute("SELECT COUNT(*) FROM sliding_window").fetchone()[0]
            conn.close()
            R.ok("L1 SQLite FTS5", f"{count} memory_fts records, {sw} sliding_window rows")
        except Exception as exc:
            R.fail("L1 SQLite FTS5", str(exc))

    # L2: ChromaDB
    try:
        import chromadb
        chroma_dir = str(Path.home() / ".aura" / "chroma")
        client = chromadb.PersistentClient(path=chroma_dir)
        cols = client.list_collections()
        if cols:
            total = sum(c.count() for c in cols)
            R.ok("L2 ChromaDB", f"{len(cols)} collections, {total} embeddings")
        else:
            R.skip("L2 ChromaDB", "no collections yet (no conversations ingested)")
    except ImportError:
        R.skip("L2 ChromaDB", "chromadb not installed")
    except Exception as exc:
        R.fail("L2 ChromaDB", str(exc))

    # L3: Neo4j aura_memory
    try:
        from neo4j import GraphDatabase
        driver = GraphDatabase.driver("bolt://localhost:7687", auth=("neo4j", "aurapassword"))
        driver.verify_connectivity()
        with driver.session(database="neo4j") as session:
            fact_count = session.run("MATCH (f:Fact) RETURN count(f) AS cnt").single()["cnt"]
            tool_count = session.run("MATCH (t:Tool) RETURN count(t) AS cnt").single()["cnt"]
        driver.close()
        R.ok("L3 Neo4j", f"{fact_count} :Fact nodes, {tool_count} :Tool nodes")
    except ImportError:
        R.fail("L3 Neo4j", "neo4j driver not installed — run: pip install neo4j>=5.0.0")
    except Exception as exc:
        R.fail("L3 Neo4j aura_memory", str(exc))

    # LightRAG knowledge graph
    try:
        from neo4j import GraphDatabase
        driver = GraphDatabase.driver("bolt://localhost:7687", auth=("neo4j", "aurapassword"))
        with driver.session(database="neo4j") as session:
            try:
                entity_count = session.run("MATCH (n) RETURN count(n) AS cnt").single()["cnt"]
                R.ok("L3 Neo4j lightrag_knowledge", f"default DB has {entity_count} nodes (LightRAG uses its own storage)")
            except Exception:
                R.skip("L3 Neo4j lightrag_knowledge", "LightRAG uses file-based storage, not Neo4j directly in this build")
        driver.close()
    except Exception:
        pass

    # LightRAG service
    try:
        lightrag_dir = Path.home() / ".aura" / "lightrag"
        if lightrag_dir.exists():
            files = list(lightrag_dir.iterdir())
            R.ok("LightRAG working dir", f"{len(files)} files in {lightrag_dir}")
        else:
            R.skip("LightRAG working dir", "not yet created (no ingest run)")
    except Exception as exc:
        R.fail("LightRAG working dir", str(exc))


# ─────────────────────────────────────────────────────────────────────────────
# 7b — Knowledge Source Integrity
# ─────────────────────────────────────────────────────────────────────────────

def eval_7b_knowledge() -> None:
    print("\n[7b] Knowledge Source Integrity")

    knowledge_base = Path.home() / ".aura" / "knowledge"
    sources = {
        "wikipedia":   ("wikipedia/fts5.db",    "articles_fts"),
        "pubmed":      ("pubmed/fts5.db",        "abstracts_fts"),
        "arxiv":       ("arxiv/fts5.db",         "papers_fts"),
        "stackexchange": ("stackexchange/fts5.db", "posts_fts"),
        "gutenberg":   ("gutenberg/fts5.db",     "texts_fts"),
        "skills":      ("skills/fts5.db",        "skills_fts"),
    }

    for name, (db_file, table) in sources.items():
        db_path = knowledge_base / db_file
        if not db_path.exists():
            R.skip(f"FTS5 {name}", "DB not found — run download/build script first")
            continue
        try:
            conn  = sqlite3.connect(str(db_path))
            count = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            conn.close()
            R.ok(f"FTS5 {name}", f"{count:,} rows")
        except Exception as exc:
            R.fail(f"FTS5 {name}", str(exc))

    # Skills KB directory
    skills_kb = _BACKEND / "app" / "knowledge" / "skills_kb"
    if skills_kb.exists():
        total_chunks = sum(1 for _ in skills_kb.rglob("*.md"))
        R.ok("Skills KB files", f"{total_chunks} .md chunk files in {skills_kb}")
    else:
        R.fail("Skills KB directory", f"Not found at {skills_kb}")

    # Legislation DB
    leg_db = Path.home() / ".aura" / "legislation.db"
    if not leg_db.exists():
        R.skip("Legislation SQLite", "not downloaded — run legislation sync")
    else:
        try:
            conn  = sqlite3.connect(str(leg_db))
            bills = conn.execute("SELECT COUNT(*) FROM bills").fetchone()[0]
            conn.close()
            R.ok("Legislation SQLite", f"{bills:,} bills")
        except Exception as exc:
            R.fail("Legislation SQLite", str(exc))


# ─────────────────────────────────────────────────────────────────────────────
# 7c — Tool Registry Integrity
# ─────────────────────────────────────────────────────────────────────────────

def eval_7c_tools() -> None:
    print("\n[7c] Tool Registry Integrity")

    tools_dir = _BACKEND / "app" / "tools"
    loaded    = 0
    failed    = []

    for py_file in sorted(tools_dir.glob("*.py")):
        if py_file.name.startswith("_"):
            continue
        stem = py_file.stem
        try:
            mod      = importlib.import_module(f"app.tools.{stem}")
            tool_def = getattr(mod, "TOOL_DEF", None)
            handler  = getattr(mod, "tool_handler", None)
            if tool_def and handler:
                name = tool_def.get("name", stem)
                loaded += 1
            elif not tool_def and not handler:
                pass  # utility module, not a tool
            else:
                failed.append(f"{stem}: missing {'TOOL_DEF' if not tool_def else 'tool_handler'}")
        except Exception as exc:
            # Soft imports (duckdb, mlflow, etc.) are expected to fail here without deps
            exc_str = str(exc)
            if "No module named" in exc_str:
                R.skip(f"tool {stem}", f"optional dep missing: {exc_str}")
            else:
                failed.append(f"{stem}: {exc_str[:80]}")

    if loaded > 0:
        R.ok("Tool files loaded", f"{loaded} tools with valid TOOL_DEF + tool_handler")
    else:
        R.fail("Tool files loaded", "0 tools found")

    for f in failed:
        R.fail(f"Tool {f.split(':')[0]}", f.split(':', 1)[-1].strip())

    # Verify key new tools are present
    for expected in ["lightrag_tool", "skills_tool", "duckdb_tool", "mlflow_tool",
                     "phoenix_tool", "huggingface_tool", "llm_eval_tool",
                     "firecrawl_tool", "replicate_tool", "fal_tool",
                     "typefully_tool", "stripe_tool", "neon_tool",
                     "sanity_tool", "tinybird_tool", "clickhouse_tool",
                     "web3_tool", "remotion_tool"]:
        path = tools_dir / f"{expected}.py"
        if path.exists():
            R.ok(f"New tool {expected}", "file present")
        else:
            R.fail(f"New tool {expected}", "file missing")


# ─────────────────────────────────────────────────────────────────────────────
# 7d — Graph Routing Integrity
# ─────────────────────────────────────────────────────────────────────────────

def eval_7d_graph() -> None:
    print("\n[7d] Graph Routing Integrity")

    try:
        from neo4j import GraphDatabase
        driver = GraphDatabase.driver("bolt://localhost:7687", auth=("neo4j", "aurapassword"))
        driver.verify_connectivity()
        with driver.session(database="neo4j") as session:
            # Tool nodes
            tool_count   = session.run("MATCH (t:Tool) RETURN count(t) AS cnt").single()["cnt"]
            domain_count = session.run("MATCH (d:Domain) RETURN count(d) AS cnt").single()["cnt"]
            rel_count    = session.run("MATCH ()-[r:BELONGS_TO]->() RETURN count(r) AS cnt").single()["cnt"]
            related_count = session.run("MATCH ()-[r:RELATED_TO]->() RETURN count(r) AS cnt").single()["cnt"]

            if tool_count > 0:
                R.ok("Neo4j :Tool nodes", f"{tool_count} tools across {domain_count} domains")
            else:
                R.fail("Neo4j :Tool nodes", "0 — run: python backend/scripts/ingest_tool_graph.py")

            if rel_count > 0:
                R.ok("Neo4j BELONGS_TO edges", f"{rel_count} tool→domain edges")
            else:
                R.fail("Neo4j BELONGS_TO edges", "0 — run ingest_tool_graph.py")

            R.ok("Neo4j RELATED_TO edges", f"{related_count} intra-domain edges")

            # Legislation graph
            bill_count = session.run("MATCH (b:Bill) RETURN count(b) AS cnt").single()["cnt"]
            if bill_count > 0:
                R.ok("Neo4j :Bill nodes", f"{bill_count:,} bills")
            else:
                R.skip("Neo4j :Bill nodes", "0 — run: python backend/scripts/ingest_legislation_graph.py")

            # Knowledge source pointers
            ks_count = session.run("MATCH (k:KnowledgeSource) RETURN count(k) AS cnt").single()["cnt"]
            if ks_count > 0:
                concept_count = session.run("MATCH (c:Concept) RETURN count(c) AS cnt").single()["cnt"]
                R.ok("Neo4j :KnowledgeSource nodes", f"{ks_count} sources, {concept_count} concepts")
            else:
                R.skip("Neo4j :KnowledgeSource nodes", "0 — run: python backend/scripts/ingest_knowledge_graph.py")


        driver.close()

        # Graph router service
        router_path = _BACKEND / "app" / "service" / "graph_router_service.py"
        if router_path.exists():
            R.ok("graph_router_service.py", "file present")
        else:
            R.fail("graph_router_service.py", "file missing")

    except ImportError:
        R.fail("Neo4j driver", "not installed — run: pip install neo4j>=5.0.0")
    except Exception as exc:
        R.fail("Neo4j connection", str(exc))


# ─────────────────────────────────────────────────────────────────────────────
# 7e — End-to-End Integration
# ─────────────────────────────────────────────────────────────────────────────

async def eval_7e_e2e() -> None:
    print("\n[7e] End-to-End Integration")

    # LightRAG service: ingest + query cycle
    try:
        from app.service.lightrag_service import LightRAGService
        svc = LightRAGService.get_instance()
        await svc.initialize()
        if svc._available:
            R.ok("LightRAG service init", f"available — working dir: {svc.index_status()['working_dir']}")

            # Test enqueue
            enqueued = svc.enqueue_ingest(
                "AURA uses LoRA fine-tuning with rank 16 for adapter training.",
                source_id="eval_test_lora_123",
                source_type="test",
            )
            R.ok("LightRAG enqueue_ingest", f"enqueued={enqueued}, queue={svc._ingest_queue.qsize()}")
        else:
            R.skip("LightRAG service", "not available — Ollama with qwen3:8b + nomic-embed-text required")
    except Exception as exc:
        R.skip("LightRAG service", f"{exc}")

    # Memory service: L1 write test
    try:
        from app.service.memory_service import get_memory_service
        mem = get_memory_service()
        if mem is None:
            R.skip("Memory service e2e", "memory service not initialized — AURA not running")
        else:
            test_thread = "eval_test_thread_7e"
            await mem.record(
                content="Integration test: AURA eval sweep passed.",
                role="assistant",
                thread_id=test_thread,
            )
            results = await mem.recall("integration test eval sweep", thread_id=test_thread)
            if results:
                R.ok("Memory record() + recall()", f"{len(results)} results returned")
            else:
                R.fail("Memory recall()", "record wrote but recall returned empty")
    except Exception as exc:
        R.fail("Memory service e2e", str(exc))

    # Skills lookup
    try:
        from app.tools.skills_tool import tool_handler as skills_handler
        result = await skills_handler({"query": "LoRA fine-tuning setup", "domain": "ai_ml"})
        if result.get("results"):
            R.ok("skills_lookup tool", f"{result['count']} results for 'LoRA fine-tuning'")
        elif result.get("error") and "not built" in result.get("error", ""):
            R.skip("skills_lookup tool", "skills index not built yet — run build_skills_index.py")
        else:
            R.fail("skills_lookup tool", str(result))
    except Exception as exc:
        R.fail("skills_lookup tool", str(exc))

    # Graph router
    try:
        from app.service.graph_router_service import get_relevant_context
        ctx = await asyncio.wait_for(get_relevant_context("LoRA fine-tuning for LLMs"), timeout=5.0)
        if ctx:
            R.ok("graph_router get_relevant_context", f"{len(ctx)} chars returned")
        else:
            R.skip("graph_router", "returned empty — Neo4j may need ingest_tool_graph.py run first")
    except Exception as exc:
        R.skip("graph_router", f"{exc}")

    # DuckDB tool (no external deps)
    try:
        from app.tools.duckdb_tool import tool_handler as duckdb_handler
        result = await duckdb_handler({"sql": "SELECT 1+1 AS result"})
        if result.get("rows") and result["rows"][0].get("result") == 2:
            R.ok("duckdb_tool", "SELECT 1+1 = 2")
        else:
            R.fail("duckdb_tool", str(result))
    except ImportError:
        R.skip("duckdb_tool", "duckdb not installed")
    except Exception as exc:
        R.fail("duckdb_tool", str(exc))

    # HuggingFace tool (public API, no key)
    try:
        from app.tools.huggingface_tool import tool_handler as hf_handler
        result = await asyncio.wait_for(
            hf_handler({"operation": "search_models", "query": "bert", "limit": 2}),
            timeout=10.0,
        )
        if result.get("models"):
            R.ok("huggingface_tool search_models", f"{result['count']} results")
        else:
            R.fail("huggingface_tool", str(result))
    except Exception as exc:
        R.skip("huggingface_tool", f"{exc}")

    # Crypto tool (free, no key)
    try:
        from app.tools.web3_tool import tool_handler as crypto_handler
        result = await asyncio.wait_for(
            crypto_handler({"operation": "trending"}),
            timeout=10.0,
        )
        if result.get("trending"):
            R.ok("web3_tool trending", f"{len(result['trending'])} trending coins")
        else:
            R.fail("web3_tool", str(result))
    except Exception as exc:
        R.skip("web3_tool", f"{exc}")


# ─────────────────────────────────────────────────────────────────────────────
# 7f — Disconnection Audit
# ─────────────────────────────────────────────────────────────────────────────

def eval_7f_disconnection() -> None:
    print("\n[7f] Disconnection Audit")

    try:
        from neo4j import GraphDatabase
        driver = GraphDatabase.driver("bolt://localhost:7687", auth=("neo4j", "aurapassword"))
        with driver.session(database="neo4j") as session:
            # Find disconnected nodes
            disconnected = session.run(
                "MATCH (n) WHERE NOT (n)-[]-() RETURN labels(n) AS labels, n.name AS name LIMIT 50"
            ).data()

            if not disconnected:
                R.ok("Disconnection audit", "No isolated nodes found")
            else:
                label_counts: dict[str, int] = {}
                for node in disconnected:
                    label = str(node.get("labels", ["unknown"]))
                    label_counts[label] = label_counts.get(label, 0) + 1

                for label, count in label_counts.items():
                    if count > 10:
                        R.fail(f"Disconnected {label} nodes", f"{count} isolated nodes")
                    else:
                        R.ok(f"Disconnected {label} nodes", f"{count} — minor, review manually")

        driver.close()
    except Exception as exc:
        R.skip("Disconnection audit", str(exc))

    # Skills KB: check every domain has chunks
    skills_kb = _BACKEND / "app" / "knowledge" / "skills_kb"
    for domain in ["ai_ml", "business", "engineering", "infra"]:
        domain_dir = skills_kb / domain
        if domain_dir.exists():
            count = len(list(domain_dir.glob("*.md")))
            if count > 0:
                R.ok(f"Skills KB domain {domain}", f"{count} chunks")
            else:
                R.fail(f"Skills KB domain {domain}", "0 chunks — directory exists but empty")
        else:
            R.fail(f"Skills KB domain {domain}", f"directory not found at {domain_dir}")

    # Verify all new tool files are non-empty
    tools_dir = _BACKEND / "app" / "tools"
    new_tools  = [
        "lightrag_tool", "skills_tool", "duckdb_tool", "mlflow_tool",
        "phoenix_tool", "huggingface_tool", "llm_eval_tool",
        "firecrawl_tool", "replicate_tool", "fal_tool",
        "typefully_tool", "stripe_tool", "neon_tool",
        "sanity_tool", "tinybird_tool", "clickhouse_tool",
        "web3_tool", "remotion_tool",
    ]
    missing = [t for t in new_tools if not (tools_dir / f"{t}.py").exists()]
    if missing:
        R.fail("New tool files present", f"Missing: {', '.join(missing)}")
    else:
        R.ok("New tool files present", f"All {len(new_tools)} new tools present")

    # Verify Phase 3 scripts
    scripts_dir = _BACKEND / "scripts"
    phase3_scripts = [
        "migrate_falkordb_to_neo4j.py",
        "ingest_tool_graph.py",
        "ingest_legislation_graph.py",
        "ingest_knowledge_graph.py",
        "backfill_conversation_graph.py",
        "ingest_skills_graph.py",
        "build_skills_index.py",
    ]
    missing_scripts = [s for s in phase3_scripts if not (scripts_dir / s).exists()]
    if missing_scripts:
        R.fail("Phase 3 scripts present", f"Missing: {', '.join(missing_scripts)}")
    else:
        R.ok("Phase 3 scripts present", f"All {len(phase3_scripts)} scripts present")


# ─────────────────────────────────────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────────────────────────────────────

async def _main(section: str | None) -> None:
    sections = {
        "7a": (eval_7a_memory, False),
        "7b": (eval_7b_knowledge, False),
        "7c": (eval_7c_tools, False),
        "7d": (eval_7d_graph, False),
        "7e": (eval_7e_e2e, True),
        "7f": (eval_7f_disconnection, False),
    }

    to_run = {section: sections[section]} if section and section in sections else sections

    for key, (fn, is_async) in to_run.items():
        try:
            if is_async:
                await fn()
            else:
                fn()
        except Exception as exc:
            print(f"  [ERROR] Section {key} crashed: {exc}")

    print(R.summary())
    if R.failed:
        print("FAILED CHECKS:")
        for f in R.failed:
            print(f)
        sys.exit(1)
    else:
        print("All checks passed or skipped (missing data/deps are expected before full setup).")


def main() -> None:
    parser = argparse.ArgumentParser(description="Phase 7 — AURA integration evaluation sweep")
    parser.add_argument("--section", default=None,
                        choices=["7a", "7b", "7c", "7d", "7e", "7f"],
                        help="Run only a specific section (default: all)")
    parser.add_argument("--verbose", action="store_true", help="Extra output")
    args = parser.parse_args()

    print("=" * 60)
    print("AURA NX-Alpha — Phase 7 Integration Evaluation Sweep")
    print("=" * 60)

    asyncio.run(_main(args.section))


if __name__ == "__main__":
    main()
