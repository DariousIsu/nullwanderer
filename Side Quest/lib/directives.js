/**
 * lib/directives.js — STANDING INSTRUCTIONS Lucas has given her, that survive the turn.
 *
 * Lucas, 2026-07-21: "Looks like putting in run time feed back like this never landed."
 *
 * He was right, and there was nowhere for it to land. Measured before building:
 *
 *   · The only durable self-store is `self_model` — 60 rows, ALL epistemic 'speculated', categorised
 *     preference / insight / value / opinion / taste / identity. Favourite film, favourite book, Ada
 *     Lovelace. There is no `correction`, `instruction` or `directive` category at all.
 *   · main.js's "correction" path fires only when focus.getCurrent() returns an ACTIVE RESEARCH RUN,
 *     and only reshapes that run's meta. Correct her outside a running dossier and nothing is written
 *     anywhere.
 *
 * So runtime feedback had no capture, no store and no read-back. Three missing pieces, not one.
 *
 * ⭐ WHY THIS IS NOT A self_model CATEGORY. That store is a PERSONALITY pool: it is MMR-sampled for
 * topical diversity, ranked by a priority that rewards personality categories, and deliberately lets
 * unreinforced entries fade. Every one of those behaviours is wrong for an instruction. Zoe's history
 * has the proof — a scope order from Lucas was once stored as her own belief and then "outgrown"
 * (see the instruction-vs-belief incident, fixed in 92035fa). An instruction is not a trait she
 * formed; it is a fact about what HE asked for, and it stays until he says otherwise.
 *
 * Hence: its own table, always-on rendering, no sampling, no decay, provenance on every row.
 */
'use strict';
const db = require('./db');

const MAX_ACTIVE = 24;          // rendered in full; beyond this the oldest are dropped from the block
const MAX_LEN = 400;

// ── DETECTION ───────────────────────────────────────────────────────────────────────────────────
//
// Conservative by construction: over-capture is the real risk. Storing every passing remark as a
// standing rule would fill her prompt with noise and make the genuine instructions unfindable — and
// this codebase already learned that lesson the other way round, distilling a prompt INSTRUCTION
// into a "learning" (the heartbeat-silence incident).
//
// A directive needs BOTH:
//   1. a persistence marker — this is about more than the current turn
//   2. a behavioural verb aimed at HER
const _PERSIST = /\b(?:always|never|from now on|going forward|in future|from here on|stop|don'?t ever|no longer|whenever you|any time you|each time you|as a rule|by default|permanently)\b/i;
const _AT_HER = /\b(?:you|your|yourself)\b/i;
// The verb list is the precision knob, and it is easy to under-fill: an early draft missed "always
// CITE the source for a number", which is about as clear an instruction as he could give. Additions
// belong here rather than loosening the persistence or aimed-at-her tests, which are what keep the
// detector from capturing ordinary conversation.
const _BEHAVIOUR = /\b(?:say|said|write|written|answer|reply|respond|use|using|call|check|ask|tell|show|give|report|claim|assume|guess|search|look|read|build|make|render|format|treat|keep|start|stop|include|omit|skip|prefer|default|route|send|post|cite|source|verify|confirm|name|list|mark|flag|label|attach|link|open|close|log|track|note|summari[sz]e|draft|package|brand|deliver)\b/i;
// Not a directive: a question, or Lucas describing HIMSELF or the world.
const _QUESTION = /\?\s*$/;
const _ABOUT_HIM = /^\s*(?:i|we|my|our)\b/i;

/**
 * Does this message set a standing rule for how she works? Returns the normalised rule, or null.
 * Pure — no DB, no model — so it is cheap enough to run on every turn and testable offline.
 */
function detect(text) {
  const raw = String(text || '').trim();
  if (!raw || raw.length < 8 || raw.length > 600) return null;
  // Take the clause that carries the instruction, not the whole paragraph.
  const sentences = raw.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  for (const s of sentences) {
    if (_QUESTION.test(s)) continue;
    if (_ABOUT_HIM.test(s) && !_AT_HER.test(s)) continue;
    if (!_PERSIST.test(s)) continue;
    if (!_AT_HER.test(s) && !/^\s*(?:always|never|stop|don'?t|from now on)\b/i.test(s)) continue;
    if (!_BEHAVIOUR.test(s)) continue;
    return s.slice(0, MAX_LEN);
  }
  return null;
}

// ── STORE ───────────────────────────────────────────────────────────────────────────────────────

/** Record a standing instruction, in HIS words, with the turn it came from. Idempotent-ish. */
function record(rule, { turnId = null, now = Date.now() } = {}) {
  const text = String(rule || '').trim().slice(0, MAX_LEN);
  if (!text) return null;
  try {
    const existing = db.getDirectives ? db.getDirectives({ activeOnly: true }) : [];
    const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, ' ').trim();
    const dup = existing.find((d) => norm(d.rule) === norm(text));
    if (dup) { db.touchDirective(dup.id, now); return { id: dup.id, duplicate: true }; }
    return db.insertDirective({ rule: text, sourceTurnId: turnId, ts: now });
  } catch (e) { console.error('[directives] record failed:', e.message); return null; }
}

function active() { try { return db.getDirectives({ activeOnly: true }) || []; } catch { return []; } }
function retire(id) { try { return db.retireDirective(id); } catch { return false; } }

/**
 * The prompt block. ALWAYS rendered in full — never sampled, never ranked against her personality,
 * never allowed to fade. Newest last, so the most recent correction is the freshest thing she reads.
 */
function buildBlock({ userName = 'Lucas', rows = null } = {}) {
  const list = (rows || active()).slice(-MAX_ACTIVE);
  if (!list.length) return null;
  const tz = (() => { try { return require('./tz'); } catch { return null; } })();
  const when = (ts) => (tz ? tz.dateShort(ts) : new Date(ts).toISOString().slice(0, 10));
  const lines = list.map((d) => `  • ${d.rule}${d.created_ts ? `   — ${userName}, ${when(d.created_ts)}` : ''}`);
  return `STANDING INSTRUCTIONS FROM ${userName.toUpperCase()} — he told you these directly and they hold until he says otherwise. `
    + `They are NOT your own preferences and you do not get to outgrow them; if one now seems wrong, say so and ask, do not quietly stop following it:\n`
    + lines.join('\n');
}

module.exports = { detect, record, active, retire, buildBlock, MAX_ACTIVE, MAX_LEN, _PERSIST, _AT_HER, _BEHAVIOUR };
