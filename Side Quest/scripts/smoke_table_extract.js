/* Smoke: lib/table_extract — turn a markdown table into a grouped, cited answer (the #1 homecoming
 * engine). Pure/offline: a fixture roster table in, a grouped digest out. Proves the parser tolerates
 * real-world shape, the pivot groups + drops noise roles, and the digest orders the governing roles
 * first and collapses a repeated role to "Role (N) — names".
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_table_extract.js
 */
'use strict';
const T = require('../lib/table_extract');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// A miniature of the LA roster: a header, a separator, party-committee NOISE, and two parishes'
// real offices (one home-rule with a President, one police-jury).
const TABLE = [
  '| Office Title | Parish | Candidate Name | Office Level |',
  '| --- | --- | --- | --- |',
  '| DSCC Member | | Someone Party | 052 |',
  '| RPEC Member | ACADIA | Party Person A | 064 |',
  '| Police Juror | ACADIA | Juror One | 245 |',
  '| Police Juror | ACADIA | Juror Two | 245 |',
  '| Sheriff | ACADIA | K.P. Gibson | 225 |',
  '| Clerk of Court | ACADIA | Laura Faul | 230 |',
  '| Parish President | ASCENSION | Clint Cointment | 243 |',
  '| Council Member | ASCENSION | Oliver Joseph | 245 |',
  '| Sheriff | ASCENSION | Bobby Webre | 225 |',
].join('\n');

// --- parse ---
const parsed = T.parseMarkdownTable(TABLE);
ok(parsed.headers.length === 4 && parsed.headers[0] === 'Office Title' && parsed.headers[1] === 'Parish', 'parseMarkdownTable: headers read, leading/trailing pipes trimmed');
ok(parsed.rows.length === 9, 'parseMarkdownTable: the separator row is skipped, 9 data rows kept');
ok(parsed.rows[0]['Candidate Name'] === 'Someone Party' && parsed.rows[0]['Office Level'] === '052', 'parseMarkdownTable: rows are keyed by header');
ok(T.parseMarkdownTable('not a table').rows.length === 0, 'parseMarkdownTable: non-table text → empty');

// --- pivot (group by Parish, drop party committees) ---
const map = T.pivot({ rows: parsed.rows, groupCol: 'Parish', roleCol: 'Office Title', nameCol: 'Candidate Name', excludeRole: /committee member|\b[DR][PS](?:EC|CC) member\b/i });
ok(map.size === 2 && map.has('ACADIA') && map.has('ASCENSION'), 'pivot: groups by Parish, the blank-parish DSCC row and the RPEC row drop → 2 real parishes');
ok(!map.get('ACADIA').some((r) => /RPEC|DSCC/.test(r.role)), 'pivot: party-committee roles excluded');
ok(map.get('ACADIA').filter((r) => r.role === 'Police Juror').length === 2, 'pivot: both police jurors kept');

// --- digest (governing roles first, repeats collapsed) ---
const roleOrder = ['Parish President', 'Police Juror', 'Council Member', 'Sheriff', 'Clerk of Court'];
const dig = T.digestByGroup(map, { roleOrder, maxNames: 3, cite: 'doc #8443' });
ok(dig.lines.length === 2 && dig.groups === 2, 'digestByGroup: one line per group');
const acadia = dig.lines.find((l) => /ACADIA/.test(l));
const ascension = dig.lines.find((l) => /ASCENSION/.test(l));
ok(/Police Juror \(2\) — Juror One, Juror Two/.test(acadia), 'digest: a repeated role collapses to "Role (N) — names"');
ok(acadia.indexOf('Police Juror') < acadia.indexOf('Sheriff'), 'digest: governing body (Police Juror) ordered before the constitutional officer (Sheriff)');
ok(/Parish President — Clint Cointment/.test(ascension) && ascension.indexOf('Parish President') < ascension.indexOf('Council Member'), 'digest: a home-rule parish leads with its Parish President (structure respected)');

// --- roleOrder acts as the include filter: a role not listed is dropped from the view ---
const digNarrow = T.digestByGroup(map, { roleOrder: ['Sheriff'], maxNames: 3 });
ok(digNarrow.lines.every((l) => !/Police Juror|Council Member/.test(l)), 'digest: roleOrder is the include filter — unlisted roles drop from the answer view');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
