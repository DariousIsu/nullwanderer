/**
 * lib/forecast_assess.js — the REACTOR's direction-judgment layer, wired to gpt-oss:120b.
 *
 * forecast_reactor shifts a race's MARGIN only for a corroborated event whose DIRECTION is judged — that
 * judgment is here. gpt-oss:120b is the reasoning model (proven reliable 2026-07-03) with ONE hard
 * requirement: num_predict ≥ ~1500 (else its answer starves in hidden `thinking` and content comes back
 * empty). It generates STRUCTURE ({favors, magnitude, confidence}), never the forecast NUMBERS.
 *
 * The reactor calls its `assess(event, race)` SYNCHRONOUSLY, but a cloud call is async — so we PRE-ASSESS:
 * assessBatch() runs the gpt-oss calls (budgeted concurrency) and returns a sync `lookup(event, race)` the
 * reactor uses. Keeps the hot path fast + lets us cap cloud spend during a live burst. PURE input/validate
 * cores + injected `ask` (cloud_logic.ask) → offline-testable. Fail-safe: no ask / bad output → null →
 * the reactor treats the event as un-attributed → volatility-only (never a phantom swing).
 */
'use strict';

const MODEL = 'gpt-oss:120b-cloud';
const NUM_PREDICT = 1500;   // gpt-oss reliability floor (proven) — never the default 400.

const ASSESS_WANT = `You judge how ONE news event affects ONE race between PARTY A and PARTY B.
Given the EVENT and the RACE, decide who it helps and how strongly. Base it only on the event's direct
effect on this race; if the effect is unclear or the event is off-topic, answer "neutral".
Respond with ONLY this JSON, nothing else:
{"favors":"A"|"B"|"neutral","magnitude":"small"|"medium"|"large","confidence":<number 0..1>}
- favors: which party the event helps (A or B); "neutral" if no clear directional effect.
- magnitude: expected size of the effect on THIS race's margin.
- confidence: your certainty in the DIRECTION, 0..1.`;

// pure — compact model input (small, ID-light). Party labels are the reactor's A/B convention.
function buildAssessInput(event, race) {
  return {
    event: { title: (event && event.title) || '', summary: String((event && event.summary) || '').slice(0, 400), entities: (event && event.entities) || [] },
    race: {
      subject: (race && race.subject) || null, office: (race && race.office) || null,
      partyA: (race && race.partyA) || 'A', partyB: (race && race.partyB) || 'B',
      candidates: (race && race.candidates) || [],
    },
  };
}

// pure — parse/validate the model output → {valid, value:{favors,magnitude,confidence}} (cloud_logic.ask contract)
function validateAssess(raw) {
  try {
    const m = String(raw == null ? '' : raw).match(/\{[\s\S]*\}/);
    if (!m) return { valid: false, error: 'no json' };
    const o = JSON.parse(m[0]);
    const favors = ['A', 'B', 'neutral'].includes(o.favors) ? o.favors : null;
    const magnitude = ['small', 'medium', 'large'].includes(o.magnitude) ? o.magnitude : null;
    let conf = Number(o.confidence);
    conf = Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : null;
    if (!favors) return { valid: false, error: 'bad favors' };
    if (favors !== 'neutral' && !magnitude) return { valid: false, error: 'missing magnitude' };
    return { valid: true, value: { favors, magnitude: magnitude || 'small', confidence: conf != null ? conf : 0.5 } };
  } catch (e) { return { valid: false, error: e.message }; }
}

// the reactor lookup key for an (event, race) pair
function keyOf(event, race) { return `${(race && race.id) || ''}|${(event && event.id) || ''}`; }

// one judgment via injected `ask` (cloud_logic.ask). → {favors,magnitude,confidence} | null (fail-safe).
async function assessOne(event, race, { ask } = {}) {
  if (typeof ask !== 'function') return null;
  try {
    const r = await ask({ task: 'forecast_assess_direction', v: 1, input: buildAssessInput(event, race), want: ASSESS_WANT, validate: validateAssess, model: MODEL, numPredict: NUM_PREDICT });
    return r || null;   // ask returns the validated value, or null on budget/failure
  } catch { return null; }
}

// pre-assess a set of {event, race} pairs → { map, lookup(event,race) } for the sync reactor. Budgeted concurrency.
async function assessBatch(pairs, { ask, concurrency = 4 } = {}) {
  const list = Array.isArray(pairs) ? pairs : [];
  const map = {};
  const q = list.slice();
  async function worker() {
    let p;
    while ((p = q.shift())) { const v = await assessOne(p.event, p.race, { ask }); if (v) map[keyOf(p.event, p.race)] = v; }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, list.length)) }, worker));
  return { map, lookup: (event, race) => map[keyOf(event, race)] || null };
}

module.exports = { MODEL, NUM_PREDICT, ASSESS_WANT, buildAssessInput, validateAssess, keyOf, assessOne, assessBatch };
