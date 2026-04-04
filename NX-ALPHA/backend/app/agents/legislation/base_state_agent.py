"""
AURA NX-Alpha — Base State Legislature Agent

Per-state monitoring agent. Invoked by scheduler_service._handle_state_monitor()
when a legislative_digest task has a state_code in its parameters.

Flow:
    1. scraper_service.scrape() fetches the legislature URL
    2. Ollama extracts bill identifiers + last actions from the Markdown
    3. Compare extracted data against legislation DB (sync)
    4. Persist changed/new bills back to legislation DB (sync)
    5. Ollama summarizes the changes (async)
    6. emit_fn fires a legislation_update SSE event if changes found

Scheduler integration:
    Create a task via scheduler_service.create_task():
        {
            "name": "California Legislature Monitor",
            "task_type": "legislative_digest",
            "schedule": STATE_CONFIGS["CA"].default_cron,
            "parameters": {"state_code": "CA", "context": "personal"},
        }
    _handle_legislative_digest() detects state_code and dispatches here.
"""

import json
import logging
from datetime import datetime
from typing import Callable, Optional

logger = logging.getLogger(__name__)


class BaseStateAgent:
    """
    Monitors a single state legislature for new or changed bill activity.

    Instantiated fresh per scheduler run — no persistent state beyond the DB.
    """

    def __init__(self, state_code: str) -> None:
        from app.agents.legislation.state_configs import STATE_CONFIGS
        self.state_code = state_code.upper()
        self.config = STATE_CONFIGS.get(self.state_code)

    async def run(self, inputs: dict, emit_fn: Optional[Callable] = None) -> dict:
        """
        Run one monitoring cycle for this state.

        Args:
            inputs:   {"context": "client" | "personal"}
            emit_fn:  async callable(data: dict) — called when changes found.
                      Typically wired to scheduler._emit("legislation_update", data).

        Returns:
            {
                state_code:    str,
                new_bills:     list[dict],   # bills inserted (not previously in DB)
                changed_bills: list[dict],   # all bills with new/changed last_action
                summary:       str,          # LLM-generated narrative
                checked_at:    str,          # ISO timestamp
            }
        """
        context = inputs.get("context", "personal")

        if not self.config or not self.config.enabled:
            logger.info("[state_agent:%s] Skipped — not configured or disabled", self.state_code)
            return {
                "state_code": self.state_code,
                "new_bills": [],
                "changed_bills": [],
                "summary": "",
                "checked_at": datetime.now().isoformat(),
            }

        # 1. Scrape + LLM extraction
        extracted_bills = await self._fetch_via_scrape()

        # 2. Change detection (sync — local SQLite reads are ~1 ms each)
        from app.service.legislation_service import get_legislation_service
        svc = get_legislation_service()
        changed_bills: list[dict] = []
        if svc and extracted_bills:
            changed_bills = self._detect_changes(svc, extracted_bills)

        # 3. Persist changes back to legislation DB
        if svc and changed_bills:
            self._persist_changes(svc, changed_bills)

        # 4. LLM summarization
        summary = ""
        if changed_bills:
            summary = await self._summarize_changes(changed_bills, context)

        result = {
            "state_code": self.state_code,
            "new_bills": [b for b in changed_bills if b.get("is_new")],
            "changed_bills": changed_bills,
            "summary": summary,
            "checked_at": datetime.now().isoformat(),
        }

        # 5. Emit SSE
        if changed_bills and emit_fn:
            await emit_fn({
                "state_code": self.state_code,
                "state_name": self.config.name,
                "summary": summary,
                "changed_count": len(changed_bills),
                "new_count": len(result["new_bills"]),
            })

        logger.info(
            "[state_agent:%s] Done — %d changed (%d new)",
            self.state_code, len(changed_bills), len(result["new_bills"]),
        )
        return result

    # ── Scrape + LLM Extraction ───────────────────────────────────────────────

    async def _fetch_via_scrape(self) -> list[dict]:
        """Scrape the legislature URL and extract structured bill data via LLM."""
        from app.service.scraper_service import scrape
        content = await scrape(self.config.legislature_url)
        if not content:
            logger.warning("[state_agent:%s] Scrape returned empty content", self.state_code)
            return []
        logger.debug("[state_agent:%s] Scraped %d chars", self.state_code, len(content))
        return await self._extract_bills_from_markdown(content)

    async def _extract_bills_from_markdown(self, content: str) -> list[dict]:
        """
        Ask Ollama to parse bill identifiers and last actions from raw Markdown.

        Returns a list of dicts: {identifier, title, last_action, last_action_date}.
        Falls back to [] on LLM unavailability or non-JSON output.
        """
        from app.service.ollama_service import get_ollama_service
        svc = get_ollama_service()
        if not svc:
            logger.warning("[state_agent:%s] Ollama not available for extraction", self.state_code)
            return []

        messages = [
            {
                "role": "system",
                "content": (
                    "You are a legislative data parser. "
                    "Extract bill identifiers and their current status or last action "
                    "from the provided legislature page text. "
                    "Return ONLY a JSON array. Each element must be: "
                    '{"identifier": "HB 42", "title": "...", '
                    '"last_action": "...", "last_action_date": "YYYY-MM-DD or empty string"}. '
                    "If no bills are visible, return []. "
                    "Output raw JSON only — no markdown fences, no explanation."
                ),
            },
            {
                "role": "user",
                "content": (
                    f"Extract all bills from this {self.config.name} legislature page:\n\n"
                    + content[:4000]
                ),
            },
        ]

        try:
            raw = await svc.chat(messages=messages, temperature=0.1, max_tokens=2048)
            clean = raw.strip()
            # Strip markdown code fences if the model wraps its output anyway
            if clean.startswith("```"):
                parts = clean.split("```")
                clean = parts[1].lstrip("json").strip() if len(parts) > 1 else clean
            bills = json.loads(clean)
            if not isinstance(bills, list):
                return []
            return bills
        except json.JSONDecodeError:
            logger.warning("[state_agent:%s] LLM extraction returned non-JSON", self.state_code)
            return []
        except Exception as exc:
            logger.error("[state_agent:%s] LLM extraction error: %s", self.state_code, exc)
            return []

    # ── Change Detection ──────────────────────────────────────────────────────

    def _detect_changes(self, svc, extracted_bills: list[dict]) -> list[dict]:
        """
        Compare extracted bills against the legislation DB.

        A bill is flagged as changed if:
        - It doesn't exist in the DB yet (is_new=True), OR
        - Its last_action text differs from the stored value

        Returns the subset of extracted_bills that have new/changed activity,
        each annotated with is_new: bool.
        """
        changed = []
        for bill in extracted_bills:
            identifier = (bill.get("identifier") or "").strip()
            if not identifier:
                continue
            existing = svc.get_bill_by_identifier(self.state_code, identifier)
            if not existing or existing.get("last_action") != bill.get("last_action"):
                changed.append({**bill, "is_new": existing is None})
        return changed

    # ── Persist ───────────────────────────────────────────────────────────────

    def _persist_changes(self, svc, changed_bills: list[dict]) -> None:
        """
        Write changed/new bills to the legislation DB via upsert_bill().
        Updates last_action + last_action_date for existing bills;
        inserts a stub row for new ones.
        """
        today = datetime.now().date().isoformat()
        for bill in changed_bills:
            identifier = (bill.get("identifier") or "").strip()
            if not identifier:
                continue
            svc.upsert_bill(
                state_code=self.state_code,
                identifier=identifier,
                title=bill.get("title") or identifier,
                last_action=bill.get("last_action") or "",
                last_action_date=bill.get("last_action_date") or today,
            )

    # ── Summarize ─────────────────────────────────────────────────────────────

    async def _summarize_changes(self, changed_bills: list[dict], context: str) -> str:
        """
        Generate a short narrative summary of the changed bills via Ollama.

        context="client"   → Gleipnir-style: policy impact + stakeholder risk
        context="personal" → personal research: practical significance
        """
        from app.service.ollama_service import get_ollama_service
        svc = get_ollama_service()
        if not svc:
            return ""

        context_note = (
            "for Gleipnir Consulting client analysis — focus on policy impact and stakeholder risk"
            if context == "client"
            else "for personal research tracking — focus on practical significance"
        )

        bill_lines = "\n".join(
            "- {}: {} — {}".format(
                b.get("identifier", "Unknown"),
                b.get("title", ""),
                b.get("last_action", "new activity"),
            )
            for b in changed_bills[:20]
        )

        messages = [
            {
                "role": "system",
                "content": (
                    f"You are a legislative analyst preparing a brief {context_note}. "
                    "Be concise — 2 to 4 sentences maximum."
                ),
            },
            {
                "role": "user",
                "content": (
                    f"Summarize these {self.config.name} legislative updates:\n\n{bill_lines}"
                ),
            },
        ]

        try:
            return await svc.chat(messages=messages, temperature=0.5, max_tokens=512)
        except Exception as exc:
            logger.error("[state_agent:%s] Summarization failed: %s", self.state_code, exc)
            return ""
