"""
AURA NX-Alpha — BaseAgent
All agent templates inherit from this class.

Provides:
    - Ollama LLM access (local-only, no external APIs)
    - JSON-mode LLM calls
    - Structured run() interface
    - Standard logging pattern
    - Input/output schema declaration for registry validation

Usage:
    class MyAgent(BaseAgent):
        AGENT_ID    = "my_agent_v1"
        INPUTS      = ["ticker_list", "price_stream"]
        OUTPUTS     = ["signal_report"]
        REQUIRES_LLM = True

        async def run(self, inputs: dict) -> dict:
            ...
"""

from __future__ import annotations

import json
import logging
import time
from abc import ABC, abstractmethod
from typing import Any

logger = logging.getLogger(__name__)


class BaseAgent(ABC):
    """
    Abstract base for all AURA agent templates.

    Class-level declarations (override in subclasses):
        AGENT_ID     : str   — matches registry.json id field
        INPUTS       : list  — expected input keys
        OUTPUTS      : list  — guaranteed output keys on success
        REQUIRES_LLM : bool  — whether this agent calls Ollama
        REAL_TIME    : bool  — whether this agent needs live streaming data
        FREE_TIER    : bool  — True if all data sources are free-tier
    """

    AGENT_ID:     str  = "base_agent"
    INPUTS:       list = []
    OUTPUTS:      list = []
    REQUIRES_LLM: bool = False
    REAL_TIME:    bool = False
    FREE_TIER:    bool = True

    def __init__(self) -> None:
        self.logger = logging.getLogger(f"agents.{self.AGENT_ID}")
        self._run_count   = 0
        self._error_count = 0
        self._last_run_ms = 0.0

    # ─────────────────────────────────────────────────────────────────────────
    # ABSTRACT INTERFACE
    # ─────────────────────────────────────────────────────────────────────────

    @abstractmethod
    async def run(self, inputs: dict) -> dict:
        """
        Execute the agent.

        Args:
            inputs: Dict with keys declared in INPUTS.

        Returns:
            Dict with keys declared in OUTPUTS, plus:
                _agent_id  : str   — AGENT_ID
                _run_ms    : float — wall-clock ms for this run
                _error     : str   — present only if run failed
        """

    # ─────────────────────────────────────────────────────────────────────────
    # RUN WRAPPER — timing + error envelope
    # ─────────────────────────────────────────────────────────────────────────

    async def execute(self, inputs: dict) -> dict:
        """Wraps run() with timing, error handling, and metadata injection."""
        t0 = time.monotonic()
        self._run_count += 1
        try:
            result = await self.run(inputs)
            elapsed = (time.monotonic() - t0) * 1000
            self._last_run_ms = elapsed
            result["_agent_id"] = self.AGENT_ID
            result["_run_ms"]   = round(elapsed, 1)
            return result
        except Exception as exc:
            self._error_count += 1
            elapsed = (time.monotonic() - t0) * 1000
            self.logger.error("[%s] run() failed: %s", self.AGENT_ID, exc, exc_info=True)
            return {
                "_agent_id": self.AGENT_ID,
                "_run_ms":   round(elapsed, 1),
                "_error":    str(exc),
            }

    # ─────────────────────────────────────────────────────────────────────────
    # LLM HELPERS — all routed through local Ollama
    # ─────────────────────────────────────────────────────────────────────────

    async def _llm(
        self,
        prompt:      str,
        system:      str   = "",
        temperature: float = 0.7,
    ) -> str:
        """
        Call the local Ollama workhorse model. Returns the response as a string.
        Never calls an external API — local-only.
        """
        from app.service.ollama_service import get_ollama_service
        svc = get_ollama_service()
        if svc is None:
            raise RuntimeError("OllamaService not initialised")

        messages: list[dict] = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})

        response = await svc.chat(messages, temperature=temperature)
        return response if isinstance(response, str) else str(response)

    async def _llm_json(
        self,
        prompt:      str,
        system:      str   = "Respond only with valid JSON. No markdown, no explanation.",
        temperature: float = 0.2,
    ) -> Any:
        """
        Call local Ollama and parse the response as JSON.
        Returns parsed dict/list, or raises ValueError on parse failure.
        """
        from app.service.ollama_service import get_ollama_service
        svc = get_ollama_service()
        if svc is None:
            raise RuntimeError("OllamaService not initialised")

        messages: list[dict] = [
            {"role": "system", "content": system},
            {"role": "user",   "content": prompt},
        ]

        # Try svc.chat_json first (returns parsed object if available)
        if hasattr(svc, "chat_json"):
            return await svc.chat_json(messages, temperature=temperature)

        raw = await svc.chat(messages, temperature=temperature)
        raw = raw.strip()

        # Strip markdown code fences if present
        if raw.startswith("```"):
            raw = raw.split("```")[1]
            if raw.startswith("json"):
                raw = raw[4:]
        raw = raw.strip()

        try:
            return json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ValueError(f"LLM did not return valid JSON: {exc}\nRaw: {raw[:300]}") from exc

    # ─────────────────────────────────────────────────────────────────────────
    # INPUT VALIDATION HELPER
    # ─────────────────────────────────────────────────────────────────────────

    def _require(self, inputs: dict, *keys: str) -> None:
        """Raise ValueError if any required input key is missing."""
        missing = [k for k in keys if k not in inputs]
        if missing:
            raise ValueError(f"[{self.AGENT_ID}] Missing required inputs: {missing}")

    # ─────────────────────────────────────────────────────────────────────────
    # STATUS
    # ─────────────────────────────────────────────────────────────────────────

    def status(self) -> dict:
        """Return runtime stats for monitoring."""
        return {
            "agent_id":    self.AGENT_ID,
            "run_count":   self._run_count,
            "error_count": self._error_count,
            "last_run_ms": self._last_run_ms,
        }
