/**
 * Offline test — Microsoft Teams meeting lane (lib/teams). No browser, no model: inject mock driver
 * deps + a fake clock and drive runTick through every stage.
 *
 * Proves:
 *   1. detectTeamsUrl matches both real invite forms (l/meetup-join + /meet/…), normalizes a bare link,
 *      and rejects a non-meeting Teams URL + a non-Teams link.
 *   2. teamsLinkFromEvent pulls the join URL from onlineMeeting / conferenceData / location.
 *   3. Full happy path: joining → (lobby) → waiting → (admitted) → intro → observing → done + recap,
 *      reusing gmeet's pure helpers (caption parse, attendee parse, sign-off) through the Teams machine.
 *   4. THE LOBBY NEVER STRIKES OUT — repeated waiting ticks keep her in 'waiting', not reset to 'none'.
 *   5. Direct join (no lobby): inMeeting on the first tick → straight to intro.
 *   6. External-chat-blocked intro: postChat keeps failing → after the strikes she still advances to
 *      observing (perception continues) but tells Lucas LOUDLY the room was NOT told she's here.
 */
const os = require('os'); const path = require('path');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_teams_${Date.now()}`, 'sq.db');
const db = require('../lib/db'); db.init();
const teams = require('../lib/teams');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } };

let CLOCK = 2_000_000;
const now = () => CLOCK;

// Mock driver deps. state.inMeeting / state.inLobby are flipped by the test between ticks to simulate
// the join → lobby → admitted progression. capScript feeds one caption scrape per observing tick.
function makeDeps(capScript = [], opts = {}) {
  let i = 0;
  const state = { inMeeting: false, inLobby: false, postChatOk: opts.postChatOk !== false };
  const calls = { leave: 0, store: 0, stored: [], enableCaptions: 0, postChat: 0 };
  const surfaced = [];      // onReading (ambient rail)
  const surfacedOut = [];   // onSurface (loud → Lucas)
  const streamChat = async ({ messages, onToken } = {}) => {
    const p = (messages && messages[0] && messages[0].content) || '';
    let out = '';
    if (/introducing yourself/i.test(p)) out = "Hi all, I'm Zoe, Lucas's AI assistant, here to follow along and take notes.";
    else if (/sat in on/i.test(p)) out = opts.recap || '';
    else if (/what's being discussed/i.test(p)) out = opts.understanding || 'They are discussing the Q3 budget; Joshua is leading.';
    else if (/addressed you/i.test(p)) out = opts.reply || "Sure — I'll pull that up.";
    if (out && onToken) onToken(out);
  };
  const ctx = {
    onReading: (content, label) => surfaced.push({ content, label }),
    onSurface: (text) => surfacedOut.push(text),
    deps: {
      web: { runRecipe: async () => ({ ok: true }) },
      streamChat, MODEL: 'test',
      scrapeAttendees: async () => opts.attendees || '',
      scrapeCaptions: async () => (i < capScript.length ? capScript[i++] : ''),
      enableCaptions: async () => { calls.enableCaptions++; return { ok: true }; },
      inMeeting: async () => state.inMeeting,
      inLobby: async () => state.inLobby,
      leaveMeeting: async () => { calls.leave++; return { ok: true }; },
      dumpDom: async () => 'url: https://login.live.com/oauth20_authorize.srf\nsignals: joinBtn=false loginPage=true',
      preClear: async () => {},
      postChat: async (_w, msg) => { calls.postChat++; return state.postChatOk ? { ok: true } : { ok: false, reason: 'composer not found' }; },
      retrieve: async () => [], webLookup: async () => '',
      storeMeeting: async (c) => { calls.store++; calls.stored.push(c); return 1; },
      joinConfirmMs: 0,   // no real sleep in the join-confirmation poll under test
      now,
    },
  };
  return { ctx, state, calls, surfaced, surfacedOut };
}

(async () => {
  console.log('Offline — Microsoft Teams lane\n');

  console.log('detectTeamsUrl:');
  const U1 = 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=xyz';
  const U2 = 'https://teams.microsoft.com/meet/1234567890?p=abcDEF';
  const U3 = 'https://teams.live.com/meet/9876543210';
  ok('meetup-join form', teams.detectTeamsUrl('join here ' + U1) === U1);
  ok('/meet/ form', teams.detectTeamsUrl(U2) === U2);
  ok('teams.live.com form', teams.detectTeamsUrl(U3) === U3);
  ok('bare link normalized to https', teams.detectTeamsUrl('hop in: teams.microsoft.com/meet/111?p=x') === 'https://teams.microsoft.com/meet/111?p=x');
  ok('non-meeting Teams URL → null', teams.detectTeamsUrl('https://teams.microsoft.com/_#/conversations/abc') === null);
  ok('a Google Meet link → null (not Teams)', teams.detectTeamsUrl('meet.google.com/abc-defg-hij') === null);
  ok('no link → null', teams.detectTeamsUrl('no meeting here') === null);

  console.log('\nteamsLinkFromEvent:');
  ok('onlineMeeting.joinUrl', teams.teamsLinkFromEvent({ onlineMeeting: { joinUrl: U1 } }) === U1);
  ok('conferenceData entryPoint', teams.teamsLinkFromEvent({ conferenceData: { entryPoints: [{ uri: U2 }] } }) === U2);
  ok('location text', teams.teamsLinkFromEvent({ location: 'Microsoft Teams Meeting — ' + U3 }) === U3);
  ok('no teams link → null', teams.teamsLinkFromEvent({ summary: 'standup', location: 'Room A' }) === null);

  console.log('\nhappy path — joining → lobby → waiting → admitted → intro → observing → done:');
  {
    const RECAP = 'The team walked the Q3 budget and agreed to defer the new hire. Action items: Lucas — circulate the revised sheet; Joshua — confirm the vendor quote.';
    const { ctx, state, calls, surfaced, surfacedOut } = makeDeps([
      'Joshua Fredrickson: Okay, so on the Q3 budget.\nLucas Overby: Right, the new hire line.',   // observe tick 1
      'Joshua Fredrickson: Bye, thanks everyone.',                                                  // observe tick 2 (sign-off)
      '', '',                                                                                        // quiet
    ], { recap: RECAP, attendees: 'Lucas Overby\nJoshua Fredrickson' });

    ok('start() → joining', teams.start(U1) === true && teams.get() === 'joining');
    db.setMeta('teams_started_at', String(CLOCK));   // align the transcript-scope anchor with the fake clock (prod uses real Date.now() for both)

    state.inLobby = true;   // she reaches the lobby (external account)
    CLOCK += 10_000; await teams.runTick(ctx);
    ok('joining → waiting (reached lobby)', teams.get() === 'waiting');
    ok('told Lucas she is waiting to be let in', surfacedOut.some(t => /lobby|let me in/i.test(t)));

    CLOCK += 10_000; await teams.runTick(ctx);
    ok('still waiting (lobby does not advance on its own)', teams.get() === 'waiting');

    state.inMeeting = true; state.inLobby = false;   // the host admits her
    CLOCK += 10_000; await teams.runTick(ctx);
    ok('admitted → intro', teams.get() === 'intro');

    CLOCK += 10_000; await teams.runTick(ctx);
    ok('intro posted → observing', teams.get() === 'observing');
    ok('enabled captions on the way into observing', calls.enableCaptions >= 1);
    ok('posted the intro to chat', calls.postChat === 1);
    ok('present captured from the roster', (JSON.parse(db.getMeta('teams_present') || '[]')).includes('Joshua Fredrickson'));

    CLOCK += 10_000; await teams.runTick(ctx);   // observe tick 1 — captions flow
    ok('surfaced live captions as perception', surfaced.some(s => /Q3 budget/.test(s.content || '')));
    ok('persisted a transcript line', (db.getTranscriptSince(parseInt(db.getMeta('teams_started_at'), 10), 100) || []).length >= 1);

    CLOCK += 30_000; await teams.runTick(ctx);   // stale wait → understanding forms
    ok('formed a running understanding', (db.getMeta('teams_understanding') || '').length > 0);

    // sign-off already delivered in tick 2's buffer; now go quiet + alone → she leaves + recaps.
    state.inMeeting = false;
    CLOCK += 10_000; await teams.runTick(ctx);   // not-in-meeting miss 1/2
    CLOCK += 10_000; await teams.runTick(ctx);   // miss 2/2 → done + recap
    ok('meeting ended → done', teams.get() === 'done');
    ok('stored a durable episodic recap (Teams-framed)', calls.stored.some(s => typeof s === 'string' && /I attended a Microsoft Teams meeting/.test(s) && s.includes(RECAP)));
    ok('surfaced the recap to Lucas', surfaced.some(s => /what I took from the meeting/i.test(s.content || '')));
    teams.reset();
  }

  console.log('\nthe lobby NEVER strikes out (a long wait is legitimate, not a failure):');
  {
    const { ctx, state } = makeDeps();
    teams.start(U1);
    state.inLobby = true;
    for (let k = 0; k < 6; k++) { CLOCK += 60_000; await teams.runTick(ctx); }
    ok('after 6 lobby ticks she is STILL waiting (not reset to none)', teams.get() === 'waiting');
    teams.reset();
  }

  console.log('\ndirect join (no lobby) → straight to intro:');
  {
    const { ctx, state } = makeDeps();
    teams.start(U2);
    state.inMeeting = true;
    CLOCK += 10_000; await teams.runTick(ctx);
    ok('joined directly → intro', teams.get() === 'intro');
    teams.reset();
  }

  console.log('\nexternal chat blocked → she observes UNDISCLOSED but tells Lucas loudly:');
  {
    const { ctx, state, surfacedOut } = makeDeps([], { postChatOk: false });
    teams.start(U1);
    state.inMeeting = true;
    CLOCK += 10_000; await teams.runTick(ctx);   // joined → intro
    // three intro ticks, each a failed post → on the third strike she gives up + advances
    for (let k = 0; k < 3; k++) { CLOCK += 10_000; await teams.runTick(ctx); }
    ok('advanced to observing despite chat being blocked (perception continues)', teams.get() === 'observing');
    ok('told Lucas LOUDLY the room was not told she is here', surfacedOut.some(t => /could NOT post my introduction|not been told|disclose/i.test(t)));
    teams.reset();
  }

  console.log('\njoin not confirmed (wrong selectors / stuck on login) → strikes, never falsely advances:');
  {
    const { ctx } = makeDeps();   // inMeeting=false, inLobby=false throughout (recipe still returns ok)
    teams.start(U1);
    CLOCK += 10_000; await teams.runTick(ctx);
    ok('tick 1: still joining (recipe-ok alone does NOT advance to intro)', teams.get() === 'joining');
    CLOCK += 10_000; await teams.runTick(ctx);
    ok('tick 2: still joining', teams.get() === 'joining');
    CLOCK += 10_000; await teams.runTick(ctx);
    ok('tick 3: 3rd strike → gave up (reset to none), never faked a join', teams.get() === 'none');
    teams.reset();
  }

  console.log('\nA1 caption-drought → honest surface, keeps attending (G3 teams variant):');
  {
    const G = require('../lib/gmeet');   // teams reuses g.CAPTION_DROUGHT_MS
    teams.start(U1); teams.set('observing');
    db.setMeta('teams_started_at', String(CLOCK - (G.CAPTION_DROUGHT_MS + 5000)));   // captions dry long enough (fake clock)
    const { ctx, state, surfacedOut } = makeDeps([], { attendees: 'Alice\nBob\nCarol' });   // others present, ZERO captions
    state.inMeeting = true;
    const r = await teams.runTick(ctx);
    ok('teams drought → honest surface about no captions', surfacedOut.some(t => /not getting any (?:live )?captions/i.test(t)));
    ok('teams drought → STILL observing (stays, does not leave)', teams.get() === 'observing');
    ok('teams drought note reflects the honest surface', /caption drought/.test(r.note));
    const before = surfacedOut.length;
    await teams.runTick(ctx);
    ok('teams drought latched — does not repeat every tick', surfacedOut.length === before);
    teams.reset();
  }

  console.log('\nA1 teams drought does NOT fire once captions are working:');
  {
    const G = require('../lib/gmeet');
    teams.start(U1); teams.set('observing');
    db.setMeta('teams_started_at', String(CLOCK - (G.CAPTION_DROUGHT_MS + 5000)));
    const { ctx, state, surfacedOut } = makeDeps(['Alice: We can hear you fine'], { attendees: 'Alice\nBob' });
    state.inMeeting = true;
    const r = await teams.runTick(ctx);
    ok('teams captions working → NO drought surface', !surfacedOut.some(t => /not getting any/i.test(t)) && /new caption/.test(r.note));
    teams.reset();
  }

  console.log('\nA1 teams drought stays quiet when alone (present<2):');
  {
    const G = require('../lib/gmeet');
    teams.start(U1); teams.set('observing');
    db.setMeta('teams_started_at', String(CLOCK - (G.CAPTION_DROUGHT_MS + 5000)));
    const { ctx, state, surfacedOut } = makeDeps([], { attendees: 'Zoe (You)' });   // ≤1 present
    state.inMeeting = true;
    await teams.runTick(ctx);
    ok('teams alone + no captions → no drought surface (present<2)', !surfacedOut.some(t => /not getting any/i.test(t)));
    teams.reset();
  }

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  try { require('fs').rmSync(path.dirname(process.env.SQ_DB_PATH), { recursive: true, force: true }); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})();
