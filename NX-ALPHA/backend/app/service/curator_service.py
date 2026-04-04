"""
AURA NX-Alpha — Knowledge Curator Service
Evaluates and ingests arbitrary datasets into the local FTS5 knowledge store.

ACCEPTED SOURCES:
    HuggingFace dataset ID  (org/dataset-name)
    Direct URL              (https://...)
    Local file path         (/path/to/file.parquet  or  C:\\path\\to\\file.parquet)

FLOW:
    1. evaluate(source)          → sample → workhorse evaluation → return report
    2. ingest(curator_id)        → full download → FTS5 index → live in router
    3. router_registration       → SOURCE_CONFIG updated in-process, no restart needed

SINGLETON PATTERN:
    Call init_curator_service() once at startup.
    Callers use get_curator_service() to get the instance.

ENDPOINTS (via data_controller.py):
    POST /data/knowledge/curator/evaluate           — submit source, get eval report
    POST /data/knowledge/curator/ingest/{id}        — approve and start ingest
    GET  /data/knowledge/curator/status/{id}        — progress polling
    GET  /data/knowledge/curator/list               — all curated sources

SSE EVENTS:
    storage_update      — during download (progress_pct) and on status changes
    knowledge_ingested  — when indexing completes and source goes live

PERSISTENCE:
    ~/.aura/knowledge/curator_registry.json — survives restarts, re-registers
                                               ready sources into LocalSearch on startup
"""

from __future__ import annotations

import asyncio
import itertools
import json
import logging
import re
import shutil
import uuid
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Dict, Iterator, List, Literal, Optional, Tuple

logger = logging.getLogger(__name__)

_KNOWLEDGE_ROOT  = Path.home() / ".aura" / "knowledge"
_CURATOR_REGISTRY = _KNOWLEDGE_ROOT / "curator_registry.json"
_SAMPLE_ROWS     = 500
_CHUNK_SIZE      = 1024 * 1024   # 1 MB

CuratorStatusLiteral = Literal[
    "pending_review", "approved", "downloading", "indexing", "ready", "error"
]


# ─────────────────────────────────────────────────────────────────────────────
# DATA MODEL
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class CuratorStatus:
    curator_id:   str
    source:       str
    source_type:  str                         # "hf" | "url" | "local"
    status:       CuratorStatusLiteral = "pending_review"
    eval_report:  Optional[dict] = None
    progress_pct: float = 0.0
    error:        Optional[str] = None
    db_path:      Optional[str] = None


# ─────────────────────────────────────────────────────────────────────────────
# SINGLETON STATE
# ─────────────────────────────────────────────────────────────────────────────

_instance: Optional["CuratorService"] = None


# ─────────────────────────────────────────────────────────────────────────────
# SERVICE
# ─────────────────────────────────────────────────────────────────────────────

class CuratorService:
    """
    Evaluates and ingests arbitrary datasets into the AURA knowledge store.

    Thread-safety: single-user desktop application; asyncio cooperative
    scheduling provides sufficient safety without explicit locking.
    """

    def __init__(self) -> None:
        self._statuses: Dict[str, CuratorStatus] = {}
        self._load_registry()

    # ──────────────────────────────────────────────────────────────────────────
    # Public API
    # ──────────────────────────────────────────────────────────────────────────

    async def evaluate(self, source: str) -> Dict[str, Any]:
        """
        Detect source type, fetch a sample, evaluate with the workhorse model.

        Returns:
            {"curator_id": str, "report": dict}

        The report contains: safety, pii, relevance_score, relevance_summary,
        indexable_fields, suggested_name, recommended, detected_format, sample_rows.
        """
        source = source.strip()
        source_type, normalized = self._detect_source_type(source)
        curator_id = self._make_id(normalized)

        status = CuratorStatus(
            curator_id=curator_id,
            source=normalized,
            source_type=source_type,
        )
        self._statuses[curator_id] = status

        try:
            sample_rows, detected_format = await self._fetch_sample(source_type, normalized)
        except Exception as exc:
            status.status = "error"
            status.error  = f"Sample fetch failed: {exc}"
            self._save_registry()
            raise

        try:
            report = await self._evaluate_with_workhorse(sample_rows, normalized, detected_format)
        except Exception as exc:
            logger.warning("[curator] Workhorse evaluation failed (%s) — using basic report", exc)
            report = self._basic_report(sample_rows, detected_format, normalized)

        status.eval_report = report
        status.status      = "pending_review"
        self._save_registry()

        return {"curator_id": curator_id, "report": report}

    async def ingest(self, curator_id: str) -> None:
        """
        Approve a pending evaluation and start the full download + index pipeline.

        Raises:
            KeyError   — curator_id unknown
            ValueError — not in a state that allows ingestion
        """
        if curator_id not in self._statuses:
            raise KeyError(f"Unknown curator_id: {curator_id!r}")

        status = self._statuses[curator_id]
        if status.status not in ("pending_review", "error"):
            raise ValueError(f"Cannot ingest from status {status.status!r}")

        status.status = "approved"
        self._save_registry()
        asyncio.create_task(self._run_ingest(curator_id))

    def get_status(self, curator_id: str) -> CuratorStatus:
        if curator_id not in self._statuses:
            raise KeyError(f"Unknown curator_id: {curator_id!r}")
        return self._statuses[curator_id]

    def get_all(self) -> Dict[str, CuratorStatus]:
        return dict(self._statuses)

    # ──────────────────────────────────────────────────────────────────────────
    # Source type detection
    # ──────────────────────────────────────────────────────────────────────────

    def _detect_source_type(self, source: str) -> Tuple[str, str]:
        """
        Classify a source descriptor.

        Returns:
            ("hf"|"url"|"local", normalized_source)
        """
        if source.startswith(("http://", "https://")):
            return "url", source

        # HF pattern: exactly one slash, org/dataset, no path separators
        if re.match(r"^[A-Za-z0-9_.\-]+/[A-Za-z0-9_.\-]+$", source):
            return "hf", source

        return "local", source

    def _make_id(self, source: str) -> str:
        """Derive a stable snake_case slug from the source string."""
        slug = re.sub(r"[^a-z0-9]+", "_", source.lower())
        slug = slug[:40].strip("_")
        return slug or uuid.uuid4().hex[:8]

    # ──────────────────────────────────────────────────────────────────────────
    # Sampling
    # ──────────────────────────────────────────────────────────────────────────

    async def _fetch_sample(
        self, source_type: str, source: str
    ) -> Tuple[List[dict], str]:
        """Return (sample_rows, detected_format)."""
        if source_type == "hf":
            return await asyncio.to_thread(self._sample_hf, source)
        if source_type == "url":
            return await asyncio.to_thread(self._sample_url, source)
        return await asyncio.to_thread(self._sample_local, Path(source).expanduser())

    def _sample_hf(self, dataset_id: str) -> Tuple[List[dict], str]:
        try:
            from datasets import load_dataset
        except ImportError as exc:
            raise RuntimeError(
                "datasets not installed. Run: pip install datasets"
            ) from exc

        logger.info("[curator] Streaming HF sample: %s", dataset_id)
        ds = load_dataset(
            dataset_id,
            split="train",
            streaming=True,
            trust_remote_code=False,
        )
        rows = list(itertools.islice(ds, _SAMPLE_ROWS))
        return rows, "parquet"

    def _sample_url(self, url: str) -> Tuple[List[dict], str]:
        import httpx
        from io import BytesIO, StringIO

        logger.info("[curator] Fetching URL sample: %s", url)
        with httpx.Client(follow_redirects=True, timeout=30.0) as client:
            with client.stream("GET", url) as r:
                r.raise_for_status()
                content_type = r.headers.get("content-type", "")
                chunks: list[bytes] = []
                size = 0
                for chunk in r.iter_bytes(chunk_size=8192):
                    chunks.append(chunk)
                    size += len(chunk)
                    if size >= 200_000:
                        break
        raw = b"".join(chunks)

        url_lower = url.lower()
        if ".parquet" in url_lower:
            import pyarrow.parquet as pq
            table = pq.read_table(BytesIO(raw))
            return table.slice(0, _SAMPLE_ROWS).to_pylist(), "parquet"

        if ".jsonl" in url_lower or "jsonlines" in content_type:
            lines = raw.decode("utf-8", errors="replace").splitlines()
            rows = [json.loads(l) for l in itertools.islice(lines, _SAMPLE_ROWS) if l.strip()]
            return rows, "jsonl"

        if ".csv" in url_lower or "csv" in content_type:
            import csv
            reader = csv.DictReader(StringIO(raw.decode("utf-8", errors="replace")))
            return list(itertools.islice(reader, _SAMPLE_ROWS)), "csv"

        # Plain text fallback
        text = raw.decode("utf-8", errors="replace")
        paragraphs = [p.strip() for p in text.split("\n\n") if len(p.strip()) > 20]
        return [{"text": p} for p in paragraphs[:_SAMPLE_ROWS]], "txt"

    def _sample_local(self, path: Path) -> Tuple[List[dict], str]:
        import csv

        logger.info("[curator] Sampling local file: %s", path)
        suffix = path.suffix.lower()

        if suffix == ".parquet":
            import pyarrow.parquet as pq
            table = pq.read_table(str(path))
            return table.slice(0, _SAMPLE_ROWS).to_pylist(), "parquet"

        if suffix in (".jsonl", ".ndjson"):
            with path.open(encoding="utf-8", errors="replace") as fh:
                rows = [
                    json.loads(l)
                    for l in itertools.islice(fh, _SAMPLE_ROWS)
                    if l.strip()
                ]
            return rows, "jsonl"

        if suffix == ".json":
            data = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(data, list):
                return data[:_SAMPLE_ROWS], "json"
            return [data], "json"

        if suffix == ".csv":
            with path.open(encoding="utf-8", errors="replace", newline="") as fh:
                reader = csv.DictReader(fh)
                return list(itertools.islice(reader, _SAMPLE_ROWS)), "csv"

        if suffix == ".txt":
            text = path.read_text(encoding="utf-8", errors="replace")
            paragraphs = [p.strip() for p in text.split("\n\n") if len(p.strip()) > 20]
            return [{"text": p} for p in paragraphs[:_SAMPLE_ROWS]], "txt"

        raise ValueError(f"Unsupported file format: {suffix}")

    # ──────────────────────────────────────────────────────────────────────────
    # Workhorse evaluation
    # ──────────────────────────────────────────────────────────────────────────

    async def _evaluate_with_workhorse(
        self,
        rows: List[dict],
        source_label: str,
        detected_format: str,
    ) -> dict:
        from app.service.ollama_service import get_ollama_service

        ollama = get_ollama_service()
        if ollama is None:
            return self._basic_report(rows, detected_format, source_label)

        fields      = list(rows[0].keys()) if rows else []
        sample_text = self._rows_to_text(rows, max_chars=6000)

        prompt = f"""You are evaluating a dataset for ingestion into a local AI knowledge base.

Source: {source_label}
Format: {detected_format}
Fields detected: {fields}
Sample ({len(rows)} rows shown, up to 20):

{sample_text}

Evaluate this dataset and respond with a JSON object containing exactly these keys:

- "safety": "clean" or "flagged"
  (flagged if content is harmful, illegal, dangerous, or hateful)
- "safety_notes": brief explanation, or empty string if clean
- "pii": "none" or "detected"
  (detected if personal names + contact info, SSNs, passwords, credentials, etc.)
- "pii_notes": brief explanation, or empty string if none
- "relevance_score": integer 1–10
  (how useful is this for a general-purpose knowledge assistant)
- "relevance_summary": one sentence describing what this dataset contains and its value
- "indexable_fields": list of field name strings that contain useful searchable text
  (exclude IDs, timestamps, pure numbers, URLs, hash fields)
- "suggested_name": a short snake_case slug for this dataset (no spaces)
- "recommended": true or false
  (false if safety=flagged, pii=detected, or relevance_score < 4)

Respond with only the JSON object. No explanation, no markdown."""

        report = await ollama.chat_json(
            messages=[{"role": "user", "content": prompt}],
            temperature=0.1,
        )

        # Ensure all required keys are present
        str_fields = [f for f in fields if rows and isinstance(rows[0].get(f), str)]
        report.setdefault("safety", "clean")
        report.setdefault("safety_notes", "")
        report.setdefault("pii", "none")
        report.setdefault("pii_notes", "")
        report.setdefault("relevance_score", 5)
        report.setdefault("relevance_summary", "")
        report.setdefault("indexable_fields", str_fields)
        report.setdefault("suggested_name", self._make_id(source_label))
        report.setdefault(
            "recommended",
            report.get("safety") == "clean"
            and report.get("pii") == "none"
            and report.get("relevance_score", 0) >= 4,
        )
        report["detected_format"] = detected_format
        report["sample_rows"]     = len(rows)
        return report

    def _basic_report(
        self, rows: List[dict], detected_format: str, source_label: str
    ) -> dict:
        """Fallback report when the workhorse is unavailable."""
        fields     = list(rows[0].keys()) if rows else []
        str_fields = [
            f for f in fields
            if rows and isinstance(rows[0].get(f), str) and len(str(rows[0].get(f, ""))) > 10
        ]
        return {
            "safety":           "unknown",
            "safety_notes":     "Workhorse unavailable — manual review recommended",
            "pii":              "unknown",
            "pii_notes":        "Workhorse unavailable — manual review recommended",
            "relevance_score":  5,
            "relevance_summary": f"Dataset with {len(rows)} sample rows; fields: {fields}",
            "indexable_fields": str_fields or fields,
            "suggested_name":   self._make_id(source_label),
            "recommended":      False,
            "detected_format":  detected_format,
            "sample_rows":      len(rows),
        }

    def _rows_to_text(self, rows: List[dict], max_chars: int = 6000) -> str:
        """Compact text rendering of sample rows for the evaluation prompt."""
        lines: list[str] = []
        total = 0
        for i, row in enumerate(rows[:20]):
            line = f"[{i}] " + " | ".join(
                f"{k}: {str(v)[:200]}" for k, v in row.items()
            )
            lines.append(line)
            total += len(line)
            if total >= max_chars:
                remaining = len(rows) - i - 1
                if remaining > 0:
                    lines.append(f"... ({remaining} more rows)")
                break
        return "\n".join(lines)

    # ──────────────────────────────────────────────────────────────────────────
    # Full ingest pipeline
    # ──────────────────────────────────────────────────────────────────────────

    async def _run_ingest(self, curator_id: str) -> None:
        status       = self._statuses[curator_id]
        report       = status.eval_report or {}
        dataset_name = report.get("suggested_name") or curator_id
        staging_dir  = _KNOWLEDGE_ROOT / dataset_name / "staging"
        db_path      = _KNOWLEDGE_ROOT / dataset_name / "fts5.db"
        staging_dir.mkdir(parents=True, exist_ok=True)

        # Disk space check — rough 1 GB reserve
        usage   = shutil.disk_usage(_KNOWLEDGE_ROOT)
        free_gb = usage.free / (1024 ** 3)
        if free_gb < 1.05:
            status.status = "error"
            status.error  = f"Insufficient disk space: {free_gb:.1f} GB free"
            self._save_registry()
            return

        try:
            # ── Download ──────────────────────────────────────────────────────
            status.status       = "downloading"
            status.progress_pct = 0.0
            self._save_registry()
            await self._emit_sse("storage_update", {
                "curator_id":   curator_id,
                "status":       "downloading",
                "progress_pct": 0.0,
            })

            if status.source_type == "hf":
                data_path = await asyncio.to_thread(
                    self._download_hf, status.source, staging_dir
                )
            elif status.source_type == "url":
                data_path = await self._download_url(curator_id, status.source, staging_dir)
            else:
                data_path = Path(status.source).expanduser()

            status.progress_pct = 100.0
            status.status       = "indexing"
            self._save_registry()
            await self._emit_sse("storage_update", {
                "curator_id":   curator_id,
                "status":       "indexing",
                "progress_pct": 100.0,
            })

            # ── Index ─────────────────────────────────────────────────────────
            text_cols = report.get("indexable_fields") or []
            await asyncio.to_thread(
                self._build_fts5_index,
                data_path,
                db_path,
                text_cols,
                dataset_name,
            )

            # ── Register in LocalSearch ───────────────────────────────────────
            self._register_source(
                source_id=dataset_name,
                db_file=f"{dataset_name}/fts5.db",
                text_cols=text_cols,
            )

            status.status  = "ready"
            status.db_path = str(db_path)
            self._save_registry()

            await self._emit_sse("knowledge_ingested", {
                "curator_id":  curator_id,
                "source_name": dataset_name,
                "index_table": "documents_fts",
            })
            logger.info("[curator] Ingest complete: %s → %s", status.source, db_path)

        except Exception as exc:
            logger.exception("[curator] Ingest failed for %s: %s", curator_id, exc)
            status.status = "error"
            status.error  = str(exc)
            self._save_registry()
            await self._emit_sse("storage_update", {
                "curator_id": curator_id,
                "status":     "error",
                "error":      str(exc),
            })

    def _download_hf(self, dataset_id: str, staging_dir: Path) -> Path:
        from huggingface_hub import snapshot_download

        logger.info("[curator] Downloading HF dataset: %s", dataset_id)
        local_dir = snapshot_download(
            repo_id=dataset_id,
            repo_type="dataset",
            local_dir=str(staging_dir),
        )
        return Path(local_dir)

    async def _download_url(
        self, curator_id: str, url: str, staging_dir: Path
    ) -> Path:
        import httpx

        filename = url.split("/")[-1].split("?")[0] or "data.bin"
        dest     = staging_dir / filename
        status   = self._statuses[curator_id]
        last_reported = -1.0

        async with httpx.AsyncClient(
            follow_redirects=True,
            timeout=httpx.Timeout(30.0, read=300.0),
        ) as client:
            async with client.stream("GET", url) as r:
                r.raise_for_status()
                total      = int(r.headers.get("content-length", 0))
                downloaded = 0

                with dest.open("wb") as fh:
                    async for chunk in r.aiter_bytes(chunk_size=_CHUNK_SIZE):
                        fh.write(chunk)
                        downloaded += len(chunk)
                        pct = (downloaded / total * 100.0) if total else 0.0
                        status.progress_pct = pct

                        if pct - last_reported >= 5.0:
                            last_reported = pct
                            self._save_registry()
                            await self._emit_sse("storage_update", {
                                "curator_id":   curator_id,
                                "status":       "downloading",
                                "progress_pct": round(pct, 1),
                            })

        logger.info("[curator] URL download complete: %s → %s", url, dest)
        return dest

    def _build_fts5_index(
        self,
        data_path: Path,
        db_path: Path,
        text_cols: List[str],
        dataset_name: str,
    ) -> None:
        from app.service.generic_indexer import build_index, detect_text_columns

        # If caller provided no cols, pass None so generic_indexer auto-detects
        cols = text_cols if text_cols else None
        count = build_index(
            data_path=data_path,
            db_path=db_path,
            text_cols=cols,
            source_id=dataset_name,
        )
        logger.info("[curator] Indexed %d rows for %s", count, dataset_name)

    def _register_source(
        self, source_id: str, db_file: str, text_cols: List[str]
    ) -> None:
        """Add source to LocalSearch's live SOURCE_CONFIG dictionary."""
        from app.knowledge.local_search import SOURCE_CONFIG, get_local_search

        cols_tuple = tuple(text_cols) if text_cols else ("text",)
        SOURCE_CONFIG[source_id] = {
            "db_file": db_file,
            "table":   "documents_fts",
            "cols":    cols_tuple,
            "limit":   5,
        }
        # Drop any stale connection so next query opens the new db
        ls = get_local_search()
        if ls is not None and source_id in ls._connections:
            del ls._connections[source_id]

        logger.info("[curator] Registered source in LocalSearch: %s", source_id)

    # ──────────────────────────────────────────────────────────────────────────
    # Persistence
    # ──────────────────────────────────────────────────────────────────────────

    def _save_registry(self) -> None:
        _KNOWLEDGE_ROOT.mkdir(parents=True, exist_ok=True)
        try:
            data = {k: asdict(v) for k, v in self._statuses.items()}
            _CURATOR_REGISTRY.write_text(
                json.dumps(data, indent=2), encoding="utf-8"
            )
        except Exception as exc:
            logger.warning("[curator] Failed to save registry: %s", exc)

    def _load_registry(self) -> None:
        if not _CURATOR_REGISTRY.exists():
            return
        try:
            data = json.loads(_CURATOR_REGISTRY.read_text(encoding="utf-8"))
            for cid, raw in data.items():
                self._statuses[cid] = CuratorStatus(
                    curator_id   = raw["curator_id"],
                    source       = raw["source"],
                    source_type  = raw["source_type"],
                    status       = raw.get("status", "pending_review"),
                    eval_report  = raw.get("eval_report"),
                    progress_pct = raw.get("progress_pct", 0.0),
                    error        = raw.get("error"),
                    db_path      = raw.get("db_path"),
                )
                # Re-register sources that are already ready
                if raw.get("status") == "ready" and raw.get("eval_report"):
                    report = raw["eval_report"]
                    self._register_source(
                        source_id = raw.get("eval_report", {}).get("suggested_name") or cid,
                        db_file   = f"{report.get('suggested_name') or cid}/fts5.db",
                        text_cols = report.get("indexable_fields", []),
                    )
            logger.info("[curator] Loaded %d entries from curator registry", len(data))
        except Exception as exc:
            logger.warning("[curator] Failed to load registry: %s", exc)

    # ──────────────────────────────────────────────────────────────────────────
    # SSE helper
    # ──────────────────────────────────────────────────────────────────────────

    @staticmethod
    async def _emit_sse(event_type: str, data: dict) -> None:
        try:
            from app.controller.chat_controller import _emit
            await _emit(event_type, data)
        except Exception as exc:
            logger.debug("[curator] SSE emit failed (%s): %s", event_type, exc)


# ─────────────────────────────────────────────────────────────────────────────
# SINGLETON LIFECYCLE
# ─────────────────────────────────────────────────────────────────────────────

def init_curator_service() -> CuratorService:
    """Create and register the global CuratorService instance."""
    global _instance
    _instance = CuratorService()
    logger.info("[curator] CuratorService initialized")
    return _instance


def get_curator_service() -> Optional[CuratorService]:
    """Return the global CuratorService, or None if not yet initialised."""
    return _instance
