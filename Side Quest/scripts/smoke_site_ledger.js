/* Smoke: lib/site_ledger — the VISITED LEDGER + per-site DIGEST PLAN (hermetic, temp sq.db).
 * Proves: url normalization (hash/tracking-params/trailing-slash); record upserts + counts repeat
 * visits (the measurable 500-calls smell); shouldSkip honors the TTL and names the reuse; the plan
 * builds bounded from same-host links (already-read urls enter done), marks done, serves the next
 * pending, and narrates coverage; foreign-host links never enter a plan.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_site_ledger.js
 */
const path = require('path'), os = require('os');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_smoke_ledger_${process.pid}.db`);
const db = require('C:/Users/azrae/Desktop/Side Quest/lib/db');
const SL = require('C:/Users/azrae/Desktop/Side Quest/lib/site_ledger');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

(async () => {
  try {
    db.init();
    const T0 = 1000000000000;

    // --- normalization ---
    ok(SL.normalizeUrl('https://X.gov/a/?utm_source=t#frag') === 'https://x.gov/a/', 'normalize: hash + tracking params dropped, host lowercased');
    ok(SL.normalizeUrl('https://x.gov/') === 'https://x.gov', 'normalize: bare-root trailing slash dropped');
    ok(SL.hostOf('https://Sub.X.gov/p') === 'sub.x.gov', 'hostOf lowercases');

    // --- record + repeat counting ---
    ok(SL.record('https://x.gov/team#top', { kind: 'page', chars: 500, now: T0 }), 'record lands');
    SL.record('https://x.gov/team', { chars: 600, now: T0 + 1000 });
    const row = SL.seen('https://x.gov/team');
    ok(row && row.visits === 2 && row.chars === 600, 'repeat visit upserts — visits counts the waste');

    // --- shouldSkip: fresh → reuse; past TTL → go again ---
    const s1 = SL.shouldSkip('https://x.gov/team', { now: T0 + 60000 });
    ok(s1.skip && /read 2×/.test(s1.why), 'fresh capture → skip, naming the reuse');
    ok(!SL.shouldSkip('https://x.gov/team', { now: T0 + 1000 + SL.DEFAULT_TTL_MS + 1 }).skip, 'past the TTL → a re-fetch is earned');
    ok(!SL.shouldSkip('https://never.gov/x').skip, 'never seen → go');

    // --- the digest plan ---
    const plan = SL.buildPlan('https://x.gov/team', ['https://x.gov/about', 'https://x.gov/team', 'https://other.org/a', 'https://x.gov/contact'], { now: T0 });
    ok(plan && plan.urls.length === 3, 'plan: same-host links only (foreign host excluded)');
    ok(plan.urls.find((e) => e.url === 'https://x.gov/team').status === 'done', 'plan: an already-read url enters as done');
    ok(SL.nextPending('x.gov') === 'https://x.gov/about', 'nextPending serves the first unread page');
    ok(SL.markDone('x.gov', 'https://x.gov/about', { now: T0 + 2000 }), 'markDone lands');
    ok(/x\.gov: 2\/3 pages digested — still working/.test(SL.planLine('x.gov')), 'planLine NARRATES coverage (slowness explained, never silent)');
    SL.markDone('x.gov', 'https://x.gov/contact');
    ok(/3\/3 pages digested — complete/.test(SL.planLine('x.gov')), 'a finished plan says complete');

    // --- bounded ---
    const many = Array.from({ length: 60 }, (_, i) => `https://big.gov/p${i}`);
    const bp = SL.buildPlan('https://big.gov/index', many, { now: T0 });
    ok(bp.urls.length <= SL.PLAN_MAX_URLS, 'a plan is bounded — a checklist, never a full mirror');
  } catch (e) {
    fail++; console.error('  ✗ threw:', e.stack || e.message);
  }
  console.log(`\nPASS — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
