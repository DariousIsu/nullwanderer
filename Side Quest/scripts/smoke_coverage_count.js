/* Smoke: accurate FILTER-SCOPED coverage count (contacts_query party/level parse + buildCoverageCountSql).
 *
 * The bug: coverage answers counted the EMAILED gather subset (203) not the DB (1,410 LA on file). The fix
 * builds a DIRECT COUNT over electoral.contact honoring the real filters — state, party, government level,
 * elected — so "how many republican state officials in LA" returns the true number. Pure + injection-safe.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_coverage_count.js
 */
'use strict';
const cq = require('../lib/contacts_query');
let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// --- party parse ---
ok(cq.partyFrom('every republican in the state') === 'R', 'republican → R');
ok(cq.partyFrom('all the democrats we have') === 'D', 'democrat → D');
ok(cq.partyFrom('every official in Louisiana') === null, 'no party word → null');

// --- level parse ---
ok(cq.levelFrom('every state-level official') === 'state', 'state-level → state');
ok(cq.levelFrom('all our congressional / federal contacts') === 'federal', 'federal/congress → federal');
ok(cq.levelFrom('parish and county leadership') === 'local', 'parish/county → local');
ok(cq.levelFrom('the contacts we have') === null, 'no level word → null');

// --- detect threads party + level through ---
const d = cq.detect('how many republican state officials do we have in Louisiana?');
ok(d.isQuery && d.countOnly === true, 'coverage question → countOnly');
ok(d.state === 'LA' && d.party === 'R' && d.level === 'state', 'detect: state=LA, party=R, level=state');

// --- buildCoverageCountSql: the real filters land in the WHERE ---
const c = cq.buildCoverageCountSql({ state: 'LA', party: 'R', level: 'state', type: 'elected' });
ok(c.applies === true, 'applies to a civic-CRM coverage ask');
ok(/c\.State_Represented\)\)='LA' OR UPPER\(TRIM\(c\.MailingState\)\)='LA'/.test(c.sql), 'state filter (either field) in WHERE');
ok(/c\.Party_Canonical\)\)='R'/.test(c.sql), 'party filter in WHERE');
ok(/c\.Office_Role_Canonical LIKE 'state\\_%'/.test(c.sql), 'state-level role family in WHERE');
ok(/c\.Contact_Kind__c='elected' OR c\.Active_Elected__c=1/.test(c.sql), 'elected filter in WHERE');
ok(/LEFT JOIN electoral\.account a/.test(c.sql), 'joins account (for name-reach)');
ok(/COUNT\(\*\) AS total/.test(c.sql) && /with_email/.test(c.sql) && /no_location/.test(c.sql),
  'counts total + with_email + no_location');
ok(c.filters.includes('LA') && c.filters.includes('Republican') && c.filters.includes('state-level') && c.filters.includes('elected'),
  'filters labelled for the reply');

// --- PARISH REACH: a named parish body is found by ACCOUNT NAME (role-coding is absent) ---
const p = cq.buildCoverageCountSql({ company: 'Richland Parish' });
ok(p.applies && /LOWER\(a\.Name\) LIKE '%richland parish%'/.test(p.sql), 'named parish → account-name match (Richland → its 3)');
ok(p.filters.includes('Richland Parish'), 'parish label carried');

// --- company (parish) is the GEOGRAPHIC ANCHOR — a strict state filter would drop stateless parish rows ---
const lp = cq.buildCoverageCountSql({ company: 'parish', state: 'LA' });
ok(/LOWER\(a\.Name\) LIKE '%parish%'/.test(lp.sql), 'LA parish → account-name %parish% (the 788)');
ok(!/c\.State_Represented\)\)='LA'/.test(lp.sql), 'company present → account anchors, no strict state gate (parish rows are stateless)');

// --- level=local reaches parish/county accounts, not just the ~5 role-coded rows ---
const loc = cq.buildCoverageCountSql({ level: 'local', state: 'TX' });
ok(/LOWER\(a\.Name\) LIKE '%parish%' OR LOWER\(a\.Name\) LIKE '%county%'/.test(loc.sql), 'local level reaches parish/county accounts');
ok(loc.filters.includes('local/parish'), 'local scope labelled');

// --- corporate → not this CRM (caller falls back to the Puller gather) ---
ok(cq.buildCoverageCountSql({ type: 'corporate', state: 'LA' }).applies === false, 'corporate ask → applies:false');

// --- injection-safe: malformed state rejected; company LIKE has quotes doubled + metachars escaped ---
const bad = cq.buildCoverageCountSql({ state: "LA'; DROP TABLE contact;--" });
ok(!/DROP/.test(bad.sql), 'malformed state is rejected, not inlined (no injection)');
const inj = cq.buildCoverageCountSql({ company: "x'; DROP TABLE contact;--" });
ok(/x''; drop table/.test(inj.sql) && !/'; DROP TABLE contact;--'/.test(inj.sql), 'company quotes doubled (injection-safe LIKE literal)');

// --- no filters → a bare (but valid) total over the CRM ---
const none = cq.buildCoverageCountSql({});
ok(none.applies === true && /WHERE c\.deleted=0/.test(none.sql), 'no filters → valid total over the CRM');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
