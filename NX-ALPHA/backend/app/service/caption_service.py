"""
AURA NX-Alpha — Caption Service (Passive CC Extraction)

Zero-GPU subtitle extraction from HLS live streams via ffmpeg.
Provides ambient current-events awareness for the Interface engine.

ARCHITECTURE:
    N Haystack/YouTube HLS streams
      -> ffmpeg -i <m3u8> -map 0:s:0 -f webvtt -  (VTT subtitle track, ~0 CPU)
      -> rolling text buffer per feed (deque, 5-min window)
      -> entity fingerprinting + dedup
      -> condensed story ledger (in-memory, 2-hour TTL)
      -> ChromaDB Layer 2 (per-story, deduplicated)

    Interface gains ambient current-events awareness via semantic search.

SINGLETON PATTERN:
    init_caption_service()          — call from boot_sequence
    get_caption_service()           — accessor
    start_caption_streams(feeds)    — called when Intel feed opens
    stop_caption_streams()          — called when Intel feed closes
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import re
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Optional

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

_BUFFER_WINDOW_SEC = 300        # 5-minute rolling window per feed
_CHUNK_INTERVAL_SEC = 30        # process captions every 30 seconds
_LEDGER_TTL_SEC = 7200          # 2-hour TTL for story ledger entries
_LEDGER_CLEANUP_SEC = 600       # run ledger cleanup every 10 minutes
_MIN_CAPTION_LEN = 20           # ignore very short caption fragments
_CORROBORATION_THRESHOLD = 3    # sources needed for HIGH confidence
_SIMILARITY_THRESHOLD = 0.85    # cosine distance for same-story match


# ---------------------------------------------------------------------------
# Entity extraction — lightweight regex-based proper noun extraction
# ---------------------------------------------------------------------------

# Matches capitalised multi-word phrases (proper nouns, org names, places)
_PROPER_NOUN_RE = re.compile(
    r"\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b"
)

# Common words that look like proper nouns but aren't
_STOPWORDS = frozenset({
    "The", "This", "That", "These", "Those", "There", "Here", "Where",
    "When", "What", "Which", "Who", "How", "And", "But", "For", "Not",
    "With", "From", "Into", "Over", "After", "Before", "Between",
    "Under", "Above", "Below", "Just", "Also", "Very", "Still",
    "Now", "Then", "Well", "Back", "About", "More", "Some", "Other",
    "New", "Good", "First", "Last", "Next", "Right", "Left",
    "Breaking", "Live", "Watch", "Today", "Tonight", "Report",
    "Coming", "Going", "Says", "Said", "According", "Welcome",
})


def _extract_entities(text: str) -> list[str]:
    """Extract proper noun phrases from caption text."""
    matches = _PROPER_NOUN_RE.findall(text)
    return [m for m in matches if m not in _STOPWORDS and len(m) > 2]


def _fingerprint(entities: list[str], top_n: int = 5) -> str:
    """Create a fingerprint hash from the top N most frequent entities."""
    if not entities:
        return ""
    # Count frequency, take top N
    freq: dict[str, int] = {}
    for e in entities:
        key = e.lower()
        freq[key] = freq.get(key, 0) + 1
    top = sorted(freq, key=freq.get, reverse=True)[:top_n]
    joined = "|".join(sorted(top))
    return hashlib.md5(joined.encode()).hexdigest()[:12]


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------

@dataclass
class CaptionChunk:
    """A single processed caption segment."""
    text: str
    timestamp: float
    source: str  # feed label / channel name


@dataclass
class StoryEntry:
    """An entry in the rolling story ledger."""
    fingerprint: str
    headline: str           # first substantial caption that created this entry
    sources: set[str] = field(default_factory=set)
    entity_bag: list[str] = field(default_factory=list)
    caption_snippets: list[str] = field(default_factory=list)
    first_seen: float = field(default_factory=time.time)
    last_seen: float = field(default_factory=time.time)
    written_to_memory: bool = False


@dataclass
class FeedBuffer:
    """Rolling caption buffer for a single feed."""
    feed_id: str
    label: str
    hls_url: str
    buffer: deque = field(default_factory=lambda: deque(maxlen=600))  # ~10/sec * 300s
    _ffmpeg_proc: object = field(default=None, repr=False)
    _reader_task: object = field(default=None, repr=False)
    status: str = "idle"  # idle | running | stopped | error


# ---------------------------------------------------------------------------
# Caption Service
# ---------------------------------------------------------------------------

class CaptionService:
    """
    Manages passive caption extraction from multiple HLS streams.
    Extracts VTT subtitle tracks via ffmpeg, deduplicates stories
    across feeds, and writes condensed intel to ChromaDB Layer 2.
    """

    def __init__(self):
        self._feeds: dict[str, FeedBuffer] = {}
        self._story_ledger: dict[str, StoryEntry] = {}
        self._running = False
        self._process_task: Optional[asyncio.Task] = None
        self._cleanup_task: Optional[asyncio.Task] = None
        logger.info("[caption_service] Initialized")

    # -- Public API ---------------------------------------------------------

    async def start_streams(self, feeds: list[dict]) -> dict:
        """
        Start caption extraction for a list of feeds.
        Each feed dict: {"id": str, "label": str, "hls_url": str}
        """
        self._running = True
        started = []

        for feed in feeds:
            feed_id = feed["id"]
            if feed_id in self._feeds and self._feeds[feed_id].status == "running":
                continue  # already running

            fb = FeedBuffer(
                feed_id=feed_id,
                label=feed.get("label", feed_id),
                hls_url=feed["hls_url"],
            )
            self._feeds[feed_id] = fb

            fb._reader_task = asyncio.create_task(
                self._caption_reader(fb),
                name=f"caption_{feed_id}",
            )
            fb.status = "running"
            started.append(feed_id)

        # Start the processing loop if not already running
        if self._process_task is None or self._process_task.done():
            self._process_task = asyncio.create_task(
                self._process_loop(), name="caption_process"
            )

        # Start the ledger cleanup loop
        if self._cleanup_task is None or self._cleanup_task.done():
            self._cleanup_task = asyncio.create_task(
                self._cleanup_loop(), name="caption_cleanup"
            )

        logger.info("[caption_service] Started %d streams: %s", len(started), started)
        return {"started": started, "total_active": len(self._feeds)}

    async def stop_streams(self, feed_ids: list[str] | None = None):
        """Stop specific streams, or all if feed_ids is None."""
        targets = feed_ids or list(self._feeds.keys())

        for fid in targets:
            fb = self._feeds.get(fid)
            if not fb:
                continue
            fb.status = "stopped"
            if fb._reader_task and not fb._reader_task.done():
                fb._reader_task.cancel()
                try:
                    await fb._reader_task
                except asyncio.CancelledError:
                    pass
            if fb._ffmpeg_proc:
                try:
                    fb._ffmpeg_proc.kill()
                    await fb._ffmpeg_proc.wait()
                except Exception:
                    pass
                fb._ffmpeg_proc = None
            del self._feeds[fid]

        # If no feeds left, stop processing loop
        if not self._feeds:
            self._running = False
            if self._process_task and not self._process_task.done():
                self._process_task.cancel()
            if self._cleanup_task and not self._cleanup_task.done():
                self._cleanup_task.cancel()

        logger.info("[caption_service] Stopped streams: %s", targets)

    def get_status(self) -> dict:
        """Return current status of all feeds and story ledger."""
        return {
            "running": self._running,
            "feeds": {
                fid: {
                    "label": fb.label,
                    "status": fb.status,
                    "buffer_size": len(fb.buffer),
                }
                for fid, fb in self._feeds.items()
            },
            "ledger_size": len(self._story_ledger),
            "ledger_entries": [
                {
                    "headline": e.headline[:80],
                    "sources": list(e.sources),
                    "confidence": "HIGH" if len(e.sources) >= _CORROBORATION_THRESHOLD else "NORMAL",
                    "age_min": round((time.time() - e.first_seen) / 60, 1),
                }
                for e in self._story_ledger.values()
            ],
        }

    # -- FFmpeg VTT reader --------------------------------------------------

    async def _caption_reader(self, fb: FeedBuffer):
        """
        Extract VTT subtitle track from HLS stream via ffmpeg.
        Runs as an async subprocess, reads text lines from stdout.
        """
        cmd = [
            "ffmpeg",
            "-i", fb.hls_url,
            "-map", "0:s:0",         # first subtitle track
            "-f", "webvtt",
            "-loglevel", "error",
            "pipe:1",                 # stdout
        ]

        logger.info("[caption_service] Starting ffmpeg for %s: %s", fb.feed_id, fb.hls_url)

        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            fb._ffmpeg_proc = proc

            # Read VTT output line by line
            partial_text = ""
            async for line_bytes in proc.stdout:
                if fb.status == "stopped":
                    break

                line = line_bytes.decode("utf-8", errors="replace").strip()

                # Skip VTT headers and timestamp lines
                if not line or line.startswith("WEBVTT") or line.startswith("NOTE"):
                    continue
                if "-->" in line:
                    # Timestamp line — flush any accumulated text
                    if partial_text and len(partial_text) >= _MIN_CAPTION_LEN:
                        fb.buffer.append(CaptionChunk(
                            text=partial_text.strip(),
                            timestamp=time.time(),
                            source=fb.label,
                        ))
                    partial_text = ""
                    continue
                # Skip numeric cue IDs
                if line.isdigit():
                    continue

                # Accumulate caption text, strip VTT tags
                clean = re.sub(r"<[^>]+>", "", line)
                if clean:
                    partial_text = f"{partial_text} {clean}" if partial_text else clean

            # Flush last partial
            if partial_text and len(partial_text) >= _MIN_CAPTION_LEN:
                fb.buffer.append(CaptionChunk(
                    text=partial_text.strip(),
                    timestamp=time.time(),
                    source=fb.label,
                ))

            # Check stderr for errors
            stderr_data = await proc.stderr.read()
            if stderr_data:
                err_msg = stderr_data.decode("utf-8", errors="replace").strip()
                # Subtitle track not found is expected for some streams
                if "Stream map '0:s:0' matches no streams" in err_msg:
                    logger.info(
                        "[caption_service] No subtitle track for %s — trying audio fallback",
                        fb.feed_id,
                    )
                    # Fall back to audio-based caption extraction if available
                    await self._audio_fallback(fb)
                elif err_msg:
                    logger.warning("[caption_service] ffmpeg stderr for %s: %s", fb.feed_id, err_msg[:200])

        except asyncio.CancelledError:
            logger.debug("[caption_service] Reader cancelled for %s", fb.feed_id)
        except Exception as exc:
            logger.error("[caption_service] Reader error for %s: %s", fb.feed_id, exc)
            fb.status = "error"
        finally:
            if fb._ffmpeg_proc:
                try:
                    fb._ffmpeg_proc.kill()
                    await fb._ffmpeg_proc.wait()
                except Exception:
                    pass
                fb._ffmpeg_proc = None

    async def _audio_fallback(self, fb: FeedBuffer):
        """
        Fallback: if no VTT subtitle track, use the existing watch_service
        transcription pipeline (Whisper) for this feed. This is heavier
        (uses GPU) but ensures we get captions from streams without embedded subs.
        """
        try:
            from app.service.watch_service import get_watch_daemon
            daemon = get_watch_daemon()
            if daemon is None:
                logger.info("[caption_service] No watch daemon — skipping audio fallback for %s", fb.feed_id)
                return
            result = await daemon.start_watch(fb.hls_url, label=f"caption:{fb.label}")
            logger.info(
                "[caption_service] Audio fallback started for %s → stream_id=%s",
                fb.feed_id, result.get("stream_id"),
            )
        except Exception as exc:
            logger.warning("[caption_service] Audio fallback failed for %s: %s", fb.feed_id, exc)

    # -- Processing loop ----------------------------------------------------

    async def _process_loop(self):
        """
        Periodically process caption buffers across all feeds:
        extract entities, fingerprint, dedup, and write to memory.
        """
        logger.info("[caption_service] Processing loop started")

        try:
            while self._running:
                await asyncio.sleep(_CHUNK_INTERVAL_SEC)

                for fb in list(self._feeds.values()):
                    if fb.status != "running" or not fb.buffer:
                        continue
                    self._process_feed_buffer(fb)

                # Write high-confidence stories to ChromaDB
                self._write_stories_to_memory()

        except asyncio.CancelledError:
            logger.debug("[caption_service] Processing loop cancelled")

    def _process_feed_buffer(self, fb: FeedBuffer):
        """Process recent captions from a single feed buffer."""
        now = time.time()
        cutoff = now - _CHUNK_INTERVAL_SEC

        # Collect recent chunks (within the last processing interval)
        recent_chunks = [c for c in fb.buffer if c.timestamp >= cutoff]
        if not recent_chunks:
            return

        # Combine text from recent chunks
        combined_text = " ".join(c.text for c in recent_chunks)
        if len(combined_text) < _MIN_CAPTION_LEN:
            return

        # Extract entities and create fingerprint
        entities = _extract_entities(combined_text)
        fp = _fingerprint(entities)

        if not fp:
            return

        # Check story ledger for existing entry
        if fp in self._story_ledger:
            entry = self._story_ledger[fp]
            entry.sources.add(fb.label)
            entry.last_seen = now
            entry.entity_bag.extend(entities)
            # Keep snippets manageable (last 10)
            entry.caption_snippets.append(combined_text[:200])
            if len(entry.caption_snippets) > 10:
                entry.caption_snippets = entry.caption_snippets[-10:]
        else:
            # New story
            self._story_ledger[fp] = StoryEntry(
                fingerprint=fp,
                headline=combined_text[:120],
                sources={fb.label},
                entity_bag=entities,
                caption_snippets=[combined_text[:200]],
            )

    def _write_stories_to_memory(self):
        """Write mature/corroborated stories to ChromaDB Layer 2."""
        try:
            from app.service.memory_service import get_memory_service
            mem = get_memory_service()
            if mem is None:
                return
        except Exception:
            return

        now = time.time()

        for fp, entry in self._story_ledger.items():
            if entry.written_to_memory:
                continue

            # Write when: corroborated (3+ sources) OR aged 5+ minutes
            age = now - entry.first_seen
            corroborated = len(entry.sources) >= _CORROBORATION_THRESHOLD

            if not corroborated and age < 300:
                continue  # wait for more corroboration or aging

            confidence = "HIGH" if corroborated else "NORMAL"
            source_list = ", ".join(sorted(entry.sources))

            # Condense the story from caption snippets
            condensed = self._condense_story(entry)

            doc_id = f"live_caption_{fp}"
            content = (
                f"[LIVE INTEL] {entry.headline}\n"
                f"Sources: {source_list}\n"
                f"Confidence: {confidence} ({len(entry.sources)} source(s))\n"
                f"Details: {condensed}"
            )

            meta = {
                "doc_id": doc_id,
                "source": "live_caption",
                "agent_role": "intelligence_collector",
                "thread_id": "",
                "area_id": "",
                "timestamp": str(entry.first_seen),
                "tags": ",".join(sorted(set(e.lower() for e in entry.entity_bag[:20]))),
                "confidence": confidence,
                "feed_sources": source_list,
            }

            try:
                # Check for existing doc (dedup)
                if hasattr(mem, '_collection') and mem._collection is not None:
                    existing = mem._collection.get(ids=[doc_id])
                    if existing and existing.get("ids"):
                        entry.written_to_memory = True
                        continue
            except Exception:
                pass

            mem._store_layer2(doc_id, content, meta)
            entry.written_to_memory = True
            logger.info(
                "[caption_service] Wrote story to memory: %s [%s] (%s)",
                entry.headline[:60], confidence, source_list,
            )

    def _condense_story(self, entry: StoryEntry) -> str:
        """Condense caption snippets into a brief summary."""
        if not entry.caption_snippets:
            return entry.headline

        # Take unique snippets, join with ellipsis, truncate
        seen: set[str] = set()
        unique: list[str] = []
        for snip in entry.caption_snippets:
            # Simple dedup: skip if >80% overlap with any existing
            snip_words = set(snip.lower().split())
            is_dup = False
            for existing in seen:
                existing_words = set(existing.lower().split())
                if snip_words and existing_words:
                    overlap = len(snip_words & existing_words) / max(len(snip_words), len(existing_words))
                    if overlap > 0.8:
                        is_dup = True
                        break
            if not is_dup:
                unique.append(snip)
                seen.add(snip)

        combined = " ... ".join(unique[:5])
        return combined[:500]

    # -- Ledger cleanup -----------------------------------------------------

    async def _cleanup_loop(self):
        """Periodically purge expired entries from the story ledger."""
        try:
            while self._running:
                await asyncio.sleep(_LEDGER_CLEANUP_SEC)
                self._purge_expired()
        except asyncio.CancelledError:
            pass

    def _purge_expired(self):
        """Remove story entries older than TTL."""
        now = time.time()
        expired = [
            fp for fp, entry in self._story_ledger.items()
            if now - entry.last_seen > _LEDGER_TTL_SEC
        ]
        for fp in expired:
            del self._story_ledger[fp]
        if expired:
            logger.debug("[caption_service] Purged %d expired stories", len(expired))


# ---------------------------------------------------------------------------
# Singleton
# ---------------------------------------------------------------------------

_instance: Optional[CaptionService] = None


def init_caption_service() -> CaptionService:
    """Initialize the caption service singleton. Called from boot_sequence."""
    global _instance
    if _instance is None:
        _instance = CaptionService()
    return _instance


def get_caption_service() -> Optional[CaptionService]:
    """Get the caption service instance."""
    return _instance


async def start_caption_streams(feeds: list[dict]) -> dict:
    """
    Convenience: start caption extraction for feeds.
    Each feed: {"id": str, "label": str, "hls_url": str}
    """
    svc = get_caption_service()
    if svc is None:
        svc = init_caption_service()
    return await svc.start_streams(feeds)


async def stop_caption_streams(feed_ids: list[str] | None = None):
    """Convenience: stop caption extraction."""
    svc = get_caption_service()
    if svc:
        await svc.stop_streams(feed_ids)
