/**
 * One-pass dedup of the EXISTING bloat in both tracks (after adding write-time dedup,
 * this cleans what accumulated before it). Greedy: walk rows oldest→newest, keep the
 * first of each near-duplicate cluster, drop the rest. A pair is a duplicate only if
 * cosine ≥ prefilter AND an LLM confirms same fact/trait (cosine-only would over-merge).
 *   knowledge   → delete dups (FTS purged), keeper retained.
 *   self_model  → delete dups, keeper's mention count absorbs the dropped ones.
 *
 * DRY-RUN default; --apply to write. Run with the app STOPPED (model stays warm via
 * keep_alive) so writes don't race the live loops.
 *
 * Run (dry):   $env:ELECTRON_RUN_AS_NODE=1; .\node_modules\.bin\electron.cmd scripts\dedup_existing.js
 * Run (apply): ... scripts\dedup_existing.js --apply
 */
const D = require('../lib/db'); D.init();
const memory = require('../lib/memory');
const selfModel = require('../lib/self_model');
const { streamChat } = require('../lib/ollama');
const MODEL = require('../lib/config').model();

const APPLY = process.argv.includes('--apply');
const db = D.getDb();
const short = (s, n = 70) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);

async function sameFact(a, b) {
  let raw = '';
  try { await streamChat({ model: MODEL, messages: [{ role: 'user', content: `Do these two notes state essentially the SAME fact/procedure (a duplicate or paraphrase, no meaningful new info)? Answer ONLY "yes" or "no".\n\nA: ${a}\nB: ${b}` }], options: { temperature: 0, top_p: 0.9, num_ctx: 8192, num_predict: 3 }, onToken: (t) => { raw += t; } }); }
  catch { return false; }
  return /^\s*yes/i.test(raw.trim());
}

// Greedy near-duplicate clustering. Returns { keep:[row], drops:[{row, intoId}] }.
async function cluster(rows, prefilter, sameFn) {
  const kept = [];
  const drops = [];
  for (const r of rows) {
    let v; try { v = JSON.parse(r.embedding); } catch { v = null; }
    let hit = null;
    if (v) {
      let best = null, bestSim = 0;
      for (const k of kept) { if (!k._v) continue; const s = memory.cosine(v, k._v); if (s > bestSim) { bestSim = s; best = k; } }
      if (best && bestSim >= prefilter && await sameFn(r.content, best.content)) hit = best;
    }
    if (hit) drops.push({ row: r, intoId: hit.id });
    else { r._v = v; kept.push(r); }
  }
  return { kept, drops };
}

(async () => {
  await memory.warm().catch(() => {});

  // --- knowledge ---
  const kRows = db.prepare(`SELECT id, content, embedding FROM knowledge WHERE embedding IS NOT NULL ORDER BY id`).all();
  const kClust = await cluster(kRows, 0.86, sameFact);
  console.log(`=== KNOWLEDGE: ${kRows.length} rows → keep ${kClust.kept.length}, drop ${kClust.drops.length} ===`);
  for (const d of kClust.drops.slice(0, 20)) console.log(`  drop #${d.row.id} (dup of #${d.intoId})  ${short(d.row.content)}`);
  if (kClust.drops.length > 20) console.log(`  …and ${kClust.drops.length - 20} more`);

  // --- self_model ---
  const sRows = db.prepare(`SELECT id, content, embedding, mentions FROM self_model WHERE embedding IS NOT NULL ORDER BY id`).all();
  const sClust = await cluster(sRows, selfModel.PREFILTER_SIM, selfModel.defaultDecide);
  console.log(`\n=== SELF_MODEL: ${sRows.length} rows → keep ${sClust.kept.length}, drop ${sClust.drops.length} ===`);
  for (const d of sClust.drops.slice(0, 20)) console.log(`  merge #${d.row.id} → #${d.intoId}  ${short(d.row.content)}`);
  if (sClust.drops.length > 20) console.log(`  …and ${sClust.drops.length - 20} more`);

  if (!APPLY) { console.log('\nDRY-RUN only. Re-run with --apply to delete the dups.'); db.close(); return; }

  // apply knowledge deletes (+ FTS purge)
  for (const d of kClust.drops) {
    db.prepare('DELETE FROM knowledge WHERE id=?').run(d.row.id);
    try { db.prepare(`INSERT INTO knowledge_fts(knowledge_fts,rowid,content) VALUES('delete',?,?)`).run(d.row.id, d.row.content); } catch {}
  }
  // apply self_model merges: keeper absorbs dropped mentions, then delete dup
  for (const d of sClust.drops) {
    db.prepare('UPDATE self_model SET mentions = mentions + ? WHERE id=?').run(d.row.mentions || 1, d.intoId);
    db.prepare('DELETE FROM self_model WHERE id=?').run(d.row.id);
  }
  console.log(`\nAPPLIED → knowledge: -${kClust.drops.length} | self_model: -${sClust.drops.length}`);
  console.log(`now: knowledge=${D.countKnowledge()} self_model=${D.countSelfModel()}`);
  db.close();
})();
