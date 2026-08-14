'use strict';
/**
 * lib/doc_contract.js — THE DONE CONTRACT (2026-08-14, Lucas-approved design).
 *
 * "How do you decide that a document is done?" — Done is not a judgment, it is a CONTRACT signed
 * before the work starts. A model asked "is this complete?" always finds a gap, so the finish line
 * receded forever (the document false loop). The contract freezes at intake and CANNOT grow:
 *
 *   1) ENTITY ANCHOR — what the document is about, resolved once against the knowledge stores and
 *      carried as a hard veto in every pass. The live failure it kills: thread #3869 read "applied
 *      digital" as a CONCEPT (digital transformation, applied) and researched the UK Government
 *      Digital Service / GOV.UK Pay under Lucas's data-center paper.
 *   2) FROZEN OUTLINE — the section shape locks at the FIRST finalize; a revision rewrites the
 *      same sections, it never adds scope.
 *   3) DRY SIGNAL — the autonomous finalize trigger is dryness, not sufficiency: when consecutive
 *      passes stop adding fragment material, more passes won't help; finalize ONCE and state the
 *      gaps inside the artifact. Auto-finalize never fires twice — revisions are Lucas's ask.
 *
 * State = one meta row per thread (doc_contract.<threadId>); every mutator is freeze-once or
 * write-once, so the plan cannot grow through this organ. Pure decisions; db is the only I/O.
 */
const crypto = require('crypto');
const db = require('./db');

const KEY = (threadId) => `doc_contract.${threadId}`;
const SIG_KEEP = 5;          // gather signatures retained (dryness needs 3)
const DRY_RUN_COUNT = 3;     // last 3 identical sigs = two consecutive passes added nothing

function get(threadId) {
  try { const v = db.getMeta(KEY(threadId)); return v ? JSON.parse(v) : null; } catch { return null; }
}
function _save(threadId, c) { try { db.setMeta(KEY(threadId), JSON.stringify(c)); } catch {} }

/** Freeze the contract ONCE. A second freeze returns the existing contract untouched — the
 *  plan cannot regrow by re-freezing with a broader topic. */
function freeze({ threadId, topic, entity = null, now = Date.now() } = {}) {
  const cur = get(threadId);
  if (cur) return { ...cur, justFrozen: false };
  const c = { topic: String(topic || '').trim(), entity, outline: null, sigs: [], finalizedSig: null, frozenTs: now };
  _save(threadId, c);
  return { ...c, justFrozen: true };
}

/** The outline locks at first finalize — write-once; later calls return the stored outline. */
function setOutline(threadId, outline) {
  const c = get(threadId);
  if (!c) return null;
  if (Array.isArray(c.outline) && c.outline.length) return c.outline;
  c.outline = (outline || []).slice(0, 12);
  _save(threadId, c);
  return c.outline;
}

/** The anchor CONTROL line folded into every pass. With a resolved entity it names it; without,
 *  it still pins the topic AS WRITTEN — the cure for concept-reinterpretation drift either way. */
function anchorLine(contract) {
  if (!contract || !contract.topic) return '';
  if (contract.entity && contract.entity.name) {
    return `TARGET ANCHOR (frozen at intake): this run is about ${contract.entity.name} — resolved from the knowledge stores as: ${String(contract.entity.evidence || contract.entity.name).replace(/\s+/g, ' ').slice(0, 240)}. Material about any OTHER entity that merely shares words with "${contract.topic}" is OFF-TARGET: drop it, do not rationalize a connection.`;
  }
  return `TARGET ANCHOR (frozen at intake): the research subject is EXACTLY the topic as written — "${contract.topic}". Never reinterpret it as a general concept or substitute a same-words-different-entity subject; material about a different entity sharing these words is OFF-TARGET: drop it.`;
}

/** Deterministic signature of the gathered material — sorted file:size pairs, hashed.
 *  Accepts gatherFragments rows ({file, text}) or finalize's fragmentStats ({file, len}). */
function gatherSignature(fragments) {
  const parts = (fragments || []).map((f) => `${f.file}:${f.len != null ? f.len : (f.text || '').length}`).sort();
  if (!parts.length) return '';
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16);
}

/** Record the gather state seen at the START of a pass. Returns the updated sig list. */
function recordGatherSig(threadId, sig) {
  const c = get(threadId);
  if (!c) return null;
  c.sigs = [...(c.sigs || []), String(sig || '')].slice(-SIG_KEEP);
  _save(threadId, c);
  return c.sigs;
}

/** Dry = the last DRY_RUN_COUNT recorded signatures are identical and non-empty. */
function isDry(threadId) {
  const c = get(threadId);
  if (!c || !Array.isArray(c.sigs) || c.sigs.length < DRY_RUN_COUNT) return false;
  const tail = c.sigs.slice(-DRY_RUN_COUNT);
  return tail[0] !== '' && tail.every((s) => s === tail[0]);
}

function markFinalized(threadId, sig) {
  const c = get(threadId);
  if (!c) return;
  c.finalizedSig = String(sig || 'finalized');
  _save(threadId, c);
}

/** Auto-finalize fires at dryness, ONCE per contract. After that, revisions are Lucas's ask. */
function shouldAutoFinalize(threadId) {
  const c = get(threadId);
  return !!c && !c.finalizedSig && isDry(threadId);
}

/** The repair door: a wrongly-frozen contract (bad topic derivation, wrong entity) must be
 *  clearable — freeze-once with no unfreeze would pin the mistake forever. */
function clear(threadId) { try { db.setMeta(KEY(threadId), ''); } catch {} }

/** Parse a search_entities result into an anchor ONLY when the resolved name plausibly IS the
 *  topic. FIRST LIVE MISFIRE (#3882, minutes after deploy): topic "search sponsor" semantically
 *  matched "Hunt (WA)" — a legislative BILL sponsor — the naive first-line parse stored the raw
 *  JSON blob as the "name", and the anchor steered an event-sponsor search into the WA
 *  Legislature. Two gates: parse the JSON shape for the real name/summary, and REQUIRE a shared
 *  distinctive token between name and topic — a resolution that doesn't name the topic is a
 *  spurious semantic hit, and NO anchor (topic-as-written) beats a wrong one. */
function entityAnchorFrom(topic, rawText) {
  const raw = String(rawText || '').trim();
  if (!raw || !topic) return null;
  let name = '', summary = '';
  const jm = raw.match(/\{[\s\S]*?\}/);
  if (jm) { try { const o = JSON.parse(jm[0]); name = String(o.name || '').trim(); summary = String(o.summary || '').trim(); } catch {} }
  if (!name) name = (raw.split('\n').map((s) => s.trim()).filter(Boolean)[0] || '').slice(0, 120);
  if (!name || name.startsWith('[') || name.startsWith('{')) return null;   // never a raw blob as a name
  const toks = (s) => new Set(String(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length >= 3));
  const t = toks(topic), n = toks(name);
  let shared = 0; for (const w of t) if (n.has(w)) shared++;
  if (shared === 0) return null;
  return { name: name.slice(0, 120), evidence: (summary || name).replace(/\s+/g, ' ').slice(0, 300) };
}

module.exports = { get, freeze, clear, setOutline, anchorLine, entityAnchorFrom, gatherSignature, recordGatherSig, isDry, markFinalized, shouldAutoFinalize, DRY_RUN_COUNT };
