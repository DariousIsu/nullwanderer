'use strict';
/**
 * lib/contacts_recovery.js — recover a PROMISED-but-unfired "contacts on your canvas" (2026-08-17 audit).
 *
 * The contacts→canvas lane (main.js) fires only when the contacts-intent classifier reads the USER message as a
 * "show me the list" query. On 2026-08-15 Lucas said "we want to invite some Louisiana federal electeds to the
 * Monroe event" — read as conversation (isQuery:false), so the lane never fired — yet her free-form reply then
 * CLAIMED "I put 183 Louisiana elected-official contacts on your canvas." Nothing landed; the anti-fab gate
 * shipped an honest correction. But the correction is only the NEGATION — the thing she said she did never
 * happens. This is the contacts/canvas twin of lib/image_intent: detect the unfired commitment and RECOVER the
 * FILTER she meant, so the harness can actually put the held contacts on the canvas and make her words true.
 *
 * Per the detectors-vs-comprehension cure: a cheap regex PREFILTER (a false nominate costs one classifier call)
 * gates a bounded model that EXTRACTS the filter or answers NONE. FAILS CLOSED — any error/ambiguity → null (no
 * dispatch), because dumping the wrong contacts on the canvas is worse than missing one recovery. Mirrors
 * lib/image_intent / lib/renag_judge: tiny prompt, temperature 0, its own cloud model, injectable classify.
 */
const { streamChat } = require('./ollama');
const config = require('./config');

// The claim SHAPE: she asserts (completed, not future) that contacts/people are on the canvas or in the DB.
// Broad on purpose — the classifier is the real gate; the regex only avoids paying it on ordinary chat.
const _PLACED = "put|placed|added|dropped|posted|loaded|dumped|populated|filled|threw|threw up|got|pulled up|laid out|is on|are on|it'?s on|they'?re on|now on|onto|saved|stored|recorded";
const _NOUN = "contacts?|people|officials?|electeds?|reps?|representatives?|senators?|legislators?|names?|list of (?:contacts?|people|officials?|electeds?)|roster";
const _WHERE = "canvas|contacts? (?:database|db|list)|crm";
const _CLAIM_RE = new RegExp(
  `\\b(?:${_PLACED})\\b[^.!?\\n]{0,80}\\b(?:${_NOUN})\\b[^.!?\\n]{0,60}\\b(?:${_WHERE})\\b`
  + `|\\b(?:${_NOUN})\\b[^.!?\\n]{0,60}\\b(?:${_PLACED})\\b[^.!?\\n]{0,40}\\b(?:${_WHERE})\\b`,
  'i');

/** Cheap pure prefilter: does the reply CLAIM contacts were placed on the canvas / saved to the DB? */
function looksLikeUnfiredContactsClaim(say) { return _CLAIM_RE.test(String(say || '')); }

const MODEL = config.importanceModel();

// Normalize the model's raw output into a contacts-query ask ({state,type,sectors,subject}) or null. Fail-closed:
// NONE / no usable filter → null (never dispatch a blank/whole-CRM dump).
function _parseAsk(raw) {
  const first = String(raw || '').split(/\n/).map((l) => l.trim()).filter(Boolean)[0] || '';
  if (!first || /^none\b/i.test(first)) return null;
  const get = (k) => { const m = first.match(new RegExp(`\\b${k}\\s*=\\s*([^;|]+)`, 'i')); return m ? m[1].trim() : ''; };
  const stateRaw = get('state');
  const typeRaw = get('type').toLowerCase();
  const sectorsRaw = get('sectors');
  const subject = get('subject') || first.slice(0, 100);
  // A US state 2-letter code, or a name we pass through for main's resolver. Empty/UNKNOWN → drop the field.
  const state = /^(unknown|none|n\/a)?$/i.test(stateRaw) ? '' : stateRaw.slice(0, 40);
  let type = /^(elected|corporate|gov|government|official|activist|all)$/i.test(typeRaw) ? typeRaw : '';
  if (type === 'government') type = 'gov';        // cq.select branches on corporate|gov|elected
  if (type === 'official') type = 'elected';
  const sectors = sectorsRaw && !/^(unknown|none|n\/a)$/i.test(sectorsRaw)
    ? sectorsRaw.split(/[,/]/).map((x) => x.trim().toLowerCase()).filter(Boolean).slice(0, 6) : [];
  // A recovery needs SOMETHING to filter on — a bare "put contacts on the canvas" with no state/type/sector is
  // too broad to dispatch safely (it would dump the whole CRM). Require at least one concrete filter.
  if (!state && !type && !sectors.length) return null;
  return { isQuery: true, state, type, sectors, subject, recovered: true };
}

/**
 * recoverContactsFilter(say, opts?) → Promise<ask|null>
 * Returns a contacts-query ask ({state,type,sectors,subject}) to put on the canvas, or null when she did NOT
 * actually commit to placing a SPECIFIC set of held contacts (a vague/whole-CRM claim, an offer, a reference to
 * something already delivered) or on ANY failure (FAIL CLOSED).
 */
async function recoverContactsFilter(say, { classify = null, model = MODEL } = {}) {
  const text = String(say == null ? '' : say).trim();
  if (!text || !looksLikeUnfiredContactsClaim(text)) return null;

  const ask =
`An AI assistant just replied to a user and CLAIMED it put a set of contacts/people on the canvas (or saved them to the contacts database) — but it did NOT actually do it (nothing landed).

Its reply:
"""
${text.slice(0, 1200)}
"""

If it committed to placing a SPECIFIC, filterable set of contacts it ALREADY HOLDS (e.g. "Louisiana elected officials", "the FL activist orgs", "Senators on the Commerce committee"), output ONE line of the form:
STATE=<US state name or 2-letter code, or UNKNOWN> | TYPE=<elected|corporate|government|activist|all, or UNKNOWN> | SECTORS=<comma list, or UNKNOWN> | SUBJECT=<short label of the list>
Use ONLY what the reply itself specifies; write UNKNOWN for any field it did not name.
If it did NOT commit to a specific held set — a vague "some contacts", a whole-database claim with no filter, a mere offer, or a reference to a list already delivered — output exactly: NONE

Answer:`;

  let raw = '';
  try {
    if (typeof classify === 'function') { raw = String(await classify(ask) || ''); }
    else {
      await streamChat({
        model,
        messages: [{ role: 'user', content: ask }],
        options: { temperature: 0, top_p: 1, num_ctx: 8192, num_predict: 120 },
        think: false,
        onToken: (tk) => { raw += tk; },
      });
    }
  } catch (e) { try { console.error('[contacts_recovery] classify failed:', e.message); } catch {} return null; }   // FAIL CLOSED

  return _parseAsk(raw);
}

module.exports = { recoverContactsFilter, looksLikeUnfiredContactsClaim, _parseAsk, _CLAIM_RE, MODEL };
