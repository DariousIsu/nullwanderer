/* ONE-TIME migration: seed artifact registry v0 with the anti-China project and archive its
 * slug-siblings (Phase 0 of the document-production plan, Root A / failure #5).
 *
 * What it does, exactly once (idempotent — a re-run no-ops on every step already done):
 *   1. mints the project slug through the registry itself (same code path as a live compose),
 *   2. moves the CURRENT unified report (promise#2100's delivery) to the clean canonical path,
 *   3. registers it (slug → canonical path, the full topic, v1 of the registered identity),
 *   4. archives the three stale siblings into notes/_archive/ (moved, never deleted).
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/migrate_artifact_registry_v0.js
 */
'use strict';
process.chdir(require('path').join(__dirname, '..'));
const fs = require('fs');
const path = require('path');
const db = require('../lib/db'); db.init();
const filesLib = require('../lib/files');
const reg = require('../lib/artifact_registry');

const TOPIC = 'anti-China and surveillance bills state by state with sponsors and co-sponsors: Utah, Arizona, Texas, Florida, Tennessee, Louisiana, Iowa';
const CURRENT = 'notes/report-anti-china-and-surveillance-bills-state-.md';
const SIBLINGS = [
  'notes/report-anti-china-legislation-state-by-state-ut.md',
  'notes/report-anti-china-legislation.md',
  'notes/report-zo-i-need-the-anti-china-legislation-rep.md',
];

const r = reg.resolveOrMint({ topic: TOPIC, kind: 'report' });
console.log(`project: ${r.slug} (existing=${r.existing}) → ${r.relPath}`);

const canonAbs = filesLib.resolvePath(r.relPath);
const curAbs = filesLib.resolvePath(CURRENT);
if (!fs.existsSync(canonAbs)) {
  if (!fs.existsSync(curAbs)) { console.error(`NEITHER the canonical nor the current file exists — nothing to seed (looked for ${CURRENT})`); process.exit(1); }
  fs.renameSync(curAbs, canonAbs);
  console.log(`moved ${CURRENT} → ${r.relPath}`);
} else {
  console.log(`canonical already in place: ${r.relPath}`);
}

if (!reg.get(r.slug)) {
  const rec = reg.record({ slug: r.slug, relPath: r.relPath, title: 'Report — anti-China and surveillance bills state by state with sponsors and co-sponsors', topic: TOPIC });
  console.log(`registered ${rec.slug} v${rec.version}`);
} else {
  console.log(`already registered: ${r.slug} v${reg.get(r.slug).version}`);
}

const archDir = filesLib.resolvePath('notes/_archive');
fs.mkdirSync(archDir, { recursive: true });
let moved = 0;
for (const rel of SIBLINGS) {
  const abs = filesLib.resolvePath(rel);
  if (!fs.existsSync(abs)) { console.log(`sibling already gone: ${rel}`); continue; }
  fs.renameSync(abs, path.join(archDir, path.basename(abs)));
  console.log(`archived ${rel} → notes/_archive/`);
  moved++;
}
console.log(`DONE — registry rows: ${reg.list().length}, siblings archived this run: ${moved}`);
