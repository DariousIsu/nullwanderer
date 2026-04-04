"""
AURA NX-Alpha — Skill Capture Service
Detects, distills, and stores reusable multi-step procedures from conversations.

Captured skills are stored in:
  - SQLite `skills` table + `skills_fts` virtual table (created by memory_service._init_layer1)
  - ChromaDB L2 with source='skill' (surfaced by existing build_context() retrieval)

Skills can be triggered manually (POST /skills/capture) or automatically when
AURA's suggest_capture() heuristic fires during a response.

SINGLETON:
    init_skill_capture_service(l1_path) at boot.
    Everywhere else: get_skill_capture_service().
"""

from __future__ import annotations

import json
import logging
import re
import sqlite3
import time
import uuid
from pathlib import Path

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# DISTILLATION PROMPT
# ─────────────────────────────────────────────────────────────────────────────

_DISTILL_PROMPT = """\
You are extracting a reusable procedure from a conversation.

Analyze this conversation and write a concise, reusable SKILL document.

Return ONLY a JSON object with exactly these keys:
{{
  "title": "Short descriptive title (5-10 words)",
  "description": "One-sentence description of what this skill does",
  "procedure": "Step-by-step markdown procedure (use numbered list, be specific and reusable)"
}}

Rules:
- Title: imperative verb phrase ("Draft a Policy Brief", "Research Legislation", "Structure an EVE Market Report")
- Description: one sentence, what the skill does and when to use it
- Procedure: numbered steps (## Step 1: ...), concrete and reusable — not specific to this particular conversation
- Return valid JSON only — no explanation, no markdown fences

CONVERSATION (last {n_turns} turns):
{thread_content}

{title_hint}

JSON:"""


async def _distill_procedure(
    thread_turns: list[dict],
    title: str | None = None,
) -> tuple[str, str, str]:
    """
    Use the Ollama workhorse to distill a conversation thread into a structured procedure.
    Returns (title, description, procedure_markdown).
    Falls back to a minimal default on failure.
    """
    # Format thread for prompt — last 10 turns, truncated
    lines = []
    for t in thread_turns[-10:]:
        role = t.get("role", "unknown").upper()
        content = (t.get("content", "") or "")[:500]
        lines.append(f"{role}: {content}")
    thread_content = "\n\n".join(lines)

    title_hint = f'Suggested title: "{title}"' if title else ""

    prompt = _DISTILL_PROMPT.format(
        n_turns=len(thread_turns[-10:]),
        thread_content=thread_content,
        title_hint=title_hint,
    )

    try:
        from app.service.ollama_service import get_ollama_service
        svc = get_ollama_service()
        if svc is None:
            raise RuntimeError("Ollama not available")

        raw = await svc.chat(
            messages=[{"role": "user", "content": prompt}],
            temperature=0.2,
            max_tokens=512,
        )

        # Strip markdown fences if model wrapped the JSON
        raw = raw.strip()
        if raw.startswith("```"):
            raw = re.sub(r"^```(?:json)?\s*", "", raw)
            raw = re.sub(r"\s*```$", "", raw)

        data = json.loads(raw)
        return (
            str(data.get("title", title or "Untitled Skill")),
            str(data.get("description", "")),
            str(data.get("procedure", "")),
        )

    except json.JSONDecodeError:
        logger.debug("[skill_capture] Distillation returned non-JSON — using fallback")
    except Exception as exc:
        logger.debug("[skill_capture] Distillation failed: %s", exc)

    # Fallback: minimal procedure from last assistant turn
    last_aura = next(
        (t.get("content", "") for t in reversed(thread_turns) if t.get("role") in ("assistant", "aura")),
        "",
    )
    return (
        title or "Captured Procedure",
        "A reusable procedure captured from a conversation.",
        last_aura[:800],
    )


# ─────────────────────────────────────────────────────────────────────────────
# SUGGEST CAPTURE HEURISTIC
# ─────────────────────────────────────────────────────────────────────────────

# Patterns that suggest a multi-step procedural response
_STEP_PATTERNS = [
    re.compile(r"^\s*\d+[\.\)]\s", re.MULTILINE),          # numbered list
    re.compile(r"^\s*#{1,3}\s+step\s+\d+", re.MULTILINE | re.IGNORECASE),  # ## Step N
    re.compile(r"\bfirst[,\s].*\bthen\b.*\bfinally\b", re.DOTALL | re.IGNORECASE),  # first...then...finally
]


def _looks_procedural(text: str) -> bool:
    """True if the response looks like a multi-step procedure."""
    return any(p.search(text) for p in _STEP_PATTERNS)


def _thread_turn_count(l1_path: str, thread_id: str) -> int:
    """Count turns in the sliding_window for a thread."""
    try:
        with sqlite3.connect(l1_path) as db:
            return db.execute(
                "SELECT COUNT(*) FROM sliding_window WHERE thread_id=?", (thread_id,)
            ).fetchone()[0]
    except Exception:
        return 0


def _has_matching_skill(l1_path: str, title: str) -> bool:
    """Check if a skill with a similar title already exists in skills_fts."""
    try:
        safe_q = '"' + title.replace('"', '""') + '"'
        with sqlite3.connect(l1_path) as db:
            rows = db.execute(
                "SELECT skill_id FROM skills_fts WHERE skills_fts MATCH ? LIMIT 1",
                (safe_q,),
            ).fetchall()
        return len(rows) > 0
    except Exception:
        return False


# ─────────────────────────────────────────────────────────────────────────────
# SKILL CAPTURE SERVICE
# ─────────────────────────────────────────────────────────────────────────────

class SkillCaptureService:
    """
    Manages dynamic captured skills stored in SQLite + ChromaDB L2.
    Static skills from skill_library.SKILLS are merged in at list/get time.
    """

    def __init__(self, l1_path: str) -> None:
        self._l1_path = l1_path

    # ── Storage ──────────────────────────────────────────────────────────────

    def save_skill(
        self,
        title: str,
        description: str,
        procedure_md: str,
        tags: list[str] | None = None,
        source_thread: str | None = None,
        source_type: str = "captured",
    ) -> dict:
        """Persist a skill to SQLite + skills_fts + ChromaDB L2."""
        skill_id = uuid.uuid4().hex
        tags_json = json.dumps(tags or [])
        now = time.time()

        with sqlite3.connect(self._l1_path) as db:
            db.execute(
                """INSERT INTO skills
                   (id, title, description, procedure_md, tags, source_thread, source_type, created_at)
                   VALUES (?,?,?,?,?,?,?,?)""",
                (skill_id, title, description, procedure_md, tags_json, source_thread, source_type, now),
            )
            # FTS5 index
            try:
                db.execute(
                    "INSERT INTO skills_fts (skill_id, title, description, procedure_md, tags) VALUES (?,?,?,?,?)",
                    (skill_id, title, description, procedure_md, " ".join(tags or [])),
                )
            except Exception as exc:
                logger.debug("[skill_capture] skills_fts insert failed: %s", exc)

        # ChromaDB L2 — makes the skill auto-retrievable by build_context()
        self._store_l2(skill_id, title, description, procedure_md)

        skill = {
            "id": skill_id,
            "title": title,
            "description": description,
            "procedure_md": procedure_md,
            "tags": tags or [],
            "source_thread": source_thread,
            "source_type": source_type,
            "created_at": now,
        }
        logger.info("[skill_capture] Saved skill '%s' (%s)", title, skill_id)
        return skill

    def _store_l2(self, skill_id: str, title: str, description: str, procedure_md: str) -> None:
        """Dual-write skill to ChromaDB L2 with source='skill'."""
        try:
            from app.service.memory_service import get_memory_service
            mem = get_memory_service()
            if mem is None:
                return
            doc_id = f"skill_{skill_id[:12]}"
            content = f"{title}\n\n{description}\n\n{procedure_md}"
            mem._store_layer2(doc_id, content, {
                "doc_id":     doc_id,
                "source":     "skill",
                "skill_id":   skill_id,
                "agent_role": "skill",
                "timestamp":  str(time.time()),
            })
        except Exception as exc:
            logger.debug("[skill_capture] L2 write failed: %s", exc)

    # ── Retrieval ─────────────────────────────────────────────────────────────

    def get_skill(self, skill_id: str) -> dict | None:
        """Check dynamic table first, then fall back to static SKILLS dict."""
        try:
            with sqlite3.connect(self._l1_path) as db:
                db.row_factory = sqlite3.Row
                row = db.execute(
                    "SELECT * FROM skills WHERE id=?", (skill_id,)
                ).fetchone()
            if row:
                d = dict(row)
                d["tags"] = json.loads(d.get("tags", "[]"))
                return d
        except Exception:
            pass

        from app.service.skill_library import SKILLS
        return SKILLS.get(skill_id)

    def list_skills(self, include_static: bool = True) -> list[dict]:
        """Return all skills — dynamic (SQLite) + optionally static (SKILLS dict)."""
        results: list[dict] = []

        # Dynamic skills
        try:
            with sqlite3.connect(self._l1_path) as db:
                db.row_factory = sqlite3.Row
                rows = db.execute(
                    "SELECT id, title, description, source_type, created_at FROM skills ORDER BY created_at DESC"
                ).fetchall()
            for r in rows:
                results.append({
                    "id":          r["id"],
                    "name":        r["title"],
                    "description": r["description"],
                    "source_type": r["source_type"],
                })
        except Exception as exc:
            logger.debug("[skill_capture] list_skills DB error: %s", exc)

        # Static skills (from skill_library.py)
        if include_static:
            from app.service.skill_library import SKILLS
            static_ids = {s["id"] for s in results}
            for sk in SKILLS.values():
                if sk["id"] not in static_ids:
                    results.append({
                        "id":          sk["id"],
                        "name":        sk["name"],
                        "description": sk["description"],
                        "source_type": "static",
                    })

        return results

    def delete_skill(self, skill_id: str) -> bool:
        """Delete a dynamic skill. Static skills are protected."""
        from app.service.skill_library import SKILLS
        if skill_id in SKILLS:
            return False  # static skills cannot be deleted

        try:
            with sqlite3.connect(self._l1_path) as db:
                cur = db.execute("DELETE FROM skills WHERE id=?", (skill_id,))
                deleted = cur.rowcount > 0
                if deleted:
                    try:
                        db.execute("DELETE FROM skills_fts WHERE skill_id=?", (skill_id,))
                    except Exception:
                        pass
            return deleted
        except Exception as exc:
            logger.warning("[skill_capture] delete_skill error: %s", exc)
            return False

    def search_skills(self, query: str, limit: int = 10) -> list[dict]:
        """FTS5 keyword search over skills_fts."""
        if not query.strip():
            return self.list_skills()
        safe_q = '"' + query.strip().replace('"', '""') + '"'
        try:
            with sqlite3.connect(self._l1_path) as db:
                db.row_factory = sqlite3.Row
                rows = db.execute(
                    """SELECT s.id, s.title, s.description, s.source_type
                       FROM skills_fts f
                       JOIN skills s ON s.id = f.skill_id
                       WHERE skills_fts MATCH ?
                       ORDER BY bm25(skills_fts)
                       LIMIT ?""",
                    (safe_q, limit),
                ).fetchall()
            return [dict(r) for r in rows]
        except Exception as exc:
            logger.debug("[skill_capture] search_skills error: %s", exc)
            return []

    def export_to_file(self, skill_id: str, export_dir: str = "~/.aura/skills/") -> str:
        """Export a skill as a markdown file. Returns the file path."""
        skill = self.get_skill(skill_id)
        if not skill:
            raise ValueError(f"Skill not found: {skill_id}")

        dest = Path(export_dir).expanduser()
        dest.mkdir(parents=True, exist_ok=True)

        safe_title = re.sub(r"[^\w\s\-]", "", skill.get("title", skill_id)).strip().replace(" ", "_")
        fpath = dest / f"{safe_title}.md"

        content = (
            f"# {skill.get('title', 'Skill')}\n\n"
            f"**Description:** {skill.get('description', '')}\n\n"
            f"---\n\n"
            f"{skill.get('procedure_md', '')}\n"
        )
        fpath.write_text(content, encoding="utf-8")
        logger.info("[skill_capture] Exported skill to %s", fpath)
        return str(fpath)

    # ── Capture Pipeline ──────────────────────────────────────────────────────

    async def capture_from_thread(
        self,
        thread_id: str,
        title: str | None = None,
        tags: list[str] | None = None,
    ) -> dict:
        """
        Extract a reusable procedure from a conversation thread using the workhorse.
        Fetches the thread turns, distills them, and saves the result.
        """
        from app.service.conversation_service import get_thread
        turns = [{"role": t.role, "content": t.content} for t in get_thread(thread_id)]
        if not turns:
            raise ValueError(f"Thread not found or empty: {thread_id}")

        distilled_title, description, procedure_md = await _distill_procedure(turns, title)
        return self.save_skill(
            title=distilled_title,
            description=description,
            procedure_md=procedure_md,
            tags=tags,
            source_thread=thread_id,
            source_type="captured",
        )

    async def suggest_capture(self, thread_id: str, response_text: str) -> bool:
        """
        Heuristic: should AURA offer to save this response as a reusable skill?

        Fires when:
        - Response is >600 chars (substantive)
        - Response looks procedural (numbered list, step headers, etc.)
        - Thread has ≥3 turns (not a one-shot)
        - No existing skill already covers this topic
        """
        if len(response_text) < 600:
            return False
        if not _looks_procedural(response_text):
            return False
        if _thread_turn_count(self._l1_path, thread_id) < 3:
            return False

        # Loose topic check — extract first 8 words as a candidate title
        words = response_text.split()[:8]
        candidate_title = " ".join(words)
        if _has_matching_skill(self._l1_path, candidate_title):
            return False

        return True


# ─────────────────────────────────────────────────────────────────────────────
# SINGLETON
# ─────────────────────────────────────────────────────────────────────────────

_skill_service: SkillCaptureService | None = None


def init_skill_capture_service(l1_path: str) -> SkillCaptureService:
    """Called once at boot after memory_service is initialized."""
    global _skill_service
    _skill_service = SkillCaptureService(l1_path)
    logger.info("[skill_capture] Initialized — SQLite path: %s", l1_path)
    return _skill_service


def get_skill_capture_service() -> SkillCaptureService | None:
    return _skill_service
