"""
AURA NX-Alpha — Watch & Transcribe Service

Background transcription daemon for live streams.
Architecture: Option A — shared queue, single faster-whisper model instance.

FLOW:
    URL → yt-dlp (extract HLS) → FFmpeg subprocess (PCM pipe, 16kHz mono s16le)
    → asyncio.Queue → faster-whisper (GPU-first, shared) → SQLite + ChromaDB
    → SSE emit (transcript_segment)

MULTI-STREAM:
    Each stream gets its own FFmpeg subprocess and WatchSession.
    All sessions share one audio chunk queue and one Whisper model load.
    GPU inference is serialized through the queue — zero VRAM duplication.

MUTED STREAMS:
    FFmpeg runs entirely server-side. The frontend player does not need
    to be open or playing. Transcription is headless and independent.
"""

import asyncio
import logging
import re as _re
import sqlite3
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

TRANSCRIPT_DB_PATH = Path("~/.aura/transcripts.db").expanduser()

# Audio config: 3-second chunks at 16 kHz, 16-bit mono (s16le)
_SAMPLE_RATE   = 16000
_CHUNK_SECONDS = 3
_CHUNK_BYTES   = _SAMPLE_RATE * _CHUNK_SECONDS * 2  # 2 bytes per s16le sample


# ─────────────────────────────────────────────────────────────────────────────
# SESSION
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class WatchSession:
    stream_id:     str
    source_url:    str
    label:         str
    hls_url:       str
    status:        str       = "starting"   # starting | watching | stopped | error
    segment_count: int       = 0
    start_time:    float     = field(default_factory=time.time)
    _ffmpeg_proc:  object    = field(default=None, repr=False)
    _audio_task:   object    = field(default=None, repr=False)


# ─────────────────────────────────────────────────────────────────────────────
# DAEMON
# ─────────────────────────────────────────────────────────────────────────────

class WatchDaemon:
    """
    Singleton managing all active watch sessions.
    Option A: single asyncio.Queue, one Whisper model, one consumer task.
    """

    def __init__(self):
        self._sessions:       dict[str, WatchSession]        = {}
        self._queue:          asyncio.Queue[tuple[str, bytes]] = asyncio.Queue(maxsize=64)
        self._consumer_task:  Optional[asyncio.Task]          = None
        self._running:        bool                            = False
        _ensure_transcript_db()

    def start(self):
        """Start the consumer task. Safe to call multiple times."""
        if self._consumer_task is None or self._consumer_task.done():
            self._running = True
            self._consumer_task = asyncio.create_task(
                self._consume_loop(), name="watch_consumer"
            )
            logger.info("[watch_service] Consumer task started")

    async def stop(self):
        """Graceful shutdown — stop all sessions then cancel consumer."""
        self._running = False
        for stream_id in list(self._sessions.keys()):
            await self.stop_watch(stream_id)
        if self._consumer_task:
            self._consumer_task.cancel()
            try:
                await self._consumer_task
            except asyncio.CancelledError:
                pass
        logger.info("[watch_service] Daemon stopped")

    async def start_watch(self, url: str, label: str = "") -> dict:
        """
        Begin watching and transcribing a stream.
        Returns {stream_id, status, label}.
        """
        from app.service.media_service import get_video_info

        stream_id = uuid.uuid4().hex[:12]

        try:
            info = await get_video_info(url)
            if "error" in info:
                # yt_dlp not installed or extraction failed — pass raw URL to FFmpeg.
                # Direct HLS/RTMP URLs work fine. YouTube watch URLs will fail at the
                # FFmpeg stage and surface a clear error then.
                logger.warning(
                    "[watch_service] get_video_info error (using raw URL): %s",
                    info["error"],
                )
                hls_url        = url
                resolved_label = label or url
            else:
                hls_url        = info.get("stream_url") or url
                resolved_label = label or info.get("title", url)
        except Exception as exc:
            logger.warning("[watch_service] Failed to resolve stream URL: %s", exc)
            hls_url        = url
            resolved_label = label or url

        session = WatchSession(
            stream_id  = stream_id,
            source_url = url,
            label      = resolved_label,
            hls_url    = hls_url,
        )
        self._sessions[stream_id] = session

        # Ensure the shared consumer is running
        self.start()

        # Per-session audio capture task
        session._audio_task = asyncio.create_task(
            self._audio_loop(session),
            name=f"watch_audio_{stream_id}",
        )

        logger.info("[watch_service] Watching: %s  id=%s", resolved_label, stream_id)
        return {"stream_id": stream_id, "status": "starting", "label": resolved_label}

    async def stop_watch(self, stream_id: str) -> dict:
        """Stop a watch session and clean up its subprocess."""
        session = self._sessions.get(stream_id)
        if not session:
            return {"error": f"Session {stream_id} not found"}

        session.status = "stopped"

        if session._audio_task and not session._audio_task.done():
            session._audio_task.cancel()
            try:
                await session._audio_task
            except asyncio.CancelledError:
                pass

        if session._ffmpeg_proc:
            try:
                session._ffmpeg_proc.kill()
                await session._ffmpeg_proc.wait()
            except Exception:
                pass
            session._ffmpeg_proc = None

        logger.info("[watch_service] Stopped: %s  id=%s", session.label, stream_id)
        return {
            "stream_id":     stream_id,
            "status":        "stopped",
            "segment_count": session.segment_count,
            "duration_s":    int(time.time() - session.start_time),
        }

    def get_status(self, stream_id: str) -> Optional[dict]:
        s = self._sessions.get(stream_id)
        if not s:
            return None
        return {
            "stream_id":     s.stream_id,
            "label":         s.label,
            "source_url":    s.source_url,
            "status":        s.status,
            "segment_count": s.segment_count,
            "duration_s":    int(time.time() - s.start_time),
        }

    def list_sessions(self) -> list[dict]:
        return [self.get_status(sid) for sid in self._sessions if sid in self._sessions]

    def get_transcript(self, stream_id: str) -> list[dict]:
        return _load_segments(stream_id)

    # ── Internal ──────────────────────────────────────────────────────────────

    async def _audio_loop(self, session: WatchSession):
        """
        Spawn FFmpeg, read PCM chunks, drop into the shared queue.
        One task per session — runs until stream ends or session is stopped.
        """
        cmd = [
            "ffmpeg",
            "-loglevel", "error",
            "-i",        session.hls_url,
            "-vn",                      # strip video track
            "-acodec",   "pcm_s16le",   # 16-bit signed PCM
            "-ar",       str(_SAMPLE_RATE),
            "-ac",       "1",           # mono
            "-f",        "s16le",
            "pipe:1",                   # raw PCM → stdout
        ]
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
            session._ffmpeg_proc = proc
            session.status = "watching"
            logger.info("[watch_service] FFmpeg running for %s", session.stream_id)

            while session.status == "watching":
                chunk = await proc.stdout.read(_CHUNK_BYTES)
                if not chunk:
                    logger.info("[watch_service] Stream ended: %s", session.stream_id)
                    break
                # Skip chunks shorter than 0.5s — not worth transcribing
                if len(chunk) >= _SAMPLE_RATE:
                    try:
                        self._queue.put_nowait((session.stream_id, chunk))
                    except asyncio.QueueFull:
                        logger.debug(
                            "[watch_service] Queue full, dropping chunk for %s",
                            session.stream_id,
                        )

        except asyncio.CancelledError:
            pass
        except Exception as exc:
            logger.error("[watch_service] Audio loop error %s: %s", session.stream_id, exc)
            session.status = "error"
        finally:
            if session._ffmpeg_proc:
                try:
                    session._ffmpeg_proc.kill()
                except Exception:
                    pass
            if session.status == "watching":
                session.status = "stopped"

    async def _consume_loop(self):
        """
        Single consumer for the shared queue.
        Dequeues (stream_id, pcm_bytes), transcribes, stores, emits.
        Serialises all GPU whisper calls — Option A.
        """
        logger.info("[watch_service] Consumer loop running")
        loop = asyncio.get_running_loop()

        while self._running:
            try:
                stream_id, pcm_bytes = await asyncio.wait_for(
                    self._queue.get(), timeout=2.0
                )
            except asyncio.TimeoutError:
                continue
            except asyncio.CancelledError:
                break

            session = self._sessions.get(stream_id)
            if not session or session.status not in ("watching", "starting"):
                continue

            try:
                text = await loop.run_in_executor(None, _transcribe_pcm, pcm_bytes)
                if text and text.strip():
                    ts  = time.time()
                    seg = {
                        "stream_id":  stream_id,
                        "source_url": session.source_url,
                        "label":      session.label,
                        "text":       text.strip(),
                        "timestamp":  ts,
                        "start_ms":   int((ts - session.start_time) * 1000),
                    }
                    _store_segment(seg)
                    _store_to_memory(seg)
                    await _emit_segment(seg)
                    session.segment_count += 1

            except Exception as exc:
                logger.warning("[watch_service] Transcription error: %s", exc)

        logger.info("[watch_service] Consumer loop stopped")


# ─────────────────────────────────────────────────────────────────────────────
# TRANSCRIPTION (blocking — runs in executor)
# ─────────────────────────────────────────────────────────────────────────────

def _transcribe_pcm(pcm_bytes: bytes) -> str:
    """
    Transcribe raw PCM s16le (16 kHz mono) bytes via faster-whisper.
    Reuses the shared model from voice_service — no second GPU load.
    Called from run_in_executor (blocking is fine here).
    """
    import numpy as np
    from app.service.voice_service import _get_whisper_model

    model    = _get_whisper_model()
    audio_np = (
        np.frombuffer(pcm_bytes, dtype=np.int16)
        .astype(np.float32) / 32768.0
    )

    try:
        segments, _ = model.transcribe(
            audio_np,
            language      = "en",
            beam_size     = 3,      # faster than 5 for streaming use
            vad_filter    = True,
            vad_parameters = {"min_silence_duration_ms": 300},
        )
        return " ".join(seg.text.strip() for seg in segments).strip()
    except Exception as exc:
        logger.warning("[watch_service] _transcribe_pcm error: %s", exc)
        return ""


# ─────────────────────────────────────────────────────────────────────────────
# STORAGE
# ─────────────────────────────────────────────────────────────────────────────

def _ensure_transcript_db():
    """Create transcripts.db and the segment table if they don't exist."""
    TRANSCRIPT_DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(str(TRANSCRIPT_DB_PATH)) as db:
        db.execute("""
            CREATE TABLE IF NOT EXISTS transcript_segments (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                stream_id  TEXT    NOT NULL,
                source_url TEXT,
                label      TEXT,
                text       TEXT    NOT NULL,
                start_ms   INTEGER,
                timestamp  REAL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        db.execute(
            "CREATE INDEX IF NOT EXISTS idx_ts_stream_id "
            "ON transcript_segments (stream_id)"
        )
        db.commit()


def _store_segment(seg: dict):
    """Write a confirmed transcript segment to SQLite."""
    try:
        with sqlite3.connect(str(TRANSCRIPT_DB_PATH)) as db:
            db.execute(
                """
                INSERT INTO transcript_segments
                    (stream_id, source_url, label, text, start_ms, timestamp)
                VALUES (?,?,?,?,?,?)
                """,
                (
                    seg["stream_id"], seg["source_url"], seg["label"],
                    seg["text"], seg["start_ms"], seg["timestamp"],
                ),
            )
            db.commit()
    except Exception as exc:
        logger.warning("[watch_service] SQLite store failed: %s", exc)


def _store_to_memory(seg: dict):
    """
    Dual-write to ChromaDB + FTS5 via the running memory_service.
    Best-effort — failures are logged and swallowed so transcription continues.
    Stored with source="transcript" so normal memory searches surface stream content.
    """
    try:
        from app.service.memory_service import get_memory_service
        mem = get_memory_service()
        if mem is None:
            return
        doc_id  = f"transcript_{seg['stream_id']}_{uuid.uuid4().hex[:8]}"
        content = f"[Stream transcript — {seg['label']}] {seg['text']}"
        metadata = {
            "source":     "transcript",
            "stream_id":  seg["stream_id"],
            "source_url": seg["source_url"],
            "label":      seg["label"],
            "start_ms":   seg["start_ms"],
            "timestamp":  str(seg["timestamp"]),
            "agent_role": "transcript",
            "thread_id":  "",
            "area_id":    "transcript",
        }
        mem._store_layer2(doc_id, content, metadata)
        mem._store_fts5(doc_id, content, metadata)
    except Exception as exc:
        logger.debug("[watch_service] Memory store failed (non-fatal): %s", exc)


def _load_segments(stream_id: str) -> list[dict]:
    """Load all segments for a stream_id from SQLite, ordered by time."""
    try:
        with sqlite3.connect(str(TRANSCRIPT_DB_PATH)) as db:
            db.row_factory = sqlite3.Row
            rows = db.execute(
                "SELECT * FROM transcript_segments WHERE stream_id=? ORDER BY start_ms",
                (stream_id,),
            ).fetchall()
        return [dict(r) for r in rows]
    except Exception as exc:
        logger.warning("[watch_service] _load_segments error: %s", exc)
        return []


def search_transcripts(
    query: str,
    stream_id: Optional[str] = None,
    limit: int = 10,
) -> list[dict]:
    """
    Full-text LIKE search across transcript segments.
    Optionally scoped to a single stream_id.
    """
    tokens = [t for t in _re.findall(r"\w+", query.lower()) if len(t) > 1]
    if not tokens:
        return []

    like_clauses = " AND ".join("LOWER(text) LIKE ?" for _ in tokens)
    params       = [f"%{t}%" for t in tokens]

    try:
        with sqlite3.connect(str(TRANSCRIPT_DB_PATH)) as db:
            db.row_factory = sqlite3.Row
            if stream_id:
                rows = db.execute(
                    f"SELECT * FROM transcript_segments "
                    f"WHERE stream_id=? AND {like_clauses} ORDER BY start_ms LIMIT ?",
                    [stream_id] + params + [limit],
                ).fetchall()
            else:
                rows = db.execute(
                    f"SELECT * FROM transcript_segments "
                    f"WHERE {like_clauses} ORDER BY timestamp DESC LIMIT ?",
                    params + [limit],
                ).fetchall()
        return [dict(r) for r in rows]
    except Exception as exc:
        logger.warning("[watch_service] search_transcripts error: %s", exc)
        return []


# ─────────────────────────────────────────────────────────────────────────────
# SSE EMIT
# ─────────────────────────────────────────────────────────────────────────────

async def _emit_segment(seg: dict):
    """Broadcast a transcript_segment event to all connected SSE clients."""
    try:
        from app.controller.chat_controller import _emit
        await _emit("transcript_segment", {
            "stream_id": seg["stream_id"],
            "label":     seg["label"],
            "text":      seg["text"],
            "start_ms":  seg["start_ms"],
            "timestamp": seg["timestamp"],
        })
    except Exception as exc:
        logger.debug("[watch_service] SSE emit failed (non-fatal): %s", exc)


# ─────────────────────────────────────────────────────────────────────────────
# SINGLETON
# ─────────────────────────────────────────────────────────────────────────────

_daemon: Optional[WatchDaemon] = None


def get_watch_daemon() -> WatchDaemon:
    """Return the global WatchDaemon instance, creating it on first call."""
    global _daemon
    if _daemon is None:
        _daemon = WatchDaemon()
    return _daemon
