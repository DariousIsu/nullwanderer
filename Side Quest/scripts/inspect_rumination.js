// READ-ONLY: diagnose whether recent thoughts are semantic rumination that the
// exact-signature StuckDetector can't see. Pulls recent thought events, shows
// signatures (lexical), and computes pairwise embedding cosine (semantic).
const db = require('../lib/db');
const memory = require('../lib/memory');
const stuck = require('../lib/stuck');

async function run() {
  db.init();
  const ev = db.getRecentAgentEvents(25).filter(e => e.kind === 'thought' || e.kind === 'reading');
  console.log(`recent thought/reading events: ${ev.length}\n`);
  for (const e of ev.slice(-12)) console.log(`  #${e.id} [${e.kind}] ${(e.content || '').replace(/\s+/g, ' ').slice(0, 64)}`);

  const thoughts = ev.filter(e => e.kind === 'thought').slice(-6);
  // lexical: any exact-signature repeats? (what the StuckDetector keys on)
  const sigs = thoughts.map(t => t.signature);
  const exactDupes = sigs.length - new Set(sigs).size;
  console.log(`\nlexical: ${thoughts.length} recent thoughts, ${exactDupes} exact-signature duplicates`);
  console.log('stuck.check():', JSON.stringify(stuck.check()));

  // semantic: pairwise cosine over the thought texts
  const vecs = [];
  for (const t of thoughts) { try { vecs.push(await memory.embed(t.content)); } catch { vecs.push(null); } }
  let sum = 0, n = 0, max = 0;
  for (let i = 0; i < vecs.length; i++) for (let j = i + 1; j < vecs.length; j++) {
    if (!vecs[i] || !vecs[j]) continue;
    const c = memory.cosine(vecs[i], vecs[j]); sum += c; n++; if (c > max) max = c;
  }
  console.log(`semantic: avg pairwise cosine ${n ? (sum / n).toFixed(3) : 'n/a'}, max ${max.toFixed(3)} (high = circling one theme despite different words)`);
  db.getDb().close();
}
run();
