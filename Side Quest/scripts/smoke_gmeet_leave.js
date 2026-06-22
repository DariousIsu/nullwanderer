/**
 * Offline test — G Meet end-of-meeting auto-leave (the "stuck in observing / closed Lucas's
 * shared tab" fix). No browser, no model: inject deps + a fake clock and drive runTick.
 *
 * Proves:
 *   1. looksLikeSignOff() catches real closers and ignores normal meeting chatter.
 *   2. After a sign-off caption THEN LEAVE_SILENCE_MS of quiet, she calls leaveMeeting()
 *      (Leave call in HER browser) and advances 'observing' → 'done'.
 *   3. Without a sign-off, silence alone does NOT make her leave (she keeps observing).
 */
const os = require('os'); const path = require('path');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_gmeetleave_${Date.now()}`, 'sq.db');
const db = require('../lib/db'); db.init();
const gmeet = require('../lib/gmeet');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } };

// Fake clock the orchestrator reads via d.now().
let CLOCK = 1_000_000;
const now = () => CLOCK;

// Build an injectable ctx ({ deps }). capScript is consumed one entry per tick (normalized
// "Speaker: text"). runTick reads ctx.deps — pass the WRAPPER, not the inner deps.
function makeDeps(capScript) {
  let i = 0;
  const calls = { leave: 0 };
  return {
    ctx: { deps: {
      web: {},
      streamChat: async () => {},
      MODEL: 'test',
      scrapeAttendees: async () => '',
      scrapeCaptions: async () => (i < capScript.length ? capScript[i++] : ''),
      enableCaptions: async () => ({ ok: true }),
      inMeeting: async () => true,                       // she IS still in-call (the stuck case)
      leaveMeeting: async () => { calls.leave++; return { ok: true, via: 'leave-button' }; },
      preClear: async () => {},
      postChat: async () => ({ ok: true }),
      retrieve: async () => [],
      webLookup: async () => '',
      now,
    } },
    calls,
  };
}

function enterObserving() {
  gmeet.start('https://meet.google.com/abc-defg-hij');   // resets seen-caps + signoff meta
  gmeet.set('observing');
  db.setMeta('gmeet_last_caption_at', String(CLOCK));     // mirror the intro→observing init
}

(async () => {
  console.log('Offline — G Meet auto-leave\n');

  console.log('looksLikeSignOff — positives:');
  for (const s of ['Bye.', 'see you on Thursday', 'thanks everyone', 'take care', 'talk to you later',
                   'Lucas is wrapping up the meeting, promising to send a follow-up email']) {
    ok(`"${s.slice(0, 32)}…" → sign-off`, gmeet.looksLikeSignOff(s));
  }
  console.log('looksLikeSignOff — negatives (normal chatter):');
  for (const s of ['I need a list of all the elected officials in the country',
                   'the database will give them that and pull up the bills',
                   'that makes a lot more sense, okay']) {
    ok(`"${s.slice(0, 32)}…" → NOT sign-off`, !gmeet.looksLikeSignOff(s));
  }

  console.log('\nsign-off + silence → she leaves the call herself:');
  {
    const { ctx, calls } = makeDeps([
      'Lucas Overby: All right.\nJoshua Fredrickson: Bye.',   // tick 1: sign-off lands
      '',                                                     // tick 2: quiet
    ]);
    enterObserving();
    CLOCK += 10_000;
    const r1 = await gmeet.runTick(ctx);
    ok('tick 1: still observing (silence not yet elapsed)', gmeet.get() === 'observing');
    ok('tick 1: did not leave yet', calls.leave === 0);
    ok('tick 1: sign-off recorded', db.getMeta('gmeet_signoff_seen') === '1');

    CLOCK += 95_000;   // > LEAVE_SILENCE_MS (90s) of quiet
    const r2 = await gmeet.runTick(ctx);
    ok('tick 2: called leaveMeeting() once', calls.leave === 1);
    ok('tick 2: advanced to done', gmeet.get() === 'done');
    ok('tick 2: note mentions leaving', /left call|left after|done/i.test(r2.note || ''));
  }

  console.log('\nNO sign-off → silence alone does NOT make her leave:');
  {
    const { ctx, calls } = makeDeps([
      'Joshua Fredrickson: the database will give them that',   // tick 1: ordinary line
      '',                                                       // tick 2: quiet
    ]);
    enterObserving();
    CLOCK += 10_000;
    await gmeet.runTick(ctx);
    CLOCK += 95_000;
    await gmeet.runTick(ctx);
    ok('did NOT leave (no sign-off)', calls.leave === 0);
    ok('still observing', gmeet.get() === 'observing');
  }

  gmeet.reset();
  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  try { require('fs').rmSync(path.dirname(process.env.SQ_DB_PATH), { recursive: true, force: true }); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})();
