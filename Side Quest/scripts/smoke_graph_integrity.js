/**
 * scripts/smoke_graph_integrity.js — lib/graph_integrity.js, offline.
 *
 * The module is pure (rows in, plan out) so every assertion here is hermetic: no database, no
 * network. The cases are the ones that actually bit while doing this by hand — QID-suffixed names,
 * bare vs. state-qualified names, and the difference between "missing" and "exists but unattached".
 */
'use strict';

const G = require('../lib/graph_integrity');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.log('  FAIL: ' + msg); } }

// --- normalisation ---------------------------------------------------------------------------
ok(G.stripQid('Sonoma County [wd:Q108067]') === 'Sonoma County', 'stripQid removes a QID suffix');
ok(G.stripQid('Sonoma County') === 'Sonoma County', 'stripQid leaves a bare name alone');
ok(G.normName("St. Mary's Parish") === 'st marys parish', 'normName folds punctuation and case');

// The three shapes the graph actually stores must key to the SAME county.
const k = G.countyKey('Acadia Parish', 'LA');
ok(G.countyKey('Acadia Parish, Louisiana', 'LA') === k, 'state-qualified name keys the same');
ok(G.countyKey('Acadia Parish [wd:Q123]', 'LA') === k, 'QID-suffixed name keys the same');
ok(G.countyKey('acadia parish', 'la') === k, 'case-insensitive');
ok(G.countyKey('Acadia Parish', 'TX') !== k, 'same county name in another state is a DIFFERENT key');

// --- the expected universe -------------------------------------------------------------------
const exp = G.expectedCounties();
ok(exp.length > 3100 && exp.length < 3200, `expectedCounties ~3,152 (got ${exp.length})`);
const la = exp.filter((e) => e.stateCode === 'LA');
ok(la.length === 64, `Louisiana has 64 parishes (got ${la.length})`);
ok(la.every((e) => e.noun === 'parish'), 'Louisiana counties carry noun=parish');
ok(la.some((e) => e.mintName === 'Acadia Parish, Louisiana'), 'mintName is state-qualified');
const ak = exp.filter((e) => e.stateCode === 'AK');
ok(ak.length > 0 && ak.every((e) => e.noun === 'borough'), 'Alaska uses borough');
// "Washington County" exists in many states — the qualified mintName is what keeps them apart.
const wash = exp.filter((e) => /^Washington County/i.test(e.name));
ok(wash.length > 20, `Washington County appears in many states (${wash.length})`);
ok(new Set(wash.map((w) => w.mintName)).size === wash.length, 'each is a distinct mintName');

// --- the diff --------------------------------------------------------------------------------
const graphPlaces = [
  { id: 1, name: 'Acadia Parish, Louisiana' },        // present + will be parented
  { id: 2, name: 'Allen Parish [wd:Q111]' },          // QID-suffixed, no state in the name
  { id: 3, name: 'Ascension Parish, Louisiana' },     // present, NOT parented
  { id: 4, name: 'Not A County, Louisiana' },         // ignored — not county-shaped
  { id: 5, name: 'Bienville Parish' },                // bare, unresolvable state -> not counted
];
const d = G.diffCounties({ graphPlaces, parentedIds: new Set([1]) });

ok(d.present.some((p) => p.id === 1), 'a state-qualified county is found');
ok(!d.present.some((p) => p.id === 2), 'a bare QID name with no state is NOT credited (cannot place it)');
ok(d.unplaceable.some((r) => r.id === 2), 'it is reported UNPLACEABLE, not silently dropped');
// It still counts as missing — we hold no confirmed object for it — but it is BLOCKED from minting,
// because the unplaceable row may BE it. Minting anyway is how a duplicate gets born.
const allen = d.missing.find((m) => m.name === 'Allen Parish');
ok(allen && allen.blocked, 'a name-collision with an unplaceable row BLOCKS the mint');
ok(!d.missing.find((m) => m.name === 'Acadia Parish'), 'a confirmed county is not missing at all');
const laTargets = G.countyIntegrityBeat('LA', { graphPlaces, parentedIds: new Set([1]) }).enumerate();
ok(laTargets.some((t) => t.action === 'verify' && t.county === 'Allen Parish'),
   'the beat emits it as VERIFY, never as mint');
ok(!laTargets.some((t) => t.action === 'mint' && t.county === 'Allen Parish'), 'and never as mint');

// The graph's OWN parent edge resolves a bare name — the real case: 1,035 counties minted from
// Wikidata are named "Kern County" with no state, but each has a LOCATED_IN edge to its state.
const viaParent = G.diffCounties({
  graphPlaces,
  parentedIds: new Set([1, 2]),
  stateOf: new Map([[2, 'LA']]),
});
ok(viaParent.present.some((p) => p.id === 2), 'stateOf resolves a bare county name');
ok(viaParent.unplaceable.length < d.unplaceable.length, 'stateOf shrinks the unplaceable set');
ok(!viaParent.missing.some((m) => m.name === 'Allen Parish'), 'and it stops reading as missing');
ok(d.unparented.some((p) => p.id === 3), 'a present-but-unattached county is reported unparented');
ok(!d.unparented.some((p) => p.id === 1), 'an attached county is not unparented');
ok(d.missing.some((m) => m.name === 'Bienville Parish' && m.stateCode === 'LA'),
   'a county we cannot place counts as MISSING, not as present');
ok(d.missing.length > 3000, 'with an almost-empty graph nearly everything is missing');
ok(d.coverage > 0 && d.coverage < 0.01, 'coverage reflects the real ratio');
ok(d.byState.LA.expected === 64, 'per-state expected count');

// The two gaps must never be conflated — that conflation is what let 308 counties read as "we have
// counties" while none of them were attached to anything.
ok(!d.missing.some((m) => d.unparented.some((u) => u.key === m.key)),
   'missing and unparented are disjoint');

// --- health ranking --------------------------------------------------------------------------
const health = G.rankTypeHealth(
  [{ entity_type: 'bill', n: 1492837 }, { entity_type: 'event', n: 1641 },
   { entity_type: 'place', n: 7054 }],
  [{ entity_type: 'bill', n: 28299 }, { entity_type: 'event', n: 1264 },
   { entity_type: 'place', n: 1007 }],
);
ok(health[0].entityType === 'event', 'ranks by how BROKEN a type is, not how big');
ok(health[health.length - 1].entityType === 'bill', 'the 1.49M-row type ranks last at 2% isolated');
ok(Math.abs(health[0].isolatedPct - 0.77) < 0.01, 'event is ~77% isolated');

// --- the beat contract -------------------------------------------------------------------------
const beat = G.countyIntegrityBeat('LA', { graphPlaces, parentedIds: new Set([1]) });
ok(beat.id === 'graph-integrity-counties-la', 'beat id');
ok(beat.parentBeat === 'graph-integrity' && beat.kind === 'integrity', 'beat kind/parent');
ok(beat.universeSize() === 64, 'universeSize is the real roster, not the gap');
const targets = beat.enumerate();
ok(targets.length > 0, 'enumerate returns repair targets');
ok(targets.every((t) => t.stateCode === 'LA'), 'a state beat only emits its own state');
ok(targets.some((t) => t.action === 'mint'), 'emits mint targets');
ok(targets.some((t) => t.action === 'parent' && t.id === 3), 'emits a parent target for the unattached one');
ok(typeof beat.enumerate === 'function' && typeof beat.universeSize === 'function',
   'same descriptor contract as lib/beats.js');

// enumerate() is a CLOSURE over the live snapshot: repair the graph, and the worklist shrinks.
// Avoyelles, not Bienville — Bienville collides with the unplaceable bare row above and is therefore
// a `verify`, never a `mint`, so it could not demonstrate a mint being retired.
const repaired = G.countyIntegrityBeat('LA', {
  graphPlaces: [...graphPlaces, { id: 9, name: 'Avoyelles Parish, Louisiana' }],
  parentedIds: new Set([1, 3, 9]),
});
const before = targets.filter((t) => t.action === 'mint').length;
const after = repaired.enumerate().filter((t) => t.action === 'mint').length;
ok(after === before - 1, 'landing a repair removes it from the worklist (coverage is graph health)');

ok(G.countyIntegritySubBeats(null).length === 51, 'one sub-beat per county-governing state');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
