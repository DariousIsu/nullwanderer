/* Smoke: lib/belief_correction — the chat-correction adapter. Proves cue detection (with the substance
 * guard), the chat-lane Claim shape (provenance 'told', authority 3), and end-to-end capture through the
 * revise pipeline (write / supersede / skip). Injected extractFn + writeFact — no cloud, no DB.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_belief_correction.js
 */
'use strict';
const C = require('../lib/belief_correction');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };
const NOW = Date.parse('2026-07-03T12:00:00Z');

(async () => {
  // ── detectCorrection — cue + substance ──
  ok(C.detectCorrection('No, Pam Bondi stepped down as AG in April 2026.').isCorrection === true, 'detect: "No, <assertion>" → correction');
  ok(C.detectCorrection('Actually, Jane Smith is the CEO now.').isCorrection === true, 'detect: "Actually, <assertion>" → correction');
  ok(C.detectCorrection("That's wrong — Zeldin runs the EPA, not Regan.").isCorrection === true, 'detect: "that\'s wrong — <assertion>" → correction');
  ok(C.detectCorrection('Marco Rubio is no longer at the CIA.').isCorrection === true, 'detect: "no longer" → correction');
  ok(C.detectCorrection('For the record, the treaty was signed in 2019.').isCorrection === true, 'detect: "for the record" + year → correction');
  ok(C.detectCorrection('no thanks').isCorrection === false, 'detect: "no thanks" → NOT a correction (no comma cue / no substance)');
  ok(C.detectCorrection('what is the weather today').isCorrection === false, 'detect: a plain question → not a correction');
  ok(C.detectCorrection('tell me about the Paris Agreement').isCorrection === false, 'detect: a request → not a correction');
  ok(C.detectCorrection('').isCorrection === false, 'detect: empty → false');

  // ── buildCorrectionClaim — chat-lane Claim shape ──
  const claim = C.buildCorrectionClaim({ claim: 'Pam Bondi stepped down as Attorney General on 2026-04-02', subject: 'Pam Bondi', asOf: '2026-04-02', predicate: 'HELD_OFFICE', kind: 'edge' }, { now: NOW });
  ok(claim.provenance === 'told' && claim.lane === 'chat', 'buildClaim: provenance "told" + lane "chat"');
  ok(claim.citations.length === 1 && claim.citations[0].authority_tier === 3, 'buildClaim: one operator citation at authority 3');
  ok(claim.as_of === '2026-04-02' && claim.subject.name === 'Pam Bondi' && /stepped down/.test(claim.value), 'buildClaim: as_of + subject + value from the extraction');
  ok(C.buildCorrectionClaim({ claim: 'X is Y', subject: 'X' }, { now: NOW }).as_of === '2026-07-03', 'buildClaim: undated correction → as_of = today (asserted NOW)');
  ok(C.buildCorrectionClaim({}, { now: NOW }) === null, 'buildClaim: no claim text → null');

  // ── captureCorrection — end to end through revise ──
  const sink = () => { const s = { recs: [] }; s.fn = async (rec) => s.recs.push(rec); return s; };
  const extractOK = async () => [{ claim: 'Pam Bondi stepped down as Attorney General on 2026-04-02', subject: 'Pam Bondi', asOf: '2026-04-02', predicate: 'HELD_OFFICE', kind: 'edge' }];

  let s = sink();
  const rNew = await C.captureCorrection({ userMessage: 'No, Pam Bondi stepped down as AG on 2026-04-02.', extractFn: extractOK, lookupIncumbent: async () => null, writeFact: s.fn, now: NOW });
  ok(rNew.captured === 1 && s.recs.length === 1, 'capture: correction → 1 verified_fact written');
  ok(s.recs[0].source === 'verified_fact' && s.recs[0].provenance.capturedBy === 'chat-correction', 'capture: banked as verified_fact with capturedBy=chat-correction (→ precedence authority 3)');

  // supersede an existing belief — and onSupersede threads through to retire it
  s = sink();
  let retired99 = null;
  const rSup = await C.captureCorrection({ userMessage: "That's wrong, Bondi is no longer AG as of 2026-04-02.", extractFn: extractOK, lookupIncumbent: async () => ({ value: 'Pam Bondi is the Attorney General', as_of: null, ref: 99, citations: [{ title: 'old', authority_tier: 1 }] }), onSupersede: async (ref) => { retired99 = ref; }, writeFact: s.fn, now: NOW });
  ok(rSup.captured === 1 && rSup.outcomes[0].action === 'supersede' && rSup.outcomes[0].supersedes === 99, 'capture: correction vs stale incumbent → supersede, supersedes_ref=99');
  ok(retired99 === 99, 'capture: onSupersede threads through → the stale incumbent (99) is retired (the correction sticks)');

  // a non-correction banks nothing
  s = sink();
  const rSkip = await C.captureCorrection({ userMessage: 'what is the current weather', extractFn: extractOK, writeFact: s.fn, now: NOW });
  ok(rSkip.captured === 0 && rSkip.skipped === 'not-a-correction' && s.recs.length === 0, 'capture: non-correction → skipped, nothing written');

  // cue present but extraction yields no claim → nothing
  s = sink();
  const rNoClaim = await C.captureCorrection({ userMessage: 'no, that is wrong actually', extractFn: async () => [], writeFact: s.fn, now: NOW });
  ok(rNoClaim.captured === 0 && rNoClaim.skipped === 'no-claim' && s.recs.length === 0, 'capture: cue but no extractable claim → nothing written');

  // no extractor wired → safe no-op
  ok((await C.captureCorrection({ userMessage: 'No, Bondi resigned in April 2026.' })).skipped === 'no-extractor', 'capture: no extractFn → safe no-op');

  // ── LEG D: cueRefutes — a FALSITY cue refutes into known_incorrect; a TEMPORAL cue only retires ──
  ok(C.cueRefutes('wrong') && C.cueRefutes('incorrect') && C.cueRefutes("that's not") && C.cueRefutes('not right') && C.cueRefutes('inaccurate'),
    'cueRefutes: an explicit falsity cue (wrong / incorrect / not right / that\'s not) REFUTES');
  ok(!C.cueRefutes('no longer') && !C.cueRefutes('as of') && !C.cueRefutes("it's now") && !C.cueRefutes('anymore') && !C.cueRefutes('update:'),
    'cueRefutes: a TEMPORAL update (no longer / as of / now) does NOT refute — refuted is not stale');
  ok(!C.cueRefutes('no,') && !C.cueRefutes('actually,') && !C.cueRefutes(''), 'cueRefutes: an ambiguous/generic cue does NOT refute (conservative — a missed refute is safe, a wrong one breaks the law)');

  // ── the chat-door wiring: onSupersede refutes on a falsity cue + the correction-event seam ──────
  const fs = require('fs'), path = require('path');
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  ok(/_bc\.cueRefutes\(_cue\)/.test(main) && /known_incorrect'\)\.record\(/.test(main), 'chat door: onSupersede refutes the superseded value into known_incorrect on a falsity cue');
  ok(/correction_classes'\)\.note\(\{ cls: 'fact'/.test(main)
    && /note\(\{ cls: 'rule'/.test(main) && /note\(\{ cls: 'capability'/.test(main),
    'the correction-event seam (cut 6) fires on all three doors through the ledger (correction_classes.note): fact + rule + capability');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
