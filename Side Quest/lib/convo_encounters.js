/* lib/convo_encounters.js — CONVERSATION AS AN ENCOUNTER STREAM (living conversational memory, C1).
 *
 * docs/LIVING_CONVERSATIONAL_MEMORY_DESIGN.md.
 *
 * The asymmetry this closes: every other input stream decomposes into objects — news into events,
 * documents into contacts and encounters, research into entities and relations. Conversation
 * decomposed into a ~600-char running summary and then nothing. Verified 2026-07-20: doc_contacts.js
 * was the ONLY writer to `encounters`; the chat turn path called resolveMention and the cognition
 * enrich loop, both READ-side. Conversation read from the object graph and never wrote to it — even
 * though the encounter model's own philosophy names conversation as an encounter source.
 *
 * ── THE RULE THAT MAKES THIS SAFE (Lucas, 2026-07-20) ────────────────────────────────────────────
 *
 *   "we can consider user input non-validating without documentation. so it would still create the
 *    object as an unverified and then seek to validate with a real source."
 *
 * So every encounter written here carries `authority:'stated'`, which lib/encounters excludes from the
 * independent-source count entirely. Saying a name creates the object and grades NOTHING: three
 * mentions across three months still yield `grade:null, unverified:true, sources:0`. The first real
 * document moves it. This is what stops a mis-extracted name from wearing Lucas's own authority as
 * its evidence — the one failure mode that would make conversational extraction worse than useless,
 * because a wrong fact sourced to the principal is harder to dislodge than a missing one.
 *
 * ── WHY ONLY HIS TURNS ───────────────────────────────────────────────────────────────────────────
 *
 * Her own utterances are deliberately NOT recorded. Letting her speech create encounters would let
 * her corroborate herself, which is precisely the self-sustaining-truth failure RFC 2308 exists to
 * prevent in the absence model — and she repeats entity names constantly, so it would also be the
 * loudest signal in the log.
 *
 * ── EXISTENCE ONLY ───────────────────────────────────────────────────────────────────────────────
 *
 * We record that the object was ENCOUNTERED, not what was claimed about it. Extracting relations or
 * attributes from conversation reliably is a much harder problem, and a wrong one would be a false
 * claim rather than a spurious pointer. Existence is the claim we can make honestly from a name.
 *
 * Flag-gated (`convo.encounters` meta, default OFF) and record-only: nothing reads these yet. Same
 * discipline as the route-observation log's P0 — record first, derive later, so a wrong extraction is
 * re-runnable instead of corrupting.
 */
'use strict';

const FLAG = 'convo.encounters';
const MAX_PER_TURN = 8;          // a turn mentioning more than this is a paste, not a conversation
const MIN_LEN = 3;               // "AI", "DC" are real but too ambiguous to key an object on

function enabled(getMeta) {
  try {
    const get = getMeta || ((k) => require('./db').getMeta(k));
    return get(FLAG) === '1';
  } catch { return false; }
}

// Names that are about the conversation itself, not objects in the world. Recording these would fill
// the log with pointers to ourselves.
const SELF_RE = /^(zoe|lucas|zo|lane)$/i;

// Pure: spans → encounter rows. Exported so the shape is testable without a model or a db.
function toEncounters(spans, turnId, { now = Date.now() } = {}) {
  const out = [];
  const seen = new Set();
  for (const s of (Array.isArray(spans) ? spans : [])) {
    const label = String((s && (s.text || s.mention)) || '').trim();
    // ONE TYPE VOCABULARY (T1). NER speaks `organization`; the log speaks `org`. Passing the raw kgType
    // through would file NER's mention and decompose's extraction of the SAME organization under two
    // identity keys, which nothing downstream can merge. Translate, and refuse what does not translate
    // rather than inventing a type — an unmapped span is recoverable, a split identity is not.
    const type = require('./decomp_encounters').objectTypeFor((s && (s.kgType || s.type)) || null);
    if (!label || label.length < MIN_LEN || !type) continue;
    if (SELF_RE.test(label)) continue;
    // Dedup on the REAL object identity, not a local lowercase of the string — "Marcy Delaney" and
    // "marcy  delaney" are one object, and a second notion of identity here would disagree with the
    // one the encounter log actually keys on.
    let k = null;
    try { k = require('./encounters').objectKey(type, label); } catch { k = `${type}:${label.toLowerCase()}`; }
    if (!k || seen.has(k)) continue;            // one encounter per object per turn, not per mention
    seen.add(k);
    out.push({
      object_type: type,
      object_label: label,
      claim_class: 'existence',
      claim_value: label,
      source_kind: 'conversation',
      source_ref: `turn:${turnId}`,
      // NON-VALIDATING BY CONSTRUCTION. Not 'operator' — that is Lucas handing over a document, which
      // has an artifact behind it. This is Lucas saying a name.
      authority: 'stated',
      observed_at: now,                        // for conversation the utterance date IS the source date
    });
    if (out.length >= MAX_PER_TURN) break;
  }
  return out;
}

// Record the objects a USER turn mentions. Fire-and-forget from the turn path; never throws.
// deps injectable so the smoke runs with no model and no db.
async function fromUserTurn(turnId, text, { detect = null, record = null, getMeta = null, now = Date.now() } = {}) {
  try {
    if (!turnId || !String(text || '').trim()) return 0;
    if (!enabled(getMeta)) return 0;
    const det = detect || ((t) => require('./ner').detect(t));
    const spans = (await det(String(text))) || [];
    const rows = toEncounters(spans, turnId, { now });
    if (!rows.length) return 0;
    const rec = record || ((list) => require('./encounters').recordMany(list));
    const r = rec(rows);
    return (r && typeof r.added === 'number') ? r.added : rows.length;
  } catch (e) {
    console.error('[convo_encounters] record failed:', e.message);
    return 0;                                  // extraction must never break a turn
  }
}

module.exports = { fromUserTurn, toEncounters, enabled, FLAG, MAX_PER_TURN, SELF_RE };
