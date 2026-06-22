/**
 * One-time cleanup (anti-glob follow-up #1): the obsession was grown by reflection laundering
 * her own ungrounded thoughts into 0.75 "facts" (knowledge source=reflection_knowledge/skill).
 * Phase 2 stops NEW laundering; this demotes the EXISTING laundered facts so they stop feeding
 * recall + the idle loop.
 *
 * Conservative + reversible: a reflection fact is "laundered" ONLY if its provenance has NO
 * clean external source (every URL is absent or a DuckDuckGo self-search) — i.e. it was
 * distilled purely from her own thoughts. Anything grounded in a real article URL is KEPT.
 * Demote = move to source 'reflection_speculation' (excluded from retrieval) + importance 0.1.
 * Nothing is deleted; re-point the source back to undo.
 *
 * Run:  ELECTRON_RUN_AS_NODE=1 electron scripts/migrate_quarantine_laundered.js [--apply]
 *       (no flag = dry-run report; --apply performs the demotion)
 */
const db = require('../lib/db');

const REFLECTION_SOURCES = ['reflection_knowledge', 'reflection_skill'];

// A reflection-distilled note with no real external grounding → laundered self-talk.
function isLaundered(row) {
  if (!row || !REFLECTION_SOURCES.includes(row.source)) return false;
  let prov = null;
  try { prov = row.provenance ? JSON.parse(row.provenance) : null; } catch { prov = null; }
  const urls = [];
  if (Array.isArray(prov)) for (const p of prov) { if (p && Array.isArray(p.urls)) urls.push(...p.urls); }
  const cleanExternal = urls.filter((u) => /^https?:\/\//i.test(u) && !/duckduckgo\.com/i.test(u));
  return cleanExternal.length === 0;
}

function scan() {
  const rows = db.getDb().prepare('SELECT id, content, source, importance, provenance FROM knowledge').all();
  const candidates = rows.filter((r) => REFLECTION_SOURCES.includes(r.source));
  const laundered = candidates.filter(isLaundered);
  const grounded = candidates.filter((r) => !isLaundered(r));
  return { total: rows.length, candidates, laundered, grounded };
}

function apply() {
  const { laundered } = scan();
  const stmt = db.getDb().prepare("UPDATE knowledge SET source = 'reflection_speculation', importance = MIN(COALESCE(importance, 0.1), 0.1) WHERE id = ?");
  const tx = db.getDb().transaction((ids) => { for (const id of ids) stmt.run(id); });
  tx(laundered.map((r) => r.id));
  return laundered.length;
}

module.exports = { isLaundered, scan, apply, REFLECTION_SOURCES };

if (require.main === module) {
  db.init();
  const { total, candidates, laundered, grounded } = scan();
  console.log(`knowledge rows: ${total} | reflection candidates: ${candidates.length} | grounded (keep): ${grounded.length} | laundered (demote): ${laundered.length}\n`);
  console.log('— sample of what would be DEMOTED —');
  for (const r of laundered.slice(0, 12)) console.log(`  #${r.id} [${r.source} imp=${r.importance}] ${(r.content || '').replace(/\s+/g, ' ').slice(0, 90)}`);
  console.log('\n— sample of what is KEPT (grounded in a real source) —');
  for (const r of grounded.slice(0, 6)) console.log(`  #${r.id} ${(r.content || '').replace(/\s+/g, ' ').slice(0, 90)}`);
  const doApply = process.argv.includes('--apply');
  if (doApply) {
    const n = apply();
    console.log(`\nAPPLIED — demoted ${n} laundered fact(s) → reflection_speculation (excluded from recall; reversible).`);
  } else {
    console.log('\nDRY RUN — re-run with --apply to perform the demotion.');
  }
  process.exit(0);
}
