/* smoke_cardinality_capture.js — P5b: vetting an OBSERVED seat count.
 *
 * cardinality.js refusing correctly is worthless if what feeds it invents sources. So the load-bearing
 * tests here are the ones where a well-formed, confident, entirely plausible answer is REJECTED
 * because its provenance does not hold up.
 */
'use strict';
const cc = require('../lib/cardinality_capture');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); } }

const VISITED = [
  'https://legislature.idaho.gov/house/membership/',
  'search: idaho house of representatives seats',
  'https://ballotpedia.org/Idaho_House_of_Representatives',
];

// ── source classification ──────────────────────────────────────────────────────────────────────
ok(cc.classifySource('https://legislature.idaho.gov/house/') === 'official', '.gov → official');
ok(cc.classifySource('https://leg.state.or.us/x') === 'official', 'state .us → official');
ok(cc.classifySource('https://ballotpedia.org/x') === 'secondary', 'ballotpedia → secondary');
ok(cc.classifySource('not a url') === null, 'non-URL → no source kind');
ok(cc.classifySource('ftp://legislature.idaho.gov') === null, 'non-http scheme → rejected');
ok(cc.classifySource('https://en.wikipedia.org/wiki/X') === 'secondary',
  'CRITICAL: wikipedia is secondary, never official — it is not the body speaking about itself');

// ── host matching: subdomains yes, bare TLD no ─────────────────────────────────────────────────
{
  const seen = cc.visitedHosts(VISITED);
  ok(seen.size === 2, 'visitedHosts ignores "search:" entries (2 hosts, not 3)');
  ok(cc.hostMatches('house.legislature.idaho.gov', seen) === true, 'deep subdomain of a visited host matches');
  ok(cc.hostMatches('legislature.idaho.gov', seen) === true, 'exact visited host matches');
  ok(cc.hostMatches('legislature.utah.gov', seen) === false,
    'CRITICAL: a DIFFERENT state .gov must not match — .gov is not one interchangeable site');
}

// ── the happy path ─────────────────────────────────────────────────────────────────────────────
{
  const r = cc.parseCapture('SEATS: 70\nSOURCE: https://legislature.idaho.gov/house/membership/', { visited: VISITED });
  ok(r.ok === true && r.seats === 70, 'well-formed, visited, plausible → accepted');
  ok(r.sourceKind === 'official' && /idaho\.gov/.test(r.sourceRef), 'carries kind + ref for cardinality.record');
}

// ── refusal is a first-class answer ────────────────────────────────────────────────────────────
{
  const r = cc.parseCapture('NOT FOUND', { visited: VISITED });
  ok(r.ok === false && r.refused === true, 'NOT FOUND → clean refusal, flagged as such (not an error)');
}

// ── THE LOAD-BEARING REJECTIONS ────────────────────────────────────────────────────────────────
{
  const fab = cc.parseCapture('SEATS: 70\nSOURCE: https://legislature.idaho.gov.example.com/members', { visited: VISITED });
  ok(fab.ok === false && fab.fabricated === true,
    'CRITICAL: a lookalike host that was never visited is REFUSED, however plausible the number');

  const unvisited = cc.parseCapture('SEATS: 105\nSOURCE: https://totally-real-source.gov/seats', { visited: VISITED });
  ok(unvisited.ok === false && unvisited.fabricated === true,
    'CRITICAL: an invented .gov URL the run never opened is refused — provenance beats plausibility');

  ok(/never visited/i.test(unvisited.reason), 'the refusal says WHY, so a skip is never mistaken for "no seat count"');

  const noSrc = cc.parseCapture('SEATS: 70', { visited: VISITED });
  ok(noSrc.ok === false && /origin/i.test(noSrc.reason), 'a count with no SOURCE line is refused');

  const prose = cc.parseCapture('The Idaho House has 70 members, which is well known.', { visited: VISITED });
  ok(prose.ok === false, 'CRITICAL: prose is NOT salvaged — an unparsed number is an ununderstood number');

  const yr = cc.parseCapture('SEATS: 2026\nSOURCE: https://legislature.idaho.gov/x', { visited: VISITED });
  ok(yr.ok === false && /implausible/i.test(yr.reason), 'a YEAR is rejected even with a perfect visited source');

  const range = cc.parseCapture('SEATS: 70 to 105\nSOURCE: https://legislature.idaho.gov/x', { visited: VISITED });
  ok(range.ok === false && /ambiguous/i.test(range.reason), 'a RANGE is refused, never rounded into a decision');

  const badUrl = cc.parseCapture('SEATS: 70\nSOURCE: the official legislature website', { visited: VISITED });
  ok(badUrl.ok === false && /usable URL/i.test(badUrl.reason), 'a described source is not a source');

  ok(cc.parseCapture('', { visited: VISITED }).ok === false, 'empty reply → refused, never throws');
}

// ── no visited list → cannot judge provenance, and must not pretend to ─────────────────────────
{
  const r = cc.parseCapture('SEATS: 70\nSOURCE: https://legislature.idaho.gov/x', { visited: [] });
  ok(r.ok === true, 'with no visited record the host check is skipped rather than faked');
}

// ── the prompt must actually license refusal, or the shape forces invention ────────────────────
{
  const p = cc.buildPrompt('Idaho House of Representatives');
  ok(/NOT FOUND/.test(p) && /Idaho House/.test(p), 'prompt names the body and offers the escape hatch');
  ok(/Do NOT estimate|Do NOT count a roster/i.test(p), 'prompt forbids deriving the number instead of citing it');
}

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
