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
  // TOKEN EQUALITY (2026-08-21, the hollow report): topic token "anti" substring-matched
  // atl-ANTI-c_county and rode Atlantic County NJ into an anti-China report. Substring is banned.
  cs.upsertBody({ title: 'Atlantic County Board of Commissioners', level: 'county', state: 'NJ' });
  cs.recordRoster({ bodyTitle: 'Atlantic County Board of Commissioners', members: [{ personName: 'John W. Risley Jr.', role: 'Chairman' }], sourceKind: 'official' });
  ok(cs.civicDigestFor('anti china legislation') === '', 'HOLLOW-REPORT REGRESSION: "anti" never substring-matches atlANTIc — token equality only');
  ok(/atlantic county/i.test(cs.civicDigestFor('the Atlantic County board')), 'the real Atlantic County topic still selects it');
  const digCapped = cs.civicDigestFor('parish leadership', { charBudget: 80 });
  ok(/\(\+\d+ more matching/.test(digCapped) && !/…$/.test(digCapped), 'a budget drop keeps WHOLE lines and NAMES the count — never a silent mid-line cut');

  // --- fail-soft everywhere ---
  ok(cs.roster('nothing here').length === 0 && cs.history('x', 'y').length === 0, 'unknown bodies read back empty, never throw');

  // ── VACANCY-AS-DATA (2026-08-14, the LA Senate D14 lesson) ──────────────────────────────────
  {
    const d = require('../lib/db').getDb();
    cs.upsertBody({ title: 'Testland State Senate', level: 'state', state: 'TS' }, { nowMs: T });
    d.prepare('INSERT OR REPLACE INTO cardinality (body, seats, source_kind, source_ref, observed_ts) VALUES (?, ?, ?, ?, ?)').run(cs.keyFor('Testland State Senate'), 3, 'official', 'https://example.gov/senate', T);
    cs.recordMembership({ bodyTitle: 'Testland State Senate', personName: 'Alpha One', district: '1', sourceKind: 'official' }, { nowMs: T });
    cs.recordMembership({ bodyTitle: 'Testland State Senate', personName: 'Beta Two', district: '2', sourceKind: 'official' }, { nowMs: T });

    // a vacancy needs a seat and a known body
    ok(cs.recordVacancy({ bodyTitle: 'Testland State Senate' }).ok === false, 'a vacancy without a seat is refused');
    ok(cs.recordVacancy({ bodyTitle: 'No Such Body', seat: '3' }).ok === false, 'a vacancy on an unknown body is refused');

    // record: seat 3 vacant, cited
    const v1 = cs.recordVacancy({ bodyTitle: 'Testland State Senate', seat: '3', vacantSince: '2026', reason: 'incumbent died in office', successorNote: 'special election pending', sourceUrl: 'https://example.gov/senate', sourceKind: 'wiki', confidence: 0.8 }, { nowMs: T + 1 });
    ok(v1.ok && v1.id, 'a cited vacancy lands');
    ok(cs.vacancies('Testland State Senate').length === 1, 'the live vacancy reads back');

    // completeness: a CITED vacancy is accounted-for, not missing
    const c = cs.completeness('Testland State Senate');
    ok(c.filled === 2 && c.vacant === 1 && c.complete === true && c.missing === 0,
      'completeness: 2 filled + 1 cited vacancy over 3 seats = COMPLETE, missing 0');

    // idempotent: unchanged re-record touches nothing; a better source regrades in place
    const v2 = cs.recordVacancy({ bodyTitle: 'Testland State Senate', seat: '3', vacantSince: '2026', reason: 'incumbent died in office', successorNote: 'special election pending' }, { nowMs: T + 2 });
    ok(v2.ok && v2.unchanged && cs.vacancies('Testland State Senate').length === 1, 'an unchanged re-record makes no new row');
    const v3 = cs.recordVacancy({ bodyTitle: 'Testland State Senate', seat: '3', vacantSince: '2026', reason: 'incumbent died in office', successorNote: 'special election pending', sourceKind: 'official', sourceUrl: 'https://official.gov', confidence: 0.95 }, { nowMs: T + 3 });
    ok(v3.ok && v3.regraded, 'a better source RAISES the grade in place');

    // a materially different claim supersedes with lineage
    const v4 = cs.recordVacancy({ bodyTitle: 'Testland State Senate', seat: '3', vacantSince: '2026', reason: 'incumbent died in office', successorNote: 'special election scheduled 2026-11-03' }, { nowMs: T + 4 });
    ok(v4.ok && v4.superseded === v1.id && cs.vacancies('Testland State Senate').length === 1, 'a changed claim supersedes, never overwrites — one live row');

    // digests SPEAK the vacancy — the report door can answer "who holds seat 3": nobody, cited
    const dg = cs.civicDigestFor('Testland senate leadership');
    ok(/VACANT/.test(dg) && /special election scheduled/.test(dg), 'the civic digest names the vacant seat and its story');
    const held = cs.heldRostersFor('testland senate roster check');
    ok(held.length === 1 && /VACANT/.test(held[0].line), 'held-roster injection carries the vacancy line');

    // THE SELF-HEALING WIRE: a successor membership on that district resolves the vacancy
    const fill = cs.recordMembership({ bodyTitle: 'Testland State Senate', personName: 'Gamma Three', district: '3', sourceKind: 'official' }, { nowMs: T + 5 });
    ok(fill.ok && fill.resolvedVacancy != null, 'a successor row on the exact seat RESOLVES the vacancy');
    ok(cs.vacancies('Testland State Senate').length === 0, 'the resolved vacancy leaves the live set');
    const c2 = cs.completeness('Testland State Senate');
    ok(c2.filled === 3 && c2.vacant === 0 && c2.complete === true, 'after the fill: 3 filled, 0 vacant, still complete');
    const vrow = d.prepare('SELECT resolved_by_membership FROM civic_vacancies WHERE id = ?').get(v4.id);
    ok(vrow && vrow.resolved_by_membership === fill.id, 'resolution carries lineage to the FILLING membership row');
  }

  // ── civicRecallFor — the lookup-grounding door (2026-08-14, the D14 chat test) ───────────────
  {
    // an ALL-GENERIC body_key (the class heldRostersFor can never match, by construction)
    cs.upsertBody({ title: 'Louisiana State Senate', level: 'state', state: 'LA' }, { nowMs: T });
    cs.recordMembership({ bodyTitle: 'Louisiana State Senate', personName: 'Test Senator', district: '5', party: 'R', sourceKind: 'official' }, { nowMs: T });
    cs.recordVacancy({ bodyTitle: 'Louisiana State Senate', seat: '14', vacantSince: '2026', reason: 'incumbent died in office', successorNote: 'special election pending' }, { nowMs: T });

    ok(cs.heldRostersFor('who represents Louisiana Senate District 14?').every((h) => h.bodyKey !== 'louisiana state senate'),
      'heldRostersFor is structurally blind to an all-generic body key (why this door exists)');
    const rc = cs.civicRecallFor('who represents Louisiana Senate District 14?');
    ok(rc.length >= 1 && rc[0].bodyKey === 'louisiana state senate', 'civicRecallFor matches the chamber on the 2-token rule');
    ok(/VACANT/.test(rc[0].line) && /District 14/.test(rc[0].line), 'the asked-about vacancy is spoken in the line');
    const rc5 = cs.civicRecallFor('who holds Louisiana Senate District 5?');
    ok(/District 5: Test Senator \(R\)/.test(rc5[0].line), 'a HELD district row is pulled to the front when asked');
    const rc9 = cs.civicRecallFor('who holds Louisiana Senate District 9?');
    ok(/District 9: no live row held/.test(rc9[0].line), 'an unheld district says so honestly — never silence');
    ok(cs.civicRecallFor('louisiana').length === 0, 'one shared token is coincidence — no match (the 2-token rule)');
    ok(cs.civicRecallFor('').length === 0 && cs.civicRecallFor('grid transmission pressure').length === 0, 'empty/unrelated topics recall nothing, never throw');
  }

  // ── DEEP-DIVE REGRESSION PINS (2026-08-15, findings C1–C6) ──────────────────────────────────
  {
    const d = require('../lib/db').getDb();

    // C1: two CLASS-word hits are not a topic — the wrong state can never ground the answer
    ok(cs.civicRecallFor('who represents Texas State Senate District 14?').length === 0,
      'C1: state+senate alone never match — a Texas ask cannot ground from the Louisiana store');
    ok(cs.civicRecallFor('who represents Louisiana Senate District 14?').length >= 1,
      'C1: a specific token (louisiana) plus a class token still matches');

    // C2: grade rides the line — the LA D14 fixture is uncited, so its line says verify-first
    const rcF = cs.civicRecallFor('who represents Louisiana Senate District 14?');
    ok(/UNCITED — verify before asserting/.test(rcF[0].line), 'C2: an uncited vacancy claim is flagged on the line itself');
    const rcS = cs.civicRecallFor('who represents Louisiana Senate District 14?', { now: T + 40 * 86400000 });
    ok(/\d+d ago — recheck/.test(rcS[0].line), 'C2: a stale vacancy claim names its age');

    // C3: a vacancy on a HELD seat is refused with the holder named; force records the conflict
    const r1 = cs.recordVacancy({ bodyTitle: 'Louisiana State Senate', seat: '5', reason: 'stale article claim' }, { nowMs: T + 10 });
    ok(r1.ok === false && /Test Senator/.test(r1.reason) && r1.heldBy != null,
      'C3: a vacancy claim on a held seat is refused, holder and door named');
    const r2 = cs.recordVacancy({ bodyTitle: 'Louisiana State Senate', seat: '5', reason: 'stale article claim', force: true, sourceUrl: 'https://stale.example', sourceKind: 'news', confidence: 0.7 }, { nowMs: T + 11 });
    ok(r2.ok && r2.conflictsWith != null, 'C3: force:true records the conflict knowingly, lineage to the holder');

    // C6: a forced conflict speaks as CONFLICT, never as plain VACANT
    const rcC = cs.civicRecallFor('who holds Louisiana Senate District 5?');
    ok(/District 5 — CONFLICT: the roster holds Test Senator/.test(rcC[0].line) && !/District 5 — VACANT/.test(rcC[0].line),
      'C6: a vacancy on a held seat renders as CONFLICT — the model is told to verify, not coin-flip');

    // C3 self-heal on the regrade path: a researched re-confirmation of the sitting holder closes it
    const rg = cs.recordMembership({ bodyTitle: 'Louisiana State Senate', personName: 'Test Senator', district: '5', party: 'R', sourceKind: 'official', confidence: 0.9 }, { nowMs: T + 12 });
    ok(rg.ok && rg.regraded && rg.resolvedVacancy === r2.id,
      'C3: a researched re-confirmation of the holder RESOLVES the conflict vacancy (the wire now runs past the early-returns)');
    ok(cs.vacancies('Louisiana State Senate').length === 1, 'C3: only the genuine D14 vacancy remains live');

    // C4: backfill never resolves an official-cited vacancy (the dead-incumbent resurrection guard)
    cs.upsertBody({ title: 'Quorumville City Council', level: 'municipal' }, { nowMs: T });
    const qv = cs.recordVacancy({ bodyTitle: 'Quorumville City Council', seat: '2', reason: 'resigned', sourceUrl: 'https://q.gov', sourceKind: 'official', confidence: 0.9 }, { nowMs: T + 20 });
    ok(qv.ok, 'setup: cited vacancy on an unheld seat lands');
    const bf = cs.recordMembership({ bodyTitle: 'Quorumville City Council', personName: 'Prose Ghost', district: '2', sourceKind: 'prose_extract' }, { nowMs: T + 21 });
    ok(bf.ok && bf.resolvedVacancy == null && cs.vacancies('Quorumville City Council').some((v) => v.id === qv.id),
      'C4: a backfill row never resolves an official-cited vacancy');

    // C4: a sitting member's detail change never resolves a vacancy sharing the district value
    cs.upsertBody({ title: 'Multiton School Board', level: 'school_district' }, { nowMs: T });
    cs.recordMembership({ bodyTitle: 'Multiton School Board', personName: 'Mem One', district: '7', sourceKind: 'official' }, { nowMs: T + 30 });
    const mv = cs.recordVacancy({ bodyTitle: 'Multiton School Board', seat: '7', reason: 'one of two district seats empty', force: true, sourceUrl: 'https://m.gov', sourceKind: 'official', confidence: 0.8 }, { nowMs: T + 31 });
    ok(mv.ok, 'setup: multi-member district vacancy force-recorded (a holder shares the district value)');
    const up = cs.recordMembership({ bodyTitle: 'Multiton School Board', personName: 'Mem One', district: '7', email: 'new@multiton.org', sourceKind: 'official' }, { nowMs: T + 32 });
    ok(up.ok && up.superseded != null && up.resolvedVacancy == null,
      'C4: a colleague detail-change supersede (district unchanged) does NOT close the shared-district vacancy');
    const nm = cs.recordMembership({ bodyTitle: 'Multiton School Board', personName: 'Mem Two', district: '7', sourceKind: 'official' }, { nowMs: T + 33 });
    ok(nm.ok && nm.resolvedVacancy === mv.id, 'C4: a genuinely NEW member on the district IS the fill — resolves');

    // C5: seat values normalize at write and compare — "District 07" is seat "7"
    const nv = cs.recordVacancy({ bodyTitle: 'Quorumville City Council', seat: 'District 07', reason: 'vacated', sourceUrl: 'https://q.gov', sourceKind: 'official', confidence: 0.8 }, { nowMs: T + 40 });
    ok(nv.ok && cs.vacancies('Quorumville City Council').some((v) => v.seat === '7'),
      'C5: a decorated seat value is stored NORMALIZED ("District 07" → "7")');
    const fill7 = cs.recordMembership({ bodyTitle: 'Quorumville City Council', personName: 'Seven Fill', district: '7', sourceKind: 'official' }, { nowMs: T + 41 });
    ok(fill7.ok && fill7.resolvedVacancy === nv.id, 'C5: the normalized seat resolves against the bare district value');

    // C2: a NON-researched holder row carries the low-grade flag when it fronts a district ask
    const rcW = cs.civicRecallFor('who holds Quorumville City Council District 2?');
    ok(rcW.length >= 1 && /Prose Ghost \[low-grade source — verify\]/.test(rcW[0].line),
      'C2: a backfill-sourced holder row is flagged low-grade on the line itself');
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  try { require('../lib/db').getDb().close(); } catch {}
  try { require('fs').unlinkSync(process.env.SQ_DB_PATH); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})();
