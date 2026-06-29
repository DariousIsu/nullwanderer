/**
 * poll — the interface's poll router: ONE place that decides which grounded SOURCE answers a question.
 *
 * The problem (docs/INTERFACE_AND_LANES_DESIGN.md §1): the interface model used to answer from its own
 * lossy memory, and grounding was bolted on as ~5 scattered ad-hoc injectors, each classifying the
 * question its own way. The fix is to make the interface POLL the brain through one router: register
 * sources, classify the question once, route to the best-matching source, prefer DETERMINISTIC sources
 * (program-grounded, no model call) over ones that need a cloud pass. Adding a new lane later = register
 * one more source — no new branch in the chat pipeline.
 *
 * PURE module: a source is a plain descriptor { name, kind, tier, match }. `match(question)` returns a
 * score (a truthy boolean counts as 1). The actual answer-building stays in the domain libs (lib/track,
 * lib/lanes, …) — poll only decides WHO answers and in what priority. Fully offline-testable. Fail-safe:
 * a source whose match() throws is treated as a non-match, never crashes the route.
 */
'use strict';

const TIERS = { deterministic: 0, cloud: 1 };   // deterministic sources win ties (cheaper, exact)

// Normalize a source's match() result to a numeric score in [0, ∞); non-match → 0.
function _score(source, question) {
  try {
    const r = source.match(question);
    if (r === true) return 1;
    if (typeof r === 'number' && r > 0) return r;
    return 0;
  } catch { return 0; }
}

// Route a question across registered sources. Returns every matching source ranked, plus the top pick.
// Ranking: higher score first; ties broken by tier (deterministic before cloud), then registration order.
//   sources: [{ name, kind, tier:'deterministic'|'cloud', match:(q)=>number|boolean }]
//   → { handled, top, matched:[{ name, kind, tier, score }] }
function route(question, sources = []) {
  const q = String(question || '');
  const scored = [];
  (Array.isArray(sources) ? sources : []).forEach((s, i) => {
    if (!s || typeof s.match !== 'function') return;
    const score = _score(s, q);
    if (score > 0) scored.push({ name: s.name, kind: s.kind, tier: s.tier || 'deterministic', score, _i: i });
  });
  scored.sort((a, b) =>
    b.score - a.score ||
    (TIERS[a.tier] ?? 9) - (TIERS[b.tier] ?? 9) ||
    a._i - b._i);
  const matched = scored.map(({ _i, ...rest }) => rest);
  return { handled: matched.length > 0, top: matched[0] || null, matched };
}

// Convenience: just the winning source name (or null) — for a quick "who owns this turn?" check.
function pick(question, sources = []) { return route(question, sources).top; }

module.exports = { route, pick, TIERS };
