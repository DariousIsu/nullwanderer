/* Smoke: BUILD 0 + BUILD 3 (2026-08-21).
 * BUILD 3 — lib/gap_plan: the gap-plan approval surface. Classification (fillable / blocked /
 * aggressive), key-registry blockers (unset watch keys, dormant rows, set-but-rejected probes),
 * fingerprint stability (fillable churn must NOT re-air an unchanged ask), deterministic compose
 * (exact venv CLI path — the bare `nx-echo` recipe burned Lucas once), and the maybePresent edge
 * (cadence 20h → fingerprint → weekly re-air) on a temp DB.
 * BUILD 0 — lib/echo_suit._webSearchFloor: an EMPTY federated web_search falls back to the
 * browser search lane; every non-empty / error / non-web path passes through untouched.
 * Offline: temp DB, injected search fn, no model/network.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_gap_plan.js
 */
const os = require('os'); const path = require('path'); const fs = require('fs');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_gapplan_${Date.now()}.db`);
const db = require('../lib/db'); db.init();
const gp = require('../lib/gap_plan');
const suit = require('../lib/echo_suit');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };
const T = 1785400000000;
const DAY = 86400000;

(async () => {
  // ── classifyItem ──────────────────────────────────────────────────────────────────────────────
  console.log('classifyItem:');
  ok(gp.classifyItem({ kind: 'absence', subject: 'the clerk of St. Landry Parish', attempts: 0, priority: 5, created_ts: T }, T).bucket === 'fillable',
    'a fresh low-priority gap is FILLABLE (the metabolism eats it)');
  const agg = gp.classifyItem({ kind: 'local-roster', subject: 'Evangeline Parish', attempts: 4, priority: 5, created_ts: T - 20 * DAY }, T);
  ok(agg.bucket === 'aggressive' && /crawl/.test(agg.action), '4 failed passive attempts → AGGRESSIVE with a named crawl action');
  ok(/4 passive attempts/.test(agg.why), 'the why names the attempt count');
  const rb = gp.classifyItem({ kind: 'open-question', subject: 'who funds the data-center PAC', attempts: 0, priority: 8, created_ts: T - 11 * DAY }, T);
  ok(rb.bucket === 'aggressive' && /deep-browse/.test(rb.action), 'a report-born (p8) gap aged 11d → AGGRESSIVE deep-browse');
  ok(gp.classifyItem({ kind: 'open-question', subject: 'same but fresh', attempts: 0, priority: 8, created_ts: T - 1 * DAY }, T).bucket === 'fillable',
    'a FRESH report-born gap stays fillable — age is the escalator, not priority alone');
  ok(gp.classifyItem({ kind: 'absence', subject: 'needs the LDA api key to answer', attempts: 0, priority: 5, created_ts: T }, T).bucket === 'blocked',
    'an item whose text names a credential need is BLOCKED, not tool-fillable');

  // ── keyBlockers ───────────────────────────────────────────────────────────────────────────────
  console.log('keyBlockers:');
  const rows = [
    { name: 'CONGRESS_GOV_API_KEY', service_id: 'congress_gov', is_set: false, required: true },
    { name: 'TAVILY_API_KEY', service_id: 'tavily', is_set: false, required: false, can_probe: true },
    { name: 'OPENFDA_API_KEY', service_id: 'openfda', is_set: false, required: false, can_probe: true },
    { name: 'RELIEFWEB_APPNAME', service_id: 'reliefweb', is_set: false, required: true },
    { name: 'POLYGON_API_KEY', is_set: true, dormant: true, dormant_reason: "key returns 401 'Unknown API Key'" },
    { name: 'EXA_API_KEY', service_id: 'exa', is_set: true, dormant: true, dormant_reason: 'mis-pasted, Exa 401s it' },
    { name: 'FRED_API_KEY', service_id: 'fred', is_set: true, required: true },
    { name: 'BLS_API_KEY', service_id: 'bls', is_set: true, required: false, can_probe: true },
  ];
  const probes = { fred: { ok: true, status_code: 200 }, bls: { ok: false, status_code: 401, key_set: true } };
  const kb = gp.keyBlockers(rows, probes);
  const names = kb.map((b) => b.name);
  ok(names.includes('CONGRESS_GOV_API_KEY') && kb.find((b) => b.name === 'CONGRESS_GOV_API_KEY').state === 'unset', 'an unset WATCH key blocks as unset');
  ok(!names.includes('TAVILY_API_KEY') && !names.includes('EXA_API_KEY'),
    'DECLINED search keys never nag — not when unset, not even when registered-but-rejected (Lucas 08-21: browser lanes ARE the search path)');
  ok(!names.includes('OPENFDA_API_KEY'), 'an unset OPTIONAL non-watch key is NOT a blocker (noise stays out)');
  ok(names.includes('RELIEFWEB_APPNAME'), 'an unset required:true key blocks even off the watch list');
  ok(kb.find((b) => b.name === 'POLYGON_API_KEY').state === 'rejected', 'a dormant row blocks as rejected');
  const bls = kb.find((b) => b.name === 'BLS_API_KEY');
  ok(bls && bls.state === 'rejected' && /401/.test(bls.detail) && /mis-paste/.test(bls.detail),
    'a SET non-declined key whose probe 401s blocks as rejected with the mis-paste hint');
  ok(!names.includes('FRED_API_KEY'), 'a set key with a passing probe is NOT a blocker');
  ok(gp._WATCH.has(names[0]), 'watch keys sort FIRST');

  // ── the subject floor (the "nonsensical unprompt" catch) ──────────────────────────────────────
  console.log('researchable:');
  const rq = require('../lib/recheck_queue');
  for (const junk of ['that', 'a guy', 'scratch doc', 'test pass', 'fire hydrant spray cap', 'your body', 'https://www.youtube.com/watch?v=x', 'notes/anti_china_followups.md', 'paper', 'they'])
    ok(!rq.researchable(junk), `junk subject rejected: "${junk}"`);
  for (const real of ['Louisiana parish roster', "De'Keither Stamps", 'Mississippi Public Service Commission', 'anti-china bills 2026', 'SB 200 co-sponsors'])
    ok(rq.researchable(real), `real subject kept: "${real}"`);
  // THE REQUEST-PHRASE FLOOR (09-04, the "list of ten people in Louisiana" catch): a retrieval request
  // is a promise, never an absence gap — rejected on BOTH floors (strict and lax).
  for (const req of ['list of ten people in Louisiana', 'that most recent list of ten people in Louisiana', "the sheet with those ten people's proper emails",
    'people we found contact information for', 'can you pull up the roster', 'my Louisiana spreadsheet', 'the latest report on Acadia Parish']) {
    ok(rq.isRequestPhrase(req) && !rq.researchable(req) && !rq.researchable(req, { requireProper: false }), `request phrase rejected on both floors: "${req}"`);
  }
  for (const real of ['list of Louisiana parish presidents', 'Louisiana parishes list', 'Evangeline Parish clerk', 'Acadia Parish treasurer', 'Sen. Ed Hooper work'])
    ok(!rq.isRequestPhrase(real) && rq.researchable(real, { requireProper: false }), `a real roster/entity subject is NOT a request phrase: "${real}"`);
  const withJunk = [
    { id: 1, kind: 'absence', subject: 'scratch doc', attempts: 5, priority: 8, created_ts: T - 20 * DAY },
    { id: 2, kind: 'absence', subject: 'Evangeline Parish clerk', attempts: 5, priority: 8, created_ts: T - 20 * DAY },
    { id: 3, kind: 'open-question', subject: 'who funds the data-center PAC', attempts: 0, priority: 8, created_ts: T - 11 * DAY },
  ];
  const pJunk = gp.buildPlan({ items: withJunk, keyRows: [], probes: {}, now: T });
  ok(pJunk.aggressive.length === 2 && !pJunk.aggressive.some((a) => a.subject === 'scratch doc'),
    'a junk-subject absence NEVER reaches the plan — even with 5 failed attempts');
  ok(pJunk.aggressive.some((a) => a.subject === 'who funds the data-center PAC'),
    'open-question rows (sentences, often lowercase) are NOT subject to the noun-phrase floor');

  // ── buildPlan + fingerprint ───────────────────────────────────────────────────────────────────
  console.log('fingerprint:');
  const items = [
    { id: 1, kind: 'absence', subject: 'fillable one', attempts: 0, priority: 5, created_ts: T },
    { id: 2, kind: 'local-roster', subject: 'Evangeline Parish', attempts: 4, priority: 5, created_ts: T - 20 * DAY },
  ];
  const p1 = gp.buildPlan({ items, keyRows: rows, probes, now: T });
  const p2 = gp.buildPlan({ items, keyRows: rows, probes, now: T });
  ok(gp.fingerprint(p1) === gp.fingerprint(p2), 'the fingerprint is stable across identical builds');
  const moreFillable = items.concat([{ id: 3, kind: 'absence', subject: 'another fillable', attempts: 0, priority: 5, created_ts: T }]);
  ok(gp.fingerprint(gp.buildPlan({ items: moreFillable, keyRows: rows, probes, now: T })) === gp.fingerprint(p1),
    'fillable churn does NOT move the fingerprint (no daily re-air of an unchanged ask)');
  const moreAgg = items.concat([{ id: 4, kind: 'absence', subject: 'Acadia Parish assessor', attempts: 6, priority: 5, created_ts: T - 30 * DAY }]);
  ok(gp.fingerprint(gp.buildPlan({ items: moreAgg, keyRows: rows, probes, now: T })) !== gp.fingerprint(p1),
    'a NEW aggressive item moves the fingerprint');

  // ── compose ───────────────────────────────────────────────────────────────────────────────────
  console.log('compose:');
  const text = gp.compose(p1);
  ok(/Blocked — these need your hand/.test(text), 'the blocked section is present');
  ok(/Needs your go/.test(text), 'the approval section is present');
  ok(text.includes('nx-echo.exe" keys set CONGRESS_GOV_API_KEY'), 'the FULL venv CLI path is printed (bare nx-echo is not on PATH)');
  ok(/run the deep crawl on/.test(text), 'the go example is a plain-words order the existing lanes execute');
  ok(text.length <= 2400, 'the plan is bounded');
  const quiet = gp.buildPlan({ items: [{ id: 9, kind: 'absence', subject: 'Ordinary Parish', attempts: 0, priority: 5, created_ts: T }], keyRows: [], probes: {}, now: T });
  ok(!quiet.blockedKeys.length && !quiet.aggressive.length, 'an all-fillable inventory produces no action buckets (silent path)');
  const line = gp.chatLine(p1);
  ok(line.length < 400 && !/nx-echo|keys set|Register it|Re-set it/i.test(line),
    'the CHAT surface is one short line in her voice — no CLI, no command walls');
  ok(/gap_plan\.md/.test(line) && /Evangeline Parish/.test(line), 'the chat line points at the doc and names the top go item');
  // THE ASK CAP + THE PASSIVE-CYCLE DIAGNOSIS (09-04, the 19:26 catch: "322 need a go" of 400 open).
  const stalledItems = Array.from({ length: 12 }, (_, i) => ({ id: 100 + i, kind: 'absence', subject: `Parish ${i} assessor`, attempts: 5, priority: 5, created_ts: T - 20 * DAY }))
    .concat([{ id: 200, kind: 'absence', subject: 'Fresh Parish clerk', attempts: 0, priority: 5, created_ts: T }, { id: 201, kind: 'absence', subject: 'Other Parish clerk', attempts: 0, priority: 5, created_ts: T }]);
  const pStall = gp.buildPlan({ items: stalledItems, keyRows: [], probes: {}, now: T });
  ok(pStall.counts.aggressive === 12 && pStall.counts.asked === gp._SHOW && pStall.counts.stalled === 12 - gp._SHOW,
    'counts carry the ask cap: 12 aggressive → 5 asked, 7 stalled');
  ok(pStall.passiveBroken === true, '12 of 14 open items stalled ≥ the half-share → the passive cycle is diagnosed as the defect');
  const stallLine = gp.chatLine(pStall);
  ok(/\b5 gap\(s\) are worth a deeper dig/.test(stallLine) && !/\b12 gap/.test(stallLine), 'the chat line asks for at most _SHOW gos, never the whole queue');
  ok(/7 more are stalled on my passive cycle/.test(stallLine) && /mine to fix, not 7 crawls to approve/.test(stallLine),
    'the remainder is a COUNT that names the passive cycle as HER defect, not N crawls for him');
  ok(stallLine.length < 520 && !/nx-echo|keys set/i.test(stallLine), 'the diagnosed chat line stays one short paragraph, no CLI');
  const stallText = gp.compose(pStall);
  ok(/\+7 more have each failed 3\+ passive passes/.test(stallText) && /not 7 crawls for you to approve/.test(stallText),
    'the sheet carries the same diagnosis under "Needs your go"');
  const pFew = gp.buildPlan({ items: stalledItems.slice(0, 2).concat(Array.from({ length: 18 }, (_, i) => ({ id: 300 + i, kind: 'absence', subject: `Quiet Parish ${i} clerk`, attempts: 0, priority: 5, created_ts: T }))), keyRows: [], probes: {}, now: T });
  ok(pFew.passiveBroken === false && !/passive cycle/.test(gp.chatLine(pFew)), '2 stalled of 20 open is the exception the go-list exists for — no defect wording');

  // ── maybePresent edge (temp DB) ───────────────────────────────────────────────────────────────
  console.log('maybePresent:');
  let delivered = [];
  const deliver = (t) => { delivered.push(t); return { id: 1 }; };
  ok((await gp.maybePresent({ now: T })).reason === 'no-deliver', 'no deliver fn → refused');
  ok((await gp.maybePresent({ now: T, deliver })).reason === 'nothing-needs-action' && !delivered.length,
    'an empty queue with no key registry stays silent');
  db.getDb().prepare(`INSERT INTO recheck_queue (kind, subject, detail, priority, due_ts, attempts, status, created_ts)
    VALUES ('local-roster', 'Evangeline Parish', NULL, 5, ?, 5, 'open', ?)`).run(T, T - 20 * DAY);
  const first = await gp.maybePresent({ now: T, deliver });
  ok(first.presented && delivered.length === 1 && /Evangeline Parish/.test(delivered[0]),
    'an aggressive item presents the plan with its subject named');
  ok((await gp.maybePresent({ now: T + 3600000, deliver })).reason === 'cadence', 'a second sweep an hour later is cadence-gated');
  ok((await gp.maybePresent({ now: T + 21 * 3600000, deliver })).reason === 'unchanged',
    'past the cadence with the SAME picture → unchanged, no re-air');
  db.getDb().prepare(`INSERT INTO recheck_queue (kind, subject, detail, priority, due_ts, attempts, status, created_ts)
    VALUES ('absence', 'the Acadia Parish treasurer', NULL, 5, ?, 4, 'open', ?)`).run(T, T - 15 * DAY);
  const again = await gp.maybePresent({ now: T + 22 * 3600000, deliver });
  ok(again.presented && delivered.length === 2 && /gap_plan\.md/.test(delivered[1]), 'a CHANGED picture past the cadence re-presents (as the one-line chat surface)');
  ok((await gp.maybePresent({ now: T + 22 * 3600000 + (gp._REAIR_MS + 20 * 3600000), deliver })).presented,
    'an unchanged plan still re-airs after the weekly window');
  ok(delivered.length === 3, 'exactly three plans went out across the whole cadence dance');
  // Echo down: a dispatch that returns null must not break the sweep (key section simply absent).
  delivered = [];
  db.setMeta('gapplan.last_ts', '0'); db.setMeta('gapplan.fp', '');
  const echoDown = await gp.maybePresent({ now: T, deliver, dispatch: async () => null });
  ok(echoDown.presented && !/Re-set it/.test(delivered[0]), 'Echo down → the plan still presents, without a key section');

  // ── THE DOOR (09-04): idle tier + away + the unprompted gate, judged after the cadence ────────
  console.log('doorOpen:');
  ok(gp.doorOpen({ idleTier: 2, away: true }).open === false && /away/.test(gp.doorOpen({ idleTier: 2, away: true }).why), 'away → closed');
  ok(gp.doorOpen({ idleTier: 0 }).open === false && /tier 0/.test(gp.doorOpen({ idleTier: 0 }).why), 'idle tier 0 (he just spoke) → closed');
  const gated = gp.doorOpen({ idleTier: 1, gate: { allow: false, reason: 'pending-user-turn' } });
  ok(gated.open === false && /pending-user-turn/.test(gated.why), 'the structural unprompted gate closes the door with its reason');
  ok(gp.doorOpen({ idleTier: 1, gate: { allow: true } }).open === true && gp.doorOpen({ idleTier: 3 }).open === true, 'hygiene tier or deeper, not away, gate allowing → open');
  ok(gp.doorOpen({}).open === false, 'no readings at all → closed (fail-quiet, never a plan into a live turn)');
  delivered = [];
  db.setMeta('gapplan.last_ts', '0'); db.setMeta('gapplan.fp', '');
  const closed = await gp.maybePresent({ now: T, deliver, door: { open: false, why: 'idle tier 0 — he just spoke' } });
  ok(closed.presented === false && /^door-closed \(idle tier 0/.test(closed.reason) && delivered.length === 0,
    'a due plan behind a closed door is NOT presented, and the reason names the door');
  ok((await gp.maybePresent({ now: T, deliver, door: { open: true, why: 'ok' } })).presented && delivered.length === 1, 'the same due plan presents once the door opens');
  ok((await gp.maybePresent({ now: T + 3600000, deliver, door: { open: false, why: 'Lucas away' } })).reason === 'cadence',
    'the cadence is judged FIRST — a closed door is only reported when a plan is actually due');

  // ── THE RETIRE SWEEP (09-04): the floor applied backward, parked never done ──────────────────
  console.log('retireUnresearchable:');
  const ins = db.getDb().prepare(`INSERT INTO recheck_queue (kind, subject, detail, priority, due_ts, attempts, status, created_ts) VALUES (?, ?, NULL, 8, ?, 7, 'open', ?)`);
  ins.run('absence', 'list of ten people in Louisiana', T, T - 26 * DAY);
  ins.run('absence', 'Iberia Parish assessor', T, T - 26 * DAY);
  ins.run('local-roster', 'that most recent list', T, T - 26 * DAY);   // not an absence → the sweep never touches other kinds
  const sweep1 = rq.retireUnresearchable({ now: T });
  const rowReq = db.getDb().prepare(`SELECT status, outcome FROM recheck_queue WHERE subject = 'list of ten people in Louisiana'`).get();
  const rowReal = db.getDb().prepare(`SELECT status FROM recheck_queue WHERE subject = 'Iberia Parish assessor'`).get();
  const rowOther = db.getDb().prepare(`SELECT status FROM recheck_queue WHERE subject = 'that most recent list'`).get();
  ok(sweep1.parked === 1 && sweep1.sample[0] === 'list of ten people in Louisiana', 'the request-phrase absence row is parked, and the sample names it');
  ok(rowReq && rowReq.status === 'parked' && /^PARKED: unresearchable subject \(a retrieval request, not a gap\)/.test(rowReq.outcome),
    'parked (reversible), never done — with the reason in the outcome');
  ok(rowReal && rowReal.status === 'open', 'a real absence gap stays open');
  ok(rowOther && rowOther.status === 'open', 'other kinds are out of the sweep\'s scope');
  ok(rq.retireUnresearchable({ now: T }).parked === 0, 'a second sweep is idempotent (parked rows are no longer open)');
  const pAfter = await gp.maybePresent({ now: T + 21 * 3600000, deliver, door: { open: true } });
  ok(!delivered.some((t) => /ten people/.test(t)) && (!pAfter.presented || !/ten people/.test(delivered[delivered.length - 1])),
    'a parked request phrase never reaches the plan again');

  // ── BUILD 0: the browser-lane web_search floor ────────────────────────────────────────────────
  console.log('_webSearchFloor:');
  const emptyFed = { ok: true, isError: false, text: JSON.stringify({ query: 'q', results: [], providers_skipped: { exa: 'no_key_or_error' } }) };
  const fullFed = { ok: true, isError: false, text: JSON.stringify({ query: 'louisiana sb200', results: [{ title: 'Louisiana SB200 hearing docket', url: 'https://legis.example/louisiana-sb200' }] }) };
  const errRes = { ok: false, isError: true, text: 'transport failed' };
  const laneHits = { results: [{ title: 'Louisiana SB200 — Lane Hit', url: 'https://lane.example/a', snippet: 's' }] };   // relevant to the query — the 08-25 junk rule judges lane results too
  const webTag = { kind: 'do', name: 'web_search', args: { query: 'louisiana sb200' } };
  let laneCalls = 0;
  const fakeSearch = async () => { laneCalls++; return laneHits; };
  ok((await suit._webSearchFloor({ kind: 'do', name: 'search_bills', args: {} }, emptyFed, { search: fakeSearch })) === emptyFed && laneCalls === 0,
    'a non-web_search tag passes through untouched — the lane is never called');
  ok((await suit._webSearchFloor(webTag, fullFed, { search: fakeSearch })) === fullFed && laneCalls === 0,
    'a federation that ANSWERED passes through untouched');
  ok((await suit._webSearchFloor(webTag, errRes, { search: fakeSearch })) === errRes && laneCalls === 0,
    'a transport error passes through — the floor never masks a real failure');
  ok((await suit._webSearchFloor(webTag, { ok: true, text: 'not json' }, { search: fakeSearch })) !== null && laneCalls === 0,
    'unparseable text passes through untouched');
  const floored = await suit._webSearchFloor(webTag, emptyFed, { search: fakeSearch });
  const fj = JSON.parse(floored.text);
  ok(laneCalls === 1 && fj.results.length === 1 && fj.results[0].source === 'browser-lane' && fj.results[0].url === 'https://lane.example/a',
    'an EMPTY federation falls back to the lane — rows carry source:browser-lane');
  ok(fj.providers_used[0] === 'browser-lane' && fj.providers_skipped.exa === 'no_key_or_error',
    'the synthesized report keeps the engine shape + the original skip reasons');
  ok((await suit._webSearchFloor(webTag, emptyFed, { search: async () => ({ results: [] }) })) === emptyFed,
    'lane ALSO empty → the honest empty stands (no fabricated results)');
  ok((await suit._webSearchFloor(webTag, emptyFed, { search: async () => { throw new Error('lane died'); } })) === emptyFed,
    'a lane crash returns the original result — fail-soft');
  // the RELEVANCE floor (bulk battery 08-25): a junk-full federation floors to the lane
  const junkFed = { ok: true, isError: false, text: JSON.stringify({ query: 'louisiana sb200', results: [{ title: 'About Meta', url: 'https://meta.com/about' }, { title: 'Applied | Homepage', url: 'https://applied.com' }] }) };
  const jf = await suit._webSearchFloor(webTag, junkFed, { search: fakeSearch });
  ok(JSON.parse(jf.text).results[0].source === 'browser-lane' && /brand-nav junk/.test(JSON.parse(jf.text).note), '⭐ a JUNK-full federation (no result carries 2+ query terms) floors to the lane');
  ok((await suit._webSearchFloor(webTag, junkFed, { search: async () => ({ results: [{ title: 'About Meta', url: 'https://meta.com/x' }] }) })) === junkFed, 'lane junk never replaces federation junk — the original stands, callers detect');
  // LANE-PRIMARY junk = a MISS (Lucas 08-25: stealth stays primary; its own junk falls through)
  ok((await suit._webSearchLanePrimary(webTag, { search: async () => ({ results: [{ title: 'About Meta', url: 'https://meta.com/about' }] }) })) === null, '⭐ lane-PRIMARY brand junk is a MISS — the federation gets its fallback shot');

  // ── BUILD 0b: the stealth lane is the PRIMARY search ──────────────────────────────────────────
  console.log('_webSearchLanePrimary:');
  const prim = await suit._webSearchLanePrimary(webTag, { search: async () => laneHits });
  const pj = JSON.parse(prim.text);
  ok(pj.results.length === 1 && pj.results[0].source === 'browser-lane' && pj.providers_used[0] === 'browser-lane',
    'the lane serves the PRIMARY result in the engine shape');
  ok((await suit._webSearchLanePrimary(webTag, { search: async () => ({ results: [] }) })) === null,
    'a lane miss returns null — dispatch falls through to the engine federation');
  ok((await suit._webSearchLanePrimary(webTag, { search: async () => { throw new Error('lane died'); } })) === null,
    'a lane crash returns null — never blocks the dispatch');
  ok((await suit._webSearchLanePrimary({ kind: 'do', name: 'web_search', args: {} }, { search: async () => laneHits })) === null,
    'a blank query is never searched');
  const sl = require('../lib/search_lane');
  ok(typeof sl.withSlot === 'function' && sl.POOL_SIZE >= 1 && sl.POOL_SIZE <= 6,
    `search_lane loads with a bounded tab pool (POOL_SIZE=${sl.POOL_SIZE})`);

  // ── wiring greps ──────────────────────────────────────────────────────────────────────────────
  console.log('wiring:');
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const suitSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'echo_suit.js'), 'utf8');
  ok(/gap_plan'\)\.maybePresent/.test(mainSrc), 'main.js metabolism tick calls gap_plan.maybePresent');
  ok(/writeDoc: \(text\) =>/.test(mainSrc) && /gap_plan\.md/.test(mainSrc), 'the full sheet writes to the workspace doc');
  ok(/if \(!_rq\.researchable\(_subj\)\) continue/.test(mainSrc), 'the conversation-warming producer enforces the subject floor');
  ok(/gap_plan'\)\.doorOpen\(\{ idleTier: _t && _t\.tier, away: _away, gate: _g \}\)/.test(mainSrc) && /maybePresent\(\{\s*\n\s*door: _gpDoor,/.test(mainSrc),
    'the gap-plan surface is DOOR-gated (idle tier + away + the unprompted gate), not the 30-second lull');
  ok(!/if \(currentSessionId && !_conversationActive\(\)\)\s*\{\s*\n\s*const _gpSid/.test(mainSrc), 'the old 30-second-only gate is gone');
  ok(/rq\.retireUnresearchable\(\{\}\)/.test(mainSrc) && /recheck\.retire_sweep_at/.test(mainSrc) && /\[metabolism\] retire sweep:/.test(mainSrc),
    'the metabolism tick runs the daily retire sweep and logs it every run');
  ok(/const lane = await _webSearchLanePrimary\(tag\)/.test(suitSrc), 'echo_suit dispatch serves web_search from the stealth lane FIRST');
  ok(/if \(!_laneMissed\) _res = await _webSearchFloor\(tag, _res\)/.test(suitSrc),
    'the post-dispatch floor stands down when the primary lane already missed (no double lane attempt)');
  ok(require('../lib/echo_tier').classifyTool('secrets_check') === 'read',
    'secrets_check classifies READ — the tier gate must never starve the key probe (live 08-21 escape)');

  console.log(`\nsmoke_gap_plan: ${pass} passed, ${fail} failed`);
  try { db.getDb().close(); fs.unlinkSync(process.env.SQ_DB_PATH); } catch {}
  process.exit(fail ? 1 : 0);
})();
