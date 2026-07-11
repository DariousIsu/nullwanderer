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
ok('plain words → search', /google\.com\/search/.test(web.toUrl('how to write a cold pitch')));
ok('empty → null', web.toUrl('') === null);

console.log('\ncleanQuery (strip prepended engine/verb + quotes):');
ok('Google "phrase" → clean phrase', web.cleanQuery('Google "best practices for sending professional emails 2024"') === 'best practices for sending professional emails 2024');
ok('search for X → X', web.cleanQuery('search for rainey center summit') === 'rainey center summit');
ok('look up X → X', web.cleanQuery('look up the maastricht treaty') === 'the maastricht treaty');
ok('plain query unchanged', web.cleanQuery('latest AI policy news') === 'latest AI policy news');
ok('toUrl search drops the Google verb + quotes from the query', (() => { const u = web.toUrl('Google "AI email tips"'); const q = decodeURIComponent((u.match(/[?&]q=([^&]+)/) || [])[1] || ''); return q === 'AI email tips'; })());

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

console.log('\nmanipulation suite — parse (attrs + body):');
ok('web-press key body + selector attr', (() => { const t = web.parseTags('<web-press selector="I0">Enter</web-press>')[0]; return t.tag === 'web-press' && t.attrs.selector === 'I0' && t.body === 'Enter'; })());
ok('web-click-text (before web-click in alternation)', web.parseTags('<web-click-text>Sign in</web-click-text>')[0]?.tag === 'web-click-text');
ok('web-click-xy coordinate attrs', (() => { const t = web.parseTags('<web-click-xy x="120" y="340"/>')[0]; return t.tag === 'web-click-xy' && t.attrs.x === '120' && t.attrs.y === '340'; })());
ok('web-select value body', (() => { const t = web.parseTags('<web-select selector="I1">Beta</web-select>')[0]; return t.tag === 'web-select' && t.body === 'Beta'; })());
ok('web-check / web-uncheck distinct', web.parseTags('<web-check>I2</web-check><web-uncheck>I2</web-uncheck>').map(t => t.tag).join(',') === 'web-check,web-uncheck');
ok('web-upload path body', web.parseTags('<web-upload selector="I3">C:\\a\\b.pdf</web-upload>')[0]?.attrs.selector === 'I3');
ok('web-drag from/to attrs', (() => { const t = web.parseTags('<web-drag from="L1" to="L5"/>')[0]; return t.attrs.from === 'L1' && t.attrs.to === 'L5'; })());
ok('web-eval expression body', web.parseTags('<web-eval>document.title</web-eval>')[0]?.body === 'document.title');
ok('web-get selector+attr', (() => { const t = web.parseTags('<web-get selector="a.h" attr="href"/>')[0]; return t.attrs.selector === 'a.h' && t.attrs.attr === 'href'; })());
ok('web-tab-switch index body', web.parseTags('<web-tab-switch>2</web-tab-switch>')[0]?.body === '2');
ok('web-wait ms body', web.parseTags('<web-wait>2000</web-wait>')[0]?.body === '2000');
ok('web-dialog action body', web.parseTags('<web-dialog>accept</web-dialog>')[0]?.body === 'accept');
ok('web-grab-pdfs self-closing', web.parseTags('<web-grab-pdfs/>')[0]?.tag === 'web-grab-pdfs');
ok('isPdfUrl detects .pdf (+query)', web.isPdfUrl('https://x.org/a/b.pdf?y=1') === true && web.isPdfUrl('https://x.org/page') === false);

console.log('\nstripTags + dispatch routing:');
ok('stripTags removes tags + collapses ws', web.stripTags('a <web-read/> b') === 'a b');
(async () => {
  const r = await web.dispatch({ tag: 'web-bogus' });
  ok('unknown tag → ok:false', r.ok === false);
  ok('click with no page → graceful', (await web.dispatch({ tag: 'web-click', body: 'L1' })).ok === false);
  ok('scroll with no page → graceful', (await web.dispatch({ tag: 'web-scroll', body: 'down' })).ok === false);
  ok('deepen with no page → graceful', (await web.dispatch({ tag: 'web-deepen' })).ok === false);

  // every new tag must route to a REAL handler (a "no page open"-style ok:false), never the
  // "unknown web tag" default — that's the regression guard for the full suite's wiring.
  const suite = ['web-press','web-clear','web-hover','web-select','web-check','web-uncheck','web-upload',
    'web-submit','web-click-text','web-click-xy','web-forward','web-reload','web-tab-new','web-tab-list',
    'web-tab-switch','web-tab-close','web-wait','web-dialog','web-get','web-eval','web-drag','web-grab-pdfs'];
  let routed = 0, unknown = [];
  for (const tag of suite) {
    const rr = await web.dispatch({ tag, attrs: {}, body: '' });
    if (rr && typeof rr.reason === 'string' && /^unknown web tag/.test(rr.reason)) unknown.push(tag); else routed++;
  }
  ok(`all ${suite.length} manipulation tags route to a real handler`, unknown.length === 0);
  if (unknown.length) console.log('    UNROUTED: ' + unknown.join(', '));

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
