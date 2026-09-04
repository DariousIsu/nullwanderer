/* smoke_markers.js — stage 4.5 (2026-09-04): THE SUB-AGENT RESULT CONTRACT (markers, from Alpha).
 *
 * A sub-agent returns COMPACT content plus MARKERS — pointers into the memory map — never the raw
 * findings, so the assembler and the challenger read by address and no agent carries another's raw
 * data. Pure contract (marker/parseResult/digest/resolve), the marker-mode brief, and the fold union.
 */
'use strict';
const fs = require('fs'), path = require('path');
const M = require('../lib/markers');

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`); } };

// ── marker(): normalize; reject junk ─────────────────────────────────────────────────────────────
ok(M.marker({ type: 'document', ref: '51497', summary: 'the FL roster' }).id === 'document:51497', 'a valid marker gets an id of type:ref');
ok(M.marker({ type: 'DOCUMENT', ref: ' 51497 ' }).type === 'document' && M.marker({ type: 'document', ref: '51497' }).ref === '51497', 'type lowercases, ref trims');
ok(M.marker({ type: 'nonsense', ref: 'x' }) === null && M.marker({ type: 'document', ref: '' }) === null && M.marker({}) === null, 'an unknown type or a missing ref → null');
ok(M.MARKER_TYPES.includes('target') && M.MARKER_TYPES.includes('entity') && M.MARKER_TYPES.includes('url'), 'the memory-map layers + target + url are marker types');

// ── parseResult(): the SUMMARY / CONTENT / MARKERS / SOURCES shape ───────────────────────────────
const reply = `SUMMARY: Established the Jefferson and Orleans parish leadership.
CONTENT: Jefferson has President Sheng; Orleans council president Moreno. Both terms current.
MARKERS:
- target:Jefferson Parish — President Cynthia Lee Sheng
- target:Orleans Parish — Council President Helena Moreno
- document:51497 — the compiled parish roster (query: louisiana parish leadership)
- entity:e_sheng
- url:https://jeffparish.net/council
SOURCES: https://jeffparish.net/council, https://council.nola.gov`;
let r = M.parseResult(reply);
ok(r.parsed && /Jefferson and Orleans/.test(r.summary), 'the SUMMARY line parses');
ok(/President Sheng/.test(r.content) && r.content.length < M.CONTENT_CAP, 'the CONTENT parses, bounded');
ok(r.markers.length === 5 && r.markers.filter((m) => m.type === 'target').length === 2, 'the MARKERS block parses (2 target markers + 3 address markers)');
ok(r.markers.find((m) => m.type === 'document').ref === '51497' && r.markers.find((m) => m.type === 'document').query === 'louisiana parish leadership', 'a marker carries its ref and its retrieval query');
ok(r.sources.length === 2 && r.sources[0] === 'https://jeffparish.net/council', 'SOURCES are the deduplicated urls');
// [[type:ref]] form + a legacy prose reply
ok(M.parseResult('MARKERS:\n[[entity:e_42]] the sponsor\n[[fact:f_9]] the vote').markers.length === 2, 'the [[type:ref]] marker form parses');
const legacy = M.parseResult('Just some prose with no shape at all, a paragraph of raw findings.');
ok(!legacy.parsed && legacy.markers.length === 0 && /paragraph of raw/.test(legacy.content), 'a legacy prose reply is kept as content (addressless), never lost');

// ── resultContract(): the instruction that asks for the contract ─────────────────────────────────
const rc = M.resultContract({ compactWords: 200 });
ok(/MUST be COMPACT — never a raw dump/.test(rc) && /Store your raw findings/.test(rc) && /SUMMARY:/.test(rc) && /MARKERS:/.test(rc) && /under ~200 words/.test(rc), 'the contract instruction asks for compact content + stored raw + markers');

// ── digest(): the compact carry — summaries, never raw ───────────────────────────────────────────
const d = M.digest(r, { maxChars: 2000 });
ok(/Established the Jefferson/.test(d) && /markers: target:Jefferson Parish/.test(d) && /sources: https/.test(d), 'the digest carries the summary, the marker summaries and the sources');
ok(M.digest(r, { maxChars: 40 }).length <= 41 && M.digest(r, { maxChars: 40 }).endsWith('…'), 'the digest is bounded (elided past maxChars)');
ok(!/raw findings behind/.test(M.digest(M.parseResult('CONTENT: x\nMARKERS:\n- document:9 — big raw doc'))), 'the digest never pulls the raw text a marker points at');

// ── resolve() / resolveAll(): read BY ADDRESS through injected resolvers ──────────────────────────
(async () => {
  const store = { document: { 51497: 'THE FULL PARISH ROSTER TEXT — 64 rows.' }, entity: { e_sheng: 'Cynthia Lee Sheng — parish president since 2020.' } };
  const resolvers = {
    document: (ref) => store.document[ref] || null,
    entity: async (ref) => store.entity[ref] || null,
    url: () => { throw new Error('network'); },
  };
  ok((await M.resolve(r.markers.find((m) => m.type === 'document'), resolvers)) === 'THE FULL PARISH ROSTER TEXT — 64 rows.', 'resolve reads a document marker by address');
  ok((await M.resolve(r.markers.find((m) => m.type === 'entity'), resolvers)).startsWith('Cynthia'), 'resolve awaits an async resolver');
  ok((await M.resolve(r.markers.find((m) => m.type === 'url'), resolvers)) === null, 'a resolver that throws → null (fail-soft, never a crash)');
  ok((await M.resolve(r.markers.find((m) => m.type === 'target'), resolvers)) === null, 'a type with no resolver → null');
  const all = await M.resolveAll(r.markers, resolvers, { maxChars: 24000 });
  ok(/THE FULL PARISH ROSTER TEXT/.test(all) && /Cynthia Lee Sheng/.test(all) && /--- document:51497/.test(all), 'resolveAll pulls the raw for the markers that resolve, labeled by address');
  const bounded = await M.resolveAll(r.markers, resolvers, { maxChars: 30 });
  ok(bounded.length <= 60, 'resolveAll is bounded by maxChars');

  // ── the fold union: FOUND lines OR target markers → coverage; address markers kept ──────────────
  const PF = require('../lib/partition_fold');
  const targets = ['Jefferson Parish', 'Orleans Parish', 'St. Charles Parish'];
  const fr = PF.foldResult({ output: reply, targets });
  ok(fr.covered.length === 2 && fr.covered.includes('Jefferson Parish') && fr.covered.includes('Orleans Parish') && !fr.covered.includes('St. Charles Parish'), 'foldResult covers exactly the targets the target-markers name');
  ok(fr.addressMarkers.length === 3 && fr.addressMarkers.every((m) => m.type !== 'target'), 'foldResult separates the address markers (document/entity/url) from the target markers');
  ok(fr.summary && fr.content && fr.sources.length === 2, 'foldResult carries the summary, content and sources');
  // backward compatible: a FOUND-shape reply (no markers) still covers via FOUND lines
  const foundReply = 'FOUND:\n- Jefferson Parish — President Sheng (https://a)\n- Orleans Parish — Moreno\nNOT FOUND:\n- St. Charles Parish\nSOURCES: https://a';
  const fr2 = PF.foldResult({ output: foundReply, targets });
  ok(fr2.covered.length === 2 && fr2.addressMarkers.length === 0 && fr2.notFound.length === 1, 'a FOUND-only reply still covers via FOUND lines (backward compatible)');
  // union: FOUND line for one, target marker for another
  const mixed = 'FOUND:\n- Jefferson Parish — x\nMARKERS:\n- target:Orleans Parish — y\n- document:5';
  const fr3 = PF.foldResult({ output: mixed, targets });
  ok(fr3.covered.length === 2 && fr3.addressMarkers.length === 1, 'coverage is the UNION of FOUND lines and target markers');

  // ── the marker-mode brief ───────────────────────────────────────────────────────────────────────
  const EP = require('../lib/executor_pick');
  const bm = EP.brief({ goal: 'compile parish leadership', targets: ['Jefferson Parish', 'Orleans Parish'], index: 1, of: 2, markers: true });
  ok(/MUST be COMPACT/.test(bm) && /SUMMARY:/.test(bm) && /MARKERS:/.test(bm) && /target:<the target name exactly as listed>/.test(bm) && /1\. Jefferson Parish/.test(bm), 'the marker-mode brief asks for the contract with a target-marker per established target');
  const bf = EP.brief({ goal: 'g', targets: ['x'], index: 1, of: 1 });
  ok(/FOUND: <one line per target/.test(bf) && !/MARKERS:/.test(bf), 'the default brief is unchanged (FOUND shape) — markers are opt-in');

  // ── the wiring: the executor fold keeps the address markers on the part ─────────────────────────
  const se = fs.readFileSync(path.join(__dirname, '..', 'lib', 'swarm_executors.js'), 'utf8');
  ok(/const \{ foldResult \} = require\('\.\/partition_fold'\)/.test(se) && /foldResult\(\{ output: run\.output/.test(se) && /part\.markers = f\.addressMarkers/.test(se), 'foldEchoPartition folds through foldResult and keeps the address markers on the part for the assembler');

  console.log(`\nsmoke_markers: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
