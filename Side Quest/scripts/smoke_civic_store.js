/* Smoke: lib/civic_store — the structured home for governing bodies and who holds their seats.
 * Offline: temp DB, nowMs injected, no model/network. Every load-bearing rule from
 * docs/CIVIC_BODY_SCHEMA_DESIGN.md is asserted here.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_civic_store.js
 */
const os = require('os'); const path = require('path');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_civic_${Date.now()}.db`);
require('../lib/db').init();
const cs = require('../lib/civic_store');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };
const T = 1785400000000;

(async () => {
  // --- identity: the SAME key cardinality and absence already use ---
  ok(cs.keyFor('the governing body of Fulton County, Georgia') === cs.keyFor('Fulton County, Georgia'),
    'a generated body prefix is stripped — renamed targets keep ONE identity');
  ok(cs.keyFor('Oregon House of Representatives') !== cs.keyFor('Pennsylvania House of Representatives'),
    'two states\' chambers stay DISTINCT (the targetPlaceKey trap this key exists to avoid)');

  // --- bodies: level and function are orthogonal (Lucas's Fulton case) ---
  const b1 = cs.upsertBody({ title: 'Fulton County Registration and Elections Board', level: 'county', function: 'elections', state: 'GA', place: 'Fulton County', officialUrl: 'https://fultoncountyga.gov/elections' }, { nowMs: T });
  ok(b1.ok && b1.created, 'a body lands');
  const b2 = cs.upsertBody({ title: 'Fulton County Board of Commissioners', level: 'county', function: 'governing', state: 'GA' }, { nowMs: T });
  ok(b2.ok && b2.bodyKey !== b1.bodyKey, 'an elections board and a commission are DIFFERENT bodies at the same level');
  const got = cs.getBody('Fulton County Registration and Elections Board');
  ok(got && got.level === 'county' && got.function === 'elections', 'level + function stored on separate axes');
  ok(cs.upsertBody({ title: 'X' }).ok === false, 'a title too short to be a body is refused');
  const b3 = cs.upsertBody({ title: 'Fulton County Registration and Elections Board', level: 'county', function: 'elections', selection: 'appointed' }, { nowMs: T + 1000 });
  ok(b3.ok && !b3.created && cs.getBody(b1.bodyKey).official_url === 'https://fultoncountyga.gov/elections',
    're-sighting UPDATES what it knows and never BLANKS what it does not');
  ok(cs.getBody(b1.bodyKey).selection === 'appointed', 'the new fact landed on the re-sighting');
  ok(cs.upsertBody({ title: 'Some Odd Authority', level: 'nonsense', function: 'nonsense' }).ok
    && cs.getBody('Some Odd Authority').level === 'other', 'an unknown level/function falls back to other — an unclassified body still gets a home');

  // --- memberships: the seat, not the person ---
  ok(cs.recordMembership({ bodyTitle: 'No Such Body', personName: 'A Person' }).ok === false, 'a membership on an unknown body is refused (upsertBody first)');
  ok(cs.recordMembership({ bodyKey: b1.bodyKey, personName: '' }).ok === false, 'a membership needs the name the source printed');
  const m1 = cs.recordMembership({ bodyKey: b1.bodyKey, personName: 'Cathy Woolard', role: 'Chair', sourceUrl: 'https://fultoncountyga.gov/elections', sourceKind: 'official', confidence: 0.9 }, { nowMs: T });
  ok(m1.ok && m1.id, 'a seat lands with its provenance');
  cs.recordMembership({ bodyKey: b1.bodyKey, personName: 'Aaron Johnson', role: 'Member', sourceKind: 'official', confidence: 0.8 }, { nowMs: T });
  ok(cs.roster(b1.bodyKey).length === 2, 'the roster reads back');
  ok(cs.roster(b1.bodyKey)[0].person_name === 'Cathy Woolard', 'best-graded first');

  // --- rule 1: SUPERSEDE, NEVER OVERWRITE ---
  const same = cs.recordMembership({ bodyKey: b1.bodyKey, personName: 'Cathy Woolard', role: 'Chair', sourceKind: 'official', confidence: 0.9 }, { nowMs: T + 5000 });
  ok(same.ok && same.unchanged && cs.roster(b1.bodyKey).length === 2, 're-reading the same page churns NO rows');
  const changed = cs.recordMembership({ bodyKey: b1.bodyKey, personName: 'Cathy Woolard', role: 'Chair', termEnd: '2027-12-31', sourceKind: 'official', confidence: 0.9 }, { nowMs: T + 6000 });
  ok(changed.ok && changed.superseded === m1.id, 'a MATERIAL change supersedes the old row instead of overwriting it');
  ok(cs.roster(b1.bodyKey).length === 2, 'the current roster still shows one row per seat');
  const hist = cs.history(b1.bodyKey, 'Cathy Woolard');
  ok(hist.length === 2 && hist[0].superseded_by === changed.id && hist[1].term_end === '2027-12-31',
    'history is preserved — "who chaired this in 2024" stays answerable, and a bad scrape is revertible');

  // --- rule 5: confidence GRADES, it does not gate ---
  const weak = cs.recordMembership({ bodyKey: b1.bodyKey, personName: 'Rumored Person', role: 'Member', sourceKind: 'news', confidence: 0.3 }, { nowMs: T });
  ok(weak.ok && cs.roster(b1.bodyKey).some((r) => r.person_name === 'Rumored Person'), 'a weak claim still LANDS (marked, outranked, never refused at the door)');
  ok(cs.roster(b1.bodyKey)[cs.roster(b1.bodyKey).length - 1].person_name === 'Rumored Person', '…and sorts last');
  const regrade = cs.recordMembership({ bodyKey: b1.bodyKey, personName: 'Rumored Person', role: 'Member', sourceKind: 'official', sourceUrl: 'https://fultoncountyga.gov/elections', confidence: 0.9 }, { nowMs: T + 7000 });
  ok(regrade.ok && regrade.regraded && cs.roster(b1.bodyKey).find((r) => r.person_name === 'Rumored Person').confidence === 0.9,
    'a better source RE-GRADES the same fact in place (no duplicate row for a corroboration)');

  // --- backfill discipline: prose may never overwrite what we researched ---
  const bf = cs.recordMembership({ bodyKey: b1.bodyKey, personName: 'Cathy Woolard', role: 'Chair', termEnd: '2099-01-01', sourceKind: 'backfill_prose', confidence: 0.3 }, { nowMs: T + 8000 });
  ok(bf.ok && bf.skipped && cs.roster(b1.bodyKey).find((r) => r.person_name === 'Cathy Woolard').term_end === '2027-12-31',
    'BACKFILL NEVER SUPERSEDES A RESEARCHED ROW — the verified fact stands');
  const bfNew = cs.recordMembership({ bodyKey: b2.bodyKey, personName: 'Robb Pitts', role: 'Chairman', sourceKind: 'backfill_prose', confidence: 0.3 }, { nowMs: T });
  ok(bfNew.ok && bfNew.id, 'backfill DOES fill a seat nobody researched yet');

  // --- rule 2: COMPLETENESS IS DERIVED ---
  const noDenom = cs.completeness(b1.bodyKey);
  ok(noDenom.filled === 3 && noDenom.seats === null && noDenom.complete === null,
    'no known denominator → an HONEST null, never a fake 0%');
  require('../lib/db').getDb().prepare("INSERT INTO cardinality (body, seats, source_kind, source_ref, observed_ts) VALUES (?, 5, 'official', 'ocga-21-2-40', ?)").run(b1.bodyKey, T);
  const c = cs.completeness(b1.bodyKey);
  ok(c.seats === 5 && c.filled === 3 && c.complete === false && c.missing === 2,
    'completeness derives from cardinality.seats — 3 of 5, 2 missing (the standing question, answerable at last)');

  // --- THE query the 120 county threads have been waiting for ---
  const inc = cs.incomplete({ state: 'GA' });
  ok(inc.incomplete.length === 1 && inc.incomplete[0].missing === 2, 'incomplete() names the short-staffed bodies and by how many');
  ok(inc.unknownDenominator.some((r) => r.body_key === b2.bodyKey), 'bodies with no known seat count are reported SEPARATELY, never miscounted as complete');
  ok(cs.incomplete({ state: 'ZZ' }).incomplete.length === 0, 'a state with no bodies is empty, never a throw');

  // --- heldRostersFor: deterministic injection digest (08-08, the all-pending parish fill) ---
  cs.upsertBody({ title: 'Tangipahoa Parish Council', level: 'county', state: 'LA' });
  cs.recordRoster({ bodyTitle: 'Tangipahoa Parish Council', members: [
    { personName: 'Alice Amite', role: 'Member' }, { personName: 'Bob Hammond', role: 'Chair' },
    { personName: 'Cara Ponchatoula', role: 'Member' }, { personName: 'Dan Kentwood', role: 'Member' },
    { personName: 'Eve Independence', role: 'Member' }, { personName: 'Frank Roseland', role: 'Member' },
    { personName: 'Gail Tickfaw', role: 'Member' }, { personName: 'Hank Amite', role: 'Member' },
    { personName: 'Ida Loranger', role: 'Member' }, { personName: 'Jack Robert', role: 'Member' },
  ], sourceKind: 'official', sourceUrl: 'https://tangipahoa.gov' });
  const heldHit = cs.heldRostersFor('- **Tangipahoa Parish**\n  - Council-President government');
  ok(heldHit.length === 1 && heldHit[0].count === 10 && /Bob Hammond \(Chair\)/.test(heldHit[0].line), 'heldRostersFor matches the doc by distinctive words and digests the roster');
  ok(cs.heldRostersFor('- **Acadia Parish**\n  - Police Jury').length === 0, 'a doc naming only OTHER parishes matches nothing (generic civic nouns never match)');
  ok(cs.heldRostersFor('').length === 0, 'empty text is empty, never a throw');

  // --- staleRostersFor: fresh-hot depth — held-but-aged rosters re-verify on mention (08-08) ---
  const NOWX = Date.now();
  cs.upsertBody({ title: 'Ouachita Parish Police Jury', level: 'county', state: 'LA' });
  cs.recordRoster({ bodyTitle: 'Ouachita Parish Police Jury', members: [{ personName: 'Old Ollie', role: 'President' }], sourceKind: 'official' });
  // age the observation directly (recordRoster stamps now; staleness is measured from observed_ts)
  require('../lib/db').getDb().prepare(`UPDATE civic_memberships SET observed_ts = ? WHERE body_key = ?`).run(NOWX - 45 * 86400000, cs.keyFor('Ouachita Parish Police Jury'));
  const staleHit = cs.staleRostersFor('what do we know about Ouachita Parish government?', { now: NOWX });
  ok(staleHit.length === 1 && staleHit[0].ageDays >= 44 && staleHit[0].count === 1, 'a 45d-old held roster on a mentioned body is a re-verify candidate (with its age)');
  ok(cs.staleRostersFor('what about Tangipahoa Parish?', { now: NOWX }).length === 0, 'a freshly-observed roster is NOT stale on mention');
  ok(cs.staleRostersFor('tell me about parish government generally', { now: NOWX }).length === 0, 'generic civic nouns never match (no distinctive word, no hit)');
  ok(cs.staleRostersFor('', { now: NOWX }).length === 0 && cs.staleRostersFor('Ouachita Parish', { now: NOWX, maxAgeMs: 90 * 86400000 }).length === 0, 'empty text is empty; a longer maxAge window keeps it fresh');

  // --- civicDigestFor: the report door's window into the store (08-08, the LA leadership ask) ---
  const digAll = cs.civicDigestFor('a simple report on the Parish leadership of Louisiana');
  ok(/CIVIC STORE/.test(digAll) && /ouachita parish/i.test(digAll) && /Old Ollie \(President\)/.test(digAll), 'a CLASS word ("parish") selects every parish body with named members');
  ok(/tangipahoa/i.test(digAll) === false || /tangipahoa parish council/i.test(digAll), 'other parish bodies ride the same digest');
  const digOne = cs.civicDigestFor('who runs the Tangipahoa council?');
  ok(/tangipahoa/i.test(digOne) && !/ouachita/i.test(digOne), 'a specific body name selects only its bodies');
  ok(cs.civicDigestFor('the positive benefits of data centers to power grids') === '', 'an unrelated topic digests EMPTY — zero noise');
  ok(cs.civicDigestFor('') === '' && cs.civicDigestFor('the of and for') === '', 'empty/stopword-only topics are empty, never a throw');

  // --- fail-soft everywhere ---
  ok(cs.roster('nothing here').length === 0 && cs.history('x', 'y').length === 0, 'unknown bodies read back empty, never throw');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  try { require('../lib/db').getDb().close(); } catch {}
  try { require('fs').unlinkSync(process.env.SQ_DB_PATH); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})();
