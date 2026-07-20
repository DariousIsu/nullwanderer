/* smoke_recovery_encounters.js — the fifth lane, plus the wiki gate that makes it pay.
 *
 * Lucas, 2026-07-20: "we should be able to reuse the same structure as any other pathway, they all
 * mint and enrich objects" — and: "The wiki search should only be for a newly minted object or an
 * object that has no wiki link."
 *
 * news / document / meeting / canvas_drop / conversation all decompose into the encounter log. The
 * enrich ladder did not: a recovery banked a flat `verified_fact` in `knowledge` with the URL as a
 * citation string — no object, no edges, invisible to a later graph walk or corroboration count.
 *
 * The two halves are one mechanism and are tested together on purpose:
 *   • the GATE stops re-fetching an object that already carries a wikidata_qid
 *   • the LANE leaves the link behind when a fetch does happen
 * Ship the gate alone and objects stay unlinked forever while we fetch less. Ship the lane alone and
 * we keep re-fetching what we already know.
 */
'use strict';
const rec = require('../lib/recovery_encounters');
const cognition = require('../lib/cognition');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); } }

const SPANS = [
  { text: 'Caddo Parish Commission', kgType: 'org' },
  { text: 'Shreveport', kgType: 'place' },
  { text: 'Caddo Parish Commission', kgType: 'org' },   // repeat within one page
];

// ── same shape as every other lane ──────────────────────────────────────────────────────────────
{
  const rows = rec.toEncounters(SPANS, { url: 'https://en.wikipedia.org/wiki/Caddo_Parish', source: 'wiki' });
  ok(rows.length === 2, 'one encounter per object per recovery (the repeat collapsed)');
  ok(rows.every((r) => r.claim_class === 'existence'), 'existence only — same honesty bound as the other lanes');
  ok(rows.every((r) => r.source_kind === 'recovery'), 'tagged as its own lane');
  ok(rows[0].source_ref === 'https://en.wikipedia.org/wiki/Caddo_Parish', 'the URL is the source ref');
  ok(rows[0].origin_host === 'en.wikipedia.org', 'origin_host set — corroboration keys on ORIGIN, so ten pages of one site count once');
  ok(rows.every((r) => r.capturedBy === 'wiki'), 'records WHICH tier found it');
  ok(rec.toEncounters(SPANS, { url: null }).length === 0, 'no URL → nothing to attach an object to → no rows');
}

// ── ⭐ AUTHORITY: Wikipedia is ordinary, a .gov is official ──────────────────────────────────────
// 'official' substitutes for roughly one ordinary source (encounters §6.3). A tertiary encyclopedia
// must not buy that, or one wiki page would outweigh real corroboration.
{
  ok(rec.authorityFor('https://en.wikipedia.org/wiki/X') === 'ordinary', 'Wikipedia is ORDINARY, not official');
  ok(rec.authorityFor('https://www.caddo.gov/council') === 'official', 'a .gov host is official');
  ok(rec.authorityFor('https://www.legis.la.gov/x') === 'official', 'a state .gov too');
  ok(rec.authorityFor('https://www.army.mil/x') === 'official', '.mil too');
  ok(rec.authorityFor('https://someblog.substack.com/p/x') === 'ordinary', 'a blog is ordinary');
  ok(rec.authorityFor('not a url') === 'unknown', 'an unparseable source is unknown, not official');
  ok(rec.authorityFor('https://notgov.com/x') === 'ordinary', 'REGRESSION: "gov" inside a name is not a .gov host');
}

(async () => {
// ── ⭐ THE WIKI GATE ─────────────────────────────────────────────────────────────────────────────
{
  let fetched = 0;
  const deps = { wikiLookup: async () => { fetched++; return [{ title: 'X', extract: 'about x' }]; } };

  // already linked → do not go out
  const linked = await cognition._enrichWiki('x', deps, { object: { name: 'X', wikidata_qid: 'Q42' } });
  ok(fetched === 0, 'an object with a wikidata_qid does NOT trigger a wiki fetch');
  ok(linked.skipped === 'already-linked', 'and the skip is reported, not silent');
  ok(linked.text === '', 'a skip yields no grounding, so the ladder moves on');

  // unlinked object → fetch (this is the enrichment that pays)
  const unlinked = await cognition._enrichWiki('x', deps, { object: { name: 'X', wikidata_qid: null } });
  ok(fetched === 1, 'an object with NO wiki link DOES fetch');
  ok(/about x/.test(unlinked.text), 'and returns grounding');

  // no object at all → newly encountered → fetch (the mint case)
  const fresh = await cognition._enrichWiki('x', deps, {});
  ok(fetched === 2, 'a newly-encountered thing (no object) fetches');
  ok(/about x/.test(fresh.text), 'and returns grounding');
}

// ── ⭐ the CURRENCY-VERIFY path must NOT be gated ────────────────────────────────────────────────
// "who is president now?" re-checks whether a fact turned over. Skipping that for a linked object
// would resurrect the confidently-stale answer the path exists to catch.
{
  const fs = require('fs'), path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cognition.js'), 'utf8');
  ok(/tier === 'wiki' \? await _enrichWiki\(topic, deps\)/.test(src),
    'the currency-verify call passes NO object — a linked object can still be re-verified');
  ok(/mode === 'wiki' \? await _enrichWiki\(q, deps, \{ object \}\)/.test(src),
    'the enrichment ladder DOES pass the object, so the gate applies there');
}

// ── the write-back mints objects as well as banking the fact ─────────────────────────────────────
{
  let banked = null, minted = null;
  cognition._kickWriteBack({
    query: 'q', answer: 'a', url: 'https://en.wikipedia.org/wiki/X', source: 'wiki', text: 'page text',
    deps: { writeBack: async (x) => { banked = x; }, recordRecovery: async (x) => { minted = x; return 1; } },
  });
  await new Promise((r) => setTimeout(r, 10));
  ok(banked && banked.url, 'the existing verified_fact write-back still fires');
  ok(minted && minted.url === 'https://en.wikipedia.org/wiki/X', 'AND the object lane fires');
  ok(minted && minted.text === 'page text', 'objects come from the SOURCE text, not the drafted answer');

  let mintedNoUrl = false;
  cognition._kickWriteBack({ query: 'q', answer: 'a', url: null, deps: { recordRecovery: async () => { mintedNoUrl = true; } } });
  await new Promise((r) => setTimeout(r, 10));
  ok(!mintedNoUrl, 'no URL → no minting (unchanged guard)');
}

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
})();
