"""
AURA NX-Alpha — User Profile Service
Persistent per-user profile that grows from real conversations.

Extracted signals are stored in SQLite (user_profile table, created by
memory_service._init_layer1) and dual-written to ChromaDB L2 with
source='user_profile' so they surface via existing build_context() retrieval.

Profile updates fire asynchronously from _record_exchange() — zero latency
impact on streaming. Workhorse LLM extraction only runs for substantive
exchanges (>50 words) and degrades gracefully if Ollama is unavailable.

SINGLETON:
    init_user_profile_service(l1_path) once at boot (via boot_sequence).
    Everywhere else: get_user_profile_service().
"""

from __future__ import annotations

import json
import logging
import re
import sqlite3
import time

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# LOCAL EXTRACTION — heuristics, no LLM
# ─────────────────────────────────────────────────────────────────────────────

# (field, list-of-regex-patterns) — first capture group becomes the value
_LOCAL_PATTERNS: list[tuple[str, list[str]]] = [
    ("expertise", [
        r"\bi(?:'m| am) (?:a |an )?(?:senior |junior |lead )?(\w[\w\s]{2,30}?)(?:\s+by|\s+with|\s+at|\s+and|,|\.|$)",
        r"\bi(?:'ve| have) been (?:doing|working with|writing|building|using) ([\w\s]{3,30}?) for \d",
        r"\bmy (?:background|expertise|experience) is (?:in )?([\w\s]{3,30})",
    ]),
    ("project", [
        r"\bworking on ([A-Z][\w\s\-]{2,40})",
        r"\bbuilding ([A-Z][\w\s\-]{2,40})",
        r"\bproject\s+(?:called\s+|named\s+)?([A-Z][\w\s\-]{2,30})",
    ]),
    ("interest", [
        r"\bi(?:'m| am) (?:really\s+)?interested in ([\w\s]{3,30})",
        r"\bi (?:love|enjoy|like) (?:working (?:with|on) )?([\w\s]{3,25})",
    ]),
    ("goal", [
        r"\bmy goal is to ([\w\s]{4,50})",
        r"\bi want to ([\w\s]{4,40})",
        r"\bwe(?:'re| are) trying to ([\w\s]{4,40})",
        r"\bwe(?:'re| are) aiming to ([\w\s]{4,40})",
    ]),
]

# Known project/domain keywords that should be captured as `project` signals
_KNOWN_PROJECTS = {
    "nx-alpha", "nxalpha", "gleipnir", "gleipnir consulting",
    "bhnyc", "nomad", "n.o.m.a.d", "aura", "eve online", "eveo",
}

# Communication style markers
_STYLE_MARKERS = {
    "direct": ["just give me", "be direct", "no fluff", "skip the preamble", "short answer"],
    "detailed": ["explain in detail", "walk me through", "step by step"],
    "technical": ["technical explanation", "low level", "under the hood"],
}


def _extract_local(user_msg: str) -> list[tuple[str, str]]:
    """
    Fast heuristic signal extraction from a single user message.
    Returns list of (field, value) tuples. No LLM required.
    """
    signals: list[tuple[str, str]] = []
    lower = user_msg.lower()

    # Pattern-based extraction
    for field, patterns in _LOCAL_PATTERNS:
        for pat in patterns:
            m = re.search(pat, user_msg, re.IGNORECASE)
            if m:
                val = m.group(1).strip().rstrip(".,!?")
                if 3 <= len(val) <= 60:
                    signals.append((field, val))
                break  # one match per field per message

    # Known project mentions
    for kw in _KNOWN_PROJECTS:
        if kw in lower:
            display = kw.title()
            signals.append(("project", display))

    # Communication style preferences
    for style, markers in _STYLE_MARKERS.items():
        if any(m in lower for m in markers):
            signals.append(("style", style))

    return signals


# ─────────────────────────────────────────────────────────────────────────────
# WORKHORSE EXTRACTION — structured LLM pass for substantive exchanges
# ─────────────────────────────────────────────────────────────────────────────

_WORKHORSE_PROMPT = """\
You are analyzing a conversation exchange to build a user profile.
Extract facts about the USER (not the assistant) from this exchange.

Return ONLY a JSON object with these optional keys (omit any that don't apply):
{
  "expertise": ["..."],      // skills, technologies, professional background
  "project": ["..."],        // projects they are working on
  "interest": ["..."],       // topics they find interesting
  "goal": ["..."],           // objectives they mentioned
  "style": ["..."]           // communication preferences (direct/detailed/technical)
}

Rules:
- Only extract facts clearly stated by the user, not inferred
- Keep each value concise (3-50 words)
- Return empty object {{}} if nothing notable is present
- Return valid JSON only — no explanation, no markdown

USER MESSAGE: {user_msg}

ASSISTANT RESPONSE: {aura_response}

JSON:"""


async def _extract_workhorse(user_msg: str, aura_response: str) -> list[tuple[str, str]]:
    """
    Use the Ollama workhorse to extract profile signals from a full exchange.
    Only called for substantive messages (>50 words). Degrades gracefully.
    """
    try:
        from app.service.ollama_service import get_ollama_service
        svc = get_ollama_service()
        if svc is None:
            return []

        prompt = _WORKHORSE_PROMPT.format(
            user_msg=user_msg[:800],
            aura_response=aura_response[:400],
        )
        raw = await svc.chat(
            messages=[{"role": "user", "content": prompt}],
            temperature=0.0,
            max_tokens=256,
        )

        # Strip markdown fences if present
        raw = raw.strip()
        if raw.startswith("```"):
            raw = re.sub(r"^```(?:json)?\s*", "", raw)
            raw = re.sub(r"\s*```$", "", raw)

        data = json.loads(raw)
        signals: list[tuple[str, str]] = []
        for field, values in data.items():
            if isinstance(values, list):
                for v in values:
                    if isinstance(v, str) and 3 <= len(v.strip()) <= 120:
                        signals.append((field, v.strip()))
            elif isinstance(values, str) and 3 <= len(values.strip()) <= 120:
                signals.append((field, values.strip()))
        return signals

    except json.JSONDecodeError:
        logger.debug("[user_profile] Workhorse returned non-JSON — skipping")
        return []
    except Exception as exc:
        logger.debug("[user_profile] Workhorse extraction failed: %s", exc)
        return []


# ─────────────────────────────────────────────────────────────────────────────
# USER PROFILE SERVICE
# ─────────────────────────────────────────────────────────────────────────────

class UserProfileService:
    """
    Manages a persistent user profile stored in SQLite + ChromaDB L2.
    Profile accumulates automatically from conversation exchanges.
    """

    VALID_FIELDS = {"expertise", "project", "interest", "goal", "style"}

    def __init__(self, l1_path: str) -> None:
        self._l1_path = l1_path

    # ── Storage ──────────────────────────────────────────────────────────────

    def _upsert_signal(self, field: str, value: str, source_thread: str) -> None:
        """Insert or update a (field, value) pair in user_profile table."""
        now = time.time()
        with sqlite3.connect(self._l1_path) as db:
            existing = db.execute(
                "SELECT id, occurrence FROM user_profile WHERE field=? AND value=?",
                (field, value),
            ).fetchone()
            if existing:
                row_id, occ = existing
                new_occ = occ + 1
                new_conf = min(1.0, 0.3 + new_occ * 0.1)
                db.execute(
                    "UPDATE user_profile SET occurrence=?, confidence=?, last_seen=? WHERE id=?",
                    (new_occ, new_conf, now, row_id),
                )
            else:
                db.execute(
                    """INSERT INTO user_profile
                       (field, value, confidence, first_seen, last_seen, occurrence, source_thread)
                       VALUES (?,?,?,?,?,?,?)""",
                    (field, value, 0.4, now, now, 1, source_thread),
                )

    def _store_l2(self, field: str, value: str) -> None:
        """Dual-write profile signal to ChromaDB L2 with source='user_profile'."""
        try:
            from app.service.memory_service import get_memory_service
            mem = get_memory_service()
            if mem is None:
                return
            import uuid
            doc_id = f"profile_{uuid.uuid4().hex[:12]}"
            mem._store_layer2(doc_id, f"{field}: {value}", {
                "doc_id":     doc_id,
                "source":     "user_profile",
                "agent_role": "user_profile",
                "profile_field": field,
                "timestamp":  str(time.time()),
            })
        except Exception as exc:
            logger.debug("[user_profile] L2 write failed: %s", exc)

    # ── Public API ────────────────────────────────────────────────────────────

    async def update_from_exchange(
        self,
        user_msg: str,
        aura_response: str,
        thread_id: str,
    ) -> None:
        """
        Extract and persist profile signals from a conversation exchange.
        Always runs local heuristics; runs workhorse only for long messages.
        Called as asyncio.create_task — does not block streaming.
        """
        signals: list[tuple[str, str]] = []

        # Fast local extraction — always
        signals.extend(_extract_local(user_msg))

        # Workhorse extraction — only for substantive messages, if Ollama is up
        word_count = len(user_msg.split())
        if word_count > 50:
            deep = await _extract_workhorse(user_msg, aura_response)
            signals.extend(deep)

        # Persist unique signals (field must be in VALID_FIELDS)
        seen: set[tuple[str, str]] = set()
        for field, value in signals:
            if field not in self.VALID_FIELDS:
                continue
            key = (field, value.lower()[:60])
            if key in seen:
                continue
            seen.add(key)
            try:
                self._upsert_signal(field, value, thread_id)
                self._store_l2(field, value)
            except Exception as exc:
                logger.debug("[user_profile] Signal persist failed: %s", exc)

        if signals:
            logger.debug("[user_profile] %d signals stored from exchange", len(seen))

    def get_profile(self) -> dict[str, list[dict]]:
        """Return all profile entries grouped by field."""
        with sqlite3.connect(self._l1_path) as db:
            db.row_factory = sqlite3.Row
            rows = db.execute(
                "SELECT field, value, confidence, occurrence, last_seen "
                "FROM user_profile ORDER BY field, confidence DESC"
            ).fetchall()
        result: dict[str, list[dict]] = {}
        for r in rows:
            d = dict(r)
            result.setdefault(d["field"], []).append(d)
        return result

    def format_for_prompt(self, max_chars: int = 800) -> str:
        """
        Format profile as a compact block for system prompt injection.
        High-confidence entries first. Truncated to max_chars.
        """
        with sqlite3.connect(self._l1_path) as db:
            rows = db.execute(
                "SELECT field, value, confidence FROM user_profile "
                "WHERE confidence >= 0.4 "
                "ORDER BY confidence DESC, occurrence DESC LIMIT 30"
            ).fetchall()

        if not rows:
            return ""

        grouped: dict[str, list[str]] = {}
        for field, value, _ in rows:
            grouped.setdefault(field, []).append(value)

        lines = ["USER PROFILE (persistent model of this user):"]
        for field, values in grouped.items():
            joined = ", ".join(values[:4])
            lines.append(f"  {field}: {joined}")

        block = "\n".join(lines)
        return block[:max_chars]

    def delete_field_value(self, field: str, value: str) -> bool:
        """Remove a specific (field, value) pair."""
        with sqlite3.connect(self._l1_path) as db:
            cur = db.execute(
                "DELETE FROM user_profile WHERE field=? AND value=?", (field, value)
            )
            return cur.rowcount > 0

    def reset(self) -> int:
        """Clear all profile data. Returns number of rows deleted."""
        with sqlite3.connect(self._l1_path) as db:
            cur = db.execute("DELETE FROM user_profile")
            return cur.rowcount


# ─────────────────────────────────────────────────────────────────────────────
# SINGLETON
# ─────────────────────────────────────────────────────────────────────────────

_profile_service: UserProfileService | None = None


def init_user_profile_service(l1_path: str) -> UserProfileService:
    """Called once at boot after memory_service is initialized."""
    global _profile_service
    _profile_service = UserProfileService(l1_path)
    logger.info("[user_profile] Initialized — SQLite path: %s", l1_path)
    return _profile_service


def get_user_profile_service() -> UserProfileService | None:
    return _profile_service
