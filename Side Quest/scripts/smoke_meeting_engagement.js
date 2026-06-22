/**
 * Hard smoke — meeting engagement + recall + universal search guard (the three live-witnessed
 * fixes). Offline; injected deps; real embedder only where needed.
 *  A) monologue.shouldSuppressSearch — the self-fragment guard now gates EVERY search path.
 *  B) directive capture → durable 'meeting_action' notes + recap preserves them verbatim
 *     (the "what did Tracy ask me to do" recall failure).
 *  C) modelFollowAlong is connection-seeking + grounded (she THINKS, not transcribes).
 */
const os = require('os'); const path = require('path');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_meeteng_${Date.now()}`, 'sq.db');
const db = require('../lib/db'); db.init();
const gmeet = require('../lib/gmeet');
const monologue = require('../lib/monologue');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } };

let CLOCK = 2_000_000;
const now = () => CLOCK;

(async () => {
  console.log('Hard smoke — meeting engagement / recall / search guard\n');

  console.log('[A] extractDirective — captures asks to Lucas/her, ignores chatter:');
  const E = gmeet.extractDirective;
  ok('the Tracy "make a column … Madeline and Lucas, can you guys" ask', !!E('you should look through it and make a column on the left and put a persons name against it Madeline and Lucas. Can you guys do that?'));
  ok('"I need you to send the agenda"', !!E('I need you to send the agenda to Russ'));
  ok('plain chatter (no ask) → null', E('yeah I think that makes a lot of sense honestly') === null);
  ok('greeting → null', E('Hey everyone, good to see you') === null);

  console.log('\n[A] shouldSuppressSearch — universal guard wiring (seeded thoughts):');
  db.insertMonologue({ content: 'I keep thinking the Coast Guard AI thing connects to the Salesforce work', model: 'm', type: 'thought' });
  db.insertMonologue({ content: 'The population was around 47,000 — but that is more about perspective than the numbers themselves', model: 'm', type: 'thought' });
  ok('self-fragment query suppressed (containment vs recent thought)', monologue.shouldSuppressSearch('the Coast Guard AI thing connects to the Salesforce work') === true);
  ok('the live #8175 leak is now caught (slice of her recent thought)', monologue.shouldSuppressSearch('that is more about perspective than the numbers themselves') === true);
  ok('first-person introspection suppressed', monologue.shouldSuppressSearch('how I could navigate it while still contributing to my work') === true);
  ok('clean world topic allowed', monologue.shouldSuppressSearch('Monroe Louisiana population') === false);

  // ---- gmeet harness for B + C ----
  const prompts = [];
  const calls = { leave: 0, stores: [] };
  function makeCtx(capScript, known) {
    let i = 0;
    return {
      onReading: () => {},
      userName: 'Lucas',
      deps: {
        web: {},
        MODEL: 'test',
        streamChat: async ({ messages, onToken }) => {
          const p = messages[0].content; prompts.push(p);
          if (/Write a tight recap/.test(p)) onToken('Recap. Action items: - Lucas & Madeline: make the name column.');
          else if (/sharp aide who THINKS/.test(p)) onToken('They assigned Madeline and Lucas to build a name column — connects to your LAMP speaker tracking.');
          else onToken('');
        },
        scrapeCaptions: async () => (i < capScript.length ? capScript[i++] : ''),
        scrapeAttendees: async () => '',
        enableCaptions: async () => ({ ok: true }),
        inMeeting: async () => true,
        leaveMeeting: async () => { calls.leave++; return { ok: true }; },
        storeMeeting: async (content, opts = {}) => { calls.stores.push({ content, kind: opts.kind || 'meeting' }); return 1; },
        preClear: async () => {},
        postChat: async () => ({ ok: true }),
        retrieve: async () => (known || []),
        webLookup: async () => '',
        now,
      },
    };
  }

  console.log('\n[C] follow-along is grounded + connection-seeking:');
  {
    const known = [{ content: 'The LA Policy Lab tracks speakers and their assigned roles.' }];
    const ctx = makeCtx([
      'Tracy Bromley: you should make a column on the left and put a persons name against it Madeline and Lucas. Can you guys do that?\nMadeline Keeter: Yep.\nLucas Overby: Sounds good.\nTracy Bromley: okay that is all for today, thanks everyone, bye.',
      ''
    ], known);
    gmeet.start('https://meet.google.com/vud-sptv-wbh');
    gmeet.set('observing');
    db.setMeta('gmeet_last_caption_at', String(CLOCK));
    CLOCK += 5000;
    await gmeet.runTick(ctx);
    const folPrompt = prompts.find(p => /sharp aide who THINKS/.test(p));
    ok('follow-along prompt asks her to THINK + connect', !!folPrompt && /How it connects|connect/i.test(folPrompt));
    ok('follow-along prompt was grounded with her knowledge', !!folPrompt && /LA Policy Lab tracks speakers/.test(folPrompt));

    console.log('\n[B] directive captured during observing:');
    const dirs = JSON.parse(db.getMeta('gmeet_directives') || '[]');
    ok('the Tracy column-assignment ask was captured', dirs.some(d => /make a column/.test(d) && /Tracy/.test(d)));
    ok('chatter was NOT captured as a directive', !dirs.some(d => /thanks everyone/.test(d)));

    console.log('\n[B] exit → directive stored durably + preserved in recap:');
    CLOCK += 95000;
    const r2 = await gmeet.runTick(ctx);
    ok('left + done', gmeet.get() === 'done' && calls.leave === 1);
    ok('directive stored as its own durable meeting_action note', calls.stores.some(s => s.kind === 'meeting_action' && /make a column/.test(s.content)));
    ok('recap also stored (kind meeting)', calls.stores.some(s => s.kind === 'meeting'));
    const recapPrompt = prompts.find(p => /Write a tight recap/.test(p));
    ok('recap prompt force-includes the assigned task verbatim', !!recapPrompt && /Tasks explicitly assigned/.test(recapPrompt) && /make a column/.test(recapPrompt));
  }

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  try { require('fs').rmSync(path.dirname(process.env.SQ_DB_PATH), { recursive: true, force: true }); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})();
