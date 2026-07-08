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

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
