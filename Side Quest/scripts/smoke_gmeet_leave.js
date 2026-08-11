/**
 * Offline test — G Meet end-of-meeting auto-leave (the "stuck in observing / closed Lucas's
 * shared tab" fix). No browser, no model: inject deps + a fake clock and drive runTick.
 *
 * Proves:
 *   1. looksLikeSignOff() catches real closers and ignores normal meeting chatter.
 *   2. After a sign-off caption THEN LEAVE_SILENCE_MS of quiet AND effectively alone, she calls
 *      leaveMeeting() (Leave call in HER browser) and advances 'observing' → 'done'.
 *   3. Without a sign-off, silence alone does NOT make her leave (she keeps observing).
 *   4. ATTENDEE GROUND-TRUTH: sign-off + long quiet but others STILL present → she does NOT leave.
 *   5. UN-STUCK LATCH: a sign-off followed by real conversation DISARMS the leave (an early
 *      "thanks everyone" no longer latches a hang-up forever).
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
function makeDeps(capScript, { recap = '' } = {}) {
  let i = 0;
  const calls = { leave: 0, store: 0, stored: null };
  const surfaced = [];
  return {
    ctx: {
      onReading: (content, label) => surfaced.push({ content, label }),
      deps: {
        web: {},
        // the recap synthesis is the only streamChat call here; emit the canned recap.
        streamChat: async ({ onToken } = {}) => { if (recap && onToken) onToken(recap); },
        MODEL: 'test',
        scrapeAttendees: async () => '',
        scrapeCaptions: async () => (i < capScript.length ? capScript[i++] : ''),
        enableCaptions: async () => ({ ok: true }),
        inMeeting: async () => true,                       // she IS still in-call (the stuck case)
        leaveMeeting: async () => { calls.leave++; return { ok: true, via: 'leave-button' }; },
        storeMeeting: async (c) => { calls.store++; calls.stored = c; return 1; },
        preClear: async () => {},
        postChat: async () => ({ ok: true }),
        retrieve: async () => [],
        webLookup: async () => '',
        now,
      },
    },
    calls,
    surfaced,
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

  console.log('\nsign-off + silence → she leaves the call herself AND processes it:');
  {
    const RECAP = 'The team reviewed the LAMP/Salesforce database scope and agreed it stays separate from the elected-official integration. Action items: Lucas — send a wrap-up email; Joshua — confirm which file the lamp list came from; you — note the Thursday 1–2pm ET sync.';
    const { ctx, calls, surfaced } = makeDeps([
      'Lucas Overby: All right.\nJoshua Fredrickson: Bye.',   // tick 1: sign-off lands
      '',                                                     // tick 2: quiet
    ], { recap: RECAP });
    enterObserving();
    db.setMeta('gmeet_understanding_log', 'They discussed the LAMP/Salesforce database scope.\nThey agreed it stays separate from the elected-official integration.\nLucas will send a wrap-up email and a Thursday sync is being scheduled.');
    CLOCK += 10_000;
    const r1 = await gmeet.runTick(ctx);
    ok('tick 1: still observing (silence not yet elapsed)', gmeet.get() === 'observing');
    ok('tick 1: did not leave yet', calls.leave === 0);
    ok('tick 1: sign-off recorded', db.getMeta('gmeet_signoff_seen') === '1');

    CLOCK += 305_000;   // > LEAVE_SILENCE_MS (5min) of quiet; scrapeAttendees:'' → alone → leave allowed
    const r2 = await gmeet.runTick(ctx);
    ok('tick 2: called leaveMeeting() once', calls.leave === 1);
    ok('tick 2: advanced to done', gmeet.get() === 'done');
    ok('tick 2: note mentions leaving + recap', /left call|left after|done/i.test(r2.note || '') && /recap/i.test(r2.note || ''));
    // PROCESSING: the meeting was synthesized into a durable, surfaced EPISODIC memory (R3) —
    // the recap is now wrapped as "I attended a Google Meet … What it covered: <recap>" so general
    // recall surfaces it as her own attendance, not a free-floating note.
    ok('recap stored as durable episodic memory (called once, attendance-framed, contains recap)',
      calls.store === 1 && typeof calls.stored === 'string' && /I attended a Google Meet/.test(calls.stored) && calls.stored.includes(RECAP));
    ok('recap surfaced to Lucas', surfaced.some(s => /Here's what I took from the meeting/.test(s.content || '')));
    ok('gmeet_last_recap persisted', (db.getMeta('gmeet_last_recap') || '') === RECAP);
    ok('understanding log cleared (no double-store)', (db.getMeta('gmeet_understanding_log') || '') === '');
  }

  console.log('\nno captions captured → no recap fabricated:');
  {
    const { ctx, calls } = makeDeps(['', ''], { recap: 'SHOULD NOT BE USED' });
    enterObserving();
    db.setMeta('gmeet_signoff_seen', '1');                 // pretend a sign-off was heard but nothing was transcribed
    CLOCK += 305_000;
    await gmeet.runTick(ctx);
    ok('left the empty call', gmeet.get() === 'done' && calls.leave === 1);
    ok('did NOT store an empty/fabricated recap', calls.store === 0);
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
    CLOCK += 305_000;
    await gmeet.runTick(ctx);
    ok('did NOT leave (no sign-off)', calls.leave === 0);
    ok('still observing', gmeet.get() === 'observing');
  }

  console.log('\nsign-off + long quiet BUT others still present → she does NOT leave (attendee ground-truth):');
  {
    const { ctx, calls } = makeDeps(['Joshua Fredrickson: Bye.', '', ''], {});
    ctx.deps.scrapeAttendees = async () => 'Lucas Overby\nJoshua Fredrickson';   // two people still in the call
    enterObserving();
    CLOCK += 10_000; await gmeet.runTick(ctx);            // sign-off lands → armed
    CLOCK += 305_000; await gmeet.runTick(ctx);           // long quiet, but the call is still populated
    ok('did NOT leave (2 attendees still present)', calls.leave === 0);
    ok('still observing (populated call)', gmeet.get() === 'observing');
  }

  console.log('\nsign-off THEN real conversation resumes → leave is DISARMED (un-stuck latch):');
  {
    const { ctx, calls } = makeDeps([
      'Joshua Fredrickson: thanks everyone',               // an early pleasantry → arms the latch
      'Lucas Overby: okay so back to the database scope',  // real talk continues → DISARMS it
      '',                                                  // quiet
    ], {});
    enterObserving();
    CLOCK += 10_000; await gmeet.runTick(ctx);
    ok('armed after the pleasantry', db.getMeta('gmeet_signoff_seen') === '1');
    CLOCK += 10_000; await gmeet.runTick(ctx);
    ok('DISARMED after conversation resumed', db.getMeta('gmeet_signoff_seen') === '');
    CLOCK += 305_000; await gmeet.runTick(ctx);
    ok('did NOT leave (latch was disarmed)', calls.leave === 0);
  }

  // FORCE-LEAVE (live incident 2026-08-11): a user-prompted "leave" when active() is FALSE but she's still
  // in the call (state desynced to stage 'done' after a prior unconfirmed leave) — the normal gates miss it,
  // so forceLeave must hang up directly; and when she is NOT in a call it must be a clean no-op (never
  // navigate a non-meeting tab).
  {
    gmeet.reset();
    const fl = { inCall: true, leaves: 0 };
    const flDeps = { web: {}, inMeeting: async () => fl.inCall, leaveMeeting: async () => { fl.leaves++; return { ok: true, via: 'leave-button' }; } };
    gmeet.set('done'); db.setMeta('gmeet_leave_requested', '1'); db.setMeta('gmeet_ended_at', '');
    let r = await gmeet.forceLeave({ deps: flDeps });
    ok('forceLeave (STUCK: active()=false but inMeeting=true) → hung up once', r.ok === true && fl.leaves === 1);
    ok('forceLeave cleared the stale leave flag', db.getMeta('gmeet_leave_requested') === '');
    ok('forceLeave parked stage=done + stamped ended_at', gmeet.get() === 'done' && !!db.getMeta('gmeet_ended_at'));

    fl.inCall = false; fl.leaves = 0;
    r = await gmeet.forceLeave({ deps: flDeps });
    ok('forceLeave (NOT in a call) → clean no-op, never clicked leave', r.via === 'not-in-call' && fl.leaves === 0);
  }

  gmeet.reset();
  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  try { require('fs').rmSync(path.dirname(process.env.SQ_DB_PATH), { recursive: true, force: true }); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})();
