/**
 * Smoke test for detectActOnOpenPage (lib/intent.js) — fires when Lucas tells her to
 * look at / use / surf the open page or chat, so the chat path can deterministically
 * read her front tab instead of letting her refuse. Must not collide with the
 * open/search intent (detectWebIntent) or fire on non-browser requests.
 *
 * Run: $env:ELECTRON_RUN_AS_NODE=1; .\node_modules\.bin\electron.cmd scripts\smoke_act_on_page.js
 */
const { detectActOnOpenPage, detectWebIntent, detectPickCharacter, SEARCH_HOME } = require('../lib/intent');

let pass = 0, fail = 0;
const ok = (n, c, detail) => { if (c) { pass++; console.log(`  ✓ ${n}${detail ? ' — ' + detail : ''}`); } else { fail++; console.log(`  ✗ ${n}${detail ? ' — ' + detail : ''}`); } };

console.log('SHOULD fire (act on the open page/chat):');
for (const s of [
  'use the chat I opened for you',
  'look at the page',
  'surf the page a bit',
  'read the chat',
  'go look at the site',
  'talk to the bot',
  "what's on the page right now?",
  'interact with the chat',
  'scroll the page and tell me what you see'
]) ok(`fire: "${s.slice(0, 40)}"`, detectActOnOpenPage(s));

console.log('\nSHOULD NOT fire (no page/chat target, or unrelated):');
for (const s of [
  'look at this report I attached',
  "what's the weather today",
  'draft an email to the senator',
  'go play for a bit',
  'what do you think about permitting reform'
]) ok(`no-fire: "${s.slice(0, 40)}"`, !detectActOnOpenPage(s));

console.log('\ndetectPickCharacter — routes to the deterministic stepper:');
for (const s of ['pick a character to chat with', 'choose a character', 'chat with one', 'start a scene', 'find someone to talk to', 'pick one to chat', 'explore different characters', 'explore a character']) {
  ok(`pick: "${s.slice(0, 40)}"`, detectPickCharacter(s));
}
for (const s of ['what do you think about housing', 'pick a topic for the article', "let's chat about the bill"]) {
  ok(`no-pick: "${s.slice(0, 40)}"`, !detectPickCharacter(s));
}

console.log('\n"use web read" routes to READ, never to DuckDuckGo:');
for (const s of ['use web read', 'web read', 'web-read', 'read it', 'use the web to read this']) {
  ok(`read-routes: "${s}"`, detectActOnOpenPage(s));
  ok(`not ddg: "${s}"`, detectWebIntent(s) === null || !/duckduckgo/i.test(detectWebIntent(s).target || ''));
}
// UPDATED 2026-08-12 (wave-3 triage): the old assert pinned the BUG — "any verb+'browser' wiped her
// open page to the DDG home" (lib/intent.js's own header names it). A mere MENTION of the browser
// ("use the browser", "your browser is slow") must NOT navigate; only a TRUE fresh-open verb does.
ok('bare "use the browser" does NOT navigate (mention ≠ open — the wiped-page bug)', detectWebIntent('use the browser') == null);

console.log('\nNo collision with open/search intent (detectWebIntent owns those):');
for (const s of ['open crushon.ai', 'search for housing data', 'go to https://example.com']) {
  const wi = detectWebIntent(s);
  ok(`"${s.slice(0, 30)}" → web-intent handles it first`, !!wi, wi && wi.target);
}

console.log(`\n${fail === 0 ? 'ALL ACT-ON-PAGE TESTS OK' : 'SOME FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
