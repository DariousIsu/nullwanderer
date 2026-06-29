/* Smoke: verified web action brain (lib/web_verify) — Vision→Action P1. Pure/deterministic: the
 * gate, verdict parse, and followup text. No browser/model/db.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_web_verify.js
 */
'use strict';
const os = require('os'); const path = require('path');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_wv_${Date.now()}.db`);
require('../lib/db').init();
const wv = require('../lib/web_verify');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// --- which tags get the loop ---
ok(wv.isStateChanging('web-click') && wv.isStateChanging('web-type') && wv.isStateChanging('web-scroll') && wv.isStateChanging('web-back'), 'state-changing actions are recognized');
ok(!wv.isStateChanging('web-read') && !wv.isStateChanging('web-open') && !wv.isStateChanging('web-see'), 'read/open/see are NOT state-changing (they already perceive)');

// --- gate (§4.3) ---
ok(wv.shouldVisionVerify({ mode: 'always', readText: 'x'.repeat(500) }) === true, 'always → verify (study default)');
ok(wv.shouldVisionVerify({ mode: 'off', expect: 'login opens' }) === false, 'off → never verify');
ok(wv.shouldVisionVerify({ mode: 'auto', readText: 'plenty of text [L0] [B1] [I2] here', minChars: 10 }) === false, 'auto + rich a11y read → skip vision');
ok(wv.shouldVisionVerify({ mode: 'auto', readText: 'tiny', minChars: 120 }) === true, 'auto + thin read → verify (likely canvas/visual)');
ok(wv.shouldVisionVerify({ mode: 'auto', readText: 'x'.repeat(500) + ' [L0] [B1]', expect: 'the form opens', minChars: 10 }) === true, 'auto + stated expect → verify');
ok(wv.countHandles('go [L0] here [B3] and [I2] and [C1]') === 4, 'countHandles tallies L/B/I/C handles');

// --- verdict parse ---
ok(wv.parseVerdict('CONFIRMED — the login form is now visible') === 'confirmed', 'parses CONFIRMED');
ok(wv.parseVerdict('FAILED. an error toast appeared') === 'failed', 'parses FAILED');
ok(wv.parseVerdict('the page looks different now') === 'unclear', 'unparseable → unclear (never silently confirmed)');
ok(wv.noteFrom('CONFIRMED — the cart now shows 1 item') === 'the cart now shows 1 item', 'noteFrom strips the verdict keyword');

// --- followup text + recovery directive ---
const okText = wv.buildFollowupText({ action: 'web-click L3', expect: 'login opens', readText: 'Login\n[I0] email [B1] submit', verdict: 'confirmed', note: 'form visible', userName: 'Lucas' });
ok(/CONFIRMED/.test(okText) && /continue|tell Lucas/i.test(okText) && /fresh read/i.test(okText), 'confirmed → continue directive + fresh state');
const failText = wv.buildFollowupText({ action: 'web-click L3', verdict: 'failed', readText: 'same page', note: 'nothing changed' });
ok(/recover/i.test(failText) && /do NOT re-click/i.test(failText) && /never claim a success/i.test(failText), 'failed/unclear → bounded recovery, no blind re-click, no fake success');
ok(/No readable page text/i.test(wv.buildFollowupText({ action: 'web-scroll', verdict: 'unclear', readText: '' })), 'empty read → honest "no text came back"');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
try { require('../lib/db').getDb().close(); } catch {}
try { require('fs').unlinkSync(process.env.SQ_DB_PATH); } catch {}
process.exit(fail === 0 ? 0 : 1);
