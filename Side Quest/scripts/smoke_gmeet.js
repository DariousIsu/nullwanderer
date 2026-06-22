/**
 * Backtest — Google Meet Step 1 (offline). Pure helpers (URL/event detection, intro
 * prompt + MANDATORY-disclosure guarantee, caption/attendee parsing), the join→intro→
 * observe stage machine through mock deps, and recipe structure. No browser/model/Meet.
 */
const os = require('os'); const path = require('path');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_gmeet_${Date.now()}`, 'sq.db');
const db = require('../lib/db'); db.init();
const g = require('../lib/gmeet');
const store = require('../lib/recipe_store');
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } };

const URL1 = 'https://meet.google.com/abc-defg-hij';

function mockDeps(over = {}) {
  const calls = { recipes: [], posts: [] };
  const web = {
    runRecipe: async (name, vars) => {
      calls.recipes.push([name, vars]);
      if (name === 'gmeet_join') return over.joinResult || { ok: true, ran: 5 };
      return { ok: true };
    },
    read: async () => ({ ok: true, text: '' })
  };
  return {
    calls,
    deps: {
      web, MODEL: 'test',
      streamChat: over.streamChat || (async ({ onToken }) => onToken(over.introText != null ? over.introText : "Hi everyone — I'm Zoe, Lucas's AI assistant, here to follow along and take notes.")),
      scrapeAttendees: async () => over.attendeesText || '',
      scrapeCaptions: async () => (over.captionsRef ? over.captionsRef.text : (over.captionsText || '')),
      enableCaptions: async () => over.captionsEnable || { ok: true, via: 'shortcut' },
      inMeeting: async () => (over.inMeeting !== undefined ? over.inMeeting : true),
      preClear: async () => {},
      postChat: async (_w, msg) => { calls.posts.push(msg); return over.postResult || { ok: true }; }
    }
  };
}

(async () => {
  console.log('Backtest — Google Meet Step 1 (offline)\n');

  console.log('detectMeetUrl:');
  ok('finds a meet url in text', g.detectMeetUrl('join this https://meet.google.com/abc-defg-hij please') === URL1);
  ok('loose lookup form', /meet\.google\.com/.test(g.detectMeetUrl('https://meet.google.com/lookup/abc123') || ''));
  ok('no url → null', g.detectMeetUrl('no link here') === null);
  // SCHEME-LESS link (the real "can't join" bug): Lucas pastes a bare meet.google.com/...
  ok('bare meet.google.com link → normalized to https', g.detectMeetUrl('meet.google.com/fhe-ccmh-ykx') === 'https://meet.google.com/fhe-ccmh-ykx');
  ok('bare link inside a sentence is found + normalized', g.detectMeetUrl('hop in when you can: meet.google.com/abc-defg-hij thanks') === URL1);

  console.log('\nmeetLinkFromEvent:');
  ok('hangoutLink', g.meetLinkFromEvent({ hangoutLink: URL1 }) === URL1);
  ok('conferenceData entryPoint', g.meetLinkFromEvent({ conferenceData: { entryPoints: [{ uri: URL1 }] } }) === URL1);
  ok('location text', g.meetLinkFromEvent({ location: 'Room A — ' + URL1 }) === URL1);
  ok('no meet → null', g.meetLinkFromEvent({ summary: 'standup', location: 'Room A' }) === null);

  console.log('\nintroPrompt:');
  const pWith = g.introPrompt({ userName: 'Lucas', attendees: ['Alice', 'Bob'] });
  ok('invites greeting recognized people', /Alice/.test(pWith) && /greet/i.test(pWith));
  ok('demands AI disclosure', /\bAI\b/.test(pWith) && /MUST/.test(pWith));
  const pNone = g.introPrompt({ userName: 'Lucas', attendees: [] });
  ok('general hello when no attendees', /friendly hello/i.test(pNone));

  console.log('\nvalidateIntro + ensureIntro (the mandatory guarantee: name + disclosure):');
  ok('valid intro passes (name + disclosure)', g.validateIntro("Hi all, I'm Zoe, Lucas's AI assistant, here to take notes.").ok);
  ok('no NAME fails', g.validateIntro('Hi all, I am an AI assistant here to take notes.').ok === false);
  ok('no disclosure fails', g.validateIntro('Hey everyone, Zoe here, great to be here!').ok === false);
  ok('too-long fails', g.validateIntro('Zoe AI ' + 'x '.repeat(220)).ok === false);
  ok('ensureIntro keeps a compliant intro', g.validateIntro(g.ensureIntro("I'm Zoe, Lucas's AI assistant.", 'Lucas')).ok);
  const fixed = g.ensureIntro('Hey everyone, excited to be here!', 'Lucas');
  ok('ensureIntro injects name + disclosure when missing', g.validateIntro(fixed).ok && /Zoe/.test(fixed) && /AI assistant/i.test(fixed));

  console.log('\nparseCaptions / parseAttendees:');
  const caps = g.parseCaptions('Alice: Hello team\nworld\nBob: Hi there');
  ok('parses speaker:text + continuation', caps.length === 2 && caps[0].speaker === 'Alice' && /Hello team world/.test(caps[0].text) && caps[1].speaker === 'Bob');
  const att = g.parseAttendees('Alice\nBob (You)\nSearch\nAlice\nChat');
  ok('dedups + strips (You) + drops chrome', att.length === 2 && att.includes('Alice') && att.includes('Bob'));

  console.log('\nstage machine (join → intro → observe):');
  ok('start → joining + active', g.start(URL1) && g.active() && g.get() === 'joining');
  const m = mockDeps({ attendeesText: 'Alice\nBob (You)', captionsRef: { text: 'Alice: Hello\nBob: Hi' } });
  let r = await g.runTick({ userName: 'Lucas', deps: m.deps });
  ok('joining → intro (recipe ran)', r.ok && g.get() === 'intro' && m.calls.recipes[0][0] === 'gmeet_join' && m.calls.recipes[0][1].url === URL1);
  r = await g.runTick({ userName: 'Lucas', deps: m.deps });
  ok('intro → observing (posted, disclosed)', r.ok && g.get() === 'observing' && m.calls.posts.length === 1 && g.validateIntro(m.calls.posts[0]).ok);
  r = await g.runTick({ userName: 'Lucas', deps: m.deps });
  ok('observing surfaces 2 fresh captions', r.ok && /2 new/.test(r.note));
  r = await g.runTick({ userName: 'Lucas', deps: m.deps });
  ok('no new captions next tick', r.ok && /no new/.test(r.note));
  m.deps.scrapeCaptions = async () => 'Alice: Hello\nBob: Hi\nAlice: One more thing';   // a new line arrives
  r = await g.runTick({ userName: 'Lucas', deps: m.deps });
  ok('detects only the 1 newly-added caption', r.ok && /1 new/.test(r.note));
  g.reset();

  console.log('\nfollow-along: enough captions → synthesizes understanding (registers live):');
  g.start(URL1); g.set('observing');
  const mFollow = mockDeps({
    captionsRef: { text: 'Lucas: one\nAlice: two\nBob: three\nLucas: four\nAlice: five' },
    streamChat: async ({ onToken }) => onToken("They're discussing the Q3 roadmap; Lucas flagged a migration risk."),
  });
  let surfacedFollow = '';
  const fr = await g.runTick({ userName: 'Lucas', deps: mFollow.deps, onReading: (c, l) => { if (/following/i.test(l || '')) surfacedFollow = c; } });
  ok('≥4 new lines → follows along (understanding synthesized)', fr.ok && /followed along/.test(fr.note));
  ok('understanding surfaced as her perception', /Q3 roadmap|migration risk/.test(surfacedFollow));
  g.reset();

  console.log('\nstay-in: recipe imperfect but actually in-meeting → joins anyway (anti-wander):');
  g.start(URL1);
  const mStay = mockDeps({ joinResult: { ok: false, reason: 'modal covered Join now' }, inMeeting: true });
  const sr = await g.runTick({ userName: 'Lucas', deps: mStay.deps });
  ok('joins via in-meeting source-of-truth', sr.ok && g.get() === 'intro');
  g.reset();

  console.log('\ngive-up: not in + recipe fails 3x → asks Lucas:');
  g.start(URL1);
  const mGive = mockDeps({ joinResult: { ok: false, reason: 'no Join now' }, inMeeting: false });
  let asked2 = null;
  await g.runTick({ userName: 'Lucas', deps: mGive.deps, onSurface: t => { asked2 = t; } });
  await g.runTick({ userName: 'Lucas', deps: mGive.deps, onSurface: t => { asked2 = t; } });
  await g.runTick({ userName: 'Lucas', deps: mGive.deps, onSurface: t => { asked2 = t; } });
  ok('after 3 fails → inactive + asks Lucas', !g.active() && /let me in|check the link/i.test(asked2 || ''));
  g.reset();

  console.log('\nleave detection (meeting ended → exits observing, frees the idle loop):');
  g.start(URL1); g.set('observing');
  const mLeave = mockDeps({ inMeeting: false });
  let lr = await g.runTick({ userName: 'Lucas', deps: mLeave.deps });
  ok('1st miss stays observing', g.get() === 'observing' && /1\/2/.test(lr.note));
  lr = await g.runTick({ userName: 'Lucas', deps: mLeave.deps });
  ok('2nd miss → ends + inactive (no more loop monopoly)', !g.active() && /ended/.test(lr.note));
  g.reset();

  console.log('\nintro guarantee end-to-end (model forgets name + disclosure → still both):');
  g.start(URL1);
  const m2 = mockDeps({ introText: 'Hey all, so happy to be here with you!' });   // NO name, NO disclosure
  await g.runTick({ userName: 'Lucas', deps: m2.deps });    // joining → intro
  await g.runTick({ userName: 'Lucas', deps: m2.deps });    // intro posts
  ok('posted intro carries name + disclosure despite model omission', m2.calls.posts.length === 1 && g.validateIntro(m2.calls.posts[0]).ok && /Zoe/.test(m2.calls.posts[0]));
  g.reset();

  console.log('\njoin blocked → asks Lucas to sign in:');
  g.start(URL1);
  const m3 = mockDeps({ joinResult: { ok: false, blocker: { type: 'login', needsHuman: true } } });
  let asked = null;
  r = await g.runTick({ userName: 'Lucas', deps: m3.deps, onSurface: (t) => { asked = t; } });
  ok('blocked join stays joining + asks to sign in', !r.ok && r.blocker === 'login' && g.get() === 'joining' && /log me into|sign(ed)? (me )?in/i.test(asked || ''));
  g.reset();

  console.log('\nrecipes present + structured:');
  ok('gmeet_join loads (verified:false)', (() => { const x = store.load('gmeet_join'); return x && x.task === 'join' && x.verified === false && x.steps.length >= 3; })());
  ok('gmeet_post_chat loads', (() => { const x = store.load('gmeet_post_chat'); return x && x.task === 'post_chat' && x.steps.some(s => s.value === '{{message}}'); })());

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  try { require('fs').rmSync(path.dirname(process.env.SQ_DB_PATH), { recursive: true, force: true }); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})();
