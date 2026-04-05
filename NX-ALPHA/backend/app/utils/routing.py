"""
AURA NX-Alpha — Routing Utilities
Three-tier routing: semantic router → LLM classify → keyword fallback.

DESIGN PRINCIPLE:
    AURA is a brainstorming partner. She handles most things solo: Q&A,
    explanations, idea challenges, casual chat, lookups, quick summaries.

    The TEAM is AURA's resource for producing deliverables. Tasks that need
    a formatted product (paper, report, briefing, analysis document) or deep
    multi-source research go to the team. The distinction is:

        "Tell me about the founding of the US"  → SOLO (conversational)
        "Write me a paper on the founding of the US" → TEAM (deliverable)
        "What are the key factors in oil pricing?" → SOLO (explanation)
        "Conduct deep research on oil market dynamics and generate a briefing" → TEAM (deliverable)

    The team produces products. The interface produces conversation.
"""

import logging

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# TIER 1: SEMANTIC ROUTER (embedding-based, ~5ms, most accurate)
# ─────────────────────────────────────────────────────────────────────────────

_semantic_router = None
_semantic_ready = False


def _init_semantic_router():
    """
    Initialize the semantic router with example utterances.
    Called lazily on first use. Falls through to keyword matching if unavailable.
    """
    global _semantic_router, _semantic_ready

    try:
        from semantic_router import Route, SemanticRouter
        from semantic_router.encoders import FastEmbedEncoder

        solo_route = Route(
            name="solo",
            utterances=[
                # Conversational / Q&A
                "hello how are you",
                "what do you think about this idea",
                "can you challenge my thinking on this",
                "let's brainstorm about",
                "give me feedback on this concept",
                "what's your take on",
                # Factual lookups — conversational answers
                "what is the price of oil",
                "what's the weather today",
                "tell me about bitcoin",
                "who is the president",
                "what time is it in Tokyo",
                "what's the S&P 500 at",
                "what's 15% of 340",
                "define machine learning",
                "who won the game last night",
                "what year was the US founded",
                "what is the capital of France",
                "who was the first president",
                "when did the Civil War start",
                # Explanations — conversational, no deliverable
                "tell me about the founding of the United States",
                "explain how monetary policy affects housing markets",
                "help me understand how tariffs affect the economy",
                "walk me through the factors driving oil prices",
                "what are the key dynamics of the EV industry",
                "break down what's happening in the bond market",
                "explain quantum computing",
                "what is climate change and why does it matter",
                # Quick tasks
                "summarize this article",
                "translate this to Spanish",
                "what does this error mean",
                "check my email",
                "what's my schedule today",
                "show me the system status",
                "remind me about my meeting",
                "search for recent news about Tesla",
                # Health / medical Q&A
                "how do you treat a burn",
                "what should I do for a headache",
                "how do you treat a sprained ankle",
                "what are the symptoms of the flu",
                "how do you stop a nosebleed",
                "what is the best way to treat a cold",
                "how do I care for a wound",
                "what are signs of dehydration",
                # How-to / practical
                "how do I fix a leaky faucet",
                "how do you change a tire",
                "how do I reset my password",
                "how do you hard boil an egg",
                "how do I unclog a drain",
                "how do I change a lightbulb",
                # General advice
                "what should I do if I feel anxious",
                "how do I deal with stress",
                "what are some good habits for productivity",
                "what's the best way to approach this problem",
                "how do I improve my sleep",
                # Legislation / DB lookups
                "what AI bills were introduced this year",
                "identify AI related legislation",
                "what laws passed in California",
                "show me bills about healthcare",
                "find legislation on climate change",
            ],
        )

        team_route = Route(
            name="team",
            utterances=[
                # Writing deliverables — user expects a product, not chat
                "write me a paper on the founding of the United States",
                "write me a research paper on climate change",
                "write me an essay on artificial intelligence",
                "write a comprehensive report on oil markets",
                "write me a detailed analysis of the EV industry",
                "can you write me a paper on World War 2",
                "draft a whitepaper on blockchain technology",
                "create a document comparing fiscal policies across G7 nations",
                # Deep research with deliverable output
                "conduct deep research on semiconductor supply chains",
                "conduct extensive research on renewable energy trends and generate a briefing",
                "research and compile a comprehensive report on tariff impacts",
                "do a deep dive into geopolitical impacts on energy markets",
                "research the crypto regulatory landscape and write a summary",
                "investigate supply chain disruptions in automotive and report findings",
                # Analysis deliverables
                "create a detailed financial analysis of Apple stock",
                "build a risk assessment for my portfolio",
                "generate a competitive analysis of EV manufacturers",
                "compile a market analysis with trade recommendations",
                "analyze sentiment across tech earnings calls and produce a report",
                "put together a sector comparison report",
                # Charting / data products
                "generate a chart of crude oil prices over the last year",
                "create a graph showing inflation vs employment",
                "plot historical gold prices",
                # Explicit team requests
                "send this to the team",
                "have the team handle this",
                "use the research team",
                "get the team on this",
                "spin up the team",
                "start a team task",
                # Citation verification
                "verify the citations in this document",
                "check the citations in this report",
                "run citation verification on this",
                "verify these citations",
                "validate citations in this document",
                "citation check this document",
                "fact check the citations",
                "verify the sources in this paper",
            ],
        )

        encoder = FastEmbedEncoder()
        _semantic_router = SemanticRouter(
            encoder=encoder,
            routes=[solo_route, team_route],
            auto_sync="local",
        )
        _semantic_router.score_threshold = 0.82
        _semantic_ready = True
        logger.info("[routing] Semantic router initialized with %d solo + %d team examples",
                     len(solo_route.utterances), len(team_route.utterances))

    except ImportError:
        logger.info("[routing] semantic-router not installed — using keyword fallback only")
        _semantic_ready = False
    except Exception as exc:
        logger.warning("[routing] Semantic router init failed (%s) — using keyword fallback", exc)
        _semantic_ready = False


def _semantic_classify(text: str) -> str | None:
    """
    Classify via semantic router. Returns "solo", "team", or None (low confidence).
    """
    global _semantic_ready
    if not _semantic_ready:
        _init_semantic_router()
    if not _semantic_ready or _semantic_router is None:
        return None

    try:
        decision = _semantic_router(text)
        if decision and decision.name:
            logger.debug("[routing] Semantic: %r → %s (score=%.3f)",
                         text[:60], decision.name, getattr(decision, 'similarity_score', 0))
            return decision.name
    except Exception as exc:
        logger.debug("[routing] Semantic classify failed: %s", exc)
    return None


# ─────────────────────────────────────────────────────────────────────────────
# TIER 2: LLM CLASSIFICATION (grammar-constrained, ~200-500ms)
# ─────────────────────────────────────────────────────────────────────────────

_CLASSIFY_SCHEMA = {
    "type": "object",
    "properties": {
        "path":       {"type": "string"},
        "confidence": {"type": "number"},
    },
    "required": ["path", "confidence"],
}


async def _llm_classify(text: str) -> str | None:
    """
    Use the interface engine with grammar-constrained output to classify.
    Returns "solo" or "team", or None if engine unavailable.
    """
    try:
        from app.service.interface_engine import get_engine
        engine = get_engine()
        if engine is None or not engine._loaded:
            return None

        messages = [
            {"role": "system", "content": (
                "Classify the user's request into one of two paths.\n\n"
                "solo = Conversational responses: Q&A, explanations, brainstorming, "
                "feedback, idea challenges, quick lookups, chat, greetings. "
                "Anything where the answer belongs in a conversation.\n\n"
                "team = Deliverable production: the user expects a PRODUCT — a paper, "
                "report, briefing, analysis document, chart, or formatted output. "
                "Also: deep multi-source research that will take time and produce a document.\n\n"
                "Key distinction: 'tell me about X' = solo. 'write me a paper on X' = team. "
                "'explain X' = solo. 'research X and produce a briefing' = team.\n\n"
                'Output JSON: {"path": "solo" or "team", "confidence": 0.0-1.0}'
            )},
            {"role": "user", "content": text},
        ]

        result = await engine.generate_with_schema(messages, _CLASSIFY_SCHEMA, max_tokens=64)
        import json
        parsed = json.loads(result.get("text", "{}"))
        path = parsed.get("path", "solo")
        confidence = float(parsed.get("confidence", 0.5))

        if path in ("solo", "team") and confidence > 0.6:
            logger.debug("[routing] LLM classify: %r → %s (conf=%.2f)", text[:60], path, confidence)
            return path
    except Exception as exc:
        logger.debug("[routing] LLM classify failed: %s", exc)
    return None


# ─────────────────────────────────────────────────────────────────────────────
# TIER 3: KEYWORD FALLBACK (instant, least accurate)
# ─────────────────────────────────────────────────────────────────────────────

# Deliverable-producing keywords — user expects a product
_TEAM_KEYWORDS_STRONG = [
    # Writing deliverables
    "write me a paper", "write a paper", "write me a report", "write a report",
    "write me an essay", "write an essay", "write me a document",
    "write a comprehensive", "write a detailed", "write me a detailed",
    "draft a whitepaper", "draft a report", "draft a paper",
    "create a report", "create a document", "create a briefing",
    "generate a report", "generate a briefing",
    "produce a report", "produce a paper", "produce a briefing",
    "compile a report", "compile an analysis", "compile a briefing",
    "put together a report", "put together a paper",
    # Deep research with deliverable
    "conduct research", "conduct deep research", "conduct extensive research",
    "deep dive into", "deep research on",
    "research and compile", "research and produce", "research and generate",
    "investigate and report", "investigate and compile",
    # Analysis deliverables
    "financial analysis of", "competitive analysis of",
    "market analysis", "sector analysis", "risk assessment",
    "portfolio review", "portfolio analysis",
    # Charting / data products
    "generate a chart", "generate a graph", "create a chart",
    "create a graph", "plot a chart", "plot a graph",
    # Explicit team requests
    "send to the team", "use the team", "research team",
    "have the team", "get the team", "spin up the team",
    "start a team task", "team task",
    # Citation verification
    "verify the citations", "check the citations", "citation verification",
    "validate citations", "citation check", "verify these citations",
    "verify the sources", "source verification",
]

# Weaker signals — need longer context to be confident (>8 words)
_TEAM_KEYWORDS_WEAK = [
    "and produce a", "and generate a", "and compile a",
    "and create a report", "and write a report",
    "comprehensive report", "comprehensive analysis", "comprehensive briefing",
    "detailed report", "detailed analysis", "detailed briefing",
]


def is_team_task_keywords(text: str) -> bool:
    """
    Keyword-based routing heuristic (Tier 3 fallback).
    """
    lower = text.lower()
    word_count = len(text.split())

    if word_count > 3 and any(kw in lower for kw in _TEAM_KEYWORDS_STRONG):
        return True
    if word_count > 8 and any(kw in lower for kw in _TEAM_KEYWORDS_WEAK):
        return True
    return False


# ─────────────────────────────────────────────────────────────────────────────
# UNDERSPECIFIED DETECTION — for Phase 2 clarification behavior
# ─────────────────────────────────────────────────────────────────────────────

def is_underspecified(text: str) -> bool:
    """
    Returns True if a team-worthy prompt is too vague to dispatch without
    clarification. Used by the interface agent to decide whether to ask
    questions before handing off to the team.

    Examples:
        "write me a paper" → True (no subject)
        "write me a report on something" → True (vague subject)
        "write me a paper on the founding of the US" → False (clear enough)
        "conduct research on oil markets and produce a briefing" → False
    """
    lower = text.lower().strip()
    word_count = len(lower.split())

    # Very short team requests are almost always underspecified
    if word_count < 6:
        return True

    # Check for vague/placeholder subjects
    _VAGUE_SUBJECTS = [
        "on something", "on a topic", "on a subject",
        "about something", "about a topic", "about a subject",
        "on it", "about it", "on that", "about that",
    ]
    if any(v in lower for v in _VAGUE_SUBJECTS):
        return True

    # "write me a paper" with no "on/about" clause is underspecified
    _NEEDS_SUBJECT = [
        "write me a paper", "write a paper", "write me a report",
        "write a report", "write me an essay", "write an essay",
        "create a report", "generate a report", "draft a paper",
        "conduct research", "do research",
    ]
    for phrase in _NEEDS_SUBJECT:
        if phrase in lower:
            # Check if there's a subject after the phrase
            after = lower.split(phrase, 1)[1].strip()
            # Needs at least "on X" or "about X" with a real subject
            if not after or len(after.split()) < 2:
                return True

    return False


# ─────────────────────────────────────────────────────────────────────────────
# PUBLIC API — three-tier routing
# ─────────────────────────────────────────────────────────────────────────────

# ─────────────────────────────────────────────────────────────────────────────
# CITATION TASK DETECTION — always routes to team, gate bypassed
# ─────────────────────────────────────────────────────────────────────────────

_CITATION_SIGNALS = [
    "verify the citations", "verify citations", "check the citations",
    "check citations", "citation verification", "verify these citations",
    "validate citations", "validate the citations", "citation check",
    "fact check the citations", "fact-check the citations",
    "verify the sources", "verify sources", "check the sources",
    "source verification", "verify these sources",
    "run citation", "citation report", "check these sources",
    "verify this document's citations", "verify the references",
    "check the references",
    # Folder / batch variants
    "verify citations in this folder", "run citations on this folder",
    "verify the folder", "citation check this folder",
    "process this folder", "batch verify", "verify all documents",
    "check all the documents", "run this on the folder",
    "verify everything in", "process everything in",
]


def is_citation_task(text: str) -> bool:
    """
    Returns True if the request is a citation verification job.
    These always route to team and bypass the team gate.
    """
    lower = text.lower()
    return any(sig in lower for sig in _CITATION_SIGNALS)


def is_team_task(text: str) -> bool:
    """
    Synchronous team routing check. Uses semantic router → keyword fallback.
    LLM classification is async and used separately via classify_request().
    """
    # Super hard override: citation verification always goes to team regardless
    # of gate state, word count, or any other guard below.
    if is_citation_task(text):
        return True

    lower = text.lower().strip()
    word_count = len(text.split())

    # Hard guard 1: Very short messages are never team tasks.
    # "perfect thank you", "ok", "sure", "great" etc. cannot be deliverable requests.
    if word_count < 5:
        return False

    # Hard guard 2: Negation / cancellation phrases are never team tasks.
    # Catches "We didn't need anything made", "never mind", "forget it" etc.
    _NEGATION_SOLO = [
        "don't need", "dont need", "didn't need", "didnt need",
        "we don't", "we dont", "we didn't", "we didnt",
        "no need", "not needed", "not necessary", "no longer need",
        "never mind", "nevermind", "forget it", "cancel that",
        "figure of speech", "just kidding", "just checking in",
        "not serious", "i was joking", "i'm joking",
    ]
    if any(neg in lower for neg in _NEGATION_SOLO):
        return False

    # Hard guard 2b: Editorial / voice passes are Interface-only — never team tasks.
    # AURA handles rewriting, punching up, and polishing in her own voice.
    _EDITORIAL_SIGNALS = [
        "punch it up", "punch this up", "punch up",
        "make it more engaging", "make this more engaging",
        "add some personality", "add personality to",
        "rewrite this", "rewrite it",
        "in your voice", "make it sound like you", "add your voice",
        "polish this", "polish it",
        "spice it up", "make it less dry", "less dry",
        "make it flow", "improve the prose",
        "edit this for voice", "edit for voice",
    ]
    if any(sig in lower for sig in _EDITORIAL_SIGNALS):
        logger.debug("[routing] Hard guard 2b (editorial): %r → solo", text[:60])
        return False

    # Hard guard 3: Resource-fetch requests are never team tasks.
    # Catches "find me a video", "can you find a link", "just web search" etc.
    _FETCH_SIGNALS = [
        "find me a", "find a ", "can you find", "look up a", "look up an",
        "search for a", "search for an", "show me a", "show me an",
        "youtube video", "youtube tutorial", "youtube link",
        "a video of", "a video about", "a video for",
        "a link to", "a link for", "a url for",
        "an image of", "a picture of", "a gif of",
        "a tutorial on", "a tutorial for",
        "put it on the canvas", "put them on the canvas",
        "put it in the canvas", "put them in the canvas",
        "just search", "search them up", "search it up",
        "web search and find", "web search for", "just web search",
    ]
    if any(sig in lower for sig in _FETCH_SIGNALS):
        return False

    # Hard guard 4: Direct questions without deliverable verbs are never team tasks.
    # "How do you treat a burn?" → solo. "How do I write a report on X?" → passes through.
    _QUESTION_STARTERS = (
        "how ", "what ", "why ", "when ", "where ", "who ", "which ",
        "can you ", "could you ", "is ", "are ", "does ", "do ", "did ",
        "will ", "would ", "should ", "was ", "were ", "has ", "have ",
        "what's ", "what're ", "who's ", "how's ", "why's ",
    )
    _DELIVERABLE_VERBS = (
        "write ", "create ", "generate ", "produce ", "compile ",
        "draft ", "build a ", "build me ", "put together ",
    )
    _is_question = any(lower.startswith(s) for s in _QUESTION_STARTERS)
    _has_deliverable = any(v in lower for v in _DELIVERABLE_VERBS)
    if _is_question and not _has_deliverable:
        logger.debug("[routing] Hard guard 4 (question-form): %r → solo", text[:60])
        return False

    # Hard guard 5: Queries resolvable from local databases are never team tasks.
    # "Identify all AI legislation this year", "what bills passed in CA", etc.
    _LOCAL_DB_SIGNALS = (
        "legislation", "legislative", "bills", "bill introduced", "bills passed",
        "laws passed", "statute", "act of congress", "state law",
        "pubmed", "arxiv", "research paper", "study on", "clinical trial",
        "wikipedia", "encyclopedia", "definition of", "what is the definition",
    )
    if any(sig in lower for sig in _LOCAL_DB_SIGNALS) and not _has_deliverable:
        logger.debug("[routing] Hard guard 5 (DB-aware): %r → solo", text[:60])
        return False

    # Hard guard 6: Filesystem / tool-use requests are solo.
    # "read the file", "list the directory", "access this folder", "run this command" etc.
    _TOOL_USE_SIGNALS = [
        "read the file", "read this file", "read your source", "read your file",
        "read my file", "read the folder", "read the dir",
        "list the dir", "list the folder", "list this dir", "list this folder",
        "access this folder", "access the folder", "access this dir",
        "browse the folder", "browse this folder", "browse the dir",
        "open the file", "open this file", "open the folder",
        "run this command", "run the command", "execute this",
        "check the file", "check this file", "check the folder",
        "your source file", "your source code", "source files",
    ]
    if any(sig in lower for sig in _TOOL_USE_SIGNALS) and not _has_deliverable:
        logger.debug("[routing] Hard guard 6 (tool-use): %r → solo", text[:60])
        return False

    # Hard guard 7: Document processing operations are Interface-only.
    # These are single-turn analysis tasks the interface handles immediately —
    # NOT multi-agent deliverables. Catches: "summarize this", "analyze this doc",
    # "give me an overview of", "review this", "explain this", etc.
    # Only applies when no strong deliverable framing is present.
    _INTERFACE_OP_SIGNALS = [
        "summarize this", "summarize it", "summarize the", "summarize my", "summarize these",
        "give me a summary", "give me an overview", "give me a brief",
        "give an overview", "quick overview", "brief overview", "brief summary",
        "what does this say", "what does it say", "what does this cover",
        "what does this mean", "what's in this", "what is in this",
        "explain this", "explain it", "explain the",
        "review this", "review it", "review the", "review these",
        "go through this", "go through the",
        "read through this", "read through the",
        "describe this", "describe the",
        "tell me about this", "tell me what this",
        "analyze this", "analyse this",
    ]
    if any(sig in lower for sig in _INTERFACE_OP_SIGNALS) and not _has_deliverable:
        logger.debug("[routing] Hard guard 7 (interface-op): %r → solo", text[:60])
        return False

    # Tier 1: Semantic router (fast, accurate at high threshold)
    result = _semantic_classify(text)
    if result is not None:
        route = result
        keyword_route = "team" if is_team_task_keywords(text) else "solo"
        _emit_routing_span(text, route, "semantic", keyword_route != route)
        return route == "team"

    # Tier 3: Keyword fallback (instant)
    route = "team" if is_team_task_keywords(text) else "solo"
    _emit_routing_span(text, route, "keyword", False)
    return route == "team"


async def classify_request(text: str) -> str:
    """
    Full async three-tier classification. Returns "solo" or "team".
    Used when you can afford the async LLM call (~200ms).
    """
    tier_used = "default_fallback"
    route = "solo"

    # Tier 1: Semantic router
    result = _semantic_classify(text)
    if result is not None:
        tier_used = "semantic"
        route = result
    else:
        # Tier 2: LLM classification
        result = await _llm_classify(text)
        if result is not None:
            tier_used = "llm"
            route = result
        else:
            # Tier 3: Keyword fallback
            tier_used = "keyword"
            route = "team" if is_team_task_keywords(text) else "solo"

    # Cross-check: keyword vs final route to detect disagreement
    keyword_route = "team" if is_team_task_keywords(text) else "solo"
    tier_disagreement = (keyword_route != route) and (tier_used != "keyword")

    _emit_routing_span(text, route, tier_used, tier_disagreement)

    return route


def _emit_routing_span(text: str, route: str, tier: str, disagreement: bool) -> None:
    """Emit a Phoenix span for this routing decision if tracing is enabled."""
    try:
        import json
        from pathlib import Path
        cfg_path = Path.home() / ".aura" / "phoenix_config.json"
        if cfg_path.exists():
            cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
        else:
            return
        if not cfg.get("tracing_enabled", False):
            return

        from opentelemetry import trace
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

        host = cfg.get("host", "http://localhost:6006")
        _ensure_tracer(host)

        tracer = trace.get_tracer("aura.routing")
        with tracer.start_as_current_span("routing_classify") as span:
            span.set_attribute("route", route)
            span.set_attribute("tier", tier)
            span.set_attribute("tier_disagreement", str(disagreement).lower())
            span.set_attribute("input.length", len(text))
    except Exception as exc:
        logger.debug("[routing] Phoenix span failed: %s", exc)


_tracer_host: str | None = None


def _ensure_tracer(host: str) -> None:
    """Set up OTel tracer provider pointing at Phoenix OTLP endpoint (once per host)."""
    global _tracer_host
    if _tracer_host == host:
        return

    try:
        from opentelemetry import trace
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

        exporter = OTLPSpanExporter(endpoint=f"{host}/v1/traces")
        provider = TracerProvider()
        provider.add_span_processor(BatchSpanProcessor(exporter))
        trace.set_tracer_provider(provider)
        _tracer_host = host
        logger.info("[routing] Phoenix tracer configured → %s", host)
    except Exception as exc:
        logger.warning("[routing] Tracer setup failed: %s", exc)


# ─────────────────────────────────────────────────────────────────────────────
# SOLO TIME ESTIMATION — for time-based team gate offers
# ─────────────────────────────────────────────────────────────────────────────

def estimate_solo_time(text: str) -> tuple[int, str]:
    """
    Estimate how long AURA would take to handle this solo (seconds).
    Used to frame the team gate offer: solo keeps interface busy; team frees it.
    Returns (estimated_seconds, tier) where tier is "instant", "quick", "moderate", or "long".
    """
    lower = text.lower()
    word_count = len(text.split())

    # Local DB lookups — near-instant (legislation, knowledge base, etc.)
    _DB_SIGNALS = (
        "legislation", "bills", "pubmed", "arxiv", "wikipedia",
        "knowledge_search", "what bills", "what laws",
    )
    if any(s in lower for s in _DB_SIGNALS):
        return (15, "instant")

    # Simple tool calls — quick
    _QUICK_SIGNALS = (
        "weather", "stock", "price", "news", "schedule", "email",
        "who is", "what is", "define", "translate",
    )
    if any(s in lower for s in _QUICK_SIGNALS) and word_count < 15:
        return (30, "quick")

    # Long-form synthesis — check before moderate so "comprehensive research" isn't misclassified
    if any(s in lower for s in ("comprehensive", "detailed", "in depth", "in-depth", "thorough", "exhaustive")):
        return (900, "long")  # ~15 min

    # Multi-web-search research — moderate
    _MODERATE_SIGNALS = (
        "research", "summarize", "compare", "analyze", "overview",
        "breakdown", "break down", "deep dive",
    )
    if any(s in lower for s in _MODERATE_SIGNALS):
        return (300, "moderate")  # ~5 min

    # Long by word count alone
    if word_count > 20:
        return (600, "long")  # ~10 min

    return (60, "quick")


# ─────────────────────────────────────────────────────────────────────────────
# BRAINSTORMING MODE DETECTION — syntax-triggered thought-partner personas
# ─────────────────────────────────────────────────────────────────────────────

def detect_brainstorm_mode(text: str) -> str | None:
    """
    Detect if the user is requesting a specific thought-partner mode.
    Returns one of: "devils_advocate", "starbursting", "socratic",
    "sequential_scope", or None for normal conversation.
    """
    lower = text.lower().strip()

    # Devil's Advocate — find flaws, push back, stress-test
    _DEVILS_TRIGGERS = [
        "devil's advocate", "devils advocate", "challenge this", "challenge my",
        "play devil", "what could go wrong", "what are the flaws", "poke holes",
        "what's wrong with this", "stress test this", "why won't this work",
        "argue against", "what are the risks", "what am i missing",
    ]
    if any(t in lower for t in _DEVILS_TRIGGERS):
        return "devils_advocate"

    # Starbursting — exhaustive Who/What/Where/When/Why/How questioning
    _STAR_TRIGGERS = [
        "starburst", "5w", "5 w's", "who what where when why", "six questions",
        "help me think through", "explore all angles", "every angle",
        "all the questions", "question storm", "what questions should i ask",
    ]
    if any(t in lower for t in _STAR_TRIGGERS):
        return "starbursting"

    # Socratic — guide via questions, never give the answer directly
    _SOCRATIC_TRIGGERS = [
        "socratic", "help me figure out", "guide me through", "help me understand",
        "teach me to think about", "walk me through my thinking",
        "don't give me the answer", "help me reason through",
    ]
    if any(t in lower for t in _SOCRATIC_TRIGGERS):
        return "socratic"

    # Sequential scope — AI-Pilot style: structured one-question-at-a-time project scoping
    _SCOPE_TRIGGERS = [
        "help me scope", "scope this out", "help me plan this out",
        "let's think through", "interview me", "ask me questions about",
        "help me define", "help me figure out what i need",
    ]
    if any(t in lower for t in _SCOPE_TRIGGERS):
        return "sequential_scope"

    return None


# ─────────────────────────────────────────────────────────────────────────────
# BRAINSTORM MATURITY — proactive team offer when conversation is ready
# ─────────────────────────────────────────────────────────────────────────────

def assess_brainstorm_maturity(
    window: list,
    brainstorm_mode: str | None,
    brainstorm_turn_count: int,
    user_message: str = "",
) -> dict | None:
    """
    Assess whether a conversation has accumulated enough material to warrant
    a proactive team dispatch offer.

    Returns None if not ready, or {"suggested_deliverable": str} if the
    conversation is mature enough that Interface should offer to dispatch.

    Maturity criteria (any one triggers):
      - brainstorm_mode active AND >= 3 turns deep
      - conversation window has >= 6 total turns
      - user message contains explicit readiness signals
    """
    lower_msg = user_message.lower().strip()

    # Readiness signals — user is wrapping up or asking "what next"
    _READINESS_SIGNALS = [
        "what should we do with this",
        "where do we go from here",
        "i think we've covered it",
        "i think we covered it",
        "so basically",
        "what's next",
        "what do we do now",
        "i think i have enough",
        "what can we make with this",
        "what do we do with this",
        "what should we build",
        "i'm ready",
        "i am ready",
        "let's do something with this",
        "lets do something with this",
        "now what",
    ]
    readiness_signal = any(sig in lower_msg for sig in _READINESS_SIGNALS)

    # Check maturity criteria
    mode_mature   = brainstorm_mode is not None and brainstorm_turn_count >= 3
    window_mature = len(window) >= 12
    is_mature     = mode_mature or window_mature or readiness_signal

    if not is_mature:
        return None

    # Derive a suggested deliverable based on mode
    _MODE_DELIVERABLES = {
        "sequential_scope":  "a structured specification or build plan",
        "starbursting":      "a comprehensive overview or scoping brief",
        "devils_advocate":   "a risk assessment or stress-tested proposal",
        "socratic":          "a position paper or reasoned analysis",
    }

    if brainstorm_mode and brainstorm_mode in _MODE_DELIVERABLES:
        suggested = _MODE_DELIVERABLES[brainstorm_mode]
    else:
        # Extract topic from the last 3 assistant turns in the window
        assistant_turns = [
            t.get("content", "")
            for t in window
            if t.get("role") in ("assistant", "aura")
        ][-3:]
        topic_hint = assistant_turns[-1][:80].strip() if assistant_turns else "this topic"
        suggested = f"a research briefing or report covering: {topic_hint}..."

    logger.debug(
        "[routing] Brainstorm mature (mode=%s, turns=%d, window=%d, signal=%s) → suggest: %s",
        brainstorm_mode, brainstorm_turn_count, len(window), readiness_signal, suggested,
    )
    return {"suggested_deliverable": suggested}
