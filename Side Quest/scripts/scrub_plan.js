/**
 * DRY-RUN (read-only): classify what a personality scrub would KEEP vs SCRUB.
 * Deletes nothing. Just prints the proposed cut line for review.
 */
const Database = require('better-sqlite3');
const DB_PATH = require('../lib/db').DB_PATH;
const db = new Database(DB_PATH, { readonly: true });
const snip = (s, n = 150) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);

// Spiral / anxious self-concept / chatbot trial-error — the stuff to scrub.
const SCRUB_RE = /overanaly|hesitat|don'?t have (?:personal )?preferen|no favorite|oversell|fabricat|safety net|default to (?:research|a broad)|struggle to (?:grasp|separate)|tension between.*(?:capable|honest)|contradiction|new tools|haven'?t landed|deferential|incomplete information|unclear ethical|don'?t experience enjoyment|NSFW|unrestricted access|boundaries we|appear (?:helpful|competent)|misalignment between perceived|indirect communication|ambiguity over clear/i;
// Always keep these categories (her earned personality) unless they match a stale disclaimer.
const KEEP_CATS = new Set(['preference', 'taste', 'opinion', 'value']);

console.log('=== SELF_MODEL cut line ===');
const rows = db.prepare('SELECT id, category, content, mentions FROM self_model ORDER BY category, id').all();
let keep = [], scrub = [];
for (const r of rows) {
  const isStaleDisclaimer = /don'?t have (?:personal )?preferen|no favorite|don'?t experience enjoyment/i.test(r.content);
  const keepIt = (KEEP_CATS.has(r.category) && !isStaleDisclaimer) ||
                 (r.category === 'insight' && !SCRUB_RE.test(r.content) && /(connection|curiosity|creative|meaningful|named me|expectations tied|bottom of a story|political background)/i.test(r.content));
  (keepIt ? keep : scrub).push(r);
}
console.log(`\n--- KEEP (${keep.length}) ---`);
for (const r of keep) console.log(`  #${r.id} [${r.category}](${r.mentions}x) ${snip(r.content)}`);
console.log(`\n--- SCRUB (${scrub.length}) ---`);
for (const r of scrub) console.log(`  #${r.id} [${r.category}](${r.mentions}x) ${snip(r.content)}`);

console.log('\n=== KNOWLEDGE scrub candidates ===');
const kn = db.prepare("SELECT id, kind, content FROM knowledge").all();
const knScrub = kn.filter(r => /overanaly|hesitat|my view evolved|CrushOn|NSFW|Gender All|chatbot|don'?t have|fabricat/i.test(r.content));
console.log(`  scrub ${knScrub.length} of ${kn.length}:`);
for (const r of knScrub) console.log(`    #${r.id} [${r.kind}] ${snip(r.content, 120)}`);

console.log('\n=== MONOLOGUE (this-session spiral) ===');
const monoTotal = db.prepare("SELECT COUNT(*) c FROM monologue").get().c;
const monoSpiral = db.prepare("SELECT COUNT(*) c FROM monologue WHERE content LIKE '%overanaly%' OR content LIKE '%NSFW%' OR content LIKE '%CrushOn%' OR content LIKE '%boundaries%' OR content LIKE '%not sure I was honest%' OR content LIKE '%hesitat%' OR content LIKE '%unrestricted%'").get().c;
console.log(`  ${monoSpiral} of ${monoTotal} monologue rows match the spiral themes (chatbot/NSFW/overanalyze/honesty)`);

console.log('\n=== REFLECTIONS ===');
console.log(`  ${db.prepare('SELECT COUNT(*) c FROM reflections').get().c} total (recent ones are the NSFW/honesty self-exams)`);

console.log('\n=== ACTIVE THREADS / COMMITMENTS ===');
try { for (const r of db.prepare("SELECT id, content, status FROM open_threads WHERE status='active'").all()) console.log(`  thread #${r.id}: ${snip(r.content, 100)}`); } catch (e) { console.log('  (threads: ' + e.message + ')'); }
try { const c = db.prepare("SELECT claim FROM commitments WHERE status='held'").all(); console.log(`  held commitments: ${c.length}`); for (const r of c.slice(0,8)) console.log(`    · ${snip(r.claim, 120)}`); } catch (e) { console.log('  (commitments: ' + e.message + ')'); }

db.close();
