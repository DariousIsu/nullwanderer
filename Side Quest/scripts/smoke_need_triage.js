/* Smoke: lib/need_triage — P0b, the needs get consumed (triage contract, pressure rule, external
 * ask) + source asserts on the autonomy-tick wiring. Pure/offline.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_need_triage.js
 */
'use strict';
const nt = require('../lib/need_triage');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// --- triage contract ---
const inp = nt.triageInput({ need: 'parse XLS roster files into contacts', born_from: 'inquiry-54-t4', recurrence: 3 });
ok(inp.need === 'parse XLS roster files into contacts' && inp.bornFrom === 'inquiry-54-t4' && inp.recurrence === 3, 'input carries need + provenance + recurrence');
ok(!('recurrence' in nt.triageInput({ need: 'x'.repeat(20) })), 'single-occurrence needs omit the recurrence field');
const want = nt.triageWant();
ok(/"buildable"\|"external"\|"research"\|"junk"/.test(want) && /build_sketch/.test(want) && /study_query/.test(want), 'want names the four classes + the build fields');
ok(/paid database.*is external, not buildable/i.test(want) && /parse XLS.*is buildable/i.test(want) && /who funds X.*is research/i.test(want), 'want carries the calibration examples (strict about buildable)');

// --- validator ---
ok(nt.triageValidator('{"class":"buildable","reason":"r","build_sketch":"s","study_query":"q","ask":""}').valid === true, 'validator accepts a buildable verdict');
ok(nt.triageValidator('<think>{"class":"junk"}</think>{"class":"external","reason":"needs a subscription","ask":"an FDO login"}').valid === true, 'validator strips think blocks first');
ok(nt.triageValidator('{"class":"maybe"}').valid === false && nt.triageValidator('prose').valid === false, 'a non-verdict is rejected');

// --- duePressure: the deterministic selection rule ---
const now = 10_000_000;
const GAP = 30 * 60 * 1000;
const mkNeeds = () => [
  { id: 3, status: 'open', created_ts: 300, triage: 'buildable' },
  { id: 1, status: 'open', created_ts: 100, triage: null },
  { id: 2, status: 'open', created_ts: 200, triage: 'buildable' },
  { id: 4, status: 'rehearsing', created_ts: 50, triage: 'buildable' },
];
ok(nt.duePressure({ needs: mkNeeds(), lastRehearseTs: now - 1000, nowMs: now, gapMs: GAP }) === null, 'inside the calm gap → nothing is due (needs-work paces itself)');
let d = nt.duePressure({ run: { status: 'active', slug: 'r' }, needs: mkNeeds(), lastRehearseTs: 0, nowMs: now, gapMs: GAP });
ok(d && d.kind === 'iterate', 'a live run is advanced before anything opens (one-at-a-time)');
d = nt.duePressure({ run: { status: 'parked', slug: 'r' }, needs: [], lastRehearseTs: 0, nowMs: now, gapMs: GAP });
ok(d && d.kind === 'iterate', 'a parked run resumes under pressure too');
d = nt.duePressure({ run: { status: 'discarded' }, needs: mkNeeds(), lastRehearseTs: 0, nowMs: now, gapMs: GAP });
ok(d && d.kind === 'triage' && d.needId === 1, 'no live run → the OLDEST untriaged open need is triaged first');
d = nt.duePressure({ needs: mkNeeds().filter((n) => n.id !== 1), lastRehearseTs: 0, nowMs: now, gapMs: GAP });
ok(d && d.kind === 'open' && d.needId === 2, 'all triaged → the oldest BUILDABLE open need opens (rehearsing rows never re-picked)');
ok(nt.duePressure({ needs: [{ id: 9, status: 'open', created_ts: 1, triage: 'external' }], lastRehearseTs: 0, nowMs: now }) === null, 'a queue of only non-buildable needs forces nothing');
ok(nt.duePressure({}) === null, 'empty world → null, no throw');

// --- M2.5.6 self-repair priority: a self-watch need jumps the queue ---
ok(nt.isSelfWatch({ born_from: 'self-watch: recurred 3x/…' }) === true && nt.isSelfWatch({ born_from: 'inquiry-54-t4' }) === false, 'isSelfWatch keys off the born_from prefix');
{
  // #1 (older, inquiry) vs #7 (younger, self-watch): the self-watch need is triaged FIRST.
  const mixed = [
    { id: 1, status: 'open', created_ts: 100, triage: null, born_from: 'inquiry-9-t2' },
    { id: 7, status: 'open', created_ts: 500, triage: null, born_from: 'self-watch: exhaust audit loop' },
  ];
  const t = nt.duePressure({ run: { status: 'discarded' }, needs: mixed, lastRehearseTs: 0, nowMs: now, gapMs: GAP });
  ok(t && t.kind === 'triage' && t.needId === 7, 'a younger SELF-WATCH need is triaged before an older inquiry need (self-repair jumps the queue)');
  // and once triaged buildable, the self-watch one opens first too
  const mixedB = mixed.map((n) => ({ ...n, triage: 'buildable' }));
  const o = nt.duePressure({ needs: mixedB, lastRehearseTs: 0, nowMs: now, gapMs: GAP });
  ok(o && o.kind === 'open' && o.needId === 7, 'the self-watch buildable opens before the older inquiry buildable');
  // among two self-watch needs, oldest-first still holds
  const twoSW = [
    { id: 13, status: 'open', created_ts: 100, triage: null, born_from: 'self-watch: A' },
    { id: 48, status: 'open', created_ts: 900, triage: null, born_from: 'self-watch: B' },
  ];
  const s = nt.duePressure({ run: { status: 'discarded' }, needs: twoSW, lastRehearseTs: 0, nowMs: now, gapMs: GAP });
  ok(s && s.needId === 13, 'two self-watch needs → the OLDER one first (#13 before #48, matching the plan)');

  // ⭐ THE PRECEDENCE FIX (2026-08-07): a self-watch BUILDABLE must OPEN before a pile of non-self-watch
  // untriaged needs are triaged — otherwise #13 waits hours behind the triage backlog.
  const mixedQueue = [
    { id: 13, status: 'open', created_ts: 100, triage: 'buildable', born_from: 'self-watch: recurring' },
    { id: 16, status: 'open', created_ts: 200, triage: null, born_from: 'inquiry-16' },
    { id: 17, status: 'open', created_ts: 300, triage: null, born_from: 'inquiry-17' },
  ];
  const q = nt.duePressure({ run: { status: 'discarded' }, needs: mixedQueue, lastRehearseTs: 0, nowMs: now, gapMs: GAP });
  ok(q && q.kind === 'open' && q.needId === 13, 'a self-watch BUILDABLE opens BEFORE the non-self-watch untriaged backlog is triaged (self-watch OPEN beats non-self-watch TRIAGE)');
  // but a self-watch UNTRIAGED still gets triaged before a self-watch buildable opens (triage-first within the group)
  const swUntriagedFirst = [
    { id: 13, status: 'open', created_ts: 100, triage: 'buildable', born_from: 'self-watch: A' },
    { id: 48, status: 'open', created_ts: 50, triage: null, born_from: 'self-watch: B' },
  ];
  const u = nt.duePressure({ run: { status: 'discarded' }, needs: swUntriagedFirst, lastRehearseTs: 0, nowMs: now, gapMs: GAP });
  ok(u && u.kind === 'triage' && u.needId === 48, 'within the self-watch group, an untriaged one is still triaged before a buildable opens');
}

// --- M2.5.6 stale-need reaper: park old non-self-watch, EXEMPT self-watch ---
{
  const DAY = 24 * 3600 * 1000;
  const t0 = 100 * DAY;
  const needs = [
    { id: 1, status: 'open', created_ts: t0 - 8 * DAY, born_from: 'inquiry-1' },       // 8d old inquiry → reap
    { id: 2, status: 'open', created_ts: t0 - 3 * DAY, born_from: 'inquiry-2' },       // 3d old → keep
    { id: 3, status: 'open', created_ts: t0 - 30 * DAY, born_from: 'self-watch: x' },  // 30d old but self-watch → EXEMPT
    { id: 4, status: 'parked', created_ts: t0 - 40 * DAY, born_from: 'inquiry-4' },    // already parked → ignore
  ];
  const reap = nt.staleReap({ needs, nowMs: t0 });
  ok(reap.length === 1 && reap[0] === 1, 'reaper parks only the 8d-old OPEN inquiry need');
  ok(!reap.includes(3), 'a 30d-old SELF-WATCH need is EXEMPT from the reaper (it stays a self-repair target)');
  ok(!reap.includes(2) && !reap.includes(4), 'a fresh need and an already-parked need are untouched');
  ok(nt.staleReap({ needs, nowMs: t0, maxAgeMs: 60 * DAY }).length === 0, 'a longer reap age spares everything (age is configurable)');
}

// --- renderExternalAsk ---
const ask1 = nt.renderExternalAsk([{ id: 1, need: 'FDO access', ask: 'a Foundation Directory Online subscription' }]);
ok(/One capability I can't build myself/.test(ask1) && /Foundation Directory Online subscription/.test(ask1), 'single blocked need → the one-sentence ask');
const ask2 = nt.renderExternalAsk([{ need: 'a' }, { need: 'b', ask: 'DCA portal credentials' }, { need: 'c' }, { need: 'd' }]);
ok(/^3 capabilities I can't build myself/.test(ask2), 'the header counts the LISTED asks (capped), not the pile');
ok(/\(1\) a \(2\) DCA portal credentials \(3\) c/.test(ask2) && !/\(4\)/.test(ask2), 'multi asks are numbered, prefer the ask over the raw need, and cap at 3');
ok(nt.renderExternalAsk([]) === '' && nt.renderExternalAsk(null) === '', 'nothing blocked → no message');

// --- wiring (source asserts): the pressure is IN the tick, gated, and routes all four classes ---
{
  const fs = require('fs'), path = require('path');
  const m = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  ok(/_forced = await _needsPressure\(now\)/.test(m) && /_forced \|\| await autonomy\.decide/.test(m), 'the tick consults needs-pressure BEFORE the idle lottery, and a forced move wins');
  ok(/if \(_userDirectedActive\(\)\) return null;\s*\/\/ his work owns the bandwidth/.test(m), 'pressure yields to directed work (preemption)');
  ok(/quota_gate'\)\.allow\('research', \{ quiet: true \}\)/.test(m), 'pressure runs on the RESEARCH quota lane (idle-lane rate starvation inverted the stated priority)');
  ok(/blocked_external/.test(m) && /routed_research/.test(m) && /parked as junk/.test(m), 'all three non-buildable routes exist (external / research / junk)');
  ok(/needs\.external_surfaced_at/.test(m) && /24 \* 3600e3/.test(m), 'the external ask is consolidated + throttled to once a day');
  ok(/TRIAGE SKETCH:/.test(m), 'a buildable verdict seeds the study block for the rehearsal open');
  // M2.5.6: the reaper runs in the tick and its result excludes those needs from this pick
  ok(/nt\.staleReap\(\{ needs, nowMs: now \}\)/.test(m) && /reaped \$\{stale\.size\} stale need/.test(m), 'the stale-need reaper runs in the pressure tick and parks past-age needs');
  ok(/openNeeds = needs\.filter\(\(n\) => !stale\.has\(n\.id\)\)/.test(m) && /needs: openNeeds/.test(m), 'a just-reaped need is excluded from this tick\'s pressure pick');

  // ── THE INVISIBLE-CARD CURE (Lucas 09-01: "there is nowhere that a card comes through — make it
  // more obvious"): the consolidated card aired only when an EXTERNAL triage happened to run, once
  // daily, weekly re-air per card, on a scrolling surface. Three rails now pinned:
  ok(/NEEDS CARD, UN-HITCHED/.test(m) && /try \{ _surfaceExternalNeeds\(Date\.now\(\)\); \} catch \{\}/.test(m),
    '⭐ the daily card rides the 10-min tick (never again hostage to triage luck)');
  ok(/>= 48 \* 3600e3/.test(m) && !/>= 7 \* 24 \* 3600e3/.test(m), 'proposed cards re-air at 48h, not weekly');
  // ── THE APPROVAL CARDS (Lucas 09-01, third revision same day — the arc that earned a law:
  // prompt block (dropped by the model) → posted chat turn (his call: "non-chat") → yes/no
  // PERMISSION REQUESTS in the UI, decided deterministically. Wiring pins: ─────────────────────
  ok(/needs:approvals/.test(m) && /_pendingNeedItems\(\)/.test(m) && /needs\.return_aired_at/.test(m),
    '⭐ return-after-a-gap pushes APPROVAL CARDS to the panel (non-chat, paced 6h)');
  ok(/ipcMain\.handle\('needs:pending'/.test(m) && /ipcMain\.handle\('needs:decide'/.test(m),
    'main: the renderer can pull the pending set and route a decision');
  ok(/capability_need'\)\.decide\(id, decision\)/.test(m), 'main: a click routes through capability_need.decide (deterministic, never freeform)');
  const pre = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  ok(/onNeedsApprovals/.test(pre) && /needsPending/.test(pre) && /needsDecide/.test(pre), 'preload: the three approval bridges exist');
  const cjs = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'chat.js'), 'utf8');
  ok(/renderApprovals/.test(cjs) && /approval-yes/.test(cjs) && /needsDecide\(id, decision\)/.test(cjs) && /loadApprovals\(\)/.test(cjs),
    'renderer: cards render with ✓/✗, decide on click, restore on every load');
  ok(/approvals-bar/.test(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8')), 'renderer: the approvals bar exists in the shell');

  // ── THE WRITE PHASE (Lucas 09-01, the Ballotpedia test: conclusion agreed in chat, need row
  // untouched — "we are missing the write phase"). Capture side: a clarify capture also WRITES
  // onto matching open/blocked/proposed needs (≥2 word-boundary token hits incl. one specific —
  // the suiteFor lesson). Read side: triage decides WITH his words, which outrank inference. ────
  ok(/WRITE PHASE — clarification written onto need #/.test(m) && /hits\.size >= 2 && specHit/.test(m),
    '⭐ write phase: a captured clarification lands on matching needs (2-hit floor + specific-token rail)');
  ok(/need\.\$\{n\.id\}\.clarification/.test(m) || /need\.\$\{_n\.id\}\.clarification/.test(m), 'write phase: the clarification rides need meta');
  ok(/clarification: \(\(\) =>/.test(m), 'read side: the pressure pass attaches his clarifications to every need it lifts');
  {
    const ti = nt.triageInput({ need: 'Ballotpedia portal access', born_from: 'plan-revalidate:3906', clarification: 'no login exists; API paywalled; go manual' });
    ok(ti.operatorClarification === 'no login exists; API paywalled; go manual', '⭐ read side: triageInput carries operatorClarification');
    ok(nt.triageInput({ need: 'x' }).operatorClarification === undefined, 'read side: absent clarification stays absent (no empty field noise)');
    ok(/OUTRANKS your inference/.test(nt.triageWant()) && /kills the premise/.test(nt.triageWant()),
      'read side: the triage contract says his words outrank inference (premise-kill → junk, quoted)');
  }

  // decide() behavior — fixture db with the real CHECK constraint:
  {
    const os2 = require('os');
    const Database = require('../node_modules/better-sqlite3');
    const tmpDb = path.join(os2.tmpdir(), `sq_needdecide_${process.pid}.db`);
    try { fs.unlinkSync(tmpDb); } catch {}
    const d = new Database(tmpDb);
    d.exec("CREATE TABLE capability_needs (id INTEGER PRIMARY KEY, need TEXT NOT NULL, born_from TEXT, status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','rehearsing','proposed','parked','retired','blocked_external','routed_research')), created_ts INTEGER NOT NULL, updated_ts INTEGER, diagnosis TEXT)");
    d.prepare("INSERT INTO capability_needs (id, need, status, created_ts) VALUES (1, 'a proposed fix', 'proposed', 1), (2, 'an external ask', 'blocked_external', 1), (3, 'mid-flight', 'rehearsing', 1)").run();
    const metaStore = {};
    const deps = { db: { getDb: () => d, setMeta: (k, v) => { metaStore[k] = v; }, getMeta: (k) => metaStore[k] } };
    const capn = require('../lib/capability_need');
    const r1 = capn.decide(1, 'yes', { deps, nowMs: 5000 });
    ok(r1.ok && r1.status === 'open' && d.prepare('SELECT status FROM capability_needs WHERE id=1').get().status === 'open',
      '⭐ decide: YES on a proposed need → back to open (the build machinery picks it up)');
    ok(JSON.parse(metaStore['need.1.decision']).d === 'yes' && /Lucas/.test(JSON.parse(metaStore['need.1.decision']).by),
      'decide: his blessing is stamped on the need meta');
    const r2 = capn.decide(2, 'no', { deps, nowMs: 6000 });
    ok(r2.ok && d.prepare('SELECT status FROM capability_needs WHERE id=2').get().status === 'retired', 'decide: NO → retired');
    ok(!capn.decide(3, 'yes', { deps }).ok, 'decide: a mid-flight (rehearsing) need is NOT decidable — a click never mutates a running lane');
    ok(!capn.decide(1, 'maybe', { deps }).ok && !capn.decide(99, 'yes', { deps }).ok, 'decide: unknown decision / unknown id refuse honestly');
    d.close();
    try { fs.unlinkSync(tmpDb); } catch {}
  }
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
