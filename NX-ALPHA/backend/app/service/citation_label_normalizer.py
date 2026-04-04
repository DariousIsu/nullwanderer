"""
Citation Label Normalizer

Translates arbitrary dataset label schemes into a common format the
adversarial trainer can use for meaningful judgment.

Problem: HuggingFace citation/fact-check datasets use wildly different
label schemes. FEVER returns "SUPPORTS". FactCC returns "CORRECT".
SciFact returns "SUPPORT". ClaimBuster returns 0-3 integers. Passing
these raw strings as `expected_answer` into the workhorse judge gives it
nothing to work with — it can't score "SUPPORTS" against an interface
answer about citation accuracy.

Solution: Detect the scheme, normalize to a common status + quality
signal, and expand into a rich expected answer string the judge can
actually use.

Output status vocabulary matches citation_verifier.py:
    confirmed    — claim is well-supported by the source  (quality ≥ 0.75)
    partial      — claim has some support but is incomplete (0.45–0.74)
    uncertain    — insufficient evidence to confirm or deny (0.20–0.44)
    hallucinated — claim contradicts or is absent from source (< 0.20)
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import Optional

logger = logging.getLogger(__name__)


# ── Output type ───────────────────────────────────────────────────────────────

@dataclass
class NormalizedLabel:
    status: str            # confirmed | partial | uncertain | hallucinated
    quality: float         # 0.0–1.0 — maps to memory layer quality_signal
    expected_answer: str   # Rich prose the workhorse judge can score against
    scheme_detected: str   # Human-readable name of the detected scheme


# ── Known dataset registry ────────────────────────────────────────────────────
# Maps HuggingFace dataset IDs (lowercased) to their label scheme name.
# Partial matches work — "fever" matches "fever", "fever_symmetric_generated", etc.

_DATASET_SCHEME_MAP: dict[str, str] = {
    "fever":          "fever",
    "vitaminc":       "fever",       # SUPPORTS / REFUTES
    "scifact":        "scifact",     # SUPPORT / CONTRADICT / NOT_ENOUGH_INFO
    "factcc":         "factcc",      # CORRECT / INCORRECT
    "frank":          "factcc",      # FACTUAL / NON-FACTUAL
    "summac":         "factcc",
    "claimbuster":    "claimbuster", # 0–3 integer
    "liar":           "liar",        # pants-fire / false / barely-true / half-true / mostly-true / true
    "multifc":        "liar",
    "climate-fever":  "fever",
    "hover":          "fever",       # SUPPORTED / NOT_SUPPORTED
    "creak":          "binary",      # true / false
    "pubhealth":      "binary",
    "covid-fact":     "binary",
    "healthver":      "fever",
    "wice":           "scifact",
}


# ── Label → (status, quality) mappings per scheme ────────────────────────────

def _fever_map(label: str) -> tuple[str, float]:
    l = label.upper().strip()
    if l in ("SUPPORTS", "SUPPORTED", "ENTAILMENT", "TRUE"):
        return "confirmed", 0.90
    if l in ("REFUTES", "CONTRADICTS", "CONTRADICTION", "FALSE"):
        return "hallucinated", 0.10
    if l in ("NOT ENOUGH INFO", "NOT_ENOUGH_INFO", "NEI", "NEUTRAL", "UNKNOWN"):
        return "uncertain", 0.35
    return "uncertain", 0.35


def _scifact_map(label: str) -> tuple[str, float]:
    l = label.upper().strip()
    if l in ("SUPPORT", "SUPPORTS", "SUPPORTED"):
        return "confirmed", 0.88
    if l in ("CONTRADICT", "CONTRADICTS", "CONTRADICTED"):
        return "hallucinated", 0.10
    if l in ("NOT_ENOUGH_INFO", "NEI", "NOTENOUGHINFO"):
        return "uncertain", 0.30
    return "uncertain", 0.30


def _factcc_map(label: str) -> tuple[str, float]:
    l = label.upper().strip()
    if l in ("CORRECT", "FACTUAL", "CONSISTENT", "FAITHFUL"):
        return "confirmed", 0.90
    if l in ("INCORRECT", "NON-FACTUAL", "NONFACTUAL", "INCONSISTENT", "UNFAITHFUL"):
        return "hallucinated", 0.10
    return "uncertain", 0.35


def _liar_map(label: str) -> tuple[str, float]:
    l = label.lower().strip()
    _LIAR_SCALE = {
        "true":         ("confirmed",    0.92),
        "mostly-true":  ("confirmed",    0.78),
        "half-true":    ("partial",      0.55),
        "barely-true":  ("uncertain",    0.38),
        "false":        ("hallucinated", 0.12),
        "pants-fire":   ("hallucinated", 0.05),
        "pants on fire":("hallucinated", 0.05),
    }
    return _LIAR_SCALE.get(l, ("uncertain", 0.35))


def _claimbuster_map(label: str) -> tuple[str, float]:
    # 0 = non-claim, 1 = unimportant CFS, 2 = important CFS, 3 = check-worthy
    try:
        v = int(float(label.strip()))
    except (ValueError, AttributeError):
        return "uncertain", 0.35
    return [
        ("uncertain",    0.30),
        ("uncertain",    0.40),
        ("partial",      0.58),
        ("confirmed",    0.80),
    ][min(v, 3)]


def _binary_map(label: str) -> tuple[str, float]:
    l = label.lower().strip()
    if l in ("true", "yes", "correct", "1", "supported", "factual"):
        return "confirmed", 0.90
    if l in ("false", "no", "incorrect", "0", "refuted", "non-factual"):
        return "hallucinated", 0.10
    return "uncertain", 0.35


def _numeric_map(value: float) -> tuple[str, float]:
    """Normalize any 0–1 or 0–10 float to status + quality."""
    # Detect scale: if > 1.0 assume 0–10, else 0–1
    q = value / 10.0 if value > 1.0 else value
    q = max(0.0, min(1.0, q))
    if q >= 0.75:
        return "confirmed", q
    if q >= 0.45:
        return "partial", q
    if q >= 0.20:
        return "uncertain", q
    return "hallucinated", q


# ── Scheme auto-detection ─────────────────────────────────────────────────────

_FEVER_LABELS    = {"supports", "refutes", "not enough info", "not_enough_info", "nei", "supported"}
_SCIFACT_LABELS  = {"support", "contradict", "notenoughinfo"}
_FACTCC_LABELS   = {"correct", "incorrect", "factual", "non-factual", "nonfactual"}
_LIAR_LABELS     = {"true", "mostly-true", "half-true", "barely-true", "false", "pants-fire"}
_BINARY_LABELS   = {"true", "false", "yes", "no", "0", "1"}


def _detect_scheme(label: str, dataset_id: str = "") -> str:
    """
    Detect the label scheme from the dataset ID (preferred) or label content.
    Returns scheme name: fever | scifact | factcc | liar | claimbuster | binary | numeric | unknown
    """
    # Try registered dataset first
    did = dataset_id.lower()
    for key, scheme in _DATASET_SCHEME_MAP.items():
        if key in did:
            return scheme

    # Fall back to label content inspection
    l = label.lower().strip()

    # Numeric check
    try:
        v = float(l)
        return "numeric"
    except ValueError:
        pass

    if l in _FEVER_LABELS:
        return "fever"
    if l in _SCIFACT_LABELS:
        return "scifact"
    if l in _FACTCC_LABELS:
        return "factcc"
    if l in _LIAR_LABELS:
        return "liar"
    if re.match(r'^[0-3]$', l):
        return "claimbuster"
    if l in _BINARY_LABELS:
        return "binary"

    return "unknown"


# ── Rich expected answer builder ──────────────────────────────────────────────

_STATUS_GUIDANCE = {
    "confirmed": (
        "The citation is well-supported. The claim accurately reflects what the source says. "
        "A correct response should identify that the cited material clearly supports the stated claim, "
        "note where in the source the supporting evidence appears, and confirm the quote or paraphrase "
        "is accurate to the original."
    ),
    "partial": (
        "The citation is partially supported. The source contains some relevant material but the claim "
        "overstates, oversimplifies, or omits important context. A correct response should identify "
        "what part of the claim is supported, what is missing or exaggerated, and explain the gap "
        "between what the source says and what the claim asserts."
    ),
    "uncertain": (
        "There is insufficient evidence in the source to confirm or deny the claim. The source may be "
        "tangentially related but does not directly address the claim. A correct response should note "
        "that the citation is ambiguous or inconclusive and explain why the source does not clearly "
        "support or refute the stated claim."
    ),
    "hallucinated": (
        "The citation does not support the claim — the claim contradicts the source, misrepresents it, "
        "or the cited content does not exist in the source. A correct response should identify the "
        "specific mismatch between what the claim asserts and what the source actually says, and "
        "classify this as a citation error or hallucination."
    ),
}


def _build_expected_answer(status: str, quality: float, raw_label: str) -> str:
    guidance = _STATUS_GUIDANCE.get(status, _STATUS_GUIDANCE["uncertain"])
    return (
        f"Citation status: {status.upper()} (quality score: {quality:.2f}).\n"
        f"Original dataset label: {raw_label!r}.\n\n"
        f"{guidance}"
    )


# ── Public API ────────────────────────────────────────────────────────────────

def scan_label_scheme(samples: list[str], dataset_id: str = "", scan_n: int = 30) -> str:
    """
    Scan a sample of label values and return the dominant scheme.

    Call this once at dataset load time with the first N values from the
    response column. The returned scheme string can be passed directly to
    normalize() to skip per-sample re-detection.

    Parameters
    ----------
    samples : list[str]
        First N raw label values from the response column.
    dataset_id : str
        HuggingFace dataset ID — checked first before label inspection.
    scan_n : int
        How many samples to inspect (default 30 is enough for all known schemes).

    Returns
    -------
    str
        Scheme name: fever | scifact | factcc | liar | claimbuster | binary | numeric | unknown
    """
    # Dataset ID match short-circuits the scan entirely
    did = dataset_id.lower()
    for key, scheme in _DATASET_SCHEME_MAP.items():
        if key in did:
            logger.info("[normalizer] Scheme locked from dataset ID %r → %s", dataset_id, scheme)
            return scheme

    # Tally scheme votes across the sample
    votes: dict[str, int] = {}
    for raw in samples[:scan_n]:
        s = _detect_scheme(str(raw).strip(), dataset_id)
        votes[s] = votes.get(s, 0) + 1

    if not votes:
        return "unknown"

    # Prefer any scheme over "unknown" or "binary" (binary is a weak signal)
    winner = max(votes, key=lambda k: (k not in ("unknown", "binary"), votes[k]))
    logger.info("[normalizer] Scheme scan (%d samples) → %s  votes=%s", len(samples[:scan_n]), winner, votes)
    return winner


def normalize(raw_label: str, dataset_id: str = "", scheme: str = "") -> NormalizedLabel:
    """
    Normalize a raw dataset label to a common citation status and quality signal.

    Parameters
    ----------
    raw_label : str
        The raw label value from the dataset (e.g. "SUPPORTS", "1", "pants-fire").
    dataset_id : str
        The HuggingFace dataset ID. Used to pick the right scheme if scheme
        is not provided.
    scheme : str
        Pre-locked scheme from scan_label_scheme(). If provided, skips detection.

    Returns
    -------
    NormalizedLabel
        status, quality (0–1), rich expected_answer prose, scheme_detected.
    """
    if not raw_label or not str(raw_label).strip():
        return NormalizedLabel(
            status="uncertain",
            quality=0.35,
            expected_answer=_build_expected_answer("uncertain", 0.35, raw_label),
            scheme_detected="empty",
        )

    raw = str(raw_label).strip()
    if not scheme:
        scheme = _detect_scheme(raw, dataset_id)

    if scheme == "fever":
        status, quality = _fever_map(raw)
    elif scheme == "scifact":
        status, quality = _scifact_map(raw)
    elif scheme == "factcc":
        status, quality = _factcc_map(raw)
    elif scheme == "liar":
        status, quality = _liar_map(raw)
    elif scheme == "claimbuster":
        status, quality = _claimbuster_map(raw)
    elif scheme == "binary":
        status, quality = _binary_map(raw)
    elif scheme == "numeric":
        status, quality = _numeric_map(float(raw))
    else:
        # Unknown scheme — pass raw label through as-is, mark uncertain
        # The workhorse judge will still see it in the expected_answer context
        logger.debug("[normalizer] Unknown label scheme for %r (dataset=%s) — passing raw",
                     raw[:40], dataset_id)
        status, quality = "uncertain", 0.35

    expected = _build_expected_answer(status, quality, raw)
    logger.debug("[normalizer] %r → %s (q=%.2f) via %s", raw[:30], status, quality, scheme)

    return NormalizedLabel(
        status=status,
        quality=quality,
        expected_answer=expected,
        scheme_detected=scheme,
    )
