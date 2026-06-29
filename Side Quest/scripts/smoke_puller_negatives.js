/* scripts/smoke_puller_negatives.js — offline checks for the verification-results reader.
 * Run: node scripts/smoke_puller_negatives.js  (pure, no db) */
'use strict';
const N = require('../studio/puller_negatives');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) pass++; else { fail++; console.error('  ✗ ' + name); } }

// ---- status normalization (the validated mapping) ----
ok('valid family', N.normalizeStatus('Deliverable') === 'valid' && N.normalizeStatus('OK') === 'valid');
ok('invalid family', N.normalizeStatus('undeliverable') === 'invalid' && N.normalizeStatus('hard bounce') === 'invalid');
ok('accept_all family', N.normalizeStatus('catch-all') === 'accept_all' && N.normalizeStatus('Accept All') === 'accept_all');
ok('unknown/greylist DEFER', N.normalizeStatus('greylisted') === 'unknown' && N.normalizeStatus('risky') === 'unknown' && N.normalizeStatus('timeout') === 'unknown');
ok('prefixed/score-tolerant', N.normalizeStatus('deliverable (98)') === 'valid' && N.normalizeStatus('status: invalid') === 'invalid');
ok('ungradeable → null', N.normalizeStatus('banana') === null && N.normalizeStatus('') === null);

// ---- CSV with header (named columns, any order) ----
const csv = [
  'Email Address,Name,Result',
  'brian.huseman@acme.com,Brian Huseman,invalid',
  'jane.doe@acme.com,Jane Doe,Deliverable',
  'press@acme.com,,catch-all',
  'greyme@acme.com,,greylisted',
  'not-an-email,,valid',          // dropped: bad email
  'x@y.com,,banana',              // dropped: bad status
].join('\n');
const r = N.parseResults(csv);
ok('header detected, 4 good rows', r.rows.length === 4);
ok('email+result mapped by header', r.rows[0].email === 'brian.huseman@acme.com' && r.rows[0].result === 'invalid');
ok('deliverable→valid', r.rows[1].result === 'valid');
ok('catch-all→accept_all', r.rows[2].result === 'accept_all');
ok('greylist→unknown (deferred, not a miss)', r.rows[3].result === 'unknown');
ok('raw status preserved', r.rows[0].raw === 'invalid');
ok('drops bad email + bad status', r.dropped.noEmail === 1 && r.dropped.badStatus === 1);

// ---- no header → col0=email, col1=status ----
const noHdr = N.parseResults('a.b@x.com,valid\nc.d@x.com,invalid');
ok('headerless fallback', noHdr.rows.length === 2 && noHdr.rows[0].email === 'a.b@x.com' && noHdr.rows[1].result === 'invalid');

// ---- TSV + quoted fields ----
const tsv = N.parseResults('email\tstatus\n"quoted@x.com"\tDeliverable');
ok('TSV + quotes', tsv.rows.length === 1 && tsv.rows[0].email === 'quoted@x.com' && tsv.rows[0].result === 'valid');

// ---- v2: vendor auto-detect ----
ok('detect hunter', N.detectVendor(['email', 'result', 'accept_all']) === 'hunter');
ok('detect zerobounce', N.detectVendor(['email', 'status', 'sub_status']) === 'zerobounce');
ok('detect apollo', N.detectVendor(['email', 'email_status']) === 'apollo');
ok('detect abstract', N.detectVendor(['email', 'deliverability', 'is_catchall_email']) === 'abstract');
ok('detect resend', N.detectVendor(['email', 'event']) === 'resend');

// ---- v2: catch-all boolean column overrides the status (Hunter/Abstract shape) ----
const hunter = N.parseResults('email,result,accept_all\na@x.com,deliverable,true\nb@x.com,deliverable,false');
ok('catch-all bool=true → accept_all (overrides deliverable)', hunter.rows.find(r => r.email === 'a@x.com').result === 'accept_all');
ok('catch-all bool=false → keeps valid', hunter.rows.find(r => r.email === 'b@x.com').result === 'valid');
ok('vendor labelled hunter', hunter.vendor === 'hunter');

// ---- v2: Resend event-log format ----
const resend = N.parseResults('email,event\na@x.com,delivered\nb@x.com,bounced\nc@x.com,soft_bounce');
ok('Resend delivered→valid, bounced→invalid, soft→unknown', resend.rows.find(r => r.email === 'a@x.com').result === 'valid'
  && resend.rows.find(r => r.email === 'b@x.com').result === 'invalid'
  && resend.rows.find(r => r.email === 'c@x.com').result === 'unknown');
ok('Resend vendor labelled', resend.vendor === 'resend');

// ---- v2: Apollo email_status column ----
ok('Apollo email_status verified→valid', N.parseResults('email,email_status\na@x.com,verified').rows[0].result === 'valid');

// ---- v2: inferName from local-part ----
ok('infer first.last', JSON.stringify(N.inferName('brian.huseman@x.com')) === JSON.stringify({ first: 'Brian', last: 'Huseman', pattern: 'first.last' }));
ok('infer first_last', N.inferName('brian_huseman@x.com').pattern === 'first_last');
ok('infer first.m.last', (n => n.first === 'Mark' && n.last === 'Miller' && n.pattern === 'first.m.last')(N.inferName('mark.a.miller@x.com')));
ok('concatenated local → null (ambiguous)', N.inferName('bhuseman@x.com') === null);

console.log(`\nsmoke_puller_negatives: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
