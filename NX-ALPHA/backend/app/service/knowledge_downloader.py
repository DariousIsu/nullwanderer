"""
AURA NX-Alpha — Knowledge Downloader Service
Downloads and indexes large offline knowledge databases for local RAG.

SUPPORTED SOURCES:
    wikipedia     — Full English Wikipedia nopic ZIM  (~50 GB)
    wikipedia_*   — Topic-specific Wikipedia ZIMs     (~2-6 GB each)
    stackoverflow — Stack Overflow ZIM                (~22 GB)
    se_*          — Specialised Stack Exchange ZIMs   (~1-3 GB each)
    devdocs_*     — DevDocs language/framework docs   (~50-100 MB each)
    wiktionary    — English Wiktionary                (~6 GB)
    pubmed        — PubMed Open Access bulk text      (~12 GB)

SINGLETON PATTERN:
    Call init_knowledge_downloader(settings) once at startup.
    Callers use get_knowledge_downloader() to get the instance.

ENDPOINTS INTEGRATION:
    These methods are exposed via data_controller.py at:
        GET  /data/knowledge/sources           — SOURCES dict + current status
        GET  /data/knowledge/status            — all DownloadStatus objects
        POST /data/knowledge/download/{id}     — start_download(source_id)

SSE EVENTS:
    storage_update     — emitted every 5 % of download progress
    knowledge_ingested — emitted when a source finishes indexing

ZIM INDEXING NOTE:
    libzim integration is deferred to a future sprint.  On completion of a ZIM
    download, the source is immediately marked "ready".  Actual full-text
    search over ZIM content will be wired in once the libzim Python binding is
    available on the target platform.
"""

from __future__ import annotations

import asyncio
import json
import logging
import shutil
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Dict, Literal, Optional

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# SOURCES REGISTRY
# ─────────────────────────────────────────────────────────────────────────────

SOURCES: Dict[str, Dict[str, Any]] = {
    # ── Wikipedia ──────────────────────────────────────────────────────────────
    # Kiwix hosts full Wikipedia and topic-specific ZIM files.
    # Full URL list: https://download.kiwix.org/zim/wikipedia/
    # NOTE: "nopic" variants don't exist for topic ZIMs — maxi only.
    "wikipedia": {
        "name": "Wikipedia (English — No Images)",
        "url": "https://download.kiwix.org/zim/wikipedia/wikipedia_en_all_nopic_2025-12.zim",
        "size_gb": 50.0,
        "type": "zim",
        "index_table": "wikipedia",
        "description": "Full English Wikipedia, no images — ~50 GB",
    },
    "wikipedia_math": {
        "name": "Wikipedia — Mathematics",
        "url": "https://download.kiwix.org/zim/wikipedia/wikipedia_en_mathematics_maxi_2026-03.zim",
        "size_gb": 2.0,
        "type": "zim",
        "index_table": "wikipedia_math",
        "description": "Wikipedia Mathematics articles — ~2 GB",
    },
    "wikipedia_chemistry": {
        "name": "Wikipedia — Chemistry",
        "url": "https://download.kiwix.org/zim/wikipedia/wikipedia_en_chemistry_maxi_2026-01.zim",
        "size_gb": 2.0,
        "type": "zim",
        "index_table": "wikipedia_chemistry",
        "description": "Wikipedia Chemistry articles — ~2 GB",
    },
    "wikipedia_physics": {
        "name": "Wikipedia — Physics",
        "url": "https://download.kiwix.org/zim/wikipedia/wikipedia_en_physics_maxi_2026-01.zim",
        "size_gb": 2.0,
        "type": "zim",
        "index_table": "wikipedia_physics",
        "description": "Wikipedia Physics articles — ~2 GB",
    },
    "wikipedia_history": {
        "name": "Wikipedia — History",
        "url": "https://download.kiwix.org/zim/wikipedia/wikipedia_en_history_maxi_2026-01.zim",
        "size_gb": 5.0,
        "type": "zim",
        "index_table": "wikipedia_history",
        "description": "Wikipedia History articles — ~5 GB",
    },
    "wikipedia_geography": {
        "name": "Wikipedia — Geography",
        "url": "https://download.kiwix.org/zim/wikipedia/wikipedia_en_geography_maxi_2026-01.zim",
        "size_gb": 5.0,
        "type": "zim",
        "index_table": "wikipedia_geography",
        "description": "Wikipedia Geography articles — ~5 GB",
    },
    "wikipedia_computer": {
        "name": "Wikipedia — Computer Science",
        "url": "https://download.kiwix.org/zim/wikipedia/wikipedia_en_computer_maxi_2026-03.zim",
        "size_gb": 3.0,
        "type": "zim",
        "index_table": "wikipedia_computer",
        "description": "Wikipedia Computer Science articles — ~3 GB",
    },
    "wikipedia_medicine": {
        "name": "Wikipedia — Medicine",
        "url": "https://download.kiwix.org/zim/wikipedia/wikipedia_en_medicine_maxi_2026-01.zim",
        "size_gb": 2.5,
        "type": "zim",
        "index_table": "wikipedia_medicine",
        "description": "Wikipedia Medicine articles — ~2.5 GB",
    },
    "wikipedia_sociology": {
        "name": "Wikipedia — Sociology & Social Science",
        "url": "https://download.kiwix.org/zim/wikipedia/wikipedia_en_sociology_maxi_2026-01.zim",
        "size_gb": 2.0,
        "type": "zim",
        "index_table": "wikipedia_sociology",
        "description": "Wikipedia Sociology articles — ~2 GB",
    },
    "wikipedia_top": {
        "name": "Wikipedia — Top Articles",
        "url": "https://download.kiwix.org/zim/wikipedia/wikipedia_en_top_maxi_2026-03.zim",
        "size_gb": 6.0,
        "type": "zim",
        "index_table": "wikipedia_top",
        "description": "Wikipedia most popular articles — ~6 GB",
    },
    # ── Stack Exchange ─────────────────────────────────────────────────────────
    # Full URL list: https://download.kiwix.org/zim/stack_exchange/
    "stackoverflow": {
        "name": "Stack Overflow",
        "url": "https://download.kiwix.org/zim/stack_exchange/stackoverflow.com_en_all_2023-11.zim",
        "size_gb": 22.0,
        "type": "zim",
        "index_table": "stackoverflow",
        "description": "Stack Overflow Q&A — ~22 GB",
    },
    "se_math": {
        "name": "Mathematics Stack Exchange",
        "url": "https://download.kiwix.org/zim/stack_exchange/math.stackexchange.com_en_all_2026-02.zim",
        "size_gb": 2.0,
        "type": "zim",
        "index_table": "se_math",
        "description": "Mathematics SE Q&A — ~2 GB",
    },
    "se_physics": {
        "name": "Physics Stack Exchange",
        "url": "https://download.kiwix.org/zim/stack_exchange/physics.stackexchange.com_en_all_2026-02.zim",
        "size_gb": 1.5,
        "type": "zim",
        "index_table": "se_physics",
        "description": "Physics SE Q&A — ~1.5 GB",
    },
    "se_security": {
        "name": "Security Stack Exchange",
        "url": "https://download.kiwix.org/zim/stack_exchange/security.stackexchange.com_en_all_2025-12.zim",
        "size_gb": 1.0,
        "type": "zim",
        "index_table": "se_security",
        "description": "Security SE Q&A — ~1 GB",
    },
    "se_superuser": {
        "name": "Super User",
        "url": "https://download.kiwix.org/zim/stack_exchange/superuser.com_en_all_2026-02.zim",
        "size_gb": 3.0,
        "type": "zim",
        "index_table": "se_superuser",
        "description": "Super User Q&A — ~3 GB",
    },
    # ── DevDocs ────────────────────────────────────────────────────────────────
    "devdocs_python": {
        "name": "DevDocs — Python",
        "url": "https://download.kiwix.org/zim/devdocs/devdocs_en_python_2026-02.zim",
        "size_gb": 0.1,
        "type": "zim",
        "index_table": "devdocs_python",
        "description": "Python documentation — ~100 MB",
    },
    "devdocs_javascript": {
        "name": "DevDocs — JavaScript",
        "url": "https://download.kiwix.org/zim/devdocs/devdocs_en_javascript_2026-01.zim",
        "size_gb": 0.1,
        "type": "zim",
        "index_table": "devdocs_javascript",
        "description": "JavaScript documentation — ~100 MB",
    },
    "devdocs_react": {
        "name": "DevDocs — React",
        "url": "https://download.kiwix.org/zim/devdocs/devdocs_en_react_2026-02.zim",
        "size_gb": 0.05,
        "type": "zim",
        "index_table": "devdocs_react",
        "description": "React documentation — ~50 MB",
    },
    # ── Reference Works ────────────────────────────────────────────────────────
    "wiktionary": {
        "name": "Wiktionary (English Dictionary)",
        "url": "https://download.kiwix.org/zim/wiktionary/wiktionary_en_all_nopic_2026-02.zim",
        "size_gb": 6.0,
        "type": "zim",
        "index_table": "wiktionary",
        "description": "English Wiktionary — ~6 GB",
    },
    # ── PubMed ─────────────────────────────────────────────────────────────────
    "pubmed": {
        "name": "PubMed Central",
        "url": "https://ftp.ncbi.nlm.nih.gov/pub/pmc/oa_bulk/oa_comm/txt/oa_comm_txt.filelist.csv",
        "size_gb": 12.0,
        "type": "pubmed",
        "index_table": "pubmed",
        "description": "PubMed Open Access — ~12 GB",
    },
}

# ─────────────────────────────────────────────────────────────────────────────
# DATA MODEL
# ─────────────────────────────────────────────────────────────────────────────

DownloadStatusLiteral = Literal["not_downloaded", "downloading", "indexing", "ready", "error"]


@dataclass
class DownloadStatus:
    source_id: str
    status: DownloadStatusLiteral = "not_downloaded"
    progress_pct: float = 0.0
    size_gb: float = 0.0
    downloaded_gb: float = 0.0
    error: Optional[str] = None


# ─────────────────────────────────────────────────────────────────────────────
# PATHS
# ─────────────────────────────────────────────────────────────────────────────

_KNOWLEDGE_ROOT = Path.home() / ".aura" / "knowledge"
_STATUS_FILE = _KNOWLEDGE_ROOT / "download_status.json"
_CHUNK_SIZE = 1024 * 1024  # 1 MB

# ─────────────────────────────────────────────────────────────────────────────
# SINGLETON STATE
# ─────────────────────────────────────────────────────────────────────────────

_instance: Optional["KnowledgeDownloader"] = None


# ─────────────────────────────────────────────────────────────────────────────
# SERVICE CLASS
# ─────────────────────────────────────────────────────────────────────────────

class KnowledgeDownloader:
    """
    Manages download and indexing of offline knowledge databases.

    Thread-safety: this is a single-user desktop application; no locking is
    applied beyond what asyncio cooperative scheduling provides naturally.
    """

    def __init__(self, settings: Any = None) -> None:
        # status dict: source_id -> DownloadStatus
        self._statuses: Dict[str, DownloadStatus] = {}
        # Initialise every known source with "not_downloaded" as a baseline
        for source_id, meta in SOURCES.items():
            self._statuses[source_id] = DownloadStatus(
                source_id=source_id,
                size_gb=meta["size_gb"],
            )
        self._load_status()

    # ------------------------------------------------------------------
    # Public read API
    # ------------------------------------------------------------------

    def get_all_status(self) -> Dict[str, DownloadStatus]:
        """Return status for every known source."""
        return dict(self._statuses)

    def get_status(self, source_id: str) -> DownloadStatus:
        """Return status for a single source.  Raises KeyError if unknown."""
        if source_id not in self._statuses:
            raise KeyError(f"Unknown source_id: {source_id!r}")
        return self._statuses[source_id]

    # ------------------------------------------------------------------
    # Download lifecycle
    # ------------------------------------------------------------------

    async def start_download(self, source_id: str) -> None:
        """
        Begin downloading *source_id*.

        Raises:
            KeyError   — source_id not in SOURCES
            ValueError — already downloading/ready, or insufficient disk space
        """
        if source_id not in SOURCES:
            raise KeyError(f"Unknown source_id: {source_id!r}")

        status = self._statuses[source_id]
        if status.status in ("downloading", "indexing"):
            raise ValueError(f"{source_id} is already {status.status}")
        if status.status == "ready":
            raise ValueError(f"{source_id} is already downloaded and ready")

        meta = SOURCES[source_id]
        required_gb: float = meta["size_gb"]

        # Disk space check — done here synchronously so errors surface immediately
        # via SSE rather than being swallowed by the background asyncio.Task.
        _KNOWLEDGE_ROOT.mkdir(parents=True, exist_ok=True)
        usage = shutil.disk_usage(_KNOWLEDGE_ROOT)
        free_gb = usage.free / (1024 ** 3)
        if free_gb < required_gb * 1.05:  # 5 % headroom
            msg = (
                f"Insufficient disk space for {meta['name']}: "
                f"need {required_gb:.1f} GB, have {free_gb:.1f} GB free."
            )
            status.status = "error"
            status.error = msg
            self._save_status()
            await self._emit_sse("storage_update", {
                "source_id": source_id,
                "status": "error",
                "error": msg,
            })
            # Also surface as a system_notification so the toast fires in the UI
            await self._emit_sse("system_notification", {
                "type": "disk_space_error",
                "message": msg,
                "level": "error",
            })
            logger.error("[knowledge_downloader] %s", msg)
            return

        dest_dir = _KNOWLEDGE_ROOT / source_id
        dest_dir.mkdir(parents=True, exist_ok=True)
        filename = meta["url"].split("/")[-1]
        dest_file = dest_dir / filename

        # Update state
        status.status = "downloading"
        status.progress_pct = 0.0
        status.downloaded_gb = 0.0
        status.error = None
        self._save_status()
        await self._emit_sse("storage_update", {
            "source_id": source_id,
            "status": "downloading",
            "progress_pct": 0.0,
        })

        try:
            await self._download_file(source_id, meta["url"], dest_file, required_gb)
        except asyncio.CancelledError:
            logger.warning("Download cancelled for %s", source_id)
            status.status = "error"
            status.error = "Download cancelled"
            self._save_status()
            raise
        except Exception as exc:
            logger.exception("Download failed for %s: %s", source_id, exc)
            status.status = "error"
            status.error = str(exc)
            self._save_status()
            await self._emit_sse("storage_update", {
                "source_id": source_id,
                "status": "error",
                "error": str(exc),
            })
            return

        # Transition to indexing
        status.status = "indexing"
        status.progress_pct = 100.0
        self._save_status()
        logger.info("Download complete for %s — starting indexing", source_id)
        await self._emit_sse("storage_update", {
            "source_id": source_id,
            "status": "indexing",
            "progress_pct": 100.0,
        })

        await self._index_source(source_id)

    async def _download_file(
        self,
        source_id: str,
        url: str,
        dest: Path,
        total_gb: float,
    ) -> None:
        """Stream-download *url* to *dest* in 1 MB chunks, updating progress."""
        try:
            import httpx
        except ImportError as exc:
            raise RuntimeError("httpx is required for downloads") from exc

        status = self._statuses[source_id]
        total_bytes = int(total_gb * 1024 ** 3)
        downloaded = 0
        last_reported_pct = -1.0

        logger.info("Starting download: %s -> %s", url, dest)

        async with httpx.AsyncClient(timeout=httpx.Timeout(30.0, read=300.0)) as client:
            async with client.stream("GET", url, follow_redirects=True) as response:
                response.raise_for_status()
                content_length = int(response.headers.get("content-length", total_bytes))

                with dest.open("wb") as fh:
                    async for chunk in response.aiter_bytes(chunk_size=_CHUNK_SIZE):
                        fh.write(chunk)
                        downloaded += len(chunk)

                        pct = min(99.9, (downloaded / content_length) * 100.0)
                        status.progress_pct = pct
                        status.downloaded_gb = downloaded / (1024 ** 3)

                        # Emit SSE every 5 % of progress
                        if pct - last_reported_pct >= 5.0:
                            last_reported_pct = pct
                            self._save_status()
                            await self._emit_sse("storage_update", {
                                "source_id": source_id,
                                "status": "downloading",
                                "progress_pct": round(pct, 1),
                                "downloaded_gb": round(status.downloaded_gb, 2),
                            })

        logger.info("Download finished: %s (%.2f GB)", source_id, status.downloaded_gb)

    # ------------------------------------------------------------------
    # Indexing
    # ------------------------------------------------------------------

    async def _index_source(self, source_id: str) -> None:
        """
        Index a downloaded source into FTS5.

        ZIM sources: Extract articles via libzim → SQLite FTS5.
        PubMed:      CSV parsing deferred (mark ready).
        arXiv:       JSON parsing deferred (mark ready).
        """
        meta = SOURCES[source_id]
        source_type = meta.get("type", "unknown")
        status = self._statuses[source_id]

        logger.info("Indexing %s (type=%s)", source_id, source_type)

        if source_type == "zim":
            await self._index_zim_source(source_id, meta, status)
        elif source_type == "pubmed":
            logger.info("PubMed deep indexing deferred: %s", source_id)
            status.status = "ready"
        elif source_type == "arxiv":
            logger.info("arXiv indexing deferred: %s", source_id)
            status.status = "ready"
        else:
            logger.info("Unknown source type %s — marking ready", source_type)
            status.status = "ready"

        status.progress_pct = 100.0
        self._save_status()

        await self._emit_sse("knowledge_ingested", {
            "source_id": source_id,
            "source_name": meta["name"],
            "index_table": meta["index_table"],
        })
        logger.info("Source %s is ready", source_id)

    async def _index_zim_source(
        self, source_id: str, meta: dict, status: "DownloadStatus"
    ) -> None:
        """Run ZIM → FTS5 indexing in a thread pool to avoid blocking the event loop."""
        source_dir = _KNOWLEDGE_ROOT / source_id
        zim_files = list(source_dir.glob("*.zim"))
        if not zim_files:
            logger.warning("No ZIM file found in %s — marking ready anyway", source_dir)
            status.status = "ready"
            return

        zim_path = zim_files[0]
        db_path = source_dir / "fts5.db"

        logger.info("ZIM indexing: %s → %s", zim_path.name, db_path)
        await self._emit_sse("storage_update", {
            "source_id": source_id,
            "status": "indexing",
            "detail": f"Building FTS5 index from {zim_path.name}...",
        })

        def _progress(indexed: int, skipped: int, total: int) -> None:
            pct = (indexed + skipped) / max(total, 1) * 100
            logger.info(
                "[%s] Indexing: %d articles, %d skipped (%.0f%%)",
                source_id, indexed, skipped, pct,
            )

        try:
            # Import the indexer
            import importlib.util
            spec = importlib.util.spec_from_file_location(
                "build_zim_index",
                str(Path(__file__).resolve().parent.parent.parent / "scripts" / "build_zim_index.py"),
            )
            zim_indexer = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(zim_indexer)

            # Run in thread pool — ZIM indexing is CPU+IO heavy
            loop = asyncio.get_running_loop()
            result = await loop.run_in_executor(
                None,
                lambda: zim_indexer.index_zim(
                    str(zim_path), str(db_path), progress_callback=_progress
                ),
            )

            if "error" in result:
                logger.error("ZIM indexing failed for %s: %s", source_id, result["error"])
                status.status = "error"
                status.error = f"Indexing failed: {result['error']}"
                return

            logger.info(
                "ZIM indexing complete for %s: %d articles in %.0fs",
                source_id, result.get("indexed", 0), result.get("elapsed_s", 0),
            )
            status.status = "ready"

            # Register in LocalSearch so it's immediately queryable
            try:
                from app.knowledge.local_search import SOURCE_CONFIG
                if source_id not in SOURCE_CONFIG:
                    SOURCE_CONFIG[source_id] = {
                        "db_file": f"{source_id}/fts5.db",
                        "table": "articles_fts",
                        "cols": ("title", "content"),
                        "limit": 5,
                    }
                    logger.info("Registered %s in LocalSearch SOURCE_CONFIG", source_id)
            except Exception as exc:
                logger.warning("Failed to register %s in LocalSearch: %s", source_id, exc)

        except Exception as exc:
            logger.exception("ZIM indexing crashed for %s: %s", source_id, exc)
            status.status = "error"
            status.error = f"Indexing error: {exc}"

    # ------------------------------------------------------------------
    # Pause (stub)
    # ------------------------------------------------------------------

    def pause_download(self, source_id: str) -> None:
        """Pause an in-progress download. (Not yet implemented.)"""
        logger.info("pause_download called for %s — pause not yet implemented", source_id)

    # ------------------------------------------------------------------
    # Persistence
    # ------------------------------------------------------------------

    def _save_status(self) -> None:
        """Persist all download statuses to download_status.json."""
        _KNOWLEDGE_ROOT.mkdir(parents=True, exist_ok=True)
        try:
            data = {k: asdict(v) for k, v in self._statuses.items()}
            _STATUS_FILE.write_text(json.dumps(data, indent=2), encoding="utf-8")
        except Exception as exc:
            logger.warning("Failed to save knowledge status: %s", exc)

    def _load_status(self) -> None:
        """Load persisted statuses from download_status.json if it exists."""
        if not _STATUS_FILE.exists():
            return
        try:
            data = json.loads(_STATUS_FILE.read_text(encoding="utf-8"))
            for source_id, raw in data.items():
                if source_id in self._statuses:
                    st = self._statuses[source_id]
                    st.status = raw.get("status", "not_downloaded")
                    st.progress_pct = raw.get("progress_pct", 0.0)
                    st.downloaded_gb = raw.get("downloaded_gb", 0.0)
                    st.error = raw.get("error")
            logger.debug("Loaded knowledge download status from %s", _STATUS_FILE)
        except Exception as exc:
            logger.warning("Failed to load knowledge status: %s", exc)

    # ------------------------------------------------------------------
    # SSE helper
    # ------------------------------------------------------------------

    @staticmethod
    async def _emit_sse(event_type: str, data: dict) -> None:
        """Push an SSE event to the global chat_controller event bus."""
        try:
            from app.controller.chat_controller import _emit
            await _emit(event_type, data)
        except Exception as exc:
            logger.debug("SSE emit failed (%s): %s", event_type, exc)


# ─────────────────────────────────────────────────────────────────────────────
# SINGLETON LIFECYCLE
# ─────────────────────────────────────────────────────────────────────────────

def init_knowledge_downloader(settings: Any = None) -> KnowledgeDownloader:
    """Create and register the global KnowledgeDownloader instance."""
    global _instance
    _instance = KnowledgeDownloader(settings=settings)
    logger.info("KnowledgeDownloader initialised")
    return _instance


def get_knowledge_downloader() -> Optional[KnowledgeDownloader]:
    """Return the global KnowledgeDownloader, or None if not yet initialised."""
    return _instance
