'use strict';
/* verify_claim.js — Spine 2 step 5 (bounded verify), docs/BIDIRECTIONAL_VERIFICATION_GATE.md.
 *
 * The honest-hedge backbone (steps 2-4) flags an ungrounded claim; this ACTUALLY CHECKS it. When the
 * reply asserts a specific current-event fact that the turn never grounded (the pure-recall confab that
 * groundFacts' conservative wiring leaves alone — e.g. "Cleco was acquired by Stonepeak"), we fire ONE
 * bounded search and post a follow-up beat: corroborated → confirm; not corroborated → say so and mark it
 * unconfirmed. Never asserts a claim is FALSE from a null search (absence of evidence ≠ contradiction) —
 * the honest verdicts are "corroborated" and "couldn't corroborate", which map to confirm vs de-certainty.
 *
 * The search is INJECTED (search(query)->{results:[{title,url,snippet}]}) so the corroboration JUDGMENT is
 * pure + offline-testable, exactly like the gates. main.js wires lib/search_lane as the instrument.
 * Run: node scripts/smoke_verify_claim.js */

// Build a compact search query from the claim: the claim sentence, stripped of hedges/filler, capped. The
// novel terms (the unsupported specifics) are appended so the SERP is forced toward the exact assertion.
function buildFactQuery(claim, novelTerms = []) {
  let q = String(claim || '')
    .replace(/^\s*(?:and|but|so|also|however|meanwhile)[,]?\s*/i, '')
    .replace(/\s+/g, ' ')
    .replace(/["'`]/g, '')
    .trim();
  // ensure the distinguishing specifics are in the query even if the claim got truncated
  for (const t of (novelTerms || [])) {
    if (t && !q.toLowerCase().includes(String(t).toLowerCase())) q += ' ' + t;
  }
  return q.slice(0, 200).trim();
}

// PURE corroboration judge. Given the claim's novel (distinguishing) terms and the SERP results, decide
// whether the specifics actually show up in real search results. Corroborated iff a MAJORITY of the novel
// terms (at least one) appear across the result titles+snippets. No results, or the specifics absent →
// "uncorroborated". Deliberately conservative toward "uncorroborated" (we only ever DE-certainty a claim,
// never assert it false), and it fails toward uncorroborated on empty input. Returns {verdict, matched, total}.
function judgeFact(novelTerms = [], results = []) {
  const terms = Array.from(new Set((novelTerms || []).map((t) => String(t || '').toLowerCase().trim()).filter((t) => t.length >= 3)));
  if (!terms.length) return { verdict: 'uncorroborated', matched: 0, total: 0 };   // nothing specific to confirm
  const hay = (Array.isArray(results) ? results : [])
    .map((r) => `${(r && r.title) || ''} ${(r && r.snippet) || ''}`.toLowerCase())
    .join(' \n ');
  if (!hay.trim()) return { verdict: 'uncorroborated', matched: 0, total: terms.length };
  let matched = 0;
  for (const t of terms) { if (hay.includes(t)) matched++; }
  const verdict = matched >= Math.ceil(terms.length / 2) ? 'corroborated' : 'uncorroborated';
  return { verdict, matched, total: terms.length };
}

// The follow-up message Zoe posts after the reply — its own beat (the reply already streamed with any
// conservative hedge). Warm, first-person, honest. Corroborated → a brief confirm; uncorroborated → own it
// and mark the claim unconfirmed so the record is honest.
function followupText(claim, verdict, { userName = 'you' } = {}) {
  const c = String(claim || '').replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '');
  const snippet = c.length > 120 ? c.slice(0, 117).trim() + '…' : c;
  if (verdict === 'corroborated') {
    return `Quick follow-up, ${userName} — I went back and checked what I said (“${snippet}”), and a quick search does corroborate it. Wanted to confirm rather than leave it on my word alone.`;
  }
  return `One correction, ${userName} — I stated “${snippet}” a moment ago, but when I actually searched to confirm it, I couldn't corroborate it. Treat that as unverified; I shouldn't have said it as flatly as I did, and I'll dig properly if it matters.`;
}

// The async orchestrator: build the query, run the injected search under a hard timeout, judge. Fully
// fail-soft — any error or timeout returns {verdict:'skip'} so the reply path is never harmed and no
// follow-up is posted on a hiccup (silence beats a false correction). Returns {verdict, query, matched, total}.
async function verifyFact(claim, novelTerms, { search, timeoutMs = 12000 } = {}) {
  try {
    if (typeof search !== 'function') return { verdict: 'skip', reason: 'no-search' };
    const query = buildFactQuery(claim, novelTerms);
    if (!query || query.length < 8) return { verdict: 'skip', reason: 'thin-query' };
    let timer;
    const timeout = new Promise((res) => { timer = setTimeout(() => res({ __timeout: true }), timeoutMs); });
    const r = await Promise.race([Promise.resolve().then(() => search(query)), timeout]);
    clearTimeout(timer);
    if (!r || r.__timeout) return { verdict: 'skip', reason: 'timeout', query };
    const j = judgeFact(novelTerms, (r && r.results) || []);
    return { verdict: j.verdict, query, matched: j.matched, total: j.total };
  } catch (e) {
    return { verdict: 'skip', reason: 'error' };
  }
}

module.exports = { buildFactQuery, judgeFact, followupText, verifyFact };
