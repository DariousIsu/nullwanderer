/**
 * Hard smoke — M2: per-turn quiet|research|contribute|connect + governed in-meeting research.
 * Quiet preferred for the chat; research is HEADLESS (webLookup, never her meeting tab),
 * rate-limited + deduped; contribute posts; connect surfaces an association. Offline; injected deps.
 */
const os = require('os'); const path = require('path');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_mr_${Date.now()}`, 'sq.db');
const db = require('../lib/db'); db.init();
const gmeet = require('../lib/gmeet');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } };

let CLOCK = 4_000_000;
const now = () => CLOCK;

function harness() {
  const capQueue = [], decQueue = [];
  const spy = { webLookups: [], stores: [], posts: [], surfaced: [] };
  const ctx = {
    onReading: (c, l) => spy.surfaced.push({ c, l }),
    userName: 'Lucas',
    deps: {
      web: {}, MODEL: 'test',
      streamChat: async ({ onToken }) => onToken(decQueue.length ? decQueue.shift() : 'idle.\nACTION: QUIET'),
      scrapeCaptions: async () => (capQueue.length ? capQueue.shift() : ''),
      scrapeAttendees: async () => '', enableCaptions: async () => ({ ok: true }),
      inMeeting: async () => true, leaveMeeting: async () => ({ ok: true }),
      storeMeeting: async (content, opts = {}) => { spy.stores.push({ kind: opts.kind || 'meeting', source: opts.source, content }); return 1; },
      preClear: async () => {}, postChat: async (web, msg) => { spy.posts.push(msg); return { ok: true }; },
      retrieve: async () => [], webLookup: async (q) => { spy.webLookups.push(q); return `Top results about ${q}.`; }, now,
    },
  };
  const begin = () => { gmeet.start('https://meet.google.com/abc-defg-hij'); gmeet.set('observing'); db.setMeta('gmeet_last_caption_at', String(CLOCK)); };
  return { capQueue, decQueue, spy, ctx, begin };
}
const FOUR = (tag) => `Tom: line one ${tag}\nTracy: line two ${tag}\nTom: line three ${tag}\nTracy: line four ${tag}`;

(async () => {
  console.log('Hard smoke — M2 per-turn decision + governed research\n');

  console.log('parseMeetingAction (pure):');
  const P = gmeet.parseMeetingAction;
  ok('QUIET', P('reads as scheduling chatter.\nACTION: QUIET').action.kind === 'quiet');
  ok('RESEARCH carries topic', (() => { const r = P('on the FERC rule.\nACTION: RESEARCH: FERC data center rule'); return r.action.kind === 'research' && /FERC data center rule/.test(r.action.payload); })());
  ok('CONTRIBUTE carries message', (() => { const r = P('they need the number.\nACTION: CONTRIBUTE: It is $4,000.'); return r.action.kind === 'contribute' && /\$4,000/.test(r.action.payload); })());
  ok('CONNECT carries link', P('x.\nACTION: CONNECT: ties to LAMP work').action.kind === 'connect');
  ok('understanding is separated from the action line', !/ACTION:/.test(P('the team is scheduling.\nACTION: QUIET').understanding));
  ok('no ACTION line → quiet', P('just a plain note with no action').action.kind === 'quiet');
  ok('empty payload → quiet (not a blank research)', P('x.\nACTION: RESEARCH:').action.kind === 'quiet');

  console.log('\nRESEARCH dispatch + governance (headless, rate-limited, deduped):');
  {
    const h = harness();
    h.begin();
    h.capQueue.push(FOUR('a'), FOUR('b'), FOUR('c'));
    h.decQueue.push('FERC rule discussed.\nACTION: RESEARCH: FERC data center interconnection rule',
                    'now the timeline.\nACTION: RESEARCH: NEPA permitting timeline',
                    'back to FERC.\nACTION: RESEARCH: FERC data center interconnection rule');
    CLOCK += 5000; await gmeet.runTick(h.ctx);                       // research A → runs
    CLOCK += 5000; await gmeet.runTick(h.ctx);                       // research B → within 30s gap → skip
    CLOCK += 40000; await gmeet.runTick(h.ctx);                      // research A again → deduped → skip
    ok('headless webLookup used (not her meeting browser)', h.spy.webLookups.length === 1);
    ok('researched the first topic', /FERC data center/.test(h.spy.webLookups[0]));
    ok('2nd research within the gap was rate-limited', !h.spy.webLookups.includes('NEPA permitting timeline'));
    ok('repeat topic deduped', h.spy.webLookups.filter(x => /FERC data center/.test(x)).length === 1);
    ok('finding stored as a durable meeting_research note', h.spy.stores.some(s => s.source === 'meeting_research'));
    ok('surfaced "I looked into …" (visible work)', h.spy.surfaced.some(s => /I looked into/.test(s.c)));
  }

  console.log('\nCONTRIBUTE / CONNECT / QUIET:');
  {
    // UPDATED 2026-08-12 (wave-3 triage): CONTRIBUTE is gated by THE CHAT DOOR (meetChatOpen —
    // ZOE_MEET_CHAT, default OFF), same as the addressed-reply path. The old asserts pinned the
    // pre-door always-posts world. Door opened for this block; closed back after.
    process.env.ZOE_MEET_CHAT = 'on';
    const h = harness(); h.begin();
    h.capQueue.push(FOUR('q1')); h.decQueue.push('they asked for the figure.\nACTION: CONTRIBUTE: The ballroom is $4,000 non-refundable.');
    CLOCK += 5000; await gmeet.runTick(h.ctx);
    ok('CONTRIBUTE posts to chat (door open)', h.spy.posts.some(m => /\$4,000/.test(m)));
    ok('CONTRIBUTE surfaced', h.spy.surfaced.some(s => /spoke up/.test(s.c)));
    delete process.env.ZOE_MEET_CHAT;
  }
  {
    const h = harness(); h.begin();
    h.capQueue.push(FOUR('q2')); h.decQueue.push('this overlaps my work.\nACTION: CONNECT: ties to the LAMP speaker-tracking work.');
    CLOCK += 5000; await gmeet.runTick(h.ctx);
    ok('CONNECT surfaces an association, posts nothing', h.spy.posts.length === 0 && h.spy.surfaced.some(s => /Connecting the meeting/.test(s.c)));
    ok('CONNECT does not web-search', h.spy.webLookups.length === 0);
  }
  {
    const h = harness(); h.begin();
    h.capQueue.push(FOUR('q3')); h.decQueue.push('routine scheduling.\nACTION: QUIET');
    CLOCK += 5000; await gmeet.runTick(h.ctx);
    ok('QUIET: no post, no search', h.spy.posts.length === 0 && h.spy.webLookups.length === 0);
    ok('QUIET still forms+surfaces understanding', h.spy.surfaced.some(s => /following the meeting/.test(s.c)));
  }

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  try { require('fs').rmSync(path.dirname(process.env.SQ_DB_PATH), { recursive: true, force: true }); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})();
