/* Smoke: lib/strongid_backfill.findBackfillMerges — the precision-bounded strong-id backfill fusion lever.
 * A non-person node lacking a wikidata id that UNIQUELY matches a QID-bearing anchor (same type + normKey +
 * compatible jurisdiction, no conflicting strong id) folds INTO that anchor. Persons are excluded; ambiguity,
 * jurisdiction conflict, and cross-system id conflict all block the fold. The anchor is always the survivor.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_strongid_backfill.js
 */
'use strict';
const BF = require('../lib/strongid_backfill');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const clusterFor = (mani, dupId) => mani.find((c) => c.duplicateIds.includes(dupId));

// 1) THE UNIVERSITY OF MONTANA CASE — the lda-client org twin folds into the Q-tagged anchor.
{
  const rows = [
    { id: 1, name: 'University of Montana [Q2302336]', entity_type: 'organization', degree: 40 },
    { id: 2, name: 'UNIVERSITY OF MONTANA [lda_client:161050]', entity_type: 'organization', degree: 5 },
  ];
  const { manifest, stats } = BF.findBackfillMerges(rows);
  const c = clusterFor(manifest, 2);
  ok(!!c, 'Montana: the no-QID lda-client org is proposed for backfill');
  ok(c && c.canonicalId === 1, 'Montana: the QID anchor (#1) is the survivor — never the higher/other-id twin');
  ok(c && c.duplicateIds.length === 1 && c.duplicateIds[0] === 2, 'Montana: exactly the lda-client node folds in');
  ok(stats.anchors === 1 && stats.totalFolds === 1, 'Montana: 1 anchor, 1 fold');
}

// 2) UNIQUENESS GUARD — a no-jur "Springfield" matches TWO QID anchors (IL + MA) → ambiguous → NO fold;
//    but a jur-qualified "Springfield (IL)" resolves to the single IL anchor.
{
  const rows = [
    { id: 10, name: 'Springfield [Q1] (IL)', entity_type: 'place', degree: 20 },
    { id: 11, name: 'Springfield [Q2] (MA)', entity_type: 'place', degree: 20 },
    { id: 12, name: 'Springfield', entity_type: 'place', degree: 3 },          // no jurisdiction → both anchors compatible
    { id: 13, name: 'Springfield (IL)', entity_type: 'place', degree: 3 },     // IL → only the IL anchor
  ];
  const { manifest } = BF.findBackfillMerges(rows);
  ok(!clusterFor(manifest, 12), 'uniqueness: ambiguous "Springfield" (2 compatible QID anchors) is NOT backfilled');
  const c13 = clusterFor(manifest, 13);
  ok(c13 && c13.canonicalId === 10, 'jurisdiction: "Springfield (IL)" folds into the IL anchor only');
}

// 3) PERSON EXCLUSION — a same-name, same-jurisdiction person with a QID twin is NEVER backfilled.
{
  const rows = [
    { id: 20, name: 'John Q Public (CA) [Q77]', entity_type: 'person', degree: 30 },
    { id: 21, name: 'John Q Public (CA)', entity_type: 'person', degree: 4 },
  ];
  const { manifest, stats } = BF.findBackfillMerges(rows);
  ok(manifest.length === 0 && stats.considered === 0, 'persons: excluded entirely — the name-collision trap the north-star protects');
  const inc = BF.findBackfillMerges(rows, { includePersons: true });
  ok(inc.manifest.length === 1, 'persons: the includePersons override still works (opt-in only)');
}

// 4) CONFLICTING STRONG ID — a node with a DIFFERENT same-system id than the anchor is provably distinct → skip.
{
  const rows = [
    { id: 30, name: 'Acme Water District [Q5] [ocd-organization/aaaa1111]', entity_type: 'organization', degree: 10 },
    { id: 31, name: 'Acme Water District [ocd-organization/bbbb2222]', entity_type: 'organization', degree: 6 },
  ];
  const { manifest, stats } = BF.findBackfillMerges(rows);
  ok(manifest.length === 0 && stats.conflicts === 1, 'conflict: a differing ocd id vs the anchor blocks the fold (provably different entity)');
}

// 5) TYPE ISOLATION + NO-ANCHOR SAFETY — a matching normKey under a different type does not cross; no anchor → no fold.
{
  const rows = [
    { id: 40, name: 'Mercury [Q308] ', entity_type: 'place', degree: 9 },      // the planet
    { id: 41, name: 'Mercury', entity_type: 'organization', degree: 2 },       // a company — different type, must NOT fold
    { id: 42, name: 'Nowhere Unmatched Org', entity_type: 'organization', degree: 1 },
  ];
  const { manifest } = BF.findBackfillMerges(rows);
  ok(!clusterFor(manifest, 41), 'type isolation: a different-type same-name node does not fold across types');
  ok(!clusterFor(manifest, 42), 'no-anchor: an unmatched node is left alone (mint-safe)');
}

// 6) MULTI-FOLD — several no-QID variants of one org all fold into the single anchor.
{
  const rows = [
    { id: 50, name: 'City of Sacramento [Q487844]', entity_type: 'organization', degree: 100 },
    { id: 51, name: 'CITY OF SACRAMENTO [lda_client:1]', entity_type: 'organization', degree: 8 },
    { id: 52, name: 'City Of Sacramento', entity_type: 'organization', degree: 3 },
  ];
  const { manifest } = BF.findBackfillMerges(rows);
  const c = manifest.find((x) => x.canonicalId === 50);
  ok(c && c.duplicateIds.length === 2 && c.duplicateIds.includes(51) && c.duplicateIds.includes(52),
    'multi-fold: both no-QID Sacramento variants fold into the single QID anchor');
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
