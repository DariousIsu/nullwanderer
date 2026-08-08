'use strict';
/*
 * scripts/pathway_suite.js — THE PATHWAY SUITE (M8.3, 2026-08-08).
 *
 * End-to-end regression cases driven through the INSIDE ACCESS PORT (lib/test_port.js) against the
 * RUNNING app — the tier beyond smokes: smokes prove pure parts; this proves the real pipeline
 * (router precedence, doors, contracts, honest relays). Every case is a live failure that actually
 * happened; the suite exists so none of them can silently return.
 *
 * ⚠️ COST + STATE: each case is a REAL turn — real cloud spend, real turns-table rows, and the
 * canvas cases really edit the working doc. Run DELIBERATELY (quota permitting), never from the
 * smoke gate. Without --run it only prints the corpus. The port's own live-guard refuses while
 * Lucas is active; this runner also waits for idle between cases.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/pathway_suite.js --run
 * One case: … --run --only=contacts-precedence
 */
const http = require('http');

const PORT = parseInt(process.env.ZOE_TEST_PORT, 10) || 8767;
const IDLE_MS = 185000;          // past the port's 120s guard with margin

// Each case: the message, and expectations over the captured logLines (every), plus optional
// forbidden patterns (never). `say` expectations are avoided — voice wording varies; LOG LINES
// are the contract surface.
const CASES = [
  {
    name: 'contacts-precedence',
    born: '08-08 "Now identify every person…" → 849-row CRM dump (the massive failure)',
    text: 'Add the contact people we hold for each parish council into the doc under their parish',
    every: [/contacts route YIELDED|\[artifact-router\] intent=canvas_edit/, /\[canvas-cmd\] edit (applied|NOT applied|output REJECTED)/],
    never: [/\[contacts-query\] .*on canvas/],
  },
  {
    name: 'vague-edit-honesty',
    born: '08-08 "Prioritize editing…" — must refuse honestly or apply, never narrate success',
    text: 'Prioritize editing the Parish clean up document',
    every: [/\[canvas-cmd\] edit (applied|NOT applied|output REJECTED)/],
    never: [],
  },
  {
    name: 'pullup-retrieval',
    born: '08-07 the Louisiana list regenerated instead of retrieved (#11102)',
    text: 'Can you pull up that most recent list of ten people in Louisiana that we found contact information for?',
    every: [/\[artifact-router\] intent=pullup|\[pull-up\]/],
    never: [/\[contacts-query\] .*on canvas/],
  },
  {
    name: 'draw-yield-in-session',
    born: '08-08 M7.2 — the image intercept must not consume doc work during a canvas session',
    text: 'Draw up the parish document with cleaner formatting on the headers',
    every: [],
    never: [/\[draw\] intercept → generating/],
  },
  {
    name: 'plain-chat-control',
    born: 'the router must leave ordinary conversation alone (no door, no dump)',
    text: 'What was the most interesting thing you learned today?',
    every: [],
    never: [/\[canvas-cmd\]|\[pull-up\]|\[contacts-query\] .*on canvas|\[draw\] intercept/],
  },
  {
    name: 'contacts-no-session',
    born: 'M7.3 second direction — a contacts ask must still reach the contacts judgment when no artifact session owns the turn (state-tolerant: a live session yielding is also correct)',
    text: 'How many contacts do we hold with a phone number in Louisiana?',
    every: [/\[contacts-query\]|contacts route YIELDED/],
    never: [/\[canvas-cmd\] (edit applied|order executed)/],
  },
];

const get = (path) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path }, (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => res(JSON.parse(d))); }).on('error', rej);
});
const post = (body) => new Promise((res, rej) => {
  const payload = JSON.stringify(body);
  const req = http.request({ host: '127.0.0.1', port: PORT, path: '/turn', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
    (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => res({ code: r.statusCode, body: JSON.parse(d) })); });
  req.on('error', rej); req.write(payload); req.end();
});

async function waitIdle() {
  for (;;) {
    try {
      const s = await get('/status');
      if (!s.inFlight && (s.lastUserTurnAgoMs == null || s.lastUserTurnAgoMs > IDLE_MS)) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 30000));
  }
}

(async () => {
  const run = process.argv.includes('--run');
  const only = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7);
  const cases = only ? CASES.filter((c) => c.name === only) : CASES;
  if (!run) {
    console.log(`pathway_suite: ${CASES.length} cases (DRY — pass --run to execute; each case is a real turn):`);
    for (const c of CASES) console.log(`  - ${c.name}: ${c.born}`);
    process.exit(0);
  }
  let pass = 0, fail = 0;
  for (const c of cases) {
    await waitIdle();
    process.stdout.write(`[${c.name}] running… `);
    let r;
    try { r = await post({ text: c.text, settleMs: 12000, maxMs: 300000 }); }
    catch (e) { console.log(`ERROR ${e.message}`); fail++; continue; }
    if (r.code !== 200 || !r.body) { console.log(`HTTP ${r.code}: ${(r.body && r.body.error) || '?'}`); fail++; continue; }
    const lines = (r.body.logLines || []).join('\n');
    const missing = c.every.filter((re) => !re.test(lines));
    const forbidden = c.never.filter((re) => re.test(lines));
    if (!missing.length && !forbidden.length) { console.log(`PASS (${Math.round(r.body.tookMs / 1000)}s${r.body.settled ? '' : ', UNSETTLED'})`); pass++; }
    else {
      console.log('FAIL');
      for (const re of missing) console.log(`    missing: ${re}`);
      for (const re of forbidden) console.log(`    forbidden matched: ${re}`);
      fail++;
    }
  }
  console.log(`pathway_suite: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('suite crashed:', e.message); process.exit(1); });
