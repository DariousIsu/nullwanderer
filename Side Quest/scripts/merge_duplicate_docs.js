/* scripts/merge_duplicate_docs.js — collapse byte-identical documents onto one canonical row and
 * repoint everything that cites them.
 *
 * WHY THIS IS NOT HOUSEKEEPING. Duplicate document rows inflate corroboration. One PDF stored 18 times
 * is 18 apparent sources for whatever it asserts, which is exactly what min(origins, texts) exists to
 * prevent (docs/ENCOUNTER_OBJECT_MODEL_DESIGN.md §6). Measured:
 *
 *   806 duplicate rows — 12% of the corpus — carry 35% of ALL `docstore:` citations.
 *   sq.db  kg_observations : 124,205 of 353,346 refs point at a duplicate (35.2%)
 *   puller.db observations :  78,884 of 344,448 refs point at a duplicate (22.9%)
 *
 * That disproportion is not an accident: the most-duplicated documents are the most-decomposed ones.
 * So the inflation is ~200,000 observations deep, not the ~800 rows the document count suggests.
 *
 * ── SAFETY ──────────────────────────────────────────────────────────────────────────────────────
 *
 * A wrong merge is the one unrecoverable failure, so this is built to be undone:
 *   - CANONICAL = the OLDEST id per content hash. The first encounter keeps the id everything cites,
 *     so most references are already correct and the diff stays as small as the data allows.
 *   - Duplicate rows are marked `superseded_by`, never deleted. The mapping remains invertible.
 *   - Both databases are copied to *.premerge-<ts>.db before a single write.
 *   - All writes for a database happen in ONE transaction: it lands whole or not at all.
 *   - DRY-RUN BY DEFAULT.
 *
 * Observation COLLAPSE (rows that become identical once repointed) is deliberately NOT done here. It is
 * the only step requiring judgement rather than arithmetic, so this reports the count and a sample and
 * stops. Repointing is reversible; deleting observations is not.
 *
 * Run with the app STOPPED (it holds sq.db open):
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/merge_duplicate_docs.js [--apply]
 */
'use strict';
process.chdir(require('path').join(__dirname, '..'));
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const APPLY = process.argv.includes('--apply');
const SQ = path.join('data', 'sq.db');
const PULLER = path.join('data', 'puller.db');

console.log(`\nDUPLICATE DOCUMENT MERGE — ${APPLY ? 'APPLYING' : 'DRY RUN (pass --apply to write)'}\n${'='.repeat(78)}`);

// Ensure the schema column exists (the app's own migration adds it; this makes the script standalone).
{
  const w = new Database(SQ);
  try { w.prepare('SELECT superseded_by FROM documents LIMIT 1').get(); }
  catch { try { w.exec('ALTER TABLE documents ADD COLUMN superseded_by INTEGER'); console.log('added documents.superseded_by'); } catch (e) { console.error('schema:', e.message); } }
  w.close();
}

// ── the mapping: oldest id per content hash wins ────────────────────────────────────────────────
const ro = new Database(SQ, { readonly: true });
const canonOf = new Map();     // hash → canonical id
const dupToCanon = new Map();  // duplicate id → canonical id
for (const r of ro.prepare('SELECT id, content_hash FROM documents WHERE content_hash IS NOT NULL ORDER BY id ASC').all()) {
  if (!canonOf.has(r.content_hash)) canonOf.set(r.content_hash, r.id);
  else dupToCanon.set(r.id, canonOf.get(r.content_hash));
}
console.log(`documents           ${ro.prepare('SELECT COUNT(*) c FROM documents').get().c}`);
console.log(`distinct texts      ${canonOf.size}`);
console.log(`duplicates to merge ${dupToCanon.size}`);

// ORIGIN RECOVERY: a later copy may have captured a publisher the original never had. Merging
// propagates it — the only way any pre-hook document ever gets an origin, since the URL is otherwise
// unrecoverable. Never the reverse: a canonical row that already has an origin keeps it.
const originGifts = [];
for (const [dup, canon] of dupToCanon) {
  const d = ro.prepare('SELECT origin, origin_host, fetch_url FROM documents WHERE id = ?').get(dup);
  const c = ro.prepare('SELECT origin, origin_host FROM documents WHERE id = ?').get(canon);
  if (d && d.origin_host && c && !c.origin_host) originGifts.push({ canon, dup, origin: d.origin, host: d.origin_host, fetch: d.fetch_url });
}
console.log(`\norigin recovered by merge: ${originGifts.length} canonical row(s) gain a publisher`);
for (const g of originGifts.slice(0, 5)) console.log(`  #${g.canon} ← #${g.dup}  ${g.host}`);

// ── what cites a duplicate ──────────────────────────────────────────────────────────────────────
const dupUrls = new Set([...dupToCanon.keys()].map((id) => `docstore:${id}`));
const countRefs = (db, table, col) => {
  let n = 0;
  for (const r of db.prepare(`SELECT ${col} u FROM ${table} WHERE ${col} LIKE 'docstore:%'`).iterate()) if (dupUrls.has(r.u)) n += 1;
  return n;
};
const pro = new Database(PULLER, { readonly: true });
const plan = {
  kg_observations: countRefs(ro, 'kg_observations', 'url'),
  puller_observations: countRefs(pro, 'observations', 'source_url'),
  encounters: ro.prepare("SELECT COUNT(*) c FROM encounters WHERE source_ref LIKE 'doc:%'").all
    ? [...dupToCanon.keys()].reduce((a, id) => a + ro.prepare('SELECT COUNT(*) c FROM encounters WHERE source_ref = ?').get(`doc:${id}`).c, 0) : 0,
  doc_contacts: [...dupToCanon.keys()].reduce((a, id) => a + ro.prepare('SELECT COUNT(*) c FROM doc_contacts WHERE doc_id = ?').get(id).c, 0),
  doc_contacts_scanned: [...dupToCanon.keys()].reduce((a, id) => a + ro.prepare('SELECT COUNT(*) c FROM doc_contacts_scanned WHERE doc_id = ?').get(id).c, 0),
  parent_id: [...dupToCanon.keys()].reduce((a, id) => a + ro.prepare('SELECT COUNT(*) c FROM documents WHERE parent_id = ?').get(id).c, 0),
};
console.log(`\nreferences to repoint:`);
for (const [k, v] of Object.entries(plan)) console.log(`  ${k.padEnd(22)} ${v}`);

// ── collapse candidates: REPORTED, never applied here ───────────────────────────────────────────
// After repointing, some observations become identical to one another. That is the real corroboration
// inflation made visible — but collapsing is a delete, and a delete is not reversible, so it stops at a
// count and a sample for a human to look at.
// Grouped on the url AFTER repointing, which is the only thing that measures what this merge creates.
// Grouping without the url would instead report how often an observation recurs across DIFFERENT
// documents — real duplication, but pre-existing and not caused here. Getting that wrong would credit
// the merge with collapsing rows it never touched.
const collapseKeys = new Map();
for (const r of ro.prepare("SELECT feed, source_entity, relation, target, value, url FROM kg_observations WHERE url LIKE 'docstore:%'").iterate()) {
  const id = Number(String(r.url).slice(9));
  const canonUrl = dupToCanon.has(id) ? `docstore:${dupToCanon.get(id)}` : r.url;
  const k = `${r.feed}|${r.source_entity}|${r.relation || ''}|${r.target || ''}|${r.value || ''}|${canonUrl}`;
  collapseKeys.set(k, (collapseKeys.get(k) || 0) + 1);
}
const collapse = [...collapseKeys.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]);
const collapsible = collapse.reduce((a, [, n]) => a + (n - 1), 0);
console.log(`\nobservations that become IDENTICAL once repointed: ${collapsible} (in ${collapse.length} group(s))`);
console.log(`  NOT applied — repointing is reversible, deleting observations is not. Sample:`);
for (const [k, n] of collapse.slice(0, 8)) {
  const p = k.split('|');
  console.log(`  ×${String(n).padStart(3)}  ${p[1]} ${p[2]}${p[3] ? ' → ' + p[3] : ''}${p[4] ? ' = ' + p[4].slice(0, 26) : ''}   [${p[5]}]`);
}

ro.close(); pro.close();

if (!APPLY) { console.log(`\nDry run — nothing written. Re-run with --apply.`); process.exit(0); }

// ── APPLY ───────────────────────────────────────────────────────────────────────────────────────
const stamp = process.env.MERGE_STAMP || String(process.hrtime.bigint()).slice(0, 13);
for (const f of [SQ, PULLER]) {
  const bak = f.replace(/\.db$/, `.premerge-${stamp}.db`);
  fs.copyFileSync(f, bak);
  console.log(`\nbacked up ${f} → ${bak}`);
}

// sq.db — one transaction. A temp mapping table makes this ONE pass over each table instead of 806.
{
  const w = new Database(SQ);
  w.exec('CREATE TEMP TABLE docmap(dup TEXT PRIMARY KEY, canon TEXT, dup_id INTEGER, canon_id INTEGER)');
  const ins = w.prepare('INSERT INTO docmap VALUES (?,?,?,?)');
  const tx = w.transaction(() => {
    for (const [dup, canon] of dupToCanon) ins.run(`docstore:${dup}`, `docstore:${canon}`, dup, canon);

    const kg = w.prepare(`UPDATE kg_observations SET url = (SELECT canon FROM docmap WHERE dup = kg_observations.url)
                           WHERE url IN (SELECT dup FROM docmap)`).run();
    // OR IGNORE, because idx_encounters_uniq (one encounter per source per claim) rejects the repoint
    // when the canonical document already produced that exact claim. That rejection is the index working:
    // the two rows were always ONE encounter, split only because the document was stored twice. The
    // leftovers are then removed — not evidence being deleted, but a duplicate vote being withdrawn,
    // which is the entire point of the merge.
    const enc = w.prepare(`UPDATE OR IGNORE encounters SET source_ref = 'doc:' || (SELECT canon_id FROM docmap WHERE 'doc:' || dup_id = encounters.source_ref)
                            WHERE source_ref IN (SELECT 'doc:' || dup_id FROM docmap)`).run();
    const encDel = w.prepare("DELETE FROM encounters WHERE source_ref IN (SELECT 'doc:' || dup_id FROM docmap)").run();
    // doc_contacts has UNIQUE(doc_id, name, email_key): repointing can collide with a row the canonical
    // document already produced. That collision IS the duplicate — OR IGNORE keeps the existing row, and
    // the leftovers pointing at a superseded document are then removed. They are derived, regenerable,
    // and cite a document that no longer stands.
    const dc = w.prepare('UPDATE OR IGNORE doc_contacts SET doc_id = (SELECT canon_id FROM docmap WHERE dup_id = doc_contacts.doc_id) WHERE doc_id IN (SELECT dup_id FROM docmap)').run();
    const dcDel = w.prepare('DELETE FROM doc_contacts WHERE doc_id IN (SELECT dup_id FROM docmap)').run();
    const dcs = w.prepare('UPDATE OR IGNORE doc_contacts_scanned SET doc_id = (SELECT canon_id FROM docmap WHERE dup_id = doc_contacts_scanned.doc_id) WHERE doc_id IN (SELECT dup_id FROM docmap)').run();
    const dcsDel = w.prepare('DELETE FROM doc_contacts_scanned WHERE doc_id IN (SELECT dup_id FROM docmap)').run();
    const par = w.prepare('UPDATE documents SET parent_id = (SELECT canon_id FROM docmap WHERE dup_id = documents.parent_id) WHERE parent_id IN (SELECT dup_id FROM docmap)').run();

    // Propagate a recovered publisher onto the canonical row.
    const og = w.prepare('UPDATE documents SET origin = ?, origin_host = ?, fetch_url = COALESCE(fetch_url, ?) WHERE id = ? AND origin_host IS NULL');
    let gifted = 0;
    for (const g of originGifts) gifted += og.run(g.origin, g.host, g.fetch, g.canon).changes;

    // Mark, never delete.
    const sup = w.prepare('UPDATE documents SET superseded_by = (SELECT canon_id FROM docmap WHERE dup_id = documents.id) WHERE id IN (SELECT dup_id FROM docmap)').run();

    console.log(`\nsq.db:`);
    console.log(`  kg_observations repointed   ${kg.changes}`);
    console.log(`  encounters repointed        ${enc.changes}   (+${encDel.changes} were the same encounter twice → merged)`);
    console.log(`  doc_contacts repointed      ${dc.changes}   (+${dcDel.changes} collided → removed as duplicates)`);
    console.log(`  doc_contacts_scanned        ${dcs.changes}   (+${dcsDel.changes} collided → removed)`);
    console.log(`  parent_id repointed         ${par.changes}`);
    console.log(`  origins recovered           ${gifted}`);
    console.log(`  documents superseded        ${sup.changes}  (marked, NOT deleted)`);
  });
  tx();
  w.close();
}

// puller.db — same shape, its own transaction.
{
  const w = new Database(PULLER);
  w.exec('CREATE TEMP TABLE docmap(dup TEXT PRIMARY KEY, canon TEXT)');
  const ins = w.prepare('INSERT INTO docmap VALUES (?,?)');
  const tx = w.transaction(() => {
    for (const [dup, canon] of dupToCanon) ins.run(`docstore:${dup}`, `docstore:${canon}`);
    const o = w.prepare(`UPDATE observations SET source_url = (SELECT canon FROM docmap WHERE dup = observations.source_url)
                          WHERE source_url IN (SELECT dup FROM docmap)`).run();
    console.log(`\npuller.db:`);
    console.log(`  observations repointed      ${o.changes}`);
  });
  tx();
  w.close();
}

// ── verify: nothing may still cite a superseded document ────────────────────────────────────────
{
  const v = new Database(SQ, { readonly: true });
  const p = new Database(PULLER, { readonly: true });
  const left = countRefs(v, 'kg_observations', 'url');
  const leftP = countRefs(p, 'observations', 'source_url');
  const leftE = [...dupToCanon.keys()].reduce((a, id) => a + v.prepare('SELECT COUNT(*) c FROM encounters WHERE source_ref = ?').get(`doc:${id}`).c, 0);
  console.log(`\n${'='.repeat(78)}`);
  console.log(`VERIFY — references still pointing at a superseded document:`);
  console.log(`  kg_observations ${left}   puller observations ${leftP}   encounters ${leftE}`);
  console.log(left + leftP + leftE === 0 ? '  ✓ none — every citation now resolves to a canonical document' : '  ✗ SOME REMAIN — investigate before trusting this');
  v.close(); p.close();
}

// ── COLLAPSE (--collapse) ───────────────────────────────────────────────────────────────────────
//
// Once repointed, thousands of observations are the same claim, from the same document, recorded twice
// — the duplicate votes the merge exists to remove. Collapsing them is a DELETE, which is why it is a
// separate flag run only after the repoint has been inspected.
//
// KEEP THE BEST ROW, NOT THE FIRST. The rows are not fully identical: 2,558 groups differ in grade,
// 2,595 in confidence and 2,720 in status. Deleting blindly by id would throw away a promoted, B-graded
// observation in favour of a held, D-graded twin. Ranking is explicit: promoted beats held, B beats D,
// higher confidence wins, oldest breaks the tie.
if (process.argv.includes('--collapse')) {
  const stamp2 = String(process.hrtime.bigint()).slice(0, 13);
  for (const f of [SQ, PULLER]) {
    const bak = f.replace(/\.db$/, `.precollapse-${stamp2}.db`);
    fs.copyFileSync(f, bak);
    console.log(`\nbacked up ${f} → ${bak}`);
  }
  {
    const w = new Database(SQ);
    const res = w.transaction(() => w.prepare(`
      DELETE FROM kg_observations WHERE id IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (
            PARTITION BY feed, source_entity, COALESCE(relation,''), COALESCE(target,''), COALESCE(value,''), url
            ORDER BY (status = 'promoted') DESC, (grade = 'B') DESC, COALESCE(confidence, -1) DESC, id ASC
          ) rn FROM kg_observations WHERE url LIKE 'docstore:%'
        ) WHERE rn > 1)`).run())();
    console.log(`\nsq.db kg_observations collapsed: ${res.changes} duplicate vote(s) removed`);
    w.close();
  }
  {
    const w = new Database(PULLER);
    const res = w.transaction(() => w.prepare(`
      DELETE FROM observations WHERE id IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (
            PARTITION BY target_id, attr, COALESCE(value,''), COALESCE(kind,''), source_url
            ORDER BY COALESCE(confidence, -1) DESC, id ASC
          ) rn FROM observations WHERE source_url LIKE 'docstore:%'
        ) WHERE rn > 1)`).run())();
    console.log(`puller.db observations collapsed: ${res.changes} duplicate vote(s) removed`);
    w.close();
  }
  const v2 = new Database(SQ, { readonly: true });
  const dupLeft = v2.prepare(`SELECT COUNT(*) c FROM (SELECT 1 FROM kg_observations WHERE url LIKE 'docstore:%'
    GROUP BY feed, source_entity, COALESCE(relation,''), COALESCE(target,''), COALESCE(value,''), url HAVING COUNT(*)>1)`).get().c;
  const kept = v2.prepare("SELECT COUNT(*) c FROM kg_observations WHERE url LIKE 'docstore:%'").get().c;
  const prom = v2.prepare("SELECT COUNT(*) c FROM kg_observations WHERE url LIKE 'docstore:%' AND status='promoted'").get().c;
  console.log(`\nVERIFY — duplicate groups remaining: ${dupLeft}   observations kept: ${kept} (${prom} promoted)`);
  console.log(dupLeft === 0 ? '  ✓ every claim from a document is now counted ONCE' : '  ✗ groups remain — investigate');
  v2.close();
}
process.exit(0);
