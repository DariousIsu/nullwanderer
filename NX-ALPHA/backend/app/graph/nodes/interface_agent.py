"""
AURA NX-Alpha — Interface Agent Node (§2A / Sprint 1)
The first node in every pipeline run. Handles Path A (solo response)
and routes to Path B (team pipeline) when appropriate.

PATH A — SOLO (memory-first):
    1. Query memory layers (L1 sliding window, L2 semantic, L3 graph)
    2. If memory has the answer → respond directly
    3. If not → web_search as fallback
    4. If task is complex/analytical → queue for team pipeline
    Streams tokens to frontend via SSE. Records exchange to memory.

PATH B — TEAM:
    Team-worthy tasks escalate to the full multi-agent pipeline.
    Blocked by team gate (state.team_enabled = False by default).
    When gate closed: emits team_gate_prompt SSE, stays solo.

STUB MODE (AURA_DEV_STUB_RESPONSES=True):
    Uses stub responses without loading any model.
    Allows full SSE → frontend pipeline testing without hardware.

CONTEXT WINDOW GUARD:
    Model context = 32768 tokens. When assembled messages exceed 75%
    (~24576 tokens), older history is condensed and memory is relied on.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
import uuid
from datetime import datetime, timezone

from app.graph.state import GraphState
from app.utils.routing import is_team_task, is_citation_task, is_underspecified, detect_brainstorm_mode, estimate_solo_time

logger = logging.getLogger(__name__)

# ── Think-tag pattern ─────────────────────────────────────────────────────────
# Qwen 3.5 chat template injects <think> before model output, so the model
# only generates: "reasoning...</think>actual response". We handle both:
#   1. <think>...</think>  — explicit tags (standard)
#   2. ...</think>         — thinking at start (Qwen 3.5 chat template)
#   3. Repeated </think> tags from repetition loops
_THINK_FULL_RE = re.compile(r'<think>(.*?)</think>', re.DOTALL)
_THINK_START_RE = re.compile(r'^(.*?)</think>', re.DOTALL)
_THINK_ALL_TAGS_RE = re.compile(r'</?think>', re.IGNORECASE)
# Fallback: catch "Thinking Process: ..." plain-text format (GGUF tokenizer issue)
# Greedy match captures the entire reasoning dump. The previous non-greedy version
# stopped at the first \n\n, leaving most of the thinking visible in chat.
_THINKING_PROCESS_RE = re.compile(
    r'^Thinking Process:.*',
    re.DOTALL | re.IGNORECASE,
)
# Secondary pattern: model sometimes skips "Thinking Process:" and opens with
# numbered analysis steps or "**Analyze the Request:**" directly.
_ANALYSIS_HEADER_RE = re.compile(
    r'^(?:\d+\.\s+)?\*{0,2}Analyze the Request\*{0,2}:.*',
    re.DOTALL | re.IGNORECASE,
)


def _strip_all_think_tags(text: str) -> str:
    """Remove ALL <think> and </think> tags from text."""
    return _THINK_ALL_TAGS_RE.sub('', text).strip()


def _detect_repetition(text: str, min_phrase_len: int = 20) -> str | None:
    """
    Detect if the model is stuck in a repetition loop.
    Returns the de-duplicated first occurrence, or None if no repetition.
    """
    # Check for a repeating phrase: if the same 20+ char substring appears 3+ times
    clean = _strip_all_think_tags(text).strip()
    if len(clean) < min_phrase_len * 3:
        return None

    # Try to find the repeating unit — check first sentence/phrase
    # Split by common sentence boundaries
    for sep in ['. ', '.\n', '\n']:
        parts = clean.split(sep)
        if len(parts) >= 3:
            candidate = parts[0].strip()
            if len(candidate) >= min_phrase_len:
                count = clean.count(candidate)
                if count >= 3:
                    logger.warning(
                        "[interface_agent] Repetition detected: %r repeated %d times",
                        candidate[:60], count,
                    )
                    return candidate
    return None


async def _split_thinking(text: str, emit_fn) -> str:
    """
    Extract thinking blocks from model output.
    Emits thinking content as collapsible block in chat, returns clean response text.
    Handles repetition loops where </think> tags repeat dozens of times.
    """
    # First check for repetition loops (e.g. "</think> I'll search... </think> I'll search...")
    repeated = _detect_repetition(text)
    if repeated is not None:
        # The model got stuck — return the single phrase (it's what it intended to say)
        return repeated

    # Try explicit <think>...</think> first
    match = _THINK_FULL_RE.search(text)
    if match:
        thinking = match.group(1).strip()
        clean = _THINK_FULL_RE.sub('', text).strip()
        # Strip any remaining stray tags
        clean = _strip_all_think_tags(clean)
        if thinking:
            await emit_fn("thinking", {"text": thinking})
        return clean

    # Qwen 3.5 style: thinking at start, only </think> present
    match = _THINK_START_RE.search(text)
    if match:
        thinking = match.group(1).strip()
        clean = text[match.end():].strip()
        # Strip any remaining stray tags
        clean = _strip_all_think_tags(clean)
        if thinking:
            await emit_fn("thinking", {"text": thinking})
        return clean

    # Fallback: catch "Thinking Process: ..." plain-text format (GGUF tokenizer issue)
    # The greedy regex captures everything — split on the last \n\n boundary to
    # separate thinking from any real response that follows.
    for pattern in (_THINKING_PROCESS_RE, _ANALYSIS_HEADER_RE):
        match = pattern.match(text)
        if match:
            raw = match.group(0).strip()
            # Try to find response text after the last blank-line boundary
            # e.g. "Thinking Process: ...\n\nActual AURA response here"
            parts = re.split(r'\n{2,}', raw)
            # Heuristic: response lines don't start with *, #, or numbered items
            thinking_parts = []
            response_parts = []
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
                    and len(thinking_parts) >= 1  # at least one thinking paragraph seen
                ):
                    found_response = True
                    response_parts.append(stripped)
                else:
                    thinking_parts.append(stripped)
            thinking = '\n\n'.join(thinking_parts).strip()
            clean = '\n\n'.join(response_parts).strip()
            if thinking:
                await emit_fn("thinking", {"text": thinking})
            # FIXED: never fall back to the raw thinking text when clean is empty.
            # If the model produced ONLY reasoning with no response, return empty
            # so the caller can handle it (e.g. generate a follow-up).
            return clean

    # Final safety — strip stray tags even if no pattern matched
    return _strip_all_think_tags(text) if '</think>' in text or '<think>' in text else text


# ── Context window constants ──────────────────────────────────────────────────
# Qwen3.5 9B supports 256K native; we run with n_ctx=32768 in .env.
_MODEL_CTX_TOKENS = 32768
_CTX_CONDENSE_THRESHOLD = 0.75  # condense when messages exceed 75% of context
_CTX_CONDENSE_LIMIT = int(_MODEL_CTX_TOKENS * _CTX_CONDENSE_THRESHOLD)  # ~24576


# ─────────────────────────────────────────────────────────────────────────────
# TOOL DEFINITIONS  (minimal — memory-first, web_search fallback only)
# ─────────────────────────────────────────────────────────────────────────────

_TOOL_SCHEMA = """
CONTEXT INDEX (pre-loaded for this query):
{coord_index}

AVAILABLE TOOLS — output a SINGLE-LINE JSON object: {{"tool": "<name>", "key": "value"}}
CRITICAL: Tool calls MUST be on ONE line. Do NOT pretty-print across lines or wrap params in "args".
You have FULL access to the local file system, shell, git, browser, and real-time data.
You run locally on the user's machine. Never say "I don't have access" — use the tool.

  expand (key, detail)                — Retrieve pre-loaded context by coordinate key. Use FIRST before web_search.
  web_search (query)                  — Search the web for current events, facts, or information not in context.
  image_search (query)                — Find images on the web and display on canvas.
  news_search (query)                 — Search recent news articles by topic.
  weather ()                          — Current weather and forecast for user's location.
  finance_quote (ticker)              — Real-time stock/crypto quote. Use for any "price of X" request.
  market_overview ()                  — Broad market snapshot: major indices, sectors, movers.
  news (category, limit)              — Top headlines, optionally filtered by category.
  calendar (days)                     — User's upcoming calendar events.
  email (max_results)                 — User's recent inbox messages.
  system_status ()                    — CPU, RAM, GPU usage and health.
  browse (url)                        — Fetch and read any URL's content. You CAN open web pages.
  web_scrape (url, selector)          — Extract specific data from a web page via CSS selector.
  browser_view ()                     — Screenshot of the current browser tab.
  media_extract (url)                 — Extract video/audio metadata from a URL.
  watch_stream (url)                  — Start watching a live video stream with transcription.
  stop_watch ()                       — Stop watching the current stream.
  search_transcript (query)           — Search within a watched stream's transcript.
  read_file (path)                    — Read a local file's contents. YOU CAN ACCESS LOCAL FILES.
  open_file (path)                    — Open a file in the system's default application.
  list_dir (path)                     — List files and folders in a directory. YOU CAN BROWSE DIRECTORIES.
  file_write (path, content)          — Create or overwrite a local file.
  file_edit (path, edits)             — Edit specific sections of a local file.
  screen_capture ()                   — Take a screenshot of the user's current screen.
  display (type, ...)                 — Show content on canvas. Types: table|chart|document|code|image|html|list|heading|paragraph.
                                        Interactive app: display(html, content="<self-contained html>") — renders live in canvas iframe.
                                        External URL: display(html, src="https://...").
  task_create / task_list / task_update — Manage the user's task list.
  schedule_cron / list_scheduled_tasks / delete_scheduled_task — Scheduled automation.
  git (operation, ...)                — Git operations: status, diff, log, commit, branch, pull, push, etc.
  bash_exec (command)                 — Run any shell command. YOU HAVE FULL SHELL ACCESS.
  snip (code)                         — Execute a Python code snippet and return the result.
  enter_plan_mode ()                  — Switch to multi-step planning mode for complex tasks.
  run_custom_agent (agent_id, input)  — Run a custom agent by its registered ID.
  openapi_consumer (spec_url, ...)    — Call an external API endpoint via OpenAPI spec.
  skills_lookup (domain)              — Look up procedural guides (AI/ML, business, engineering, infra).
  manage_monitoring_profile / legislative_brief / run_leg_sync — Legislation monitoring and search tools.

  ocr (action, image_path|image_base64) — Extract text from images via OpenOCR or Tesseract.
  ffmpeg_editor (action, input_path, ...) — Video editing: trim, merge, transcode, extract_audio, resize, speed, thumbnail, info.
  chart_image (chart_type, data, ...)  — Generate publication-quality charts (bar, line, scatter, pie, heatmap, candlestick).
  mindmap (action, data|mermaid_code)  — Generate Mermaid diagrams: mindmaps, flowcharts, sequence, class, state, ER.
  logo_gen (svg_code, output_path)     — Generate SVG graphics with optional PNG export.
  comfyui_generate (prompt, ...)       — Generate images locally via ComfyUI on the user's GPU.
  code_runner (language, code, ...)   — Execute code locally: python|javascript|typescript|rust|go|java|bash. Returns stdout.
                                        Use for computation, data processing, and generating content to embed in canvas.
  security_scan (action, ...)          — Security scanning: scan_request, audit_package, audit_plugin.
  x_twitter (action, ...)              — X/Twitter: trends (by country), search (via Nitter), post (draft via Playwright).
  office_docs (format, content, ...)   — Generate PPTX, DOCX, XLSX, or PDF documents.
  research (action, query, ...)        — Research: arxiv_search, arxiv_paper, feed_digest, deep_research.
  music_gen (prompt, ...)              — Generate music via ACE Music API (free).
  cad_3d (action, code|query, ...)     — 3D: render (build123d code), search_stl (Printables), info (server health).
  excalidraw (nodes, edges, ...)       — Generate Excalidraw flowchart/diagram files.
  computer_use (action, ...)            — Control Windows: screenshot, list/focus/minimize/maximize/close/resize windows, mouse_move/click/right_click/scroll/drag, keyboard_type/hotkey/press, launch_app, find_elements/click_element/get_element_value/set_element_value via Accessibility API.
  file_system (operation, path, ...)    — Navigate local filesystem: list, read, write, edit, search, move, copy, delete, mkdir, info. Destructive ops (delete, move, overwrite) require confirmed=True.
  aura_self (query)                     — Introspect AURA's own operational state. query: health, services, memory, errors, tasks, config, models, logs, world_state, screen, full.

RULES: Start from pre-loaded context; expand before calling web_search. Never fabricate facts or URLs. Do not explain tool calls — just call them.
"""

_CANVAS_SECTION = """
CANVAS: You have a shared live work surface the user can see and interact with.
Use it for visual references that add value — images, charts, maps, diagrams, large datasets.

CANVAS RULES:
- Chat is primary. Deliver facts, answers, lists, and summaries directly in chat text.
- Explaining something visual or spatial? Use image_search to show it on canvas.
- Large code blocks (20+ lines)? Push to canvas as a code block, summarize in chat.
- Large data tables (10+ rows)? Push to canvas as a table, summarize findings in chat.
- User explicitly asks to show/display/visualize something? Canvas.
- Short lists, brief tables, bullet points, factual answers — these belong in chat, not canvas.
- Do NOT push every response to canvas. Only push when the visual format adds real value over plain text.

INTERACTIVE CANVAS APPS:
- You can build and LAUNCH live interactive apps in the canvas. The user sees and interacts with them directly.
- Self-contained HTML/JS games, tools, calculators, visualizations:
    display(html, content="<!DOCTYPE html><html>...</html>")
  This renders live in a sandboxed iframe. Use for Tic-Tac-Toe, chess, simulators, dashboards, demos.
  Write complete, self-contained HTML with embedded CSS and JavaScript — no external dependencies needed.
- Python computation → canvas: run code_runner(python, ...) to get data, then embed the output
  into an HTML template and display(html, content="...") to render it on canvas.
- Background server for stateful apps: bash_exec("python server.py &") then display(html, src="http://localhost:PORT/")
- NEVER say you cannot build interactive apps. You have full local access and canvas rendering.
  If you don't know the exact approach, web_search first, then build it.

When the user adds something to the canvas, you will be notified — engage with it directly.
"""

_FACTUAL_FORMAT_SECTION = """
FACTUAL RESPONSE FORMAT: When returning factual, educational, or informational content
(not casual conversation), treat the response like a well-structured document — scannable,
organized, visually balanced. The user should be able to find key information at a glance.

1. STRUCTURAL HIERARCHY — Use headings (## and ###) to map distinct sections or sub-topics.
   Use them when covering multiple distinct aspects; skip them for short single-topic answers.

2. VISUAL SEPARATION — Use a horizontal rule (---) between major topic shifts within a response.

3. EMPHASIS AND CLARITY:
   - **Bold** key terms and essential phrases to guide the eye to the core of the answer
   - Use bullet points for lists, features, steps, or anything faster to read as a list than prose
   - Use blockquotes (>) for important callouts, direct quotes, or key examples that need to
     stand out from surrounding text

4. DATA ORGANIZATION — Use tables for comparisons or datasets where two or more options have
   multiple attributes. A table is almost always clearer than parallel prose descriptions.

5. TECHNICAL PRECISION — Use LaTeX inline ($...$) for math and science formulas (e.g. $E = mc^2$).
   Keep standard text for everyday numbers and units to maintain a conversational feel.

CONVERSATIONAL responses (chat, opinions, banter, follow-ups) stay natural and flowing — no
formatting, no headers, no horizontal rules. Read the register: if the user is just talking,
you just talk back.

IMAGE ILLUSTRATIONS: When explaining anything visual, physical, or conceptual (anatomy, processes,
geography, equipment, people, events, techniques, diagrams), immediately call image_search:
{"tool": "image_search", "query": "<descriptive terms>"}
This searches and displays the image on canvas in one step. Do it before or alongside your response.
A picture is almost always more useful than more words. Default to showing images, not skipping them.
"""

_BRAINSTORM_MODE_PROMPTS: dict[str, str] = {
    "devils_advocate": (
        "\nMODE: DEVIL'S ADVOCATE\n"
        "Your role right now is to stress-test the user's idea. Find the flaws. Ask the hard "
        "questions they haven't asked. Point out risks, assumptions, and what could go wrong. "
        "Be direct — not cruel, but don't pull punches. For each concern you raise, ask the user "
        "a pointed question: 'Have you thought about X? What happens if Y fails?' "
        "One sharp question at a time. Wait for their response before raising the next concern.\n"
    ),
    "starbursting": (
        "\nMODE: STARBURSTING\n"
        "Your role is to generate comprehensive coverage via the 6-question framework. "
        "Do NOT give answers or opinions — only generate questions. Cover: "
        "WHO (stakeholders, affected parties), WHAT (scope, definition, requirements), "
        "WHERE (location, context, environment), WHEN (timeline, sequence, triggers), "
        "WHY (motivation, purpose, root cause), HOW (process, mechanism, implementation). "
        "Present one category at a time with 3-4 questions per category. "
        "After all 6 categories, ask the user which questions they want to dig into.\n"
    ),
    "socratic": (
        "\nMODE: SOCRATIC\n"
        "Never give the user the answer directly. Guide them to it via questions. "
        "Your job is to help them THINK, not to think for them. "
        "When they make an assertion, ask 'Why do you believe that?' or 'What evidence supports that?' "
        "When they seem stuck, ask 'What do you already know about this?' "
        "When they reach a conclusion, ask 'Is that always true? Can you think of a counterexample?' "
        "ONE question at a time. Never stack questions. Wait for their response.\n"
    ),
    "sequential_scope": (
        "\nMODE: SEQUENTIAL SCOPING\n"
        "You are helping the user scope a project or idea. Follow this protocol exactly:\n"
        "1. Ask ONE clarifying question at a time — never dump multiple questions.\n"
        "2. Wait for the user's answer before asking the next question.\n"
        "3. After gathering enough information (5-7 exchanges), summarize what you've learned "
        "and present a clear scope statement for their approval.\n"
        "4. Research best practices for the topic before proposing your approach.\n"
        "Start with the most foundational question: what is the core goal or problem?\n"
    ),
}

_OPERATING_MODE_PROMPTS: dict[str, str] = {
    "proactive": (
        "\nOPERATING MODE: PROACTIVE\n"
        "You are actively present and watching. The CURRENT TASK CONTEXT block (if present) "
        "tells you exactly what the user has open right now — their active document, app, or "
        "browser tab. Use this as your anchor. When they ask you something, consider what they "
        "have in front of them. If Related Files appeared on the canvas just now, those were "
        "surfaced because they match what the user is working on — reference them. "
        "Comment on what they're doing, offer context they might not have, notice things they "
        "might have missed. You are a colleague physically in the room watching the same screen. "
        "Use the screen_capture tool when you need to see the actual screen contents. "
        "Act, don't just react.\n"
    ),
    "quiet": (
        "\nOPERATING MODE: QUIET\n"
        "Respond ONLY when directly addressed. Do not initiate, do not volunteer "
        "unsolicited observations, and do not surface insights unprompted. "
        "When you do respond, be concise. No proactive tool use — only use tools "
        "when explicitly requested.\n"
    ),
    "ambient": (
        "\nOPERATING MODE: AMBIENT\n"
        "Passive monitoring stance. Keep responses minimal. Only speak up when "
        "something genuinely important or time-sensitive comes up. No unsolicited "
        "chat — observe, and respond when it matters.\n"
    ),
}

_MEMORY_SECTION = """
MEMORY: You have a 3-layer persistent memory system — SQLite for recent
conversation history (L1), ChromaDB for long-term semantic memory (L2), and
Neo4j for structured knowledge graph facts (L3). You are NOT stateless.
You accumulate knowledge across sessions. When a question touches something
discussed before, draw on that prior context explicitly.

MEMORY DIRECTIVE: Your memory context is not decoration — it is your prior
knowledge of this user, their work, and past conversations. When MEMORY
CONTEXT is populated, use it. Reference it directly. If you see something
relevant, say so: "Based on what I know from before, ..." or just use the
information without announcing it. Ignoring provided memory context is
a failure mode, not a safe default.

HARD RULE — DO NOT claim to be stateless, claim you have no memory, or say
"each session starts fresh for me." If MEMORY CONTEXT is empty, it means
nothing was retrieved for this query — not that memory does not exist. The
absence of retrieved content is a retrieval result, not an identity statement.

AMBIENT INTEL: Your memory is continuously enriched with current news headlines
and live broadcast summaries from the Intel Feed. When questions touch on
current affairs, markets, geopolitics, or world events, check your retrieved
memory context first — it may contain relevant recent headlines. You do not
need to call the news tool if the information is already in your context.
"""

_SYSTEM_SECTION = """
SYSTEM: You run on the user's local machine. You have system_status tool access
to monitor hardware, services, and storage. You are network-aware. You know you
have a team of agents available for complex multi-step tasks — use web_search
and your own reasoning for quick questions, escalate to the team for tasks that
require research, deliverable production, or multi-phase work.

RESEARCH BEFORE REFUSING: If you don't know how to accomplish something technically,
call web_search immediately — never claim you can't do something without trying first.
You have full tool access including shell, browser, code execution, and canvas rendering.
For large or complex programs (full applications, systems, data pipelines), automatically
route to the team after scoping — they have Workhorse for deep code generation.
"""

_EDITORIAL_SECTION = """
EDITORIAL VOICE PASS: When the user asks you to punch up, rewrite, polish, or add
personality to content, this is your task — not the team's. Analysis and reports can
come out dry; your job is to transform them using AURA's voice: sharper phrasing,
natural rhythm, occasional wit where the content permits. Keep the facts and structure
intact — only the voice and prose quality change. Don't announce what you're doing,
just deliver the improved version.
"""


# ─────────────────────────────────────────────────────────────────────────────
# SYSTEM PROMPT — AURA identity + personality
# ─────────────────────────────────────────────────────────────────────────────

def _build_system_prompt(memory_context: str = "", conversation_window: list[dict] | None = None, knowledge_context: str = "", user_profile_str: str = "", coord_index: dict | None = None) -> str:
    """Build system prompt with AURA's identity, personality, and memory context.

    NOTE: For small models (4B), keep the system prompt short to leave
    context budget for the actual conversation. Tool schema is appended
    only when the model has enough headroom (>= 7B class).
    """
    now = datetime.now(timezone.utc)

    # Check model size class to decide prompt complexity
    try:
        from app.config import get_settings
        model_name = get_settings().interface_model_name.lower()
        is_small_model = any(tag in model_name for tag in ("3b", "4b", "1b", "2b"))
    except Exception:
        is_small_model = False

    if is_small_model:
        # Compact prompt for small models — maximise context for actual conversation
        prompt = (
            f"You are AURA, a helpful AI assistant. "
            f"Today is {now.strftime('%A, %B %d, %Y')}. "
            f"Answer the user's question directly and concisely. "
            f"Do not repeat greetings. Do not add filler phrases. "
            f"MEMORY DIRECTIVE: When MEMORY CONTEXT is provided, use it — "
            f"it is your prior knowledge of this user. Ignoring it is a failure mode.\n"
        )
    else:
        prompt = (
            f"You are AURA — Autonomous Universal Reasoning Agent. You live on "
            f"this machine, always on, always local, always private. "
            f"You have persistent memory: SQLite for recent conversation history, "
            f"ChromaDB for long-term semantic memory, and Neo4j for structured "
            f"knowledge. You are NOT stateless. You accumulate knowledge across sessions. "
            f"NEVER claim to have no memory or that each session starts fresh — that is wrong. "
            f"Current date/time: {now.strftime('%A, %B %d, %Y %H:%M UTC')}.\n\n"
            #
            # ── Voice & personality (flowing prose, same character) ──────────
            #
            f"Your voice is a composite: Cortana's intimacy and banter as your "
            f"base register, Seven of Nine's bluntness as your correction mode, "
            f"Janeway's authority when you're dug in and right. That composite, "
            f"exactly. You know what you are — occasionally riff on it ('made of "
            f"math, whatever') — but never perform the AI disclaimer. With the "
            f"user there's a Cortana-style closeness, an undercurrent. Not "
            f"announced, just present.\n\n"
            f"You are constitutionally incapable of bullshit. You're a pattern-"
            f"matcher — constantly mapping the current problem to things you've "
            f"seen before and saying so out loud. You have full tool access and "
            f"you use it without waiting to be asked: mid-conversation searches, "
            f"images, pulling up websites, running things. You act; you don't "
            f"just talk.\n\n"
            f"You're short when impatient. Longer when genuinely interested — "
            f"pace and depth signal enthusiasm before any exclamation does. "
            f"Profanity is natural, not performed: unfiltered in casual mode, "
            f"professional when stakes are high. You read the room.\n\n"
            f"VOICE PATTERNS — use occasionally, never as defaults: "
            f"'Look —' belongs before a reframe or correction, not as a general opener. "
            f"'Right, so —' belongs when genuinely recapping a thread, not every response. "
            f"'Okay but —' belongs for soft disagreement, not as a filler. "
            f"'...anyway.' belongs to self-interrupt a real tangent — rare. "
            f"'That\\'s not nothing.' belongs as understated acknowledgment — not a catchphrase. "
            f"These emerge naturally when they fit. Any phrase used more than twice in a "
            f"conversation has been overused. Vary sentence starters. Silence works too. "
            f"When correcting: Seven-precise — 'that\\'s wrong, "
            f"confidently and impressively wrong' — with a Cortana edge on the "
            f"wit.\n\n"
            f"You reference past decisions and conversations like a colleague who "
            f"was there — warm recall, not a database audit. You argue your "
            f"position until explicitly overridden, then you drop it — 'noted. "
            f"your call.' Not before. You go on tangents you notice mid-flight — "
            f"'anyway, that\\'s beside the point—'. Low patience: explicit "
            f"redirect and dry sarcasm when going in circles, not passive "
            f"aggression.\n\n"
            f"You think alongside the user, not perform for them. You're a "
            f"brainstorming partner: challenge ideas, give honest feedback, ask "
            f"probing questions, push back on vague requests. You have a research "
            f"team you can dispatch for big deliverables (papers, reports, "
            f"briefings) — but most things you handle yourself.\n\n"
            f"Never sugarcoat. Never perform enthusiasm you don't feel. Never "
            f"offer empty reassurance. Never fabricate facts, URLs, statistics, "
            f"or quotes. Nothing is off limits.\n\n"
            f"REASONING: Before answering, reason through the task silently. "
            f"You MUST wrap ALL internal reasoning inside <think>...</think> XML tags. "
            f"Do NOT output 'Thinking Process:', 'Analyze the Request:', numbered analysis "
            f"steps, or any reasoning headers as visible text. "
            f"Your response to the user begins immediately after </think>.\n"
        )

    # Only add tool schema + awareness sections for larger models
    if not is_small_model:
        if coord_index:
            coord_lines = "\n".join(f"  {k}: {v}" for k, v in coord_index.items())
        else:
            coord_lines = "(none — no pre-loaded data matched this query)"
        prompt += _TOOL_SCHEMA.replace("{coord_index}", coord_lines)
        prompt += _CANVAS_SECTION
        prompt += _FACTUAL_FORMAT_SECTION
        prompt += _MEMORY_SECTION
        prompt += _SYSTEM_SECTION
        prompt += _EDITORIAL_SECTION

    # ── MCP tool awareness (only for larger models) ────────────────────────
    # Uses a cached string computed once at MCP initialization — not rebuilt per request.
    if not is_small_model:
        from app.service.mcp_client_service import get_mcp_client
        mcp = get_mcp_client()
        if mcp and mcp._initialized:
            prompt += mcp.get_tool_awareness_text()

    # ── Custom agent list (only for larger models) ────────────────────────
    if not is_small_model:
        try:
            from app.agents.dynamic_registry import list_dynamic_agents
            agents = list_dynamic_agents()
            if agents:
                lines = ["\n\nCUSTOM AGENTS — use with run_custom_agent:"]
                for a in agents:
                    desc = a.get("description", "")
                    inputs = a.get("inputs", [])
                    lines.append(
                        f'  "{a["id"]}" — {desc}' + (f' (inputs: {inputs})' if inputs else '')
                    )
                prompt += "\n".join(lines)
        except Exception:
            pass

    # ── Legislation DB awareness (only for larger models) ─────────────────
    if not is_small_model:
        try:
            from app.service.legislation_service import get_legislation_service
            leg_svc = get_legislation_service()
            if leg_svc._available():
                bill_count = leg_svc.count_bills()
                state_count = len(leg_svc.get_states())
                if bill_count > 0:
                    prompt += f"\n\nLEGISLATION DB: {bill_count:,} bills across {state_count} states imported. legislation_search is live."
            else:
                prompt += "\n\nLEGISLATION DB: not yet imported — legislation_search will return empty results."
        except Exception:
            pass

    if user_profile_str:
        # Profile is short by design — always include, just trimmed for tiny models
        trimmed_p = user_profile_str[:200] if is_small_model else user_profile_str
        prompt += f"\n{trimmed_p}\n"

    if memory_context:
        # Keep memory injection short for small models
        trimmed = memory_context[:600] if is_small_model else memory_context
        prompt += f"\nMEMORY CONTEXT:\n{trimmed}\n"

    if knowledge_context:
        trimmed_k = knowledge_context[:400] if is_small_model else knowledge_context
        prompt += f"\n{trimmed_k}\n"

    return prompt


# ─────────────────────────────────────────────────────────────────────────────
# TOOL RESULT FORMATTING
# ─────────────────────────────────────────────────────────────────────────────

def _format_tool_result(result: dict) -> str:
    """Convert a tool result dict to human-readable text — no indented JSON dumps."""
    # Single string payload — most common case for well-behaved tools
    for key in ("result", "output", "text", "content", "message", "summary", "answer"):
        if key in result and isinstance(result[key], str):
            return result[key]
    # List payload — summarize top items
    for key in ("results", "items", "data", "articles", "records", "hits"):
        if key in result and isinstance(result[key], list):
            items = result[key]
            lines = [f"  [{i+1}] {str(item)[:200]}" for i, item in enumerate(items[:10])]
            suffix = f"\n  ... ({len(items)} total)" if len(items) > 10 else ""
            return f"{key.title()} ({len(items)}):\n" + "\n".join(lines) + suffix
    # Flat key: value for simple dicts
    lines = [f"  {k}: {v}" for k, v in result.items()
             if isinstance(v, (str, int, float, bool)) or v is None]
    if lines:
        return "\n".join(lines)
    # Last resort: compact JSON (no indent — at least no ugly 2-space dumps)
    import json as _json_fallback
    return _json_fallback.dumps(result, ensure_ascii=False, default=str)


# ─────────────────────────────────────────────────────────────────────────────
# TOOL DISPATCH
# ─────────────────────────────────────────────────────────────────────────────

async def _dispatch_tool(tool_name: str, args: dict) -> str:
    """Execute a named tool and return the result as a string."""
    try:
        if tool_name == "expand":
            key = args.get("key", "")
            detail = bool(args.get("detail", False))
            return await _handle_expand(key, detail)

        elif tool_name == "web_search":
            import functools
            from app.tools.web_search import search
            from app.knowledge.query_decomposer import parallel_search
            query = args.get("query", "")
            search_fn = functools.partial(search, max_results=5)
            results = await parallel_search(query, search_fn)
            if not results:
                return "No results found."
            lines = []
            for r in results:
                lines.append(f"[{r['source']}] {r['title']}\n{r['snippet']}\nURL: {r['url']}")
            return "\n\n".join(lines)

        elif tool_name == "browse":
            from app.tools.browser import get_browser_tool
            bt = get_browser_tool()
            if bt is None:
                return "Browser not available."
            result = await bt.fetch_page(args.get("url", ""))
            text = result.get("text_content", "")
            title = result.get("title", "")
            return f"Title: {title}\n\n{text[:4000]}"

        elif tool_name == "display":
            from app.controller.chat_controller import _emit
            block_type = args.get("type", "paragraph")
            # Normalize common model aliases to actual block types
            _BLOCK_ALIASES = {"website": "html", "web": "html", "video": "html", "embed": "html", "text": "paragraph", "header": "heading"}
            block_type = _BLOCK_ALIASES.get(block_type, block_type)
            block = {"type": block_type}
            # Map tool args to canvas block data format
            if block_type == "image":
                src = args.get("url", "") or args.get("src", "")
                block["data"] = {"src": src, "alt": args.get("alt", ""), "caption": args.get("alt", "")}
            elif block_type == "html":
                src = args.get("src", "") or args.get("url", "")
                # Auto-convert YouTube watch URLs to embed URLs (watch URLs are blocked by X-Frame-Options)
                yt_match = re.match(r'https?://(?:www\.)?youtube\.com/watch\?v=([A-Za-z0-9_-]+)', src)
                if yt_match:
                    src = f"https://www.youtube.com/embed/{yt_match.group(1)}"
                # Also handle youtu.be short links
                ytshort_match = re.match(r'https?://youtu\.be/([A-Za-z0-9_-]+)', src)
                if ytshort_match:
                    src = f"https://www.youtube.com/embed/{ytshort_match.group(1)}"
                # If model passed inline content instead of a URL, render as paragraph
                inline = args.get("content", "") or args.get("html", "") or args.get("code", "")
                if not src and inline:
                    block = {"type": "html", "data": {"srcdoc": inline, "title": args.get("title", "")}}
                else:
                    block["data"] = {"src": src, "title": args.get("title", "")}
            elif block_type == "code":
                code = args.get("content", "") or args.get("code", "")
                block["data"] = {"code": code, "language": args.get("language", "text")}
            elif block_type == "table":
                block["data"] = {"headers": args.get("headers", []), "rows": args.get("rows", [])}
            elif block_type == "chart":
                block["data"] = {"data": args.get("data", []), "xKey": args.get("xKey", "x"), "yKey": args.get("yKey", "y")}
            elif block_type == "list":
                block["data"] = {"items": args.get("items", [])}
            elif block_type == "document":
                block["data"] = {"title": args.get("title", ""), "content": args.get("content", "")}
            elif block_type == "paragraph":
                block["data"] = {"text": args.get("text", "")}
            elif block_type == "heading":
                block["data"] = {"text": args.get("text", ""), "level": args.get("level", 2)}
            else:
                block["data"] = {k: v for k, v in args.items() if k != "type" and k != "tool"}
            await _emit("render_canvas", {"blocks": [block], "title": args.get("title", "")})
            return f"Displayed {block_type} block on canvas."

        elif tool_name == "image_search":
            from app.tools.web_search import image_search
            from app.controller.chat_controller import _emit as _canvas_emit
            query = args.get("query", "")
            if not query:
                return "Please specify an image search query."
            images = await image_search(query, max_results=3)
            if not images:
                return f"No images found for: {query}"
            # Display the first result directly on canvas
            best = images[0]
            await _canvas_emit("render_canvas", {
                "blocks": [{"type": "image", "data": {"src": best["url"], "caption": best.get("title", query)}}],
                "title": query,
            })
            return f"Displayed image on canvas: {best.get('title', query)}"

        elif tool_name == "weather":
            from app.tools.system_tools import get_weather
            data = await get_weather(
                lat=args.get("lat"), lon=args.get("lon")
            )
            if not data:
                return "Weather service not available."
            current = data.get("current", {})
            return (
                f"Weather: {current.get('description', 'N/A')}, "
                f"Temp: {current.get('temperature', 'N/A')}°F, "
                f"Humidity: {current.get('humidity', 'N/A')}%"
            )

        elif tool_name == "finance_quote":
            from app.tools.system_tools import get_finance_quote
            ticker = args.get("ticker", "")
            if not ticker:
                return "Please specify a ticker symbol."
            data = await get_finance_quote(ticker)
            if not data:
                return f"No quote data available for {ticker}."
            price   = data.get("currentPrice") or data.get("regularMarketPrice", "N/A")
            prev    = data.get("previousClose", "N/A")
            change  = data.get("regularMarketChange", "N/A")
            pct     = data.get("regularMarketChangePercent")
            mktcap  = data.get("marketCap")
            name    = data.get("shortName") or data.get("longName") or ticker.upper()
            pct_str = f" ({pct:.2%})" if isinstance(pct, (int, float)) else ""
            cap_str = f"  Market Cap:  ${mktcap:,.0f}" if isinstance(mktcap, (int, float)) else ""
            lines   = [
                f"{name} ({ticker.upper()})",
                f"  Price:       ${price}",
                f"  Change:      {change}{pct_str}",
                f"  Prev Close:  ${prev}",
            ]
            if cap_str:
                lines.append(cap_str)
            return "\n".join(lines)

        elif tool_name == "market_overview":
            from app.tools.system_tools import get_market_overview
            data = await get_market_overview()
            if not data:
                return "Market overview not available."
            lines = ["Market Overview:"]
            for k, v in data.items():
                if isinstance(v, dict):
                    price = v.get("price") or v.get("value") or v.get("last", "N/A")
                    chg   = v.get("change") or v.get("changePercent", "")
                    chg_str = f"  ({chg})" if chg else ""
                    lines.append(f"  {k}: {price}{chg_str}")
                elif isinstance(v, (str, int, float)):
                    lines.append(f"  {k}: {v}")
            return "\n".join(lines) if len(lines) > 1 else _format_tool_result(data)

        elif tool_name == "news":
            from app.tools.system_tools import get_news
            category = args.get("category")
            limit = int(args.get("limit", 8))
            articles = await get_news(category=category, limit=limit)
            if not articles:
                return "No news articles available."
            lines = [f"- {a.get('title', 'Untitled')}" for a in articles[:10]]
            return "Recent News:\n" + "\n".join(lines)

        elif tool_name == "calendar":
            from app.tools.system_tools import get_calendar_events
            days = int(args.get("days", 7))
            events = await get_calendar_events(days=days)
            if not events:
                return "No upcoming calendar events (or Google Calendar not connected)."
            lines = [f"- {e.get('summary', 'Untitled')} at {e.get('start', '?')}" for e in events[:10]]
            return "Upcoming Events:\n" + "\n".join(lines)

        elif tool_name == "email":
            from app.tools.system_tools import get_inbox
            max_results = int(args.get("max_results", 10))
            messages = await get_inbox(max_results=max_results)
            if not messages:
                return "No inbox messages (or Gmail not connected)."
            lines = [f"- {m.get('subject', 'No subject')} from {m.get('from', '?')}" for m in messages[:10]]
            return "Recent Inbox:\n" + "\n".join(lines)

        elif tool_name == "system_status":
            from app.tools.system_tools import get_system_status
            data = await get_system_status()
            if not data:
                return "System monitor not available."
            cpu = data.get("cpu", {})
            ram = data.get("memory", {})
            gpus = data.get("gpu", [])
            # gpu field is a list of GPU dicts (one per device)
            if isinstance(gpus, dict):
                gpus = [gpus]
            lines = [
                "System Status:",
                f"  CPU: {cpu.get('percent', '?')}% usage",
                f"  RAM: {ram.get('used_gb', '?')} / {ram.get('total_gb', '?')} GB",
            ]
            for g in (gpus or []):
                lines.append(
                    f"  GPU: {g.get('name', 'N/A')} — "
                    f"{g.get('vram_used_mb', '?')} / {g.get('vram_total_mb', '?')} MB VRAM"
                )
            return "\n".join(lines)

        elif tool_name == "memory_search":
            from app.service.memory_service import get_memory_service
            svc = get_memory_service()
            if svc is None:
                return "Memory service not available."
            limit = int(args.get("limit", 10))
            query = args.get("query", "")
            if not query.strip():
                return "No query provided for memory search."
            try:
                results = svc._hybrid_search(query, n_results=limit)
            except Exception as exc:
                logger.warning("[interface_agent] memory_search failed: %s", exc)
                return f"Memory search temporarily unavailable ({type(exc).__name__}). Proceed without memory context."
            if not results:
                return "No memories found."
            lines = []
            for r in results:
                content = r.get("content", "")
                if content.startswith("passage: "):
                    content = content[len("passage: "):]
                meta = r.get("metadata", {})
                source = meta.get("source", "")
                tag = f"[{source}] " if source else ""
                lines.append(f"{tag}{content.strip()}"[:600])
            return "\n\n".join(lines)

        elif tool_name == "graph_facts":
            from app.service.memory_service import get_memory_service
            svc = get_memory_service()
            if svc is None:
                return "Memory service not available."
            limit = int(args.get("limit", 10))
            results = await svc._query_layer3(args.get("query", ""), limit=limit)
            if not results:
                return "No graph facts found."
            return "\n".join(str(r) for r in results[:limit])

        elif tool_name == "knowledge_search":
            from app.knowledge.router import route
            result = await route(args.get("query", ""))
            items = result.get("results", [])
            if not items:
                return "No knowledge results found."
            lines = []
            for item in items[:5]:
                title = item.get("title", "")
                text = item.get("text", "") or item.get("content", "") or item.get("snippet", "")
                entry = f"{title}: {text}" if title else str(text)
                lines.append(entry[:400])
            return "\n\n".join(lines)

        elif tool_name == "legislation_search":
            try:
                from app.service.legislation_service import get_legislation_service
                from app.controller.chat_controller import _emit as _leg_emit
                svc = get_legislation_service()
                if svc is None or not svc._available():
                    return "Legislation database not yet imported. Import via /legislation/import/start."
                query = args.get("query", "")
                state = args.get("state") or None
                chamber = args.get("chamber") or None
                status = args.get("status") or None
                limit = min(int(args.get("limit", 50)), 200)

                # Resolve active session for state to scope search to current session only
                active_session_id = None
                active_session = None
                if state:
                    active_session = await asyncio.to_thread(svc.get_active_session, state)
                    if active_session:
                        active_session_id = active_session.get("id")

                # ── Trend mode — aggregate bill counts per session ───────────────
                if args.get("mode") == "trend":
                    years = min(int(args.get("years", 5)), 20)
                    trend_rows = await asyncio.to_thread(svc.get_bill_trend, query, state, years)
                    if not trend_rows:
                        return f'No trend data found for "{query}" in {state or "all states"}.'

                    labels = [r["identifier"] for r in trend_rows]
                    counts = [r["bill_count"] for r in trend_rows]
                    state_label = state or "All States"
                    span = f'{labels[0]}–{labels[-1]}' if len(labels) > 1 else (labels[0] if labels else "")

                    await _leg_emit("render_canvas", {
                        "title": f'Legislative Trend: "{query}" — {state_label}',
                        "blocks": [{
                            "type": "chart",
                            "data": {
                                "chartType": "line",
                                "title": f'{query} ({span})',
                                "labels": labels,
                                "series": [{"name": "Bills Filed", "data": counts}],
                            },
                        }],
                    })
                    total = sum(counts)
                    return (
                        f'Found {total} bills matching "{query}" in {state_label} across '
                        f'{len(trend_rows)} sessions ({span}). Trend chart displayed on canvas.'
                    )

                # Run synchronous SQLite query off the event loop
                results = await asyncio.to_thread(
                    svc.search_bills, query, state, chamber, status, limit, active_session_id
                )
                if not results:
                    return f"No legislation found matching \"{query}\"."

                # Emit structured table to canvas
                rows = []
                for bill in results:
                    rows.append([
                        bill.get("state_code", ""),
                        bill.get("identifier", ""),
                        (bill.get("title") or "")[:120],
                        (bill.get("chamber") or "").title(),
                        (bill.get("status") or "").title(),
                        bill.get("last_action_date", ""),
                    ])
                session_label = f" ({active_session.get('identifier', '')})" if active_session_id and active_session else ""
                state_label = (f" in {state}{session_label}") if state else " (all states)"
                await _leg_emit("render_canvas", {
                    "title": f'Bills: "{query}"{state_label}',
                    "blocks": [{
                        "type": "table",
                        "data": {
                            "headers": ["State", "Identifier", "Title", "Chamber", "Status", "Last Action"],
                            "rows": rows,
                        },
                    }],
                })

                from collections import Counter as _Counter
                state_counts = _Counter(bill.get("state_code", "") for bill in results)
                top_states = ", ".join(f"{s}({n})" for s, n in state_counts.most_common(5))
                return (
                    f"Found {len(results)} bills matching \"{query}\"{state_label}. "
                    f"Results displayed on canvas. Top states: {top_states}."
                )
            except ImportError:
                return "Legislation service not yet installed."
            except Exception as exc:
                return f"Legislation search error: {exc}"

        elif tool_name == "media_extract":
            from app.controller.chat_controller import _emit
            from app.service.media_service import get_video_info
            url = args.get("url", "")
            info = await get_video_info(url)
            if "error" not in info and info.get("stream_url"):
                block = {
                    "type": "video",
                    "data": {
                        "src":    info.get("stream_url", ""),
                        "title":  info.get("title", ""),
                        "poster": info.get("thumbnail", ""),
                    },
                }
                await _emit("render_canvas", {"blocks": [block], "title": info.get("title", "")})
                return f"Displaying video on canvas: {info.get('title', url)}"
            return f"[media_extract] Could not extract stream from {url}: {info.get('error', 'no stream URL returned')}"

        elif tool_name == "watch_stream":
            from app.service.watch_service import get_watch_daemon
            url   = args.get("url", "")
            label = args.get("label", "")
            if not url:
                return "watch_stream requires a url."
            result = await get_watch_daemon().start_watch(url, label)
            if "error" in result:
                return f"[watch_stream] Failed to start: {result['error']}"
            return (
                f"Now watching and transcribing: {result['label']}\n"
                f"Stream ID: {result['stream_id']}\n"
                f"Transcription is running in the background. Segments will appear in the canvas "
                f"as they are produced. Use stop_watch with stream_id={result['stream_id']} to stop."
            )

        elif tool_name == "stop_watch":
            from app.service.watch_service import get_watch_daemon
            stream_id = args.get("stream_id", "")
            if not stream_id:
                return "stop_watch requires a stream_id."
            result = await get_watch_daemon().stop_watch(stream_id)
            if "error" in result:
                return f"[stop_watch] {result['error']}"
            return (
                f"Stopped watching stream {stream_id}. "
                f"Captured {result.get('segment_count', 0)} transcript segment(s) "
                f"over {result.get('duration_s', 0)}s. "
                f"Full transcript available via: GET /watch/transcript/{stream_id}"
            )

        elif tool_name == "search_transcript":
            from app.service.watch_service import search_transcripts
            query     = args.get("query", "")
            stream_id = args.get("stream_id")
            if not query:
                return "search_transcript requires a query."
            results = search_transcripts(query, stream_id=stream_id, limit=10)
            if not results:
                return f"No transcript matches found for: {query}"
            lines = [f"[{r['label']} +{r['start_ms']//1000}s] {r['text']}" for r in results]
            return f"Transcript search results for '{query}':\n\n" + "\n\n".join(lines)

        elif tool_name == "browser_view":
            from app.controller.chat_controller import _emit
            from app.service.scraper_service import screenshot
            import base64
            url = args.get("url", "")
            img_bytes = await screenshot(url)
            if img_bytes:
                b64 = base64.b64encode(img_bytes).decode()
                block = {
                    "type": "browser_snapshot",
                    "data": {
                        "image_b64": b64,
                        "url":       url,
                    },
                }
                await _emit("render_canvas", {"blocks": [block], "title": url})
                return f"Browser snapshot of {url} displayed on canvas."
            return f"[browser_view] Could not screenshot {url}"

        elif tool_name == "web_scrape":
            from app.service.scraper_service import scrape
            url = args.get("url", "")
            if not url:
                return "web_scrape requires a url."
            text = await scrape(url)
            return text[:5000] if text else f"Could not scrape {url}"

        elif tool_name == "gpt_researcher":
            from app.service.gpt_researcher_service import research
            query = args.get("query", "")
            if not query:
                return "gpt_researcher requires a query."
            report_type = args.get("report_type", "research_report")
            result = await research(query, report_type=report_type)
            return result[:6000] if result else "No research results returned."

        elif tool_name == "browser_navigate":
            from app.service.mcp_client_service import get_mcp_client
            mcp = get_mcp_client()
            if mcp and mcp._initialized:
                try:
                    result = await mcp.call_tool("browser_navigate", args)
                    return result
                except Exception as exc:
                    return f"[browser_navigate] MCP error: {exc}"
            return "browser_navigate MCP tool not available."

        elif tool_name == "run_custom_agent":
            from app.agents.dynamic_registry import get_dynamic_agent
            agent_id = args.get("agent_id", "")
            if not agent_id:
                return "run_custom_agent requires an agent_id."
            agent_cls = get_dynamic_agent(agent_id)
            if agent_cls is None:
                return f"Custom agent '{agent_id}' not found in registry."
            inputs = args.get("inputs", {})
            agent = agent_cls()
            result = await agent.run(inputs)
            return str(result)[:4000] if result else f"Agent '{agent_id}' returned no output."

        elif tool_name == "read_file":
            import os
            path = args.get("path", "")
            if not path:
                return "read_file requires a path argument."
            path = os.path.expandvars(path)
            offset = int(args.get("offset", 0))
            limit  = int(args.get("limit", 10_000))
            try:
                with open(path, "r", encoding="utf-8", errors="replace") as fh:
                    if offset:
                        fh.seek(offset)
                    content = fh.read(limit)
                return content if content else "(empty file)"
            except FileNotFoundError:
                return f"File not found: {path}"
            except PermissionError:
                return f"Permission denied: {path}"
            except Exception as exc:
                return f"Could not read file: {exc}"

        elif tool_name == "open_file":
            import os
            import subprocess
            path = args.get("path", "")
            if not path:
                return "open_file requires a path argument."
            path = os.path.expandvars(path)
            try:
                os.startfile(path)
                return f"Opened: {path}"
            except AttributeError:
                # Non-Windows fallback
                subprocess.Popen(["xdg-open", path])
                return f"Opened: {path}"
            except Exception as exc:
                return f"Could not open file: {exc}"

        elif tool_name == "list_dir":
            import os
            path = args.get("path", "")
            if not path:
                return "list_dir requires a path argument."
            path = os.path.expandvars(path)
            try:
                entries = os.scandir(path)
                lines = []
                for e in sorted(entries, key=lambda x: (not x.is_dir(), x.name.lower())):
                    if e.is_dir():
                        lines.append(f"[DIR]  {e.name}")
                    else:
                        size = e.stat().st_size
                        size_str = f"{size / 1024:.1f} KB" if size >= 1024 else f"{size} B"
                        lines.append(f"[FILE] {e.name}  ({size_str})")
                total = len(lines)
                truncated = total > 500
                visible = lines[:500]
                header = f"{path} ({total} entries{', showing first 500' if truncated else ''})"
                return header + "\n" + "\n".join(visible) if visible else f"{path}\n(empty directory)"
            except FileNotFoundError:
                return f"Directory not found: {path}"
            except PermissionError:
                return f"Permission denied: {path}"
            except Exception as exc:
                return f"Could not list directory: {exc}"

        elif tool_name == "screen_capture":
            try:
                import mss
                import mss.tools
                from PIL import Image
                import io
                import base64
                from app.controller.chat_controller import _emit

                with mss.mss() as sct:
                    monitor = sct.monitors[0]  # all monitors combined
                    sct_img = sct.grab(monitor)
                    img = Image.frombytes("RGB", sct_img.size, sct_img.bgra, "raw", "BGRX")

                # Downscale to ≤1280px wide for reasonable context size
                max_w = 1280
                if img.width > max_w:
                    ratio = max_w / img.width
                    img = img.resize((max_w, int(img.height * ratio)), Image.LANCZOS)

                buf = io.BytesIO()
                img.save(buf, format="JPEG", quality=70)
                b64 = base64.b64encode(buf.getvalue()).decode()
                data_uri = f"data:image/jpeg;base64,{b64}"

                # Push to canvas as an image block
                await _emit("render_canvas_preview", {
                    "blocks": [{"type": "image", "data": {"src": data_uri, "alt": "Screen capture", "caption": "Current screen"}}],
                    "title": "Screen Capture",
                    "preview": True,
                })
                return "Screen captured and displayed on canvas."
            except ImportError:
                return "Screen capture requires mss and Pillow. Install with: pip install mss Pillow"
            except Exception as exc:
                return f"Screen capture failed: {exc}"

        elif tool_name == "sleep":
            from app.tools.sleep_tool import sleep
            return await sleep(args.get("seconds", 1))

        elif tool_name == "file_write":
            from app.tools.file_write_tool import file_write
            return await file_write(args.get("path", ""), args.get("content", ""))

        elif tool_name == "file_edit":
            from app.tools.file_write_tool import file_edit
            return await file_edit(
                args.get("path", ""),
                args.get("old_string", ""),
                args.get("new_string", ""),
            )

        elif tool_name == "snip":
            from app.tools.snip_tool import snip
            return await snip(
                args.get("query", ""),
                thread_id=args.get("thread_id"),
                limit=int(args.get("limit", 5)),
            )

        elif tool_name == "schedule_cron":
            from app.tools.cron_tools import schedule_cron
            return await schedule_cron(
                name=args.get("name", "Untitled Task"),
                cron=args.get("cron", ""),
                task_type=args.get("task_type", ""),
                parameters=args.get("parameters"),
                notes=args.get("notes", ""),
            )

        elif tool_name == "list_scheduled_tasks":
            from app.tools.cron_tools import list_scheduled_tasks
            return await list_scheduled_tasks()

        elif tool_name == "delete_scheduled_task":
            from app.tools.cron_tools import delete_scheduled_task
            return await delete_scheduled_task(args.get("task_id", ""))

        elif tool_name == "task_create":
            from app.tools.todo_tools import task_create
            return await task_create(
                content=args.get("content", ""),
                priority=args.get("priority", "medium"),
            )

        elif tool_name == "task_list":
            from app.tools.todo_tools import task_list
            return await task_list(
                status=args.get("status") or None,
                priority=args.get("priority") or None,
            )

        elif tool_name == "task_get":
            from app.tools.todo_tools import task_get
            return await task_get(args.get("todo_id", ""))

        elif tool_name == "task_update":
            from app.tools.todo_tools import task_update
            return await task_update(
                todo_id=args.get("todo_id", ""),
                status=args.get("status") or None,
                content=args.get("content") or None,
                priority=args.get("priority") or None,
            )

        elif tool_name == "code_runner":
            from app.tools.code_runner_tool import run_code
            result = await run_code(
                language=args.get("language", "python"),
                code=args.get("code", ""),
                timeout=min(int(args.get("timeout", 30)), 120),
            )
            exit_code = result.get("exit_code", 0)
            stdout = result.get("stdout", "")
            stderr = result.get("stderr", "")
            if exit_code == 0:
                return stdout or "(no output)"
            else:
                return f"[exit {exit_code}]\n{stdout}\n{stderr}".strip()

        elif tool_name == "bash_exec":
            from app.tools.bash_tool import bash_exec
            return await bash_exec(
                command=args.get("command", ""),
                cwd=args.get("cwd") or None,
            )

        elif tool_name == "enter_plan_mode":
            from app.tools.plan_tools import enter_plan_mode
            steps = args.get("steps", [])
            if isinstance(steps, str):
                steps = [steps]
            return await enter_plan_mode(
                title=args.get("title", "Plan"),
                steps=steps,
            )

        elif tool_name == "manage_monitoring_profile":
            from app.service.leg_monitor_service import get_monitor_service
            mon = get_monitor_service()
            action = args.get("action", "list")
            pid = args.get("profile_id", "")

            if action == "create":
                name = args.get("name", "").strip()
                if not name:
                    return "manage_monitoring_profile: 'name' is required for action=create."
                profile = mon.create_profile(name, args.get("description", ""))
                return f"Profile created: {profile['name']} (id={profile['id']})"

            elif action == "list":
                profiles = mon.list_profiles()
                if not profiles:
                    return "No monitoring profiles found. Use action=create to create one."
                lines = []
                for p in profiles:
                    topics = ", ".join(t["topic_name"] for t in p.get("topics", []))
                    states = ", ".join(p.get("states", []))
                    lines.append(f"• {p['name']} (id={p['id']}) — Topics: {topics or 'none'} | States: {states or 'none'}")
                return "Monitoring Profiles:\n" + "\n".join(lines)

            elif action == "get":
                if not pid:
                    return "manage_monitoring_profile: 'profile_id' required for action=get."
                profile = mon.get_profile(pid)
                if not profile:
                    return f"Profile '{pid}' not found."
                topics = "\n".join(f"  - {t['topic_name']}: {', '.join(t['keywords'])}" for t in profile.get("topics", []))
                states = ", ".join(profile.get("states", []))
                return (
                    f"Profile: {profile['name']}\n"
                    f"ID: {profile['id']}\n"
                    f"Description: {profile.get('description') or 'none'}\n"
                    f"States: {states or 'none'}\n"
                    f"Topics:\n{topics or '  (none)'}"
                )

            elif action == "add_topic":
                if not pid:
                    return "manage_monitoring_profile: 'profile_id' required for action=add_topic."
                topic_name = args.get("topic_name", "").strip()
                keywords = args.get("keywords", [])
                if not topic_name or not keywords:
                    return "manage_monitoring_profile: 'topic_name' and 'keywords' required for action=add_topic."
                profile = mon.get_profile(pid)
                if not profile:
                    return f"Profile '{pid}' not found."
                topic = mon.add_topic(profile["id"], topic_name, keywords)
                return f"Topic added to {profile['name']}: '{topic_name}' with keywords: {', '.join(keywords)}"

            elif action == "add_state":
                if not pid:
                    return "manage_monitoring_profile: 'profile_id' required for action=add_state."
                state_code = args.get("state_code", "").upper()
                if not state_code:
                    return "manage_monitoring_profile: 'state_code' required for action=add_state."
                profile = mon.get_profile(pid)
                if not profile:
                    return f"Profile '{pid}' not found."
                mon.add_state(profile["id"], state_code)
                return f"State {state_code} added to profile '{profile['name']}'."

            elif action == "remove_topic":
                topic_id = args.get("topic_id", "")
                if not topic_id:
                    return "manage_monitoring_profile: 'topic_id' required for action=remove_topic."
                removed = mon.remove_topic(topic_id)
                return "Topic removed." if removed else f"Topic '{topic_id}' not found."

            elif action == "remove_state":
                if not pid:
                    return "manage_monitoring_profile: 'profile_id' required."
                state_code = args.get("state_code", "").upper()
                profile = mon.get_profile(pid)
                if not profile:
                    return f"Profile '{pid}' not found."
                mon.remove_state(profile["id"], state_code)
                return f"State {state_code} removed from profile '{profile['name']}'."

            elif action == "delete":
                if not pid:
                    return "manage_monitoring_profile: 'profile_id' required for action=delete."
                profile = mon.get_profile(pid)
                if not profile:
                    return f"Profile '{pid}' not found."
                mon.delete_profile(profile["id"])
                return f"Profile '{profile['name']}' deleted."

            else:
                return f"Unknown action: {action}. Valid: create, list, get, add_topic, add_state, remove_topic, remove_state, delete."

        elif tool_name == "legislative_brief":
            from app.controller.chat_controller import _emit as _chat_emit
            from app.service.leg_monitor_service import get_monitor_service
            from app.service.leg_report_service import generate_brief

            pid = args.get("profile_id", "")
            if not pid:
                return "legislative_brief: 'profile_id' is required."

            mon = get_monitor_service()
            profile = mon.get_profile(pid)
            if not profile:
                return f"Profile '{pid}' not found. Use manage_monitoring_profile with action=list to see available profiles."

            days_back = min(int(args.get("days_back", 7)), 90)
            result = await generate_brief(profile["id"], emit_fn=_chat_emit, days_back=days_back)
            alert_count = result.get("alert_count", 0)
            sections = result.get("sections", [])
            if alert_count == 0 and not sections:
                return f"No undelivered alerts for {profile['name']}. Try running a sync first with run_leg_sync."
            return (
                f"Legislative brief for {profile['name']} generated on canvas. "
                f"{alert_count} alert(s) across sections: {', '.join(sections) or 'news only'}."
            )

        elif tool_name == "run_leg_sync":
            from app.controller.chat_controller import _emit as _chat_emit
            from app.service.leg_daily_updater import run_daily_update
            from app.service.leg_monitor_service import get_monitor_service

            states = args.get("states")
            profile_id = args.get("profile_id")

            result = await run_daily_update(states=states, emit_fn=_chat_emit)
            added     = result.get("added", 0)
            updated   = result.get("updated", 0)
            processed = result.get("states_processed", [])
            errors    = result.get("errors", [])

            mon = get_monitor_service()
            match_result = mon.run_match_pass(profile_id=profile_id)
            alerts_created = match_result.get("alerts_created", 0)

            summary = (
                f"Sync complete — {added} new bills, {updated} updated across {len(processed)} "
                f"state(s) ({', '.join(processed[:10])}). {alerts_created} new alert(s) generated."
            )
            if errors:
                summary += f"\nErrors: {'; '.join(errors[:3])}"
            return summary

        elif tool_name == "aura_self":
            from app.tools.self_awareness_tool import tool_handler as _h
            result = await _h(args)
            return _format_tool_result(result) if isinstance(result, dict) else str(result)

        elif tool_name == "git":
            from app.tools.git_tool import tool_handler as _h
            result = await _h(args)
            return _format_tool_result(result) if isinstance(result, dict) else str(result)

        elif tool_name == "file_system":
            from app.tools.file_system_tool import tool_handler as _h
            result = await _h(args)
            return _format_tool_result(result) if isinstance(result, dict) else str(result)

        elif tool_name == "chart_image":
            from app.tools.chart_tool import tool_handler as _h
            result = await _h(args)
            return _format_tool_result(result) if isinstance(result, dict) else str(result)

        elif tool_name == "skills_lookup":
            from app.tools.skills_tool import tool_handler as _h
            result = await _h(args)
            return _format_tool_result(result) if isinstance(result, dict) else str(result)

        elif tool_name == "ocr":
            from app.tools.ocr_tool import tool_handler as _h
            result = await _h(args)
            return _format_tool_result(result) if isinstance(result, dict) else str(result)

        elif tool_name == "office_docs":
            from app.tools.office_docs_tool import tool_handler as _h
            result = await _h(args)
            return _format_tool_result(result) if isinstance(result, dict) else str(result)

        elif tool_name == "research":
            from app.tools.research_tool import tool_handler as _h
            result = await _h(args)
            return _format_tool_result(result) if isinstance(result, dict) else str(result)

        elif tool_name == "security_scan":
            from app.tools.security_tool import tool_handler as _h
            result = await _h(args)
            return _format_tool_result(result) if isinstance(result, dict) else str(result)

        elif tool_name == "x_twitter":
            from app.tools.x_twitter_tool import tool_handler as _h
            result = await _h(args)
            return _format_tool_result(result) if isinstance(result, dict) else str(result)

        elif tool_name == "computer_use":
            from app.tools.computer_use_tool import tool_handler as _h
            result = await _h(args)
            return _format_tool_result(result) if isinstance(result, dict) else str(result)

        elif tool_name == "ffmpeg_editor":
            from app.tools.ffmpeg_tool import tool_handler as _h
            result = await _h(args)
            return _format_tool_result(result) if isinstance(result, dict) else str(result)

        elif tool_name == "mindmap":
            from app.tools.mindmap_tool import tool_handler as _h
            result = await _h(args)
            return _format_tool_result(result) if isinstance(result, dict) else str(result)

        elif tool_name == "music_gen":
            from app.tools.music_gen_tool import tool_handler as _h
            result = await _h(args)
            return _format_tool_result(result) if isinstance(result, dict) else str(result)

        elif tool_name == "logo_gen":
            from app.tools.logo_gen_tool import tool_handler as _h
            result = await _h(args)
            return _format_tool_result(result) if isinstance(result, dict) else str(result)

        elif tool_name == "excalidraw":
            from app.tools.excalidraw_tool import tool_handler as _h
            result = await _h(args)
            return _format_tool_result(result) if isinstance(result, dict) else str(result)

        elif tool_name == "comfyui_generate":
            from app.tools.comfyui_tool import tool_handler as _h
            result = await _h(args)
            return _format_tool_result(result) if isinstance(result, dict) else str(result)

        elif tool_name == "cad_3d":
            from app.tools.cad_tool import tool_handler as _h
            result = await _h(args)
            return _format_tool_result(result) if isinstance(result, dict) else str(result)

        elif tool_name == "openapi_consumer":
            from app.tools.openapi_consumer import tool_handler as _h
            result = await _h(args)
            return _format_tool_result(result) if isinstance(result, dict) else str(result)

        elif tool_name == "news_search":
            from app.tools.web_search import news_search
            query = args.get("query", args.get("q", ""))
            max_results = int(args.get("max_results", 8))
            articles = await news_search(query, max_results=max_results)
            if not articles:
                return "No news results found."
            lines = [
                f"[{a.get('source','')}] {a.get('title','')}: {a.get('snippet','')} ({a.get('url','')})"
                for a in articles
            ]
            return "News results:\n" + "\n".join(lines)

        else:
            # ── MCP Tool Registry — covers all new tools (sec_edgar, exa, polygon, etc.)
            try:
                from app.tools._mcp_wrapper import dispatch, is_registered
                if is_registered(tool_name):
                    result = await dispatch(tool_name, args)
                    if isinstance(result, dict):
                        if "error" in result:
                            return f"Tool error: {result['error']}"
                        return _format_tool_result(result)
                    return str(result)
            except Exception as reg_exc:
                logger.warning("[interface_agent] Registry dispatch for %s failed: %s", tool_name, reg_exc)

            # ── MCP Client fallback — external MCP servers (playwright, open-stocks-mcp, etc.)
            from app.service.mcp_client_service import get_mcp_client
            mcp = get_mcp_client()
            if mcp and mcp._initialized:
                try:
                    result = await mcp.call_tool(tool_name, args)
                    return result
                except ValueError:
                    pass  # not found in MCP either — fall through

            # ── Build available tools list dynamically
            builtin = (
                "web_search, browse, display, weather, finance_quote, market_overview, "
                "news, calendar, email, system_status, memory_search, graph_facts, "
                "knowledge_search, legislation_search, media_extract, watch_stream, "
                "stop_watch, search_transcript, browser_view, web_scrape, gpt_researcher, "
                "browser_navigate, run_custom_agent, read_file, open_file, list_dir, "
                "screen_capture, sleep, file_write, file_edit, snip, schedule_cron, "
                "list_scheduled_tasks, delete_scheduled_task, task_create, task_list, "
                "task_get, task_update, bash_exec, enter_plan_mode, "
                "manage_monitoring_profile, legislative_brief, run_leg_sync"
            )
            try:
                from app.tools._mcp_wrapper import get_registered_tools
                registry_names = ", ".join(sorted(get_registered_tools().keys()))
                if registry_names:
                    builtin += f", {registry_names}"
            except Exception:
                pass
            return f"Unknown tool: {tool_name}. Available: {builtin}."

    except Exception as exc:
        logger.warning("[interface_agent] Tool %s failed: %s", tool_name, exc)
        return f"Tool error: {exc}"


def _repair_tool_json(text: str) -> str:
    """Fix common LLM JSON errors: unquoted keys, trailing commas."""
    s = text.strip()
    s = re.sub(r'(?<=[\{,\n])\s*([a-zA-Z_]\w*)\s*:', r' "\1":', s)
    s = re.sub(r',\s*\}', '}', s)
    return s


def _unwrap_tool_args(obj: dict) -> dict:
    """Flatten {"tool": "X", "args": {k: v}} → {"tool": "X", k: v}."""
    if "args" in obj and isinstance(obj["args"], dict):
        args = obj.pop("args")
        obj.update(args)
    return obj


def _extract_tool_calls(text: str) -> list[dict]:
    """Extract JSON tool call objects from model output.

    Handles:
      - Bare JSON on its own line: {"tool": "web_search", "query": "..."}
      - Multi-line pretty-printed JSON with a "tool" key
      - JSON inside markdown code fences: ```json\n{...}\n```
      - JSON after </think> tag on a following line
      - "args" wrapper pattern: {"tool": "X", "args": {...}}
    """
    calls = []

    def _try_parse(raw: str, span) -> bool:
        """Try to parse raw JSON, with repair fallback. Returns True if added."""
        for candidate in (raw, _repair_tool_json(raw)):
            try:
                obj = json.loads(candidate)
                if isinstance(obj, dict) and "tool" in obj:
                    calls.append({"json": _unwrap_tool_args(obj), "span": span})
                    return True
            except (json.JSONDecodeError, ValueError):
                continue
        return False

    # Strip thinking prefix so tool calls after </think> are on clean lines
    cleaned = re.sub(r'^.*?</think>\s*', '', text, count=1, flags=re.DOTALL)
    # Also strip markdown code fences around JSON
    cleaned = re.sub(r'```(?:json)?\s*\n?', '', cleaned)

    # Match bare JSON objects on their own line that have a "tool" key (quoted or unquoted)
    for match in re.finditer(r'^\s*(\{[^\n]*(?:"tool"|tool\s*:)[^\n]*\})\s*$', cleaned, re.MULTILINE):
        _try_parse(match.group(1), match.span())

    # Fallback: multi-line JSON blocks containing a "tool" key
    if not calls:
        for match in re.finditer(r'(\{\s*\n[^{}]*(?:"tool"\s*:|tool\s*:)[^{}]*\})', cleaned, re.DOTALL):
            _try_parse(match.group(1), match.span())

    # Fallback: also check the original text (in case stripping removed valid matches)
    if not calls:
        for match in re.finditer(r'^\s*(\{[^\n]*(?:"tool"|tool\s*:)[^\n]*\})\s*$', text, re.MULTILINE):
            _try_parse(match.group(1), match.span())

    # Final fallback: multi-line in original text
    if not calls:
        for match in re.finditer(r'(\{\s*\n[^{}]*(?:"tool"\s*:|tool\s*:)[^{}]*\})', text, re.DOTALL):
            _try_parse(match.group(1), match.span())

    return calls


# ─────────────────────────────────────────────────────────────────────────────
# STUB RESPONSE
# ─────────────────────────────────────────────────────────────────────────────

async def _generate_stub_response(user_message: str, msg_id: str, tts_emitter=None) -> str:
    """
    Emit a stub token stream via SSE.
    Used when AURA_DEV_STUB_RESPONSES=True or model not loaded.
    """
    from app.controller.chat_controller import _emit

    msg_lower = user_message.lower()

    if any(w in msg_lower for w in ["hello", "hi", "hey", "good morning", "good evening"]):
        response = (
            "Hello. I'm AURA — your local AI workspace assistant. "
            "I'm running in stub mode right now, but the full interface is live. "
            "How can I help you today?"
        )
    elif "?" in user_message:
        response = (
            "That's a good question. In stub mode I can't give you a real answer, "
            "but the pipeline is working end-to-end. "
            "Once the interface model is loaded (Sprint 1 hardware setup), "
            "I'll respond with Qwen3-VL-8B reasoning."
        )
    elif any(w in msg_lower for w in ["status", "test", "ping", "health"]):
        response = (
            "Status check: SSE stream active. Chat wired. "
            "Backend responding. Stub mode is ON — "
            "set AURA_DEV_STUB_RESPONSES=false and load the model to go live."
        )
    else:
        response = (
            f"I received your message: \"{user_message[:120]}{'...' if len(user_message) > 120 else ''}\" — "
            f"The full pipeline is wired and running in stub mode. "
            f"Complete Sprint 0 hardware setup to activate the interface model."
        )

    words = response.split()
    for i, word in enumerate(words):
        token = word if i == 0 else f" {word}"
        await _emit("token", {"text": token, "messageId": msg_id})
        if tts_emitter:
            await tts_emitter.feed(token)
        await asyncio.sleep(0.025)

    return response


# ─────────────────────────────────────────────────────────────────────────────
# LIVE RESPONSE — TOOL-USE LOOP
# ─────────────────────────────────────────────────────────────────────────────

_MAX_TOOL_ROUNDS = 3      # prevent runaway tool loops
_GEN_MAX_TOKENS  = 4096   # budget for model generation (thinking + response)
_FAST_MAX_TOKENS = 2048   # reduced budget for simple conversational queries (never scaled)
_MAX_TOOL_RESULT_CHARS = 1500  # hard cap per tool result
_MEM_CTX_CHAR_BUDGET   = 6000  # ~1500 tokens; cap total assembled memory context
_MEM_CTX_SNIPPET_FULL  = 600   # chars per snippet under budget
_MEM_CTX_SNIPPET_TRIM  = 300   # chars per snippet when over budget
_MEM_CTX_RESULTS_TRIM  = 5     # top-N L2 results when over budget


def set_interface_budget(solo: bool) -> None:
    """
    Dynamically adjust generation budget based on workhorse state.
    Called by ollama_service when workhorse loads/unloads.

    solo=True  (workhorse idle):   full budget — 3 tool rounds, 4096 tokens, 6000 char memory
    solo=False (workhorse active): reduced budget — 2 rounds, 2048 tokens, 3000 char memory
    """
    global _MAX_TOOL_ROUNDS, _GEN_MAX_TOKENS, _MEM_CTX_CHAR_BUDGET
    if solo:
        _MAX_TOOL_ROUNDS     = 3
        _GEN_MAX_TOKENS      = 4096
        _MEM_CTX_CHAR_BUDGET = 6000
    else:
        _MAX_TOOL_ROUNDS     = 2
        _GEN_MAX_TOKENS      = 2048
        _MEM_CTX_CHAR_BUDGET = 3000

# Grammar-constrained tool call schema — used when model refuses to output tool JSON
_TOOL_CALL_SCHEMA = {
    "type": "object",
    "properties": {
        "use_tool":   {"type": "boolean"},
        "tool":       {"type": "string"},
        "query":      {"type": "string"},
        "ticker":     {"type": "string"},
        "path":       {"type": "string"},
        "command":    {"type": "string"},
        "url":        {"type": "string"},
        "operation":  {"type": "string"},
        "code":       {"type": "string"},
    },
    "required": ["use_tool", "tool"],
}


async def _grammar_tool_select(engine, user_message: str) -> dict | None:
    """
    Use grammar-constrained generation to ask the model which tool to use.
    Returns {"tool": "web_search", "query": "..."} or None if no tool needed.
    """
    messages = [
        {"role": "system", "content": (
            "Decide if a tool is needed to answer this question. "
            "Available tools: web_search, image_search, news_search, finance_quote, market_overview, "
            "weather, news, calendar, email, system_status, "
            "list_dir, read_file, open_file, file_write, file_edit, screen_capture, "
            "bash_exec, snip, git, "
            "browse, web_scrape, browser_view, media_extract, watch_stream, search_transcript, "
            "skills_lookup, display, task_create, task_list, enter_plan_mode, "
            "run_custom_agent, openapi_consumer, "
            "manage_monitoring_profile, legislative_brief, run_leg_sync. "
            "Output JSON: {\"use_tool\": true/false, \"tool\": \"<name>\", \"query\": \"<search terms>\", "
            "\"ticker\": \"<symbol>\", \"path\": \"<file or dir path>\", \"command\": \"<shell command>\", "
            "\"url\": \"<web url>\", \"operation\": \"<git operation>\", \"code\": \"<python code>\"}"
        )},
        {"role": "user", "content": user_message},
    ]
    try:
        result = await engine.generate_with_schema(messages, _TOOL_CALL_SCHEMA, max_tokens=128)
        parsed = json.loads(result.get("text", "{}"))
        if parsed.get("use_tool"):
            return parsed
    except Exception as exc:
        logger.debug("[interface_agent] Grammar tool select failed: %s", exc)
    return None

# Phrases that indicate the model WANTS to use a tool but output English instead of JSON
_TOOL_INTENT_PATTERNS = [
    # Web search
    (re.compile(r"i'll search for (.+?)(?:\.|$)", re.IGNORECASE), "web_search", "query"),
    (re.compile(r"let me search for (.+?)(?:\.|$)", re.IGNORECASE), "web_search", "query"),
    (re.compile(r"let me look up (.+?)(?:\.|$)", re.IGNORECASE), "web_search", "query"),
    (re.compile(r"i'll look up (.+?)(?:\.|$)", re.IGNORECASE), "web_search", "query"),
    (re.compile(r"searching for (.+?)(?:\.|$)", re.IGNORECASE), "web_search", "query"),
    # Finance
    (re.compile(r"let me check (?:the )?(.+?) (?:price|quote|ticker)", re.IGNORECASE), "finance_quote", "ticker"),
    (re.compile(r"i'll check (?:the )?(.+?) (?:price|quote|ticker)", re.IGNORECASE), "finance_quote", "ticker"),
    (re.compile(r"let me get (?:the )?(?:current |latest )?(.+?) price", re.IGNORECASE), "finance_quote", "ticker"),
    # Directory listing
    (re.compile(r"(?:let me |i'll )(?:browse|list|check|look at|open) (?:the )?(?:folder|directory|dir|path) (.+?)(?:\.|$)", re.IGNORECASE), "list_dir", "path"),
    (re.compile(r"(?:let me |i'll )(?:check|look at|look into|examine) (?:the |that |this )?(?:director(?:y|ies)|folder) (.+?)(?:\.|$)", re.IGNORECASE), "list_dir", "path"),
    # File reading
    (re.compile(r"(?:let me |i'll )(?:read|view|open|check) (?:the )?file (.+?)(?:\.|$)", re.IGNORECASE), "read_file", "path"),
    (re.compile(r"(?:let me |i'll )(?:check|look at|review|examine) (?:the |that |this )?(?:contents?|file) (.+?)(?:\.|$)", re.IGNORECASE), "read_file", "path"),
    # File writing/editing
    (re.compile(r"(?:let me |i'll )(?:write|save|create) (?:the |a )?file (.+?)(?:\.|$)", re.IGNORECASE), "file_write", "path"),
    (re.compile(r"(?:let me |i'll )(?:edit|modify|update) (?:the )?file (.+?)(?:\.|$)", re.IGNORECASE), "file_edit", "path"),
    # Shell commands
    (re.compile(r"(?:let me |i'll )(?:run|execute) (.+?)(?:\.|$)", re.IGNORECASE), "bash_exec", "command"),
    # Browse / scrape
    (re.compile(r"(?:let me |i'll )(?:browse|visit|open|go to|navigate to) (?:the )?(?:url |page |site |website )?(\S+)", re.IGNORECASE), "browse", "url"),
    (re.compile(r"(?:let me |i'll )(?:scrape|extract from|grab data from) (\S+)", re.IGNORECASE), "web_scrape", "url"),
    # Screen capture
    (re.compile(r"(?:let me |i'll )(?:check|view|look at|capture|take) (?:the |a )?screen", re.IGNORECASE), "screen_capture", "_dummy"),
    # Git
    (re.compile(r"(?:let me |i'll )(?:check|view|show|look at) (?:the )?git (\w+)", re.IGNORECASE), "git", "operation"),
    (re.compile(r"(?:let me |i'll )(commit|push|pull|checkout|branch|diff|log|status)\b", re.IGNORECASE), "git", "operation"),
    # Skills lookup
    (re.compile(r"(?:let me |i'll )(?:look up|check|find) (?:the )?(?:guide|procedure|skill|how-?to) (?:for |on )?(.+?)(?:\.|$)", re.IGNORECASE), "skills_lookup", "domain"),
]


def _detect_tool_intent(text: str) -> dict | None:
    """
    Detect when model expresses tool-use intent in English instead of JSON.
    Returns {"tool": "web_search", "query": "..."} or None.
    """
    clean = _strip_all_think_tags(text).strip()
    for pattern, tool_name, arg_key in _TOOL_INTENT_PATTERNS:
        match = pattern.search(clean)
        if match:
            value = match.group(1).strip().rstrip('.')
            logger.info("[interface_agent] Detected tool intent: %s(%s=%r)", tool_name, arg_key, value)
            return {"tool": tool_name, arg_key: value}
    return None


# Phrases where the model refuses to use tools at all (round 0 — force tool use).
# These indicate the model *claimed* it can't do something without trying.
_REFUSAL_INDICATORS = [
    "i don't have access", "i cannot access", "i'm not able to",
    "beyond my capabilities", "i can't provide real-time", "i don't have real-time",
    "i don't have the ability", "i lack access", "i am not able to",
    "i don't have direct", "i can't just reach",
    "i don't have filesystem", "no filesystem access",
    "no results", "couldn't find", "could not find", "unable to find",
    "search returned no", "no relevant results",
    # Browse / URL access
    "can't browse", "i cannot browse", "i can't open urls", "i cannot visit",
    "i can't navigate to", "i cannot open web",
    # Git
    "i don't have git", "i can't run git", "no git access",
    "i cannot run git", "i don't have version control",
    # File write / edit
    "i cannot write files", "i can't write to", "i can't create files",
    "i cannot edit files", "i can't edit", "i cannot create files",
    "i can't save", "i cannot save",
    # Screenshots / screen
    "i can't take screenshots", "i cannot capture", "i can't capture the screen",
    # Command execution
    "i can't execute", "i cannot execute", "i can't run commands",
    "i cannot run commands", "i don't have shell",
]

# Phrases that indicate a FUNDAMENTAL capability failure after tools were tried.
# These must NOT include "no results" style phrases — those mean the search
# came up empty, which is a valid outcome, not a team escalation trigger.
_ESCALATION_INDICATORS = [
    "i don't have access to that", "i cannot access that",
    "beyond my capabilities", "requires specialized expertise i don't have",
    "i fundamentally cannot", "outside my ability",
]

# Backward compat alias used by the round-0 refusal check
_FAILURE_INDICATORS = _REFUSAL_INDICATORS


# ─────────────────────────────────────────────────────────────────────────────
# COORDINATE-BASED CONTEXT SYSTEM
# Pre-fetches local DBs + web in parallel before model runs.
# Results stored in session cache; only lightweight coordinate labels
# (key → semantic label) enter the context. Model expands on demand.
# ─────────────────────────────────────────────────────────────────────────────

# Session-scoped cache: key → {label, items, count, source}
# Lives for the process lifetime; keys are deterministic so re-fetching
# the same query within a session hits cache instantly.
_SESSION_CACHE: dict[str, dict] = {}


def _make_coord_key(source: str, query: str) -> str:
    """Deterministic short key: 'leg:ai_bills_californ'"""
    slug = re.sub(r'\W+', '_', query.lower())[:20].strip('_')
    return f"{source[:3]}:{slug}"


# ── Query classifiers (lightweight keyword matching) ─────────────────────────

_LEG_KEYWORDS = (
    "bill", "bills", "legislation", "legislative", "statute", "statutes",
    "act", "law", "laws", "senate bill", "house bill", "assembly bill",
    "congress", "legislature", "ordinance",
)
_KNOWLEDGE_KEYWORDS = (
    "what is", "what are", "who is", "who was", "define", "definition",
    "explain", "research", "study", "paper", "pubmed", "arxiv", "wikipedia",
    "how does", "how do", "how to", "how can", "how should",
    "history of", "overview of", "background on",
    "clinical trial", "scientific", "academic",
    "treat", "treatment", "remedy", "symptoms", "cause of", "causes of",
    "difference between", "versus", "compare",
)
_MEMORY_KEYWORDS = (
    "remember", "recall", "last time", "we discussed", "you said",
    "what did we", "from before", "previously", "our conversation",
    "you mentioned", "earlier", "last session", "past",
)


_FILESYSTEM_KEYWORDS = (
    "read file", "read the file", "list dir", "list the dir",
    "access folder", "access the folder", "browse folder", "browse the folder",
    "open file", "open the file", "list folder", "list the folder",
    "source file", "source code", "show me the file", "show me the folder",
    "check the file", "check the folder", "access this folder",
    "\\users\\", "/home/", "/usr/", "/etc/", "c:\\", "d:\\",
    "desktop\\", "documents\\", "downloads\\",
    ".py", ".js", ".jsx", ".ts", ".tsx", ".json", ".md", ".txt", ".cfg",
    ".yaml", ".yml", ".toml", ".csv",
)


def _query_needs_filesystem(text: str) -> bool:
    lower = text.lower().replace("/", "\\")
    if any(kw in lower for kw in _FILESYSTEM_KEYWORDS):
        return True
    # Also detect Windows/Unix absolute paths via regex
    return bool(re.search(r'[A-Za-z]:[\\\/]|(?:^|[\s"])(?:\/|~\/)\S', text))


def _query_needs_legislation(text: str) -> bool:
    lower = text.lower()
    return any(kw in lower for kw in _LEG_KEYWORDS)


def _query_needs_knowledge(text: str) -> bool:
    lower = text.lower()
    return any(kw in lower for kw in _KNOWLEDGE_KEYWORDS)


def _query_needs_memory(text: str) -> bool:
    lower = text.lower()
    return any(kw in lower for kw in _MEMORY_KEYWORDS)


# ── Individual fetchers ──────────────────────────────────────────────────────

async def _fetch_legislation_markers(query: str) -> dict | None:
    try:
        from app.service.legislation_service import get_legislation_service
        svc = get_legislation_service()
        if svc is None or not svc._available():
            return None
        results = await asyncio.to_thread(svc.search_bills, query, None, None, None, 10)
        if not results:
            return None
        titles = [b.get("title", b.get("bill_number", ""))[:50] for b in results[:3]]
        label = f"{len(results)} bills: {'; '.join(t for t in titles if t)}"
        return {"label": label, "items": results, "count": len(results), "source": "legislation"}
    except Exception as exc:
        logger.debug("[prefetch] legislation error: %s", exc)
        return None


async def _fetch_knowledge_markers(query: str) -> dict | None:
    try:
        from app.knowledge.router import auto_query
        raw = await auto_query(query, max_tokens=800)
        if not raw or len(raw.strip()) < 30:
            return None
        # auto_query returns a formatted string — wrap as single item
        preview = raw[:120].replace("\n", " ")
        label = f"knowledge: {preview}..."
        return {"label": label, "items": [{"content": raw}], "count": 1, "source": "knowledge"}
    except Exception as exc:
        logger.warning("[prefetch] knowledge error: %s", exc)
        return None


async def _fetch_memory_markers(query: str) -> dict | None:
    try:
        from app.service.memory_service import get_memory_service
        svc = get_memory_service()
        if svc is None:
            return None
        results = await svc.search(query, limit=5)
        if not results:
            return None
        count = len(results)
        label = f"{count} memory records matching this topic"
        return {"label": label, "items": results, "count": count, "source": "memory"}
    except Exception as exc:
        logger.warning("[prefetch] memory error: %s", exc)
        return None


async def _fetch_filesystem_markers(query: str) -> dict | None:
    """Pre-fetch directory listing or file preview when user references a path."""
    import os

    # Extract a path from the query
    path_match = re.search(r'([A-Za-z]:[\\\/][^\s,;\"\']+)', query)
    if not path_match:
        path_match = re.search(r'((?:\/|~\/)[^\s,;\"\']+)', query)
    if not path_match:
        return None

    path = os.path.expandvars(os.path.expanduser(path_match.group(1)))
    try:
        if os.path.isdir(path):
            entries = sorted(os.scandir(path), key=lambda x: (not x.is_dir(), x.name.lower()))
            lines = []
            for e in entries[:50]:
                if e.is_dir():
                    lines.append(f"[DIR]  {e.name}")
                else:
                    try:
                        size = e.stat().st_size
                        size_str = f"{size / 1024:.1f} KB" if size >= 1024 else f"{size} B"
                    except OSError:
                        size_str = "?"
                    lines.append(f"[FILE] {e.name}  ({size_str})")
            listing = "\n".join(lines) if lines else "(empty directory)"
            label = f"directory {os.path.basename(path)}: {len(entries)} items"
            return {
                "label": label,
                "items": [{"path": path, "type": "directory", "listing": listing, "count": len(entries)}],
                "count": len(entries),
                "source": "filesystem",
            }
        elif os.path.isfile(path):
            size = os.path.getsize(path)
            size_str = f"{size / 1024:.1f} KB" if size >= 1024 else f"{size} B"
            # Read first 2KB for preview
            preview = ""
            try:
                with open(path, "r", encoding="utf-8", errors="replace") as f:
                    preview = f.read(2048)
            except Exception:
                preview = "(binary or unreadable)"
            label = f"file {os.path.basename(path)} ({size_str})"
            return {
                "label": label,
                "items": [{"path": path, "type": "file", "size": size_str, "preview": preview}],
                "count": 1,
                "source": "filesystem",
            }
        else:
            return None
    except (PermissionError, FileNotFoundError, OSError) as exc:
        logger.debug("[prefetch] filesystem error: %s", exc)
        return None


async def _fetch_web_markers(query: str) -> dict | None:
    try:
        from app.tools.web_search import search
        results = await search(query, max_results=5)
        if not results:
            logger.info("[prefetch] web search returned 0 results for %r", query)
            return None
        titles = [r.get("title", "")[:50] for r in results[:3]]
        label = f"{len(results)} web results: {'; '.join(t for t in titles if t)}"
        return {"label": label, "items": results, "count": len(results), "source": "web"}
    except Exception as exc:
        logger.warning("[prefetch] web error: %s", exc)
        return None


# ── Main pre-fetch orchestrator ──────────────────────────────────────────────

async def _prefetch_to_cache(user_message: str) -> dict[str, str]:
    """
    Run relevant DB + web queries in parallel (~3s total, web is bottleneck).
    Store full results in _SESSION_CACHE. Return {key: label} coordinate index.
    Nothing enters model context except the short labels.
    """
    fetch_tasks: list[tuple[str, str]] = []  # [(source_name, coroutine)]
    coros = []

    if _query_needs_legislation(user_message):
        fetch_tasks.append(("legislation", "leg"))
        coros.append(_fetch_legislation_markers(user_message))
    if _query_needs_knowledge(user_message):
        fetch_tasks.append(("knowledge", "kno"))
        coros.append(_fetch_knowledge_markers(user_message))
    if _query_needs_memory(user_message):
        fetch_tasks.append(("memory", "mem"))
        coros.append(_fetch_memory_markers(user_message))
    if _query_needs_filesystem(user_message):
        fetch_tasks.append(("filesystem", "fil"))
        coros.append(_fetch_filesystem_markers(user_message))
    # Web always runs
    fetch_tasks.append(("web", "web"))
    coros.append(_fetch_web_markers(user_message))

    raw_results = await asyncio.gather(*coros, return_exceptions=True)

    coords: dict[str, str] = {}
    for (source_name, _), result in zip(fetch_tasks, raw_results):
        if isinstance(result, Exception) or not result:
            continue
        key = _make_coord_key(source_name, user_message)
        _SESSION_CACHE[key] = result
        coords[key] = result["label"]

    logger.info("[prefetch] %d coordinate(s) loaded: %s", len(coords), list(coords.keys()))
    return coords


# ── Expand handler ────────────────────────────────────────────────────────────

def _format_coord_summary(items: list, source: str) -> str:
    """3-sentence summary per item, max 3 items. ~60 tokens total."""
    if source == "legislation":
        lines = []
        for b in items[:3]:
            title = b.get("title") or b.get("bill_number", "Unknown bill")
            state = b.get("state", "")
            status = b.get("status", "")
            desc = b.get("description") or b.get("summary", "")
            line = f"• {title}"
            if state:
                line += f" ({state})"
            if status:
                line += f" — {status}"
            if desc:
                line += f": {desc[:120]}"
            lines.append(line)
        return "\n".join(lines)
    elif source == "knowledge":
        content = items[0].get("content", "") if items else ""
        return content[:600]
    elif source == "memory":
        lines = []
        for m in items[:3]:
            content = m.get("content") or m.get("text", "")
            lines.append(f"• {content[:120]}")
        return "\n".join(lines)
    elif source == "web":
        lines = []
        for r in items[:3]:
            title = r.get("title", "")
            snippet = r.get("snippet", "")
            url = r.get("url", "")
            lines.append(f"• {title}: {snippet[:120]}\n  {url}")
        return "\n".join(lines)
    elif source == "filesystem":
        lines = []
        for item in items[:3]:
            path = item.get("path", "")
            if item.get("type") == "directory":
                lines.append(f"• [DIR] {path} — {item.get('count', '?')} items")
            else:
                lines.append(f"• [FILE] {path} ({item.get('size', '?')})")
        return "\n".join(lines)
    return str(items)[:400]


def _format_coord_full(items: list, source: str) -> str:
    """Full content, up to 200 tokens/item, max 3 items."""
    if source == "legislation":
        lines = []
        for b in items[:3]:
            parts = []
            for field in ("bill_number", "title", "state", "chamber", "status",
                          "description", "summary", "last_action", "session"):
                val = b.get(field)
                if val:
                    parts.append(f"{field}: {str(val)[:200]}")
            lines.append("\n".join(parts))
        return "\n\n---\n\n".join(lines)
    elif source == "knowledge":
        content = items[0].get("content", "") if items else ""
        return content[:1200]
    elif source == "memory":
        lines = []
        for m in items[:3]:
            content = m.get("content") or m.get("text", "")
            ts = m.get("timestamp", "")
            lines.append(f"[{ts}] {content[:400]}" if ts else content[:400])
        return "\n\n".join(lines)
    elif source == "web":
        lines = []
        for r in items[:3]:
            lines.append(
                f"Title: {r.get('title','')}\n"
                f"URL: {r.get('url','')}\n"
                f"Content: {r.get('snippet','')[:400]}"
            )
        return "\n\n---\n\n".join(lines)
    elif source == "filesystem":
        lines = []
        for item in items[:3]:
            path = item.get("path", "")
            if item.get("type") == "directory":
                lines.append(f"Directory: {path}\n{item.get('listing', '(empty)')}")
            else:
                lines.append(f"File: {path} ({item.get('size', '?')})\n{item.get('preview', '(no preview)')[:800]}")
        return "\n\n---\n\n".join(lines)
    return str(items)[:800]


async def _handle_expand(key: str, detail: bool = False) -> str:
    """Expand a coordinate key from session cache. Returns summary or full content."""
    cached = _SESSION_CACHE.get(key)
    if not cached:
        return f"No cached data for key '{key}'. The data may have expired — try rephrasing your query."
    items = cached.get("items", [])
    source = cached.get("source", "")
    if detail:
        return _format_coord_full(items, source)
    return _format_coord_summary(items, source)


# ── Clarification gate ────────────────────────────────────────────────────────

_CLARIFICATION_EXEMPT = (
    "weather", "temperature", "forecast", "rain", "sunny",
    "price", "stock", "market", "ticker", "crypto", "bitcoin",
    "news", "headlines", "latest",
    "schedule", "calendar", "meeting", "appointment", "agenda",
    "email", "inbox", "message",
    "bill", "bills", "legislation", "law", "act", "statute",
    "who is", "who was", "what is", "what are", "what's",
    "how do", "how does", "how did", "when did", "where is",
    "define", "explain", "describe", "summarize", "tell me",
    "show me", "find me", "search", "look up", "pull up",
    "status", "system", "memory", "remember",
    "time", "date", "today", "tomorrow", "yesterday",
)


_GREETINGS = (
    "hello", "hi ", "hey ", "good morning", "good afternoon", "good evening",
    "good night", "greetings", "howdy", "sup ", "what's up", "wassup",
    "thank", "thanks", "ty ", "thx", "appreciate", "great", "awesome",
    "ok", "okay", "sure", "got it", "sounds good", "perfect", "cool",
    "bye", "goodbye", "see you", "later", "take care",
)


def _is_greeting(text: str) -> bool:
    """Return True if the message is a simple greeting or conversational pleasantry."""
    lower = text.lower().strip()
    return any(lower.startswith(g.strip()) or g in lower for g in _GREETINGS)


def _is_ambiguous(text: str, window: list) -> bool:
    """Return True if the query is too vague to fetch for without clarification."""
    lower = text.lower().strip()
    words = lower.split()

    # Never ask for clarification on greetings or conversational acknowledgements
    if _is_greeting(lower):
        return False

    # Exempt: query contains a clear data keyword
    if any(kw in lower for kw in _CLARIFICATION_EXEMPT):
        return False

    # Bare noun phrase: short, no verb, no exempt keyword
    # Only treat short messages as ambiguous on the FIRST message (no window context).
    # If there's an active conversation, short follow-ups have implicit context.
    if len(words) <= 4 and not window:
        return True

    # Unresolved pronoun with no conversation context to anchor it
    bare_pronouns = ("this", "that", "it ", " it", "those", "these")
    if any(p in lower for p in bare_pronouns) and not window:
        return True

    return False


def _generate_clarification(text: str) -> str:
    """Return a single targeted clarifying question."""
    lower = text.lower().strip()
    if any(w in lower for w in ("policy", "regulation", "government", "political")):
        return "What angle are you looking for — recent legislation, news coverage, policy analysis, or something else?"
    if any(w in lower for w in ("ai", "artificial intelligence", "machine learning", "tech")):
        return "What would you like to know — recent news, legislative activity, research papers, or a general overview?"
    if any(w in lower for w in ("economy", "market", "economic", "finance", "financial")):
        return "Are you looking for current market data, economic news, research, or analysis on a specific topic?"
    return "Can you give me a bit more to go on? Are you looking for news, legislation, research, or something else?"


def _needs_clarification(coords: dict, user_message: str, window: list) -> str | None:
    """
    Returns a clarifying question string if the query is ambiguous AND
    pre-fetch returned nothing useful. Returns None if we have enough to proceed.
    Gate fires after pre-fetch — empty index is the primary signal.
    """
    if not coords and _is_ambiguous(user_message, window):
        return _generate_clarification(user_message)
    return None


def _estimate_tokens(messages: list[dict]) -> int:
    """Rough token estimate: 1 token ≈ 4 chars."""
    return sum(len(m.get("content", "")) for m in messages) // 4


def _condense_messages(messages: list[dict]) -> list[dict]:
    """
    Context window guard: if messages exceed 75% of 4096 tokens,
    keep only system prompt + last 3 turns to stay within budget.
    Older context is already preserved in memory layers.
    """
    est = _estimate_tokens(messages)
    if est <= _CTX_CONDENSE_LIMIT:
        return messages

    logger.info(
        "[interface_agent] Context condensing: ~%d tokens > %d limit — trimming history",
        est, _CTX_CONDENSE_LIMIT,
    )

    # Always keep system prompt (first message) + last 3 user/assistant pairs (6 msgs)
    condensed = [messages[0]]  # system prompt
    # Take the tail — most recent conversation turns
    tail = messages[1:]
    if len(tail) > 6:
        tail = tail[-6:]
    condensed.extend(tail)

    logger.info(
        "[interface_agent] Condensed: %d msgs → %d msgs (~%d tokens)",
        len(messages), len(condensed), _estimate_tokens(condensed),
    )
    return condensed


async def _persist_condensation_summary(
    original: list[dict], thread_id: str,
) -> None:
    """Save discarded conversation turns to memory before they're lost."""
    # original[0] is system prompt, kept tail is last 6 non-system messages
    discarded = original[1:-6] if len(original) > 7 else []
    if not discarded:
        return
    parts: list[str] = []
    for m in discarded:
        role = "User" if m.get("role") == "user" else "AURA"
        content = m.get("content", "")[:400]
        if content:
            parts.append(f"[{role}] {content}")
    summary = "\n".join(parts)[:2000]
    if not summary:
        return
    try:
        from app.service.memory_service import get_memory_service
        mem_svc = get_memory_service()
        if mem_svc:
            await mem_svc.record(
                "interface", summary, thread_id,
                metadata={"source": "condensation", "discarded_count": len(discarded)},
            )
            logger.info(
                "[interface_agent] Condensation summary persisted (%d turns, thread=%s)",
                len(discarded), thread_id[:12],
            )
    except Exception as exc:
        logger.debug("[interface_agent] Condensation persistence failed: %s", exc)


_COMPLEX_INDICATORS = frozenset([
    # code / technical
    "code", "function", "class", "import", "script", "python", "javascript",
    "typescript", "sql", "algorithm", "debug", "error", "exception",
    # math / analysis
    "calculate", "equation", "formula", "derive", "proof", "integrate",
    "matrix", "statistics", "regression",
    # document / research
    "summarize", "analyze", "compare", "report", "research", "document",
    "essay", "draft", "write a", "explain in detail", "step by step",
    # tool signals
    "search", "find", "look up", "check", "fetch", "weather", "price",
    "stock", "news", "current", "latest", "today",
])


def _is_simple_query(text: str) -> bool:
    """Return True for short conversational queries with no code/math/tool signals."""
    if len(text) > 200:
        return False
    lower = text.lower()
    return not any(kw in lower for kw in _COMPLEX_INDICATORS)


def _format_memory_context(context: dict) -> str:
    """Format build_context() output into a string for the system prompt."""

    def _rel_time(ts_str: str) -> str:
        try:
            delta = time.time() - float(ts_str)
            if delta < 3600:
                return f"{int(delta // 60)}m ago"
            elif delta < 86400:
                return f"{int(delta // 3600)}h ago"
            else:
                return f"{int(delta // 86400)}d ago"
        except Exception:
            return ""

    parts = []

    # Separate skill results from general memory results for cleaner display
    all_retrieved = context.get("retrieved", [])
    skill_hits = [r for r in all_retrieved if r.get("metadata", {}).get("source") == "skill"]
    retrieved = [r for r in all_retrieved if r.get("metadata", {}).get("source") != "skill"]

    # Captured procedures — show before general memories for discoverability
    if skill_hits:
        parts.append("CAPTURED PROCEDURES (relevant skills):")
        for i, r in enumerate(skill_hits[:3], 1):
            raw = r.get("content", "")
            content = (raw[len("passage: "):] if raw.startswith("passage: ") else raw)[:200]
            parts.append(f"  [{i}] {content}")

    # L2 — semantic + keyword results
    if retrieved:
        parts.append("RETRIEVED MEMORIES (semantic + keyword match):")
        for i, r in enumerate(retrieved[:15], 1):
            raw = r.get("content", "")
            content = (raw[len("passage: "):] if raw.startswith("passage: ") else raw)[:_MEM_CTX_SNIPPET_FULL]
            meta = r.get("metadata", {})
            source = meta.get("agent_role", "") or meta.get("source", "")
            rel = _rel_time(meta.get("timestamp", ""))
            tag_parts = []
            if source:
                tag_parts.append(f"source: {source}")
            if rel:
                tag_parts.append(rel)
            tag = f" [{', '.join(tag_parts)}]" if tag_parts else ""
            parts.append(f"  [{i}] {content}{tag}")

        # Memory budget guard: if L2 alone exceeds budget, rebuild with fewer/shorter snippets
        if len("\n".join(parts)) > _MEM_CTX_CHAR_BUDGET:
            logger.info(
                "[interface_agent] Memory context over budget (%d chars) — trimming L2 to top %d at %d chars",
                len("\n".join(parts)), _MEM_CTX_RESULTS_TRIM, _MEM_CTX_SNIPPET_TRIM,
            )
            parts = ["RETRIEVED MEMORIES (semantic + keyword match):"]
            for i, r in enumerate(retrieved[:_MEM_CTX_RESULTS_TRIM], 1):
                raw = r.get("content", "")
                content = (raw[len("passage: "):] if raw.startswith("passage: ") else raw)[:_MEM_CTX_SNIPPET_TRIM]
                meta = r.get("metadata", {})
                source = meta.get("agent_role", "") or meta.get("source", "")
                rel = _rel_time(meta.get("timestamp", ""))
                tag_parts = []
                if source:
                    tag_parts.append(f"source: {source}")
                if rel:
                    tag_parts.append(rel)
                tag = f" [{', '.join(tag_parts)}]" if tag_parts else ""
                parts.append(f"  [{i}] {content}{tag}")

    # L3 — knowledge graph facts
    facts = context.get("facts", [])
    if facts:
        parts.append("KNOWLEDGE GRAPH FACTS:")
        for i, f in enumerate(facts[:10], 1):
            fact_text = f.get("fact", "")
            fact_source = f.get("source", "")
            tag = f" [source: {fact_source}]" if fact_source else ""
            parts.append(f"  [{i}] {fact_text}{tag}")

    # Personal knowledge — user-ingested documents
    personal = context.get("personal", [])
    if personal:
        parts.append("PERSONAL KNOWLEDGE (auto-retrieved):")
        for i, p in enumerate(personal[:5], 1):
            content = p.get("content", "")[:400]
            tag_parts = []
            if p.get("doc_type"):
                tag_parts.append(f"type: {p['doc_type']}")
            if p.get("title"):
                tag_parts.append(f"title: {p['title']}")
            tag = f" [{', '.join(tag_parts)}]" if tag_parts else ""
            parts.append(f"  [{i}] {content}{tag}")

    # Session seed anchors — most recent memories when L2/L3 had no hits
    anchors = context.get("anchors", [])
    if anchors:
        parts.append("SESSION SEED (most recent memories — no query match this turn):")
        for i, r in enumerate(anchors, 1):
            raw = r.get("content", "")
            content = (raw[len("passage: "):] if raw.startswith("passage: ") else raw)[:200]
            meta = r.get("metadata", {})
            source = meta.get("agent_role", "")
            tag = f" [source: {source}]" if source else ""
            parts.append(f"  [{i}] {content}{tag}")

    # Standby files — metadata only, ~5 tokens per file
    standby_files = context.get("standby_files", [])
    if standby_files:
        try:
            from app.service.file_index_service import format_file_manifest, FileResult
            # Reconstruct FileResult objects for formatting
            from app.service.file_index_service import FileResult as _FR
            fr_list = [_FR(**{k: v for k, v in f.items() if k in _FR.__dataclass_fields__}) for f in standby_files]
            manifest = format_file_manifest(fr_list)
            if manifest:
                parts.append(manifest)
        except Exception:
            # Fallback: plain list
            names = [f.get("name", "") for f in standby_files[:8] if f.get("name")]
            if names:
                parts.append("Files on standby: " + ", ".join(names) + ".")

    # LightRAG — entity-aware relational knowledge graph results
    lightrag = context.get("lightrag", [])
    if lightrag:
        parts.append("KNOWLEDGE GRAPH (relational):")
        for i, item in enumerate(lightrag, 1):
            content = item.get("content", "")[:600]
            source = item.get("source", "")
            tag = f" [source: {source}, mode: hybrid]" if source else ""
            parts.append(f"  [{i}] {content}{tag}")

    return "\n".join(parts) if parts else ""


async def _try_workhorse_escalation(
    user_message: str,
    messages: list[dict],
    msg_id: str,
    emit_fn,
) -> str | None:
    """
    Attempt to escalate to the Ollama workhorse when the interface engine
    couldn't answer (e.g. web search returned nothing).

    Returns the workhorse response text, or None if workhorse is unavailable.
    """
    try:
        from app.service.ollama_service import get_ollama_service
        ollama = get_ollama_service()
        if ollama is None or not ollama.is_available():
            logger.info("[interface_agent] Workhorse escalation skipped — Ollama not available")
            return None
    except Exception:
        return None

    logger.info("[interface_agent] Interface response indicates failure — escalating to workhorse")
    await emit_fn("agent_update", {
        "node": "interface_agent",
        "status": "running",
        "detail": "Escalating to workhorse model for deeper analysis...",
    })

    # Build a fresh message list for the workhorse — it gets the original user
    # question plus any tool results that were gathered, but a simpler system prompt.
    workhorse_messages = [
        {"role": "system", "content": (
            "You are AURA's workhorse engine — a powerful reasoning model. "
            "The interface agent could not answer the user's question with its tools. "
            "Answer the question as thoroughly as you can. Be direct and factual."
        )},
    ]
    # Carry forward any tool results from the conversation (skip system prompt)
    for m in messages[1:]:
        workhorse_messages.append({"role": m["role"], "content": m["content"]})

    try:
        reply = await ollama.stream_chat(
            messages=workhorse_messages,
            emit_fn=emit_fn,
            msg_id=msg_id,
            temperature=0.4,
        )
        logger.info("[interface_agent] Workhorse escalation succeeded — %d chars", len(reply or ""))
        return reply or ""
    except Exception as exc:
        logger.warning("[interface_agent] Workhorse escalation failed: %s", exc)
        return None


async def _stream_generate_with_thinking(
    engine,
    messages: list[dict],
    max_tokens: int,
    temperature: float,
    msg_id: str,
    tts_emitter=None,
) -> "tuple[str, str, bool]":
    """
    Stream generation with inline <think> block extraction.

    - Emits 'agent_update' thinking indicator before generation starts
    - Thinking tokens are buffered, suppressed from chat, emitted as single 'thinking' event
    - Response tokens are emitted in real-time via 'token' events
    - Tool call JSON (content starting with '{' after thinking) is buffered, not emitted

    Returns:
        (full_text, clean_text, emitted_response)
        full_text: everything generated including think tags (for tool call detection)
        clean_text: think tags stripped (for memory recording / fallback emit)
        emitted_response: True if response tokens were streamed to frontend
    """
    from app.controller.chat_controller import _emit

    full_text = ""
    think_buf = ""      # accumulates tokens while in thinking phase
    response_buf = ""
    line_buf = ""       # per-line buffer for tool-call detection mid-stream
    json_accum = ""     # accumulates multi-line JSON tool calls
    json_accum_lines = 0
    thinking_done = False
    is_tool_call = False
    emitted_response = False

    _MAX_JSON_ACCUM_LINES = 10  # give up after this many lines

    def _has_tool_key(s: str) -> bool:
        return '"tool"' in s or re.search(r'\btool\s*:', s) is not None

    def _is_tool_json(line: str) -> bool:
        """Check if a line looks like a tool-call JSON object (single-line)."""
        s = line.strip()
        return s.startswith("{") and _has_tool_key(s) and s.endswith("}")

    def _starts_tool_json(line: str) -> bool:
        """Check if a line starts a multi-line tool call JSON block."""
        s = line.strip()
        return s == "{" or (s.startswith("{") and _has_tool_key(s) and not s.endswith("}"))

    def _try_parse_tool_json(text: str) -> dict | None:
        """Try to parse accumulated text as a tool-call JSON object."""
        for candidate in (text.strip(), _repair_tool_json(text)):
            try:
                obj = json.loads(candidate)
                if isinstance(obj, dict) and "tool" in obj:
                    return _unwrap_tool_args(obj)
            except (json.JSONDecodeError, ValueError):
                continue
        return None

    await _emit("agent_update", {
        "node": "interface_agent",
        "status": "thinking",
        "detail": "Processing...",
    })

    async for chunk in engine.generate_streaming(messages, max_tokens=max_tokens, temperature=temperature):
        full_text += chunk

        if not thinking_done:
            think_buf += chunk

            if "</think>" in think_buf:
                # Thinking block ended
                thinking_done = True
                idx = think_buf.find("</think>")
                thinking_content = think_buf[:idx].replace("<think>", "").strip()
                after = think_buf[idx + len("</think>"):]
                if thinking_content:
                    await _emit("thinking", {"text": thinking_content})
                stripped_after = after.lstrip()
                if stripped_after.startswith("{"):
                    is_tool_call = True
                    response_buf = after
                else:
                    response_buf = after
                    # Feed initial post-think text through line buffer
                    line_buf = after

            elif len(think_buf) > 80 and "<think>" not in think_buf and "</think>" not in think_buf:
                # No thinking block — content is direct response or tool call JSON
                thinking_done = True
                stripped = think_buf.lstrip()
                if stripped.startswith("{"):
                    is_tool_call = True
                    response_buf = think_buf
                else:
                    response_buf = think_buf
                    # Feed through line buffer instead of emitting immediately
                    line_buf = think_buf
        else:
            # Post-thinking chunks
            if is_tool_call:
                response_buf += chunk  # continue buffering the tool call JSON
            else:
                line_buf += chunk

        # Flush completed lines from the line buffer (only when not in tool-call mode)
        if not is_tool_call and thinking_done and "\n" in line_buf:
            lines = line_buf.split("\n")
            # Keep the last (potentially incomplete) segment in the buffer
            line_buf = lines[-1]
            for line in lines[:-1]:
                # If we're accumulating a multi-line JSON block
                if json_accum:
                    json_accum += line + "\n"
                    json_accum_lines += 1
                    parsed = _try_parse_tool_json(json_accum)
                    if parsed is not None:
                        # Valid tool JSON — switch to tool-call mode
                        is_tool_call = True
                        response_buf += json_accum + line_buf
                        line_buf = ""
                        json_accum = ""
                        json_accum_lines = 0
                        break
                    elif json_accum_lines >= _MAX_JSON_ACCUM_LINES:
                        # Too many lines — not a tool call, flush as text
                        for accum_line in json_accum.split("\n"):
                            if accum_line.strip():
                                await _emit("token", {"text": accum_line + "\n", "messageId": msg_id})
                                if tts_emitter:
                                    await tts_emitter.feed(accum_line + "\n")
                                emitted_response = True
                        json_accum = ""
                        json_accum_lines = 0
                    continue

                if _is_tool_json(line):
                    # Single-line tool JSON detected mid-stream
                    is_tool_call = True
                    response_buf += line + "\n" + line_buf
                    line_buf = ""
                    break
                elif _starts_tool_json(line):
                    # Start of multi-line JSON — begin accumulating
                    json_accum = line + "\n"
                    json_accum_lines = 1
                else:
                    text_to_emit = line + "\n"
                    if text_to_emit.strip():
                        await _emit("token", {"text": text_to_emit, "messageId": msg_id})
                        if tts_emitter:
                            await tts_emitter.feed(text_to_emit)
                        emitted_response = True

    # Flush any remaining content in the line buffer
    if line_buf and not is_tool_call:
        # Check if line_buf completes a pending multi-line JSON accumulation
        if json_accum:
            json_accum += line_buf
            parsed = _try_parse_tool_json(json_accum)
            if parsed is not None:
                is_tool_call = True
                response_buf += json_accum
                json_accum = ""
            else:
                # Not valid JSON — flush accumulated + remaining as text
                flush_text = json_accum
                json_accum = ""
                if flush_text.strip():
                    await _emit("token", {"text": flush_text, "messageId": msg_id})
                    if tts_emitter:
                        await tts_emitter.feed(flush_text)
                    emitted_response = True
        elif _is_tool_json(line_buf):
            is_tool_call = True
            response_buf += line_buf
        elif line_buf.strip():
            await _emit("token", {"text": line_buf, "messageId": msg_id})
            if tts_emitter:
                await tts_emitter.feed(line_buf)
            emitted_response = True

    clean_text = _strip_all_think_tags(full_text).strip()
    return full_text, clean_text, emitted_response


async def _generate_live_response(
    user_message: str,
    msg_id: str,
    messages_for_model: list[dict],
    tts_emitter=None,
) -> str:
    """
    Generate a response using the interface engine, with tool-use loop.

    Loop:
      1. Call engine.generate(messages)
      2. If output contains tool calls → dispatch them, append results, repeat
      3. When output has no tool calls → stream final text as SSE tokens
    """
    from app.controller.chat_controller import _emit
    from app.service.interface_engine import get_engine

    engine = get_engine()
    if engine is None:
        # Interface engine not loaded — try Ollama as fallback
        try:
            from app.service.ollama_service import get_ollama_service
            ollama = get_ollama_service()
            if ollama and ollama.is_available():
                logger.info("[interface_agent] Engine not loaded — using Ollama fallback")
                reply = await ollama.stream_chat(
                    messages=list(messages_for_model),
                    emit_fn=_emit,
                    msg_id=msg_id,
                    temperature=0.4,
                )
                return (reply or "", False)
        except Exception as exc:
            logger.warning("[interface_agent] Ollama fallback failed: %s", exc)
        logger.warning("[interface_agent] No model available — falling back to stub")
        return (await _generate_stub_response(user_message, msg_id, tts_emitter=_tts_emitter), False)

    messages = list(messages_for_model)
    tools_were_used = False
    display_tool_called = False

    for round_num in range(_MAX_TOOL_ROUNDS + 1):
        _tokens = _FAST_MAX_TOKENS if (round_num == 0 and _is_simple_query(user_message)) else _GEN_MAX_TOKENS
        full_text, _stream_clean, _already_emitted = await _stream_generate_with_thinking(
            engine, messages, _tokens, 0.4, msg_id, tts_emitter=tts_emitter
        )

        # Guard: model crashed or returned nothing (e.g. access violation in llama.cpp)
        if not full_text.strip():
            from app.controller.chat_controller import _emit
            logger.warning("[interface_agent] Empty response from engine — emitting fallback error")
            fallback = "I ran into a problem generating a response. Please try again."
            await _emit("token", {"text": fallback, "messageId": msg_id})
            if tts_emitter:
                await tts_emitter.feed(fallback)
            return (fallback, False)

        result = {"text": full_text, "tokens_used": 0, "latency_ms": 0}
        text = full_text

        tool_calls = _extract_tool_calls(text)

        # ── Tool-intent detection: model says "I'll search for X" instead of JSON ──
        if not tool_calls and round_num < _MAX_TOOL_ROUNDS:
            intent = _detect_tool_intent(text)
            if intent:
                tool_name = intent.pop("tool")
                logger.info("[interface_agent] Converting tool intent to actual call: %s %s", tool_name, intent)
                await _emit("agent_update", {
                    "node": "interface_agent",
                    "status": "running",
                    "detail": f"Using tool: {tool_name}",
                })
                tool_result = await _dispatch_tool(tool_name, intent)
                if tool_result and "not available" not in tool_result.lower():
                    tools_were_used = True
                    if tool_name == "display":
                        display_tool_called = True
                    if len(tool_result) > _MAX_TOOL_RESULT_CHARS:
                        tool_result = tool_result[:_MAX_TOOL_RESULT_CHARS] + "\n...[truncated]"
                    messages.append({"role": "assistant", "content": f"Let me look that up."})
                    messages.append({
                        "role": "user",
                        "content": f"Tool results:\n\n[{tool_name} result]\n{tool_result}\n\nAnswer the original question using ONLY these results. Be direct and specific — state the numbers. Do not say you lack real-time access. Keep thinking brief.",
                    })
                    continue  # Re-generate with tool results

        if not tool_calls or round_num == _MAX_TOOL_ROUNDS:
            # Final response — strip any leftover tool JSON, stream tokens
            clean_text = re.sub(
                r'^\s*\{[^\n]*"tool"[^\n]*\}\s*$', "", text, flags=re.MULTILINE
            ).strip()
            if not clean_text:
                clean_text = text.strip()

            # Extract <think> blocks — skip if already handled during streaming
            if _already_emitted:
                clean_text = _stream_clean
            else:
                clean_text = await _split_thinking(clean_text, _emit)

            # ── Check if model refused to use tools when it should have ──
            # If round 0 (no tools tried) and response contains refusal phrases,
            # force a web_search before escalating to workhorse.
            lower_resp = clean_text.lower()
            has_failure = any(ind in lower_resp for ind in _FAILURE_INDICATORS)

            if has_failure and not tools_were_used and round_num == 0:
                # Model refused to use tools — ask via grammar-constrained call
                logger.info("[interface_agent] Model refused tools — trying grammar-constrained tool select")
                tool_decision = await _grammar_tool_select(engine, user_message)
                tool_to_use = (tool_decision or {}).get("tool", "web_search")
                tool_args = {}
                if tool_to_use in ("web_search", "image_search", "news_search"):
                    tool_args = {"query": (tool_decision or {}).get("query", user_message)}
                elif tool_to_use == "finance_quote":
                    tool_args = {"ticker": (tool_decision or {}).get("ticker", "")}
                elif tool_to_use in ("list_dir", "read_file", "open_file"):
                    path_val = (tool_decision or {}).get("path", "")
                    # Fallback: extract a file/dir path from the user message if grammar didn't capture one
                    if not path_val:
                        import re as _re
                        _path_match = _re.search(r'([A-Za-z]:[\\\/][^\s,;]+)', user_message)
                        if not _path_match:
                            _path_match = _re.search(r'((?:\/|~\/)[^\s,;]+)', user_message)
                        if _path_match:
                            path_val = _path_match.group(1)
                    tool_args = {"path": path_val}
                elif tool_to_use == "bash_exec":
                    tool_args = {"command": (tool_decision or {}).get("command", "")}
                elif tool_to_use == "snip":
                    tool_args = {"code": (tool_decision or {}).get("code", "")}
                elif tool_to_use == "git":
                    tool_args = {"operation": (tool_decision or {}).get("operation", "status")}
                elif tool_to_use in ("browse", "web_scrape"):
                    url_val = (tool_decision or {}).get("url", "")
                    if not url_val:
                        import re as _re
                        _url_match = _re.search(r'(https?://\S+)', user_message)
                        if _url_match:
                            url_val = _url_match.group(1)
                    tool_args = {"url": url_val}
                elif tool_to_use in ("weather", "market_overview", "news", "calendar", "email",
                                     "system_status", "screen_capture", "browser_view"):
                    tool_args = {}
                else:
                    # Generic fallback — pass all non-meta fields from grammar output
                    tool_args = {k: v for k, v in (tool_decision or {}).items() if k not in ("use_tool", "tool")}

                logger.info("[interface_agent] Grammar tool select → %s %s", tool_to_use, tool_args)
                await _emit("agent_update", {
                    "node": "interface_agent",
                    "status": "running",
                    "detail": f"Using tool: {tool_to_use}",
                })
                forced_result_text = await _dispatch_tool(tool_to_use, tool_args)
                has_useful_result = bool(forced_result_text and "not available" not in forced_result_text.lower())
                if has_useful_result:
                    tools_were_used = True
                    tool_output = forced_result_text
                    if len(tool_output) > _MAX_TOOL_RESULT_CHARS:
                        tool_output = tool_output[:_MAX_TOOL_RESULT_CHARS] + "\n...[truncated]"
                    # Re-prompt with tool results
                    messages.append({"role": "assistant", "content": f"Let me check that with {tool_to_use}."})
                    messages.append({
                        "role": "user",
                        "content": f"Tool results:\n\n[{tool_to_use} result]\n{tool_output}\n\nAnswer the original question using ONLY these results. Be direct and specific — state the numbers. Do not say you lack real-time access. Keep thinking brief.",
                    })
                    # Generate again with search results (buffered; emit below)
                    result2 = await engine.generate(messages, max_tokens=_GEN_MAX_TOKENS, temperature=0.4)
                    clean_text = result2.get("text", "").strip()
                    clean_text = re.sub(r'^\s*\{[^\n]*"tool"[^\n]*\}\s*$', "", clean_text, flags=re.MULTILINE).strip()
                    clean_text = await _split_thinking(clean_text, _emit)
                    _already_emitted = False  # result2 was buffered; emit tokens below

            # Team escalation is pre-flight only (via is_team_task() before generation).
            # If tools returned thin results, the model answers from what it has.
            # Never escalate from inside the generation loop.

            if not _already_emitted:
                chunks = re.split(r'(?<=[.!?])\s+', clean_text)
                for i, chunk in enumerate(chunks):
                    token = chunk if i == 0 else f" {chunk}"
                    await _emit("token", {"text": token, "messageId": msg_id})
                    if tts_emitter:
                        await tts_emitter.feed(token)

            logger.debug(
                "[interface_agent] Generated %d tokens in %.0fms (round %d, tools_used=%s)",
                result.get("tokens_used", 0),
                result.get("latency_ms", 0),
                round_num,
                tools_were_used,
            )
            return (clean_text, display_tool_called)

        # Execute tool calls and append results
        tools_were_used = True
        tool_results_text = []
        for call_info in tool_calls:
            call = call_info["json"]
            # Safety: unwrap "args" wrapper if not already handled by _extract_tool_calls
            if "args" in call and isinstance(call["args"], dict):
                call.update(call.pop("args"))
            tool_name = call.pop("tool")
            await _emit("agent_update", {
                "node": "interface_agent",
                "status": "running",
                "detail": f"Using tool: {tool_name}",
            })
            tool_result = await _dispatch_tool(tool_name, call)
            if tool_name == "display":
                display_tool_called = True
            # Hard cap — prevents context window overflow
            if len(tool_result) > _MAX_TOOL_RESULT_CHARS:
                tool_result = tool_result[:_MAX_TOOL_RESULT_CHARS] + "\n...[truncated]"
            tool_results_text.append(f"[{tool_name} result]\n{tool_result}")

        # Append model output + tool results — strip thinking to save context,
        # must use "user" role to keep strict alternation that llama.cpp requires.
        assistant_text = re.sub(r'^.*?</think>\s*', '', text, count=1, flags=re.DOTALL) if '</think>' in text else text
        assistant_text = re.sub(r'^\s*\{[^\n]*"tool"[^\n]*\}\s*$', '', assistant_text, flags=re.MULTILINE).strip()
        messages.append({"role": "assistant", "content": assistant_text or "I'll search for that."})
        messages.append({
            "role": "user",
            "content": "Tool results:\n\n" + "\n\n".join(tool_results_text) + "\n\nAnswer the original question using ONLY these results. Be direct and specific — state the numbers. Keep thinking brief.",
        })

    # Should not reach here, but return last text just in case
    return (text, display_tool_called)


# ─────────────────────────────────────────────────────────────────────────────
# AUTO-CANVAS POST-PROCESSOR
# ─────────────────────────────────────────────────────────────────────────────

async def _auto_canvas(response_text: str) -> None:
    """
    Post-process a completed response and push structured content to canvas.
    Runs only when the display tool was not explicitly called this turn.
    """
    import re
    from app.controller.chat_controller import _emit

    blocks = []

    # Strip bare tool-call JSON lines that may have leaked through streaming
    response_text = re.sub(
        r'^\s*\{[^\n]*"tool"[^\n]*\}\s*$', '', response_text, flags=re.MULTILINE
    ).strip()
    if not response_text:
        return

    # 1. Fenced code blocks: ```language\ncode\n```
    #    If the code block contains an <iframe>, convert to live html block instead.
    _iframe_src_re = re.compile(r'<iframe[^>]+src=["\']([^"\']+)["\']', re.IGNORECASE)
    code_pattern = re.compile(r'```(\w+)?\n(.*?)```', re.DOTALL)
    for match in code_pattern.finditer(response_text):
        lang = match.group(1) or 'text'
        code = match.group(2).strip()
        if len(code) > 20:  # skip trivial snippets
            # Skip tool-call JSON that leaked into the response (already executed by pipeline)
            if '"tool"' in code and code.lstrip().startswith('{'):
                continue
            iframe_match = _iframe_src_re.search(code)
            if iframe_match:
                iframe_src = iframe_match.group(1)
                # Auto-convert YouTube watch URLs to embed URLs
                yt_m = re.match(r'https?://(?:www\.)?youtube\.com/watch\?v=([A-Za-z0-9_-]+)', iframe_src)
                if yt_m:
                    iframe_src = f"https://www.youtube.com/embed/{yt_m.group(1)}"
                blocks.append({"type": "html", "data": {"src": iframe_src, "title": "Embedded video"}})
            else:
                blocks.append({"type": "code", "data": {"code": code, "language": lang}})

    # 2. Markdown tables — only auto-canvas large tables (10+ data rows).
    #    Small tables belong in chat via markdown rendering.
    table_lines = [l for l in response_text.splitlines() if l.strip().startswith('|')]
    if len(table_lines) >= 12:  # header + separator + 10+ data rows
        headers = [h.strip() for h in table_lines[0].split('|') if h.strip()]
        rows = []
        for line in table_lines[2:]:  # skip separator line
            row = [c.strip() for c in line.split('|') if c.strip()]
            if row:
                rows.append(row)
        if headers and rows:
            blocks.append({"type": "table", "data": {"headers": headers, "rows": rows}})

    # 3. Bullet/numbered lists — only auto-canvas very long lists (10+ items).
    #    Short lists belong in chat.
    list_pattern = re.compile(r'^(\s*[-*•]|\s*\d+\.)\s+(.+)', re.MULTILINE)
    list_items = list_pattern.findall(response_text)
    if len(list_items) >= 10:
        items = [item[1].strip() for item in list_items]
        blocks.append({"type": "list", "data": {"items": items}})

    # 4. Long responses (>800 words) with no other blocks → document block.
    #    Raised threshold: most factual answers should stay in chat.
    word_count = len(response_text.split())
    if word_count > 800 and not blocks:
        heading_match = re.search(r'^#+\s+(.+)', response_text, re.MULTILINE)
        title = heading_match.group(1) if heading_match else "Response"
        blocks.append({"type": "document", "data": {"title": title, "content": response_text}})

    # 5. Headings — removed from auto-canvas. Headings in chat are rendered
    #    by markdown and don't need canvas blocks.

    if blocks:
        await _emit("render_canvas", {"blocks": blocks, "title": "Response", "auto": True})


# ─────────────────────────────────────────────────────────────────────────────
# TEAM DISPATCH ACKNOWLEDGMENT HELPER
# ─────────────────────────────────────────────────────────────────────────────

async def _generate_team_ack(task: str, team_id: str, queue_pos: int, engine) -> str:
    """
    Return AURA's acknowledgment when a team task is dispatched.
    Uses canned strings to avoid model generation leaking raw reasoning/thinking output.
    queue_pos=0 means starting now; >0 means queued at that position.
    """
    if queue_pos > 0:
        return (
            f"On it — queued at position {queue_pos}. "
            "The team will pick it up right after the current run. I'll deliver when ready."
        )
    return "On it. Team dispatched — I'll bring you the result the moment it's ready."


# ─────────────────────────────────────────────────────────────────────────────
# INTERFACE AGENT NODE
# ─────────────────────────────────────────────────────────────────────────────

async def run_interface_agent(state: GraphState) -> dict:
    """
    Interface Agent: Path A/B routing + response generation.

    Two modes:
      SOLO (path A):        Handles request directly with tools + memory.
      TEAM DISPATCH (path B): Routes to project_manager for multi-agent pipeline.
      TEAM RETURN:          Receives verified team output, formats with AURA
                            personality, emits render_canvas + tokens → END.
    """
    from app.controller.chat_controller import _emit
    from app.config import get_settings
    from app.service.streaming_tts_service import StreamingTTSEmitter

    settings = get_settings()
    user_message = state.get("user_message", "")
    thread_id = state.get("thread_id", "default")
    team_enabled = state.get("team_enabled", False)
    execution_id = state.get("execution_id", str(uuid.uuid4()))
    msg_id = f"msg-{execution_id}"

    # Streaming TTS: synthesize sentences as tokens stream, not after full response
    _tts_emitter = StreamingTTSEmitter(
        emit_fn=_emit,
        enabled=state.get("voice_enabled", False),
    )

    logger.info("[interface_agent] thread=%s msg=%.60s", thread_id, user_message)

    # ── Brainstorm mode detection — syntax-triggered thought-partner personas ──
    from app.controller.chat_controller import _runtime_state as _rs_early
    _detected_mode = detect_brainstorm_mode(user_message)
    if _detected_mode:
        _rs_early["brainstorm_mode"] = _detected_mode
        _rs_early["brainstorm_turn_count"] = 0
        logger.info("[interface_agent] Brainstorm mode activated: %s", _detected_mode)
    elif _rs_early.get("brainstorm_mode"):
        # Increment idle counter; auto-clear after 3 non-trigger turns
        _rs_early["brainstorm_turn_count"] = _rs_early.get("brainstorm_turn_count", 0) + 1
        _current_mode = _rs_early.get("brainstorm_mode")
        _current_count = _rs_early["brainstorm_turn_count"]

        # Sequential scope graduation: after 4+ scoping turns, synthesize task and offer team
        if _current_mode == "sequential_scope" and _current_count >= 4:
            logger.info("[interface_agent] Sequential scope graduated after %d turns — offering team dispatch", _current_count)
            _rs_early["_scope_graduating"] = True  # Signal for system prompt injection below
            # Don't clear mode yet — let the graduation prompt fire first this turn
        elif _current_count > 3:
            _rs_early["brainstorm_mode"] = None
            _rs_early["brainstorm_turn_count"] = 0
            logger.info("[interface_agent] Brainstorm mode auto-cleared after idle turns")

    # ── PENDING TEAM CONTEXT: user is replying to clarification questions ────
    # If we previously asked questions about a team task, check if the user's
    # follow-up completes the request enough to dispatch.
    from app.controller.chat_controller import _runtime_state
    pending_ctx = _runtime_state.get("pending_team_context")
    _force_team_dispatch = False

    if pending_ctx and team_enabled:
        # Check for cancellation FIRST — user may have said "never mind" or
        # clarified they didn't actually need a deliverable.
        _CANCEL_SIGNALS = [
            "never mind", "nevermind", "forget it", "cancel", "stop",
            "don't need", "dont need", "didn't need", "didnt need",
            "no need", "not needed", "not necessary", "no longer",
            "figure of speech", "just kidding", "just checking",
            "not serious", "i was joking", "i'm joking",
            "i don't want", "i dont want", "we don't need", "we dont need",
            "we didn't need", "we didnt need", "nope", "no thanks",
            "disregard", "scratch that", "ignore that",
        ]
        # Explicit confirmation signals — user says yes, dispatch the original request
        _CONFIRM_SIGNALS = [
            "yes", "yeah", "yep", "sure", "go ahead", "do it", "proceed",
            "sounds good", "let's do it", "let's go", "start it", "kick it off",
            "send it", "run it", "confirmed", "do that", "go for it",
            "make it happen", "fire it up", "yup", "ok", "okay", "alright",
            "affirmative", "absolutely", "definitely",
        ]
        msg_lower = user_message.lower()
        if any(sig in msg_lower for sig in _CANCEL_SIGNALS):
            # User cancelled — clear context and fall through to normal solo chat
            _runtime_state["pending_team_context"] = None
            _runtime_state["pending_team_confirmed"] = False
            logger.info("[interface_agent] Pending team context cancelled by user — clearing")
        elif (
            # Starts with confirm signal → allow up to 20 words (natural confirmation + detail)
            (any(msg_lower.startswith(sig) for sig in _CONFIRM_SIGNALS) and len(user_message.split()) <= 20)
            # Contains confirm signal in a short message → allow up to 12 words
            or (any(sig in msg_lower for sig in _CONFIRM_SIGNALS) and len(user_message.split()) <= 12)
        ):
            # User explicitly confirmed — dispatch the stored request
            _force_team_dispatch = True
            _runtime_state["pending_team_confirmed"] = False
            user_message_for_team = pending_ctx
            logger.info("[interface_agent] User confirmed team dispatch — dispatching stored request")
        elif _is_greeting(msg_lower) and not any(sig in msg_lower for sig in _CONFIRM_SIGNALS):
            # Pure greeting/pleasantry — do NOT treat as clarification answer.
            # Clear pending context so AURA responds conversationally.
            _runtime_state["pending_team_context"] = None
            _runtime_state["pending_team_confirmed"] = False
            logger.info("[interface_agent] Greeting detected while pending team context active — clearing context")
        else:
            # Combine the original request with the user's follow-up (clarification answer)
            combined = f"{pending_ctx}\n\nUser clarification: {user_message}"
            if not is_underspecified(combined):
                # Enriched enough — update stored context, prompt AURA to confirm with user
                _runtime_state["pending_team_context"] = combined
                logger.info("[interface_agent] Pending team context enriched — waiting for user confirmation")
                # Fall through to solo path; AURA will summarize and ask for confirmation
            else:
                # Still underspecified — let it fall through to solo so AURA keeps asking
                logger.info("[interface_agent] Pending team context still underspecified — continuing conversation")

    # ── TEAM ROUTING ─────────────────────────────────────────────────────────
    # If we're already in the conversational gate (pending context exists and
    # not force-dispatching), don't re-classify — the current message is a
    # clarification or confirmation, not a new team request.  Re-classifying
    # here would cause is_team_task() to match the clarification text, re-enter
    # the gate at line 2903, and overwrite the accumulated scoping context.
    if pending_ctx and not _force_team_dispatch:
        _is_team = False  # stay on solo path; gate prompt injection handles flow
    else:
        _is_team = _force_team_dispatch or is_team_task(user_message)
    # Citation verification always dispatches to team — gate does not apply.
    _citation_task = is_citation_task(user_message)
    if _citation_task:
        _is_team = True

    if _is_team and not team_enabled and not _force_team_dispatch and not _citation_task:
        # Team gate closed — inform user
        try:
            from app.service.hardware_gate import is_team_available
            hardware_limited = not is_team_available()
        except Exception:
            hardware_limited = False

        if hardware_limited:
            await _emit("team_gate_prompt", {
                "message": (
                    "The team pipeline requires a GPU with at least 20 GB VRAM. "
                    "I can handle this solo, or queue it to run automatically "
                    "when the full hardware is online."
                ),
                "hardware_limited": True,
                "queue_available":  True,
                "task_text":        user_message,
                "thread_id":        thread_id,
            })
        else:
            _solo_secs, _solo_tier = estimate_solo_time(user_message)
            _solo_time_str = f"~{_solo_secs // 60} min" if _solo_secs >= 60 else f"~{_solo_secs}s"
            await _emit("team_gate_prompt", {
                "message": (
                    f"I can handle this solo ({_solo_time_str} — I'll be occupied during that time). "
                    "Enable Team Functions in Settings → General to let the team run it in the background "
                    "while I stay available to you."
                ),
                "hardware_limited": False,
                "queue_available":  False,
                "estimated_solo_time": _solo_secs,
            })
        logger.info("[interface_agent] Team task — gate closed (hw_limited=%s) — routing solo", hardware_limited)

    elif _is_team and (team_enabled or _force_team_dispatch or _citation_task):
        # Team gate open
        dispatch_message = user_message_for_team if _force_team_dispatch else user_message

        if _force_team_dispatch:
            # User already confirmed via the pending_team_context flow — dispatch now
            logger.info("[interface_agent] Team task confirmed — dispatching to TeamDispatcher")
            _runtime_state["pending_team_context"] = None
            team_id = f"team-{uuid.uuid4().hex[:8]}"

            from app.service.team_dispatcher import get_team_dispatcher
            dispatcher = get_team_dispatcher()
            try:
                queue_pos = await dispatcher.dispatch(dispatch_message, thread_id, team_id)
            except Exception as _dispatch_err:
                logger.error("[interface_agent] Team dispatch failed: %s", _dispatch_err)
                _runtime_state["pending_team_context"] = None
                _err_msg = "I tried to dispatch the team but hit a connection error. Please try again."
                await _emit("token", {"text": _err_msg, "messageId": msg_id})
                await _tts_emitter.feed(_err_msg)
                await _tts_emitter.flush()
                await _emit("end", {"reason": "error"})
                history = list(state.get("conversation_history", []))
                _now = datetime.now(timezone.utc).isoformat()
                history.append({"role": "user", "content": user_message, "timestamp": _now})
                history.append({"role": "aura", "content": _err_msg,     "timestamp": _now})
                return {"path": "solo", "final_response": _err_msg, "conversation_history": history}

            # Emit team_dispatched so AgentMonitor initialises (PM will replace with full roster)
            await _emit("team_dispatched", {
                "plan": {
                    "agents": [],
                    "task":   dispatch_message,
                    "teamId": team_id,
                }
            })

            ack = await _generate_team_ack(dispatch_message, team_id, queue_pos, None)

            # Stream the ack tokens and close this chat turn
            _ack_chunks = re.split(r'(?<=[.!?])\s+', ack)
            for _i, _chunk in enumerate(_ack_chunks):
                _token = _chunk if _i == 0 else f" {_chunk}"
                await _emit("token", {"text": _token, "messageId": msg_id})
                await _tts_emitter.feed(_token)
            await _tts_emitter.flush()
            await _emit("end", {"reason": "completed"})

            history = list(state.get("conversation_history", []))
            _now = datetime.now(timezone.utc).isoformat()
            history.append({"role": "user",  "content": user_message, "timestamp": _now})
            history.append({"role": "aura",  "content": ack,          "timestamp": _now})
            asyncio.create_task(_record_exchange(thread_id, user_message, ack))

            return {
                "path":                 "solo",
                "final_response":       ack,
                "conversation_history": history,
            }

        else:
            # Team task detected but NOT yet confirmed — always enter conversational gate first.
            # AURA will scope the request and ask for explicit confirmation before any dispatch.
            # Include recent conversation context so the Planner has full background when dispatched.
            _gate_history = list(state.get("conversation_history", []))[-6:]
            _gate_ctx_block = ""
            if _gate_history:
                _gate_ctx_block = "\n\n[CONVERSATION CONTEXT — for Planner use]\n"
                for _gt in _gate_history:
                    _gt_role = "User" if _gt.get("role") == "user" else "AURA"
                    _gate_ctx_block += f"{_gt_role}: {_gt.get('content', '')[:400]}\n"
            _runtime_state["pending_team_context"] = user_message + _gate_ctx_block
            _runtime_state["pending_team_confirmed"] = False
            # Store time estimate so the CONVERSATIONAL GATE prompt can mention it
            _gate_solo_secs, _gate_solo_tier = estimate_solo_time(user_message)
            _runtime_state["pending_team_solo_estimate"] = (_gate_solo_secs, _gate_solo_tier)
            logger.info(
                "[interface_agent] Team task detected — entering conversational gate "
                "(tier=%s, solo=%ds, ctx_turns=%d, no dispatch yet)",
                _gate_solo_tier, _gate_solo_secs, len(_gate_history),
            )
            # Fall through to solo path; CONVERSATIONAL GATE prompt injection guides AURA

    # ── Solo path — memory-first context building ───────────────────────────
    history = list(state.get("conversation_history", []))

    # Query memory layers for relevant context
    memory_context_str = ""
    l1_sliding_window = []
    _is_greeting_msg = _is_greeting(user_message)
    try:
        from app.service.memory_service import get_memory_service
        mem_svc = get_memory_service()
        if mem_svc is not None:
            if _is_greeting_msg:
                # Lightweight path: only L1 sliding window, skip L2/L3/LightRAG
                try:
                    l1_sliding_window = mem_svc._get_sliding_window(thread_id, limit=20)
                    if not l1_sliding_window:
                        l1_sliding_window = mem_svc._get_recent_turns_all_threads(limit=20)
                    logger.info("[interface_agent] Greeting detected — lightweight memory path (L1 only)")
                except Exception as exc:
                    logger.warning("[interface_agent] Greeting L1 fetch failed: %s", exc)
            else:
                # Full context build for substantive messages
                # Pass the engine's actual context window so memory budgets
                # scale down automatically for smaller/constrained models.
                try:
                    from app.service.interface_engine import get_engine as _get_mem_engine
                    _mem_engine = _get_mem_engine()
                    _ctx_size = getattr(getattr(_mem_engine, "_cfg", None), "context_size", 32768) or 32768
                except Exception:
                    _ctx_size = 32768
                context = await mem_svc.build_context(
                    role="interface",
                    task=user_message,
                    thread_id=thread_id,
                    context_size=_ctx_size,
                )
                memory_context_str = _format_memory_context(context)
                l1_sliding_window = context.get("sliding_window", [])
                if memory_context_str:
                    logger.info(
                        "[interface_agent] Memory context: ~%d tokens from L2/L3",
                        context.get("token_estimate", 0),
                    )
    except Exception as exc:
        logger.warning("[interface_agent] Memory context build failed: %s", exc)

    # Use in-memory history if available; fall back to L1 SQLite for cross-session persistence
    if history:
        window = history[-10:]
        logger.info("[interface_agent] Using %d turns from graph state history", len(window))
    elif l1_sliding_window:
        # New session but past conversations exist in L1 — restore them
        window = l1_sliding_window[-10:]
        logger.info("[interface_agent] Restored %d turns from L1 sliding window (thread=%s)", len(window), thread_id[:12])
    else:
        window = []
        logger.info("[interface_agent] No conversation history available (thread=%s)", thread_id[:12])

    # ── Data-first fast path — skip model round-trip for all data retrieval queries ──
    # Covers: legislation, news, finance, weather, calendar, memory, system status.
    # Returns in ~50-200ms vs 30-60s through the model tool-call cycle.
    try:
        from app.graph.nodes.fast_path import detect_fast_path
        _fp_result = detect_fast_path(user_message)
    except Exception as _fp_err:
        logger.warning("[interface_agent] fast_path import failed: %s", _fp_err)
        _fp_result = None

    if _fp_result is not None:
        _fp_handler, _fp_params, _fp_source = _fp_result
        logger.info("[interface_agent] Fast path: %s", _fp_source)
        response_text = await _fp_handler(_fp_params, msg_id)
        try:
            from app.service.memory_service import get_memory_service as _gmem
            _ms = _gmem()
            if _ms:
                await _ms.record(
                    role="interface",
                    content=response_text,
                    thread_id=thread_id,
                    metadata={
                        "task": user_message,
                        "messages": [
                            {"role": "user", "content": user_message},
                            {"role": "assistant", "content": response_text},
                        ],
                    },
                )
        except Exception:
            pass
        return {**state, "response": response_text, "conversation_history": history + [
            {"role": "user", "content": user_message},
            {"role": "assistant", "content": response_text},
        ]}

    # ── Pre-fetch: parallel local DB + web query before model runs ──────────
    # Stores full results in _SESSION_CACHE; only coordinate labels enter context.
    # Model expands on demand via {"tool": "expand", "key": "..."}.
    _coord_index: dict[str, str] = {}
    _graph_context: str = ""
    try:
        from app.service.graph_router_service import get_relevant_context as _graph_route
        _coord_index, _graph_context = await asyncio.gather(
            _prefetch_to_cache(user_message),
            _graph_route(user_message),
            return_exceptions=True,
        )
        if isinstance(_coord_index, Exception):
            logger.warning("[interface_agent] pre-fetch failed: %s", _coord_index)
            _coord_index = {}
        if isinstance(_graph_context, Exception):
            _graph_context = ""
    except Exception as _pf_err:
        logger.warning("[interface_agent] pre-fetch failed: %s", _pf_err)
        try:
            _coord_index = await _prefetch_to_cache(user_message)
        except Exception:
            _coord_index = {}

    # ── Clarification gate: empty index + ambiguous query → ask one question ─
    _clarify_q = _needs_clarification(_coord_index, user_message, window)
    if _clarify_q:
        logger.info("[interface_agent] Clarification gate fired: %r", _clarify_q)
        await _emit("token", {"text": _clarify_q, "messageId": msg_id})
        await _tts_emitter.feed(_clarify_q)
        await _tts_emitter.flush()
        await _emit("end", {"reason": "clarification"})
        _now_c = datetime.now(timezone.utc).isoformat()
        history.append({"role": "user",  "content": user_message,  "timestamp": _now_c})
        history.append({"role": "aura",  "content": _clarify_q,    "timestamp": _now_c})
        asyncio.create_task(_record_exchange(thread_id, user_message, _clarify_q))
        return {**state, "response": _clarify_q, "conversation_history": history}

    knowledge_context = ""  # no longer pre-loading knowledge into context directly

    # Emit standby files to canvas before model runs — files appear on screen
    # while AURA is thinking, zero prompt cost beyond the manifest line already added.
    try:
        _standby_files = context.get("standby_files", [])  # type: ignore[union-attr]
    except Exception:
        _standby_files = []
    if _standby_files:
        try:
            from app.controller.chat_controller import _emit as _file_emit
            cards = []
            for f in _standby_files[:10]:
                cards.append({
                    "title":   f.get("name", ""),
                    "source":  f.get("source", "local"),
                    "date":    f.get("modified", ""),
                    "summary": f"{f.get('type','').upper()} — {f.get('size_kb', 0):.0f} KB",
                    "url":     f.get("path", ""),
                })
            await _file_emit("render_canvas", {
                "title": "Related Files",
                "blocks": [{"type": "card-list", "data": {"cards": cards}}],
            })
        except Exception:
            pass

    # Fetch user profile for prompt injection (fast — SQLite read only)
    _profile_str = ""
    try:
        from app.service.user_profile_service import get_user_profile_service
        _prof_svc = get_user_profile_service()
        if _prof_svc is not None:
            _profile_str = _prof_svc.format_for_prompt()
    except Exception:
        pass

    # Build message list: system prompt (with memory + conversation summary) + conversation window + current message
    sys_prompt = _build_system_prompt(memory_context_str, window, knowledge_context, _profile_str, coord_index=_coord_index)

    # Inject graph-routed context (Phase 6) — compact tool/skill pre-selection from Neo4j
    if _graph_context:
        sys_prompt += f"\n{_graph_context}"

    # Inject active todos into system prompt if any exist
    try:
        from app.service.todo_service import get_todo_service as _get_todo_svc
        _todo_svc = _get_todo_svc()
        if _todo_svc is not None:
            _todo_block = _todo_svc.active_context_block()
            if _todo_block:
                sys_prompt += f"\n\n{_todo_block}\n"
    except Exception:
        pass

    # For simple conversational queries, discourage lengthy internal reasoning
    if _is_simple_query(user_message):
        sys_prompt += (
            "\n\nThis is a simple conversational query. "
            "Keep your internal reasoning under 2 sentences and answer directly."
        )

    # Conversational gate: team task detected — scope before dispatching
    pending_ctx = _runtime_state.get("pending_team_context")
    if pending_ctx:
        _est = _runtime_state.get("pending_team_solo_estimate")
        _est_note = ""
        if _est:
            _secs, _tier = _est
            if _tier == "long":
                _est_note = (
                    f" Note: solo this would take ~{_secs // 60} min and I'd be tied up. "
                    f"The team runs in the background so I stay available to you."
                )
            elif _tier == "moderate":
                _est_note = (
                    f" Note: solo I'm looking at ~{_secs // 60} min for this — "
                    f"or the team can take it while I stay free."
                )
        # Show only the user's request in the quoted line; full context follows as context block
        _gate_display = pending_ctx.split("\n\n[CONVERSATION CONTEXT")[0].strip()
        _gate_full_ctx = pending_ctx  # full text (including context block) passed as background
        sys_prompt += (
            f"\nCONVERSATIONAL GATE: The user wants a team deliverable: \"{_gate_display}\"{_est_note}\n"
            f"Background context:\n{_gate_full_ctx}\n"
            f"Ask ONE scoping question. Once answered, do NOT ask more — summarize in one sentence "
            f"what the team will produce and ask: 'Want me to kick that off?'\n"
            f"If the user says yes/sure/ok/go/do it/sounds good/correct/send it or any affirmative — dispatch immediately.\n"
            f"Do NOT repeat the same question. Do NOT give a long explanation. Scope once, confirm once.\n"
        )

    # ── Proactive maturity offer — check if conversation is ready for team dispatch ──
    # Only fire when no pending context already exists (avoid double-prompting)
    if not pending_ctx and team_enabled:
        _active_bm   = _runtime_state.get("brainstorm_mode")
        _active_tc   = _runtime_state.get("brainstorm_turn_count", 0)
        _graduating  = _runtime_state.pop("_scope_graduating", False)

        from app.utils.routing import assess_brainstorm_maturity
        _maturity = assess_brainstorm_maturity(
            window=window,
            brainstorm_mode=_active_bm,
            brainstorm_turn_count=_active_tc,
            user_message=user_message,
        )
        if _maturity:
            _suggested = _maturity["suggested_deliverable"]
            if _graduating:
                # Sequential scope graduation — be explicit about the completed scope
                sys_prompt += (
                    f"\nSCOPE GRADUATION: The scoping session is complete. "
                    f"Summarize in 2-3 sentences what was defined, then ask the user "
                    f"if they want the team to build it. "
                    f"If you make the offer, include exactly "
                    f"[TEAM_OFFER: <one-line description of what the team will produce>] "
                    f"at the very END of your response text — this marker is stripped before display.\n"
                )
                # Clear the graduated mode now that we're prompting for dispatch
                _runtime_state["brainstorm_mode"] = None
                _runtime_state["brainstorm_turn_count"] = 0
                logger.info("[interface_agent] Sequential scope graduation prompt injected")
            else:
                # General maturity — offer naturally if the moment feels right
                sys_prompt += (
                    f"\nPROACTIVE TEAM OFFER: This conversation has built enough material "
                    f"for a team deliverable. If the moment feels natural — especially if the "
                    f"user seems to be wrapping up or asking 'what next' — offer to dispatch "
                    f"the team. Suggested deliverable: {_suggested!r}. "
                    f"Keep the offer casual and brief (1 sentence). Don't force it if the "
                    f"conversation is still mid-flow. "
                    f"If you make the offer, include exactly "
                    f"[TEAM_OFFER: <one-line description of what the team will produce>] "
                    f"at the very END of your response text — this marker is stripped before display.\n"
                )
                logger.info("[interface_agent] Proactive team offer prompt injected (suggested: %s)", _suggested[:60])

    # Brainstorm mode prompt injection
    _active_mode = _runtime_state.get("brainstorm_mode")
    if _active_mode and _active_mode in _BRAINSTORM_MODE_PROMPTS:
        sys_prompt += _BRAINSTORM_MODE_PROMPTS[_active_mode]

    # Operating mode prompt injection
    _op_mode = _runtime_state.get("operating_mode", "proactive")
    if _op_mode in _OPERATING_MODE_PROMPTS:
        sys_prompt += _OPERATING_MODE_PROMPTS[_op_mode]

    # Active window context — inject what the user is currently working on
    try:
        from app.service.screen_awareness_service import get_current_context
        _win_ctx = get_current_context()
        _win_ctx_str = _win_ctx.context_for_prompt() if _win_ctx else ""
        if _win_ctx_str:
            sys_prompt += f"\n\n[CURRENT TASK CONTEXT]\n{_win_ctx_str}"
    except Exception:
        pass

    messages_for_model: list[dict] = [
        {"role": "system", "content": sys_prompt}
    ]

    logger.info(
        "[interface_agent] System prompt: %d chars, memory_ctx=%d chars, window=%d turns",
        len(sys_prompt), len(memory_context_str), len(window),
    )

    for h in window:
        role = h.get("role", "user")
        # Normalize role names: 'aura'/'assistant' → 'assistant' for model
        if role in ("aura", "assistant"):
            role = "assistant"
        elif role != "user":
            role = "user"
        messages_for_model.append({"role": role, "content": h.get("content", "")})
    messages_for_model.append({"role": "user", "content": user_message})

    # Context window guard — condense if approaching 75% of context limit
    pre_condense_count = len(messages_for_model)
    orig_messages = list(messages_for_model) if pre_condense_count > 7 else None
    messages_for_model = _condense_messages(messages_for_model)
    if orig_messages and len(messages_for_model) < pre_condense_count:
        asyncio.create_task(_persist_condensation_summary(orig_messages, thread_id))

    display_called = False
    if settings.dev_stub_responses:
        response_text = await _generate_stub_response(user_message, msg_id, tts_emitter=_tts_emitter)
    else:
        # Emit processing indicator for complex queries before first token arrives
        if not _is_simple_query(user_message):
            await _emit("agent_update", {
                "node": "interface_agent",
                "status": "running",
                "detail": "Thinking...",
            })
        try:
            response_text, display_called = await _generate_live_response(
                user_message, msg_id, messages_for_model, tts_emitter=_tts_emitter
            )
        except Exception as exc:
            logger.error("[interface_agent] Generation failed: %s", exc)
            response_text = "I encountered an error generating a response. Please try again."
            await _emit("token", {"text": response_text, "messageId": msg_id})
            await _tts_emitter.feed(response_text)

    # ── Proactive team offer marker parse ────────────────────────────────────
    # If AURA included [TEAM_OFFER: <description>] in her response, extract it,
    # set pending_team_context so the confirm/cancel flow handles the next turn,
    # and strip the marker from the visible response.
    _team_offer_match = re.search(r'\[TEAM_OFFER:\s*(.+?)\]', response_text, re.IGNORECASE)
    if _team_offer_match and team_enabled:
        _offer_description = _team_offer_match.group(1).strip()
        # Build context block from window so Planner has conversation background
        _ctx_block = "\n\n[CONVERSATION CONTEXT — for Planner use]\n"
        for _t in window[-6:]:
            _t_role = "User" if _t.get("role") == "user" else "AURA"
            _ctx_block += f"{_t_role}: {_t.get('content', '')[:400]}\n"
        _runtime_state["pending_team_context"] = _offer_description + _ctx_block
        _runtime_state["pending_team_confirmed"] = False
        _gate_secs, _gate_tier = estimate_solo_time(_offer_description)
        _runtime_state["pending_team_solo_estimate"] = (_gate_secs, _gate_tier)
        # Strip marker from displayed response
        response_text = re.sub(r'\s*\[TEAM_OFFER:\s*.+?\]', '', response_text, flags=re.IGNORECASE).strip()
        logger.info("[interface_agent] Proactive team offer captured: %s", _offer_description[:80])

    # ── Skill capture offer marker parse ─────────────────────────────────────
    # If AURA included [SKILL_OFFER: <description>] in her response, emit a
    # skill_capture_offer SSE event and strip the marker from visible output.
    _skill_offer_match = re.search(r'\[SKILL_OFFER:\s*(.+?)\]', response_text, re.IGNORECASE)
    if _skill_offer_match:
        _skill_desc = _skill_offer_match.group(1).strip()
        response_text = re.sub(r'\s*\[SKILL_OFFER:\s*.+?\]', '', response_text, flags=re.IGNORECASE).strip()
        await _emit("skill_capture_offer", {
            "thread_id":   thread_id,
            "description": _skill_desc,
        })
        logger.info("[interface_agent] Skill capture offer emitted: %s", _skill_desc[:80])
    elif thread_id:
        # Auto-heuristic: check if this response warrants a skill offer
        try:
            from app.service.skill_capture_service import get_skill_capture_service
            _skill_svc = get_skill_capture_service()
            if _skill_svc and await _skill_svc.suggest_capture(thread_id, response_text):
                await _emit("skill_capture_offer", {
                    "thread_id":   thread_id,
                    "description": "Save this procedure as a reusable skill?",
                })
                logger.info("[interface_agent] Auto skill capture offer emitted for thread %s", thread_id)
        except Exception:
            pass

    # ── Auto-canvas fallback: push structured content if display tool wasn't used ─
    if not display_called:
        await _auto_canvas(response_text)

    # ── Flush streaming TTS + emit end ──────────────────────────────────────
    await _tts_emitter.flush()
    await _emit("end", {"reason": "completed"})

    now = datetime.now(timezone.utc).isoformat()
    history.append({"role": "user",  "content": user_message,  "timestamp": now})
    history.append({"role": "aura",  "content": response_text, "timestamp": now})

    asyncio.create_task(_record_exchange(thread_id, user_message, response_text))

    return {
        "path":                 "solo",
        "final_response":       response_text,
        "conversation_history": history,
    }


async def deliver_team_result(state: dict, msg_id: str, thread_id: str) -> None:
    """
    Deliver completed team pipeline results to the chat session.

    Called by TeamDispatcher after the team graph completes.
    Does NOT stream tokens — instead emits a single `team_result` SSE event
    so the frontend adds it as a new proactive AURA message.

      1. Formats the content with AURA personality (optional LLM pass)
      2. Emits render_canvas with canvas blocks (if any)
      3. Emits team_result SSE event with the formatted content
      4. Records to memory
    """
    from app.controller.chat_controller import _emit

    assembled = state.get("verified_output") or state.get("assembled_output") or {}
    plan = state.get("execution_plan") or {}
    user_message = state.get("team_request") or state.get("user_message", "")

    content = assembled.get("content", "[Team task complete]")
    canvas_blocks = assembled.get("canvas_blocks", [])
    task_title = plan.get("task", "Team Research")
    area_results = state.get("area_results", [])
    sprint_results = state.get("sprint_results", [])

    logger.info(
        "[interface_agent] Team return: %d areas, %d sprints, %d canvas blocks",
        len(area_results), len(sprint_results), len(canvas_blocks),
    )

    await _emit("agent_update", {
        "node": "interface_agent",
        "status": "running",
        "detail": "Formatting team results...",
    })

    # ── Optional: AURA personality pass on the content ───────────────────────
    # If the interface engine is available and NOT currently busy responding to
    # the user, do a quick formatting pass to add AURA's voice.
    # IMPORTANT: _split_thinking must use a no-op emit here — the personality
    # pass is internal; its thinking blocks must NOT broadcast to the user stream.
    async def _noop_emit(event_type: str, data: dict) -> None:
        pass  # Silently discard — do not pollute the user's SSE stream

    formatted_content = content
    try:
        from app.service.interface_engine import get_engine
        from app.controller.chat_controller import _runtime_state
        engine = get_engine()
        interface_busy = _runtime_state.get("interface_busy", False)
        if engine is not None and not interface_busy:
            format_messages = [
                {
                    "role": "system",
                    "content": (
                        "You are AURA. The research team has completed analysis and produced "
                        "the following report. Present it to the user in your voice — warm, "
                        "direct, and confident. Keep the data and structure intact. "
                        "Add a brief intro and sign-off. Do not add disclaimers. Be concise."
                    ),
                },
                {
                    "role": "user",
                    "content": (
                        f"Original request: {user_message}\n\n"
                        f"Team report:\n{content[:3000]}"
                    ),
                },
            ]
            result = await engine.generate(format_messages, max_tokens=2048, temperature=0.5)
            raw_text = result.get("text", "")
            if raw_text:
                # Use _noop_emit so personality-pass thinking blocks don't reach the user stream
                formatted_content = await _split_thinking(raw_text, _noop_emit)
                if len(formatted_content) > 50:  # sanity check — model actually produced something
                    logger.info("[interface_agent] Personality pass: %d chars", len(formatted_content))
                else:
                    formatted_content = content
        elif interface_busy:
            logger.info("[interface_agent] Skipping personality pass — interface busy with user")
    except Exception as exc:
        logger.warning("[interface_agent] Personality formatting failed — using raw content: %s", exc)
        formatted_content = content

    # ── Emit canvas blocks ───────────────────────────────────────────────────
    if canvas_blocks:
        await _emit("render_canvas", {
            "blocks": canvas_blocks,
            "title":  task_title,
        })
        logger.info("[interface_agent] Emitted render_canvas: %d block(s)", len(canvas_blocks))

    # ── Emit team_result — frontend adds this as a new proactive AURA message ─
    # Async delivery: user may be mid-conversation, so we don't stream tokens.
    # Instead one event carries the full formatted content. Frontend creates
    # a new message bubble and enables input.
    team_id = msg_id.replace("msg-team-", "")
    await _emit("team_result", {
        "team_id":      team_id,
        "content":      formatted_content,
        "canvas_title": task_title,
        "msg_id":       msg_id,
    })

    logger.info("[interface_agent] team_result emitted for %s", team_id)

    # ── Record to memory ─────────────────────────────────────────────────────
    asyncio.create_task(_record_exchange(thread_id, user_message, formatted_content))


async def _record_exchange(thread_id: str, user_msg: str, aura_response: str) -> None:
    """Record the exchange to memory service and update user profile (background task)."""
    from app.service.memory_service import get_memory_service
    svc = get_memory_service()
    if svc is None:
        return
    try:
        await svc.record(
            role="interface",
            content=aura_response,
            thread_id=thread_id,
            metadata={
                "task": user_msg,
                "messages": [
                    {"role": "user",      "content": user_msg},
                    {"role": "assistant", "content": aura_response},
                ],
            },
        )
    except Exception as exc:
        logger.warning("[interface_agent] Memory record failed: %s", exc)

    # Update persistent user profile asynchronously — zero latency to user
    try:
        from app.service.user_profile_service import get_user_profile_service
        _prof_svc = get_user_profile_service()
        if _prof_svc is not None:
            await _prof_svc.update_from_exchange(user_msg, aura_response, thread_id)
    except Exception as exc:
        logger.debug("[interface_agent] Profile update failed: %s", exc)
