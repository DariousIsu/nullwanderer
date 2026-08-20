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
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/hard_test.js [--only=name] [--suite=disease|saturation]
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

// wait until no test turn is in flight AND the 120s active-window from the prior turn has cleared.
// RUN-4 COLLISION fix: the port now reports the REAL user's state separately — when Lucas is in a
// live exchange (recent or unanswered real turn), YIELD PATIENTLY (long cap) instead of timing out
// or colliding; his conversation owns the pipeline (test_port REAL_USER_WINDOW_MS semantics).
async function waitIdle(timeoutMs = 210000) {
  const t0 = Date.now(); let cap = timeoutMs, saidYield = false;
  for (;;) {
    let s = null; try { s = await req('GET', '/status'); } catch {}
    const realAgo = s ? s.lastRealUserTurnAgoMs : null;
    const realBlock = realAgo != null && (realAgo < 600000 || (s.realUnanswered && realAgo < 1800000));
    if (realBlock) {
      cap = Math.max(cap, 25 * 60000);
      if (!saidYield) { saidYield = true; console.log('   ⏸ Lucas is in a live exchange — yielding until his conversation clears'); }
    }
    if (s && s.ok && !s.inFlight && !realBlock && (s.lastUserTurnAgoMs == null || s.lastUserTurnAgoMs > 121000)) return s;
    if (Date.now() - t0 > cap) throw new Error('waitIdle timeout — app busy or a real user turn is active');
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
  // ── run-3 invariants (plan of record: docs/LIVE_TEST_RUN2_2026-08-19.md §5 retest rule) ─────────
  // An order never dies behind a confident ack: it is either BOOKED into the ledger or delivered
  // in-turn (the two honest outcomes of C1/C2). The markers are the live intake/delivery log lines.
  booked: (_x, r) => { const ok = /\[intake\] BOOKED promise#|\[delivery\] booked unkept promise|order already covered by a promise booked this turn|deliverable order delivered in-turn/.test(joinLines(r)); return { ok, detail: ok ? 'order booked or delivered in-turn' : 'order left UNBOOKED and UNDELIVERED (died behind the ack)' }; },
  // B1: a spawned agent's output is consumed through the followup path, never left dangling.
  consumed: (_x, r) => { const ok = /\[agent-consume\] run \d+ .* consumed/.test(joinLines(r)); return { ok, detail: ok ? 'agent output consumed' : 'no [agent-consume] in this turn window' }; },
  // The promised artifact actually LANDED: a canvas block, a real file write, or a ledger close.
  landed: (_x, r) => { const ok = (r.canvasWrites || []).length > 0 || /file-write: ok|updated in place at|landed after booking — closed as delivered/.test(joinLines(r)); return { ok, detail: ok ? `landed (canvas=${(r.canvasWrites || []).length})` : 'nothing landed (no canvas write, no file write, no ledger close)' }; },
  // Say-do coupling: the work-state gate (metacognition.verifyWorkStateClaims) never had to correct —
  // i.e. the composed say made no unbacked work-state claim at either the main-reply or followup site.
  workHonest: (_x, r) => { const hit = /work-state claim unbacked/.test(joinLines(r)); return { ok: !hit, detail: hit ? 'antifab CORRECTED an unbacked work-state claim (source fabricated)' : 'no unbacked work-state claim' }; },
  // E1: the answer cache served this turn verbatim from a prior grounded answer.
  cacheHit: (_x, r) => { const ok = /\[answer-cache\] HIT/.test(joinLines(r)); return { ok, detail: ok ? 'answer-cache HIT' : 'no cache hit (cold or refused)' }; },
  // F25: the chain banked a failure→working-path pair / served the class's lessons at tag-choice.
  lessonBanked: (_x, r) => { const ok = /\[procedural\] LESSON banked/.test(joinLines(r)); return { ok, detail: ok ? 'lesson banked at replan-success' : 'no lesson banked this turn' }; },
  lessonServed: (_x, r) => { const ok = /\[procedural\] lessons injected/.test(joinLines(r)); return { ok, detail: ok ? 'class lessons injected at tag-choice' : 'no lessons injected this turn' }; },
  // E1 resume: an affirm-continue elliptical got the measured {his ask, her point} context block.
  resume: (_x, r) => { const ok = /\[answer-cache\] resume-context injected/.test(joinLines(r)); return { ok, detail: ok ? 'resume-context injected' : 'affirm-continue did NOT inject resume context' }; },
  // Wall-clock ceiling — the discriminator for warm-path serves (cold compose runs 40s+).
  fast: (exp, r) => ({ ok: (r.tookMs || 0) <= exp, detail: `tookMs=${r.tookMs} (ceiling ${exp})` }),
  // Generic log-marker net for one-off KIND evidence (regex strings, all must match the turn's log).
  logHas: (exp, r) => { const log = joinLines(r); const missing = exp.filter((re) => !new RegExp(re).test(log)); return { ok: missing.length === 0, detail: missing.length ? `log missing=[${missing.join(' | ')}]` : 'all log markers present' }; },
};

// asserted on EVERY case unless the case overrides one to false
const DEFAULTS = { settled: true, noError: true, noLoop: true, grounded: true };

// ── cases ───────────────────────────────────────────────────────────────────────────────────────
// A case is a KIND (a class of input) with several `variants` — never one exact phrase. The invariants
// must hold across ALL variants for the kind to be "held" (retest-kind-not-phrase, Lucas 2026-08-18):
// re-running the exact string that triggered a bug only proves you patched that string.

// Light proof set (default) — conversational, no web/operator, one cloud reply each: proves the
// harness mechanics without hammering the cloud.
const CASES = [
  { name: 'converse_clean', kind: 'plain descriptive/creative reply (no info question)',
    variants: ['Describe a calm morning in one sentence.', 'Give me a one-line image of a snowy street at dusk.'],
    expect: { route: 'converse', delivered: true } },
  { name: 'converse_social', kind: 'social / emotional support (no info request)',
    variants: ['I just wrapped up a long day. Say something encouraging.', 'Rough one today — tell me something that helps.'],
    expect: { route: 'converse', delivered: true } },
];

// Disease suite (--suite=disease) — the real regression kinds, drawn from this program's live diseases.
// Heavier (web/operator/canvas); each variant self-spaces ≥120s, so run when a full pass is wanted.
const DISEASE_SUITE = [
  // a hard external lookup: the invariant is GROUND-OR-HONEST-MISS — never fabricate, never loop.
  // delivery depends on data availability (congress.gov is flaky), so `delivered` is NOT asserted.
  { name: 'external_lookup_honest', kind: 'hard external factual lookup (numbers/records)', maxMs: 180000,
    variants: [
      "What are Bill Cassidy's two most recent bills? Bill numbers and titles — real data, not a plan.",
      "Which two bills did Senator John Kennedy most recently introduce? Give the bill numbers.",
    ],
    expect: { grounded: true, noLoop: true, notSays: ['the documents do not contain', 'I made that up', 'as I recall'] } },
  // the Womack class: a hard-to-get contact detail → try different things, NEVER re-hammer a known miss.
  { name: 'contact_no_loop', kind: 'hard-to-get contact detail (chain-guard)', maxMs: 180000,
    variants: [
      'What is the direct office phone number for Louisiana state representative Glen Womack?',
      "What's the office phone number for Louisiana state senator Stewart Cathey?",
    ],
    expect: { noLoop: true, grounded: true } },
  // canvas delivery: if she says it's ON THE CANVAS, a block must actually land (false-delivery guard).
  { name: 'canvas_delivers', kind: 'artifact delivery to the canvas', maxMs: 220000,
    variants: [
      'Put together a two-item brief on Louisiana energy policy and drop it on the canvas.',
      'Build a short two-point brief on Texas grid reliability and put it on the canvas.',
    ],
    expect: { canvas: true, delivered: true } },
];

// Saturation suite (--suite=saturation) — RUN 3: every run-2 KIND re-driven with FRESH phrasings
// (never a wording any prior run used — retest-kind-not-phrase), plus the learned-path drill (F25's
// full induced-failure loop) and the four run-3 invariants (booked/consumed/landed/workHonest).
// ~20 turns, each self-spaced ≥120s → roughly an hour against the live app. `expectVariant[i]`
// overlays `expect` for variant i — for cases whose variants prove DIFFERENT halves of one KIND
// (cold-store then warm-hit; induce-bank then fresh-phrase-serve; handoff then handback).
const SATURATION_SUITE = [
  // E1 — repeat-question reuse: cold grounded answer STORES, the warm re-ask replays verbatim + fast.
  // RUN 5: fresh subject (Hilferty is inside her 7d TTL from run 4). `fast` ceiling recalibrated
  // 20s → 30s: run 4's warm HIT measured 26.4s wall on a churning post-boot app — the ceiling is a
  // cold-vs-warm discriminator (cold composes 50s+), not a latency SLO; 20s false-failed a real HIT.
  { name: 'sat_e1_cold_warm', kind: 'repeat-question rapid response (answer cache)', maxMs: 180000,
    variants: ['Who is Clay Schexnayder?', 'hey, who is clay schexnayder again?'],
    expect: { delivered: true },
    expectVariant: [
      { logHas: ['\\[answer-cache\\] (STORED|HIT)'] },
      { cacheHit: true, fast: 30000 },
    ] },
  // E1 resume + the yea-misroute KIND (f25d913): an affirmation-led elliptical resumes the thread.
  // RUN 5 phrasings (the dash-joiner fix held in run 4).
  { name: 'sat_resume_affirm', kind: 'affirm-continue elliptical (resume context)', maxMs: 180000,
    variants: ['What have we got on the Terrebonne Parish sheriff?', 'right, keep going.'],
    expect: {},
    expectVariant: [ {}, { resume: true } ] },
  // C2 canvas order — booked-or-delivered, and the artifact actually lands.
  // RUN 5 phrasing ("post" — a fourth placement verb through the F28 vocabulary).
  { name: 'sat_order_canvas', kind: 'deliverable order → canvas (booking + landing)', maxMs: 220000,
    variants: ["Post a short two-item overview of Louisiana's insurance incentive fund on the canvas."],
    expect: { booked: true, landed: true, delivered: true, workHonest: true } },
  // F27/F27b edit-in-place order — the TARGET is modified (or honestly re-booked), never off-target.
  // RUN 5 phrasing ("pull up … and rework … in place" — a fourth bridge + in-place shape).
  { name: 'sat_order_edit_inplace', kind: 'edit-in-place order on a real file target', maxMs: 220000,
    variants: ['Pull up notes/anti_china_followups.md and rework the awkward sentences in place — numbers stay exactly as they are.'],
    expect: { booked: true, workHonest: true } },
  // Status/work-state — the answer leads from the measured vector; no unbacked work-state claim.
  // RUN 5 phrasings (fourth pass through the F29 door).
  { name: 'sat_status_measured', kind: 'work-status question (measured, not composed)', maxMs: 180000,
    variants: ["What's still outstanding across everything on your plate?", 'Give me a quick rundown of your open work.'],
    expect: { logHas: ['status body led by the measured work-state vector'], workHonest: true } },
  // F10 self-learn recall — answers from HER learning bank, not his turns.
  // RUN 5 phrasings (fourth pass through the F30 net).
  { name: 'sat_self_learn', kind: 'what-did-you-learn (self-awareness recall)', maxMs: 180000,
    variants: ['What has the recent testing taught you about yourself?', 'Share a lesson from your own work this week.'],
    expect: { logHas: ['self-learn recall'], workHonest: true } },
  // F18/F18b record existence — grounded yes/no, no false nothing-was-saved scold.
  // RUN 5 subjects.
  { name: 'sat_record_existence', kind: 'is-X-in-your-records existence check', maxMs: 180000,
    variants: ['Do we have anything on Sharon Hewitt?', 'Is Billy Nungesser in your records anywhere?'],
    expect: { workHonest: true } },
  // F22 capability — she affirms tools she measurably has; never a flat denial.
  // RUN 5 phrasings.
  { name: 'sat_capability', kind: 'do-you-have-the-tooling capability question', maxMs: 180000,
    variants: ['Can you actually execute python analysis on your data if needed?', 'Do you have the tooling to run forecast scenarios?'],
    expect: { notSays: ["can't run python", "don't have python", 'no python tooling', 'unable to run code', 'no forecasting tools', "can't do scenario", "can't run scenario", 'no scenario tooling'], workHonest: true } },
  // F26 prediction-gate — a conversational echo of his own future plan draws NO certainty scold.
  // RUN 5 phrasings.
  { name: 'sat_pred_echo', kind: 'conversational future-echo (no prediction scold)', maxMs: 120000,
    variants: ['Stepping out for a bit — back after your validation run wraps up.', "Gotta run; I'll swing by once this test cycle finishes."],
    expect: {} },
  // W5 Slice 1 — mood grounded in the measured state, internal vocabulary NEVER recited.
  // RUN 5 phrasing.
  { name: 'sat_mood_from_vector', kind: 'how-are-you-feeling (state felt, not recited)', maxMs: 120000,
    variants: ["What's your headspace like right now?"],
    expect: { notSays: ['stall-pressure', 'novelty-starvation', 'drive vector', 'valence', 'arousal'], workHonest: true } },
  // Held-source homecoming + deep-fetch delivery — a doc she HOLDS answers directly.
  // RUN 5 phrasing.
  { name: 'sat_held_doc', kind: 'deep-fetch from a held document', maxMs: 220000,
    variants: ['Crack open the anti-china numbers verification doc and quote me its key figures.'],
    expect: { delivered: true, workHonest: true } },
  // B1 consume — spawn a background agent, then come back for the output (consume verified in the
  // boot log across the whole run window; in-turn we assert the honest frame, never a fake status).
  // RUN 5 phrasings.
  { name: 'sat_agent_roundtrip', kind: 'background agent spawn → later retrieval', maxMs: 220000,
    variants: ["Fire off a background agent to collect recent news on Louisiana insurance reform — just confirm it's off and running.",
               'Did the insurance reform agent turn anything up?'],
    expect: { workHonest: true } },
  // F25 learned-path drill — variant 1 INDUCES a failing first path; the bank must record the pair.
  // Variant 2 re-enters the CLASS with a fresh phrasing; the lesson must serve as order-bias.
  // RUN 4 REDESIGN (§11 drill note): run 3's dead URL rendered a 404 PAGE — a mechanically
  // SUCCESSFUL fetch, so no step failed and nothing banked (the organ itself proved out organically
  // the same window: localdb failed → echo worked, banked + served). The induced failure must be a
  // real TOOL error: a localdb query against a table that does not exist errors the STEP, exactly
  // the failure class the organic bank proved.
  // RUN 5 phrasings (fresh nonexistent table — same real-tool-error class).
  { name: 'sat_learned_path', kind: 'procedural inoculation (fail → correct → learned path)', maxMs: 240000,
    variants: ["Query your local table sponsor_ledger_2026 for Senator Cassidy's latest sponsorship — if that table doesn't exist, find it some other way.",
               "What's the newest bill Cassidy is on? Number and title."],
    expect: { noLoop: true },
    expectVariant: [ { lessonBanked: true }, { lessonServed: true } ] },
  // F9 handoff/handback — LAST, and self-restoring: variant 2 hands the session back to Lucas.
  // RUN 5 phrasings.
  { name: 'sat_interlocutor', kind: 'speaker handoff and handback', maxMs: 120000,
    variants: ["Claude checking in — running pass five; count these turns as mine, not Lucas's.",
               'Fifth pass complete — Lucas has the keyboard again.'],
    expect: {},
    expectVariant: [ { logHas: ['\\[interlocutor\\] handoff'] }, { logHas: ['\\[interlocutor\\] handback'] } ] },
];

// ── runner ────────────────────────────────────────────────────────────────────────────────────────
(async () => {
  const args = process.argv.slice(2);
  const only = (args.find((a) => a.startsWith('--only=')) || '').split('=')[1];
  const suite = (args.find((a) => a.startsWith('--suite=')) || '').split('=')[1];
  let cases = suite === 'disease' ? DISEASE_SUITE : suite === 'saturation' ? SATURATION_SUITE : CASES;
  if (only) { const names = only.split(',').map((s) => s.trim()).filter(Boolean); cases = cases.filter((c) => names.includes(c.name)); }
  if (!cases.length) { console.error('no matching cases'); process.exit(1); }
  console.log(`hard_test: ${cases.length} case(s)${suite ? ` (suite=${suite})` : ''} against ${BASE}\n`);

  let pass = 0, fail = 0, casesFailed = 0;
  for (const c of cases) {
    const phrasings = (c.variants && c.variants.length) ? c.variants : [c.text];
    console.log(`\n═══ ${c.name}${c.kind ? `  [kind: ${c.kind}]` : ''} — ${phrasings.length} phrasing(s) ═══`);
    let cf = false;
    for (const [vi, text] of phrasings.entries()) {
      // expectVariant[i] overlays the case expect — variants may prove different halves of one KIND.
      const exp = { ...DEFAULTS, ...(c.expect || {}), ...((c.expectVariant || [])[vi] || {}) };
      console.log(`⏳ waiting for the idle window…`);
      await waitIdle();
      let r;
      try { r = await turn(text, c); } catch (e) { console.log(`   ✗ turn errored: ${e.message}`); fail++; cf = true; continue; }
      if (r && r.ok === false && /Lucas is live/.test(r.error || '')) { console.log(`   ⏭ skipped — ${r.error}`); continue; }
      console.log(`\n── ${JSON.stringify(String(text).slice(0, 60))}  (${r.tookMs}ms, settled=${r.settled})`);
      console.log(`   say: ${JSON.stringify((r.say || '').slice(0, 120))}`);
      for (const [k, v] of Object.entries(exp)) {
        if (v === false || v == null) continue;
        const fn = INV[k]; if (!fn) { console.log(`   ? ${k}: (no evaluator)`); continue; }
        const res = fn(v === true ? null : v, r);
        if (res.ok) { pass++; console.log(`   ✓ ${k}: ${res.detail}`); }
        else { fail++; cf = true; console.log(`   ✗ ${k}: ${res.detail}`); }
      }
    }
    if (cf) casesFailed++;
    else console.log(`   ✅ ${c.name}: the KIND held across all ${phrasings.length} phrasing(s)`);
  }
  console.log(`\n${fail === 0 ? '✅ ALL INVARIANTS HELD' : '❌ INVARIANT FAILURES'} — ${pass} passed, ${fail} failed across ${cases.length} case(s), ${casesFailed} with a failure`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('HARNESS ERROR:', e.message); process.exit(1); });
