/* Smoke: lib/grounding_flare.js — T1 of the swarm substrate (offline: pure behavior + wiring).
 * Proves: cluster routing (≤2 agents, registry-hyphenated by construction), the verify-shaped
 * task spec, pacing + kill switch, the antifab followup posture, and the three wiring points
 * (cognition's hook on the model-answer branch, main's _flareRun, the quiet canvas tab).
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_grounding_flare.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const gf = require('../lib/grounding_flare');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };
process.exitCode = 1;

// ── cluster routing: the turn's tokens pick the specialists ─────────────────────────────────────
const picks = [];
const p1 = gf.pickSpecialists({ userMessage: 'what does SB 200 actually require of hospitals?' }); picks.push(p1);
ok(p1.join(',') === 'legislative-analyst,fact-checker', 'bill tokens → legislative-analyst + fact-checker');
const p2 = gf.pickSpecialists({ kind: 'office_holder', topic: 'President of the United States' }); picks.push(p2);
ok(p2.join(',') === 'fact-checker,press-monitor', 'office_holder kind → fact-checker + press-monitor (press-shaped currency)');
const p3 = gf.pickSpecialists({ need: 'largest PAC contribution to the campaign' }); picks.push(p3);
ok(p3[0] === 'donor-flow-analyst', 'donor tokens → donor-flow-analyst leads');
const p4 = gf.pickSpecialists({ userMessage: 'what did the latest approval rating survey show?' }); picks.push(p4);
ok(p4[0] === 'polling-strategist', 'polling tokens → polling-strategist leads');
const p5 = gf.pickSpecialists({ need: 'the precedent for mid-decade redistricting' }); picks.push(p5);
ok(p5[0] === 'historical-researcher', 'precedent tokens → historical-researcher leads');
const p6 = gf.pickSpecialists({ userMessage: 'what are the laws of thermodynamics?' }); picks.push(p6);
ok(p6.join(',') === 'fact-checker', 'no cluster match → fact-checker alone (a flare is small)');
ok(picks.every((p) => p.length >= 1 && p.length <= 2), 'every pick is 1-2 agents (rail 4: a flare is small)');
ok(picks.flat().every((a) => /^[a-z]+(?:-[a-z]+)+$/.test(a)), '⭐ §70: every name is registry-hyphenated by construction (the underscore corpse stays dead)');

// ── the task spec: verify-first, deposit-shaped ending ─────────────────────────────────────────
const fp = gf.flarePrompt({ userMessage: 'who chairs the ways and means committee?', need: 'current ways and means chair', topic: 'Ways and Means Committee chair' });
ok(/VERIFY/.test(fp) && /general knowledge/.test(fp), 'task spec: names itself a VERIFY of a model-knowledge answer');
ok(/who chairs the ways and means/.test(fp) && /Ways and Means Committee chair/.test(fp), 'task spec: carries the question AND the normalized topic');
ok(/FOUND: .*NOT FOUND: .*SOURCES:/.test(fp), 'task spec: ends on the FOUND / NOT FOUND / SOURCES envelope (the §72-proven deposit shape)');

// ── pacing + kill switch ───────────────────────────────────────────────────────────────────────
{
  const meta = {};
  const g1 = gf.shouldFire({ getMeta: (k) => meta[k], setMeta: (k, v) => { meta[k] = v; }, now: 1000000 });
  ok(g1.fire === true && Number(meta[gf.PACE_KEY]) === 1000000, 'fresh state → fires and stamps the pace key');
  const g2 = gf.shouldFire({ getMeta: (k) => meta[k], setMeta: (k, v) => { meta[k] = v; }, now: 1000000 + gf.FLARE_PACE_MS - 1 });
  ok(g2.fire === false && /paced/.test(g2.why), 'inside the window → paced, why names it (the log line stands beside the red line)');
  const g3 = gf.shouldFire({ getMeta: (k) => meta[k], setMeta: (k, v) => { meta[k] = v; }, now: 1000000 + gf.FLARE_PACE_MS + 1 });
  ok(g3.fire === true, 'past the window → fires again');
  meta[gf.KILL_KEY] = 'off';
  const g4 = gf.shouldFire({ getMeta: (k) => meta[k], setMeta: (k, v) => { meta[k] = v; }, now: 9e12 });
  ok(g4.fire === false && /kill switch/.test(g4.why), `kill switch: meta ${gf.KILL_KEY}=off disarms without a build`);
}

// ── the followup: antifab posture rides the instruction ────────────────────────────────────────
const ft = gf.followupText({ topic: 'Ways and Means chair', deposits: ['— fact-checker —\nFOUND: Jason Smith chairs it. SOURCES: house.gov'], userName: 'Lucas' });
ok(/research team just came back/.test(ft) && /Jason Smith/.test(ft), 'followup: carries the deposits and the research-team framing');
ok(/CONFIRM/.test(ft) && /enrichment/.test(ft), 'followup: confirm → enrichment with the source');
ok(/CONTRADICT/.test(ft) && /lead with the correction/.test(ft) && /never defend/.test(ft), '⭐ followup: contradict → correction leads, never a defense (the antifab posture)');
ok(/nothing solid/.test(ft), 'followup: an empty harvest is said honestly, never dressed up');

// ── wiring (presence of the three seams; behavior is pinned above on the pure functions) ───────
const cog = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cognition.js'), 'utf8');
const _redLine = cog.indexOf('answering from the model, not refusing');
ok(_redLine > -1 && cog.indexOf('deps.onModelAnswer', _redLine) > -1 && cog.indexOf('deps.onModelAnswer', _redLine) < cog.indexOf('return null', _redLine) + 400,
  'cognition: the flare hook rides the exact answering-from-the-model branch, before its return');
const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
ok(/onModelAnswer: \(\{ need, topic, kind \}\) => \{ _flareRun\(/.test(mainSrc), 'main: answerGrounded deps carry the hook → _flareRun (fire-and-forget)');
ok(/name: 'spawn_agent_async', args: \{ name: agent, prompt: gf\.flarePrompt\([^)]*\), canvas_tab: gf\.FLARE_TAB \}/.test(mainSrc),
  '⭐ quiet canvas (rail 3): every flare spawn passes the designated research-flare tab');
ok(/resultText: gf\.followupText\(\{ topic: topic \|\| need, deposits, userName \}\)/.test(mainSrc), 'main: the harvest posts through fireToolFollowup with the antifab followup');
ok(/if \(!deposits\.length\) \{ console\.log\('\[flare\] zero deposits — nothing to post'\); return; \}/.test(mainSrc), 'main: zero deposits → log only, never a noise followup');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
