/* Smoke: lib/civic_capture — HOW a roster legitimately gets recorded (the sibling of
 * cardinality_capture, same anti-fabrication doctrine, plus the name check page furniture demands).
 * Pure: no db, no network, no model.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_civic_capture.js
 */
'use strict';
const cc = require('../lib/civic_capture');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

const VISITED = ['https://fultoncountyga.gov/elections/board', 'search: fulton county elections board members'];

// --- the name check: page furniture is the dominant failure of any roster scrape ---
ok(cc.looksLikeName('Cathy Woolard') && cc.looksLikeName('Mark A. Wingate') && cc.looksLikeName("Aaron O'Brien-Diaz"),
  'real names pass: plain, with an initial, hyphenated/apostrophed');
ok(cc.looksLikeName('Vincent van der Berg'), 'particles and 4-word names pass');
// REAL NAMES THE FIRST (ASCII-only) SCREEN REFUSED — caught by the backfill dry run before it
// wrote anything. An ASCII screen does not filter noise, it filters non-Anglo names.
ok(cc.looksLikeName('Josué Estrada') && cc.looksLikeName('José Jaime Villalobos'),
  'diacritics pass — an ASCII-only screen was refusing real people');
ok(cc.looksLikeName('Meia Chita‑Tegmark'), 'a non-breaking hyphen (U+2011) is still a hyphen');
ok(cc.looksLikeName('Andrew (Shan) Shanahan') && cc.looksLikeName('Russell “Scott” McCaw'),
  'a parenthesised or quoted nickname is part of the name');
ok(cc.looksLikeName('Müller Schmidt') && cc.looksLikeName('Ngô Đình Diệm'), 'non-Latin-1 letters pass too');
ok(!cc.looksLikeName('Board Members') && !cc.looksLikeName('Contact Us') && !cc.looksLikeName('Meeting Minutes'),
  'HEADINGS are refused — the furniture that sits exactly where a name would');
ok(!cc.looksLikeName('Fulton County') && !cc.looksLikeName('Elections Department'), 'places and departments are not people');
ok(!cc.looksLikeName('Springfield Township') && !cc.looksLikeName('Registration Office') && !cc.looksLikeName('Shanghai University'),
  'the furniture word can sit at the END too — no surname is "County"/"Office"/"University"');
ok(cc.looksLikeName('Hunter Bell') && cc.looksLikeName('Mary Church Terrell'), '…and real names with ordinary words still pass');
ok(!cc.looksLikeName('District 3') && !cc.looksLikeName('Seat 2'), 'a seat label is not a person');
ok(!cc.looksLikeName('Robb') && !cc.looksLikeName(''), 'a mononym or empty is refused (almost always furniture)');
ok(!cc.looksLikeName('clerk@fultoncountyga.gov') && !cc.looksLikeName('https://x.gov/board'), 'addresses and URLs are refused');

// --- the prompt states the escape hatch AND why it is safe ---
{
  const p = cc.buildPrompt('Fulton County Registration and Elections Board');
  ok(/ONE LINE PER PERSON/.test(p) && /MEMBER: <full name>/.test(p), 'the prompt fixes a strict per-line shape');
  ok(/reply with exactly:\nNOT FOUND/.test(p), 'an honest refusal is cheap and explicit');
  ok(/an invented member is far worse than a missing one/.test(p), 'it says WHY refusing is safe (or the model fills the format)');
  ok(/LEVEL: </.test(p) && /FUNCTION: </.test(p), 'level and function are captured in the same ask');
}

// --- the happy path ---
{
  const r = cc.parseCapture([
    'MEMBER: Cathy Woolard | Chair | - | https://fultoncountyga.gov/elections/board',
    'MEMBER: Mark A. Wingate | Member | District 2 | https://fultoncountyga.gov/elections/board',
    'LEVEL: county',
    'FUNCTION: elections',
  ].join('\n'), { visited: VISITED });
  ok(r.ok && r.members.length === 2, 'a clean roster parses');
  ok(r.members[0].role === 'Chair' && r.members[1].district === 'District 2', 'role and district survive');
  ok(r.members[0].district === null, 'a "-" district becomes null, never the literal dash');
  ok(r.members[0].sourceKind === 'official' && r.members[0].confidence === 0.9, 'a .gov source is official and graded high');
  ok(r.level === 'county' && r.function === 'elections', 'level + function captured on their own axes');
}

// --- refusal is first-class ---
ok(cc.parseCapture('NOT FOUND', { visited: VISITED }).refused === true, 'NOT FOUND is an honest refusal, flagged as such');
ok(cc.parseCapture('', {}).ok === false, 'an empty reply never throws');
ok(cc.parseCapture('The board has five members, all appointed.', { visited: VISITED }).ok === false,
  'PROSE IS NOT SALVAGED — a roster we had to infer is one we do not understand');

// --- THE anti-fabrication check, inherited verbatim ---
{
  const r = cc.parseCapture([
    'MEMBER: Cathy Woolard | Chair | - | https://fultoncountyga.gov/elections/board',
    'MEMBER: Invented Person | Member | - | https://totally-made-up-county.gov/board',
  ].join('\n'), { visited: VISITED });
  ok(r.ok && r.members.length === 1 && r.members[0].personName === 'Cathy Woolard',
    'a member cited to a host the run NEVER VISITED is dropped — the tidy invented URL fails here');
  ok(r.rejected.some((x) => /never visited/.test(x.why)), 'and the rejection says exactly why');
}
{
  const r = cc.parseCapture('MEMBER: Jane Doe | Member | - | https://house.legislature.idaho.gov/members',
    { visited: ['https://legislature.idaho.gov/'] });
  ok(r.ok && r.members.length === 1, 'a SUBDOMAIN of a visited host is honest research, not fabrication');
}

// --- furniture and sanity ---
{
  const r = cc.parseCapture([
    'MEMBER: Board Members | Member | - | https://fultoncountyga.gov/elections/board',
    'MEMBER: Cathy Woolard | Chair | - | https://fultoncountyga.gov/elections/board',
    'MEMBER: Missing Url Person | Member | -',
  ].join('\n'), { visited: VISITED });
  ok(r.ok && r.members.length === 1, 'furniture and source-less lines are dropped, the real member survives');
  ok(r.rejected.length === 2, 'both rejections are reported, never silently swallowed');
}
{
  const many = Array.from({ length: 70 }, (_, i) => `MEMBER: Person Number${String.fromCharCode(65 + (i % 26))} | Member | - | https://fultoncountyga.gov/elections/board`).join('\n');
  ok(cc.parseCapture(many, { visited: VISITED }).ok === false, 'a 70-person "board" is a directory page, refused wholesale');
}
{
  const r = cc.parseCapture('MEMBER: Board Members | Member | - | https://fultoncountyga.gov/elections/board', { visited: VISITED });
  ok(r.ok === false && /failed vetting/.test(r.reason), 'if EVERY line fails, the capture fails with the reasons');
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
