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

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
