/* Smoke: DATASETS UNDER DOCUMENTS (Phase 2 slice 1, Root B / doc-plan failure #6).
 * A data-shaped deliverable carries ROWS; counts/tables/rosters render DETERMINISTICALLY from
 * them; the model never authors a number. Drives the store on an in-memory db, the pure renders,
 * the acquirer's row path, then pins the main.js wiring (acquisition lands rows under the project
 * slug · the compose appends the code-authored data section · "how many" injects exact counts).
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_dataset_store.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const _print = console.log.bind(console);
const ok = (c, t) => { if (c) { pass++; _print('  ✓', t); } else { fail++; _print('  ✗', t); } };
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const ds = require('../lib/dataset_store');
const la = require('../lib/legis_acquire');
const Database = require('better-sqlite3');
ds._setDb(new Database(':memory:'));
console.log = () => {};

// --- 1. the store: upsert, identity, refresh ---
const SLUG = 'report-anti-china-test';
const r1 = ds.upsertRows({ slug: SLUG, rows: [
  { entity: 'UT SB101', attrs: { state: 'UT', title: 'Foreign land ban', status: 'Passed', tags: ['china'] }, sourceUrl: 'https://legiscan.com/UT/1', provenance: 'legiscan_search UT "china"' },
  { entity: 'UT HB22', attrs: { state: 'UT', title: 'Procurement ban', status: 'Introduced', tags: ['china'] }, sourceUrl: 'https://legiscan.com/UT/2', provenance: 'legiscan_search UT "china"' },
  { entity: 'TX SB17', attrs: { state: 'TX', title: 'Land ownership', status: 'Passed', tags: ['china'] }, sourceUrl: 'https://legiscan.com/TX/1', provenance: 'legiscan_search TX "china"' },
] });
ok(r1.inserted === 3 && r1.updated === 0, '3 rows land');
const r2 = ds.upsertRows({ slug: SLUG, rows: [{ entity: 'UT SB101', attrs: { state: 'UT', title: 'Foreign land ban', status: 'Enrolled', tags: ['china', 'surveillance'] }, sourceUrl: 'https://legiscan.com/UT/1', provenance: 'legiscan_search UT "surveillance"' }] });
ok(r2.inserted === 0 && r2.updated === 1, 'a re-found entity REFRESHES, never duplicates (identity = project+entity)');
ok(ds.countFor(SLUG) === 3, 'countFor = SELECT COUNT — exact');
ok(ds.rowsFor(SLUG).find((r) => r.entity === 'UT SB101').attrs.status === 'Enrolled', 'fresh attrs beat stale');
ok(ds.hasRows(SLUG, { state: 'UT' }) && !ds.hasRows(SLUG, { state: 'FL' }), 'hasRows filters by attr');
ok(ds.countFor('report-other') === 0 && ds.rowsFor('report-other').length === 0, 'projects are isolated');

// --- 2. the deterministic renders ---
const rows = ds.rowsFor(SLUG);
const counts = ds.renderCounts(rows);
ok(/\*\*Total: 3\*\*/.test(counts), 'renderCounts: the total is exact');
ok(/By state: UT 2 · TX 1/.test(counts), 'renderCounts: by-state counts exact and ordered');
const table = ds.renderTable(rows);
ok(/\| state \\ status \|/.test(table) && /\| UT \|/.test(table) && /\| 2 \|$/m.test(table), 'renderTable: state × status cross-tab with row totals');
const noCol = ds.renderTable(rows.map((r) => ({ ...r, attrs: { state: r.attrs.state } })), {});
ok(/\| state \| count \|/.test(noCol), 'renderTable: a missing column dimension falls back to a one-dimension count (renders only what rows hold)');
const roster = ds.renderRoster(rows);
ok(/\*\*UT SB101 — Foreign land ban\*\*/.test(roster) && /Source: https:\/\/legiscan\.com\/UT\/1/.test(roster), 'renderRoster: every row carries its source URL');
const sp = ds.renderRoster([{ entity: 'TN SB318', attrs: { title: 'Organ act', sponsors: ['Adam Lowe (R)', 'Paul Rose (R)'] }, sourceUrl: 'u' }]);
ok(/Sponsors: Adam Lowe \(R\); Paul Rose \(R\)/.test(sp), 'renderRoster: sponsors ride when held');
ok(ds.renderReportData([]) === '' && ds.renderCounts([]) === '', 'empty dataset renders NOTHING (no fabricated structure)');
ok(/### Counts \(deterministic/.test(ds.renderReportData(rows)) && /### The table/.test(ds.renderReportData(rows)) && /### Every row/.test(ds.renderReportData(rows)), 'renderReportData: counts + table + roster, one section');

// --- 3. the acquirer's row path ---
const lrows = la.resultsToRows({ state: 'AZ', query: 'surveillance', results: [
  { bill_number: 'SB1683', title: 'Foreign adversary land', last_action: 'Chaptered', last_action_date: '2026-05-01', url: 'https://legiscan.com/AZ/SB1683', relevance: 99 },
  { bill_id: 999, title: 'No number bill', url: 'u2' },
  { title: 'no id at all' },
] });
ok(lrows.length === 2 && lrows[0].entity === 'AZ SB1683', 'resultsToRows: entity = "ST BILLNUM"; id-less results drop');
ok(lrows[0].attrs.state === 'AZ' && lrows[0].attrs.tags[0] === 'surveillance' && /legiscan_search AZ/.test(lrows[0].provenance), 'rows carry state, query tag, and provenance');
// acquire(): rows land even when the day's sheet is already held (the rows-refresh path)
{
  const landed = [];
  const calls = [];
  const fakeDispatch = async (tag) => { calls.push(tag.args.state); return { ok: true, text: JSON.stringify({ results: [{ bill_number: 'HB1', title: 'T', url: 'u' }], total_results: 1 }) }; };
  (async () => {
    const out = await la.acquire({
      states: ['UT'], query: 'china', dispatch: fakeDispatch,
      insertDocument: () => { throw new Error('sheet must not re-land'); },
      findExisting: () => true,                       // today's sheet exists...
      landRows: (rs) => landed.push(...rs), hasRowsFor: () => false,   // ...but the dataset is empty
    });
    ok(out.skipped === 1 && out.rows === 1 && landed.length === 1, 'a held sheet with an empty dataset still lands ROWS (search re-runs; sheet stands)');
    const out2 = await la.acquire({
      states: ['UT'], query: 'china', dispatch: async () => { throw new Error('no search needed'); },
      insertDocument: () => {}, findExisting: () => true, landRows: () => {}, hasRowsFor: () => true,
    });
    ok(out2.skipped === 1 && out2.rows === 0, 'sheet AND rows held → true skip, no search');

    // --- 3b. SLICE 2: bill-detail enrichment ---
    const bill = { status: 4, url: 'https://legiscan.com/TN/SB318',
      sponsors: [ { name: 'Paul Rose', party: 'R', district: 'SD-032', sponsor_type_id: 2 }, { name: 'Adam Lowe', party: 'R', district: 'SD-001', sponsor_type_id: 1 } ],
      history: [ { action: 'Introduced', date: '2026-01-05' }, { action: 'Signed by Governor', date: '2026-05-01' } ] };
    const ba = la.billToAttrs(bill);
    ok(ba.status === 'Passed', 'billToAttrs: the status CODE maps to its word');
    ok(ba.sponsors[0] === 'Adam Lowe (R-SD-001)' && ba.sponsors[1] === 'Paul Rose (R-SD-032)' && ba.primarySponsors === 1, 'billToAttrs: primary sponsors LEAD the roster');
    ok(ba.lastAction === 'Signed by Governor' && ba.lastActionDate === '2026-05-01', 'billToAttrs: the history TAIL is the last action');
    ok(JSON.stringify(la.billToAttrs({})) === '{}', 'an empty bill distills to nothing (no invented fields)');
    {
      const upserts = [];
      const mkRow = (e, rel, extra = {}) => ({ entity: e, attrs: { billId: 100 + rel, relevance: rel, state: 'TN', tags: ['china'], ...extra }, sourceUrl: '', provenance: 'p' });
      const rowsE = [mkRow('TN SB1', 50), mkRow('TN SB2', 99), mkRow('TN SB3', 10, { status: 'Passed', sponsors: ['X'] }), { entity: 'TN NOID', attrs: {} }];
      const seen = [];
      const disp = async (tag) => { seen.push(tag.args.bill_id); return { ok: true, text: JSON.stringify({ bill_id: tag.args.bill_id, bill } ) }; };
      la.enrich({ rows: rowsE, dispatch: disp, upsert: (rs) => upserts.push(...rs), cap: 1 }).then((er) => {
        ok(er.done === 1 && seen[0] === 199, 'enrich: bounded by cap, HIGHEST relevance first');
        ok(er.remaining === 1, 'the un-fetched tail is reported (later runs pick it up)');
        ok(upserts[0].attrs.status === 'Passed' && upserts[0].attrs.state === 'TN' && upserts[0].attrs.tags[0] === 'china', 'enrich MERGES: detail attrs join the search attrs (state/tags survive)');
        ok(!seen.includes(110), 'already-enriched rows are never re-fetched');
        return la.enrich({ rows: [mkRow('TN SB9', 5)], dispatch: async () => ({ ok: false }), upsert: () => {}, cap: 5 });
      }).then((er2) => {
        ok(er2.failed === 1 && er2.done === 0, 'a failed detail fetch is counted, never fatal');
        finishWiring();
      });
    }
    function finishWiring() {
    console.log = _print;
    // --- 4. the wiring is pinned ---
    const main = read('main.js');
    ok(/landRows: \(rows\) => _ds\.upsertRows\(\{ slug, rows \}\)/.test(main), 'acquisition lands rows under the PROJECT slug');
    ok(/hasRowsFor: \(state, q\) => _ds\.rowsFor\(slug\)\.some/.test(main), 'the rows-refresh path is wired PER (state, query) — a held sheet never starves the dataset, query A never suppresses query B');
    ok(main.indexOf('resolveOrMint({ topic: t, kind: \'report\' })') < main.indexOf('_ar.detect(t)'), 'the registry resolve is HOISTED above acquisition (rows need the slug)');
    ok(/if \(_dsSection\) md = `\$\{md\}\$\{_dsSection\}`/.test(main), 'the data section is CODE-authored and appended — save + canvas both carry it');
    ok(/NEVER state a count, total, percentage, or tally/.test(main), 'the compose rule forbids model-authored numbers when a dataset rides');
    ok(/DATASET COUNTS — EXACT/.test(main) && /renderCounts\(_rows2/.test(main), '"how many" injects exact SELECT-COUNT numbers into the reply context');
    ok(/\bhow many\b/.source ? /if \(\/\\bhow many\\b\/i\.test\(userMessage\)\)/.test(main) : false, 'the count injection is gated on the ask shape + a project + rows');
    ok(/la2\.enrich\(\{/.test(main) && main.indexOf('la2.enrich({') < main.indexOf('const _clean = t.replace'), 'enrichment runs in the compose door AFTER acquisition, BEFORE the gather/renders');
    ok(/renders proceed on held attrs/.test(main), 'enrichment is fail-soft — a miss never blocks the report');
    _print(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
    }
  })();
}
