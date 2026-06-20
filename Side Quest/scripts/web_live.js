/**
 * LIVE end-to-end test of ALL of Zoe's web-browsing tools (lib/web.js), driving the
 * real patchright browser against real sites. Uses a TEMP profile (SQ_DB_PATH override)
 * so it never collides with the running app's data/web_profile lock.
 *
 * Tools exercised: ensure(launch) · open(url) · read(text+handles) · click(handle) ·
 *   back() · open(search) · openTopResult(auto-deepen) · type(handle) · close().
 * Plus a Cloudflare probe (nowsecure.nl) to see whether patchright passes a real
 * bot-check cold (fresh profile, no prior cf_clearance).
 *
 * Run: $env:ELECTRON_RUN_AS_NODE=1; .\node_modules\.bin\electron.cmd scripts\web_live.js
 */
const os = require('os'); const path = require('path');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_webtest_${Date.now()}`, 'sq.db');

const D = require('../lib/db'); D.init();
const web = require('../lib/web');

let pass = 0, fail = 0;
const ok = (n, c, detail) => { if (c) { pass++; console.log(`  ✓ ${n}${detail ? ' — ' + detail : ''}`); } else { fail++; console.log(`  ✗ ${n}${detail ? ' — ' + detail : ''}`); } };
const short = (s, n = 60) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);

(async () => {
  try {
    console.log('launch (patchright + system Chrome, temp profile):');
    await web.ensure();
    ok('ensure() launched the browser', web.isConnected());

    console.log('\nopen + read (static page):');
    const o1 = await web.open('https://example.com');
    ok('open(example.com)', o1.ok, o1.ok ? `title="${o1.title}"` : o1.reason);
    const r1 = await web.read();
    ok('read() returns body text', r1.ok && /example domain/i.test(r1.text), short(r1.text, 50));
    const hasLink = r1.ok && /\[L\d+\]/.test(r1.text);
    ok('read() assigns link handles', hasLink);

    console.log('\nclick + back (navigation):');
    if (hasLink) {
      const c1 = await web.click('L0');
      ok('click(L0) navigates', c1.ok, c1.ok ? `→ ${short(c1.url, 50)}` : c1.reason);
      const b1 = await web.back();
      ok('back() returns', b1.ok, b1.ok ? `→ ${short(b1.url, 50)}` : b1.reason);
    } else { console.log('  (no link handle to click — skipped)'); }

    console.log('\nsearch + auto-deepen:');
    const o2 = await web.open('Cloudflare company Wikipedia');
    ok('open(search terms) → SERP', o2.ok, o2.ok ? short(o2.url, 55) : o2.reason);
    const top = await web.openTopResult();
    ok('openTopResult() follows a result', top.ok, top.ok ? `→ ${short(top.url, 55)}` : top.reason);
    if (top.ok) { const r2 = await web.read(); ok('read() the followed page', r2.ok && (r2.text || '').length > 200, `${(r2.text || '').length} chars`); }

    console.log('\ntype (form input):');
    const o3 = await web.open('https://duckduckgo.com/html/?q=test');
    if (o3.ok) {
      const r3 = await web.read();
      const inputHandle = (r3.text.match(/\[(I\d+)\]/) || [])[1];
      if (inputHandle) { const t1 = await web.type(inputHandle, 'site reliability'); ok(`type(${inputHandle})`, t1.ok, t1.ok ? `filled "${t1.text}"` : t1.reason); }
      else { console.log('  (no input handle found — skipped)'); }
    }

    console.log('\nCloudflare probe (nowsecure.nl, cold profile):');
    const cf = await web.open('https://nowsecure.nl');
    if (cf.ok) {
      await new Promise(r => setTimeout(r, 6000)); // give Turnstile a moment to auto-resolve
      const rcf = await web.read();
      const txt = (rcf.text || '');
      const challenged = /just a moment|verify you are human|cf-chl|checking your browser|attention required/i.test(txt);
      const passed = !challenged && /(oh yeah|you are human|passed|nowsecure)/i.test(txt + ' ' + (rcf.title || ''));
      console.log(`  page title: ${short(rcf.title, 60)}`);
      console.log(`  verdict: ${passed ? 'PASSED Cloudflare ✓' : challenged ? 'STILL CHALLENGED ✗ (needs rung-3 heavy tier)' : 'inconclusive — ' + short(txt, 80)}`);
    } else { console.log('  open failed: ' + cf.reason); }

    console.log('\nclose:');
    const cl = await web.close();
    ok('close()', cl.ok);

  } catch (e) {
    console.error('\n[web_live] FATAL:', e.message);
    fail++;
    try { await web.close(); } catch {}
  }
  console.log(`\n${fail === 0 ? 'ALL TOOLS OK' : 'SOME FAILURES'} — ${pass} passed, ${fail} failed`);
  try { D.getDb().close(); } catch {}
  process.exit(0);
})();
