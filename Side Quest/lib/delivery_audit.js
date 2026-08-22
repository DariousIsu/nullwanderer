'use strict';
// ── VERIFY BEFORE ANNOUNCE (Phase 4, the last phase) ────────────────────────────────────────────
// docs/DOCUMENT_PRODUCTION_PLAN_2026-08-21.md §3 Phase 4: a deterministic pre-announce audit on
// every composed document — artifact non-empty · topic-relevant · the spec's named scope present ·
// the numbers ARE the dataset's · a data-shaped topic is never served prose over a starved
// dataset. Any violation → honest non-delivery (the caller reports the GAP and what it needs);
// the done-claim is structurally unreachable for a wrong artifact. Pure — the caller supplies
// everything; nothing here reads stores or announces.

const reg = require('./artifact_registry');
const { STATE_CODES } = require('./legis_acquire');

const MIN_BODY = 300;   // below this a "report" is a husk, whatever it says

/** States NAMED in the topic/spec (full names) → [{name, code}]. */
function namedStates(text) {
  const t = String(text || '').toLowerCase();
  const out = [];
  for (const [name, code] of Object.entries(STATE_CODES)) {
    if (new RegExp(`\\b${name}\\b`, 'i').test(t)) out.push({ name, code });
  }
  return out;
}

/**
 * audit({ topic, body, dsRows, dataShaped, doneScope }) → { ok, violations: [{check, detail}] }.
 *   topic      the project topic (his spec words)
 *   body       the FULL composed document (narrative + the appended data section)
 *   dsRows     the project's dataset rows at compose time
 *   dataShaped whether an acquirer matched the topic (a data deliverable)
 *   doneScope  scope items marked done — their content must actually be present
 * OPEN scope items are declared debt and never audited against the body.
 */
function audit({ topic = '', body = '', dsRows = [], dataShaped = false, doneScope = [] } = {}) {
  const violations = [];
  const b = String(body || '');
  const bLow = b.toLowerCase();

  // 1. substance — a husk is not a report
  if (b.trim().length < MIN_BODY) violations.push({ check: 'husk', detail: `${b.trim().length}ch < ${MIN_BODY} floor` });

  // 2. topic relevance — at least half the topic's content tokens (min 2) appear in the body
  const toks = reg.tokensOf(topic);
  if (toks.length >= 2) {
    const present = toks.filter((w) => bLow.includes(w));
    const need = Math.max(2, Math.ceil(toks.length / 2));
    if (present.length < need) violations.push({ check: 'off-topic', detail: `${present.length}/${toks.length} topic tokens in the body (need ${need})` });
  }

  // 3. named-scope coverage — every state the SPEC names must appear (name or code; the data
  //    section's "By state: TX 99" counts). A missing state is a REPORTABLE GAP, not a silent hole.
  const missing = namedStates(topic).filter(({ name, code }) =>
    !new RegExp(`\\b${name}\\b`, 'i').test(b) && !new RegExp(`\\b${code}\\b`).test(b));
  if (missing.length) violations.push({ check: 'scope-missing', detail: missing.map((m) => m.name).join(', ') });

  // 4. done scope items — "done" means the content is actually in the document
  for (const item of doneScope) {
    const iToks = reg.tokensOf(item);
    if (iToks.length && !iToks.some((w) => bLow.includes(w))) violations.push({ check: 'done-scope-absent', detail: String(item).slice(0, 80) });
  }

  // 5. the numbers ARE the dataset's — the data section's Total must equal SELECT COUNT
  if (dsRows.length) {
    const m = b.match(/\*\*Total: (\d+)\*\*/);
    if (!m) violations.push({ check: 'data-section-missing', detail: `${dsRows.length} rows held but no deterministic Total in the document` });
    else if (Number(m[1]) !== dsRows.length) violations.push({ check: 'count-drift', detail: `document says ${m[1]}, the dataset holds ${dsRows.length}` });
  }

  // 6. THE STARVED DATASET (the adversarial gate): a data-shaped topic with ZERO rows must never
  //    ship as prose — the honest move is the gap report ("I could not acquire the data").
  if (dataShaped && !dsRows.length) violations.push({ check: 'dataset-starved', detail: 'the topic is data-shaped but acquisition landed no rows — report the gap, never the report' });

  // 7. QUERY-LEAK (the P4 adversarial catch, 2026-08-22): every query that FED the dataset must
  //    be made of the topic's own content tokens. A leaked order-verb ("build") once landed 50
  //    generic construction bills as a nonsense project's data — and the report passed its audit
  //    on poisoned fuel. Rows without query tags (e.g. civic-store rows) are exempt.
  if (dsRows.length) {
    const topicToks = new Set(toks);
    const leaked = [...new Set(dsRows.flatMap((r) => (r.attrs && Array.isArray(r.attrs.tags)) ? r.attrs.tags : []))]
      .filter((q) => q && !String(q).toLowerCase().split(/\s+/).every((w) => topicToks.has(w)));
    if (leaked.length) violations.push({ check: 'query-leak', detail: `dataset fed by queries outside the topic: ${leaked.join(', ')}` });
  }

  // 8. SUBJECT-ANCHOR (battery-2 escape, 2026-08-22): a HALF-fabricated topic — "Blorvik-Hansen
  //    procurement bills in Vermont" — rode its REAL half past every floor above: 'procurement'
  //    landed 50 genuine rows (not starved), procurement+vermont hit the ½-token relevance floor
  //    exactly, and the feeding query was a topic token — so a 30KB garbage report DELIVERED while
  //    her own say honestly reported "no record of any Blorvik-Hansen bill". The same principle as
  //    check #3, generalized: every PROPER-NOUN token the topic names (capitalized, non-state,
  //    content-bearing) must appear in the body — a named subject absent from its own report is a
  //    reportable gap, never a silent hole. All-lowercase topics leave this check inert (honest
  //    bound; the starved and relevance checks still stand).
  {
    const stateNames = new Set(Object.keys(STATE_CODES).flatMap((n) => n.split(' ')));
    const tokSet = new Set(toks);
    const proper = [...new Set((String(topic).match(/(?<![A-Za-z])[A-Z][a-z]{2,}/g) || [])
      .map((w) => w.toLowerCase())
      .filter((w) => tokSet.has(w) && !stateNames.has(w)))];
    const absent = proper.filter((w) => !new RegExp(`\\b${w}\\b`, 'i').test(b));
    if (absent.length) violations.push({ check: 'subject-missing', detail: `the topic names ${absent.join(', ')} — absent from the entire document (a named subject the material never reached)` });
  }

  return { ok: violations.length === 0, violations };
}

/** One honest sentence per violation — the caller hands this to the gap report. */
function describe(violations) {
  return (violations || []).map((v) => `${v.check}: ${v.detail}`).join(' · ');
}

module.exports = { audit, describe, namedStates, MIN_BODY };
