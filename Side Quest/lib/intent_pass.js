/**
 * lib/intent_pass.js — W1 of the CHAT-PATH SIMPLIFICATION (docs/CHAT_PATH_SIMPLIFICATION_2026-08-29.md).
 *
 * ONE decision point per user turn. The existing regex nets stay as instant fast-paths — they are
 * precise when they fire; their disease was only what they missed — and any turn they don't catch
 * gets ONE bounded model classification into a CLOSED vocabulary. The doors then EXECUTE the one
 * verdict instead of each re-deciding. The evidence on both sides: the leak ledger (five one-word
 * net widenings in 24 hours, every one found by failing live) and the leg-6 false positive
 * ("Taking the quiet morning to do some work on your systems" → route=task + a canvas edit on a
 * social sentence). Enumeration cannot cover language; comprehension can.
 *
 * Invariants: cloud down → verdict null → today's nets alone (the pass only ever ADDS recall).
 * The classifier reads THE SAME rolling assembly the reply reads (§62b) and carries the live-
 * window authority line (catch #7). When unsure between deliver and chatter, chatter — a dropped
 * order re-asks in one turn; a false claim spawns work.
 */
'use strict';

const INTENTS = new Set(['deliver', 'edit', 'redirect', 'status', 'question', 'chatter', 'control', 'clarify']);
const SIZES = new Set(['brief', 'report', 'dossier']);
const FRESH_MS = 90 * 1000;

// The nets, as fast-paths. A hit is final — no model consulted.
function fastPath(text) {
  const s = String(text || '');
  if (!s.trim()) return null;
  try {
    const ic = require('./intake_contract');
    const order = ic.detectDeliverableOrder(s);
    if (order) return { intent: 'deliver', deliverable: order.deliverable, topic: order.topic, target: order.target, referent: null, size: null, confidence: 1, via: 'net:order' };
    if (typeof ic.detectEditIntent === 'function' && ic.detectEditIntent(s)) return { intent: 'edit', deliverable: null, topic: null, referent: null, size: null, confidence: 1, via: 'net:edit' };
  } catch {}
  try {
    const dr = require('./document_road');
    if (dr.anaphoricOrder(s)) {
      const hit = dr.resolveAnaphor();
      if (hit) return { intent: 'deliver', deliverable: 'report', topic: hit.title || hit.slug, referent: hit.slug, size: null, confidence: 1, via: 'net:anaphor' };
    }
  } catch {}
  try {
    const { PAPER_VERB_RE } = require('./paper_finalize');
    if (PAPER_VERB_RE.test(s)) return { intent: 'deliver', deliverable: 'report', topic: null, referent: null, size: null, confidence: 1, via: 'net:finalize' };
  } catch {}
  return null;
}

// The bounded comprehension pass. deps.ask injectable for smokes; the live door is cloud_logic.ask.
async function classify(text, { windowText = '', deps = {} } = {}) {
  const ask = deps.ask || require('./cloud_logic').ask;
  const v = await ask({
    // 'interactive' is NEVER deferred (quota.js TIER) — the comprehension of a live user turn must
    // not lose to idle graph-walking (08-29: two quota nulls, one causal in the #4109 confabulation).
    // 320 (was 220): trace#104823 shows a truncated verdict JSON failing validation when a long
    // topic/referent rides — the classifier's whole output must always fit.
    task: 'intent_pass', v: 1, numPredict: 320, think: false, lane: 'interactive',
    input: {
      latest_turn: String(text || '').slice(0, 600),
      conversation_window: String(windowText || '').slice(0, 4000),
      rule: 'THE LIVE CONVERSATION WINDOW ABOVE OUTRANKS ANY OTHER MEMORY. Classify the LATEST turn only.',
    },
    want: 'STRICT JSON only: {"intent":"deliver|edit|redirect|status|question|chatter|control","deliverable":"<noun or null>","topic":"<short phrase or null>","referent":"<what that/it points at, or null>","size":"brief|report|dossier|null","confidence":0.0-1.0}. deliver = they want a DOCUMENT-shaped artifact (a report, list, dossier, brief, table, file) produced or finished — information, an answer, or a lookup told to them in chat is NEVER deliver. question = they want to be TOLD something in chat: an answer, a fact, a lookup ("go get/find/look up the information", "what did you find") — answer it, produce nothing. edit = change an existing artifact in place. redirect = switch what work is focused on. status = asking how work is going. chatter = social talk, thinking aloud, or commentary about work — NOT an instruction to do it. control = stop/pause/confirm. Resolve referent FROM THE CONVERSATION WINDOW: what does "it/that/the information" point at? If the order\'s object is a bare reference you cannot resolve from the window, say so by setting referent to null and confidence no higher than 0.5. When unsure between deliver and chatter, answer chatter; when unsure between deliver and question, answer question.',
    // cloud_logic's validator CONTRACT: called with the RAW STRING, must return {valid, value}
    // (leg 7's second catch — a boolean predicate here made every classify fail silently).
    validate: (raw) => {
      try {
        const m = String(raw || '').match(/\{[\s\S]*\}/);
        if (!m) return { valid: false, error: 'no JSON object in the response' };
        const o = JSON.parse(m[0]);
        if (!o || !INTENTS.has(o.intent) || typeof o.confidence !== 'number') return { valid: false, error: 'missing or out-of-vocabulary intent/confidence' };
        return { valid: true, value: o };
      } catch (e) { return { valid: false, error: e.message }; }
    },
  });
  if (!v) return null;
  const out = {
    intent: INTENTS.has(v.intent) ? v.intent : 'chatter',
    deliverable: v.deliverable && v.deliverable !== 'null' ? String(v.deliverable).slice(0, 60) : null,
    topic: v.topic && v.topic !== 'null' ? String(v.topic).slice(0, 140) : null,
    referent: v.referent && v.referent !== 'null' ? String(v.referent).slice(0, 140) : null,
    size: SIZES.has(v.size) ? v.size : null,
    confidence: Math.max(0, Math.min(1, Number(v.confidence) || 0)),
    via: 'model',
  };
  // THE ARTIFACT-NOUN LAW (the 08-29 live miss: "just go get the information" → deliver:information
  // at 0.99 → an unrequested wrong-topic document, twice). A deliver verdict whose deliverable is
  // not a document-shaped noun is a want-to-be-TOLD — it demotes to question and nothing composes.
  // The regex nets have always required an artifact noun; the model path gets the same floor.
  if (out.intent === 'deliver') {
    let artifact = false;
    try { artifact = !!(out.deliverable && require('./intake_contract').artifactNoun(out.deliverable)); } catch {}
    if (!artifact) { out.intent = 'question'; out.via = 'model:demoted-non-artifact'; }
  }
  // Low-confidence deliver never silently spawns work — it becomes a clarify (the design's D1).
  if (out.intent === 'deliver' && out.confidence < 0.55) out.intent = 'clarify';
  return out;
}

// One verdict per turn: computed once, cached by text, read by every door via current().
let _last = null;
async function intentPass(text, { windowText = '', deps = {}, nowMs = Date.now() } = {}) {
  if (_last && _last.text === text && nowMs - _last.ts < FRESH_MS) return _last.verdict;
  let verdict = fastPath(text);
  if (!verdict) {
    try { verdict = await classify(text, { windowText, deps }); }
    catch (e) { console.error('[intent] classify failed (nets alone this turn):', e.message); }
  }
  if (verdict) console.log(`[intent] ${verdict.intent}${verdict.deliverable ? `:${verdict.deliverable}` : ''} (${verdict.via}, conf ${verdict.confidence.toFixed(2)})${verdict.referent ? ` — referent: ${String(verdict.referent).slice(0, 60)}` : ''}`);
  else console.log('[intent] no verdict (classifier unavailable) — the nets alone govern this turn');
  _last = { text: String(text || ''), ts: nowMs, verdict: verdict || null };
  return verdict;
}

function current({ nowMs = Date.now() } = {}) {
  return _last && nowMs - _last.ts < FRESH_MS ? _last.verdict : null;
}

function _resetForTest() { _last = null; }

module.exports = { fastPath, classify, intentPass, current, INTENTS, FRESH_MS, _resetForTest };
