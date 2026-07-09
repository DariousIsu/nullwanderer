/* Smoke: lib/supersession — Milestone D2 deterministic supersession candidates (offline, pure).
 * THE GATE (build plan): the anti-pattern test — a late-arriving OLD fact (newer created_at, OLDER
 * valid_from) must NOT supersede the newer truth. Plus: termination on valid_to, functional-predicate
 * replacement on valid_from, confidence floor, non-functional untouched, cycle-guarded, proposal-only.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_supersession.js
 */
'use strict';
const S = require('../lib/supersession');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

// unix-seconds anchors + an ms "now"
const NOW_MS = 1_700_000_000_000;          // ~2023-11
const T2019 = 1_546_300_800, T2020 = 1_577_836_800, T2023 = 1_672_531_200, FUTURE = 2_000_000_000;

// --- TERMINATION: valid_to already passed ---
const termEdges = [
  { id: 1, source_id: 10, target_id: 20, relation: 'HELD_OFFICE', validTo: T2020 },   // expired
  { id: 2, source_id: 10, target_id: 21, relation: 'HELD_OFFICE', validTo: FUTURE },   // still valid
  { id: 3, source_id: 10, target_id: 22, relation: 'HELD_OFFICE', validTo: null },      // no end → current
];
const term = S.terminationCandidates(termEdges, { now: NOW_MS });
ok(term.length === 1 && term[0].edgeId === 1 && term[0].reason === 'valid_to_passed', 'termination: only the edge whose valid_to has passed is a candidate');
ok(!term.some((c) => c.edgeId === 2 || c.edgeId === 3), 'termination: a future / open-ended validity is NOT terminated');

// --- REPLACEMENT: functional predicate, later valid_from supersedes earlier (different value) ---
const ceoEdges = [
  { id: 11, source_id: 100, target_id: 200, relation: 'HAS_CEO', validFrom: T2019, confidence: 0.9, createdAt: T2019 },  // old CEO
  { id: 12, source_id: 100, target_id: 201, relation: 'HAS_CEO', validFrom: T2023, confidence: 0.9, createdAt: T2023 },  // new CEO
];
const repl = S.replacementCandidates(ceoEdges);
ok(repl.length === 1 && repl[0].supersededId === 11 && repl[0].supersededBy === 12, 'replacement: the earlier-valid CEO (id 11) is superseded by the later (id 12)');
ok(repl[0].reason === 'newer_valid_from' && repl[0].kind === 'replacement', 'replacement: reason = newer_valid_from');

// --- THE ANTI-PATTERN GATE: a late-arriving OLD fact must NOT supersede the newer truth ---
const antiEdges = [
  // the NEWER TRUTH: valid_from 2023, ingested EARLY (2023)
  { id: 21, source_id: 300, target_id: 400, relation: 'HAS_CHAIR', validFrom: T2023, confidence: 0.9, createdAt: T2023 },
  // a LATE-ARRIVING OLD FACT: valid_from 2019 (older), but created_at is the NEWEST (just ingested now)
  { id: 22, source_id: 300, target_id: 401, relation: 'HAS_CHAIR', validFrom: T2019, confidence: 0.9, createdAt: NOW_MS / 1000 },
];
const anti = S.replacementCandidates(antiEdges);
ok(anti.length === 1 && anti[0].supersededBy === 21, 'ANTI-PATTERN: the later-VALID fact (id 21) wins — decided on valid_from, NOT created_at');
ok(anti[0].supersededId === 22, 'ANTI-PATTERN: the late-arriving OLD fact (id 22, newest created_at, oldest valid_from) is the LOSER — it never supersedes the newer truth');

// --- CONFIDENCE FLOOR: never supersede on a weak new fact ---
const weakWinner = [
  { id: 31, source_id: 500, target_id: 600, relation: 'SUBSIDIARY_OF', validFrom: T2019, confidence: 0.9 },
  { id: 32, source_id: 500, target_id: 601, relation: 'SUBSIDIARY_OF', validFrom: T2023, confidence: 0.3 },  // newer but weak
];
ok(S.replacementCandidates(weakWinner, { confFloor: 0.5 }).length === 0, 'confidence floor: a below-floor superseding fact does NOT generate a candidate (never overwrite on weak evidence)');
ok(S.replacementCandidates(weakWinner, { confFloor: 0.2 }).length === 1, 'confidence floor: lowering the floor lets it through (the gate is the floor, not the fact)');

// --- NON-FUNCTIONAL predicate is multi-valued → never a replacement ---
const memberEdges = [
  { id: 41, source_id: 700, target_id: 800, relation: 'MEMBER_OF', validFrom: T2019, confidence: 0.9 },
  { id: 42, source_id: 700, target_id: 801, relation: 'MEMBER_OF', validFrom: T2023, confidence: 0.9 },
];
ok(S.replacementCandidates(memberEdges).length === 0, 'non-functional: two MEMBER_OF values coexist (a person is member of many) → NO replacement');

// --- edge cases ---
ok(S.replacementCandidates([{ id: 51, source_id: 900, target_id: 1, relation: 'HAS_CEO', validFrom: T2023, confidence: 0.9 }]).length === 0, 'single functional value → no candidate (nothing to replace)');
const sameTarget = [
  { id: 61, source_id: 1000, target_id: 1, relation: 'HAS_CEO', validFrom: T2019, confidence: 0.9 },
  { id: 62, source_id: 1000, target_id: 1, relation: 'HAS_CEO', validFrom: T2023, confidence: 0.9 },  // SAME CEO, later tenure
];
ok(S.replacementCandidates(sameTarget).length === 0, 'same target (same value re-affirmed) → NOT a replacement (that is re-verification, not supersession)');
const noVf = [
  { id: 71, source_id: 1100, target_id: 1, relation: 'HAS_CEO', confidence: 0.9 },
  { id: 72, source_id: 1100, target_id: 2, relation: 'HAS_CEO', confidence: 0.9 },
];
ok(S.replacementCandidates(noVf).length === 0, 'no valid_from → cannot order deterministically → left for the operator/LLM lane (never guessed)');

// --- combined: supersessionCandidates = termination ∪ replacement ---
const combined = S.supersessionCandidates([...termEdges, ...ceoEdges], { now: NOW_MS });
ok(combined.filter((c) => c.kind === 'termination').length === 1 && combined.filter((c) => c.kind === 'replacement').length === 1, 'supersessionCandidates: combines termination + replacement');
// cycle guard: never both A→B and B→A for a replacement pair
const dirs = new Set(combined.filter((c) => c.kind === 'replacement').map((c) => `${c.supersededId}->${c.supersededBy}`));
ok(![...dirs].some((d) => { const [a, b] = d.split('->'); return dirs.has(`${b}->${a}`); }), 'cycle guard: no replacement pair appears in both directions (no A⇄B lineage cycle)');

// nothing here mutates — proposal-only
ok(Array.isArray(combined) && combined.every((c) => c.kind === 'termination' || c.kind === 'replacement'), 'proposal-only: returns candidate descriptors, never writes/expires an edge');

// --- worldYear: comparable WORLD-TIME year, NEVER a bogus epoch year ---
ok(S.worldYear(2023) === 2023, 'worldYear: a year int passes through');
ok(S.worldYear('2019-05-01') === 2019 && S.worldYear('became CEO in 2021') === 2021, 'worldYear: extracts the 4-digit year from a date / prose string');
ok(S.worldYear(T2023) === 2023 && S.worldYear(T2019) === 2019, 'worldYear: a unix-seconds epoch → its year (not misread digit-by-digit)');
ok(S.worldYear(null) === null && S.worldYear(999) === null && S.worldYear('no year here') === null, 'worldYear: junk / no-year → null');

// --- worldEpoch: valid_to world-time as epoch SECONDS (matches terminationCandidates' comparison) ---
ok(S.worldEpoch(2020) === Math.floor(Date.UTC(2020, 0, 1) / 1000), 'worldEpoch: a bare year → Jan 1 epoch-seconds');
ok(S.worldEpoch('2021-06-15') === Math.floor(Date.UTC(2021, 5, 15) / 1000), 'worldEpoch: an ISO date → its epoch-seconds');
ok(S.worldEpoch(T2020) === T2020, 'worldEpoch: an epoch-seconds value passes through');
ok(S.worldEpoch(null) === null && S.worldEpoch('nope') === null, 'worldEpoch: junk → null');
// the unit-bug regression guard: a real-data edge (year in metadata) must NOT read as terminated in ~2023.
const notExpired = S.edgesFromRows([{ id: 9, source_id: 1, target_id: 2, rt: 'HELD_OFFICE', md: JSON.stringify({ valid_to: 2099 }) }]);
ok(S.terminationCandidates(notExpired, { now: NOW_MS }).length === 0, 'unit-bug guard: a future valid_to YEAR from metadata is NOT flagged terminated (worldEpoch keeps units consistent)');

// --- edgesFromRows: world-time valid_from from METADATA (tenure_start/valid_from), not the column ---
const rows = [
  { id: 1, source_id: 100, target_id: 200, rt: 'HAS_CEO', confidence: 0.9, md: JSON.stringify({ tenure_start: '2020-03-01' }), sn: 'Acme', tn: 'Old CEO' },
  { id: 2, source_id: 100, target_id: 201, rt: 'HAS_CEO', confidence: 0.9, md: JSON.stringify({ valid_from: 2023 }), sn: 'Acme', tn: 'New CEO' },
];
const built = S.edgesFromRows(rows);
ok(built[0].validFrom === 2020 && built[1].validFrom === 2023, 'edgesFromRows: valid_from parsed from metadata (tenure_start / valid_from), year-normalized');
ok(built[0].sourceName === 'Acme' && built[0].targetName === 'Old CEO', 'edgesFromRows: carries joined subject + target names');
// valid_to from metadata (tenure_end) OR the valid_to COLUMN fallback → epoch-seconds
const vtRows = S.edgesFromRows([
  { id: 5, source_id: 1, target_id: 2, rt: 'HELD_OFFICE', md: JSON.stringify({ tenure_end: '2020-01-01' }) },
  { id: 6, source_id: 1, target_id: 3, rt: 'HELD_OFFICE', md: '{}', valid_to: T2023 },   // column fallback
]);
ok(vtRows[0].validTo === Math.floor(Date.UTC(2020, 0, 1) / 1000), 'edgesFromRows: valid_to from metadata tenure_end → epoch-seconds');
ok(vtRows[1].validTo === T2023, 'edgesFromRows: valid_to falls back to the valid_to COLUMN when metadata lacks it (what C1 lands)');

(async () => {
  // --- runReplacementScan: reads functional edges via dispatch → replacement candidates (proposal-only) ---
  const dispatch = async () => ({ ok: true, text: JSON.stringify({ rows }) });
  const scan = await S.runReplacementScan({ dispatch });
  ok(scan.summary.assessed === 2 && scan.summary.candidates === 1, 'runReplacementScan: 2 functional edges assessed → 1 replacement candidate');
  ok(scan.candidates[0].supersededBy === 2 && scan.candidates[0].winnerTarget === 'New CEO' && scan.candidates[0].subjectName === 'Acme', 'runReplacementScan: candidate carries the winning edge + subject/target names for operator review');
  ok((await S.runReplacementScan({})).summary.candidates === 0, 'runReplacementScan: no dispatch → empty (fail-soft)');
  const scanErr = await S.runReplacementScan({ dispatch: async () => { throw new Error('db down'); } });
  ok(scanErr.candidates.length === 0 && scanErr.summary.error === true, 'runReplacementScan: a db_query failure → empty + error flag (never throws)');

  // --- runTerminationScan: reads valid_to-bearing edges via dispatch → termination candidates (proposal-only) ---
  const termRows = [
    { id: 21, source_id: 1, target_id: 2, rt: 'HELD_OFFICE', confidence: 0.9, md: '{}', valid_to: T2020, sn: 'Rep A', tn: 'member of the Old Chamber' }, // expired
    { id: 22, source_id: 1, target_id: 3, rt: 'HELD_OFFICE', confidence: 0.9, md: '{}', valid_to: FUTURE, sn: 'Rep A', tn: 'member of the Current Chamber' }, // still valid
  ];
  const tScan = await S.runTerminationScan({ dispatch: async () => ({ ok: true, text: JSON.stringify({ rows: termRows }) }), now: NOW_MS });
  ok(tScan.summary.assessed === 2 && tScan.summary.candidates === 1, 'runTerminationScan: 2 valid_to edges assessed → 1 termination candidate (the expired one)');
  ok(tScan.candidates[0].edgeId === 21 && tScan.candidates[0].reason === 'valid_to_passed', 'runTerminationScan: flags only the edge whose valid_to has passed');
  ok((await S.runTerminationScan({})).summary.candidates === 0, 'runTerminationScan: no dispatch → empty (fail-soft)');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
