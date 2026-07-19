/* scripts/route_health.js — read the route observation log and report what is BREAKING.
 *
 * The observation log (lib/route_obs.js, slice P0) exists to derive retrieval routes, but its first
 * live run turned up something more immediately useful: a call site that had been failing 100% of
 * the time, silently, because its caller swallowed the error (resolvePlaces sent `limit` to
 * search_entities, which only accepts `top_k` — 628 failures in 30 minutes, nobody noticed).
 *
 * This report makes that class of bug findable on demand instead of by luck. It groups by
 * (tool, arg_shape) rather than by tool alone, because THAT is the pairing that isolates a broken
 * caller: the same tool usually succeeds from a correct call site and fails from a broken one, so
 * a per-tool error rate averages the signal away while a per-shape rate points straight at it.
 *
 * Usage: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron.cmd scripts/route_health.js [hours]
 * Read-only. Never modifies the log.
 */
'use strict';
process.chdir(require('path').join(__dirname, '..'));
const db = require('../lib/db');

const HOURS = Number(process.argv[2]) || 24;
const MIN_N = 3;   // below this, an error rate is noise, not a pattern

db.init();
const d = db.getDb();
const since = Date.now() - HOURS * 3600 * 1000;

const total = d.prepare('SELECT COUNT(*) n FROM route_obs WHERE ts > ?').get(since).n;
if (!total) {
  console.log(`No observations in the last ${HOURS}h. Is route.obs enabled? (meta route.obs=1)`);
  process.exit(0);
}

const span = d.prepare('SELECT MIN(ts) a, MAX(ts) b FROM route_obs WHERE ts > ?').get(since);
const mins = Math.max(1, Math.round((span.b - span.a) / 60000));
console.log(`\nROUTE HEALTH — ${total} observations over ${mins} min (last ${HOURS}h)\n${'='.repeat(78)}`);

const mix = d.prepare(`SELECT outcome, COUNT(*) n FROM route_obs WHERE ts > ? GROUP BY outcome`).all(since);
const by = Object.fromEntries(mix.map(r => [r.outcome, r.n]));
const pct = (n) => `${(100 * (n || 0) / total).toFixed(1)}%`;
console.log(`hit ${by.hit || 0} (${pct(by.hit)})   miss ${by.miss || 0} (${pct(by.miss)})   error ${by.error || 0} (${pct(by.error)})`);

// ── THE MAIN EVENT: (tool, arg_shape) pairs that fail. A 100% error rate with a healthy call
// volume is almost always a broken caller, not a flaky tool.
const shapes = d.prepare(`
  SELECT tool, arg_shape,
         SUM(outcome='error') err, SUM(outcome='miss') miss, SUM(outcome='hit') hit,
         COUNT(*) n, CAST(AVG(latency_ms) AS INT) ms
  FROM route_obs WHERE ts > ? GROUP BY tool, arg_shape HAVING n >= ? ORDER BY err DESC, n DESC`).all(since, MIN_N);

const broken = shapes.filter(s => s.err === s.n);
const flaky = shapes.filter(s => s.err > 0 && s.err < s.n);

console.log(`\n${'─'.repeat(78)}\nALWAYS FAILS — every call errored (suspect the CALLER, not the tool)`);
if (!broken.length) console.log('  (none — good)');
for (const s of broken) {
  const alt = shapes.find(o => o.tool === s.tool && o.arg_shape !== s.arg_shape && o.hit > 0);
  console.log(`  ✗ ${s.tool}  ${s.arg_shape}`);
  console.log(`      ${s.n} calls, ${s.n} errors, avg ${s.ms}ms`);
  // A fast-failing call that has a WORKING sibling shape is the strongest possible signal: same
  // tool, different args, one works. That is what caught the resolvePlaces bug.
  if (alt) console.log(`      ↳ but "${alt.arg_shape}" WORKS (${alt.hit} hits) — compare the args`);
  if (s.ms < 50) console.log(`      ↳ fails in ${s.ms}ms — too fast to be real work; looks like arg rejection`);
}

console.log(`\n${'─'.repeat(78)}\nSOMETIMES FAILS`);
if (!flaky.length) console.log('  (none)');
for (const s of flaky) console.log(`  ~ ${s.tool.padEnd(24)} ${String(s.arg_shape).slice(0, 40).padEnd(40)} ${s.err}/${s.n} err`);

// ── Misses are NOT failures — they are the gap signal P3/P4 are built on. Reported separately and
// deliberately, so nobody "fixes" a high-miss lookup that is correctly reporting absence.
console.log(`\n${'─'.repeat(78)}\nHIGH-MISS LOOKUPS (not bugs — these are GAP signal; see MEMORY_PATH_MAPPING_DESIGN §6)`);
const misses = shapes.filter(s => s.miss >= Math.max(MIN_N, s.n * 0.5)).sort((a, b) => b.miss - a.miss);
if (!misses.length) console.log('  (none)');
for (const s of misses) console.log(`  ? ${s.tool.padEnd(24)} ${String(s.arg_shape).slice(0, 40).padEnd(40)} ${s.miss}/${s.n} empty`);

// ── Cost: where is the time actually going?
console.log(`\n${'─'.repeat(78)}\nSLOWEST (total time spent, not per-call)`);
for (const s of d.prepare(`SELECT tool, COUNT(*) n, CAST(AVG(latency_ms) AS INT) ms,
    CAST(SUM(latency_ms)/1000.0 AS INT) total_s FROM route_obs WHERE ts > ?
    GROUP BY tool ORDER BY SUM(latency_ms) DESC LIMIT 8`).all(since))
  console.log(`  ${s.tool.padEnd(24)} ${String(s.n).padStart(5)} calls  avg ${String(s.ms).padStart(6)}ms  total ${s.total_s}s`);

// ── DB-first: are we consulting ourselves before reaching outward? The measured motivation for the
// whole path-mapping effort. NOTE this counts Echo-side tools only — the operator's own web_search
// lives in a different lane, so read this as "within Echo, how much was outward-facing".
const OUTWARD = ['web_search', 'web_fetch', 'web_extract', 'web_resolve_oa', 'news_search', 'academic_search',
  'mediawiki_search', 'mediawiki_get_extract', 'gdelt_article_search'];
const q = OUTWARD.map(() => '?').join(',');
const out = d.prepare(`SELECT COUNT(*) n FROM route_obs WHERE ts > ? AND tool IN (${q})`).get(since, ...OUTWARD).n;
const ours = total - out;
console.log(`\n${'─'.repeat(78)}\nINWARD vs OUTWARD (Echo tools only): ${ours} ours / ${out} outward — ${pct(ours)} ours`);

console.log(`\n${'='.repeat(78)}`);
console.log(`${broken.length} always-failing call shape(s), ${flaky.length} intermittent.`);
if (broken.length) console.log('→ Each ALWAYS-FAILS row is a caller bug until proven otherwise. Check the args first.');
process.exit(0);
