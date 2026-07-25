/* Smoke: the RE-SPIN BRAKE (lib/web respinHit / _cacheReading) — an autonomous re-open of a page
 * read within the window is served from cache with no fetch; chat opens are never braked; the window
 * expires; the cache is LRU-bounded; tracking-param variants collapse to one URL.
 * Pure (Map + site_ledger.normalizeUrl) — no browser.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_respin.js
 */
'use strict';
const web = require('../lib/web');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

const T0 = 1_000_000_000_000;
const W = web.RESPIN_WINDOW_MS;
web._recentReads.clear();

// --- a read is cached, and an AUTONOMOUS re-open within the window hits it ---
web._cacheReading('https://alamosa.gov/', 'Alamosa', 'the council roster text', T0);
ok(!!web.respinHit('https://alamosa.gov/', { autonomous: true, now: T0 + 60_000 }),
  'autonomous re-open 1m later → cache HIT (no re-fetch)');
const hit = web.respinHit('https://alamosa.gov/', { autonomous: true, now: T0 + 60_000 });
ok(hit && hit.text === 'the council roster text', 'the hit carries the cached reading back to the caller');

// --- chat opens are NEVER braked (a human ask always navigates) ---
ok(web.respinHit('https://alamosa.gov/', { autonomous: false, now: T0 + 60_000 }) === null,
  'chat / un-flagged open (autonomous:false) → null, always navigates');

// --- the window is SHORT: a genuine later return re-fetches ---
ok(web.respinHit('https://alamosa.gov/', { autonomous: true, now: T0 + W + 1 }) === null,
  'past the window → miss (a later visit for another answer still fetches)');

// --- tracking-param variants collapse (normalizeUrl) so ?ref= doesn't defeat the brake ---
ok(!!web.respinHit('https://alamosa.gov/?utm_source=x', { autonomous: true, now: T0 + 60_000 }),
  'a tracking-param variant of the same page is the same cache entry');

// --- a genuinely different URL misses ---
ok(web.respinHit('https://alamosa.gov/departments', { autonomous: true, now: T0 + 60_000 }) === null,
  'a different path is a distinct page (miss)');

// --- empty / junk never caches or throws ---
web._cacheReading('https://x.gov/', 'x', '   ', T0);
ok(web.respinHit('https://x.gov/', { autonomous: true, now: T0 }) === null, 'an empty-body read is not cached');
ok(web.respinHit('not a url', { autonomous: true }) === null, 'a junk target → null, no throw');

// --- LRU bound holds (never grows without limit) ---
web._recentReads.clear();
for (let i = 0; i < 350; i++) web._cacheReading(`https://h${i}.gov/`, 't', `body ${i}`, T0 + i);
ok(web._recentReads.size <= 300, `cache is LRU-bounded (size ${web._recentReads.size} <= 300)`);
ok(web.respinHit('https://h0.gov/', { autonomous: true, now: T0 }) === null, 'the oldest entry was evicted');
ok(!!web.respinHit('https://h349.gov/', { autonomous: true, now: T0 + 349 }), 'the newest entry survives');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
