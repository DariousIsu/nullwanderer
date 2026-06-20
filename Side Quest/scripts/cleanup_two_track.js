// One-shot tidy of the two-track stores after the build/test triggers:
//  - strip leading dash/em-dash/bullet noise from self_model content (cosmetic — it's
//    always-injected into the persona block)
//  - drop exact-duplicate knowledge notes (kept lowest id), purging FTS
const D = require('../lib/db'); D.init();
const db = D.getDb();

let fixed = 0;
for (const r of D.getAllSelfModel()) {
  const cleaned = (r.content || '').replace(/^[\s\-–—•*:]+/, '').trim();
  if (cleaned && cleaned !== r.content) { db.prepare('UPDATE self_model SET content=? WHERE id=?').run(cleaned, r.id); fixed++; }
}
console.log(`self_model: stripped leading noise from ${fixed} entr(y/ies)`);

const dups = db.prepare(`SELECT content, COUNT(*) n, MIN(id) keepId FROM knowledge GROUP BY content HAVING n > 1`).all();
let del = 0;
for (const d of dups) {
  const rows = db.prepare('SELECT id, content FROM knowledge WHERE content=? AND id<>?').all(d.content, d.keepId);
  for (const row of rows) {
    db.prepare('DELETE FROM knowledge WHERE id=?').run(row.id);
    try { db.prepare(`INSERT INTO knowledge_fts(knowledge_fts, rowid, content) VALUES('delete', ?, ?)`).run(row.id, row.content); } catch {}
    del++;
  }
}
console.log(`knowledge: removed ${del} exact-duplicate note(s)`);
console.log(`now: self_model=${D.countSelfModel()} knowledge=${D.countKnowledge()}`);
db.close();
