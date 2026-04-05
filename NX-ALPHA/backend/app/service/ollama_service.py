"""
AURA NX-Alpha — Ollama Service
Wrapper around the ollama Python client for workhorse model calls.
All pipeline nodes use this to call the Ollama-hosted model.
"""

import asyncio
import json
import logging
import time

logger = logging.getLogger(__name__)


class OllamaService:
    """
    Async wrapper around the synchronous ollama Python client.
    All blocking calls are dispatched via asyncio.to_thread.
    Tracks workhorse load state for auto-purge and Interface Engine scaling.
    """

    def __init__(
        self,
        model: str,
        host: str,
        num_gpu: int = -1,
        num_ctx: int = 16384,
        keep_alive: str = "5m",
    ) -> None:
        self.model = model
        self.host = host
        self.num_gpu = num_gpu
        self.num_ctx = num_ctx
        # Ollama's Go backend parses keep_alive as time.Duration; the string "-1"
        # has no unit suffix and is rejected with HTTP 400. Pass integer -1 instead
        # so the JSON payload sends a number, which Ollama treats as "never unload".
        self.keep_alive: str | int = -1 if keep_alive == "-1" else keep_alive
        # Parse keep_alive string to seconds for load-state estimation
        try:
            from app.config import _parse_keep_alive_sec
            self._keep_alive_sec = _parse_keep_alive_sec(keep_alive)
        except Exception:
            self._keep_alive_sec = 300  # default 5m
        self._last_used: float = 0.0
        self._workhorse_ever_loaded: bool = False
        # Reuse a single ollama.Client to avoid socket leaks
        import ollama
        self._client: ollama.Client = ollama.Client(host=self.host)

    @property
    def is_probably_loaded(self) -> bool:
        """Estimate whether Ollama still has the model in VRAM based on keep_alive."""
        if not self._workhorse_ever_loaded:
            return False
        if self._keep_alive_sec < 0:   # "-1" = never unloads
            return True
        return time.time() - self._last_used < self._keep_alive_sec

    @property
    def idle_seconds(self) -> float:
        """Seconds since last workhorse request (0.0 if never used)."""
        if not self._workhorse_ever_loaded:
            return 0.0
        return time.time() - self._last_used

    def _mark_used(self) -> None:
        """Record a successful request."""
        self._last_used = time.time()
        self._workhorse_ever_loaded = True

    def _opts(self, **extra) -> dict:
        """Build options dict with GPU offload + context size + caller overrides."""
        base = {"num_gpu": self.num_gpu, "num_ctx": self.num_ctx}
        base.update(extra)
        return base

    async def chat(
        self,
        messages: list[dict],
        temperature: float = 0.7,
        max_tokens: int = 2048,
    ) -> str:
        """
        Send a chat request to Ollama and return the assistant's reply as a string.

        Args:
            messages:    Conversation turns — [{"role": "user"|"system"|"assistant", "content": str}]
            temperature: Sampling temperature (0.0–1.0).
            max_tokens:  Maximum tokens to generate.

        Returns:
            The model's reply content as a plain string.

        Raises:
            Re-raises any exception from the ollama client after logging.
        """

        def _call() -> str:
            response = self._client.chat(
                model=self.model,
                messages=messages,
                keep_alive=self.keep_alive,
                options=self._opts(temperature=temperature, num_predict=max_tokens),
            )
            content = response.message.content or ""
            # Qwen 3.5+ uses Ollama's native thinking API — thinking tokens
            # go into a separate `thinking` field, leaving `content` empty
            # until the model finishes reasoning.  Fall back to the thinking
            # text so callers always receive a non-empty string.
            if not content.strip():
                thinking = getattr(response.message, "thinking", None) or ""
                if thinking.strip():
                    logger.info("[ollama_service] content empty, returning thinking text (%d chars)", len(thinking))
                    return thinking.strip()
            return content

        try:
            result = await asyncio.to_thread(_call)
            self._mark_used()
            return result
        except Exception as exc:
            logger.error("[ollama_service] chat() failed: %s", exc)
            raise

    async def chat_with_image(
        self,
        prompt: str,
        image_b64: str,
        model: str | None = None,
        temperature: float = 0.7,
    ) -> str:
        """
        Send a chat request with a base64 image for vision analysis.

        Args:
            prompt:      Text prompt describing what to do with the image.
            image_b64:   Raw base64-encoded image data (no data URI prefix).
            model:       Override model name. Defaults to self.model.
            temperature: Sampling temperature.

        Returns:
            The model's reply content as a plain string.
        """

        use_model = model or self.model

        def _call() -> str:
            response = self._client.chat(
                model=use_model,
                messages=[
                    {
                        "role": "user",
                        "content": prompt,
                        "images": [image_b64],
                    }
                ],
                keep_alive=self.keep_alive,
                options=self._opts(temperature=temperature),
            )
            return response.message.content

        try:
            result = await asyncio.to_thread(_call)
            self._mark_used()
            return result
        except Exception as exc:
            logger.error("[ollama_service] chat_with_image() failed: %s", exc)
            raise

    async def chat_json(
        self,
        messages: list[dict],
        temperature: float = 0.3,
        schema: dict | None = None,
    ) -> dict:
        """
        Send a chat request to Ollama forcing JSON output and return the parsed dict.

        Args:
            messages:    Conversation turns.
            temperature: Lower temperature for more deterministic JSON output.
            schema:      Optional JSON schema dict. When provided, Ollama uses
                         grammar-constrained decoding to guarantee the output
                         matches the schema exactly (requires Ollama >= 0.5).
                         When None, falls back to format="json" (unconstrained).

        Returns:
            Parsed JSON dict from the model's reply, or {} on parse failure.
        """

        fmt = schema if schema is not None else "json"

        def _call() -> str:
            response = self._client.chat(
                model=self.model,
                messages=messages,
                format=fmt,
                options=self._opts(temperature=temperature),
            )
            return response.message.content

        try:
            raw = await asyncio.to_thread(_call)
        except Exception as exc:
            logger.error("[ollama_service] chat_json() failed: %s", exc)
            raise

        try:
            return json.loads(raw)
        except json.JSONDecodeError as exc:
            logger.error("[ollama_service] chat_json() JSON parse error: %s — raw: %.200s", exc, raw)
            return {}

    async def chat_with_tools(
        self,
        messages: list[dict],
        tools: list[dict],
        temperature: float = 0.4,
    ) -> dict:
        """
        Send a chat request with native Ollama tool calling.

        Args:
            messages:    Conversation turns.
            tools:       List of tool definitions in Ollama format:
                         [{"type": "function", "function": {"name": ..., "description": ..., "parameters": ...}}]
            temperature: Sampling temperature.

        Returns:
            {"content": str, "tool_calls": list[dict]} where each tool_call is
            {"name": str, "arguments": dict}. tool_calls is [] if no tools called.
        """

        def _call():
            return self._client.chat(
                model=self.model,
                messages=messages,
                tools=tools,
                options=self._opts(temperature=temperature),
            )

        try:
            response = await asyncio.to_thread(_call)
        except Exception as exc:
            logger.error("[ollama_service] chat_with_tools() failed: %s", exc)
            raise

        content = response.message.content or ""
        tool_calls = []
        if response.message.tool_calls:
            for tc in response.message.tool_calls:
                tool_calls.append({
                    "name": tc.function.name,
                    "arguments": tc.function.arguments or {},
                })

        return {"content": content, "tool_calls": tool_calls}

    async def stream_chat(
        self,
        messages: list[dict],
        emit_fn,
        msg_id: str,
        temperature: float = 0.7,
    ) -> str:
        """
        Stream tokens from Ollama, calling emit_fn for each chunk.

        Args:
            messages:    Conversation turns.
            emit_fn:     Async callable: await emit_fn(event_name, payload_dict)
            msg_id:      Message ID forwarded in each token event.
            temperature: Sampling temperature.

        Returns:
            The full accumulated text response.
        """
        import queue as _queue

        token_queue: _queue.Queue = _queue.Queue()
        _SENTINEL = object()

        def _stream_to_queue() -> None:
            for chunk in self._client.chat(
                model=self.model,
                messages=messages,
                stream=True,
                keep_alive=self.keep_alive,
                options=self._opts(temperature=temperature),
            ):
                text = chunk.message.content or ""
                if text:
                    token_queue.put(text)
            token_queue.put(_SENTINEL)

        loop = asyncio.get_running_loop()
        thread_fut = loop.run_in_executor(None, _stream_to_queue)

        full_text: list[str] = []
        in_think = False
        think_buf: list[str] = []
        chat_started = False
        plain_think_detected = False

        # Plain-text thinking headers emitted by some GGUF tokenizer configurations
        _PLAIN_THINK_PREFIXES = ("Thinking Process:", "Analyze the Request:")

        while True:
            try:
                item = token_queue.get_nowait()
            except _queue.Empty:
                await asyncio.sleep(0.01)
                continue

            if item is _SENTINEL:
                break

            full_text.append(item)
            accumulated = "".join(full_text)

            # Detect plain-text thinking headers before any chat tokens are emitted
            if not in_think and not plain_think_detected and not chat_started:
                if any(accumulated.startswith(p) for p in _PLAIN_THINK_PREFIXES):
                    plain_think_detected = True
            if plain_think_detected:
                continue  # Buffer everything via full_text, emit after stream ends

            # Buffer tokens while inside <think> block
            if not in_think and "<think>" in accumulated and "</think>" not in accumulated:
                in_think = True
                think_buf.append(item)
                continue
            elif in_think:
                think_buf.append(item)
                if "</think>" in accumulated:
                    # Thinking complete — extract and send to canvas
                    import re
                    think_match = re.search(r'<think>(.*?)</think>', accumulated, re.DOTALL)
                    if think_match:
                        thinking = think_match.group(1).strip()
                        if thinking:
                            await emit_fn("thinking", {"text": thinking})
                    # Stream any text after </think> as chat tokens
                    after_think = accumulated.split("</think>", 1)[1].strip()
                    if after_think:
                        await emit_fn("token", {"text": after_think, "messageId": msg_id})
                        chat_started = True
                    in_think = False
                continue

            # Not in think block — stream directly to chat
            # Skip leading <think> tag if it appears in a single token
            if not chat_started and "<think>" in item:
                continue
            await emit_fn("token", {"text": item, "messageId": msg_id})
            chat_started = True

        # Ensure the thread has fully completed
        await thread_fut

        import re
        raw = "".join(full_text)

        # Post-stream: handle plain-text thinking headers (buffered above)
        if plain_think_detected:
            parts = re.split(r'\n{2,}', raw)
            thinking_parts: list[str] = []
            response_parts: list[str] = []
            found_response = False
            for part in parts:
                stripped = part.strip()
                if found_response:
                    response_parts.append(stripped)
                elif (
                    stripped
                    and not stripped.startswith(('*', '#', '-'))
                    and not re.match(r'^\d+\.', stripped)
                    and not re.match(r'^\*{2}', stripped)
                    and 'Thinking Process' not in stripped
                    and 'Analyze the Request' not in stripped
                    and 'Constraint' not in stripped
                    and len(thinking_parts) >= 1
                ):
                    found_response = True
                    response_parts.append(stripped)
                else:
                    thinking_parts.append(stripped)
            thinking = '\n\n'.join(thinking_parts).strip()
            clean = '\n\n'.join(response_parts).strip()
            if thinking:
                await emit_fn("thinking", {"text": thinking})
            if clean:
                await emit_fn("token", {"text": clean, "messageId": msg_id})
            return clean

        # Return clean text (without think blocks)
        result = re.sub(r'<think>.*?</think>', '', raw, flags=re.DOTALL).strip()
        self._mark_used()
        return result

    def is_available(self) -> bool:
        """
        Synchronously probe Ollama to check availability.

        Returns:
            True if the Ollama server is reachable and responds to list(), False otherwise.
        """
        try:
            self._client.list()
            return True
        except Exception:
            return False

    async def unload_model(self) -> bool:
        """
        Ask Ollama to unload the current model from VRAM.
        Uses the generate endpoint with keep_alive=0, which tells Ollama
        to immediately free the model's memory.

        Returns:
            True if unload succeeded (or model wasn't loaded), False on error.
        """
        import httpx

        async with httpx.AsyncClient(timeout=10) as client:
            try:
                resp = await client.post(
                    f"{self.host}/api/generate",
                    json={"model": self.model, "keep_alive": 0},
                )
                if resp.status_code == 200:
                    logger.info("[ollama_service] Unloaded model %s from VRAM", self.model)
                    self._last_used = 0.0
                    self._workhorse_ever_loaded = False
                    return True
                else:
                    logger.warning(
                        "[ollama_service] Unload request returned %d: %s",
                        resp.status_code, resp.text[:200],
                    )
                    return False
            except Exception as exc:
                # Ollama not running or unreachable — nothing to unload
                logger.debug("[ollama_service] Unload skipped (server unreachable): %s", exc)
                return True


# ─────────────────────────────────────────────────────────────────────────────
# SINGLETON
# ─────────────────────────────────────────────────────────────────────────────

_ollama_service: OllamaService | None = None


def get_ollama_service() -> OllamaService | None:
    """Return the initialized OllamaService singleton, or None if not yet initialized."""
    return _ollama_service


def init_ollama_service(model: str, host: str, num_gpu: int = -1, num_ctx: int = 16384, keep_alive: str = "5m") -> OllamaService:
    """
    Initialize (or re-initialize) the OllamaService singleton.

    Args:
        model:   Ollama model name (e.g. "qwen3:32b").
        host:    Ollama server URL (e.g. "http://127.0.0.1:11434").
        num_gpu: GPU layers to offload (-1 = all layers on GPU).
        num_ctx: Context window size (controls KV cache VRAM).

    Returns:
        The initialized OllamaService instance.
    """
    global _ollama_service
    _ollama_service = OllamaService(model=model, host=host, num_gpu=num_gpu, num_ctx=num_ctx, keep_alive=keep_alive)
    logger.info("[ollama_service] Initialized: model=%s host=%s num_gpu=%d num_ctx=%d keep_alive=%s", model, host, num_gpu, num_ctx, keep_alive)
    return _ollama_service
