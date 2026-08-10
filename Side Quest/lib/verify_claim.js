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

// ── ABSENCE ACTIVE-SEARCH (Spine 2 step 6, docs/BIDIRECTIONAL_VERIFICATION_GATE.md §4b) ─────────────────────
// The absence gate (groundAbsence) CONFESSES "I didn't actually search — let me look." This does the looking:
// when she declares an EMAIL absent without an external search, fire one bounded search for the subject's
// email and either SURFACE what she wrongly called blank (the §7.1 cure) or CONFIRM the blank honestly.
// Scoped to EMAIL — the highest-value, cleanly-extractable case (a phone/address value is fuzzier and stays
// confession-only). Pure judgment + injected search, exactly like verifyFact.
const _ABS_IS_EMAIL_RE = /\be-?mail\b/i;
const _EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const _ABS_PROPER_RE = /\b([A-Z][a-zA-Z0-9&.\-]+(?:\s+[A-Z][a-zA-Z0-9&.\-]+)*)\b/g;
const _ABS_PROPER_STOP = new Set(['I', 'The', 'A', 'An', 'No', 'None', 'His', 'Her', 'Their', 'Mayor', 'Governor', 'Senator', 'Representative', 'Councilman', 'Councilwoman', 'Dr', 'Mr', 'Ms', 'Mrs']);

// the subject to look up: the longest proper-noun phrase in the claim, else the most-recent one in context.
function _absSubject(claim, context = '') {
  const grab = (s) => {
    const out = []; let m; _ABS_PROPER_RE.lastIndex = 0;
    while ((m = _ABS_PROPER_RE.exec(String(s || ''))) !== null) {
      const words = String(m[1]).split(/\s+/).filter((w) => !_ABS_PROPER_STOP.has(w));
      const core = words.join(' ').trim();
      if (core.length >= 3) out.push(core);
    }
    return out;
  };
  const inClaim = grab(claim);
  if (inClaim.length) return inClaim.sort((a, b) => b.length - a.length)[0];   // richest name in the claim
  const inCtx = grab(context);
  return inCtx.length ? inCtx.sort((a, b) => b.length - a.length)[0] : '';   // richest name on the table (a person beats a bare city)
}

function buildAbsenceQuery(claim, context = '') {
  const subj = _absSubject(claim, context);
  if (!subj) return '';
  return `${subj} email address`.slice(0, 200);
}

// PURE. Pull plausible email addresses out of the SERP results (placeholders discarded, deduped).
function extractEmails(results = []) {
  const hay = (Array.isArray(results) ? results : []).map((r) => `${(r && r.title) || ''} ${(r && r.snippet) || ''}`).join(' \n ');
  const found = Array.from(new Set((hay.match(_EMAIL_RE) || []).map((e) => e.trim())));
  return found.filter((e) => !/(example|noreply|no-reply|sentry|wixpress|domain\.com|email\.com|yourdomain)/i.test(e));
}

// The follow-up after an active absence search. FOUND → surface it + own the premature blank; NOT-FOUND →
// confirm the blank is honest (fulfils the gate's "let me look" promise either way).
function absenceFollowupText(verdict, value, { userName = 'you' } = {}) {
  if (verdict === 'found' && value) {
    return `Following up, ${userName} — I said I couldn't find that, but I went and searched, and there is one: ${value}. I flagged it blank too quickly; worth confirming it's current before you rely on it.`;
  }
  return `Following up, ${userName} — I went back and actually searched for it, and I still couldn't turn up an address. The blank is honest, not a shortcut this time.`;
}

// Async orchestrator, parallel to verifyFact. Only handles EMAIL absences; anything else → skip (the gate's
// confession stands). Fully fail-soft. Returns {verdict:'found'|'not-found'|'skip', value?, query?}.
async function verifyAbsence(claim, { context = '', search, timeoutMs = 12000 } = {}) {
  try {
    if (typeof search !== 'function') return { verdict: 'skip', reason: 'no-search' };
    if (!_ABS_IS_EMAIL_RE.test(String(claim || ''))) return { verdict: 'skip', reason: 'not-email' };
    const query = buildAbsenceQuery(claim, context);
    if (!query || query.length < 8) return { verdict: 'skip', reason: 'no-subject' };
    let timer;
    const timeout = new Promise((res) => { timer = setTimeout(() => res({ __timeout: true }), timeoutMs); });
    const r = await Promise.race([Promise.resolve().then(() => search(query)), timeout]);
    clearTimeout(timer);
    if (!r || r.__timeout) return { verdict: 'skip', reason: 'timeout', query };
    const emails = extractEmails((r && r.results) || []);
    return emails.length ? { verdict: 'found', value: emails[0], query } : { verdict: 'not-found', query };
  } catch (e) {
    return { verdict: 'skip', reason: 'error' };
  }
}

module.exports = { buildFactQuery, judgeFact, followupText, verifyFact, buildAbsenceQuery, extractEmails, absenceFollowupText, verifyAbsence, _absSubject };
