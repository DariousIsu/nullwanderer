/* Smoke: vision SURFACES — every place she meets an image routes to a screenshot/base64 + the
 * <…-see> tag (her browser, shared browser, screen) or image-file detection. Deterministic: tag
 * parsing is pure regex; image-file detection uses a temp PNG. No model/network.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_vision_surfaces.js
 */
const fs = require('fs'); const os = require('os'); const path = require('path');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_vsurf_${Date.now()}.db`);
const D = require('../lib/db'); D.init();
const web = require('../lib/web');
const browser = require('../lib/browser');
const screen = require('../lib/screen');
const files = require('../lib/files');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// --- her own browser: <web-see> ---
ok(web.parseTags('<web-see/>').some(t => t.tag === 'web-see'), 'web.parseTags → web-see (self-close)');
ok(web.parseTags('<web-see>what is the chart?</web-see>').some(t => t.tag === 'web-see' && /chart/.test(t.body)), 'web.parseTags → web-see (with question)');
ok(typeof web.screenshot === 'function', 'web.screenshot exported');

// --- shared browser: <browse-see> ---
const bt = browser.parseTags('let me <browse-see/> and <browse-see tab="2"/>');
ok(bt.filter(t => t.tag === 'browse-see').length === 2, 'browser.parseTags → browse-see (active + tab)');
ok(browser.parseTags('<browse-read/>').some(t => t.tag === 'browse-read'), 'browser.parseTags still parses browse-read');

// --- screen: <screen-see> vs <observe-screen> ---
const st = screen.parseTags('<observe-screen/> then <screen-see/>');
ok(st.some(t => t.tag === 'observe-screen') && st.some(t => t.tag === 'screen-see'), 'screen.parseTags distinguishes observe-screen vs screen-see');
ok(typeof screen.capture === 'function', 'screen.capture exported');

// --- screen-sight safety net detector (auto-look so she can't confabulate sight) ---
ok(screen.detectScreenSightRequest('I have a picture pulled up on my screen, can you see it?'), 'detect: "pulled up on my screen … see it" (the logged case)');
ok(screen.detectScreenSightRequest('can you see my screen'), 'detect: "can you see my screen"');
ok(screen.detectScreenSightRequest("what's on my screen right now"), 'detect: "what\'s on my screen"');
ok(!screen.detectScreenSightRequest('what is the price of oil'), 'detect: live-info → no');
ok(!screen.detectScreenSightRequest('what is your favorite color'), 'detect: taste → no');

// --- image file: file-read returns base64, not garbled text ---
const pngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const wsDir = path.join(path.dirname(process.env.SQ_DB_PATH), 'zoe_workspace');
try { fs.mkdirSync(wsDir, { recursive: true }); } catch {}
const imgPath = path.join(wsDir, 'shot.png');
fs.writeFileSync(imgPath, Buffer.from(pngB64, 'base64'));
const rd = files.dispatch ? null : null; // dispatch is async; call directly
(async () => {
  const r = await files.dispatch({ tag: 'file-read', attrs: { path: imgPath }, body: '' });
  ok(r && r.ok && r.image === true && typeof r.base64 === 'string' && r.base64.length > 10, 'file-read on a .png → { image:true, base64 } (not utf8 text)');
  ok(!r.text, 'image file-read does NOT return utf8 text');
  // a normal text file still reads as text
  const txtPath = path.join(wsDir, 'note.txt'); fs.writeFileSync(txtPath, 'hello world');
  const rt = await files.dispatch({ tag: 'file-read', attrs: { path: txtPath }, body: '' });
  ok(rt && rt.ok && /hello world/.test(rt.text) && !rt.image, 'text file-read still returns text (not image)');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  try { D.getDb().close(); } catch {}
  try { fs.rmSync(path.dirname(process.env.SQ_DB_PATH) + '/zoe_workspace', { recursive: true, force: true }); } catch {}
  try { fs.unlinkSync(process.env.SQ_DB_PATH); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})();
