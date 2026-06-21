/**
 * Backtest — idle-research browser routing. A <browse>URL</browse> (opens in LUCAS's
 * Chrome) emitted during her OWN research is a misfire: splitIdleBrowserTags redirects
 * it to <web-open> (her own browser), while browse-read/click/scroll on his active tab
 * pass through unchanged.
 */
const { splitIdleBrowserTags } = require('../lib/monologue');
const browserLib = require('../lib/browser');
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } };

console.log('Backtest — idle browse-open redirect\n');

// browse-OPEN of a URL → redirected to her own browser as web-open
let r = splitIdleBrowserTags(browserLib.parseTags('<browse>https://substack.com</browse>'));
ok('browse open is NOT dispatched to Lucas\'s browser', r.browserTags.length === 0);
ok('browse open → web-open redirect', r.redirectedOpens.length === 1 && r.redirectedOpens[0].tag === 'web-open');
ok('redirect carries the URL', r.redirectedOpens[0].body === 'https://substack.com');

// browse open with search terms (no scheme) also redirects
r = splitIdleBrowserTags(browserLib.parseTags('<browse>maastricht treaty convergence criteria</browse>'));
ok('browse open with search terms redirects', r.redirectedOpens.length === 1 && r.redirectedOpens[0].body === 'maastricht treaty convergence criteria');

// browse-read on his active tab is legitimate → stays a browser tag
r = splitIdleBrowserTags(browserLib.parseTags('<browse-read/>'));
ok('browse-read passes through (glance at his tab)', r.browserTags.length === 1 && r.browserTags[0].tag === 'browse-read' && r.redirectedOpens.length === 0);

// browse-click / browse-scroll on his tab pass through
r = splitIdleBrowserTags(browserLib.parseTags('<browse-click>B0</browse-click> <browse-scroll>down 1</browse-scroll>'));
ok('browse-click + browse-scroll pass through', r.browserTags.length === 2 && r.redirectedOpens.length === 0);

// mixed: a browse open + a browse-read → split correctly
r = splitIdleBrowserTags(browserLib.parseTags('<browse>https://x.com</browse> <browse-read/>'));
ok('mixed splits: 1 redirect + 1 passthrough', r.redirectedOpens.length === 1 && r.browserTags.length === 1 && r.browserTags[0].tag === 'browse-read');

// empty / no browse open
ok('empty input → empty arrays', (() => { const x = splitIdleBrowserTags([]); return x.browserTags.length === 0 && x.redirectedOpens.length === 0; })());

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
