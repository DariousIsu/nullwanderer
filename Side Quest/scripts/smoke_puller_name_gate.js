/* Smoke: studio/puller_name_gate — junk person-name rejection (#43).
 * Proves the gate drops roles/orgs/mailboxes while keeping real people (incl. edge cases). Pure, no db.
 * Run: node scripts/smoke_puller_name_gate.js
 */
'use strict';
const { isJunkPersonName } = require('../studio/puller_name_gate');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };
const junk = (n) => ok(isJunkPersonName(n) === true, `JUNK: "${n}"`);
const keep = (n) => ok(isJunkPersonName(n) === false, `KEEP: "${n}"`);

console.log('— junk: roles (a role is not a person) —');
junk('Finance Director');
junk('Communications Manager');
junk('Executive Director');
junk('Board Member');
junk('Vice President');
junk('Chief');
junk('Director');
junk('Interim Treasurer');

console.log('— junk: organizations / legal entities —');
junk('Smith Family Trust');
junk('Acme Foundation');
junk('Rainey PAC');
junk('Board of Trustees');
junk('Advisory Board');
junk('The Heritage Institute');
junk('Government Accountability Office');

console.log('— junk: org-tail mailboxes + single-token generics + non-names —');
junk('Press Office');          // "office" is an org tail
junk('Various');               // single generic token
junk('Unknown');
junk('Contact');
junk('info2020');              // digit+alpha mailbox local-part
junk('');
junk('   ');
junk('the of and');

console.log('— KEEP: multi-word generic personas are the ingest TIER system\'s job, not this gate (#43 scope = role/org) —');
keep('General Inquiries');     // no role/org tail → left to the 30%-generic tier
keep('Support Team');

console.log('— keep: real people (a false positive drops a real contact) —');
keep('John Smith');
keep('Mary Jane Watson');
keep('Jane Doe');
keep("Sarah O'Brien");
keep('Jean-Luc Picard');
keep('Alexandria Ocasio-Cortez');
keep('Trust Nkosi');            // a person whose given name is "Trust" — surname is real
keep('Li Wei');
keep('Henry Whitehorn');
keep('Dr. Angela Merkel');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
