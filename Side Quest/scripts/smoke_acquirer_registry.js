/* Smoke: THE ACQUIRER REGISTRY (Phase 3 slice 1). Acquirers keyed by what the topic names:
 * legislation (wrapping legis_acquire verbatim — the P2 gate passed on it) and civic-roster
 * (the civic store's verified memberships as instant dataset rows). Detection routing, the civic
 * acquire against an in-memory store, render-dims threading, and the main.js wiring.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_acquirer_registry.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const _print = console.log.bind(console);
const ok = (c, t, d = '') => { if (c) { pass++; _print('  ✓', t); } else { fail++; _print('  ✗', t, d ? `— ${d}` : ''); } };
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const ar = require('../lib/acquirer_registry');
const ds = require('../lib/dataset_store');
const Database = require('better-sqlite3');
console.log = () => {};

// --- 1. detection routes to the right acquirer ---
const dLeg = ar.detect('anti-China legislation state by state: Utah, Texas');
ok(dLeg && dLeg.name === 'legislation' && dLeg.plan.states.sort().join(',') === 'TX,UT', 'a legislative topic → the legislation acquirer (states resolved)');
ok(dLeg.renderDims.rowKey === 'state' && dLeg.renderDims.colKey === 'status', 'legislation renders state × status');
ok(dLeg.renderDims.trendKey === 'lastActionDate', 'legislation dims carry the trend dimension (monthly by last action)');
ok(typeof dLeg.renderDims.classify === 'function' && dLeg.renderDims.classify({ title: 'Foreign adversary land ban' }) === true && dLeg.renderDims.classify({ title: 'Marijuana producers; licensure' }) === false, 'legislation dims carry the relevance classifier (v11 pass: query-matched ≠ subject-named)');
const dCiv = ar.detect('the Louisiana parish leadership contact table');
ok(dCiv && dCiv.name === 'civic-roster' && dCiv.plan.state === 'LA', 'a civic contact/roster topic → the civic acquirer (state resolved)');
ok(dCiv.renderDims.rowKey === 'body' && dCiv.renderDims.colKey === 'role', 'civic rosters render body × role');
ok(ar.detect('the parish council roster') && ar.detect('the parish council roster').plan.state === null, 'no state named → stateless civic plan (all held rows)');
ok(ar.detect('the Hartfield Foundation funding network') === null, 'a prose-shaped topic matches NO acquirer (the compose proceeds on held material)');
ok(ar.detect('county contact directory for Iowa').name === 'civic-roster', 'county phrasing routes civic');

// --- 2. the civic acquirer lands held rows as the dataset ---
{
  const mem = new Database(':memory:');
  mem.exec(`CREATE TABLE civic_bodies (body_key TEXT PRIMARY KEY, title TEXT, level TEXT, function TEXT, state TEXT, place TEXT);
    CREATE TABLE civic_memberships (id INTEGER PRIMARY KEY, body_key TEXT, person_name TEXT, role TEXT, district TEXT, party TEXT,
      email TEXT, phone TEXT, source_url TEXT, confidence REAL, superseded_by INTEGER);`);
  mem.prepare(`INSERT INTO civic_bodies VALUES ('jefferson parish council','Jefferson Parish Council','parish','legislative','LA','Jefferson Parish')`).run();
  mem.prepare(`INSERT INTO civic_bodies VALUES ('polk county board','Polk County Board','county','legislative','IA','Polk County')`).run();
  mem.prepare(`INSERT INTO civic_memberships VALUES (1,'jefferson parish council','Ricky Templet','Chairman',NULL,NULL,'rt@jp.gov','504-555-1','https://jp.gov',0.9,NULL)`).run();
  mem.prepare(`INSERT INTO civic_memberships VALUES (2,'jefferson parish council','Old Member','Member',NULL,NULL,NULL,NULL,NULL,0.5,3)`).run();   // superseded
  mem.prepare(`INSERT INTO civic_memberships VALUES (3,'polk county board','Angela Connolly','Chair',NULL,NULL,NULL,NULL,NULL,0.8,NULL)`).run();
  const landed = [];
  const deps = { db: { getDb: () => mem }, landRows: (rs) => landed.push(...rs), log: () => {} };
  ar.acquire({ name: 'civic-roster', plan: { state: 'LA' }, slug: 's', deps }).then((out) => {
    ok(out.rows === 1 && landed.length === 1, 'state-filtered: only LIVE LA rows land (superseded + other-state excluded)');
    ok(landed[0].entity === 'Ricky Templet @ Jefferson Parish Council', 'entity = person @ body');
    ok(landed[0].attrs.email === 'rt@jp.gov' && landed[0].attrs.role === 'Chairman' && landed[0].attrs.place === 'Jefferson Parish', 'attrs carry role/place/email');
    ok(/civic_store state=LA/.test(landed[0].provenance) && landed[0].sourceUrl === 'https://jp.gov', 'provenance + source URL ride');
    const landed2 = [];
    return ar.acquire({ name: 'civic-roster', plan: { state: null }, slug: 's', deps: { ...deps, landRows: (rs) => landed2.push(...rs) } }).then((o2) => {
      ok(o2.rows === 2 && landed2.length === 2, 'stateless plan lands every live row');
      finish();
    });
  });
  function finish() {
    // --- 3. render-dims: the civic table is body × role; contact payload rides the roster ---
    const rows = landed.concat([]).map((r) => ({ entity: r.entity, attrs: r.attrs, sourceUrl: r.sourceUrl }));
    const section = ds.renderReportData(rows, { rowKey: 'body', colKey: 'role', countKeys: ['place', 'role'] });
    ok(/\| body \\ role \|/.test(section), 'the civic cross-tab is body × role');
    ok(/By place: Jefferson Parish 1/.test(section), 'counts by place');
    ok(/rt@jp\.gov · 504-555-1/.test(section), 'the roster line carries email · phone (reachability IS the payload)');
    console.log = _print;
    // --- 4. the wiring is pinned ---
    const main = read('main.js');
    ok(/acquirer_registry'\)/.test(main) && /_ar\.detect\(t\)/.test(main) && /_ar\.acquire\(\{/.test(main), 'the compose door routes acquisition through the REGISTRY');
    ok(/_renderDims = _det\.renderDims/.test(main) && /renderReportData\(_dsRows, _renderDims \|\| \{\}\)/.test(main), 'the matched acquirer\'s render dims reach the data section');
    ok(/directed acquisition \[\$\{_det\.name\}\]/.test(main), 'the acquisition log names its acquirer');
    // P3 gate catch: a kept in-turn report with a DATA-SHAPED topic recomposes through the spine.
    ok(/kept in-turn report is DATA-SHAPED/.test(main) && /_arK\.detect\(order\.topic\)/.test(main) && /buildReportFromHeld\(\{ io: null, channel: 'chat', sessionId, userName: require\('\.\/lib\/interlocutor'\)/.test(main),
      'the operator\'s in-turn delivery triggers the dataset recompose (one order → a data-backed canonical, whichever path answers)');
    _print(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
  }
}
