/* Smoke: lib/leakguard — keep injected directives out of BOTH the final text and the live token stream.
 * Pure. Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_leakguard.js
 */
'use strict';
const lg = require('../lib/leakguard');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// --- isLeakyDirective ---
ok(lg.isLeakyDirective('[ANSWER TO GIVE Lucas — say this]'), 'ANSWER TO GIVE → leaky');
ok(lg.isLeakyDirective('[DELIVER THIS TO Lucas — the complete result]'), 'DELIVER THIS → leaky');
ok(lg.isLeakyDirective('[Lucas asked for the list (15 organizations on file). Put it on the Canvas or here.]'), 'canvas-ask directive → leaky');
ok(lg.isLeakyDirective('[YOU HAVE ACCEPTED THIS AS A STANDING TASK]'), 'ACCEPTED standing task → leaky');
ok(!lg.isLeakyDirective('[1]'), 'a footnote marker [1] → not leaky');
ok(!lg.isLeakyDirective('[see notes]'), 'a short aside → not leaky');
ok(!lg.isLeakyDirective('[link](url)'.match(/\[[^\]]*\]/)[0]), 'a markdown link label → not leaky');

// --- final-text strip: the exact live leak reduces to clean ---
const leaked = `[ANSWER TO GIVE Lucas — this is the accurate, grounded answer. Say THIS in your own voice:
The grounding shows the user previously asked for lists of center right think tanks.]

[Lucas asked for the list (15 organizations on file). You can show it here in chat OR display the full thing on your Canvas. Ask him in ONE short line. Do NOT recite the list yet.]`;
const stripped = lg.stripLeakedDirectives(leaked);
ok(!/ANSWER TO GIVE|Lucas asked for|Canvas|grounding shows/.test(stripped), 'final-text strip removes the leaked directives entirely');

// stacked/unterminated (no closing ]) still caught
const stacked = '[DELIVER THIS TO Lucas — keep EVERY item:\n- a\n[ANSWER TO GIVE Lucas]\nreal answer\n[YOU HAVE ACCEPTED THIS AS A STANDING TASK]';
ok(!/DELIVER THIS|ANSWER TO GIVE|ACCEPTED/.test(lg.stripLeakedDirectives(stacked)), 'stacked/unterminated directives stripped');

// model-hallucinated reply scaffold (the live 2026-06-30 leak): echoed instruction + [YOUR REPLY] marker
const scaffold = lg.stripLeakedDirectives('explore how music trends reflect cultural shifts [YOUR REPLY] Got it Lucas, no more work talk.');
ok(/^Got it Lucas/.test(scaffold) && !/YOUR REPLY|explore how music/.test(scaffold), 'leading [YOUR REPLY] scaffold + echoed prefix stripped, real reply kept');
ok(lg.isLeakyDirective('[YOUR REPLY]'), '[YOUR REPLY] marker is a leaky directive (stream suppresses it)');

// legit content survives
ok(lg.stripLeakedDirectives('Here are 3 orgs: Heritage, Cato, AEI. [1]') === 'Here are 3 orgs: Heritage, Cato, AEI. [1]', 'legit prose + footnote survives');

// --- STREAM filter: feed the leak token-by-token, the UI must never see a directive ---
function streamThrough(text, chunk = 7) {
  let out = '';
  const f = lg.makeStreamFilter((s) => { out += s; });
  for (let i = 0; i < text.length; i += chunk) f.feed(text.slice(i, i + chunk));
  f.flush();
  return out;
}
const liveOut = streamThrough('On it — ' + leaked);
ok(/On it —/.test(liveOut), 'stream filter passes the real reply through');
ok(!/ANSWER TO GIVE|Lucas asked for|Canvas|grounding shows/.test(liveOut), 'stream filter suppresses directives live (token-by-token)');
ok(streamThrough('See [1] and [2] for refs.') === 'See [1] and [2] for refs.', 'stream filter keeps short legit brackets');
ok(streamThrough('A markdown [link](http://x) here.') === 'A markdown [link](http://x) here.', 'stream filter keeps markdown links');
// unterminated non-directive bracket flushes through
ok(/an open bracket \[oops/.test(streamThrough('an open bracket [oops')), 'unterminated non-directive bracket flushed on close');

// --- STREAM filter: internal/tool TAGS suppressed live; genuine '<' content preserved ---
ok(streamThrough('Here it is: <think>he wants the short version</think>done.').indexOf('<think') === -1, 'live <think> tag suppressed in the stream (the thought-flash)');
const toolStream = streamThrough('Opening it <web-open>https://x.com</web-open> now');
ok(!/<\/?web-open>/.test(toolStream) && /Opening it/.test(toolStream) && /now/.test(toolStream), 'live tool tag MARKERS suppressed (<web-open>…</web-open>)');
ok(streamThrough('a bare <thought fragment cut off', 5).indexOf('<thought') === -1, 'truncated internal tag <thought… dropped on flush (no leak)');
ok(streamThrough('the value 3 < 5 holds and a < b too') === 'the value 3 < 5 holds and a < b too', 'literal "<" ("3 < 5", "a < b") passes through untouched');
ok(streamThrough('render a <div class="x">block</div> here') === 'render a <div class="x">block</div> here', 'a NON-internal tag (<div>) is preserved verbatim (not eaten)');
const mixStream = streamThrough('mix [YOUR REPLY] and <say>hello there</say>');
ok(!/YOUR REPLY|<\/?say>/.test(mixStream) && /hello there/.test(mixStream) && /mix/.test(mixStream), 'directives AND internal tags both stripped, say-interior kept');
ok(lg._INTERNAL_TAG_RE.test('<think>') && lg._INTERNAL_TAG_RE.test('</web-open>') && !lg._INTERNAL_TAG_RE.test('<div>'), '_INTERNAL_TAG_RE: internal/tool tags match, <div> does not');

// --- ⭐ THE FILTER AND THE REAL TAG VOCABULARY MUST NOT DRIFT ---
// Live 2026-07-20, Lucas saw this in his chat window:
//     "<read-inbox/> Got it—I'll keep the Hawaii county board update in mind…"
// The patterns match a tag's FIRST word, so `inbox[\w-]*` never matched `read-inbox` — the tag
// begins with "read". Six of main.js's thirty-four tags were leaking, all compounds whose first word
// is the VERB (observe-screen, read-inbox, notify, clipboard-read/write, chat-send) while the
// patterns were written around the nouns.
//
// The list is read from main.js's own _hasToolTag regex rather than restated here, so adding a tag
// there without teaching the filter fails HERE instead of on Lucas's screen.
{
  const fs = require('fs'), path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const m = src.match(/const _hasToolTag = \/<\(([^)]+)\)/);
  ok(!!m, 'found main.js _hasToolTag — the authoritative tag vocabulary');
  if (m) {
    const tags = m[1].split('|').map((s) => s.trim()).filter(Boolean);
    ok(tags.length >= 20, `read ${tags.length} tags from main.js (sanity: the list is real)`);
    const leaking = tags.filter((t) => !lg._INTERNAL_TAG_RE.test(`<${t}/>`));
    ok(leaking.length === 0, `NO tag leaks to the screen — leaking: ${leaking.join(', ') || 'none'}`);
    for (const t of ['read-inbox', 'observe-screen', 'notify', 'clipboard-read', 'clipboard-write', 'chat-send']) {
      ok(lg._INTERNAL_TAG_RE.test(`<${t}/>`), `REGRESSION: <${t}/> is held back (it leaked live)`);
    }
  }
  // …and widening must not start eating genuine content.
  for (const c of ['<div>', '<p class="x">', '<span>', '<code>', '<b>', '<Table>']) {
    ok(!lg._INTERNAL_TAG_RE.test(c), `genuine markup ${c} still passes through`);
  }
  ok(streamThrough('read the docs at <div>x</div>') === 'read the docs at <div>x</div>',
    'a word starting with "read" outside a tag is untouched');
}

// --- deliveryPromise (Slice P3, the parish-canvas fiction) ---
{
  const LIVE = 'Glad the canvas looks good—I\'ll keep adding the Louisiana parish contacts there as we collect them.';
  const d1 = lg.deliveryPromise(LIVE);
  ok(d1 && /louisiana parish contacts/i.test(d1.topic), `the LIVE parish promise lands, topic="${d1 && d1.topic}"`);
  ok(lg.deliveryPromise('I\'ll compile the clerk roster into a tracker document for you.') != null,
    'a compile-into-document promise lands');
  ok(lg.deliveryPromise('I\'ll keep adding detail as I learn more.') === null,
    'no artifact surface named anywhere → not a delivery promise');
  ok(lg.deliveryPromise('Should I keep adding the parish contacts to the canvas?') === null,
    'a question is not a commitment');
  ok(lg.deliveryPromise('The canvas already holds the parish contacts you asked about.') === null,
    'a status statement without a commitment verb stays silent');
  ok(lg.deliveryPromise('I\'m pulling the source that records when the strait closed.') === null,
    'a retrieval promise stays the LOOKUP net\'s (no artifact surface)');

  // THE DEICTIC MISS — why the net fired 0x live. The artifact (canvas) was named a PRIOR turn; the
  // promise refers to it by pronoun ("there"), so the old literal-word-only test in the SAY missed it.
  const DEICTIC = 'I\'ll keep adding the Louisiana parish contacts there as we collect them.';
  ok(lg.deliveryPromise(DEICTIC) === null,
    'deictic promise with NO context → still null (a bare "there" can\'t manufacture a promise tab)');
  const d2 = lg.deliveryPromise(DEICTIC, { context: 'The canvas is perfect for the parish work.' });
  ok(d2 && /louisiana parish contacts/i.test(d2.topic),
    `deictic "there" + context that names the canvas → lands, topic="${d2 && d2.topic}"`);
  ok(lg.deliveryPromise('I\'ll meet you there at noon.', { context: 'the canvas has the docs' }) === null,
    'a non-delivery "there" (no add/put/compile verb) never fires, even with an artifact in context');
  ok(lg.deliveryPromise('I\'ll keep adding them there.', { context: 'no artifact mentioned at all here' }) === null,
    'deictic + context WITHOUT an artifact word → still null (context must actually name one)');
}

// --- isConductAcknowledgment (2026-07-25 live fail) ---------------------------------------------
{
  // THE LIVE LEAK, verbatim: reply to "I need to take Alice to the gym for strength training day".
  const LEAK = "Got it. I'll skip the 'I wasn't able…' line, keep things concise, and stop ending replies with a question. I'll stick to my own voice moving forward.";
  ok(lg.isConductAcknowledgment(LEAK), 'THE LIVE LEAK is caught (4 conduct signals, leads with "Got it")');

  // Other real shapes of the same failure
  ok(lg.isConductAcknowledgment("Understood — I'll vary my phrasing and stop reflecting your words back."),
    'variation + reflect-back recital caught');
  ok(lg.isConductAcknowledgment("I'll keep it concise and won't end on a question this time."),
    'leading commitment + concise + question-habit caught');
  ok(lg.isConductAcknowledgment("Noted. Going forward I'll drop the disclaimers and be less wordy."),
    'disclaimer + length recital caught');

  // ⚠️ FALSE-POSITIVE GUARDS — a real reply must NEVER be eaten
  ok(!lg.isConductAcknowledgment('Got it — how did Alice do at her last session?'),
    'an acknowledgment that then ENGAGES the topic is not a recital (0 conduct signals)');
  ok(!lg.isConductAcknowledgment("I'll keep it concise: Heritage, Cato, and AEI."),
    'one conduct word beside a real answer → NOT flagged (needs >=2 signals)');
  ok(!lg.isConductAcknowledgment("I'll pull the Iowa numbers now."),
    'a real action commitment with no conduct vocabulary → not flagged');
  ok(!lg.isConductAcknowledgment("Sure, that's a fascinating question about the voice actors in that film."),
    'topic words that brush "voice"/"question" without being about HER conduct → not flagged');
  ok(!lg.isConductAcknowledgment("Nice, strength day. Hope the session goes well and you both enjoy it."),
    'a warm, on-topic reply (the RIGHT answer) is untouched');
  ok(!lg.isConductAcknowledgment(''), 'empty → false');
  ok(!lg.isConductAcknowledgment('x'.repeat(500)), 'a long substantive reply is never a recital');

  // isStyleFeedback — when LUCAS asks for the change, the ack is appropriate (Slice 2 won't recover)
  ok(lg.isStyleFeedback("you're ending every reply with a question — stop that"),
    'an explicit style request from Lucas is recognised');
  ok(lg.isStyleFeedback('please be less wordy'), 'imperative style request recognised');
  ok(!lg.isStyleFeedback('I need to take Alice to the gym for strength training day'),
    'the ambient personal share is NOT a style request → a conduct ack to it IS a leak');
  ok(!lg.isStyleFeedback('what do you know about my kids?'), 'a normal question is not a style request');
}

// isUnkeptPromiseSay — the double-relay fix (08-08 audit defect 3): a verify-INVITATION about
// delivered work must NOT read as a pending promise, or the followup driver re-fires on the door
// relay's own closing line and Lucas gets two near-identical relays.
{
  ok(lg.isUnkeptPromiseSay('Fetching the latest reports now...'), 'a real promise-say still detects');
  ok(lg.isUnkeptPromiseSay('One moment — pulling that up'), 'one-moment promise still detects');
  ok(!lg.isUnkeptPromiseSay('The parish list is on your canvas — take a look.'),
    '"take a look" (delivered-work invitation) is NOT an unkept promise');
  ok(!lg.isUnkeptPromiseSay('It landed on the canvas, check it out.'), '"check it out" is an invitation, not a promise');
  ok(!lg.isUnkeptPromiseSay('Have a look at the table when you get a chance.'), '"have a look" is an invitation');
  ok(lg.isUnkeptPromiseSay('Checking the records...'), 'bare "checking..." (her own pending work) still detects');
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
