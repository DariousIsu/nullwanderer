/* smoke_procedural_lessons.js — F25: procedural inoculation (run-2 audit → built 2026-08-20).
 *
 * The proven gap: wrong→correct happened live twice, wrong→correct→LEARNED never — chain-guard
 * state died with the turn, experience.js captured success-only via a dead caller, and nothing
 * injected lessons at tag-choice time. This organ persists the failure→working-path PAIR at the
 * moment a replan SUCCEEDS, class-keyed (never arg-keyed), and serves it as ORDER-BIAS history.
 *
 * Isolated temp DB. The wiring greps pin both main.js seams (capture in the chain loop; injection
 * gated on lookup/explore routes).
 */
'use strict';
const os = require('os'), path = require('path'), fs = require('fs');
process.env.SQ_DB_PATH = process.env.SQ_DB_PATH || path.join(os.tmpdir(), `sq_lessons_${process.pid}`, 'sq.db');
const db = require('../lib/db'); db.init();
const pl = require('../lib/procedural_lessons');

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`); } };

// ── task class rides the E1 vocabulary ──────────────────────────────────────────────────────────
ok(pl.taskClassOf('who is Cleo Fields?') === 'person', 'taskClassOf: a who-is ask → person');
ok(pl.taskClassOf('how many contacts with a phone in Louisiana?') === 'contact-count', 'taskClassOf: contact count');
ok(pl.taskClassOf('finish the report at notes/x.md') === 'general', 'taskClassOf: a non-question floors to general (never null)');

// ── record: class-keyed upsert, never arg-keyed ────────────────────────────────────────────────
ok(pl.record({ taskClass: 'person', failed: 'search_contacts', worked: 'quick_lookup' }).ok, 'a failure→working pair records');
ok(pl.record({ taskClass: 'person', failed: 'search_contacts', worked: 'quick_lookup' }).ok, 'the same pair again upserts');
ok(pl.lessonsFor('person')[0].hits === 2, '…hits increments (2) — repetition is weight, not duplication');
ok(pl.record({ taskClass: 'person', failed: 'db_query', worked: 'quick_lookup' }).ok, 'a second failed tool records as its own pair');
ok(!pl.record({ taskClass: 'person', failed: 'quick_lookup', worked: 'quick_lookup' }).ok, 'failed === worked never records (not a lesson)');
ok(!pl.record({ taskClass: '', failed: 'a', worked: 'b' }).ok, 'a classless pair never records');

// ── serving: strongest first, class-scoped, decay by disuse ─────────────────────────────────────
{
  const rows = pl.lessonsFor('person', { limit: 5 });
  ok(rows.length === 2 && rows[0].failed_tool === 'search_contacts', 'lessonsFor: strongest (2 hits) first');
  ok(pl.lessonsFor('bill').length === 0, 'another class sees nothing (class-scoped)');
  pl.record({ taskClass: 'bill', failed: 'bill_lookup', worked: 'legiscan_search', now: Date.now() - 31 * 24 * 3600e3 });
  ok(pl.lessonsFor('bill').length === 0, 'a month-stale unconfirmed lesson is NOT served (the world changes)');
}

// ── the injection block: measured history, order-bias, NEVER a fence ────────────────────────────
{
  const b = pl.injectionBlock('person');
  ok(!!b && /search_contacts came up empty and quick_lookup then found it \(seen 2×/.test(b), 'the block names the measured pair with its count');
  ok(/START with the tool that worked/.test(b), '…biases ORDER');
  ok(/history, not a fence/.test(b), '…and says explicitly it is not a fence (reachability untouched)');
  ok(pl.injectionBlock('news') === null, 'no lessons for the class → null (fail-absent, nothing injected)');
}

// ── WIRING (main.js seams) ──────────────────────────────────────────────────────────────────────
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  ok(/f25Failed/.test(src) && /f25Done/.test(src), 'capture: the chain loop tracks failed labels and banks once per chain');
  ok(/_pl\.record\(\{ taskClass: _tc, failed: _f, worked: _label \}\)/.test(src), 'capture: pairs record at the replan-SUCCESS moment');
  ok(/routeAllowsAny\('lookup', 'explore'\)[\s\S]{0,400}injectionBlock/.test(src), 'injection: gated on lookup/explore routes at tag-choice time');
}

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
