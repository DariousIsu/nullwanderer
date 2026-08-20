/* smoke_verdict_reconcile.js — W5-S0.5: the ONE-VERDICT-STORE clock gate (run-2 F4).
 *
 * The live disease: a synthesis pass branded the TRUE "Larry Selders died July 7, 2026" a
 * "temporally impossible future date" — the model's TRAINED clock believed 2026 was future, and the
 * verdict sat opposite the reply layer with no reconciliation. Two seams, both here:
 *   1. the verdict DOOR — known_incorrect.record refuses a temporal charge the wall clock disproves;
 *   2. the MINTING seam — the synthesis prompt now leads with the real date (clockLine).
 * Plus the Slice-2 wiring greps (drive weights touch BUDGET/CADENCE knobs only).
 *
 * Isolated temp DB for the integration half.
 */
'use strict';
const os = require('os'), path = require('path'), fs = require('fs');
process.env.SQ_DB_PATH = process.env.SQ_DB_PATH || path.join(os.tmpdir(), `sq_verdict_${process.pid}`, 'sq.db');
const vr = require('../lib/verdict_reconcile');

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`); } };

const NOW = Date.UTC(2026, 7, 20, 12);   // 2026-08-20 — the wall clock of the live failure's world

// ── datesIn ─────────────────────────────────────────────────────────────────────────────────────
{
  const d = vr.datesIn('Larry Selders died July 7, 2026, leaving the seat vacant');
  ok(d.length === 1 && new Date(d[0].ts).toISOString().startsWith('2026-07-07'), 'datesIn: "July 7, 2026" → that exact day (no bare-year double count)');
  ok(vr.datesIn('the 2026-07-07 filing').length === 1, 'datesIn: ISO dates parse');
  ok(vr.datesIn('elected in 2019, resigned 2024').length === 2, 'datesIn: bare years parse');
  ok(vr.datesIn('no dates here at all').length === 0, 'datesIn: none → empty');
}

// ── the gate: the F4 KIND ───────────────────────────────────────────────────────────────────────
{
  const live = vr.gate({ claimValue: 'died July 7, 2026', reason: 'temporally impossible future date — 2026 has not happened', now: NOW });
  ok(live.stick === false && /clock-refuted/.test(live.why), 'F4 REGRESSION: the verbatim live charge is REFUSED — July 7 2026 is PAST on 2026-08-20');
  const bareYear = vr.gate({ claimValue: 'Selders died in 2026', reason: 'temporal error: future date', now: NOW });
  ok(bareYear.stick === false, 'a bare current-year mention is judged from Jan 1 — never future mid-year');
  const genuine = vr.gate({ claimValue: 'the special election on March 3, 2027', reason: 'temporal error — future date asserted as past', now: NOW });
  ok(genuine.stick === true && /genuinely-future/.test(genuine.why), 'a GENUINELY future date sticks — the gate cannot be used to launder real time errors');
  const bounce = vr.gate({ claimValue: 'mayor@shreveport.gov', reason: 'email bounced 2026-08-01 (SMTP 550)', now: NOW });
  ok(bounce.stick === true && bounce.why === 'not-temporal', 'a bounce refutation is untouched (not a temporal charge)');
  ok(vr.gate({ claimValue: 'the address is wrong', reason: 'temporally impossible', now: NOW }).stick === true, 'a temporal charge with NO dates to judge sticks (nothing to disprove)');
  ok(vr.gate({}).stick === true, 'empty input → stick (fail-open)');
}

// ── clockLine ───────────────────────────────────────────────────────────────────────────────────
{
  const c = vr.clockLine(NOW);
  ok(/TODAY IS/.test(c) && /2026/.test(c), 'clockLine names the real date');
  ok(/ALREADY HAPPENED/i.test(c), '…and states the past/future rule the trained clock breaks');
}

// ── integration: known_incorrect.record refuses the clock-refuted verdict ───────────────────────
{
  const db = require('../lib/db'); db.init();
  const ki = require('../lib/known_incorrect');
  const refused = ki.record({ objectKey: 'person:larry selders', claimClass: 'biographical', claimValue: 'died July 7, 2026', reason: 'temporally impossible future date' });
  ok(refused === null, 'record(): the F4 verdict never lands in the store');
  const kept = ki.record({ objectKey: 'person:test subject', claimClass: 'contact', claimValue: 'bad@example.com', reason: 'email bounced (SMTP 550), test 2026-08-19' });
  ok(kept !== null, 'record(): a real bounce refutation still lands');
  const futureKept = ki.record({ objectKey: 'person:test subject2', claimClass: 'biographical', claimValue: 'sworn in March 3, 2099', reason: 'temporal error: future date asserted as fact' });
  ok(futureKept !== null, 'record(): a genuinely-future temporal charge still lands');
}

// ── the minting seam: the synthesis prompt leads with the wall clock ────────────────────────────
{
  const sc = require('../lib/subconscious');
  const p = sc.buildSynthesisPrompt({ recentThoughts: [{ content: 'a thought' }] });
  ok(/TODAY IS/.test(p), 'buildSynthesisPrompt carries the real-date line (the trained clock no longer fills the vacuum)');
  ok(p.indexOf('TODAY IS') < p.indexOf('recent between-turn thoughts'), '…and it LEADS the prompt');
}

// ── W5 Slice 1+2 WIRING (text-level, like the F15 smoke): consumers exist, knobs only ───────────
{
  const mono = fs.readFileSync(path.join(__dirname, '..', 'lib', 'monologue.js'), 'utf8');
  ok(/45 \* 60 \* 1000 \* _isw\.exploreGateMult/.test(mono), 'Slice 2: the interest-spawn gate consults the drive weights');
  ok(/2 \* 3600e3 \* _isw\.exploreGateMult/.test(mono), 'Slice 2: the self-explore gate consults the drive weights');
  ok(/Math\.max\(1, _cfg\.subcMovesPerTick\(\) \+ _isw\.graphMovesDelta\)/.test(mono), 'Slice 2: the burst floors at 1 — exhaustion trims, never zeroes');
  const moodSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mood.js'), 'utf8');
  ok(/readingsLine/.test(moodSrc) && /stateLine/.test(moodSrc), 'Slice 1: mood.compose consults the measured readings line');
}

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
