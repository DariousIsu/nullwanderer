/* Smoke: VERIFY BEFORE ANNOUNCE (Phase 4). The deterministic pre-announce audit — any violation
 * makes the done-claim structurally unreachable. Pure cases + the compose-door wiring.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_delivery_audit.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const da = require('../lib/delivery_audit');

let pass = 0, fail = 0;
const ok = (c, t, d = '') => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t, d ? `— ${d}` : ''); } };
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const rows = (n) => Array.from({ length: n }, (_, i) => ({ entity: `R${i}` }));
const topic7 = 'anti-China and surveillance bills state by state with sponsors: Utah, Arizona, Texas';
const goodBody = `# Report\nThe anti-China and surveillance bills picture. Sponsors ride each row.\n` +
  `Utah leads; Arizona and Texas follow.\n## The data (deterministic)\n**Total: 5**\nBy state: UT 2 · AZ 2 · TX 1\n` + 'x'.repeat(300);

// --- the PASS cases ---
ok(da.audit({ topic: topic7, body: goodBody, dsRows: rows(5), dataShaped: true }).ok, 'a complete data-backed report PASSES');
ok(da.audit({ topic: 'the Hartfield Foundation funding network', body: `Hartfield Foundation funding flows and the network around it. ${'x'.repeat(300)}`, dsRows: [], dataShaped: false }).ok,
  'a prose report (no acquirer, no dataset) passes on substance + relevance');
ok(da.audit({ topic: topic7, body: goodBody, dsRows: rows(5), dataShaped: true, doneScope: ['sponsors for each bill'] }).ok,
  'a done scope item whose tokens are present passes');

// --- the FAIL cases (each check bites) ---
const v = (a) => a.violations.map((x) => x.check).join(',');
ok(v(da.audit({ topic: topic7, body: 'tiny', dsRows: [], dataShaped: false })).includes('husk'), 'a husk fails');
ok(v(da.audit({ topic: topic7, body: `Completely unrelated prose about gardening tulips. ${'x'.repeat(300)}`, dsRows: [], dataShaped: false })).includes('off-topic'), 'an off-topic body fails');
{
  const noTexas = goodBody.replace(/Texas/g, 'elsewhere').replace(/TX 1/, 'ZZ 1');
  ok(v(da.audit({ topic: topic7, body: noTexas, dsRows: rows(5), dataShaped: true })).includes('scope-missing'), 'a named state absent from the body fails (a reportable gap)');
}
ok(v(da.audit({ topic: topic7, body: goodBody, dsRows: rows(5), dataShaped: true, doneScope: ['per-bill fiscal impact appendix'] })).includes('done-scope-absent'),
  'a "done" scope item absent from the document fails');
ok(v(da.audit({ topic: topic7, body: goodBody, dsRows: rows(9), dataShaped: true })).includes('count-drift'), 'a Total that is not SELECT COUNT fails');
ok(v(da.audit({ topic: topic7, body: goodBody.replace(/\*\*Total: 5\*\*/, ''), dsRows: rows(5), dataShaped: true })).includes('data-section-missing'), 'rows held but no deterministic Total fails');
ok(v(da.audit({ topic: topic7, body: goodBody.replace(/## The data[\s\S]*$/, 'prose only ' + 'x'.repeat(300)), dsRows: [], dataShaped: true })).includes('dataset-starved'),
  '⭐ THE ADVERSARIAL CASE: a data-shaped topic over a STARVED dataset fails — the gap, never the report');
// P4 adversarial catch (live, boot_p98): 'build' leaked from the raw order into the LegiScan
// query — 50 construction bills fed a nonsense project and the audit passed on poisoned fuel.
{
  const tagged = (tags) => rows(5).map((r, i) => ({ ...r, attrs: { tags } }));
  ok(v(da.audit({ topic: 'build the report on Hartfield Zorblat bills in Louisiana', body: goodBody + ' hartfield zorblat louisiana', dsRows: tagged(['build']), dataShaped: true })).includes('query-leak'),
    '⭐ a dataset fed by a query OUTSIDE the topic fails (the live order-verb leak)');
  ok(!v(da.audit({ topic: topic7, body: goodBody, dsRows: tagged(['china']), dataShaped: true })).includes('query-leak'),
    'a topic-token query passes');
  ok(!v(da.audit({ topic: 'the Louisiana parish leadership contact table', body: goodBody + ' louisiana parish leadership contact', dsRows: rows(5).map((r) => ({ ...r, attrs: {} })), dataShaped: true })).includes('query-leak'),
    'rows without query tags (civic store) are exempt');
}
const laDetect = require('../lib/legis_acquire').detect('build the report on Hartfield Zorblat bills in Louisiana');
ok(laDetect.queries.join(',') === 'hartfield,zorblat', 'the acquirer stoplist strips order verbs — the raw order text yields only SUBJECT queries');
ok(da.describe([{ check: 'a', detail: 'b' }, { check: 'c', detail: 'd' }]) === 'a: b · c: d', 'describe renders one honest line');
ok(da.namedStates('Utah and new mexico, plus Indianapolis').map((s) => s.code).sort().join(',') === 'NM,UT', 'namedStates: names matched, city-lookalikes not');

// --- the wiring: the audit sits between compose and EVERY delivery effect ---
const main = read('main.js');
ok(/delivery_audit'\)/.test(main) && /pre-announce AUDIT FAILED — honest non-delivery/.test(main), 'the compose door runs the audit');
const iAudit = main.indexOf('pre-announce AUDIT FAILED');
ok(iAudit > -1 && iAudit < main.indexOf("try { require('fs').writeFileSync(filesLib.resolvePath(rel)"), 'the audit gates BEFORE the file save');
ok(iAudit < main.indexOf('promiseArtifactEmit({ slug, title: `Report'), '…and BEFORE the canvas emit');
ok(iAudit < main.indexOf("artifact_registry').record({ slug, relPath: rel"), '…and BEFORE the registry record');
ok(/NEVER say the report is ready or done/.test(main), 'the failure followup forbids the done-claim in her voice');
ok(/miss: `audit: \$\{_verdictA\.violations/.test(main), 'the return is an honest miss naming each failed check');
ok(/fail-open, delivery proceeds/.test(main), 'an audit ERROR fails open (a broken audit never blocks a good report)');
// battery-1 catch (08-22): a scope-add fragment as topic made the audit condemn the project's own
// feeding query ('surveillance' ∉ fragment) — the compose now adopts the bound project's canonical
// subject, gated on BOTH spines agreeing (registry reuse + project bind).
ok(/topic adopts the bound project's canonical subject/.test(main), 'a re-compose runs under the PROJECT\'s canonical subject, never an order fragment');
ok(/if \(_regVersion > 1\) \{/.test(main), 'topic adoption is gated on the registry having REUSED the canonical (a new subject never inherits)');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
