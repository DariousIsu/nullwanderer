/**
 * Hard smoke — post-meeting recall: after a meeting ends, her AWARENESS block must state she
 * ATTENDED it (recap + who was there) for a freshness window, so she recalls instead of
 * confabulating. Mirrors the live gmeetLine. Offline; temp DB.
 */
const os = require('os'); const path = require('path');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_recall_${Date.now()}`, 'sq.db');
const db = require('../lib/db'); db.init();
const ctx = require('../lib/context');
const gmeet = require('../lib/gmeet');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } };

function awareness() {
  return ctx.buildAwarenessBlock({ chosenName: 'Zoe', sessionStartedAt: Date.now(), cumulativeMs: 60000 });
}

(async () => {
  console.log('Hard smoke — post-meeting recall\n');

  // no meeting yet → no recall line
  gmeet.reset();
  db.setMeta('gmeet_last_recap', ''); db.setMeta('gmeet_ended_at', '0'); db.setMeta('gmeet_present', '[]');
  let a = String(await awareness());
  ok('no recap → no recall line', !/ATTENDED a Google Meet/.test(a));

  // a meeting just ended → recall line present with recap + attendees
  db.setMeta('gmeet_stage', 'done');
  db.setMeta('gmeet_last_recap', 'Budget review for April; Tracy to send the venue quote; Lucas to confirm speakers.');
  db.setMeta('gmeet_present', JSON.stringify(['Lucas Overby', 'Madeline Keeter', 'Tracy']));
  db.setMeta('gmeet_ended_at', String(Date.now() - 40 * 60 * 1000)); // 40 min ago
  a = String(await awareness());
  ok('recall line fires after a fresh meeting', /ATTENDED a Google Meet/.test(a));
  ok('recall carries the recap', /Budget review for April/.test(a));
  ok('recall names who was there', /Madeline Keeter/.test(a) && /Tracy/.test(a));
  ok('recall says ago', /min ago|h ago|just now/.test(a));
  ok('recall asserts she SAT THROUGH it (not a calendar entry)', /not just a calendar entry/i.test(a));

  // stale meeting (>6h) → no recall line
  db.setMeta('gmeet_ended_at', String(Date.now() - 7 * 60 * 60 * 1000));
  a = String(await awareness());
  ok('stale meeting (>6h) drops out of recall', !/ATTENDED a Google Meet/.test(a));

  // while a meeting is ACTIVE, recall line is suppressed (live line owns it)
  db.setMeta('gmeet_stage', 'observing');
  db.setMeta('gmeet_ended_at', String(Date.now() - 40 * 60 * 1000));
  a = String(await awareness());
  ok('active meeting suppresses the post-meeting recall line', !/ATTENDED a Google Meet/.test(a));

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  try { require('fs').rmSync(path.dirname(process.env.SQ_DB_PATH), { recursive: true, force: true }); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})();
