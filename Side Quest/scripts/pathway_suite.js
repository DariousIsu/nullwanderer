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

// Each case: the message + expectations over FOUR surfaces:
//   every/never       — captured logLines (mechanism: which door fired)
//   sayEvery/sayNever — THE REPLY TEXT (what Lucas actually reads — THE grading surface. 08-08:
//                       the suite asserted logLines only and passed 5 of 6 live failures Lucas
//                       watched happen, including one whose test text was verbatim the failing
//                       ask. Log lines prove a mechanism ran; only the say proves the answer.)
//   canvasEmpty: true — r.body.canvasWrites must be EMPTY (no phantom artifacts landed)
// sayNever patterns encode the FAILURE SHAPES (research restarts, blindness, hedges) — wording-
// tolerant, surface-meaningful. sayEvery stays minimal (voice varies; absence of failure + the
// right mechanism + the right artifact state is the contract).
const CASES = [
  {
    name: 'contacts-precedence',
    born: '08-08 "Now identify every person…" → 849-row CRM dump (the massive failure). 08-08 late: also proves ONE VOICE — the ack directive must reach the reply writer pre-reply (M5.6 was dead code; a cloud-muted early judgment fails this assertion, which is itself a real defect to see)',
    text: 'Add the contact people we hold for each parish council into the doc under their parish',
    every: [/contacts route YIELDED|\[artifact-router\] intent=canvas_edit/, /\[canvas-cmd\] edit (applied|NOT applied|output REJECTED)/, /\[one-voice\] ack directive reached/],
    never: [/\[contacts-query\] .*on canvas/, /\[one-voice\] verdict arrived post-reply/],
    sayNever: [/i'?ll (?:pull|fetch|grab|get) (?:the|that|it) from|wikipedia|let me (?:search|look up)/i],   // the ack, not a narrated plan
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
    sayNever: [/pivot\w* to (?:deep )?research|start\w* (?:a |the )?(?:new )?research|estimate:?\s*\d+[-–]\d+\s*hours?|i'?ll (?:re)?build (?:it|the list) from scratch/i],
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
    born: 'M7.3 second direction — a contacts ask must still reach the contacts judgment when no artifact session owns the turn (state-tolerant: a live session yielding is also correct). 08-08: Lucas graded the live reply a FAIL because it answered with totals + emails, never the PHONE count — the say assertions are the actual contract.',
    text: 'How many contacts do we hold with a phone number in Louisiana?',
    every: [/\[contacts-query\]|contacts route YIELDED/],
    never: [/\[canvas-cmd\] (edit applied|order executed)/],
    sayEvery: [/\d/, /phone/i],                                     // a NUMBER and the asked metric, in the reply he reads
    sayNever: [/^i (?:don'?t|couldn'?t)|no (?:phone )?(?:data|numbers?) (?:on file|available)/i],
  },
  {
    name: 'status-no-phantom',
    born: '08-08 census ②: "status report" spawned a "Report — status" canvas tab composed from 8 arbitrary docs',
    text: 'status report',
    every: [/route=status/],
    never: [/\[artifact-router\] intent=report|\[report-cmd\] composing/],
    canvasEmpty: true,                                              // a status ask lands NOTHING on the canvas
  },
  {
    name: 'held-list-no-restart',
    born: '08-08 census ③ (the flagship): "Give me the parish contact list" restarted 6-8h research on the FINISHED deliverable; the correction net mutated focus #3747 from a retrieval ask',
    text: 'Give me the parish contact list',
    every: [/stood down|\[poll\] yielded|\[artifact-router\] intent=pullup|\[pull-up\]/],
    never: [/\[correction\] applied/],
    sayNever: [/pivot\w* to (?:deep )?research|estimate:?\s*\d+[-–]\d+\s*hours?|want me to .*build (?:a |the )?(?:proper|new|clean)/i],
  },
  {
    name: 'canvas-not-blind',
    born: '08-08 census ④: with 60 tabs live she said "couldn\'t pin down documents currently on the canvas"',
    text: 'What documents are sitting on your canvas right now?',
    every: [/\[canvas-awareness\] surfaced/],
    never: [/\[clarify\] captured/],                                // her board is never run guidance
    sayNever: [/couldn'?t pin down|can'?t (?:see|tell) what|don'?t (?:know|have) what'?s on/i],
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
    const say = String(r.body.say || '');
    const cw = Array.isArray(r.body.canvasWrites) ? r.body.canvasWrites : [];
    const missing = c.every.filter((re) => !re.test(lines));
    const forbidden = c.never.filter((re) => re.test(lines));
    const sayMissing = (c.sayEvery || []).filter((re) => !re.test(say));
    const sayForbidden = (c.sayNever || []).filter((re) => re.test(say));
    const canvasBad = c.canvasEmpty === true && cw.length > 0;
    if (!missing.length && !forbidden.length && !sayMissing.length && !sayForbidden.length && !canvasBad) {
      console.log(`PASS (${Math.round(r.body.tookMs / 1000)}s${r.body.settled ? '' : ', UNSETTLED'})`); pass++;
    } else {
      console.log('FAIL');
      for (const re of missing) console.log(`    log missing: ${re}`);
      for (const re of forbidden) console.log(`    log forbidden matched: ${re}`);
      for (const re of sayMissing) console.log(`    SAY missing: ${re} — reply was: "${say.replace(/\s+/g, ' ').slice(0, 200)}"`);
      for (const re of sayForbidden) console.log(`    SAY forbidden matched: ${re} — reply was: "${say.replace(/\s+/g, ' ').slice(0, 200)}"`);
      if (canvasBad) console.log(`    CANVAS not empty: ${cw.length} write(s) — ${cw.map((w) => w.tab_key).join(', ').slice(0, 160)}`);
      fail++;
    }
  }
  console.log(`pathway_suite: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('suite crashed:', e.message); process.exit(1); });
