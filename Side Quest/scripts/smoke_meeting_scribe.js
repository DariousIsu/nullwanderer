/**
 * Hard smoke — meeting scribe (separate recorder, own model). Offline; injected deps + temp db.
 * Verifies: pure prompt builders, transcript accumulation + minutes refresh at the line threshold,
 * cursor advance (no re-reading), and finalize storing a recap + clearing state.
 */
const os = require('os'); const path = require('path');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_scribe_${Date.now()}`, 'sq.db');
const db = require('../lib/db'); db.init();
const scribe = require('../lib/meeting_scribe');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } };

// ---- pure ----
ok('cleanModelText strips tags + quotes', scribe.cleanModelText('<think>x</think>"hello"') === 'hello');
ok('buildMinutesPrompt includes prior + new', /no minutes yet/.test(scribe.buildMinutesPrompt('', 'A: hi')) && /A: hi/.test(scribe.buildMinutesPrompt('', 'A: hi')));
ok('buildRecapPrompt includes minutes + Action items', /Action items/.test(scribe.buildRecapPrompt('Topics: x')) && /Topics: x/.test(scribe.buildRecapPrompt('Topics: x')));

// ---- flow with injected deps ----
let minutesCalls = 0, recapCalls = 0, stored = null;
const deps = {
  MODEL: 'fake-scribe',
  getTranscriptSince: (ts, lim) => db.getTranscriptSince(ts, lim),
  storeMeeting: async (content, opts) => { stored = { content, opts }; return { id: 1 }; },
  now: () => 5_000_000,
  streamChat: async ({ messages, onToken }) => {
    const p = messages[0].content;
    if (/FINAL record/.test(p)) { recapCalls++; onToken('Summary. Action items:\n- Lucas: follow up'); }
    else { minutesCalls++; onToken('Topics:\n- launch plan\nDecisions:\n- ship Friday\nAction items:\n- Lucas: send draft'); }
  },
};

(async () => {
  console.log('Hard smoke — meeting scribe\n');
  db.setMeta('gmeet_started_at', '1000');

  // seed 4 lines (below threshold of 6) → no minutes refresh yet
  for (let i = 0; i < 4; i++) db.insertTranscriptLine({ meeting: 'abc', speaker: 'Tom', text: `line ${i}`, ts: 1000 + i });
  let r = await scribe.tick({ deps });
  ok('session auto-started', scribe.hasPending() === true);
  ok('4 lines read, below threshold → no minutes yet', r.lines === 4 && r.updated === false && minutesCalls === 0);

  // 3 more lines crosses the 6-line threshold on next tick → minutes refresh
  for (let i = 4; i < 7; i++) db.insertTranscriptLine({ meeting: 'abc', speaker: 'Tracy', text: `line ${i}`, ts: 1010 + i });
  r = await scribe.tick({ deps });
  ok('threshold crossed → minutes updated', r.updated === true && minutesCalls === 1);
  ok('minutes persisted', /launch plan/.test(scribe.minutes()));

  // a tick with no new lines does nothing
  const before = minutesCalls;
  r = await scribe.tick({ deps });
  ok('no new lines → no model call', r.lines === 0 && minutesCalls === before);

  // finalize → recap stored, state cleared
  const recap = await scribe.finalize({ deps });
  ok('finalize produced recap', /Action items/.test(recap) && recapCalls === 1);
  ok('recap stored as meeting memory', stored && /Meeting record \(scribe\)/.test(stored.content) && stored.opts.source === 'scribe');
  ok('session cleared after finalize', scribe.hasPending() === false && scribe.minutes() === '');
  ok('finalize is idempotent (no second recap)', (await scribe.finalize({ deps })) === '' && recapCalls === 1);

  console.log(`\n${fail ? 'FAIL' : 'ALL PASS'} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
