"""
AURA NX-Alpha — Streaming TTS Service

Sentence-level streaming TTS emitter. Accumulates tokens as they stream from
the interface agent, detects sentence boundaries, synthesizes each sentence
independently via piper/chatterbox, and emits audio_chunk SSE events.

The frontend plays chunks sequentially as they arrive — audio starts within
~1-2s of the first complete sentence instead of waiting for the full response.

Integrates with wake_word_service: signals set_aura_speaking + audio ducking
so the wake listener knows AURA is outputting audio and won't capture it as
user speech.
"""

import asyncio
import base64
import logging
import re
from typing import Callable, Awaitable, List, Optional

logger = logging.getLogger(__name__)

# Sentence boundary: period, exclamation, question mark, or colon/semicolon
# followed by whitespace. Requires whitespace after punctuation to avoid
# false splits on abbreviations like "Dr." or "U.S.A."
_SENTENCE_RE = re.compile(r'(?<=[.!?;:])\s+')

# Minimum character length for a sentence to be worth synthesizing on its own.
# Shorter fragments get merged with the next sentence.
_MIN_SENTENCE_LEN = 20


class StreamingTTSEmitter:
    """
    Accumulates streamed tokens, detects sentence boundaries,
    synthesizes each sentence, and emits audio_chunk SSE events.

    Usage:
        emitter = StreamingTTSEmitter(emit_fn, enabled=True)
        # During token streaming:
        await emitter.feed(token_text)
        # After response complete:
        await emitter.flush()
        # On interrupt:
        emitter.cancel()
    """

    def __init__(
        self,
        emit_fn: Callable[[str, dict], Awaitable[None]],
        enabled: bool = True,
    ):
        self._emit = emit_fn
        self._enabled = enabled
        self._buffer = ""
        self._seq = 0
        self._tasks: List[asyncio.Task] = []
        self._cancelled = False
        self._speaking_signalled = False

    async def feed(self, text: str) -> None:
        """Feed a token into the buffer. Synthesize complete sentences."""
        if not self._enabled or self._cancelled:
            return
        self._buffer += text

        # Split on sentence boundaries
        parts = _SENTENCE_RE.split(self._buffer)
        if len(parts) <= 1:
            return

        # All but the last part are complete sentences.
        # Merge short fragments with the next segment.
        pending: List[str] = []
        fragment = ""
        for sentence in parts[:-1]:
            fragment += (" " if fragment else "") + sentence.strip()
            if len(fragment) >= _MIN_SENTENCE_LEN:
                pending.append(fragment)
                fragment = ""

        # If there's a leftover short fragment, prepend it to the remaining buffer
        if fragment:
            self._buffer = fragment + " " + parts[-1]
        else:
            self._buffer = parts[-1]

        # Kick off synthesis for each complete sentence
        for sentence in pending:
            if sentence.strip():
                self._seq += 1
                task = asyncio.create_task(
                    self._synth_and_emit(sentence.strip(), self._seq)
                )
                self._tasks.append(task)

    async def flush(self) -> None:
        """Flush remaining buffer as final sentence, then emit audio_end."""
        if not self._enabled or self._cancelled:
            return

        remaining = self._buffer.strip()
        if remaining:
            self._seq += 1
            task = asyncio.create_task(
                self._synth_and_emit(remaining, self._seq)
            )
            self._tasks.append(task)
            self._buffer = ""

        # Wait for all synthesis tasks to complete
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)

        # Emit audio_end to signal frontend that all chunks have been sent
        if self._seq > 0:
            await self._emit("audio_end", {"seq_total": self._seq})

        # Signal wake word service: AURA done speaking
        self._signal_speaking(False)

    def cancel(self) -> None:
        """Stop all pending synthesis (on stop_tts or interrupt)."""
        self._cancelled = True
        for t in self._tasks:
            if not t.done():
                t.cancel()
        self._tasks.clear()
        self._signal_speaking(False)

    async def _synth_and_emit(self, sentence: str, seq: int) -> None:
        """Synthesize one sentence and emit as audio_chunk SSE event."""
        if self._cancelled:
            return

        # Signal AURA speaking on first chunk
        if seq == 1:
            self._signal_speaking(True)

        try:
            from app.service.voice_service import synthesize_text_async
            wav_bytes = await synthesize_text_async(sentence)
        except Exception as exc:
            logger.error("[streaming_tts] Synthesis error for seq %d: %s", seq, exc)
            return

        if self._cancelled or not wav_bytes:
            return

        b64 = base64.b64encode(wav_bytes).decode("ascii")
        await self._emit("audio_chunk", {
            "data": b64,
            "format": "wav",
            "seq": seq,
        })

    def _signal_speaking(self, speaking: bool) -> None:
        """Notify wake word service of AURA's speaking state + audio ducking."""
        if speaking and self._speaking_signalled:
            return
        if not speaking and not self._speaking_signalled:
            return

        self._speaking_signalled = speaking
        try:
            from app.service.wake_word_service import (
                set_aura_speaking,
                set_audio_ducking,
            )
            set_aura_speaking(speaking)
            set_audio_ducking(speaking)
            logger.debug(
                "[streaming_tts] AURA speaking=%s, ducking=%s",
                speaking, speaking,
            )
        except ImportError:
            pass
        except Exception as exc:
            logger.debug("[streaming_tts] Signal speaking error: %s", exc)
