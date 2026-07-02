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
  const r2 = await excavate.excavate('x', { url: 'https://x', maxClicks: 0, deps: { web: web2, vision: visionNo } });
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

  // ── Slice 2: vision-guided CLICK to dig (vision NAMES the visible link → web.clickText) ───────────
  // a stateful page: page-1 never shows it → vision names a link → clickText → page-2 shows it.
  function clickableWeb() {
    let clicked = false, i = 0, clicks = 0, lastText = null;
    return {
      _clicks: () => clicks, _lastText: () => lastText,
      open: async () => ({ ok: true, url: 'https://en.wikipedia.org/wiki/Office' }),
      openTopResult: async () => ({ ok: true }), isConnected: () => true,
      screenshot: async () => ({ ok: true, base64: (clicked ? 'PAGE2_' : 'PAGE1_') + (i++), url: clicked ? 'https://en.wikipedia.org/wiki/Person' : 'https://en.wikipedia.org/wiki/Office' }),
      scroll: async () => ({ ok: true }),
      clickText: async (t) => { clicked = true; clicks++; i = 0; lastText = t; return { ok: true, url: 'https://en.wikipedia.org/wiki/Person', clicked: t }; },
    };
  }
  const visionClick = { describe: async ({ imageBase64, prompt }) => {
    if (/CLICK:/.test(prompt)) return { ok: true, text: 'CLICK: Lee Zeldin' };                 // vision NAMES the link text
    if (String(imageBase64).startsWith('PAGE2')) return { ok: true, text: 'FOUND: Lee Zeldin is the 17th EPA Administrator.' };
    return { ok: true, text: 'NOT_VISIBLE' };                                                  // page-1 scan
  } };
  const web6 = clickableWeb();
  const r6 = await excavate.excavate('what does Lee Zeldin do', { url: 'https://en.wikipedia.org/wiki/Office', maxSteps: 2, maxClicks: 1, deps: { web: web6, vision: visionClick, settle: false } });
  ok(r6.found && /Zeldin/.test(r6.answer), 'scan misses → vision names the link → clickText → finds it on the next page');
  ok(web6._clicks() === 1 && web6._lastText() === 'Lee Zeldin' && r6.clicks === 1, 'clicked exactly once by TEXT (tactile dig), reported depth');

  // NONE → she does not click blindly; bounded not-found (never wanders forever).
  const web7 = clickableWeb();
  const visionNone = { describe: async ({ prompt }) => /CLICK:/.test(prompt) ? { ok: true, text: 'NONE' } : { ok: true, text: 'NOT_VISIBLE' } };
  const r7 = await excavate.excavate('x', { url: 'https://x', maxSteps: 2, maxClicks: 2, deps: { web: web7, vision: visionNone, settle: false } });
  ok(!r7.found && web7._clicks() === 0, 'no useful link (NONE) → does not click, bounded not-found');

  // a weak model names browser CHROME ("Main menu") → guard refuses to follow it.
  const web8 = clickableWeb();
  const visionChrome = { describe: async ({ prompt }) => /CLICK:/.test(prompt) ? { ok: true, text: 'CLICK: Main menu' } : { ok: true, text: 'NOT_VISIBLE' } };
  const r8 = await excavate.excavate('x', { url: 'https://x', maxSteps: 2, maxClicks: 2, deps: { web: web8, vision: visionChrome, settle: false } });
  ok(!r8.found && web8._clicks() === 0, 'vision names chrome ("Main menu") → guard skips it, no wander');

  // ── seePage: research vision-EXTRACT across views (reads infoboxes/tables the a11y text misses) ──
  let si = 0;
  const seeWeb = { open: async () => ({ ok: true, url: 'https://org.example/team' }), screenshot: async () => ({ ok: true, base64: 'V' + (si++), url: 'https://org.example/team' }), scroll: async () => ({ ok: true }) };
  const seeVision = { describe: async ({ imageBase64 }) => imageBase64 === 'V1' ? { ok: true, text: '(nothing relevant)' } : { ok: true, text: 'Jane Roe — VP of Policy. Board formed 2019.' } };
  const sp = await excavate.seePage('leadership of the org', { url: 'https://org.example/team', maxViews: 2, deps: { web: seeWeb, vision: seeVision } });
  ok(sp.ok && /Jane Roe/.test(sp.text) && /VP of Policy/.test(sp.text) && sp.url === 'https://org.example/team', 'seePage extracts facts across views (with source url for the write-back)');
  ok(!/nothing relevant/i.test(sp.text), 'seePage drops "(nothing relevant)" views');
  const spFail = await excavate.seePage('x', { url: 'https://x', deps: { web: { open: async () => ({ ok: false, reason: 'nav timeout' }) }, vision: seeVision } });
  ok(spFail.ok === false && /open failed/.test(spFail.reason), 'seePage: open failure → graceful not-ok');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
