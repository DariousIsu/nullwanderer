/* Smoke: lib/excavate.js — the forensic screenshot→vision→scroll tier (offline, injected web+vision).
 * Proves: it scrolls past NOT_VISIBLE screens then FINDS the answer, stops at the bottom (no-movement),
 * and reports not-found when the page never shows it. No real browser, no cloud.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_excavate.js
 */
'use strict';
const excavate = require('../lib/excavate');
let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

function fakeWeb({ shots }) {
  let i = 0, scrolls = 0;
  return {
    _scrolls: () => scrolls,
    open: async () => ({ ok: true, url: 'https://en.wikipedia.org/wiki/Test' }),
    openTopResult: async () => ({ ok: true }),
    isConnected: () => true,
    screenshot: async () => ({ ok: true, base64: shots[Math.min(i++, shots.length - 1)], url: 'https://en.wikipedia.org/wiki/Test' }),
    scroll: async () => { scrolls++; return { ok: true }; },
  };
}

(async () => {
  // 1) scrolls past a NOT_VISIBLE first screen, then FINDS the answer on the second.
  const web1 = fakeWeb({ shots: ['SHOT_A', 'SHOT_B', 'SHOT_C'] });
  const vision1 = { describe: async ({ imageBase64 }) => imageBase64 === 'SHOT_B'
    ? { ok: true, text: 'FOUND: Pete Hegseth is the current U.S. Secretary of Defense.' }
    : { ok: true, text: 'NOT_VISIBLE' } };
  const r1 = await excavate.excavate('current US Secretary of Defense', { url: 'https://x', deps: { web: web1, vision: vision1 } });
  ok(r1.found && /Hegseth/.test(r1.answer), 'scrolls past NOT_VISIBLE → FINDS the answer on a later screen');
  ok(web1._scrolls() >= 1, 'actually SCROLLED before finding (not just top-of-page)');
  ok(r1.steps === 2, 'reports the step it found on');

  // 2) bottom detection — screenshots stop changing → stop (never loops forever).
  const web2 = fakeWeb({ shots: ['SAME', 'SAME', 'SAME'] });
  const visionNo = { describe: async () => ({ ok: true, text: 'NOT_VISIBLE' }) };
  const r2 = await excavate.excavate('x', { url: 'https://x', deps: { web: web2, vision: visionNo } });
  ok(!r2.found && web2._scrolls() <= 1, 'identical consecutive screenshots → detects bottom, stops');

  // 3) genuinely not on the page — exhausts the step cap, returns not-found (never invents).
  const web3 = fakeWeb({ shots: ['P0', 'P1', 'P2', 'P3', 'P4'] });
  const r3 = await excavate.excavate('x', { url: 'https://x', maxSteps: 3, deps: { web: web3, vision: visionNo } });
  ok(!r3.found && r3.steps === 3, 'answer never visible → bounded not-found (no confabulation)');

  // 4) open failure → graceful not-found.
  const webFail = { open: async () => ({ ok: false, reason: 'nav timeout' }) };
  const r4 = await excavate.excavate('x', { url: 'https://x', deps: { web: webFail, vision: visionNo } });
  ok(!r4.found && /could not open/.test(r4.reason || ''), 'browser open failure → graceful not-found');

  // 5) NOT_VISIBLE must not be mis-read as FOUND even if the word "found" appears elsewhere.
  const web5 = fakeWeb({ shots: ['Z0', 'Z1'] });
  const vision5 = { describe: async () => ({ ok: true, text: 'NOT_VISIBLE (I could not find it)' }) };
  const r5 = await excavate.excavate('x', { url: 'https://x', maxSteps: 2, deps: { web: web5, vision: vision5 } });
  ok(!r5.found, 'NOT_VISIBLE is honored even when the text mentions "find"');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
