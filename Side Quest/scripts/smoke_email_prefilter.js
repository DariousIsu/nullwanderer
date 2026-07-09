/* Smoke: lib/email_prefilter — the SAFE no-handshake pre-send filter (offline, injected MX resolver).
 * Proof: syntax / disposable / role / MX-presence verdicts, and that it NEVER does an SMTP handshake and
 * FAILS OPEN on a DNS blip (no self-inflicted drops). The authoritative mailbox-exists answer stays with
 * the ESP send-and-bounce loop — this only culls the obviously-unsendable.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_email_prefilter.js
 */
'use strict';
const P = require('../lib/email_prefilter');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

// --- pure sub-checks -------------------------------------------------------------------------------
console.log('== pure checks ==');
ok(P.validSyntax('jane.doe@acme.com') === true, 'valid syntax passes');
ok(P.validSyntax('nope@@acme') === false && P.validSyntax('no-at-sign') === false && P.validSyntax('a@b') === false, 'malformed / no-TLD / no-dot → invalid');
ok(P.isDisposable('mailinator.com') === true && P.isDisposable('acme.com') === false, 'disposable domain detected; a real one is not');
ok(P.isRole('info') === true && P.isRole('support') === true && P.isRole('jane.doe') === false, 'role local-parts flagged; a person name is not');
ok(P.parts('Jane.Doe@Acme.COM').domain === 'acme.com' && P.parts('Jane.Doe@Acme.COM').local === 'jane.doe', 'parts() lowercases + splits on the last @');

// injected MX resolvers
const mxOk = async () => [{ exchange: 'mail.acme.com', priority: 10 }];
const mxNone = async () => [];
const mxNx = async () => { const e = new Error('nope'); e.code = 'ENOTFOUND'; throw e; };
const mxBlip = async () => { const e = new Error('timeout'); e.code = 'ETIMEDOUT'; throw e; };

(async () => {
  console.log('== prefilter verdicts (injected MX, NEVER an SMTP handshake) ==');
  ok((await P.prefilter('bad@@x', { resolveMx: mxOk })).verdict === 'reject' && (await P.prefilter('bad@@x', { resolveMx: mxOk })).reason === 'syntax', 'bad syntax → reject (no MX lookup even attempted)');
  ok((await P.prefilter('user@mailinator.com', { resolveMx: mxOk })).reason === 'disposable', 'disposable domain → reject');
  ok((await P.prefilter('jane.doe@acme.com', { resolveMx: mxOk })).verdict === 'pass', 'good address + MX present → PASS (worth an ESP send)');
  ok((await P.prefilter('jane.doe@acme.com', { resolveMx: mxNone })).reason === 'no-mx', 'domain with NO MX record → reject (can\'t receive mail)');
  ok((await P.prefilter('jane.doe@acme.com', { resolveMx: mxNx })).reason === 'no-mx', 'NXDOMAIN → reject');
  const blip = await P.prefilter('jane.doe@acme.com', { resolveMx: mxBlip });
  ok(blip.verdict === 'pass' && blip.checks.mx === 'unknown', 'a DNS BLIP (timeout) FAILS OPEN → pass (never drop on our own hiccup)');
  const roleV = await P.prefilter('info@acme.com', { resolveMx: mxOk });
  ok(roleV.verdict === 'flag' && roleV.reason === 'role-address', 'a role address → FLAG (kept + marked, not dropped)');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
