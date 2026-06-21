/**
 * Backtest — Zoe's dedicated browser, PARSE layer (offline, no launch).
 * URL/search routing, tag parsing (all forms), strip, dispatch routing.
 * The live automation is exercised by scripts/web_live.js.
 */
const web = require('../lib/web');
let pass = 0, fail = 0;
function ok(n, c) { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } }

console.log('Backtest — web.js parse layer\n');

console.log('toUrl (URL vs search):');
ok('full URL passes through', web.toUrl('https://example.com/x') === 'https://example.com/x');
ok('bare domain → https', web.toUrl('example.com') === 'https://example.com');
ok('plain words → search', /duckduckgo\.com\/html/.test(web.toUrl('how to write a cold pitch')));
ok('empty → null', web.toUrl('') === null);

console.log('\ncleanQuery (strip prepended engine/verb + quotes):');
ok('Google "phrase" → clean phrase', web.cleanQuery('Google "best practices for sending professional emails 2024"') === 'best practices for sending professional emails 2024');
ok('search for X → X', web.cleanQuery('search for rainey center summit') === 'rainey center summit');
ok('look up X → X', web.cleanQuery('look up the maastricht treaty') === 'the maastricht treaty');
ok('plain query unchanged', web.cleanQuery('latest AI policy news') === 'latest AI policy news');
ok('toUrl search drops Google+quotes', (() => { const u = web.toUrl('Google "AI email tips"'); return !/Google/i.test(u) && /AI%20email%20tips/.test(u); })());

console.log('\nparseTags (all forms):');
ok('web-open with body', web.parseTags('<web-open>example.com</web-open>')[0]?.tag === 'web-open');
ok('web-read self-closing', web.parseTags('<web-read/>')[0]?.tag === 'web-read');
ok('web-click body handle', web.parseTags('<web-click>L3</web-click>')[0]?.body === 'L3');
ok('web-type selector attr', (() => { const t = web.parseTags('<web-type selector="I0">hi</web-type>')[0]; return t.attrs.selector === 'I0' && t.body === 'hi'; })());
ok('web-back self-closing', web.parseTags('<web-back/>')[0]?.tag === 'web-back');
ok('web-deepen self-closing', web.parseTags('<web-deepen/>')[0]?.tag === 'web-deepen');
ok('web-scroll self-closing', web.parseTags('<web-scroll/>')[0]?.tag === 'web-scroll');
ok('web-scroll with dir body', (() => { const t = web.parseTags('<web-scroll>up</web-scroll>')[0]; return t.tag === 'web-scroll' && t.body === 'up'; })());
ok('multiple tags parsed', web.parseTags('<web-open>x.com</web-open> then <web-read/>').length === 2);

console.log('\nstripTags + dispatch routing:');
ok('stripTags removes tags + collapses ws', web.stripTags('a <web-read/> b') === 'a b');
(async () => {
  const r = await web.dispatch({ tag: 'web-bogus' });
  ok('unknown tag → ok:false', r.ok === false);
  ok('click with no page → graceful', (await web.dispatch({ tag: 'web-click', body: 'L1' })).ok === false);
  ok('scroll with no page → graceful', (await web.dispatch({ tag: 'web-scroll', body: 'down' })).ok === false);
  ok('deepen with no page → graceful', (await web.dispatch({ tag: 'web-deepen' })).ok === false);
  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
