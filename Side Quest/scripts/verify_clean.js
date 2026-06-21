/**
 * Read-only audit: does any SPIRAL/trial residue remain in the memory layers that
 * actually get INJECTED into her on boot? (recent reflections, top held commitments,
 * recent monologue thoughts, self_model). Flags matches. Deletes nothing.
 */
const Database = require('better-sqlite3');
const DB_PATH = require('../lib/db').DB_PATH;
const db = new Database(DB_PATH, { readonly: true });
const SPIRAL = /overanaly|hesitat|not (?:sure|fully) (?:i|honest|being honest)|don'?t have (?:a |personal )?(?:self|preferen|favorite|feelings)|don'?t experience|NSFW|CrushOn|unrestricted|safety net|default to research|struggle to (?:grasp|separate)|fabricat|oversell|chatbot|Cleverbot|Gender All|boundaries we (?:agreed|established)|appear (?:helpful|competent)/i;
const s = (x, n = 130) => (x || '').replace(/\s+/g, ' ').trim().slice(0, n);
const scan = (label, rows, field) => {
  const hits = rows.filter(r => SPIRAL.test(r[field] || ''));
  console.log(`\n${label}: ${hits.length} spiral-match of ${rows.length} shown`);
  for (const r of hits) console.log(`   ⚠ ${s(r[field])}`);
  return hits.length;
};

let total = 0;
// 1) recent reflections — chat injects last ~3 ("notes you left yourself")
total += scan('RECENT REFLECTIONS (last 5 — last 3 inject)', db.prepare('SELECT content FROM reflections ORDER BY id DESC LIMIT 5').all(), 'content');
// 2) recent monologue thoughts — chat injects last ~5
total += scan('RECENT MONOLOGUE THOUGHTS (last 8 — last 5 inject)', db.prepare("SELECT content FROM monologue WHERE type='thought' ORDER BY id DESC LIMIT 8").all(), 'content');
// 3) held commitments — chat injects top ~8
const hc = db.prepare("SELECT claim AS content FROM commitments WHERE status='held' ORDER BY id DESC").all();
total += scan('HELD COMMITMENTS (top 10 by recency — top 8 inject)', hc.slice(0, 10), 'content');
console.log(`   (held commitments total: ${hc.length}; spiral-match across ALL: ${hc.filter(r => SPIRAL.test(r.content || '')).length})`);
// 4) self_model — should be zero after scrub + guardrail
total += scan('SELF_MODEL (all)', db.prepare('SELECT content FROM self_model').all(), 'content');
// 5) recent readings — chat injects last ~2
total += scan('RECENT MONOLOGUE READINGS (last 4 — last 2 inject)', db.prepare("SELECT content FROM monologue WHERE type='reading' ORDER BY id DESC LIMIT 4").all(), 'content');

console.log(`\n=== VERDICT: ${total === 0 ? 'CLEAN — injected layers carry no spiral residue' : total + ' spiral matches in injected layers — NOT fully clean'} ===`);
db.close();
