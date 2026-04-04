"""
AURA NX-Alpha — Memory Service (§27)
Three-layer memory architecture:
    Layer 1 — SQLite sliding window (interface agent only)
    Layer 2 — ChromaDB + e5-small embedding (all pipeline nodes)
    Layer 3 — FalkorDB / Graphiti knowledge graph (all pipeline nodes)

HYBRID SEARCH:
    Reciprocal Rank Fusion (k=60) merging semantic (ChromaDB, 0.7) + BM25 (FTS5, 0.3).

GRACEFUL DEGRADATION:
    If chromadb / sentence-transformers / graphiti / falkordb are not installed,
    those layers disable themselves. Layer 1 (SQLite) always works.

SINGLETON PATTERN:
    Call init_memory_service(settings) once at startup.
    Nodes call get_memory_service() to get the instance.
"""

from __future__ import annotations

import asyncio
import logging
import re
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Literal

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# OPTIONAL IMPORTS — guarded for hardware-less development
# ─────────────────────────────────────────────────────────────────────────────

try:
    import chromadb
    from chromadb.utils.embedding_functions import SentenceTransformerEmbeddingFunction
    _CHROMA_AVAILABLE = True
    logger.debug("[memory_service] chromadb available")
except ImportError:
    _CHROMA_AVAILABLE = False
    logger.info("[memory_service] chromadb not installed — Layer 2 disabled")

try:
    from neo4j import GraphDatabase as _neo4j_GraphDatabase
    _NEO4J_AVAILABLE = True
    logger.debug("[memory_service] neo4j available")
except ImportError:
    _NEO4J_AVAILABLE = False
    logger.info("[memory_service] neo4j not installed — Layer 3 disabled")

# Graphiti (full LLM-driven entity extraction) — Sprint 3+ only.
# Sprint 1: Layer 3 uses FalkorDB directly via Cypher.
_GRAPHITI_AVAILABLE = False

# ─────────────────────────────────────────────────────────────────────────────
# TYPES
# ─────────────────────────────────────────────────────────────────────────────

Role = Literal[
    "interface", "pm", "plan_validator", "area_decompose", "area_review",
    "sprint", "assembler", "proposer", "challenger", "verifier", "adversarial",
    "collector",
]

# Token budgets per role: how many tokens from each layer to include in context.
# These are sized for a 32K+ context window. _scale_budgets() trims them for smaller models.
_TOKEN_BUDGETS: dict[str, dict[str, int]] = {
    "interface":      {"layer1": 1600, "layer2": 2000, "layer3": 1000},
    "pm":             {"layer1":    0, "layer2": 1200, "layer3":  800},
    "plan_validator": {"layer1":    0, "layer2":  800, "layer3":  600},
    "area_decompose": {"layer1":    0, "layer2":  800, "layer3":  400},
    "area_review":    {"layer1":    0, "layer2": 1000, "layer3":  600},
    "sprint":         {"layer1":    0, "layer2": 1500, "layer3":  800},
    "assembler":      {"layer1":    0, "layer2": 1500, "layer3":  800},
    "proposer":       {"layer1":    0, "layer2": 1000, "layer3":  500},
    "challenger":     {"layer1":    0, "layer2": 2000, "layer3":  900},
    "verifier":       {"layer1":    0, "layer2":  500, "layer3":  800},
    "adversarial":    {"layer1":    0, "layer2": 1000, "layer3": 1000},
    "collector":      {"layer1":    0, "layer2":    0, "layer3":    0},
}

# Cosine distance above this threshold is considered orthogonal / irrelevant.
# e5-small-v2 cosine space: 0.0 = identical, 2.0 = fully opposite.
# 1.2 ≈ "mostly unrelated" — filters noise before it consumes token budget.
_DISTANCE_THRESHOLD: float = 1.2

# Session-level search cache TTL (seconds). Prevents re-embedding the same
# query multiple times in a single conversation session.
_CACHE_TTL: int = 300

# ─────────────────────────────────────────────────────────────────────────────
# QUERY EXPANSION
# Maps project-specific abbreviations → full names so FTS5 and semantic
# search can match docs that use either form.
# ─────────────────────────────────────────────────────────────────────────────

QUERY_EXPANSIONS: dict[str, str] = {
    "gc":        "Gleipnir Consulting",
    "gleipnir":  "Gleipnir Consulting",
    "nx":        "NX-Alpha AURA",
    "nx-alpha":  "NX-Alpha AURA",
    "aura":      "AURA NX-Alpha AI assistant",
    "eve":       "EVE Online",
    "eveo":      "EVE Online",
    "bhnyc":     "BHNYC New York campaign",
    "nomad":     "N.O.M.A.D. Nomad project",
    "sprint":    "sprint development task iteration",
    "falkordb":  "FalkorDB knowledge graph Layer 3",
    "chromadb":  "ChromaDB vector embeddings Layer 2",
    "lucas":     "Lucas user project owner",
}


def _expand_query(query: str) -> str:
    """
    Augment query with full-form expansions of known abbreviations.
    Only appends terms not already present. Whole-word matches only
    (e.g. "nx" won't fire inside "lynx").

    Example: "gc pricing sheet" → "gc pricing sheet Gleipnir Consulting"
    """
    lower = query.lower()
    extra: list[str] = []
    for abbrev, expansion in QUERY_EXPANSIONS.items():
        if re.search(r'\b' + re.escape(abbrev) + r'\b', lower):
            if expansion.lower() not in lower:
                extra.append(expansion)
    return (query + " " + " ".join(extra)) if extra else query


def _scale_budgets(budgets: dict[str, int], context_size: int) -> dict[str, int]:
    """
    Scale token budgets proportionally when the model's context window is small.
    Prevents memory context from crowding out the actual prompt + response.

    Tiers:
        <=  4 096 tokens → 40 %  (tiny models / Raspberry Pi class)
        <=  8 192 tokens → 65 %  (7B Q4 on 8 GB VRAM)
        <= 16 384 tokens → 85 %  (9B-14B models)
        >  16 384 tokens → 100 % (32K+ context, no scaling needed)
    """
    if context_size <= 4096:
        factor = 0.40
    elif context_size <= 8192:
        factor = 0.65
    elif context_size <= 16384:
        factor = 0.85
    else:
        return budgets  # no copy needed
    return {k: max(0, int(v * factor)) for k, v in budgets.items()}

# ─────────────────────────────────────────────────────────────────────────────
# MEMORY MARKER
# ─────────────────────────────────────────────────────────────────────────────

class MemoryMarkerObj:
    """
    Lightweight pointer to data stored in Layer 2 or 3.
    Agents pass markers instead of raw data to stay within token budgets.
    """
    __slots__ = ("marker_id", "type", "source_layer", "source_key", "summary", "retrieval_query")

    def __init__(
        self,
        *,
        type: str,
        source_layer: int,
        source_key: str,
        summary: str,
        retrieval_query: str,
    ):
        self.marker_id = f"mk_{uuid.uuid4().hex[:12]}"
        self.type = type                        # data_point | document | image | tool_result | analysis
        self.source_layer = source_layer        # 2 or 3
        self.source_key = source_key
        self.summary = summary
        self.retrieval_query = retrieval_query

    def to_dict(self) -> dict:
        return {
            "marker_id":       self.marker_id,
            "type":            self.type,
            "source_layer":    self.source_layer,
            "source_key":      self.source_key,
            "summary":         self.summary,
            "retrieval_query": self.retrieval_query,
        }


# ─────────────────────────────────────────────────────────────────────────────
# MEMORY SERVICE
# ─────────────────────────────────────────────────────────────────────────────

class MemoryService:
    """
    Universal memory service.
    Every pipeline node calls build_context() before inference
    and record() after producing output.
    """

    def __init__(self, settings):
        self._settings = settings
        mem = settings.memory

        # Layer 1 — SQLite (always available)
        self._l1_path = str(Path(mem.sqlite_db_path).expanduser())
        self._init_layer1()

        # Layer 2 — ChromaDB + e5-small
        self._collection = None
        self._embed_fn = None
        self._l2_available = False
        if _CHROMA_AVAILABLE:
            try:
                self._init_layer2(str(Path(mem.chroma_persist_dir).expanduser()))
            except Exception as exc:
                logger.warning("[memory_service] Layer 2 init failed: %s", exc)

        # Layer 3 — Neo4j (Bolt protocol; LightRAG entity extraction in lightrag_service.py)
        self._neo4j_driver = None
        self._neo4j_database = mem.neo4j_database
        self._l3_available = False
        self._l3_config = (mem.neo4j_uri, mem.neo4j_user, mem.neo4j_password, mem.neo4j_database)
        if _NEO4J_AVAILABLE:
            try:
                self._init_layer3(mem.neo4j_uri, mem.neo4j_user, mem.neo4j_password, mem.neo4j_database)
            except Exception as exc:
                logger.warning("[memory_service] Layer 3 init failed (will retry in background): %s", exc)

        # Session-level query result cache {cache_key → (timestamp, results)}
        # Prevents re-embedding the same query multiple times per session.
        self._search_cache: dict[str, tuple[float, list]] = {}

        logger.info(
            "[memory_service] Initialized. L1=sqlite L2=%s L3=%s",
            "ok" if self._l2_available else "disabled",
            "ok" if self._l3_available else "disabled",
        )

    # ── LAYER 1 — SQLite Sliding Window ──────────────────────────────────────

    def _init_layer1(self) -> None:
        """Create SQLite schema for all memory tables."""
        Path(self._l1_path).parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(self._l1_path) as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS sliding_window (
                    id              INTEGER PRIMARY KEY AUTOINCREMENT,
                    thread_id       TEXT    NOT NULL,
                    role            TEXT    NOT NULL,
                    content         TEXT    NOT NULL,
                    timestamp       REAL    NOT NULL,
                    reference_count INTEGER DEFAULT 0
                );
                CREATE INDEX IF NOT EXISTS idx_sw_thread ON sliding_window(thread_id);
                CREATE INDEX IF NOT EXISTS idx_sw_ts     ON sliding_window(timestamp);

                CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts
                USING fts5(
                    doc_id,
                    content,
                    thread_id    UNINDEXED,
                    agent_role   UNINDEXED,
                    area_id      UNINDEXED,
                    timestamp    UNINDEXED,
                    tokenize='porter unicode61'
                );

                CREATE TABLE IF NOT EXISTS memory_markers (
                    marker_id       TEXT PRIMARY KEY,
                    type            TEXT    NOT NULL,
                    source_layer    INTEGER NOT NULL,
                    source_key      TEXT    NOT NULL,
                    summary         TEXT    NOT NULL,
                    retrieval_query TEXT    NOT NULL,
                    created_at      REAL    NOT NULL
                );

                CREATE TABLE IF NOT EXISTS training_candidates (
                    id              INTEGER PRIMARY KEY AUTOINCREMENT,
                    source_type     TEXT    NOT NULL,
                    input_text      TEXT    NOT NULL,
                    output_text     TEXT    NOT NULL,
                    quality_signal  REAL    DEFAULT 0.0,
                    model_source    TEXT,
                    markers         TEXT,
                    trace_file      TEXT,
                    promoted        INTEGER DEFAULT 0,
                    created_at      REAL    NOT NULL
                );

                CREATE TABLE IF NOT EXISTS user_profile (
                    id            INTEGER PRIMARY KEY AUTOINCREMENT,
                    field         TEXT    NOT NULL,
                    value         TEXT    NOT NULL,
                    confidence    REAL    DEFAULT 0.5,
                    first_seen    REAL    NOT NULL,
                    last_seen     REAL    NOT NULL,
                    occurrence    INTEGER DEFAULT 1,
                    source_thread TEXT
                );
                CREATE UNIQUE INDEX IF NOT EXISTS idx_up_field_value ON user_profile(field, value);
                CREATE INDEX IF NOT EXISTS idx_up_field ON user_profile(field);

                CREATE TABLE IF NOT EXISTS skills (
                    id            TEXT    PRIMARY KEY,
                    title         TEXT    NOT NULL,
                    description   TEXT    NOT NULL,
                    procedure_md  TEXT    NOT NULL,
                    tags          TEXT    DEFAULT '[]',
                    source_thread TEXT,
                    source_type   TEXT    DEFAULT 'captured',
                    use_count     INTEGER DEFAULT 0,
                    last_used     REAL,
                    created_at    REAL    NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_skills_type ON skills(source_type);

                CREATE VIRTUAL TABLE IF NOT EXISTS skills_fts
                USING fts5(
                    skill_id     UNINDEXED,
                    title,
                    description,
                    procedure_md,
                    tags,
                    tokenize='porter unicode61'
                );
            """)
        logger.debug("[memory_service] Layer 1 schema initialized: %s", self._l1_path)

    def _get_sliding_window(self, thread_id: str, limit: int = 10) -> list[dict]:
        """Retrieve recent conversation turns for the given thread."""
        with sqlite3.connect(self._l1_path) as db:
            db.row_factory = sqlite3.Row
            rows = db.execute(
                """
                SELECT role, content, timestamp, reference_count
                FROM sliding_window
                WHERE thread_id = ?
                ORDER BY timestamp DESC
                LIMIT ?
                """,
                (thread_id, limit),
            ).fetchall()
        return [dict(r) for r in reversed(rows)]  # chronological order

    def _get_recent_turns_all_threads(self, limit: int = 20) -> list[dict]:
        """Retrieve the most recent conversation turns across ALL threads.
        Used as fallback when the current thread has no history yet."""
        with sqlite3.connect(self._l1_path) as db:
            db.row_factory = sqlite3.Row
            rows = db.execute(
                """
                SELECT role, content, timestamp, reference_count
                FROM sliding_window
                ORDER BY timestamp DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
        return [dict(r) for r in reversed(rows)]  # chronological order

    def _append_sliding_window(self, thread_id: str, role: str, content: str) -> None:
        """Append a turn to the sliding window. Evict old entries beyond max_turns.
        Also dual-writes to memory_fts (FTS5) and Layer 2 (ChromaDB) so conversation
        history is searchable via keyword and semantic search."""
        max_turns = getattr(self._settings.memory, "sliding_window_max_turns", 40)
        with sqlite3.connect(self._l1_path) as db:
            db.execute(
                "INSERT INTO sliding_window (thread_id, role, content, timestamp) VALUES (?,?,?,?)",
                (thread_id, role, content, time.time()),
            )
            # Evict oldest entries beyond max_turns for this thread
            count = db.execute(
                "SELECT COUNT(*) FROM sliding_window WHERE thread_id=?", (thread_id,)
            ).fetchone()[0]
            if count > max_turns:
                db.execute(
                    """
                    DELETE FROM sliding_window
                    WHERE thread_id=? AND id IN (
                        SELECT id FROM sliding_window WHERE thread_id=?
                        ORDER BY timestamp ASC LIMIT ?
                    )
                    """,
                    (thread_id, thread_id, count - max_turns),
                )

        # Dual-write to FTS5 + L2 for conversation search.
        # agent_role='conversation' distinguishes these from memory nodes.
        # area_id holds the message role (user|assistant) for filtering.
        doc_id = f"sw_{uuid.uuid4().hex[:16]}"
        ts_str = str(time.time())
        try:
            self._store_fts5(doc_id, content, {
                "thread_id":  thread_id,
                "agent_role": "conversation",
                "area_id":    role,
            })
        except Exception as exc:
            logger.debug("[memory_service] Conversation FTS5 write failed: %s", exc)
        self._store_layer2(doc_id, content, {
            "doc_id":     doc_id,
            "source":     "conversation",
            "thread_id":  thread_id,
            "conv_role":  role,
            "agent_role": "conversation",
            "timestamp":  ts_str,
        })

    def _persist_marker(self, marker: MemoryMarkerObj) -> None:
        """Store a memory marker in SQLite for O(1) lookups."""
        with sqlite3.connect(self._l1_path) as db:
            db.execute(
                """
                INSERT OR REPLACE INTO memory_markers
                (marker_id, type, source_layer, source_key, summary, retrieval_query, created_at)
                VALUES (?,?,?,?,?,?,?)
                """,
                (marker.marker_id, marker.type, marker.source_layer,
                 marker.source_key, marker.summary, marker.retrieval_query, time.time()),
            )

    # ── FTS5 BM25 Search ─────────────────────────────────────────────────────

    def _store_fts5(self, doc_id: str, content: str, metadata: dict) -> None:
        """Dual-write to FTS5 table alongside Layer 2."""
        with sqlite3.connect(self._l1_path) as db:
            db.execute(
                """
                INSERT INTO memory_fts (doc_id, content, thread_id, agent_role, area_id, timestamp)
                VALUES (?,?,?,?,?,?)
                """,
                (
                    doc_id, content,
                    metadata.get("thread_id", ""),
                    metadata.get("agent_role", ""),
                    metadata.get("area_id", ""),
                    str(time.time()),
                ),
            )

    def _query_fts5(
        self, query: str, limit: int = 10, thread_id: str | None = None
    ) -> list[dict]:
        """BM25 keyword search via FTS5."""
        # Tokenize into individual words — each wrapped in double-quotes so FTS5
        # treats them as literal terms (not operators). Joining without AND means
        # FTS5 uses implicit AND: all tokens must appear, in any order.
        # This is injection-safe and far more effective than phrase matching the
        # full query string (which required exact consecutive word order).
        import re as _re
        tokens = [t for t in _re.findall(r'\w+', query.lower()) if len(t) > 1]
        if not tokens:
            return []
        safe_query = " ".join(f'"{t}"' for t in tokens)
        with sqlite3.connect(self._l1_path) as db:
            db.row_factory = sqlite3.Row
            if thread_id:
                rows = db.execute(
                    """
                    SELECT doc_id, content, agent_role, area_id,
                           bm25(memory_fts) AS score
                    FROM memory_fts
                    WHERE memory_fts MATCH ? AND thread_id = ?
                    ORDER BY score
                    LIMIT ?
                    """,
                    (safe_query, thread_id, limit),
                ).fetchall()
            else:
                rows = db.execute(
                    """
                    SELECT doc_id, content, agent_role, area_id,
                           bm25(memory_fts) AS score
                    FROM memory_fts
                    WHERE memory_fts MATCH ?
                    ORDER BY score
                    LIMIT ?
                    """,
                    (safe_query, limit),
                ).fetchall()
        return [dict(r) for r in rows]

    # ── LAYER 2 — ChromaDB + e5-small ────────────────────────────────────────

    def _init_layer2(self, persist_dir: str) -> None:
        """Initialize ChromaDB with a single aura_memory collection."""
        Path(persist_dir).mkdir(parents=True, exist_ok=True)
        self._embed_fn = SentenceTransformerEmbeddingFunction(
            model_name="intfloat/e5-small-v2",
            device="cpu",
        )
        client = chromadb.PersistentClient(path=persist_dir)
        self._collection = client.get_or_create_collection(
            name="aura_memory",
            embedding_function=self._embed_fn,
            metadata={"hnsw:space": "cosine"},
        )
        self._l2_available = True
        logger.debug("[memory_service] Layer 2 (ChromaDB) ready at %s", persist_dir)

    @staticmethod
    def _sanitize_metadata(metadata: dict) -> dict:
        """Filter metadata to only include ChromaDB-compatible scalar values.
        ChromaDB rejects lists, dicts, None — only str, int, float, bool allowed."""
        clean = {}
        for k, v in metadata.items():
            if isinstance(v, (str, int, float, bool)):
                clean[k] = v
            elif v is None:
                clean[k] = ""  # ChromaDB rejects None; use empty string
        return clean

    def _store_layer2(self, doc_id: str, content: str, metadata: dict) -> None:
        """Embed and store content. e5-small requires 'passage:' prefix."""
        if not self._l2_available or self._collection is None:
            return
        try:
            self._collection.upsert(
                ids=[doc_id],
                documents=[f"passage: {content}"],
                metadatas=[self._sanitize_metadata(metadata)],
            )
        except Exception as exc:
            logger.warning("[memory_service] Layer 2 store failed: %s", exc)

    def _query_layer2(
        self, query: str, n_results: int = 5, where: dict | None = None
    ) -> list[dict]:
        """Semantic search via ChromaDB. e5-small requires 'query:' prefix."""
        if not self._l2_available or self._collection is None:
            return []
        try:
            doc_count = self._collection.count()
            if doc_count == 0:
                return []  # nothing to search
            kwargs: dict = {
                "query_texts": [f"query: {query}"],
                "n_results": min(n_results, doc_count),
                "include": ["documents", "metadatas", "distances"],
            }
            if where:
                kwargs["where"] = where
            result = self._collection.query(**kwargs)
            docs = result.get("documents", [[]])[0]
            metas = result.get("metadatas", [[]])[0]
            dists = result.get("distances", [[]])[0]
            # Filter out clearly irrelevant results (distance > threshold).
            # 1.2 in e5-small cosine space ≈ orthogonal — not worth injecting.
            return [
                {"content": d, "metadata": m, "distance": dist}
                for d, m, dist in zip(docs, metas, dists)
                if dist <= _DISTANCE_THRESHOLD
            ]
        except Exception as exc:
            logger.warning("[memory_service] Layer 2 query failed: %s", exc)
            return []

    async def _query_personal_knowledge(self, query: str, n_results: int = 5) -> list[dict]:
        """Query ChromaDB filtered to source='personal' documents."""
        results = self._query_layer2(query, n_results=n_results, where={"source": "personal"})
        out = []
        for item in results:
            raw = item.get("content", "")
            content = raw[len("passage: "):] if raw.startswith("passage: ") else raw
            meta = item.get("metadata", {})
            out.append({
                "content":  content,
                "doc_type": meta.get("type", ""),
                "title":    meta.get("title", ""),
                "score":    item.get("distance", 0.0),
            })
        return out

    def _hybrid_search(
        self, query: str, n_results: int = 5, thread_id: str | None = None
    ) -> list[dict]:
        """
        Reciprocal Rank Fusion: merge semantic (ChromaDB, 0.7) + BM25 (FTS5, 0.3).
        RRF(d) = Σ weight * confidence / (k + rank_i(d))  where k = 60

        Post-fusion improvements:
        - Query expansion: project abbreviations → full names before search
        - Distance-aware RRF: semantic weight scaled by cosine confidence
        - Source diversity penalty: 0.85 decay per repeated thread_id
        - Session cache: skips re-embedding identical queries within _CACHE_TTL
        """
        expanded = _expand_query(query)

        # Session cache check — skip ChromaDB re-embed for repeated queries
        cache_key = f"{hash(expanded)}_{n_results}_{thread_id}"
        now = time.time()
        if cache_key in self._search_cache:
            ts, cached = self._search_cache[cache_key]
            if now - ts < _CACHE_TTL:
                return cached

        k = 60
        scores: dict[str, float] = {}
        content_map: dict[str, dict] = {}

        # Semantic results — distance-aware RRF weighting
        sem = self._query_layer2(expanded, n_results=n_results * 2)
        for rank, item in enumerate(sem):
            doc_id = item.get("metadata", {}).get("doc_id", f"sem-{rank}")
            dist = item.get("distance", 1.0)
            # Normalize cosine distance [0, 2] → confidence [0, 1]
            # dist=0 → confidence=1.0 (identical), dist=2 → confidence=0.0 (opposite)
            confidence = max(0.0, 1.0 - dist / 2.0)
            scores[doc_id] = scores.get(doc_id, 0.0) + 0.7 * confidence / (k + rank + 1)
            content_map[doc_id] = item

        # BM25 results
        bm25 = self._query_fts5(expanded, limit=n_results * 2, thread_id=thread_id)
        for rank, item in enumerate(bm25):
            doc_id = item.get("doc_id", f"bm25-{rank}")
            scores[doc_id] = scores.get(doc_id, 0.0) + 0.3 / (k + rank + 1)
            if doc_id not in content_map:
                content_map[doc_id] = {"content": item.get("content", ""), "metadata": item}

        # Source diversity penalty — dampen results from already-seen thread_ids
        # so a single verbose thread can't crowd out all n_results slots.
        # 0.85^1 = 85%, 0.85^2 = 72%, 0.85^3 = 61% — soft, not a hard cap.
        _DIVERSITY_DECAY = 0.85
        seen_threads: dict[str, int] = {}
        penalized: list[tuple[str, float]] = []
        for doc_id, score in sorted(scores.items(), key=lambda x: x[1], reverse=True):
            tid = content_map.get(doc_id, {}).get("metadata", {}).get("thread_id", "")
            count = seen_threads.get(tid, 0)
            adjusted = score * (_DIVERSITY_DECAY ** count)
            seen_threads[tid] = count + 1
            penalized.append((doc_id, adjusted))

        # Re-sort after penalty, return top n_results
        ranked = sorted(penalized, key=lambda x: x[1], reverse=True)[:n_results]
        results = [content_map[doc_id] for doc_id, _ in ranked if doc_id in content_map]

        # Store in session cache; evict oldest entry if over 200 limit
        self._search_cache[cache_key] = (time.time(), results)
        if len(self._search_cache) > 200:
            oldest = min(self._search_cache, key=lambda k: self._search_cache[k][0])
            del self._search_cache[oldest]

        return results

    # ── LAYER 3 — Neo4j ───────────────────────────────────────────────────────

    def _init_layer3(self, uri: str, user: str, password: str, database: str) -> None:
        """
        Connect to Neo4j via the official Python driver (Bolt protocol).
        Conversation facts stored as :Fact nodes in the aura_memory database.
        LightRAG entity extraction writes to lightrag_knowledge database (lightrag_service.py).
        """
        self._neo4j_driver = _neo4j_GraphDatabase.driver(uri, auth=(user, password))
        self._neo4j_database = database
        self._neo4j_driver.verify_connectivity()
        # Ensure index on thread_id
        with self._neo4j_driver.session(database=database) as session:
            session.run(
                "CREATE INDEX fact_thread_id IF NOT EXISTS FOR (n:Fact) ON (n.thread_id)"
            )
        self._l3_available = True
        logger.debug("[memory_service] Layer 3 (Neo4j) connected at %s database:%s", uri, database)

    async def _store_layer3(self, content: str, thread_id: str, source: str) -> None:
        """
        Store a content episode as a :Fact node in Neo4j.
        Runs in executor — neo4j driver is synchronous.
        """
        if not self._l3_available or self._neo4j_driver is None:
            return
        try:
            loop = asyncio.get_running_loop()
            fact_id = uuid.uuid4().hex
            ts = time.time()

            def _write() -> None:
                with self._neo4j_driver.session(database=self._neo4j_database) as session:
                    session.run(
                        "CREATE (f:Fact {id: $id, content: $content, "
                        "thread_id: $tid, source: $src, timestamp: $ts})",
                        {"id": fact_id, "content": content[:2000],
                         "tid": thread_id, "src": source, "ts": ts},
                    )

            await loop.run_in_executor(None, _write)
        except Exception as exc:
            logger.warning("[memory_service] Layer 3 store failed: %s", exc)

    async def _query_layer3(self, query: str, limit: int = 5) -> list[dict]:
        """
        Query Neo4j for relevant :Fact nodes.
        Uses tokenized multi-word OR search with match-count ranking.
        """
        if not self._l3_available or self._neo4j_driver is None:
            return []
        try:
            loop = asyncio.get_running_loop()

            # Tokenize — drop stopwords, take top 5 signal words
            _stopwords = {"the", "a", "an", "is", "are", "was", "were", "and", "or", "of", "in", "to"}
            words = [w for w in re.findall(r'\w+', query.lower()) if w not in _stopwords][:5]

            if not words:
                return []

            params: dict = {"limit": limit, "min_match": min(2, len(words))}
            or_conditions: list[str] = []
            sum_cases: list[str] = []
            for i, word in enumerate(words):
                key = f"w{i}"
                params[key] = word
                or_conditions.append(f"toLower(f.content) CONTAINS ${key}")
                sum_cases.append(
                    f"CASE WHEN toLower(f.content) CONTAINS ${key} THEN 1 ELSE 0 END"
                )

            cypher = (
                "MATCH (f:Fact) WHERE " + " OR ".join(or_conditions) +
                " WITH f, (" + " + ".join(sum_cases) + ") AS match_count"
                " WHERE match_count >= $min_match"
                " RETURN f.content AS content, f.source AS source, "
                "f.thread_id AS thread_id, f.timestamp AS ts, match_count"
                " ORDER BY match_count DESC, f.timestamp DESC LIMIT $limit"
            )

            def _read() -> list[dict]:
                with self._neo4j_driver.session(database=self._neo4j_database) as session:
                    result = session.run(cypher, params)
                    return [
                        {
                            "fact":        record["content"],
                            "source":      record["source"],
                            "thread":      record["thread_id"],
                            "ts":          record["ts"],
                            "match_count": record["match_count"],
                        }
                        for record in result
                    ]

            return await loop.run_in_executor(None, _read)
        except Exception as exc:
            logger.warning("[memory_service] Layer 3 query failed: %s", exc)
            return []

    # ── DEDUP ─────────────────────────────────────────────────────────────────

    @staticmethod
    def _dedup_by_source(primary: list[dict], secondary: list[dict], threshold: float = 0.85) -> list[dict]:
        """
        Remove items from `secondary` whose content overlaps >threshold with any item
        in `primary` (Jaccard word overlap). Prevents personal/profile/skill docs
        from duplicating what's already in retrieved results.
        """
        def _sig(text: str) -> set[str]:
            return set(text.lower().split())

        p_sigs = [_sig(r.get("content", "")) for r in primary]

        out = []
        for item in secondary:
            s = _sig(item.get("content", ""))
            if not s:
                out.append(item)
                continue
            is_dup = any(
                len(s & p) / max(len(s), 1) > threshold
                for p in p_sigs
            )
            if not is_dup:
                out.append(item)
        return out

    def _get_recent_anchors(self, limit: int = 5) -> list[dict]:
        """Return the N most recently stored non-conversation memories from FTS5.

        Used as a session seed when L2/L3 query retrieval returns nothing (e.g.
        greeting messages). Bypasses semantic search — pure recency, so the
        model always has some memory context to anchor its identity.
        """
        try:
            with sqlite3.connect(self._l1_path) as db:
                db.row_factory = sqlite3.Row
                rows = db.execute(
                    """
                    SELECT content, agent_role, timestamp
                    FROM memory_fts
                    WHERE agent_role != 'conversation'
                    ORDER BY CAST(timestamp AS REAL) DESC
                    LIMIT ?
                    """,
                    (limit,),
                ).fetchall()
            return [
                {"content": r["content"], "metadata": {"agent_role": r["agent_role"], "timestamp": r["timestamp"]}}
                for r in rows
            ]
        except Exception as exc:
            logger.debug("[memory_service] _get_recent_anchors failed: %s", exc)
            return []

    # ── PUBLIC API: build_context() ───────────────────────────────────────────

    async def build_context(
        self,
        role: Role,
        task: str,
        thread_id: str,
        token_budget: int | None = None,
        markers_to_resolve: list[str] | None = None,
        context_size: int = 32768,
    ) -> dict:
        """
        Assemble context from all memory layers for a pipeline node.

        Args:
            context_size: Model's actual context window (tokens). Used to scale
                          memory budgets down so memory doesn't crowd the prompt.
                          Defaults to 32768 (no scaling).

        Returns:
            {
                "sliding_window": [...],       # Layer 1 (interface only)
                "retrieved":      [...],       # Layer 2 hybrid search results
                "facts":          [...],       # Layer 3 knowledge graph results
                "resolved_markers": {...},     # marker_id → full content (on demand)
                "token_estimate": int,
            }
        """
        budgets = _scale_budgets(
            _TOKEN_BUDGETS.get(role, {"layer1": 0, "layer2": 800, "layer3": 400}),
            context_size,
        )

        # Layer 1 — sliding window (interface agent only)
        sliding_window: list[dict] = []
        if budgets["layer1"] > 0:
            sliding_window = self._get_sliding_window(thread_id, limit=20)
            # Cross-thread fallback: if this thread has no history,
            # pull recent turns from ANY thread so AURA has conversation context
            if not sliding_window:
                sliding_window = self._get_recent_turns_all_threads(limit=20)

        # Expand query abbreviations once — used for both L2 and L3 lookups.
        # _hybrid_search() runs expand internally too, but L3 and personal
        # queries go through separate paths so we expand here as well.
        expanded_task = _expand_query(task) if task else task

        # Layer 2 — hybrid search (cross-thread: no thread_id filter)
        retrieved: list[dict] = []
        if budgets["layer2"] > 0 and expanded_task:
            retrieved = self._hybrid_search(expanded_task, n_results=15, thread_id=None)

        # Layer 3 + personal knowledge — run in parallel (asyncio.gather).
        # L3 (FalkorDB) runs in executor (~50-200ms), personal (ChromaDB) is sync (~20ms).
        # Sequential ordering was wasting ~200ms per context build.
        facts: list[dict] = []
        personal_raw: list[dict] = []
        if (budgets["layer3"] > 0 or budgets["layer2"] > 0) and expanded_task:
            l3_coro = (
                self._query_layer3(expanded_task, limit=10)
                if budgets["layer3"] > 0
                else asyncio.sleep(0, result=[])
            )
            l4_coro = (
                self._query_personal_knowledge(expanded_task, n_results=5)
                if budgets["layer2"] > 0
                else asyncio.sleep(0, result=[])
            )
            facts, personal_raw = await asyncio.gather(l3_coro, l4_coro)
        personal: list[dict] = []

        # Deduplicate personal results against retrieved to avoid injecting
        # the same content twice under different section headers.
        if personal_raw and retrieved:
            personal = self._dedup_by_source(retrieved, personal_raw)
        else:
            personal = personal_raw

        # Resolve requested markers
        resolved: dict[str, dict] = {}
        if markers_to_resolve:
            resolved = self._resolve_markers(markers_to_resolve)

        # File standby — search local + Drive indexes for files relevant to this task.
        # Only fires for substantive messages (>20 words) with known entity signals.
        # Returns metadata only (~5 tokens per file). Content never loaded here.
        standby_files: list[dict] = []
        if expanded_task and budgets["layer2"] > 0:
            word_count = len(expanded_task.split())
            # Only trigger for substantive messages — skip quick questions
            if word_count >= 6 and expanded_task != task:
                # expanded_task != task means _expand_query found a known entity
                try:
                    from app.service.file_index_service import search_files
                    _file_results = await search_files(expanded_task, max_results=8)
                    standby_files = [f.to_dict() for f in _file_results]
                except Exception as _fe:
                    logger.debug("[memory_service] File standby search failed: %s", _fe)

        # Rough token estimate (1 token ≈ 4 chars)
        # Standby files are metadata only so ~5 tokens each — negligible
        estimate = (
            sum(len(t.get("content", "")) for t in sliding_window) // 4 +
            sum(len(r.get("content", "")) for r in retrieved) // 4 +
            sum(len(f.get("fact", "")) for f in facts) // 4 +
            sum(len(p.get("content", "")) for p in personal) // 4 +
            len(standby_files) * 5
        )

        # Retrieval diagnostics — tuning visibility without performance cost
        if retrieved:
            dists = [r.get("distance", 0.0) for r in retrieved]
            logger.debug(
                "[memory] role=%s L2=%d results (dist %.2f–%.2f) L3=%d facts personal=%d",
                role, len(retrieved), min(dists), max(dists), len(facts), len(personal),
            )
        else:
            logger.debug("[memory] role=%s L2=0 results L3=%d facts personal=%d", role, len(facts), len(personal))

        # Session seed: force-load recent anchors when L2+L3 return nothing.
        # Covers cold-start greetings ("Hello") where semantic search has no hits
        # but the model still needs memory context to avoid claiming to be stateless.
        anchors: list[dict] = []
        if not retrieved and not facts and not personal:
            anchors = self._get_recent_anchors(limit=5)
            if anchors:
                logger.debug("[memory] role=%s using %d recency anchors (L2/L3 empty)", role, len(anchors))

        # LightRAG — entity-aware knowledge graph query (inbound injection)
        # Complements L3 Neo4j: LightRAG uses entity extraction + relational traversal
        # rather than simple keyword matching, surfacing cross-document insights.
        lightrag_results: list[dict] = []
        try:
            from app.service.lightrag_service import LightRAGService
            lg = LightRAGService.get_instance()
            if lg._available:
                res = await asyncio.wait_for(lg.query(task, mode="hybrid"), timeout=5.0)
                if res.get("success") and res.get("result"):
                    lightrag_results = [{"content": res["result"], "source": "lightrag"}]
                    logger.debug("[memory] role=%s LightRAG: %d chars",
                                 role, len(res["result"]))
        except asyncio.TimeoutError:
            logger.warning("[memory] LightRAG query timed out after 5s — skipping")
        except Exception as exc:
            logger.debug("[memory] LightRAG query failed (non-fatal): %s", exc)

        return {
            "sliding_window":   sliding_window,
            "retrieved":        retrieved,
            "facts":            facts,
            "personal":         personal,
            "anchors":          anchors,
            "standby_files":    standby_files,
            "resolved_markers": resolved,
            "token_estimate":   estimate,
            "lightrag":         lightrag_results,
        }

    def _resolve_markers(self, marker_ids: list[str]) -> dict[str, dict]:
        """Fetch full content for a list of marker IDs."""
        resolved = {}
        for mid in marker_ids:
            row = self._get_marker(mid)
            if row:
                resolved[mid] = row
        return resolved

    def _get_marker(self, marker_id: str) -> dict | None:
        with sqlite3.connect(self._l1_path) as db:
            db.row_factory = sqlite3.Row
            row = db.execute(
                "SELECT * FROM memory_markers WHERE marker_id=?", (marker_id,)
            ).fetchone()
        return dict(row) if row else None

    # ── PUBLIC API: record() ──────────────────────────────────────────────────

    async def record(
        self,
        role: Role,
        content: str | dict,
        thread_id: str,
        metadata: dict | None = None,
        markers: list | None = None,
    ) -> list[MemoryMarkerObj]:
        """
        Store agent output across all memory layers.

        Returns:
            list of MemoryMarker objects created during this storage pass
        """
        if metadata is None:
            metadata = {}

        # Normalize content to string
        if isinstance(content, dict):
            import json as _json
            content_str = _json.dumps(content, ensure_ascii=False)
        else:
            content_str = str(content)

        doc_id = f"doc_{uuid.uuid4().hex[:16]}"
        meta = {
            "doc_id":     doc_id,
            "thread_id":  thread_id,
            "agent_role": role,
            "area_id":    metadata.get("area_id", ""),
            "timestamp":  str(time.time()),
            **metadata,
        }

        created_markers: list[MemoryMarkerObj] = []

        # 1. Layer 1 — sliding window (interface agent only)
        if role == "interface":
            for msg in metadata.get("messages", []):
                self._append_sliding_window(thread_id, msg.get("role", role), msg.get("content", ""))

        # 2. Layer 2 + FTS5 dual-write
        self._store_layer2(doc_id, content_str, meta)
        try:
            self._store_fts5(doc_id, content_str, meta)
        except Exception as exc:
            logger.warning("[memory_service] FTS5 store failed: %s", exc)

        # 3. Create a memory marker pointing to this document
        marker = MemoryMarkerObj(
            type="document",
            source_layer=2,
            source_key=doc_id,
            summary=content_str[:120] + ("..." if len(content_str) > 120 else ""),
            retrieval_query=metadata.get("task", content_str[:80]),
        )
        self._persist_marker(marker)
        created_markers.append(marker)

        # 4. Layer 3 — fact extraction (async, non-blocking)
        def _l3_done(t: asyncio.Task) -> None:
            if not t.cancelled() and t.exception():
                logger.warning("[memory_service] Layer 3 store failed: %s", t.exception())
        task = asyncio.create_task(
            self._store_layer3(content_str, thread_id, f"role:{role}")
        )
        task.add_done_callback(_l3_done)

        # 5. LightRAG entity extraction — handled by FTS5 sync worker in
        #    lightrag_service.py. The worker polls memory_fts for new entries
        #    (newest-first) and enqueues them automatically, covering ALL
        #    ingestion paths including record(), personal docs, git, etc.

        return created_markers

    # ── DEFERRED L3 CONNECT ──────────────────────────────────────────────────

    async def retry_layer3_connect(self, max_attempts: int = 5, delay: float = 10.0) -> None:
        """
        Retry Neo4j connection in the background.
        Called when initial connect fails (Docker still starting up).
        """
        if self._l3_available or not _NEO4J_AVAILABLE:
            return
        uri, user, password, database = self._l3_config
        for attempt in range(1, max_attempts + 1):
            await asyncio.sleep(delay)
            try:
                self._init_layer3(uri, user, password, database)
                logger.info("[memory_service] Layer 3 connected on retry %d/%d", attempt, max_attempts)
                return
            except Exception as exc:
                logger.debug("[memory_service] Layer 3 retry %d/%d failed: %s", attempt, max_attempts, exc)
        logger.warning("[memory_service] Layer 3 failed after %d retries — L3 disabled for this session", max_attempts)

    # ── MAINTENANCE ───────────────────────────────────────────────────────────

    async def run_idle_maintenance(self) -> None:
        """
        CPU-only maintenance tasks run when the interface engine has been idle.
        - Compact FTS5 index
        - Future: graph edge pruning, vector dedup (Sprint 3+)
        """
        try:
            with sqlite3.connect(self._l1_path) as db:
                db.execute("INSERT INTO memory_fts(memory_fts) VALUES('optimize')")
            logger.debug("[memory_service] FTS5 optimized")
        except Exception as exc:
            logger.warning("[memory_service] Idle maintenance failed: %s", exc)


# ─────────────────────────────────────────────────────────────────────────────
# SINGLETON
# ─────────────────────────────────────────────────────────────────────────────

_memory_service: MemoryService | None = None


def init_memory_service(settings) -> MemoryService:
    """Called once at app startup (main.py lifespan)."""
    global _memory_service
    _memory_service = MemoryService(settings)
    return _memory_service


def get_memory_service() -> MemoryService | None:
    """Return the running MemoryService instance, or None if not initialized."""
    return _memory_service
