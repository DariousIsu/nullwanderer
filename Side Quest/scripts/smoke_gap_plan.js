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
  const moreAgg = items.concat([{ id: 4, kind: 'absence', subject: 'stuck thing', attempts: 6, priority: 5, created_ts: T - 30 * DAY }]);
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
  const quiet = gp.buildPlan({ items: [{ id: 9, kind: 'absence', subject: 'ordinary', attempts: 0, priority: 5, created_ts: T }], keyRows: [], probes: {}, now: T });
  ok(!quiet.blockedKeys.length && !quiet.aggressive.length, 'an all-fillable inventory produces no action buckets (silent path)');

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
  ok(again.presented && delivered.length === 2 && /Acadia Parish/.test(delivered[1]), 'a CHANGED picture past the cadence re-presents');
  ok((await gp.maybePresent({ now: T + 22 * 3600000 + (gp._REAIR_MS + 20 * 3600000), deliver })).presented,
    'an unchanged plan still re-airs after the weekly window');
  ok(delivered.length === 3, 'exactly three plans went out across the whole cadence dance');
  // Echo down: a dispatch that returns null must not break the sweep (key section simply absent).
  delivered = [];
  db.setMeta('gapplan.last_ts', '0'); db.setMeta('gapplan.fp', '');
  const echoDown = await gp.maybePresent({ now: T, deliver, dispatch: async () => null });
  ok(echoDown.presented && !/Re-set it/.test(delivered[0]), 'Echo down → the plan still presents, without a key section');

  // ── BUILD 0: the browser-lane web_search floor ────────────────────────────────────────────────
  console.log('_webSearchFloor:');
  const emptyFed = { ok: true, isError: false, text: JSON.stringify({ query: 'q', results: [], providers_skipped: { exa: 'no_key_or_error' } }) };
  const fullFed = { ok: true, isError: false, text: JSON.stringify({ query: 'q', results: [{ title: 'hit', url: 'https://x.example' }] }) };
  const errRes = { ok: false, isError: true, text: 'transport failed' };
  const laneHits = { results: [{ title: 'Lane Hit', url: 'https://lane.example/a', snippet: 's' }] };
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
  ok(/_conversationActive\(\)\)\s*\{\s*\n\s*const _gpSid/.test(mainSrc) || /if \(currentSessionId && !_conversationActive\(\)\)/.test(mainSrc),
    'the gap-plan surface is lull-gated');
  ok(/const lane = await _webSearchLanePrimary\(tag\)/.test(suitSrc), 'echo_suit dispatch serves web_search from the stealth lane FIRST');
  ok(/if \(!_laneMissed\) _res = await _webSearchFloor\(tag, _res\)/.test(suitSrc),
    'the post-dispatch floor stands down when the primary lane already missed (no double lane attempt)');
  ok(require('../lib/echo_tier').classifyTool('secrets_check') === 'read',
    'secrets_check classifies READ — the tier gate must never starve the key probe (live 08-21 escape)');

  console.log(`\nsmoke_gap_plan: ${pass} passed, ${fail} failed`);
  try { db.getDb().close(); fs.unlinkSync(process.env.SQ_DB_PATH); } catch {}
  process.exit(fail ? 1 : 0);
})();
