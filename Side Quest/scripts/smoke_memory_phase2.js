/**
 * Backtest — Memory Phase 2 (endpoint-not-path), OFFLINE (temp DB, no model).
 * Proves: the consolidated/distilled_into columns + helper, the excludeConsolidated
 * filter on recency injection, and that reflection.routeReflection marks the source
 * readings consolidated (pointing at the distilled note) once it stores knowledge.
 * storeDeduped is stubbed so the test stays model-free and deterministic.
 */
const os = require('os');
const path = require('path');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_mem2_${Date.now()}`, 'sq.db');
const db = require('../lib/db'); db.init();

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } };

(async () => {
  console.log('Backtest — Memory Phase 2 (offline)\n');

  console.log('schema + helper:');
  const r1 = db.insertMonologue({ content: 'read: DuckDuckGo HTML results live under a.result__a', type: 'reading', query: 'ddg html selectors' });
  const r2 = db.insertMonologue({ content: 'read: Substack publish flow is compose→Continue→Publish', type: 'reading', query: 'substack publish' });
  const th = db.insertMonologue({ content: 'a passing thought', type: 'thought' });
  ok('readings present before consolidation (excludeConsolidated)', db.getRecentMonologueByType('reading', 10, { excludeConsolidated: true }).length === 2);

  const changed = db.markReadingsConsolidated([r1.id, r2.id, th.id], 4242);
  ok('marks only the 2 readings (not the thought)', changed === 2);
  const row = db.getMonologueById(r1.id);
  ok('consolidated=1 + distilled_into points at the note', row.consolidated === 1 && row.distilled_into === 4242);

  console.log('\nrecency injection excludes consolidated (but raw stays addressable):');
  ok('excludeConsolidated drops them from injection', db.getRecentMonologueByType('reading', 10, { excludeConsolidated: true }).length === 0);
  ok('default (audit) still sees them — source not deleted', db.getRecentMonologueByType('reading', 10).length === 2);
  ok('the raw row is still fetchable via its pointer', !!db.getMonologueById(r1.id));

  console.log('\nreflection.routeReflection consolidates the window once knowledge is distilled:');
  // stub storeDeduped so no embedder/model is needed — return a stable note id.
  const memory = require('../lib/memory');
  const realStore = memory.storeDeduped;
  memory.storeDeduped = async () => ({ action: 'add', id: 7777 });
  const reflection = require('../lib/reflection');

  const a = db.insertMonologue({ content: 'read: cold-pitch emails state the ask in sentence one', type: 'reading' });
  const b = db.insertMonologue({ content: 'read: follow up within 48h on no-reply', type: 'reading' });
  const sourceRows = [db.getMonologueById(a.id), db.getMonologueById(b.id)];
  const raw = '[KNOWLEDGE] A cold pitch email should state the specific ask in the first sentence.';
  const routed = await reflection.routeReflection(raw, sourceRows, { decideFn: async () => false });
  ok('a knowledge takeaway was kept', routed.nKnow === 1);
  const ra = db.getMonologueById(a.id), rb = db.getMonologueById(b.id);
  ok('both source readings consolidated → the distilled note', ra.consolidated === 1 && rb.consolidated === 1 && ra.distilled_into === 7777 && rb.distilled_into === 7777);

  console.log('\nno consolidation when nothing durable is distilled (pure noop window):');
  memory.storeDeduped = async () => ({ action: 'noop', id: 7777 });
  const c = db.insertMonologue({ content: 'read: already-known fact', type: 'reading' });
  const routed2 = await reflection.routeReflection('[KNOWLEDGE] Already-known fact restated.', [db.getMonologueById(c.id)], { decideFn: async () => true });
  ok('noop-only window keeps readings hot (not consolidated)', db.getMonologueById(c.id).consolidated === 0 && routed2.nKnow === 0);

  memory.storeDeduped = realStore;   // restore

  console.log('\nembedding-tier high-band guard (_tierSame, deterministic-loops #5 + 2026-08-15 backcheck):');
  ok('verbatim restate (case/punct only) → same, no model call', memory._tierSame('The parish seat is Gretna', 'the parish seat is gretna.', 0.99) === true);
  ok('RE-FIX: word-order REVERSAL that flips meaning is NOT same ("A owes B" vs "B owes A")', memory._tierSame('Lucas owes Bob 5 dollars', 'Bob owes Lucas 5 dollars', 0.97) === false);
  ok('RE-FIX: a benign reorder also reaches the model (sequence equality is order-SENSITIVE — safe)', memory._tierSame('Gretna is the parish seat', 'the parish seat is Gretna', 0.99) === false);
  ok('BACKCHECK: negation REMOVAL is NOT same ("approved" vs "not approved" — the old subset bug)', memory._tierSame('The drug was approved', 'The drug was not approved', 0.97) === false);
  ok('BACKCHECK: short-token difference reaches the model (Q3 vs Q2 — the old tokenizer collapsed it)', memory._tierSame('Revenue rose in Q3', 'Revenue rose in Q2', 0.97) === false);
  ok('BACKCHECK: suffixed-numeric difference ($4.2B vs $4.3B)', memory._tierSame('Revenue was $4.2B', 'Revenue was $4.3B', 0.97) === false);
  ok('a terser restatement (drops filler tokens) → the model decides (conservative, no silent drop)', memory._tierSame('parish seat Gretna', 'The parish seat of Jefferson Parish is Gretna', 0.95) === false);
  ok('numeric correction reaches the model (39→38 embeds ~0.97)', memory._tierSame('The Senate has 39 seats', 'The Senate has 38 seats', 0.97) === false);
  ok('a novel token (new info) → the model decides', memory._tierSame('Gretna is the seat and the mayor is Constance', 'The parish seat is Gretna', 0.94) === false);
  ok('below SIM_SAME → the model decides regardless', memory._tierSame('the parish seat is gretna', 'The parish seat is Gretna', 0.9) === false);
  ok('empty/degenerate inputs → never same', memory._tierSame('', 'x', 0.99) === false && memory._tierSame('a b', '', 0.99) === false);

  // ⭐ audit S30: storeDeduped is serialized (read-then-await-then-insert races double-inserted)
  {
    const src = require('fs').readFileSync(path.join(__dirname, '..', 'lib', 'memory.js'), 'utf8');
    ok('S30: storeDeduped runs through a serializing chain (no concurrent same-fact double-insert)',
      /let _storeChain = Promise\.resolve\(\)/.test(src) && /_storeChain = new Promise/.test(src) && /_storeDedupedInner/.test(src));
  }

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  try { require('fs').rmSync(path.dirname(process.env.SQ_DB_PATH), { recursive: true, force: true }); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})();
