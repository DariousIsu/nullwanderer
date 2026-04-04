"""
AURA NX-Alpha — Assembler Node (§12.1 / Sprint 2)
Synthesizes all AgentResults into a coherent AssembledOutput with canvas blocks.
Sprint 2: calls OllamaService workhorse to synthesize + generate canvas blocks.
Falls back to Sprint 1 stub (concatenation) when OllamaService is unavailable.
"""

import logging
import re
from app.graph.state import GraphState, AssembledOutput

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# MARKDOWN → CANVAS BLOCKS PARSER
# ─────────────────────────────────────────────────────────────────────────────

def _markdown_to_blocks(text: str) -> list[dict]:
    """
    Parse synthesized markdown text into typed canvas blocks.
    Handles headings, code fences, lists, tables, callouts, and paragraphs.
    """
    blocks: list[dict] = []
    lines = text.split('\n')
    i = 0
    block_counter = 0

    def _next_id(prefix: str) -> str:
        nonlocal block_counter
        block_counter += 1
        return f"{prefix}-{block_counter}"

    # Accumulate consecutive paragraph lines into a single paragraph block
    para_buf: list[str] = []

    def _flush_para():
        if para_buf:
            blocks.append({
                "type": "paragraph",
                "id": _next_id("para"),
                "data": {"text": "\n".join(para_buf).strip()},
            })
            para_buf.clear()

    while i < len(lines):
        line = lines[i]
        stripped = line.strip()

        # ── Blank line → flush paragraph buffer ──
        if not stripped:
            _flush_para()
            i += 1
            continue

        # ── Heading: # ## ### ──
        heading_match = re.match(r'^(#{1,3})\s+(.+)$', stripped)
        if heading_match:
            _flush_para()
            level = len(heading_match.group(1))
            blocks.append({
                "type": "heading",
                "id": _next_id("heading"),
                "data": {"text": heading_match.group(2).strip(), "level": level},
            })
            i += 1
            continue

        # ── Code fence: ```lang ... ``` ──
        if stripped.startswith('```'):
            _flush_para()
            lang = stripped[3:].strip() or "text"
            code_lines: list[str] = []
            i += 1
            while i < len(lines) and not lines[i].strip().startswith('```'):
                code_lines.append(lines[i])
                i += 1
            i += 1  # skip closing ```
            blocks.append({
                "type": "code",
                "id": _next_id("code"),
                "data": {"language": lang, "content": "\n".join(code_lines)},
            })
            continue

        # ── Table: | col | col | (3+ consecutive lines starting with |) ──
        if stripped.startswith('|'):
            _flush_para()
            table_lines: list[str] = []
            while i < len(lines) and lines[i].strip().startswith('|'):
                table_lines.append(lines[i].strip())
                i += 1
            if len(table_lines) >= 3:
                headers = [h.strip() for h in table_lines[0].split('|') if h.strip()]
                rows = []
                for tl in table_lines[2:]:  # skip separator
                    row = [c.strip() for c in tl.split('|') if c.strip()]
                    if row:
                        rows.append(row)
                blocks.append({
                    "type": "table",
                    "id": _next_id("table"),
                    "data": {"headers": headers, "rows": rows},
                })
            else:
                # Not enough lines for a real table, treat as paragraph
                para_buf.extend(table_lines)
            continue

        # ── Callout / blockquote: > text ──
        if stripped.startswith('>'):
            _flush_para()
            quote_lines: list[str] = []
            while i < len(lines) and lines[i].strip().startswith('>'):
                quote_lines.append(lines[i].strip().lstrip('>').strip())
                i += 1
            blocks.append({
                "type": "callout",
                "id": _next_id("callout"),
                "data": {"content": "\n".join(quote_lines)},
            })
            continue

        # ── Unordered list: - item or * item (3+ consecutive) ──
        if re.match(r'^[-*•]\s+', stripped):
            _flush_para()
            items: list[str] = []
            while i < len(lines) and re.match(r'^\s*[-*•]\s+', lines[i]):
                items.append(re.sub(r'^\s*[-*•]\s+', '', lines[i]).strip())
                i += 1
            if len(items) >= 2:
                blocks.append({
                    "type": "list",
                    "id": _next_id("list"),
                    "data": {"items": items, "ordered": False},
                })
            else:
                para_buf.extend(f"- {item}" for item in items)
            continue

        # ── Ordered list: 1. item (3+ consecutive) ──
        if re.match(r'^\d+\.\s+', stripped):
            _flush_para()
            items = []
            while i < len(lines) and re.match(r'^\s*\d+\.\s+', lines[i]):
                items.append(re.sub(r'^\s*\d+\.\s+', '', lines[i]).strip())
                i += 1
            if len(items) >= 2:
                blocks.append({
                    "type": "list",
                    "id": _next_id("list"),
                    "data": {"items": items, "ordered": True},
                })
            else:
                para_buf.extend(f"1. {item}" for item in items)
            continue

        # ── Regular text → accumulate into paragraph buffer ──
        para_buf.append(line)
        i += 1

    _flush_para()
    return blocks


async def run_assembler(state: GraphState) -> dict:
    """
    Output synthesis node. Merges all area_results into final AssembledOutput.
    Uses OllamaService to synthesize results into coherent prose when available.
    Falls back to simple concatenation when not.
    """
    from app.service.ollama_service import get_ollama_service
    from app.controller.chat_controller import _emit

    ollama = get_ollama_service()

    area_results = state.get("area_results", [])
    sprint_results = state.get("sprint_results", [])
    correction_notes = state.get("correction_notes")
    iteration = state.get("validator_iteration", 0)
    plan = state.get("execution_plan") or {}
    task = plan.get("task", "Team output")

    logger.info(
        "[assembler] areas=%d sprints=%d iteration=%d",
        len(area_results), len(sprint_results), iteration,
    )

    if correction_notes:
        logger.info("[assembler] Applying corrections: %s", correction_notes.get("notes", []))

    # Build flat list of all sprint content for synthesis
    all_sprint_contents: list[str] = []
    provenance: dict[str, list[str]] = {}

    for ar in area_results:
        area_id = ar.get("area_id", "unknown")
        area_sprint_ids: list[str] = []
        for sr in ar.get("sprint_results", []):
            content_text = sr.get("content", "")
            if content_text:
                all_sprint_contents.append(content_text)
            area_sprint_ids.append(sr.get("sprint_id", ""))
        provenance[area_id] = area_sprint_ids

    if ollama and ollama.is_available() and all_sprint_contents:
        combined_raw = "\n\n---\n\n".join(all_sprint_contents)

        correction_instruction = ""
        if correction_notes:
            notes_text = "; ".join(
                n.get("instruction", "") for n in correction_notes.get("notes", [])
            )
            correction_instruction = f"\n\nApply these corrections in your synthesis: {notes_text}"

        output_contract = state.get("output_contract", "")
        original_request = state.get("team_request") or state.get("user_message") or task

        messages = [
            {
                "role": "system",
                "content": (
                    "You are a professional editor. You have received draft sections written by different "
                    "contributors for a single document. Your job is to produce the final, unified document.\n\n"
                    "Rules:\n"
                    "- Preserve ALL substance from every section — do not summarize, condense, or cut content\n"
                    "- Smooth transitions between sections so they flow as one continuous document\n"
                    "- Ensure consistent voice and tense throughout\n"
                    "- Add a brief introduction paragraph at the start if one is not present\n"
                    "- Add a brief conclusion paragraph at the end if one is not present\n"
                    "- Do not add new facts or opinions — only edit for coherence and flow"
                ),
            },
            {
                "role": "user",
                "content": (
                    f"ORIGINAL REQUEST: {original_request}\n\n"
                    f"OUTPUT CONTRACT: {output_contract}\n\n"
                    f"DRAFT SECTIONS:\n\n{combined_raw}"
                    f"{correction_instruction}\n\n"
                    "Produce the final unified document now."
                ),
            },
        ]

        try:
            await _emit("agent_update", {
                "agent_id": "assembler",
                "status": "working",
                "summary": "Synthesizing sprint results into coherent output...",
            })

            synthesized_text = await ollama.chat(messages, temperature=0.5, max_tokens=4096)
        except Exception as exc:
            logger.warning("[assembler] OllamaService synthesis failed, falling back to concat: %s", exc)
            synthesized_text = _concat_fallback(all_sprint_contents)
    else:
        if not all_sprint_contents:
            logger.info("[assembler] No sprint content — using placeholder")
        else:
            logger.info("[assembler] OllamaService unavailable — stub concatenation")
        synthesized_text = _concat_fallback(all_sprint_contents)

    await _emit("agent_update", {
        "agent_id": "assembler",
        "status": "done",
        "summary": f"Assembled {len(all_sprint_contents)} sprint outputs",
    })

    canvas_blocks = _markdown_to_blocks(synthesized_text)
    if not canvas_blocks:
        # Fallback: if parser produced nothing, wrap as single paragraph
        canvas_blocks = [{"type": "paragraph", "id": "para-assembled", "data": {"text": synthesized_text}}]

    # NOTE: Do NOT emit render_canvas here. The Interface Agent handles
    # final rendering on the return path (verifier → PM → IA → END).
    # Emitting here would push intermediate blocks to the canvas prematurely.

    output: AssembledOutput = {
        "content":        synthesized_text,
        "canvas_blocks":  canvas_blocks,
        "provenance_map": provenance,
        "markers":        [],
    }

    return {
        "assembled_output": output,
        "correction_notes": None,  # cleared after applying
    }


def _concat_fallback(parts: list[str]) -> str:
    """Simple concatenation used when OllamaService is unavailable."""
    if not parts:
        return "[No results assembled.]"
    return "\n\n".join(parts)
