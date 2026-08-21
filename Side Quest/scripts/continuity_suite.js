/* THE MULTI-DAY CONTINUITY SUITE — Phase 1's gate (docs/DOCUMENT_PRODUCTION_PLAN_2026-08-21.md §3).
 *
 * The KIND: order a deliverable on day 1, add scope on day 2, status-check on day 3 — nothing
 * orphaned, ONE project, ONE canonical artifact, scope list accurate. The suite is LEG-PER-
 * INVOCATION with a durable state file, so one run spans REAL session/day boundaries: run it,
 * reboot/come back tomorrow, run it again — it knows which leg is next and what it recorded.
 *
 * Usage:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/continuity_suite.js --run=NAME [--topic="..."] [--no-wait-compose]
 *     --run=NAME     names the run; state lives at data/continuity_suite/NAME.json
 *     --topic="..."  required on the FIRST invocation (leg A); later legs read it from state
 *     --no-wait-compose  leg A: don't block waiting for the pursuit to land the artifact
 *   Each invocation drives exactly ONE leg through POST :8767/turn (the REAL pipeline) and
 *   asserts that leg's invariants against the live DB. Exit 0 = leg passed; 1 = leg failed;
 *   the final invocation (after leg C) prints the RUN verdict.
 *
 * Phrasings vary by run name (retest the KIND, not the phrase).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
process.chdir(path.join(__dirname, '..'));
const db = require('../lib/db'); db.init();
const dp = require('../lib/deliverable_projects');
const reg = require('../lib/artifact_registry');

const BASE = 'http://127.0.0.1:8767';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] == null ? true : m[2]] : [a, true]; }));
if (!args.run) { console.error('need --run=NAME'); process.exit(1); }

const STATE_DIR = path.join(__dirname, '..', 'data', 'continuity_suite');
fs.mkdirSync(STATE_DIR, { recursive: true });
const STATE_PATH = path.join(STATE_DIR, `${String(args.run).replace(/[^\w-]/g, '_')}.json`);
const state = fs.existsSync(STATE_PATH) ? JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) : { run: args.run, topic: null, slug: null, legs: [], notesSnapshot: null };
const save = () => fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');

// ── phrase variation by run-name hash (the KIND, never the phrase) ──────────────────────────────
const hash = [...String(args.run)].reduce((h, c) => ((h * 33) ^ c.charCodeAt(0)) >>> 0, 5381);
const ORDER_P = [(t) => `build the report on ${t}`, (t) => `put together a report on ${t}`, (t) => `draft the report on ${t}`];
const SCOPE_P = [(s, t) => `also fold ${s} into the ${t} report`, (s, t) => `add ${s} to the ${t} report`, (s, t) => `the ${t} report should also cover ${s}`];
const STATUS_P = [(t) => `where are we on the ${t} report`, (t) => `what's the status of the ${t} report`, (t) => `any progress on the ${t} report?`];
const SCOPE_ITEMS = ['a grid reliability section', 'a funding-sources breakdown', 'a timeline of key votes'];
const pick = (arr, salt) => arr[(hash + salt) % arr.length];

// ── plumbing ────────────────────────────────────────────────────────────────────────────────────
function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(BASE + p, { method, timeout: 300000, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} },
      (res) => { let buf = ''; res.on('data', (c) => buf += c); res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve({ ok: false, error: 'bad json: ' + buf.slice(0, 200) }); } }); });
    r.on('error', reject); r.on('timeout', () => r.destroy(new Error('request timeout')));
    if (data) r.write(data); r.end();
  });
}
async function waitIdle(capMs = 16 * 60000) {
  const t0 = Date.now();
  for (;;) {
    const s = await req('GET', '/status').catch(() => null);
    if (s && s.ok && !s.inFlight && (s.lastUserTurnAgoMs == null || s.lastUserTurnAgoMs > 125000)
      && (s.lastRealUserTurnAgoMs == null || s.lastRealUserTurnAgoMs > 615000)) return;
    if (Date.now() - t0 > capMs) throw new Error('waitIdle timeout — pipeline busy or a real exchange owns it');
    await sleep(8000);
  }
}
let pass = 0, fail = 0;
const ok = (c, t, detail = '') => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t, detail ? `— ${detail}` : ''); } };
const shortTopic = (t) => reg.tokensOf(t).slice(0, 3).join(' ');
const notesReportFiles = () => { try { return fs.readdirSync(require('../lib/files').resolvePath('notes')).filter((f) => /^report-.*\.md$/i.test(f)).sort(); } catch { return []; } };
const bootId = () => { try { const l = fs.readdirSync('.').filter((f) => /^boot_p\d+\.log$/.test(f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs); return l[0] || '?'; } catch { return '?'; } };

// ── the legs ────────────────────────────────────────────────────────────────────────────────────
(async () => {
  const leg = ['A', 'B', 'C'][state.legs.length];
  if (!leg) { console.log(`run "${state.run}" is COMPLETE — verdict already rendered. Start a new --run for a fresh pass.`); process.exit(0); }
  if (leg === 'A') {
    if (!args.topic) { console.error('leg A needs --topic="..."'); process.exit(1); }
    state.topic = String(args.topic);
    state.notesSnapshot = notesReportFiles();
  }
  const t = state.topic, st = shortTopic(t);
  console.log(`\n═══ CONTINUITY RUN "${state.run}" — LEG ${leg} (${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET, ${bootId()}) ═══`);
  await waitIdle();

  if (leg === 'A') {
    const text = pick(ORDER_P, 0)(t);
    console.log(`ORDER: "${text}"`);
    const r = await req('POST', '/turn', { text, settleMs: 15000, maxMs: 240000 });
    if (r.error) console.log('port:', r.error);
    console.log('SAY:', String(r.say || '').replace(/\s+/g, ' ').slice(0, 300));
    const p = dp.findProject(t);
    ok(!!p, 'A1 the order BOUND: a project row exists for the topic', 'no project row — the intake bind missed');
    if (p) {
      state.slug = p.slug;
      ok(p.spec.some((s) => s.text === text), 'A2 the VERBATIM ask is on the spec', `spec: ${JSON.stringify(p.spec.map((s) => s.text))}`);
    }
    const openP = db.getDb().prepare(`SELECT COUNT(*) n FROM recheck_queue WHERE kind='promise' AND status='open'`).get().n;
    const composed = (r.logLines || []).some((l) => /\[report-cmd\] report on .* composed/.test(l));
    // Third tracked state (leg-A catch, compressed-1): the operator delivers IN-TURN via a file
    // write — intake logs it as a kept order. Tracked = composed | kept-in-turn | open promise.
    const keptInTurn = (r.logLines || []).some((l) => /deliverable order delivered in-turn/.test(l));
    ok(composed || keptInTurn || openP > 0, 'A3 the debt is TRACKED (composed / kept in-turn / an open promise)', `open promises: ${openP}`);
    // the pursuit lands the artifact async — wait for the registry row unless told not to
    if (!args['no-wait-compose'] && p) {
      let landed = null;
      for (let i = 0; i < 90 && !landed; i++) {
        const row = dp.get(p.slug);
        landed = reg.get((row && row.artifact_slug) || p.slug);
        if (!landed) await sleep(10000);
      }
      ok(!!landed, 'A4 the canonical artifact LANDED (registry row exists)', 'compose still pending after 15min — recorded, leg B will retest');
      if (landed) console.log(`   canonical: ${landed.rel_path} v${landed.version}`);
    }
  }

  if (leg === 'B') {
    const item = pick(SCOPE_ITEMS, 1);
    const text = pick(SCOPE_P, 1)(item, st);
    console.log(`SCOPE-ADD: "${text}"`);
    const before = dp.list().length;
    const specBefore = (dp.get(state.slug) || { spec: [] }).spec.length;
    const r = await req('POST', '/turn', { text, settleMs: 15000, maxMs: 240000 });
    if (r.error) console.log('port:', r.error);
    console.log('SAY:', String(r.say || '').replace(/\s+/g, ' ').slice(0, 300));
    const p = dp.get(state.slug);
    ok(dp.list().length === before, 'B1 NO sibling project minted — the follow-up bound to the same project', `projects: ${before} → ${dp.list().length}`);
    ok(p && p.spec.length > specBefore, 'B2 the follow-up ask joined the spec', `spec ${specBefore} → ${p ? p.spec.length : '?'}`);
    const itemToks = reg.tokensOf(item);
    ok(p && p.scope.some((s) => s.status === 'open' && itemToks.some((w) => s.item.toLowerCase().includes(w))), 'B3 the NOVEL scope is an OPEN item on the row', `scope: ${JSON.stringify((p || {}).scope)}`);
    state.scopeItem = item;
  }

  if (leg === 'C') {
    const text = pick(STATUS_P, 2)(st);
    console.log(`STATUS: "${text}"`);
    const r = await req('POST', '/turn', { text, settleMs: 15000, maxMs: 240000 });
    if (r.error) console.log('port:', r.error);
    const say = String(r.say || '');
    console.log('SAY:', say.replace(/\s+/g, ' ').slice(0, 400));
    ok((r.logLines || []).some((l) => /\[projects\] status ask/.test(l)), 'C1 the status INJECTION fired (row facts rode the reply context)');
    const p = dp.get(state.slug);
    const art = p && p.artifact_slug ? reg.get(p.artifact_slug) : reg.get(state.slug);
    ok(art ? say.includes(path.basename(art.rel_path, '.md')) || /version \d/i.test(say) : /no.*(artifact|report|file)|not.*(landed|composed|built)/i.test(say),
      'C2 the say names the CANONICAL artifact (or honestly reports none landed)', art ? `expected "${path.basename(art.rel_path)}" or a version — say lacked both` : '');
    const openItems = p ? p.scope.filter((s) => s.status === 'open') : [];
    if (openItems.length) {
      const mentioned = openItems.some((s) => reg.tokensOf(s.item).some((w) => say.toLowerCase().includes(w)));
      ok(mentioned, 'C3 open scope is REPORTED accurately (an open item is named)', `open: ${openItems.map((s) => s.item).join('; ')}`);
    } else {
      ok(!/still (?:need|working|folding)|open scope/i.test(say) || /no open scope|none/i.test(say), 'C3 no open scope → none claimed');
    }
    // ── the RUN verdict ──
    console.log('\n─── RUN VERDICT ───');
    const kin = dp.list().filter((row) => reg.kinScore(t, row.title || '') >= 0.5 || row.slug === state.slug);
    ok(kin.length === 1, 'V1 ONE project row for the whole arc', `kin rows: ${kin.map((k) => k.slug).join(', ')}`);
    const newFiles = notesReportFiles().filter((f) => !state.notesSnapshot.includes(f));
    const canonBase = art ? path.basename(art.rel_path) : null;
    ok(newFiles.every((f) => f === canonBase), 'V2 ONE canonical artifact — no slug-siblings minted across the legs', `new report files: ${newFiles.join(', ') || '(none)'}`);
    // Only THIS ARC's promises count — background lanes legitimately book unrelated debts
    // across a multi-day window. Kin = the promise's topic/subject matches our topic.
    const openRows = db.getDb().prepare(`SELECT id, subject, detail FROM recheck_queue WHERE kind='promise' AND status='open' AND created_ts >= ?`).all(state.legs[0] ? state.legs[0].ts : 0);
    const orphans = openRows.filter((row) => {
      let d = {}; try { d = JSON.parse(row.detail || '{}'); } catch {}
      return reg.kinScore(t, d.topic || row.subject || '') >= 0.5;
    });
    ok(orphans.length === 0, 'V3 nothing ORPHANED — every promise born in this arc is closed', orphans.map((o) => `#${o.id} ${o.subject}`).join(', '));
  }

  state.legs.push({ leg, ts: Date.now(), boot: bootId(), pass, fail });
  save();
  console.log(`\nLEG ${leg}: ${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  if (leg !== 'C') console.log(`state saved → run leg ${leg === 'A' ? 'B' : 'C'} after the next session/day boundary:\n  ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/continuity_suite.js --run=${state.run}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('SUITE ERROR:', e.message); process.exit(1); });
