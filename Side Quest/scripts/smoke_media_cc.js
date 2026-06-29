/**
 * Backtest — Media CC capture, Slice 1 (offline). Pure helpers (URL/id detection, site
 * config, caption parsing + dedupe) and the open → enable → watch stage machine through
 * mock deps. No browser/model. The live DOM cascade verifies on a real video.
 */
const os = require('os'); const path = require('path');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_media_${Date.now()}`, 'sq.db');
const db = require('../lib/db'); db.init();
const m = require('../lib/media_cc');
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } };

const YT = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

// Mock deps: a captionsRef whose .text the watch loop reads (so a test can mutate it between
// ticks to simulate new captions arriving), plus the cascade's `via`.
function mockDeps(over = {}) {
  const calls = { opens: [], enables: [], reads: 0, stored: [] };
  return {
    calls,
    deps: {
      web: {},
      openMedia: async (_w, u) => { calls.opens.push(u); return over.openResult || { ok: true, url: u }; },
      enableCaptions: async () => { calls.enables.push(1); return over.enableResult || { ok: true, via: 'button' }; },
      readCaptions: async () => { calls.reads++; return { text: over.captionsRef ? over.captionsRef.text : (over.captionsText || ''), via: over.via || 'dom' }; },
      isPlaying: async () => (over.isPlaying !== undefined ? over.isPlaying : true),
      MODEL: 'test',
      streamChat: over.streamChat || (async ({ onToken }) => onToken(over.modelText != null ? over.modelText : 'A running understanding of the video.')),
      storeMeeting: async (content, opts) => { calls.stored.push({ content, opts }); return { id: 1 }; },
      now: over.now,
    }
  };
}

(async () => {
  console.log('Backtest — Media CC, Slice 1 (offline)\n');

  console.log('detectMediaUrl:');
  ok('youtube watch url', m.detectMediaUrl('check this https://www.youtube.com/watch?v=dQw4w9WgXcQ out') === YT);
  ok('bare youtu.be normalized to https', m.detectMediaUrl('youtu.be/dQw4w9WgXcQ') === 'https://youtu.be/dQw4w9WgXcQ');
  ok('youtube live url', /youtube\.com\/live\//.test(m.detectMediaUrl('https://youtube.com/live/abc123def') || ''));
  ok('falls back to any http url', m.detectMediaUrl('watch https://vimeo.com/123456789') === 'https://vimeo.com/123456789');
  ok('no url → null', m.detectMediaUrl('just some text') === null);

  console.log('\nmediaId / hostOf / siteConfig:');
  ok('id from watch?v=', m.mediaId(YT) === 'dQw4w9WgXcQ');
  ok('id from youtu.be', m.mediaId('https://youtu.be/dQw4w9WgXcQ') === 'dQw4w9WgXcQ');
  ok('id absent → null', m.mediaId('https://vimeo.com/123') === null);
  ok('hostOf strips www', m.hostOf(YT) === 'youtube.com');
  ok('youtube site config has caption selectors', m.siteConfig(YT).kind === 'youtube' && m.siteConfig(YT).captionSelectors.length > 0);
  ok('unknown host → generic config', m.siteConfig('https://example.com/v').kind === 'generic');

  console.log('\nparseCaptionBlock + freshFrom (cascade dedupe):');
  const lines = m.parseCaptionBlock('  Hello there  \n\n<i>everyone</i>\n' + 'x'.repeat(300));
  ok('normalizes, strips markup, drops empties + overlong', lines.length === 2 && lines[0] === 'Hello there' && lines[1] === 'everyone');
  const seen = new Set();
  ok('first pass: all fresh', m.freshFrom(seen, ['a', 'b']).length === 2);
  ok('second pass: repeats suppressed', m.freshFrom(seen, ['a', 'b']).length === 0);
  ok('only genuinely-new line surfaces', JSON.stringify(m.freshFrom(seen, ['a', 'c'])) === JSON.stringify(['c']));

  console.log('\nstage machine (open → enable → watch):');
  ok('start → opening + active', m.start(YT) && m.active() && m.get() === 'opening');
  const ref = { text: 'We are no strangers to love' };
  const d1 = mockDeps({ captionsRef: ref, via: 'dom' });
  let r = await m.runTick({ deps: d1.deps });
  ok('opening → enabling (navigated to the url)', r.ok && m.get() === 'enabling' && d1.calls.opens[0] === YT);
  r = await m.runTick({ deps: d1.deps });
  ok('enabling → watching (captions turned on)', r.ok && m.get() === 'watching' && d1.calls.enables.length === 1);
  let surfaced = '';
  r = await m.runTick({ deps: d1.deps, onReading: (c, l) => { if (/caption/i.test(l || '')) surfaced = c; } });
  ok('watching surfaces the fresh caption line', r.ok && /1 new caption/.test(r.note) && /no strangers to love/.test(surfaced));
  r = await m.runTick({ deps: d1.deps });
  ok('same caption not re-surfaced next tick', r.ok && /no new captions/.test(r.note));
  ref.text = 'We are no strangers to love\nYou know the rules and so do I';   // a new line arrives
  r = await m.runTick({ deps: d1.deps });
  ok('detects only the 1 newly-added caption', r.ok && /1 new caption/.test(r.note) && r.via === 'dom');
  ok('transcript rows persisted under media:<id>', db.getTranscriptSince(0).filter(x => x.meeting === 'media:dQw4w9WgXcQ').length === 2);
  m.reset();

  console.log('\nfollow-along: enough captions → synthesizes a running understanding (registers what she watches):');
  m.start(YT); m.set('watching');
  const refF = { text: 'Line one of the talk\nLine two follows\nThen line three\nAnd line four here' };
  const dF = mockDeps({ captionsRef: refF, modelText: "It's a talk explaining how neural networks learn from data." });
  let understood = '';
  let fr = await m.runTick({ deps: dF.deps, onReading: (c, l) => { if (/following/i.test(l || '')) understood = c; } });
  ok('≥4 new lines → understanding synthesized', fr.ok && /understanding \(/.test(fr.note));
  ok('understanding surfaced as her perception', /neural networks/.test(understood));
  ok('latest understanding stored for her awareness', /neural networks/.test(db.getMeta('media_understanding')));
  m.reset();

  console.log('\nfollow-along stale-flush: a slow video (<4 lines) is still understood after the max wait:');
  m.start(YT); m.set('watching');
  let clock = 1000;
  const refS = { text: 'A single slow caption line' };
  const dS = mockDeps({ captionsRef: refS, now: () => clock, modelText: 'A quiet opening line before the video gets going.' });
  let sr1 = await m.runTick({ deps: dS.deps });
  ok('1 sparse line → not yet synthesized (below count, not stale)', sr1.ok && /1 new caption/.test(sr1.note));
  clock += 26000;                                            // past FOLLOW_MAX_WAIT_MS
  refS.text = 'A single slow caption line';                 // same line, nothing fresh this tick
  let sr2 = await m.runTick({ deps: dS.deps });
  ok('after the max wait → stale-flush fires the understanding', sr2.ok && /understanding \(/.test(sr2.note) && /stale/.test(sr2.note));
  m.reset();

  console.log('\nend-of-video recap stored as retrievable memory:');
  m.start(YT); m.set('watching');
  db.setMeta('media_understanding_log', "The video explains how vaccines train the immune system.\nIt then covers booster timing.");
  const dR = mockDeps({ isPlaying: false, modelText: 'The video was an explainer on how vaccines train the immune system and why boosters matter.' });
  let surfacedRecap = '';
  let rr1 = await m.runTick({ deps: dR.deps });                                  // 1st miss
  let rr2 = await m.runTick({ deps: dR.deps, onReading: (c, l) => { if (/recap/i.test(l || '')) surfacedRecap = c; } });   // 2nd → done + recap
  ok('2nd miss → done + recap', !m.active() && /recap/.test(rr2.note));
  ok('recap stored as episodic memory (retrievable later)', dR.calls.stored.length === 1 && dR.calls.stored[0].opts.kind === 'episodic' && /vaccines/.test(dR.calls.stored[0].content));
  ok('recap framed as HER viewing', /I watched a video/.test(dR.calls.stored[0].content));
  ok('media_last_recap set for post-watch recall', /vaccines/.test(db.getMeta('media_last_recap')));
  m.reset();

  console.log('\ntexttrack source wins when it yields cues (cascade order):');
  m.start(YT); m.set('watching');
  const dTT = mockDeps({ captionsText: 'Discrete cue from a native track', via: 'texttrack' });
  r = await m.runTick({ deps: dTT.deps });
  ok('source via = texttrack', r.ok && r.via === 'texttrack' && /1 new caption/.test(r.note));
  m.reset();

  console.log('\nplayback-ended detection (frees the idle loop):');
  m.start(YT); m.set('watching');
  const dEnd = mockDeps({ isPlaying: false });
  r = await m.runTick({ deps: dEnd.deps });
  ok('1st miss stays watching', m.get() === 'watching' && /1\/2/.test(r.note));
  r = await m.runTick({ deps: dEnd.deps });
  ok('2nd miss → done + inactive (no loop monopoly)', !m.active() && /ended/.test(r.note));
  m.reset();

  console.log('\nlogin wall on open → asks to sign in (does not flail):');
  m.start(YT);
  const dLogin = mockDeps({ openResult: { ok: false, blocker: { type: 'login', needsHuman: true } } });
  let asked = null;
  r = await m.runTick({ deps: dLogin.deps, onSurface: (t) => { asked = t; } });
  ok('stays opening + asks to sign in', !r.ok && r.blocker === 'login' && m.get() === 'opening' && /log me in/i.test(asked || ''));
  m.reset();

  console.log('\nopen fails 3x → gives up (inactive):');
  m.start(YT);
  const dFail = mockDeps({ openResult: { ok: false, reason: 'nav timeout' } });
  let gaveUp = null;
  await m.runTick({ deps: dFail.deps, onSurface: t => { gaveUp = t; } });
  await m.runTick({ deps: dFail.deps, onSurface: t => { gaveUp = t; } });
  await m.runTick({ deps: dFail.deps, onSurface: t => { gaveUp = t; } });
  ok('after 3 fails → inactive + surfaced the failure', !m.active() && /couldn'?t open/i.test(gaveUp || ''));
  m.reset();

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  try { require('fs').rmSync(path.dirname(process.env.SQ_DB_PATH), { recursive: true, force: true }); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})();
