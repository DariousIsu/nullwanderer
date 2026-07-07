/* Smoke: lib/face_match — the PURE face-compare math + fail-soft spawn (identity confirmation, Slice 2a).
 * The insightface EMBEDDING itself needs the venv + model (proven live, not offline-deterministic), so the
 * gate covers the vector math + the never-throw contract.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_face_match.js
 */
'use strict';
const fm = require('../lib/face_match');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

// --- cosine ---
ok(Math.abs(fm.cosine([1, 0, 0], [1, 0, 0]) - 1) < 1e-9, 'identical vectors → cosine 1');
ok(Math.abs(fm.cosine([1, 0], [0, 1])) < 1e-9, 'orthogonal → cosine 0');
ok(Math.abs(fm.cosine([1, 0], [-1, 0]) + 1) < 1e-9, 'opposite → cosine -1');
ok(fm.cosine([1, 2, 3], [1, 2]) === 0, 'length mismatch → 0 (no crash)');
ok(fm.cosine(null, [1]) === 0 && fm.cosine([], []) === 0, 'empty/null → 0, no crash');

// --- isSameFace (threshold) ---
ok(fm.isSameFace([1, 0, 0], [1, 0, 0]) === true, 'identical → same');
ok(fm.isSameFace([1, 0], [0, 1]) === false, 'orthogonal → not same');
ok(fm.SAME_FACE_THRESHOLD > 0.3 && fm.SAME_FACE_THRESHOLD < 0.7, `threshold is a sane ArcFace value (${fm.SAME_FACE_THRESHOLD})`);
const near = Array.from({ length: 4 }, () => 0.5);
ok(fm.isSameFace(near, near, 0.99) === true && fm.isSameFace([1, 0, 0, 0], [0, 1, 0, 0], 0.5) === false, 'custom threshold respected');

// --- fail-soft: a bogus python path → { ok:false }, never throws / hangs ---
(async () => {
  const r = await fm.embedImages([{ id: 'x', path: '/nope.jpg' }], { python: '/no/such/python', wallMs: 4000 });
  ok(r && r.ok === false && Array.isArray(r.results), 'embedImages with a dead interpreter → {ok:false}, no throw');

  const c = await fm.confirmAgainst({ path: '/nope.jpg' }, [{ path: '/nope2.jpg' }], { python: '/no/such/python', wallMs: 4000 });
  ok(c && c.ok === false && Array.isArray(c.matches), 'confirmAgainst fail-soft when the sidecar is unavailable');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
