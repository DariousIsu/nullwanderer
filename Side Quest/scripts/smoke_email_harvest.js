/* Smoke: lib/email_harvest — pull STATED public emails from page text (public-email collection). Pure.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_email_harvest.js
 */
'use strict';
const { extractEmails } = require('../lib/email_harvest');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

const text = [
  'Contact Jane Doe at jane.doe@acme.org for media inquiries.',
  'General: info@acme.org · Press: no-reply@acme.org',
  'A masked teaser: j***@acme.org and an example test@example.com',
  'An asset: logo@2x.png and sprite.svg — not emails.',
  'Her personal note: janedoe.writer@gmail.com',
].join('\n');

const found = extractEmails(text, { name: 'Jane Doe', orgDomain: 'acme.org' });
const emails = found.map((f) => f.email);
ok(emails.includes('jane.doe@acme.org'), 'pulls the stated professional email');
ok(emails.includes('janedoe.writer@gmail.com'), 'pulls a stated personal email too (public info)');
ok(emails.includes('info@acme.org'), 'pulls a general org email');
ok(!emails.includes('no-reply@acme.org'), 'drops no-reply');
ok(!emails.includes('test@example.com'), 'drops example.com junk');
ok(!emails.some((e) => /\*/.test(e)), 'drops the masked teaser');
ok(!emails.some((e) => /\.png|\.svg/.test(e)), 'drops asset filenames (logo@2x.png)');

const top = found[0];
ok(top.email === 'jane.doe@acme.org', `name+org match ranks first — got ${top.email}`);
ok(top.confidence > 0.7 && /name/.test(top.reason) && /org/.test(top.reason), `name-in-localpart + org-domain both scored (${top.confidence.toFixed(2)}, ${top.reason})`);
ok(extractEmails('duplicate a@b.com and a@b.com', {}).filter((f) => f.email === 'a@b.com').length === 1, 'dedups repeated addresses');
ok(extractEmails('', {}).length === 0 && extractEmails(null, {}).length === 0, 'empty/null text → [], no crash');
ok(extractEmails('no addresses here at all', {}).length === 0, 'text with no emails → []');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
