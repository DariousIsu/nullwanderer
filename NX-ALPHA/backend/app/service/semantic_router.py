"""
AURA NX-Alpha — Semantic Router

Two-tier intent classifier for the prefetch pipeline.
  Tier 1: keyword matching (caller's responsibility, 0ms)
  Tier 2: this module — embedding cosine similarity (~5-15ms)

Uses all-MiniLM-L6-v2 (already cached at ~/.cache/huggingface/hub/) loaded
in-process via sentence-transformers.  No Ollama, no network call.

Usage:
    scores = await SemanticRouter.get_instance().classify(query)
    # {"knowledge": 0.81, "legislation": 0.34, "memory": 0.21, "filesystem": 0.12}
    if scores["knowledge"] > SemanticRouter.THRESHOLD:
        # fire knowledge prefetch
"""

import asyncio
import logging
from typing import Optional

import numpy as np

logger = logging.getLogger(__name__)

# ── Golden utterances per route ────────────────────────────────────────────────
# 20 diverse examples covering natural phrasing, contractions, and edge cases.
# These are embedded once at init time → averaged → stored as centroid vectors.

_UTTERANCES: dict[str, list[str]] = {
    "knowledge": [
        "who is the president of the united states",
        "who's in the cabinet",
        "what are the cabinet members",
        "what is quantum computing",
        "tell me about the french revolution",
        "explain how inflation works",
        "who invented the telephone",
        "history of world war two",
        "background on the civil rights movement",
        "what's the capital of france",
        "who won the last election",
        "overview of machine learning",
        "search wikipedia for",
        "what does the wiki say about",
        "list all members of",
        "who are the current members",
        "give me information about",
        "tell me everything about",
        "find information about",
        "what can you tell me about",
    ],
    "legislation": [
        "what does the new tax law say",
        "tell me about the infrastructure bill",
        "summary of senate bill",
        "congress passed a law about",
        "what regulation covers this",
        "the house voted on",
        "proposed legislation for",
        "what act covers this situation",
        "federal statute regarding",
        "executive order on immigration",
        "legislative history of",
        "what laws apply to this",
        "cfr requirements",
        "supreme court ruling on",
        "constitutional amendment about",
        "what did congress do about",
        "new policy from the senate",
        "house bill introduced yesterday",
        "regulatory framework for",
        "is there a law that covers",
    ],
    "memory": [
        "what did we talk about before",
        "you mentioned this earlier",
        "last time we discussed this",
        "remember what you told me",
        "going back to our previous conversation",
        "what was that thing you said",
        "refresh my memory on",
        "from our earlier session",
        "you said something about",
        "what have we already figured out",
        "do you recall what we covered",
        "earlier in our conversation",
        "what did i ask you about before",
        "continue where we left off",
        "bring up what we discussed previously",
        "didn't we already talk about this",
        "i thought you mentioned",
        "based on what we covered earlier",
        "from what you said before",
        "you previously told me",
    ],
    "filesystem": [
        "read the file at this path",
        "what's in the downloads folder",
        "show me the contents of the directory",
        "open the config file",
        "list all files in the folder",
        "check what's in the desktop",
        "look at my project directory",
        "access the log file",
        "browse the source code folder",
        "show directory listing",
        "read the python file",
        "open the json config",
        "show me the folder structure",
        "find files named",
        "what files are in",
        "get the contents of",
        "load the file from",
        "check the folder",
        "look inside the directory",
        "what's stored in that path",
    ],
}


def _cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    """Cosine similarity between two unit-normalised vectors."""
    return float(np.dot(a, b))


class SemanticRouter:
    """
    Singleton semantic intent classifier.

    classify(query) → {route: cosine_score}

    Scores above THRESHOLD indicate the query should trigger that prefetch route.
    Only routes that keyword matching missed need to be checked here (caller
    should already set routes that keyword-matched to True and skip them).
    """

    THRESHOLD: float = 0.72

    _instance: Optional["SemanticRouter"] = None

    def __init__(self) -> None:
        self._model = None          # SentenceTransformer, lazy-loaded
        self._centroids: dict[str, np.ndarray] = {}  # route → unit vector
        self._ready = False

    @classmethod
    def get_instance(cls) -> "SemanticRouter":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    # ── Model ─────────────────────────────────────────────────────────────────

    def _get_model(self):
        if self._model is None:
            from sentence_transformers import SentenceTransformer
            self._model = SentenceTransformer("all-MiniLM-L6-v2")
            logger.debug("[semantic_router] all-MiniLM-L6-v2 loaded")
        return self._model

    # ── Centroid init ─────────────────────────────────────────────────────────

    def _build_centroids(self) -> None:
        """
        Embed all golden utterances and compute per-route centroid vectors.
        Runs synchronously once; ~300ms on first call (model warm after that).
        """
        model = self._get_model()
        for route, utterances in _UTTERANCES.items():
            vecs = model.encode(utterances, normalize_embeddings=True,
                                show_progress_bar=False, batch_size=32)
            centroid = np.mean(vecs, axis=0)
            # Re-normalise the centroid so cosine similarity stays in [-1, 1]
            norm = np.linalg.norm(centroid)
            if norm > 0:
                centroid = centroid / norm
            self._centroids[route] = centroid.astype(np.float32)
        self._ready = True
        logger.info("[semantic_router] centroids built for routes: %s",
                    list(self._centroids.keys()))

    def _ensure_ready(self) -> None:
        if not self._ready:
            self._build_centroids()

    # ── Public API ─────────────────────────────────────────────────────────────

    async def classify(self, query: str) -> dict[str, float]:
        """
        Embed query and return cosine similarity scores against each route centroid.

        Returns
        -------
        dict[str, float]
            e.g. {"knowledge": 0.81, "legislation": 0.34, "memory": 0.21, "filesystem": 0.12}

        Runs embedding in a thread so it doesn't block the event loop.
        """
        def _run() -> dict[str, float]:
            self._ensure_ready()
            model = self._get_model()
            vec = model.encode([query], normalize_embeddings=True,
                               show_progress_bar=False)[0].astype(np.float32)
            return {
                route: _cosine_similarity(vec, centroid)
                for route, centroid in self._centroids.items()
            }

        try:
            scores = await asyncio.to_thread(_run)
            logger.debug("[semantic_router] scores for %r: %s",
                         query[:60],
                         {k: f"{v:.2f}" for k, v in scores.items()})
            return scores
        except Exception as exc:
            logger.warning("[semantic_router] classify failed: %s", exc)
            return {}
