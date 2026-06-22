/**
 * Hard smoke — M1: speaker-turn segmentation + durable timestamped transcript.
 * Every caption line is persisted to meeting_transcript with a timestamp (so it can purge from
 * active context yet stay queryable); segmentTurns groups consecutive same-speaker lines into
 * turns with time spans. Offline; injected deps.
 */
const os = require('os'); const path = require('path');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_mtx_${Date.now()}`, 'sq.db');
const db = require('../lib/db'); db.init();
const gmeet = require('../lib/gmeet');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } };

let CLOCK = 3_000_000;
const now = () => CLOCK;

(async () => {
  console.log('Hard smoke — M1 transcript + speaker turns\n');

  console.log('segmentTurns (pure):');
  const turns = gmeet.segmentTurns([
    { speaker: 'Tom', text: 'I am working on the markup', ts: 10 },
    { speaker: 'Tom', text: 'for Wednesday', ts: 20 },
    { speaker: 'Tracy', text: 'okay', ts: 30 },
    { speaker: 'Tom', text: 'anyway', ts: 40 },
  ]);
  ok('3 turns (Tom, Tracy, Tom)', turns.length === 3 && turns[0].speaker === 'Tom' && turns[1].speaker === 'Tracy' && turns[2].speaker === 'Tom');
  ok("first turn merges Tom's two lines", /working on the markup for Wednesday/.test(turns[0].text) && turns[0].lines === 2);
  ok('turn carries its time span', turns[0].startTs === 10 && turns[0].endTs === 20);
  ok('empty input → []', gmeet.segmentTurns([]).length === 0 && gmeet.segmentTurns(null).length === 0);

  console.log('\ndurable transcript via runTick (observing):');
  const startedRef = CLOCK;
  const ctx = {
    onReading: () => {},
    userName: 'Lucas',
    deps: {
      web: {}, MODEL: 'test',
      streamChat: async () => {},
      scrapeCaptions: async () => 'Tom Hassenboehler: working on the markup\nTom Hassenboehler: for Wednesday\nTracy Bromley: okay sounds good',
      scrapeAttendees: async () => '', enableCaptions: async () => ({ ok: true }),
      inMeeting: async () => true, leaveMeeting: async () => ({ ok: true }),
      storeMeeting: async () => 1, preClear: async () => {}, postChat: async () => ({ ok: true }),
      retrieve: async () => [], webLookup: async () => '', now,
    },
  };
  gmeet.start('https://meet.google.com/abc-defg-hij');
  gmeet.set('observing');
  db.setMeta('gmeet_last_caption_at', String(CLOCK));
  // start() stamps gmeet_started_at with real Date.now(); align it to the fake clock the
  // injected deps use so the time-scoped query matches (in production both are real Date.now()).
  db.setMeta('gmeet_started_at', String(startedRef));
  const startedAt = startedRef;
  CLOCK += 5000;
  await gmeet.runTick(ctx);

  const tx = db.getTranscriptSince(startedAt);
  ok('every caption line persisted to the transcript', tx.length === 3);
  ok('lines carry speaker + meeting code + timestamp', tx[0].speaker === 'Tom Hassenboehler' && tx[0].meeting === 'abc-defg-hij' && tx[0].ts >= startedAt);
  ok('countTranscriptSince matches', db.countTranscriptSince(startedAt) === 3);

  // the transcript IS the queryable record; turns are a view over it
  const txTurns = gmeet.segmentTurns(tx);
  ok('transcript segments into 2 turns (Tom ×2 merged, Tracy)', txTurns.length === 2 && txTurns[0].lines === 2 && txTurns[1].speaker === 'Tracy Bromley');

  // a later, distinct meeting window does not pull this meeting's lines
  ok('scoped by start time (future window empty)', db.getTranscriptSince(CLOCK + 10_000_000).length === 0);

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  try { require('fs').rmSync(path.dirname(process.env.SQ_DB_PATH), { recursive: true, force: true }); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})();
