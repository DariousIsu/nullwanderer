/* Smoke: the outbound-email kill-switch. Default = blocked (nothing sent); the gate re-opens
 * only when ZOE_EMAIL_SEND_ENABLED is set. No SMTP creds → the enabled path stops at
 * "not configured" before any network call, so this is offline + send-free.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_email_killswitch.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const tmp = path.join(os.tmpdir(), `sq_smoke_email_${process.pid}.db`);
process.env.SQ_DB_PATH = tmp;
// Deterministic env: fake creds so isConfigured() is true (lets us inspect the prompt blocks),
// and the switch starts OFF. Fake creds never send — no test calls sendEmail with the switch on.
process.env.ZOE_EMAIL_USER = 'test@example.com';
process.env.ZOE_EMAIL_PASS = 'not-a-real-password';
delete process.env.ZOE_EMAIL_SEND_ENABLED;
const db = require('C:/Users/azrae/Desktop/Side Quest/lib/db');
const email = require('C:/Users/azrae/Desktop/Side Quest/lib/email');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

(async () => {
  try {
    db.init();

    console.log('default (switch unset) — sending is blocked:');
    ok(email.isSendEnabled() === false, 'isSendEnabled() is false by default');
    const r1 = await email.sendEmail({ to: 'real.person@example.com', subject: 'hi', body: 'a hallucinated email' });
    ok(r1.ok === false && r1.blocked === true, 'sendEmail returns { ok:false, blocked:true } — nothing sent');
    const logs = db.getDb().prepare("SELECT status, COUNT(*) n FROM email_log GROUP BY status").all();
    const byStatus = Object.fromEntries(logs.map(l => [l.status, l.n]));
    ok((byStatus.sent || 0) === 0, 'no `sent` rows in email_log');
    ok((byStatus.blocked || 0) === 1, 'the blocked attempt is audited (status=blocked)');

    // NOTE: we deliberately do NOT call sendEmail() with the switch ON — .env may carry real
    // SMTP creds (dotenv), and an enabled send would actually hit the mail server. The guard is
    // the first line of sendEmail() and consults isSendEnabled(), so proving the toggle flips
    // the predicate (plus the blocked path above) fully proves the gate without risking a send.
    console.log('toggle — the predicate the guard depends on flips on/off:');
    process.env.ZOE_EMAIL_SEND_ENABLED = '1';
    ok(email.isSendEnabled() === true, 'isSendEnabled() → true with ZOE_EMAIL_SEND_ENABLED=1');
    process.env.ZOE_EMAIL_SEND_ENABLED = 'true';
    ok(email.isSendEnabled() === true, 'accepts "true"');
    process.env.ZOE_EMAIL_SEND_ENABLED = '0';
    ok(email.isSendEnabled() === false, '"0" stays blocked');
    delete process.env.ZOE_EMAIL_SEND_ENABLED;
    ok(email.isSendEnabled() === false, 'unset stays blocked (fail-safe default)');

    console.log('prompt reflects the hold (so she knows, and stops trying):');
    const blockOff = email.buildPromptBlock();
    ok(/TURNED OFF/i.test(blockOff) && !/you can send real email yourself/i.test(blockOff),
       'buildPromptBlock tells her sending is off, not how to send');
    const nudgeOff = email.buildEmailNudge('can you send an email to bob@example.com');
    ok(/off|disabled/i.test(nudgeOff) && !/EMAIL ACTION/.test(nudgeOff),
       'buildEmailNudge says it is off + offers to draft, never pushes a send');

    console.log('and when re-enabled, the normal send guidance returns:');
    process.env.ZOE_EMAIL_SEND_ENABLED = '1';
    const blockOn = email.buildPromptBlock();
    ok(/you can send real email yourself/i.test(blockOn), 'buildPromptBlock restores the send capability text');
    // Regression guard for the fixed `draft` ReferenceError: the enabled nudge must run (no throw)
    // and, with no draft in progress, return the normal send nudge.
    let nudgeOn = null, threw = false;
    try { nudgeOn = email.buildEmailNudge('can you send an email to bob@example.com'); } catch { threw = true; }
    ok(!threw, 'buildEmailNudge no longer throws on the enabled path (draft ReferenceError fixed)');
    ok(/EMAIL ACTION/.test(nudgeOn || ''), 'enabled nudge returns the normal send guidance');
    delete process.env.ZOE_EMAIL_SEND_ENABLED;
  } catch (e) {
    fail++; console.error('  ✗ threw:', e.stack || e.message);
  } finally {
    try { db.getDb().close(); } catch {}
    for (const f of [tmp, tmp + '-wal', tmp + '-shm']) { try { fs.existsSync(f) && fs.unlinkSync(f); } catch {} }
  }
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
