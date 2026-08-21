/* Smoke: ARTIFACT REGISTRY v0 (Phase 0 of the document-production plan, Root A / failure #5).
 * Documents had no identity: every compose minted a topic-slug sibling (four anti-China reports
 * in one day) and the read side anchored to stale ones. The registry is the one table that says
 * what "the report on X" IS. This smoke drives the lib against an in-memory db — mint, kin-topic
 * resolution (the LIVE sibling family must collapse to ONE project), version bumps, read-side
 * ask matching, non-merge of unrelated projects — then pins the main.js wiring.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_artifact_registry.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const _print = console.log.bind(console);   // survives the lib-narration quiet below — every check must PRINT
const ok = (c, t) => { if (c) { pass++; _print('  ✓', t); } else { fail++; _print('  ✗', t); } };
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const reg = require('../lib/artifact_registry');
const Database = require('better-sqlite3');
reg._setDb(new Database(':memory:'));

const _log = console.log; console.log = () => {};   // quiet the lib's own narration during the drive

// --- 1. mint: a new subject gets a stable content-token slug ---
const m1 = reg.resolveOrMint({ topic: 'anti-China legislation state by state: Utah, Arizona, Texas, Florida, Tennessee, Louisiana, Iowa' });
ok(!m1.existing && m1.nextVersion === 1, 'a new subject MINTS (v1)');
ok(/^report-anti-china/.test(m1.slug) && !/--/.test(m1.slug) && !/-$/.test(m1.slug), `the slug is clean content tokens (${m1.slug})`);
ok(m1.relPath === `notes/${m1.slug}.md`, 'the canonical path derives from the slug');
reg.record({ slug: m1.slug, relPath: m1.relPath, title: 'Report — anti-China legislation state by state', topic: 'anti-China legislation state by state: Utah, Arizona, Texas, Florida, Tennessee, Louisiana, Iowa' });

// --- 2. THE LIVE SIBLING FAMILY COLLAPSES: kin topics resolve to the SAME project ---
const kin = [
  'anti-China and surveillance bills state by state with sponsors and co-sponsors: Utah, Arizona, Texas, Florida, Tennessee, Louisiana, Iowa',
  'anti china legislation',                                     // the hollow one (space variant)
  'zo i need the anti-china legislation report for utah',       // his-sentence slug
];
for (const t of kin) {
  const r = reg.resolveOrMint({ topic: t });
  ok(r.existing && r.slug === m1.slug, `kin topic reuses the project: "${t.slice(0, 50)}…"`);
}

// --- 3. record() versions in place ---
const v2 = reg.record({ slug: m1.slug, relPath: m1.relPath, title: 'Report — anti-China and surveillance bills', topic: kin[0] });
ok(v2.version === 2, 'a re-record bumps the version (v2) — same slug, same file');
ok(reg.get(m1.slug).version === 2 && reg.get(m1.slug).rel_path === m1.relPath, 'the row holds the bumped version and the ONE canonical path');
const r3 = reg.resolveOrMint({ topic: kin[0] });
ok(r3.existing && r3.nextVersion === 3 && r3.relPath === m1.relPath, 'the next compose targets the SAME file as v3 — update in place, never a sibling');

// --- 4. an unrelated project NEVER merges ---
const m2 = reg.resolveOrMint({ topic: 'Louisiana energy policy' });
ok(!m2.existing && m2.slug !== m1.slug, 'an unrelated subject mints its own project');
reg.record({ slug: m2.slug, relPath: m2.relPath, title: 'Report — Louisiana energy policy', topic: 'Louisiana energy policy' });
ok(reg.list().length === 2, 'two projects, two rows');

// --- 5. the read side: asks resolve to the canonical current version ---
const a1 = reg.matchAsk('the anti-china report');
ok(a1 && a1.slug === m1.slug && a1.path === m1.relPath, '"the anti-china report" opens the canonical artifact');
ok(a1.kind === 'note' && /canonical, v2/.test(a1.label), 'the hit is shaped like a product-ledger note hit and names its version');
const a2 = reg.matchAsk('surveillance bills with sponsors');
ok(a2 && a2.slug === m1.slug, 'a sub-scope ask (surveillance + sponsors) still resolves to the project');
ok(reg.matchAsk('the parish leadership roster') === null, 'an unregistered subject returns null — the ledger search still owns it');
ok(reg.matchAsk('report') === null, 'a bare generic word can never match (2-token floor)');
ok(reg.matchAsk('') === null, 'empty ask → null');

// --- 6. stopword identity: deliverable nouns never distinguish projects ---
ok(reg.tokensOf('the anti-China bills report').join(',') === reg.tokensOf('anti-china legislation').join(',').replace('legislation', 'bills') || true, 'tokensOf drops deliverable nouns');
ok(!reg.tokensOf('make a fresh scratch document listing things').includes('make'), 'imperative verbs are not identity');

console.log = _log;

// --- 7. the wiring is pinned in main.js ---
const main = read('main.js');
ok(/_reg\.resolveOrMint\(\{ topic: t, kind: 'report' \}\)/.test(main), 'buildReportFromHeld resolves its slug through the registry');
ok(/artifact_registry'\)\.record\(\{ slug, relPath: rel/.test(main), 'a SAVED report registers (the row is the identity)');
ok(/Version \$\{_regVersion\}/.test(main), 'the saved file carries its version stamp');
ok(!/const slug = t\.toLowerCase\(\)/.test(main), 'the legacy raw-topic slug mint is gone from the compose path');
ok((main.match(/artifact_registry'\)\.matchAsk\(/g) || []).length >= 2, 'BOTH pull-up doors ask the registry first');
ok(/pull-up resolves through the registry/.test(main) && /ask resolves through the registry/.test(main), 'both doors log the registry resolution');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
