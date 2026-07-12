/**
 * lib/intent_parse.js — MODEL-BASED turn intent parse (replaces the brittle regex intent-gating).
 *
 * Lucas's point, and he's right: a growing pile of hand-written regexes (_CURRENCY_RE, _OFFICE_HOLDER_Q,
 * _isBareOfficeTitle, metacognition.CURRENT_RE) kept breaking on PHRASING — "who's" vs "who is", "now" vs
 * "the", contractions — while a language model reads intent trivially. So a fast cloud model (gemma4:31b)
 * parses ONE structured intent per factual turn, and the regex cascade is demoted to a FAIL-SAFE FALLBACK
 * for when the model call is unavailable (offline / cloud down / budget). Model PRIMARY, regex fallback.
 *
 * Returns { kind, topic, needs_fresh, source }:
 *   kind        office_holder | current_fact | entity | personal | task | lookup | chitchat | other
 *   topic       the normalized thing being asked about, as a CLEAN lookup phrase ("President of the United
 *               States", "CEO of Nvidia") — for office_holder this is the OFFICE, never the guessed person.
 *               This is what fixes "who is president now?" being fed verbatim into a wiki search.
 *   needs_fresh does the answer TURN OVER (office holder, price, score, weather, news, "latest/current") →
 *               it must be verified against a fresh source, never trusted from our (possibly stale) records.
 *   source      'model' | 'fallback'
 *
 * Pure logic + dep-injected cloud call + fail-safe (never throws into a turn). Offline-testable.
 */
'use strict';

const KINDS = ['office_holder', 'current_fact', 'entity', 'personal', 'task', 'lookup', 'chitchat', 'other'];

// ---- the model path ----
const _WANT = 'Classify the user\'s message. Output ONLY a compact JSON object, no prose, no code fence.\n'
  + 'Fields:\n'
  + '- "kind": exactly one of: office_holder | current_fact | entity | personal | task | lookup | chitchat | other.\n'
  + '    office_holder = asking who CURRENTLY holds a public or corporate office/role (president, vice president, '
  + 'governor, senator, mayor, secretary, attorney general, prime minister, chancellor, chair, CEO/CFO/CTO, '
  + 'director, administrator, pope, ambassador, chief justice, ...). Phrased any way ("who runs the country", '
  + '"current potus", "who\'s in charge of the EPA").\n'
  + '    current_fact = other time-sensitive fact (price, stock, score, weather, news, "latest"/"current" of anything).\n'
  + '    entity = a timeless "who/what is X" about a specific named person, org, place, work, or event.\n'
  + '    personal = about the user or shared history ("what\'s my dog\'s name", "what did we discuss").\n'
  + '    task = an assignment to do work / research / produce something.\n'
  + '    lookup = an explicit request to search/look something up on the web.\n'
  + '    chitchat = greeting, opinion, small talk, banter, thanks.\n'
  + '    other = none of the above.\n'
  + '- "topic": the SINGLE normalized thing being asked about, as a clean lookup phrase. For office_holder give '
  + 'the OFFICE ("President of the United States", "CEO of Nvidia", "Governor of Texas"), NOT any person. For '
  + 'entity give the entity name. "" if not applicable.\n'
  + '- "needs_fresh": true if the answer changes over time and must be checked against a fresh source '
  + '(office_holder and current_fact are almost always true); false for timeless facts, personal, chitchat, task.\n'
  + 'Assume UNITED STATES context unless the message names another country/state/place (the user is American): '
  + '"the country"/"the nation"/"who runs the country"/"who\'s in charge" -> the US federal head of state; a bare '
  + 'office ("the president", "the governor") is the US one. If another place is named, use it ("president of France").\n'
  + 'Examples:\n'
  + '"who\'s the president now?" -> {"kind":"office_holder","topic":"President of the United States","needs_fresh":true}\n'
  + '"who runs the country?" -> {"kind":"office_holder","topic":"President of the United States","needs_fresh":true}\n'
  + '"who\'s in charge of the country?" -> {"kind":"office_holder","topic":"President of the United States","needs_fresh":true}\n'
  + '"who runs Nvidia?" -> {"kind":"office_holder","topic":"CEO of Nvidia","needs_fresh":true}\n'
  + '"who is Marie Curie?" -> {"kind":"entity","topic":"Marie Curie","needs_fresh":false}\n'
  + '"what\'s the weather in Paris?" -> {"kind":"current_fact","topic":"weather in Paris","needs_fresh":true}\n'
  + '"what\'s my sister\'s name?" -> {"kind":"personal","topic":"","needs_fresh":false}\n'
  + '"good morning!" -> {"kind":"chitchat","topic":"","needs_fresh":false}';

function _validate(raw) {
  let t = String(raw || '').trim().replace(/^```[a-z]*\s*|\s*```$/gi, '').trim();
  const m = t.match(/\{[\s\S]*\}/);           // tolerate a stray sentence around the JSON
  if (m) t = m[0];
  let o; try { o = JSON.parse(t); } catch { return { valid: false, error: 'not valid JSON' }; }
  if (!o || typeof o !== 'object') return { valid: false, error: 'not an object' };
  const kind = KINDS.includes(o.kind) ? o.kind : 'other';
  const topic = String(o.topic == null ? '' : o.topic).replace(/\s+/g, ' ').trim().slice(0, 120);
  const needs_fresh = o.needs_fresh === true || o.needs_fresh === 'true'
    || (o.needs_fresh == null && (kind === 'office_holder' || kind === 'current_fact'));
  return { valid: true, value: { kind, topic, needs_fresh } };
}

// Resolve the fast utility cloud model (gemma4:31b per the live cloud-model assignments); never the slow
// curator. Falls back to the literal if meta isn't set.
function _fastModel() {
  try { const m = require('./models'); return m.getModelFor('search', null) || m.getModelFor('editor', null) || 'gemma4:31b-cloud'; }
  catch { return 'gemma4:31b-cloud'; }
}

// ---- the regex fallback (only when the model call is unavailable) ----
// Kept intentionally close to the prior in-code gates so "model down" degrades to exactly the old behavior.
const _CURRENCY_RE = /\b(current(ly)?|now(adays)?|today|tonight|latest|recently|these days|right now|as of|this (?:week|month|year)|who is the|price|stock|score|weather|news|headlines?)\b/i;
const _OFFICE_HOLDER_RE = /\bwho(?:'s|\s+is|\s+are|\s+se)\b[^?.!]*\b(president|potus|vice[-\s]?president|governor|senators?|congress(?:man|woman|person)|representatives?|mayor|secretary|attorney\s+general|prime\s+minister|premier|chancellor|chair(?:man|woman|person)?|ceo|cfo|cto|coo|administrator|pope|king|queen|monarch|ambassador|speaker|chief\s+justice|justices?|commissioner|treasurer|comptroller|sheriff)\b/i;
const _SOCIAL_RE = /^(hi|hey|hello|yo|sup|good (?:morning|afternoon|evening|night)|how are you|how'?s it going|what'?s up|thanks|thank you|cheers|lol|haha)\b/i;
function _regexIntent(msg) {
  const s = String(msg || '').trim();
  if (!s) return { kind: 'other', topic: '', needs_fresh: false };
  if (_OFFICE_HOLDER_RE.test(s)) return { kind: 'office_holder', topic: '', needs_fresh: true };
  if (_SOCIAL_RE.test(s)) return { kind: 'chitchat', topic: '', needs_fresh: false };
  if (_CURRENCY_RE.test(s)) return { kind: 'current_fact', topic: '', needs_fresh: true };
  return { kind: 'other', topic: '', needs_fresh: false };
}

/**
 * Parse one turn's intent. Model-primary, regex-fallback, never throws.
 *   opts.ask   inject cloud.ask (default: the real one). Returns the validated intent object or null.
 *   opts.model override the model (default: the fast utility cloud model).
 *   opts.deps  passed to ask (e.g. { skipBudget:true }).
 */
async function parseIntent(userMessage, { ask = null, model = null, deps = {} } = {}) {
  const msg = String(userMessage || '').trim();
  if (!msg) return { kind: 'other', topic: '', needs_fresh: false, source: 'fallback' };
  const askFn = ask || (() => { try { return require('./cloud_logic').ask; } catch { return null; } })();
  // Attempt the model only when an ask was injected (tests) OR a real cloud source is configured — so a
  // pure-offline turn (no cloud) skips straight to the regex fallback with no wasted call / trace noise.
  const _hasCloud = () => { try { return (require('./models').sources() || []).some(s => s.tier === 'cloud' && s.token); } catch { return false; } };
  if (askFn && (ask || _hasCloud())) {
    try {
      const out = await askFn({
        task: 'intent_parse', v: 1,
        input: { question: msg.slice(0, 400) },
        want: _WANT, validate: _validate,
        model: model || _fastModel(), numPredict: 160,
        deps: { skipBudget: true, ...deps }
      });
      if (out && typeof out === 'object' && KINDS.includes(out.kind)) return { ...out, source: 'model' };
    } catch { /* fall through to regex */ }
  }
  return { ..._regexIntent(msg), source: 'fallback' };
}

module.exports = { parseIntent, _regexIntent, _validate, _fastModel, KINDS, _WANT, _CURRENCY_RE, _OFFICE_HOLDER_RE };
