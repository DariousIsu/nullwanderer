'use strict';
/* READ-ONLY baseline v2 — precision-grade. Two honest measures, no writes:
 *   (A) STRONG-ID collisions: same wd/FEC/bioguide/ocd/openstates id on >1 node = DEFINITE dups (0 false-pos).
 *   (B) MATCHER-adjudicated near-dups: block by (type + nameKey + jurisdiction), then within each block run the
 *       REAL entity_match.matchPair. Count 'match' pairs (matcher-confident dups) vs 'review' pairs (ambiguous
 *       queue). This uses our actual precision logic, so the bill/​homonym false-collisions from v1 fall to
 *       'review'/'no-match', NOT 'match'. Oversized blocks (> CAP) are flagged, not pairwise-scanned. */
const Database = require('C:/Users/azrae/Desktop/Side Quest/node_modules/better-sqlite3');
const EM = require('C:/Users/azrae/Desktop/Side Quest/lib/entity_match');
const DBP = 'C:/Users/azrae/Desktop/NX ECHO/nx-echo/data/foundations/civic_graph.db';
const db = new Database(DBP, { readonly: true, fileMustExist: true });

const ID_KEYS = ['wikidata', 'fec', 'bioguide', 'ocd', 'openstates', 'lda'];
const strong = new Map();   // "system:value" → { c, samples:[] }
const blocks = new Map();   // "type|nameKey|jur" → [{id,name,type}]
let total = 0;

const stmt = db.prepare('SELECT id, name, entity_type AS et FROM entities');
for (const row of stmt.iterate()) {
  total++;
  const p = EM.parseEntity({ name: row.name, type: row.et });
  for (const k of ID_KEYS) {
    if (p.ids[k]) {
      const key = k + ':' + p.ids[k];
      let e = strong.get(key);
      if (!e) { e = { c: 0, samples: [] }; strong.set(key, e); }
      e.c++;
      if (e.samples.length < 4) e.samples.push(`#${row.id} "${row.name}" [${row.et}]`);
    }
  }
  if (!p.nameKey) continue;
  const bk = `${row.et || '?'}|${p.nameKey}|${p.jurisdiction || ''}`;
  let arr = blocks.get(bk);
  if (!arr) { arr = []; blocks.set(bk, arr); }
  if (arr.length < 200) arr.push({ id: row.id, name: row.name, type: row.et });
}
db.close();

// (A) strong-id collisions
let sidClusters = 0, sidSurplus = 0; const sidBig = [];
for (const [key, e] of strong) {
  if (e.c < 2) continue;
  sidClusters++; sidSurplus += (e.c - 1);
  sidBig.push({ key, c: e.c, samples: e.samples });
}
sidBig.sort((a, b) => b.c - a.c);

// (B) matcher-adjudicated near-dups within blocks
const CAP = 80;
let matchPairs = 0, reviewPairs = 0, mergedClusters = 0, mergedSurplus = 0, oversized = 0, oversizedRows = 0, blocksScanned = 0;
const sampleMatches = [];
for (const [bk, arr] of blocks) {
  if (arr.length < 2) continue;
  if (arr.length > CAP) { oversized++; oversizedRows += arr.length; continue; }
  blocksScanned++;
  const parsed = arr.map((r) => EM.parseEntity({ name: r.name, type: r.type }));
  const parent = arr.map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) {
    const d = EM.matchPair(parsed[i], parsed[j]).decision;
    if (d === 'match') { matchPairs++; parent[find(i)] = find(j); if (sampleMatches.length < 30) sampleMatches.push(`${arr[i].name}  ==  ${arr[j].name}`); }
    else if (d === 'review') reviewPairs++;
  }
  const groups = new Map();
  for (let i = 0; i < arr.length; i++) { const r = find(i); groups.set(r, (groups.get(r) || 0) + 1); }
  for (const sz of groups.values()) if (sz > 1) { mergedClusters++; mergedSurplus += (sz - 1); }
}

console.log('== BASELINE v2 (read-only, precision-grade) ==');
console.log('total entities scanned:', total);
console.log('\n(A) STRONG-ID collisions (same id on >1 node = DEFINITE dups, 0 false-pos):');
console.log('    id-collision clusters:', sidClusters, '  surplus dup rows:', sidSurplus);
console.log('    top id-collisions:');
for (const b of sidBig.slice(0, 12)) { console.log(`      [${b.c}x] ${b.key}`); for (const s of b.samples.slice(0, 3)) console.log('           ', s); }
console.log('\n(B) MATCHER-adjudicated near-dups (block = type+nameKey+jurisdiction, entity_match.matchPair):');
console.log('    blocks scanned (2..' + CAP + '):', blocksScanned, ' | oversized blocks (>' + CAP + ', flagged not scanned):', oversized, '(', oversizedRows, 'rows )');
console.log("    MATCH pairs (matcher-confident dups):", matchPairs);
console.log("    REVIEW pairs (ambiguous → queue, NOT auto-merged):", reviewPairs);
console.log('    merged dup clusters:', mergedClusters, '  surplus rows collapsed:', mergedSurplus);
console.log('\n    sample MATCH pairs (eyeball precision):');
for (const s of sampleMatches.slice(0, 20)) console.log('      ', s);
process.exit(0);
