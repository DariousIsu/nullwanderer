/**
 * lib/dig.js — THE MID-CONVERSATION DIG (catalog §7, slice 4b, 2026-07-23).
 *
 * N5's gap, named in the needs lens: "Mid-chat search is crammed into turn latency (operator 4
 * steps/45s); she cannot fork a dig and keep talking; what she learns rarely loops back into talk."
 * Unlocked by Lucas's 2026-07-23 concurrency ruling (≤3 DISTINCT models in flight; same-model
 * concurrency unbounded): the reply rides the reserved chat slot while a bounded same-model dig
 * runs on a pool slot.
 *
 * The organ, mechanically: a chat turn may emit <dig>question</dig>. The tag is stripped like every
 * tool tag; the question becomes a LINE OF INQUIRY (lib/inquiry) whose born_from is the CONVERSATION
 * TURN that asked — §6 L1: the return address rides the OBJECT, not the code path. One touch runs
 * immediately if a pool slot is free; no slot → the inquiry is BANKED and the autonomy tick advances
 * it (a cap may defer, never disappear). Either way, the first real finding comes home through the
 * announce door addressed to the talk: "about the X you asked — here's what I found."
 *
 * This module is the PURE half (parse/strip/addressing/judgment/message shapes) so the gate can
 * prove it offline. The orchestration (slot, operator run, announce) lives in main.js beside the
 * advance-inquiry block it mirrors.
 */
'use strict';

const str = (v) => (v == null ? '' : String(v));

// Complete pairs only — format narration ("use <dig>") can never produce a dispatch.
const DIG_RE = /<dig>([\s\S]*?)<\/dig>/gi;

function parseDigTags(text) {
  const out = [];
  const s = str(text);
  let m;
  DIG_RE.lastIndex = 0;
  while ((m = DIG_RE.exec(s)) !== null) {
    const q = str(m[1]).replace(/\s+/g, ' ').trim();
    if (q.length >= 15) out.push({ question: q });   // inquiry.open's own floor — shorter refuses there anyway
  }
  return out;
}

function stripDigTags(text) {
  return str(text).replace(DIG_RE, '').replace(/<\/?dig>/gi, '');
}

// §6 L1 — the return address, written into born_from at open. TWO shapes carry a conversation
// address: the DIG convention this module writes ("conversation turn #N — ..."), and the
// HARVEST-born shape the decider writes when a mined conversation lead opens an inquiry
// ("Born from conversation [d8269] where Lucas asked ...", "Conversation harvest [d8271] ...").
// Both deserve the homecoming — the address rides the OBJECT, however it was written — but only
// the dig shape may claim the minutes-ago frame (isDigBorn splits them for the voice).
function bornFrom(turnId, userLine) {
  const snippet = str(userLine).replace(/\s+/g, ' ').trim().slice(0, 110);
  return `conversation turn #${Number(turnId) || 0} — "${snippet}"`.slice(0, 160);
}
function isDigBorn(row) {
  return /^conversation turn #\d+/i.test(str(row && row.born_from));
}
function isConversationBorn(row) {
  const bf = str(row && row.born_from);
  return /^conversation turn #\d+/i.test(bf) || /\bconversation\b[\s\S]{0,40}\[d\d+\]/i.test(bf);
}

// The touch preamble — tells the operator run WHERE this question was born and where the answer
// is going, so it researches the asked thing instead of re-deriving a mission.
function digHeader(row) {
  return `THIS IS A DIG FORKED FROM A LIVE CONVERSATION (${str(row && row.born_from) || 'the chat'}). ` +
    `Lucas raised this in talk minutes ago; your finding returns TO that conversation. ` +
    `Research the question as asked — grounded, cited, bounded. If the conversation context below ` +
    `disambiguates the question, trust it over any other reading.`;
}

// A REAL finding earns the homecoming (and marks delivery); a dry continue is honest but doesn't
// close the promise — the first real finding from ANY later touch still comes home.
function hasRealFinding(env) {
  if (!env) return false;
  if (env.status === 'answered' || env.status === 'dead_end') return true;
  return Array.isArray(env.new_evidence) && env.new_evidence.length > 0;
}

// Deterministic homecoming — the guaranteed fallback when the voice model is unreachable. Honest in
// all three shapes: found something / resolved it / came up dry and still looking.
function returnFallback({ question, env, closedStatus = null } = {}) {
  const q = str(question).slice(0, 120);
  if (!env) {
    return `About what you asked — "${q}" — I went digging but the run didn't come back with anything I can stand behind yet. I've kept the question open and I'll keep working it.`;
  }
  const learned = str(env.learned).slice(0, 500);
  if (closedStatus === 'closed_dead_end') {
    return `About what you asked — "${q}" — I ran it down and I don't think it's answerable with what's out there: ${learned}`;
  }
  if (hasRealFinding(env)) {
    const cites = (env.new_evidence || []).map((e) => str(e.cite)).filter(Boolean).slice(0, 3);
    return `About what you asked — "${q}" — here's what I found: ${learned}${cites.length ? ` (sources: ${cites.join(' · ')})` : ''}`;
  }
  return `About what you asked — "${q}" — nothing solid yet: ${learned || 'the first pass came up dry.'} The question's still open on my board.`;
}

// The voice-written homecoming (condenseComplete in main.js; persona is prepended there). Grounded
// HARD in the write-back — the same no-fabrication contract as the research-complete engagement gen.
function returnPromptParts({ question, env, uname = 'Lucas', mode = 'dig' } = {}) {
  const ev = (env && env.new_evidence) || [];
  // The frame must be HONEST about when the ask happened: a dig forked minutes ago mid-talk vs a
  // harvest-born question carried from an earlier conversation and worked since.
  const opening = mode === 'harvest'
    ? `In a recent conversation, ${uname} asked for something you took away and have been working on since. The work just landed — speak to ${uname} now, IN YOUR OWN VOICE, bringing the answer back:`
    : `Minutes ago, mid-conversation, ${uname} raised a question and you forked a background dig on it while the talk went on. The dig just came back — speak to ${uname} now, IN YOUR OWN VOICE, returning to what was asked:`;
  const sys = `${opening} (1) open by anchoring to the question ("about the X you asked…") so it lands in the right thread of the talk; (2) give what you actually found — the substance, not a status report; (3) if the evidence is thin or the question resolved as unanswerable, say so plainly. Ground EVERYTHING in the dig results below; do not invent findings, sources, or confidence you don't have. 2-4 sentences, warm and direct, no headings or bullets. Start directly with what you'd say.`;
  const user = [
    `THE QUESTION (as forked): ${str(question).slice(0, 300)}`,
    `WHERE IT LANDED: ${str(env && env.learned).slice(0, 700) || '(no write-back — the run returned nothing usable)'}`,
    ev.length ? `EVIDENCE:\n${ev.slice(0, 6).map((e) => `- ${str(e.gist).slice(0, 200)}${e.cite ? ` [${str(e.cite).slice(0, 100)}]` : ''}`).join('\n')}` : 'EVIDENCE: none this touch.',
    `STATUS: ${str(env && env.status) || 'no write-back'}`,
  ].join('\n\n');
  return { sys, user };
}

module.exports = { parseDigTags, stripDigTags, bornFrom, isDigBorn, isConversationBorn, digHeader, hasRealFinding, returnFallback, returnPromptParts };
