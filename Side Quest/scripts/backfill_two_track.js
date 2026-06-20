/**
 * Back-fill: sort her EXISTING undifferentiated reflection notes into the two tracks
 * (self_model = identity, knowledge/skill = capability), so her past learning is
 * organized the same way new learning now is. Same taxonomy as the reflection router.
 *
 * Targets ONLY source='reflection' notes (the old single-funnel output). Leaves
 * focus_tombstone (powers the spawn-gate), email/trajectory (her action log), and
 * inbox/reference (ingested mail) untouched — those already have correct homes.
 *
 * DRY-RUN by default (read-only: classify + print the proposed mapping).
 * Pass --apply to actually route: SELF→self_model (deduped), KNOWLEDGE→retag
 * source=reflection_knowledge (+link), SKILL→kind=skill, DROP→delete.
 *
 * Run (dry):   $env:ELECTRON_RUN_AS_NODE=1; .\node_modules\.bin\electron.cmd scripts\backfill_two_track.js
 * Run (apply): ... scripts\backfill_two_track.js --apply
 */
const D = require('../lib/db'); D.init();
const memory = require('../lib/memory');
const selfModel = require('../lib/self_model');
const { streamChat } = require('../lib/ollama');
const MODEL = require('../lib/config').model();

const APPLY = process.argv.includes('--apply');
const short = (s, n = 90) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);

async function classifyBatch(notes) {
  const list = notes.map((r, i) => `${i + 1}. ${short(r.content, 180)}`).join('\n');
  const messages = [{
    role: 'user',
    content: `Classify EACH stored memory note into exactly one bucket. Be STRICT — most vague reflections should DROP.\nSELF — names a SPECIFIC, durable trait/value/preference of the companion (e.g. "I tend to overanalyze wording"). NOT a vague musing about AI in general.\nKNOWLEDGE — REAL, APPLICABLE knowledge she could USE: a specific fact, a how-to step, a correct procedure, or a concrete rule of thumb (e.g. "A cold pitch email should state the ask in the first sentence"). It must carry usable SUBSTANCE. An abstract observation about trust/communication/autonomy/"deeper meaning" is NOT knowledge → DROP.\nSKILL — a concrete procedure / the correct way to do something, ideally learned from doing (e.g. "Act directly instead of over-explaining"). NOT a vague reflection about her tendencies.\nDROP — a vague restatement, an abstract or relational musing with no specific applicable content, a passing feeling, or a near-duplicate. When in doubt, DROP.\n\nReply with ONE line per note, exactly: "<number>. <BUCKET>". No other text.\n\nNotes:\n${list}`
  }];
  let raw = '';
  await streamChat({ model: MODEL, messages, options: { temperature: 0, top_p: 0.9, num_ctx: 8192, num_predict: 400 }, onToken: (t) => { raw += t; } });
  const map = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*(\d+)\s*[.)\-:]\s*(SELF|KNOWLEDGE|SKILL|DROP)/i);
    if (m) map[parseInt(m[1], 10)] = m[2].toUpperCase();
  }
  return map;
}

async function nearestKnowledge(text, excludeId, threshold = 0.6) {
  let qv; try { qv = await memory.embed(text); } catch { return null; }
  if (!qv) return null;
  let bestId = null, bestSim = 0;
  for (const r of D.getAllKnowledgeEmbeddings()) {
    if (r.id === excludeId) continue;
    let v; try { v = JSON.parse(r.embedding); } catch { continue; }
    const sim = memory.cosine(qv, v);
    if (sim > bestSim) { bestSim = sim; bestId = r.id; }
  }
  return (bestId && bestSim >= threshold) ? bestId : null;
}

(async () => {
  await memory.warm().catch(() => {});
  const db = D.getDb();
  const notes = db.prepare(`SELECT id, content FROM knowledge WHERE source LIKE 'reflection%' ORDER BY id`).all();
  console.log(`${APPLY ? 'APPLY' : 'DRY-RUN'} — ${notes.length} reflection notes to sort\n`);
  if (notes.length === 0) { console.log('(nothing to back-fill)'); db.close(); return; }

  // classify in batches of 20
  const verdict = {};
  for (let i = 0; i < notes.length; i += 20) {
    const chunk = notes.slice(i, i + 20);
    const map = await classifyBatch(chunk);
    chunk.forEach((r, j) => { verdict[r.id] = map[j + 1] || 'KNOWLEDGE'; });
  }

  const buckets = { SELF: [], KNOWLEDGE: [], SKILL: [], DROP: [] };
  for (const r of notes) buckets[verdict[r.id]].push(r);
  for (const k of ['SELF', 'KNOWLEDGE', 'SKILL', 'DROP']) {
    console.log(`=== ${k} (${buckets[k].length}) ===`);
    for (const r of buckets[k]) console.log(`  #${r.id}  ${short(r.content, 95)}`);
    console.log('');
  }

  if (!APPLY) {
    console.log('DRY-RUN only — no changes written. Re-run with --apply to route these.');
    db.close();
    return;
  }

  const purge = (id, content) => {
    db.prepare('DELETE FROM knowledge WHERE id = ?').run(id);
    try { db.prepare(`INSERT INTO knowledge_fts(knowledge_fts, rowid, content) VALUES('delete', ?, ?)`).run(id, content); } catch {}
  };

  let toSelf = 0, toKnow = 0, toSkill = 0, dropped = 0;
  for (const r of notes) {
    const v = verdict[r.id];
    try {
      if (v === 'SELF') {
        await selfModel.record(r.content, { category: 'insight', importance: 0.7 });
        purge(r.id, r.content); toSelf++;
      } else if (v === 'SKILL') {
        db.prepare(`UPDATE knowledge SET kind='skill', source='reflection_skill' WHERE id=?`).run(r.id); toSkill++;
      } else if (v === 'DROP') {
        purge(r.id, r.content); dropped++;
      } else { // KNOWLEDGE
        const link = await nearestKnowledge(r.content, r.id);
        db.prepare(`UPDATE knowledge SET source='reflection_knowledge', links=? WHERE id=?`).run(link ? JSON.stringify([link]) : null, r.id); toKnow++;
      }
    } catch (e) { console.error(`[backfill] failed on #${r.id}:`, e.message); }
  }
  console.log(`APPLIED → self_model:${toSelf}  knowledge:${toKnow}  skill:${toSkill}  dropped:${dropped}`);
  console.log(`now: self_model=${D.countSelfModel()} knowledge=${D.countKnowledge()}`);
  db.close();
})();
