'use strict';
/* smoke_c4_persona.js — Spine 4 / C4 persona-anchored drive (docs/SPINE4_C4_PERSONA_DRIVE.md).
 * PEPA: "who she is" competes with "what she does" at the DRIVE level. Proves the decision-side logic
 * (pure) + the honesty invariant (the attend-self move cultivates MOOD + inner thought, NEVER writes
 * identity/self_model, NEVER speaks — so it cannot override Spine 2). Offline, model-free, temp DB. */
const fs = require('fs'); const os = require('os'); const path = require('path');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_c4_${Date.now()}.db`);
const D = require('../lib/db'); D.init();
const A = require('../lib/autonomy');
const selfModel = require('../lib/self_model');
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } };
const H = 3600e3;

(async () => {
  const now = 1_700_000_000_000;   // fixed clock (Date.now is fine in a smoke; use a constant for determinism)

  console.log('personaPressure (C4 — the starvation-proof drive: neglect RAISES the pull to DUE):');
  const fresh = A.personaPressure({ lastAttendAt: now - 1 * H, now });      // 1h < 6h floor
  ok('recently tended → NOT due, low pressure', fresh.due === false && fresh.pressure < 1);
  const dueP = A.personaPressure({ lastAttendAt: now - 8 * H, now });       // 8h > 6h floor
  ok('long-neglected → DUE, pressure ≥ 1', dueP.due === true && dueP.pressure >= 1);
  const never = A.personaPressure({ lastAttendAt: 0, now });                // never attended
  ok('never attended → DUE + max pressure (capped 3) + hoursSince Infinity', never.due === true && never.pressure === 3 && never.hoursSince === Infinity);
  ok('pressure rises monotonically with neglect', A.personaPressure({ lastAttendAt: now - 12 * H, now }).pressure > A.personaPressure({ lastAttendAt: now - 7 * H, now }).pressure);
  ok('deep neglect is capped at 3× (no unbounded pressure)', A.personaPressure({ lastAttendAt: now - 100 * H, now }).pressure === 3);

  console.log('\nthe move exists in the decider vocabulary:');
  ok('MOVES includes attend-self', A.MOVES.includes('attend-self'));
  ok('DECISION_WANT enum offers attend-self', A.DECISION_WANT.includes('attend-self'));
  ok('DECISION_WANT frames inner life as a competing DRIVE', /INNER LIFE IS A DRIVE/i.test(A.DECISION_WANT));

  console.log('\nvalidateDecision (attend-self is target-free + expect-free; work moves still constrained):');
  const vSelf = A.validateDecision('{"move":"attend-self","why":"I have been all task and no self for a while"}');
  ok('attend-self valid with NO target and NO expect', vSelf.valid === true && vSelf.value.move === 'attend-self');
  const vNoWhy = A.validateDecision('{"move":"attend-self"}');
  ok('attend-self still requires a why (honest reason)', vNoWhy.valid === false);
  const vWork = A.validateDecision('{"move":"research","why":"x","expect":"y"}');
  ok('a work move still REQUIRES a target (no regression)', vWork.valid === false && /target required/.test(vWork.error));

  console.log('\nbuildManifest surfaces WHO YOU ARE as a competing section, with a DUE flag:');
  D.setMeta('user_name', 'Lucas');
  D.setMeta(A.PERSONA_ATTEND_KEY, String(now - 8 * H));                     // neglected → DUE
  const mDue = A.buildManifest({ db: D, now });
  ok('manifest contains the WHO YOU ARE / attend-self section', /WHO YOU ARE/.test(mDue.text) && /attend-self/.test(mDue.text));
  ok('section marks attending DUE when neglected', /attending is DUE/.test(mDue.text) && mDue.counts.personaDue === 1);
  D.setMeta(A.PERSONA_ATTEND_KEY, String(now));                            // just tended → NOT due
  const mFresh = A.buildManifest({ db: D, now });
  ok('section NOT due right after tending', mFresh.counts.personaDue === 0 && !/attending is DUE/.test(mFresh.text));

  console.log('\npersonaThoughtLine (renders her OWN mood as a private inner thought — onMind→withUser→feeling):');
  ok('prefers what is on her mind', /keep coming back to the roster/.test(A.personaThoughtLine({ onMind: 'the roster', withUser: 'x', feeling: 'y' })));
  ok('falls back to where she is with him', /Where I am with Lucas/.test(A.personaThoughtLine({ withUser: 'easy, in sync' }, 'Lucas')));
  ok('falls back to the core feeling', /Sitting with how I feel/.test(A.personaThoughtLine({ feeling: 'quietly content' })));
  ok('empty mood → empty line (nothing invented)', A.personaThoughtLine({}) === '');

  console.log('\npersonaAttend — the sink + THE FIREWALL (mood only; NEVER identity; NEVER speaks):');
  // Spy self_model: attend-self must not write it, on ANY write path. personaAttend never imports
  // self_model, so this stays 0 — the guard fails loudly if a future edit wires an identity write in.
  let selfWrites = 0;
  const _rec = selfModel.record; selfModel.record = async (...a) => { selfWrites++; return _rec.apply(selfModel, a); };
  const _tld = selfModel.recordTold; if (typeof _tld === 'function') selfModel.recordTold = async (...a) => { selfWrites++; return _tld.apply(selfModel, a); };
  const landed = [];
  const setCalls = [];
  const stubMood = { feeling: 'quietly content', onMind: 'the parish roster and where it is going', withUser: 'easy, in sync' };
  const res = await A.personaAttend({
    now, userName: 'Lucas',
    deps: {
      composeMood: async () => stubMood,
      landThought: (line) => landed.push(line),
      setMeta: (k, v) => setCalls.push([k, v]),
    },
  });
  ok('cultivated the mood (moodUpdated)', res.moodUpdated === true && res.mood === stubMood);
  ok('landed exactly one private inner thought (inner life ≠ only research)', landed.length === 1 && /the parish roster/.test(landed[0]));
  ok('advanced the persona cursor (pressure resets → Goldilocks cadence)', setCalls.some(([k, v]) => k === A.PERSONA_ATTEND_KEY && v === String(now)));
  ok('NEVER wrote self_model — the identity firewall holds by construction', selfWrites === 0);
  ok('produced NO utterance — attend-self never speaks (only engage does)', !('say' in res) && !('utterance' in res));
  selfModel.record = _rec; if (typeof _tld === 'function') selfModel.recordTold = _tld;

  // Robustness: a FAILED mood cultivation must still advance the cursor, or a broken cloud pins the
  // drive permanently DUE and it re-picks attend-self every tick (a new monoculture).
  console.log('\npersonaAttend robustness — a failed cultivation still resets the cadence:');
  const setCalls2 = []; const landed2 = [];
  const res2 = await A.personaAttend({ now: now + H, deps: { composeMood: async () => null, landThought: (l) => landed2.push(l), setMeta: (k, v) => setCalls2.push([k, v]) } });
  ok('no mood, no thought when cultivation returns null', res2.moodUpdated === false && landed2.length === 0);
  ok('cursor STILL advanced (no permanent-DUE lock)', setCalls2.some(([k, v]) => k === A.PERSONA_ATTEND_KEY && v === String(now + H)));

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  try { D.getDb().close(); } catch {}
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(process.env.SQ_DB_PATH + ext); } catch {} }
  process.exit(fail === 0 ? 0 : 1);
})();
