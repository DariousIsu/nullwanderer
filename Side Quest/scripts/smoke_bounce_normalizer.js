/* Smoke: lib/bounce_normalizer — the format-AGNOSTIC bounce/test-list normalizer (F4).
 * Proof: sniff + parse of DSN (RFC3464) / ARF (RFC5965) / ESP JSON (SES/SendGrid/Mailgun/Postmark/Resend)
 * / CSV / free-text all reduce to ONE canonical row; the enhanced-status CLASS digit arbitrates hard vs
 * soft (5=invalid, 4=unknown, 2=valid) and OVERRIDES a misleading textual action; a complaint is
 * suppression-not-invalid; and reconcileTestList classifies a sent list (bounce/deliver/silent).
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_bounce_normalizer.js
 */
'use strict';
const N = require('../lib/bounce_normalizer');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const find = (rows, email) => rows.find(r => r.email === email);

// --- arbiter unit ---------------------------------------------------------------------------------
console.log('== enhanced-status class digit = master arbiter ==');
ok(N.classResult(5) === 'invalid' && N.classResult(4) === 'unknown' && N.classResult(2) === 'valid', 'class 5→invalid, 4→unknown(soft), 2→valid');
ok(N.statusClassOf('Status: 5.1.1 (bad destination mailbox)') === 5, 'extracts the 5.x.x class from a status line');
ok(N.statusClassOf('we had 5 items on 2024') === null, 'does NOT mistake "5 items" for an enhanced status (needs X.Y.Z)');

// --- sniff ----------------------------------------------------------------------------------------
console.log('== sniff picks the right reader ==');
ok(N.sniff('{"notificationType":"Bounce"}') === 'json', 'json sniffed');
ok(N.sniff('Feedback-Type: abuse\nUser-Agent: x') === 'arf', 'arf sniffed via Feedback-Type');
ok(N.sniff('Final-Recipient: rfc822; a@b.com\nAction: failed\nStatus: 5.1.1') === 'dsn', 'dsn sniffed via recipient+action');
ok(N.sniff('email,status\na@b.com,invalid') === 'csv', 'csv sniffed via delimiter+@');
ok(N.sniff('some prose about a@b.com bounced') === 'unknown', 'free text → unknown (regex fallback)');

// --- DSN ------------------------------------------------------------------------------------------
console.log('== DSN (RFC 3464): class digit arbitrates, Action is the fallback ==');
const dsn = [
  'Content-Type: message/delivery-status', '',
  'Final-Recipient: rfc822; hardfail@acme.com',
  'Action: failed',
  'Status: 5.1.1',
  'Diagnostic-Code: smtp; 550 5.1.1 user unknown', '',
  'Final-Recipient: rfc822; softfail@acme.com',
  'Action: failed',
  'Status: 4.4.1', '',
  'Final-Recipient: rfc822; ok@acme.com',
  'Action: delivered',
  'Status: 2.0.0', '',
].join('\n');
const rd = N.parse(dsn);
ok(rd.format === 'dsn', 'parsed as dsn');
ok(find(rd.rows, 'hardfail@acme.com').result === 'invalid', '5.1.1 failed → invalid (hard)');
ok(find(rd.rows, 'softfail@acme.com').result === 'unknown', '4.4.1 failed → unknown (SOFT — class digit overrides the "failed" action)');
ok(find(rd.rows, 'ok@acme.com').result === 'valid', '2.0.0 delivered → valid');

// --- ARF ------------------------------------------------------------------------------------------
console.log('== ARF (RFC 5965): a complaint is SUPPRESSION, not invalidity ==');
const arf = [
  'Content-Type: multipart/report; report-type=feedback-report;', '',
  'Feedback-Type: abuse',
  'User-Agent: SomeMailer/1.0',
  'Original-Rcpt-To: rfc822; complainer@acme.com', '',
].join('\n');
const ra = N.parse(arf);
ok(ra.format === 'arf', 'parsed as arf');
ok(find(ra.rows, 'complainer@acme.com').result === 'unknown', 'complaint → result unknown (the box exists — it received the mail)');
ok(find(ra.rows, 'complainer@acme.com').suppression === true, 'complaint → suppression:true (do-not-send WITHOUT marking invalid)');

// --- ESP JSON -------------------------------------------------------------------------------------
console.log('== ESP JSON webhooks: SES / SendGrid / Mailgun / Postmark / Resend ==');
const ses = JSON.stringify({ notificationType: 'Bounce', bounce: { bounceType: 'Permanent',
  bouncedRecipients: [{ emailAddress: 'x@ses.com', status: '5.1.1' }] }, mail: { destination: ['x@ses.com'] } });
ok(find(N.parse(ses).rows, 'x@ses.com').result === 'invalid', 'SES Permanent bounce (status 5.1.1) → invalid');
const sesSoft = JSON.stringify({ notificationType: 'Bounce', bounce: { bounceType: 'Transient',
  bouncedRecipients: [{ emailAddress: 's@ses.com', status: '4.2.2' }] } });
ok(find(N.parse(sesSoft).rows, 's@ses.com').result === 'unknown', 'SES Transient bounce (4.2.2) → unknown (soft)');
const sesComplaint = JSON.stringify({ notificationType: 'Complaint', complaint: { complainedRecipients: [{ emailAddress: 'c@ses.com' }] } });
const rc = find(N.parse(sesComplaint).rows, 'c@ses.com');
ok(rc.result === 'unknown' && rc.suppression === true, 'SES Complaint → unknown + suppression');
const sg = JSON.stringify([{ email: 'g@sg.com', event: 'bounce', type: 'bounce' }, { email: 'd@sg.com', event: 'delivered' }]);
const rsg = N.parse(sg);
ok(find(rsg.rows, 'g@sg.com').result === 'invalid' && find(rsg.rows, 'd@sg.com').result === 'valid', 'SendGrid bounce→invalid, delivered→valid');
const mg = JSON.stringify({ 'event-data': { event: 'failed', severity: 'permanent', recipient: 'm@mg.com', 'delivery-status': { code: 550, message: '5.1.1 no mailbox' } } });
ok(find(N.parse(mg).rows, 'm@mg.com').result === 'invalid', 'Mailgun permanent failure → invalid');
const pm = JSON.stringify({ RecordType: 'Bounce', Type: 'HardBounce', Email: 'p@pm.com' });
ok(find(N.parse(pm).rows, 'p@pm.com').result === 'invalid', 'Postmark HardBounce → invalid');
const rz = JSON.stringify({ type: 'email.bounced', data: { to: ['r@rz.com'] }, bounce_type: 'hard' });
ok(find(N.parse(rz).rows, 'r@rz.com').result === 'invalid', 'Resend email.bounced (hard) → invalid');

// --- CSV delegation -------------------------------------------------------------------------------
console.log('== CSV delegates to puller_negatives (one of four readers) ==');
const csv = 'email,status\nq@csv.com,undeliverable\nw@csv.com,deliverable';
const rcsv = N.parse(csv);
ok(rcsv.format === 'csv' && find(rcsv.rows, 'q@csv.com').result === 'invalid' && find(rcsv.rows, 'w@csv.com').result === 'valid', 'CSV parsed via the shared vendor reader');

// --- free text fallback ---------------------------------------------------------------------------
console.log('== regex fallback for a mystery format ==');
const ft = '550 user unknown for nobody@ghost.com\ndelivered fine to real@ghost.com';
const rft = N.parse(ft);
ok(find(rft.rows, 'nobody@ghost.com').result === 'invalid' && find(rft.rows, 'real@ghost.com').result === 'valid', 'free text: keyword sniff invalid vs delivered');

// --- weighting + reconciliation -------------------------------------------------------------------
console.log('== test-list weighting + reconciliation ==');
ok(N.parse(csv, { testList: true }).rows.every(r => r.weight === 'test'), 'opts.testList tags every row weight:test');
ok(N.parse(csv).rows.every(r => r.weight === 'opportunistic'), 'default weight is opportunistic');
const sent = ['bounced@t.com', 'delivered@t.com', 'silent@t.com', 'not-an-email'];
const backRows = [{ email: 'bounced@t.com', result: 'invalid' }, { email: 'delivered@t.com', result: 'valid' }];
const recon = N.reconcileTestList(sent, backRows);
ok(recon.length === 3, 'reconcile drops the non-address, keeps the 3 real sends');
ok(find(recon, 'bounced@t.com').result === 'invalid' && find(recon, 'delivered@t.com').result === 'valid', 'sent list: bounced→invalid, delivered→valid');
ok(find(recon, 'silent@t.com').result === 'unknown' && find(recon, 'silent@t.com').silent === true, 'SILENT sent address → unknown (silence is NOT proof of delivery)');
ok(recon.every(r => r.weight === 'test'), 'reconciled rows all carry weight:test');
// invalid beats valid beats silence when an address has conflicting events
const conflict = N.reconcileTestList(['dup@t.com'], [{ email: 'dup@t.com', result: 'valid' }, { email: 'dup@t.com', result: 'invalid' }]);
ok(find(conflict, 'dup@t.com').result === 'invalid', 'conflicting events → hard bounce is decisive');

// --- SNS-wrapped SES (the standard AWS webhook envelope) ------------------------------------------
console.log('== SNS envelope is unwrapped to the inner SES event (not dropped) ==');
const sns = JSON.stringify({ Type: 'Notification', MessageId: 'm', TopicArn: 't',
  Message: JSON.stringify({ notificationType: 'Bounce', bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'z@ses.com', status: '5.1.1' }] } }) });
const rsns = N.parse(sns);
ok(rsns.rows.length === 1 && find(rsns.rows, 'z@ses.com') && find(rsns.rows, 'z@ses.com').result === 'invalid', 'SNS-wrapped SES Permanent bounce → unwrapped → invalid');

// --- collapse duplicate events per mailbox --------------------------------------------------------
console.log('== collapseByEmail: N events for one mailbox → ONE decisive row ==');
const dup = N.collapseByEmail([
  { email: 'a@x.com', result: 'invalid' }, { email: 'a@x.com', result: 'invalid' }, { email: 'a@x.com', result: 'invalid' },
]);
ok(dup.length === 1 && dup[0].result === 'invalid', 'three identical hard bounces collapse to one');
const mixed = N.collapseByEmail([
  { email: 'b@x.com', result: 'valid' }, { email: 'b@x.com', result: 'invalid' },   // decisive wins
  { email: 'c@x.com', result: 'unknown', suppression: true }, { email: 'c@x.com', result: 'invalid' },  // bounce + complaint
]);
ok(find(mixed, 'b@x.com').result === 'invalid', 'invalid beats valid when a mailbox has both');
const c = find(mixed, 'c@x.com');
ok(c.result === 'invalid' && c.suppression === true, 'a mailbox that both bounced AND complained keeps invalid + suppression');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
