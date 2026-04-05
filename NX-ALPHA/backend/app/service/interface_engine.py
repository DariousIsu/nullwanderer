"""
AURA NX-Alpha — Interface Engine (§28)
Always-loaded interface model (qwen3.5:9b) via Ollama.
keep_alive=-1 keeps it permanently in VRAM.
Vision handled natively by Ollama's multimodal support.

LIFECYCLE:
    Instantiated in boot_sequence Phase 2.
    Constructor is lightweight — call load() to init the Ollama service + pull model.
    load() is called via run_in_executor since ollama pull is synchronous.

STUB MODE:
    When AURA_DEV_STUB_RESPONSES=True or Ollama is unreachable,
    the engine runs in stub mode: generate() returns a canned response.
"""

from __future__ import annotations

import asyncio
import json
import logging
import queue as _queue
import time
from typing import TYPE_CHECKING

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# MODULE-LEVEL SINGLETON
# ─────────────────────────────────────────────────────────────────────────────

_engine: "InterfaceEngine | None" = None


def register_engine(engine: "InterfaceEngine") -> None:
    """Called from boot_sequence after engine is loaded."""
    global _engine
    _engine = engine
    logger.debug("[interface_engine] Engine registered in singleton")


def get_engine() -> "InterfaceEngine | None":
    """Return the running engine instance, or None if not loaded."""
    return _engine


# ─────────────────────────────────────────────────────────────────────────────
# INTERFACE ENGINE
# ─────────────────────────────────────────────────────────────────────────────

class InterfaceEngine:
    """
    Always-loaded interface model (qwen3.5:9b) via Ollama.
    keep_alive=-1 keeps the model permanently in VRAM.
    All vision calls use Ollama's native multimodal support (no mmproj needed).
    """

    def __init__(self, interface_model_config):
        """Lightweight constructor. Call load() to init Ollama service."""
        self._cfg = interface_model_config
        self._loaded: bool = False
        self._idle_since: float = time.time()
        self._svc = None   # OllamaService instance, set in load()

    # ── LOADING ───────────────────────────────────────────────────────────────

    def load(self, skip_vram_check: bool = False) -> None:
        """
        Init OllamaService and ensure model is available.
        Called via run_in_executor from boot_sequence (ollama client is synchronous).
        """
        from app.service.ollama_service import OllamaService

        self._svc = OllamaService(
            model=self._cfg.model,
            host=self._cfg.ollama_host,
            num_gpu=-1,
            num_ctx=self._cfg.context_size,
            keep_alive=self._cfg.keep_alive,
        )

        # Verify Ollama is reachable
        if not self._svc.is_available():
            logger.warning(
                "[interface_engine] Ollama not reachable at %s — stub mode active",
                self._cfg.ollama_host,
            )
            self._loaded = False
            return

        # Pull model if not present (fast no-op if already pulled)
        try:
            self._svc._client.pull(self._cfg.model)
            logger.info("[interface_engine] Model ready: %s", self._cfg.model)
        except Exception as exc:
            logger.warning("[interface_engine] Pull warning (model may already exist): %s", exc)

        self._loaded = True

    # ── GENERATION ────────────────────────────────────────────────────────────

    async def generate(
        self,
        messages: list[dict],
        max_tokens: int = 512,
        grammar=None,
        temperature: float = 0.7,
    ) -> dict:
        """
        Generate a response via Ollama.

        Returns:
            {"text": str, "tokens_used": int, "latency_ms": float}
        """
        if not self._loaded or self._svc is None:
            return self._stub_generate(messages)

        start = time.perf_counter()
        try:
            if grammar is not None:
                # grammar arg is a JSON schema dict when coming from generate_with_schema
                result = await self._svc.chat_json(messages, temperature=temperature, schema=grammar)
                text = json.dumps(result) if isinstance(result, dict) else str(result)
            else:
                text = await self._svc.chat(messages, temperature=temperature, max_tokens=max_tokens)
        except Exception as exc:
            logger.error("[interface_engine] generate() failed: %s", exc)
            return self._stub_generate(messages)

        elapsed_ms = (time.perf_counter() - start) * 1000
        self._idle_since = time.time()
        return {"text": text, "tokens_used": 0, "latency_ms": round(elapsed_ms)}

    async def generate_streaming(
        self,
        messages: list[dict],
        max_tokens: int = 512,
        temperature: float = 0.7,
    ):
        """
        Async generator that yields clean text chunks (think blocks stripped).
        Uses Ollama streaming via a thread queue.
        """
        if not self._loaded or self._svc is None:
            result = self._stub_generate(messages)
            for word in result["text"].split():
                yield word + " "
                await asyncio.sleep(0.025)
            return

        token_queue: _queue.Queue = _queue.Queue()
        _SENTINEL = object()

        def _stream_sync() -> None:
            chunk_count = 0
            try:
                for chunk in self._svc._client.chat(
                    model=self._svc.model,
                    messages=messages,
                    stream=True,
                    keep_alive=self._svc.keep_alive,
                    options=self._svc._opts(temperature=temperature, num_predict=max_tokens),
                ):
                    chunk_count += 1
                    text = chunk.message.content or ""
                    if text:
                        token_queue.put(("content", text))
                    # Qwen 3.5+ uses Ollama's native thinking field instead
                    # of embedding <think> tags inside content.
                    thinking = getattr(chunk.message, "thinking", None) or ""
                    if thinking:
                        token_queue.put(("think", thinking))
                    # Detect stop reason on final chunk
                    done = getattr(chunk, 'done', False)
                    if done:
                        reason = getattr(chunk, 'done_reason', None)
                        if reason and reason != 'stop':
                            logger.warning(
                                "[interface_engine] Stream ended with done_reason=%r"
                                " (chunks=%d) — model may have hit token limit",
                                reason, chunk_count,
                            )
            except Exception as exc:
                logger.warning("[interface_engine] Streaming error: %s", exc)
            finally:
                if chunk_count == 0:
                    logger.warning("[interface_engine] Ollama returned 0 chunks — model not loaded?")
                token_queue.put(_SENTINEL)

        loop = asyncio.get_running_loop()
        executor_fut = loop.run_in_executor(None, _stream_sync)

        # Stream tokens, handling both:
        # 1. Native thinking field (Qwen 3.5+ via Ollama) — tagged ("think"/"content")
        # 2. Legacy <think> tags in content (DeepSeek-R1 style) — fallback path
        content_accumulated = ""
        think_accumulated = ""
        in_think = False
        think_resolved = False
        anything_yielded = False
        native_thinking = False  # True once we see a ("think", ...) tuple

        while True:
            try:
                item = token_queue.get_nowait()
            except _queue.Empty:
                await asyncio.sleep(0.01)
                continue

            if item is _SENTINEL:
                break

            # Handle tagged tuples from _stream_sync
            if isinstance(item, tuple):
                tag, text = item
                if tag == "think":
                    native_thinking = True
                    think_accumulated += text
                    continue
                else:  # "content"
                    content_accumulated += text
                    # Native thinking path — content tokens stream directly
                    if native_thinking or think_resolved:
                        yield text
                        anything_yielded = True
                        continue
                    # Fall through to legacy <think> tag handling
                    item = text
            else:
                content_accumulated += item

            # Legacy path: strip <think>...</think> from content text
            if not think_resolved:
                if "<think>" in content_accumulated and not in_think:
                    in_think = True

                if in_think:
                    if "</think>" in content_accumulated:
                        in_think = False
                        think_resolved = True
                        after = content_accumulated.split("</think>", 1)[1]
                        if after.strip():
                            yield after
                            anything_yielded = True
                    continue
                else:
                    # Detect orphan </think> — model emitted thinking without
                    # an opening <think> tag (e.g. "Thinking Process:\n...\n</think>").
                    if "</think>" in content_accumulated:
                        think_resolved = True
                        after = content_accumulated.split("</think>", 1)[1]
                        if after.strip():
                            yield after
                            anything_yielded = True
                        continue
                    # Buffer at the very start when content looks like a think prefix
                    # so we can catch the orphan </think> before yielding anything.
                    if not anything_yielded and content_accumulated.lstrip().startswith("Thinking"):
                        if len(content_accumulated) < 1500:
                            continue  # Still waiting for </think> or more content
                        # Exceeded buffer without </think> — real content, flush all
                        think_resolved = True
                        yield content_accumulated
                        anything_yielded = True
                        continue
                    think_resolved = True
                    yield item
                    anything_yielded = True
                    continue
            else:
                yield item
                anything_yielded = True

        # Guard: model generated only thinking with no response content (token budget
        # exhausted during reasoning). Yield the thinking content so the caller
        # receives a non-empty string instead of triggering the fallback error.
        if not anything_yielded:
            fallback = think_accumulated.strip() or content_accumulated.strip()
            if fallback:
                import re as _re
                fallback = _re.sub(r"</?think>", "", fallback).strip()
            if fallback:
                logger.warning(
                    "[interface_engine] Think-only response (no content after thinking)"
                    " — yielding thinking content as response (%d chars)",
                    len(fallback),
                )
                yield fallback

        self._idle_since = time.time()
        await executor_fut

    async def generate_with_schema(
        self,
        messages: list[dict],
        schema: dict,
        max_tokens: int = 1024,
    ) -> dict:
        """Generate JSON-constrained output using Ollama's format parameter."""
        if not self._loaded or self._svc is None:
            return self._stub_generate(messages)
        start = time.perf_counter()
        try:
            result = await self._svc.chat_json(messages, schema=schema)
        except Exception as exc:
            logger.error("[interface_engine] generate_with_schema() failed: %s", exc)
            return self._stub_generate(messages)
        elapsed_ms = (time.perf_counter() - start) * 1000
        self._idle_since = time.time()
        return {"text": json.dumps(result), "tokens_used": 0, "latency_ms": round(elapsed_ms)}

    def _stub_generate(self, messages: list[dict]) -> dict:
        """Stub response when model not loaded."""
        user_msg = next(
            (m.get("content", "") for m in reversed(messages) if m.get("role") == "user"),
            ""
        )
        text = (
            f"[STUB MODE] Interface Engine not loaded. "
            f"Ensure Ollama is running and {self._cfg.model if self._cfg else 'model'} is pulled. "
            f"Your message: \"{user_msg[:80]}{'...' if len(user_msg) > 80 else ''}\""
        )
        return {"text": text, "tokens_used": 0, "latency_ms": 0.0}

    # ── UNLOAD ────────────────────────────────────────────────────────────────

    async def unload(self) -> None:
        """Ask Ollama to unload the model from VRAM."""
        if not self._loaded or self._svc is None:
            return
        await self._svc.unload_model()
        self._loaded = False

    async def shutdown(self) -> None:
        """Unload model on app exit."""
        await self.unload()

    # ── VISION ────────────────────────────────────────────────────────────────

    @property
    def has_vision(self) -> bool:
        """Always True — qwen3.5 is natively multimodal via Ollama."""
        return self._loaded and self._svc is not None

    async def generate_vision(
        self,
        image_b64: str,
        prompt: str,
        max_tokens: int = 512,
    ) -> dict:
        """
        Analyse an image using Ollama's native multimodal support.

        Args:
            image_b64: Raw base64 string (no data URI prefix).
            prompt:    Text question/instruction about the image.
            max_tokens: Generation budget.

        Returns:
            {"text": str, "tokens_used": int, "latency_ms": float}
        """
        if not self.has_vision:
            return self._stub_generate([{"role": "user", "content": prompt}])

        start = time.perf_counter()
        try:
            text = await self._svc.chat_with_image(prompt, image_b64)
        except Exception as exc:
            logger.error("[interface_engine] generate_vision() failed: %s", exc)
            return self._stub_generate([{"role": "user", "content": prompt}])
        elapsed_ms = (time.perf_counter() - start) * 1000
        self._idle_since = time.time()
        return {"text": text, "tokens_used": 0, "latency_ms": round(elapsed_ms)}

    # ── HEALTH ────────────────────────────────────────────────────────────────

    def health_check(self) -> dict:
        """Return health status dict for /status endpoint."""
        return {
            "model_loaded": self._loaded,
            "stub_mode":    not self._loaded,
            "vram_free_mb": None,
            "idle_seconds": round(time.time() - self._idle_since),
        }

    @property
    def idle_seconds(self) -> float:
        return time.time() - self._idle_since

    # ── IDLE MAINTENANCE ──────────────────────────────────────────────────────

    async def idle_maintenance_loop(self, memory_service) -> None:
        """
        Background task: triggers CPU-only maintenance when the engine is idle.
        Started as asyncio.create_task() in main.py lifespan.
        """
        idle_threshold = 300    # 5 minutes
        check_interval = 60     # check every minute

        while True:
            await asyncio.sleep(check_interval)

            if self.idle_seconds > idle_threshold:
                logger.debug("[interface_engine] Idle >5min — running maintenance")
                try:
                    await memory_service.run_idle_maintenance()
                except Exception as exc:
                    logger.warning("[interface_engine] Idle maintenance error: %s", exc)
