'use strict';
/* smoke_local_frame.js — Spine 3 R1/R3 the enumeration frame (lib/local_frame.js).
 * Proves the frame is GENERIC (any state from the bundled national gazetteer) and validated on Louisiana
 * (exactly 64 parishes), with honest governance scoping (hypothesis + taxonomy + exclusions, never asserted).
 * Reads the real bundled data (deterministic, no network). Run: node scripts/smoke_local_frame.js */
const lf = require('../lib/local_frame');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// ── the validation target: Louisiana, exactly 64 parishes ───────────────────────────────────────────────
const la = lf.buildFrame('LA');
ok(la.count === 64, `LA frame enumerates exactly 64 parishes (got ${la.count}) — the independent denominator`);
ok(la.localities[0].name === 'Acadia Parish', 'LA first locality is Acadia Parish (authoritative order)');
ok(la.localities.every((l) => /Parish$/.test(l.name)), 'every LA locality is a Parish (LA naming), not County');
ok(la.localities.every((l) => l.fips && /^22\d{3}$/.test(l.fips)), 'every LA locality carries its Census FIPS (state 22)');

// ── GENERIC: the same mechanism works for any state, no per-state code ───────────────────────────────────
ok(lf.buildFrame('DE').count === 3, 'DE frame = 3 counties (generic, from the same bundled national frame)');
ok(lf.buildFrame('WY').count === 23, 'WY frame = 23 counties (generic)');
ok(lf.buildFrame('CA').count === 58, 'CA frame = 58 counties (generic)');
ok(lf.buildFrame('TX').count === 254, 'TX frame = 254 counties (generic)');
ok(lf.buildFrame('DE').localities[0].body === 'County Commission', 'a non-LA state uses the generic county governance form');
ok(lf.buildFrame('ZZ').count === 0, 'an unknown state code → empty frame (no crash)');

// ── governance scoping (R3): default hypothesis, known exceptions, exclusions — all HONEST ───────────────
{
  const acadia = lf.governanceFor('LA', 'Acadia Parish');
  ok(acadia.body === 'Police Jury' && acadia.presiding === 'President', 'LA default: Police Jury / President');
  ok(acadia.govSource === 'default-hypothesis', 'a default is labeled a HYPOTHESIS, not an asserted fact (research confirms)');
  ok(Array.isArray(acadia.bodyKinds) && acadia.bodyKinds.includes('Parish Council'), 'the R3 taxonomy of body kinds is carried (Police Jury OR home-rule councils)');
  ok(acadia.exclude.includes('Sheriff') && acadia.exclude.includes('District Attorney'), 'R3 exclusions carried: sheriff/DA/clerk are NOT the governing body');
}
{
  const orleans = lf.governanceFor('LA', 'Orleans Parish');
  ok(orleans.body === 'New Orleans City Council' && orleans.govSource === 'known-exception', 'a consolidated-government exception (Orleans) is a labeled known-exception');
  ok(orleans.presiding === null, 'the exception leaves the presiding TITLE for research (frame never asserts a shaky title)');
}
{
  // the frame attaches governance to every locality
  const ebr = la.localities.find((l) => l.name === 'East Baton Rouge Parish');
  ok(ebr && ebr.body === 'Metropolitan Council' && ebr.govSource === 'known-exception', 'buildFrame attaches the EBR Metro Council exception to the locality row');
  const rural = la.localities.find((l) => l.name === 'Allen Parish');
  ok(rural && rural.body === 'Police Jury' && rural.govSource === 'default-hypothesis', 'buildFrame attaches the default hypothesis to a rural parish');
}

// ── parseCounties is a pure parser (fixture, no file) ────────────────────────────────────────────────────
{
  const rows = lf.parseCounties('USPS\tGEOID\tNAME\nLA\t22001\tAcadia Parish\nDE\t10001\tKent County\n');
  ok(rows.length === 2 && rows[0].name === 'Acadia Parish' && rows[1].state === 'DE', 'parseCounties: pure TSV parse, header skipped');
}

// ── resolveState: "the Louisiana parish roster" → LA (for the artifact-router door) ─────────────────────
ok(lf.resolveState('build the Louisiana parish roster') === 'LA', 'resolveState: spelled-out state name → LA');
ok(lf.resolveState('compile a spreadsheet of Texas county commissioners') === 'TX', 'resolveState: Texas → TX');
ok(lf.resolveState('the parish roster') === 'LA', 'resolveState: "parish" (LA-only word) implies Louisiana');
ok(lf.resolveState('build the CA county roster') === 'CA', 'resolveState: a bare USPS code → CA');
ok(lf.resolveState('build me a report on data centers') === null, 'resolveState: no state → null (door asks which state)');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
