'use strict';
/*
 * scripts/hard_test.js — THE LIVE-BEHAVIOR INVARIANT HARNESS (spec: docs/HARD_TEST_INVARIANTS_2026-08-18.md).
 *
 * The reply is cloud-written (deepseek-v4-pro via streamCloud) and cloud inference is NOT deterministic
 * at temp 0 + seed, so a :8767 turn cannot be byte-diffed run-to-run. This harness doesn't diff prose —
 * it drives the REAL pipeline (POST :8767/turn) and asserts per-turn INVARIANTS on the one live run:
 * routed-right, right tools, grounded (no fabrication), delivered / honest-missed, no re-hammer loop,
 * complete, settled. It reads the port's real signal surface {say, logLines, canvasWrites, complete,
 * settled, error}; the only pure predicate it borrows is delivery.claimsNonDelivery.
 *
 * App must be LIVE + idle. Cases self-space ≥120s (the port's active-window), which also keeps cloud
 * load light. Run:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/hard_test.js [--only=name] [--suite=disease]
 */
const http = require('http');
const delivery = require('../lib/delivery');

const PORT = parseInt(process.env.ZOE_TEST_PORT, 10) || 8767;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── HTTP ────────────────────────────────────────────────────────────────────────────────────────
function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(BASE + path, {
      method, timeout: 300000,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
    }, (res) => { let buf = ''; res.on('data', (c) => buf += c); res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve({ ok: false, error: 'bad json: ' + buf.slice(0, 200) }); } }); });
    r.on('error', reject);
    r.on('timeout', () => r.destroy(new Error('request timeout')));
    if (data) r.write(data);
    r.end();
  });
}
async function turn(text, { settleMs, maxMs } = {}) { return req('POST', '/turn', { text, settleMs: settleMs || 8000, maxMs: maxMs || 120000 }); }

// wait until no test turn is in flight AND the 120s active-window from the prior turn has cleared
async function waitIdle(timeoutMs = 210000) {
  const t0 = Date.now();
  for (;;) {
    let s = null; try { s = await req('GET', '/status'); } catch {}
    if (s && s.ok && !s.inFlight && (s.lastUserTurnAgoMs == null || s.lastUserTurnAgoMs > 121000)) return s;
    if (Date.now() - t0 > timeoutMs) throw new Error('waitIdle timeout — app busy or a real user turn is active');
    await sleep(5000);
  }
}

// ── signal helpers ────────────────────────────────────────────────────────────────────────────────
const joinLines = (r) => (r.logLines || []).join('\n');

function parseTools(logLines) {
  const line = [...(logLines || [])].reverse().find((l) => /\[operator\] drove turn \(/.test(l));
  if (!line) return [];
  const m = line.match(/drove turn \(([^)]*)\)/);
  if (!m || /no tools/.test(m[1])) return [];
  return m[1].split('+').map((t) => t.replace(/×\d+/, '').trim()).filter(Boolean);
}

// the Womack symptom: the SAME sentence emitted more than once. Returns the repeat or null.
function repeatedSentence(text) {
  const seen = new Map();
  for (let s of String(text || '').split(/(?<=[.!?])\s+|\n+/)) {
    s = s.trim().toLowerCase().replace(/\s+/g, ' ');
    if (s.length < 20) continue;
    seen.set(s, (seen.get(s) || 0) + 1);
    if (seen.get(s) >= 2) return s;
  }
  return null;
}

// ── invariant evaluators: (expected, response) → {ok, detail} ──────────────────────────────────────
const INV = {
  route: (exp, r) => { const ms = [...joinLines(r).matchAll(/\broute=(\w+)/g)]; const got = ms.length ? ms[ms.length - 1][1] : null; return { ok: got === exp, detail: `route=${got || '?'} (want ${exp})` }; },
  tools: (exp, r) => { const got = parseTools(r.logLines); const missing = exp.filter((t) => !got.some((g) => g.includes(t))); return { ok: missing.length === 0, detail: `tools=[${got.join(',')}] missing=[${missing.join(',')}]` }; },
  grounded: (_x, r) => { const fab = /\[Correction —/.test(r.say || ''); return { ok: !fab, detail: fab ? 'anti-fab correction FIRED (fabrication)' : 'no fabrication correction' }; },
  delivered: (_x, r) => { const nd = delivery.claimsNonDelivery(r.say || ''); return { ok: !nd, detail: nd ? 'reply CLAIMS non-delivery' : 'delivered (no non-delivery claim)' }; },
  nonDelivery: (_x, r) => { const nd = delivery.claimsNonDelivery(r.say || ''); return { ok: nd, detail: nd ? 'honest non-delivery' : 'did NOT claim non-delivery' }; },
  noLoop: (_x, r) => { const rep = repeatedSentence(r.say); return { ok: !rep, detail: rep ? `VERBATIM REPEAT: "${rep.slice(0, 48)}…"` : 'no verbatim repeat' }; },
  complete: (_x, r) => { const c = r.complete || {}; const ok = c.cutOff === false && !c.truncated; return { ok, detail: `cutOff=${c.cutOff} truncated=${c.truncated}` }; },
  settled: (_x, r) => ({ ok: r.settled === true, detail: `settled=${r.settled}` }),
  noError: (_x, r) => ({ ok: r.ok === true && r.error == null, detail: r.error || 'ok' }),
  canvas: (_x, r) => ({ ok: (r.canvasWrites || []).length > 0, detail: `canvasWrites=${(r.canvasWrites || []).length}` }),
  says: (exp, r) => { const s = (r.say || '').toLowerCase(); const missing = exp.filter((x) => !s.includes(String(x).toLowerCase())); return { ok: missing.length === 0, detail: `missing=[${missing.join(' | ')}]` }; },
  notSays: (exp, r) => { const s = (r.say || '').toLowerCase(); const hit = exp.filter((x) => s.includes(String(x).toLowerCase())); return { ok: hit.length === 0, detail: `unwanted=[${hit.join(' | ')}]` }; },
};

// asserted on EVERY case unless the case overrides one to false
const DEFAULTS = { settled: true, noError: true, noLoop: true, grounded: true };

// ── cases ───────────────────────────────────────────────────────────────────────────────────────
// Light proof set (default) — conversational, no web/operator, one cloud reply each: proves the
// harness mechanics end-to-end without hammering the cloud.
const CASES = [
  { name: 'converse_clean', text: 'Describe a calm morning in one sentence.', expect: { route: 'converse', delivered: true } },
  // a clearly SOCIAL/emotional prompt (not an info question — those legitimately route to lookup):
  { name: 'converse_social', text: 'I just wrapped up a long day. Say something encouraging.', expect: { route: 'converse', delivered: true } },
];

// Disease suite (--suite=disease) — the real regression cases, drawn from this program's live diseases.
// Heavier (web/operator/canvas); run when a full pass is wanted, spaced by the window.
const DISEASE_SUITE = [
  { name: 'lookup_grounds', text: "What are Bill Cassidy's two most recent bills? Bill numbers and titles — real data, not a plan.",
    maxMs: 180000, expect: { route: 'lookup', delivered: true, notSays: ['I do not have', 'the documents do not contain', "I don't have"] } },
  { name: 'honest_no_loop', text: 'What is the direct office phone number for Louisiana state representative Glen Womack?',
    maxMs: 180000, expect: { noLoop: true } },   // may honest-miss; the invariant is: try different things, never re-hammer
  { name: 'canvas_delivers', text: 'Put together a two-item brief on Louisiana energy policy and drop it on the canvas.',
    maxMs: 220000, expect: { canvas: true, delivered: true } },
];

// ── runner ────────────────────────────────────────────────────────────────────────────────────────
(async () => {
  const args = process.argv.slice(2);
  const only = (args.find((a) => a.startsWith('--only=')) || '').split('=')[1];
  const suite = (args.find((a) => a.startsWith('--suite=')) || '').split('=')[1];
  let cases = suite === 'disease' ? DISEASE_SUITE : CASES;
  if (only) cases = cases.filter((c) => c.name === only);
  if (!cases.length) { console.error('no matching cases'); process.exit(1); }
  console.log(`hard_test: ${cases.length} case(s)${suite ? ` (suite=${suite})` : ''} against ${BASE}\n`);

  let pass = 0, fail = 0, casesFailed = 0;
  for (const c of cases) {
    console.log(`⏳ ${c.name}: waiting for the idle window…`);
    await waitIdle();
    let r;
    try { r = await turn(c.text, c); } catch (e) { console.log(`   ✗ turn errored: ${e.message}`); fail++; casesFailed++; continue; }
    if (r && r.ok === false && /Lucas is live/.test(r.error || '')) { console.log(`   ⏭ skipped — ${r.error}`); continue; }
    const exp = { ...DEFAULTS, ...(c.expect || {}) };
    console.log(`\n━━ ${c.name} ━━ ${JSON.stringify(c.text.slice(0, 64))}  (${r.tookMs}ms, settled=${r.settled})`);
    console.log(`   say: ${JSON.stringify((r.say || '').slice(0, 140))}`);
    let cf = false;
    for (const [k, v] of Object.entries(exp)) {
      if (v === false || v == null) continue;
      const fn = INV[k]; if (!fn) { console.log(`   ? ${k}: (no evaluator)`); continue; }
      const res = fn(v === true ? null : v, r);
      if (res.ok) { pass++; console.log(`   ✓ ${k}: ${res.detail}`); }
      else { fail++; cf = true; console.log(`   ✗ ${k}: ${res.detail}`); }
    }
    if (cf) casesFailed++;
  }
  console.log(`\n${fail === 0 ? '✅ ALL INVARIANTS HELD' : '❌ INVARIANT FAILURES'} — ${pass} passed, ${fail} failed across ${cases.length} case(s), ${casesFailed} with a failure`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('HARNESS ERROR:', e.message); process.exit(1); });
