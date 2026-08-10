'use strict';
/* smoke_local_roster.js — Spine 3 leaf-fill (lib/local_roster.js + recheck_queue local-roster kind).
 * Proves: the frame → local-roster tasks (locality-scoped, deduped), the R3-scoped research prompt, the
 * richer roster parse, and honest coverage vs the independent denominator. Pure (mock rq + injected frame).
 * Run: node scripts/smoke_local_roster.js */
const lr = require('../lib/local_roster');
const rq = require('../lib/recheck_queue');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// ── bodyTitle: locality-scoped (no cross-locality body_key collapse) ────────────────────────────────────
ok(lr.bodyTitle({ name: 'Acadia Parish', body: 'Police Jury' }) === 'Acadia Parish Police Jury', 'bodyTitle qualifies the default body with the parish name');
ok(lr.bodyTitle({ name: 'Allen Parish', body: 'Police Jury' }) === 'Allen Parish Police Jury', 'bodyTitle is distinct per parish (Allen ≠ Acadia)');
ok(lr.bodyTitle({ name: 'Orleans Parish', body: 'New Orleans City Council' }) === 'New Orleans City Council', 'bodyTitle keeps an exception body that already names the locality');
ok(lr.bodyTitle({ name: 'Foo County', body: '' }) === 'Foo County governing body', 'bodyTitle falls back to "<locality> governing body" when no body');

// ── enqueueState: frame → local-roster tasks (mock rq captures them) ─────────────────────────────────────
{
  const captured = [];
  const mockRq = { enqueue: (item) => { const dup = captured.find((c) => c.subject === item.subject); captured.push(item); return { ok: true, existing: !!dup }; } };
  const frame = { state: 'LA', count: 2, localities: [
    { name: 'Acadia Parish', fips: '22001', state: 'LA', body: 'Police Jury', presiding: 'President', govSource: 'default-hypothesis', bodyKinds: ['Police Jury', 'Parish Council'], exclude: ['Sheriff', 'District Attorney'] },
    { name: 'Orleans Parish', fips: '22071', state: 'LA', body: 'New Orleans City Council', presiding: null, govSource: 'known-exception', bodyKinds: ['Police Jury', 'Parish Council'], exclude: ['Sheriff'] },
  ] };
  const res = lr.enqueueState('LA', { frame, rq: mockRq });
  ok(res.denominator === 2 && res.enqueued === 2, 'enqueueState enqueues one task per locality, carries the denominator');
  ok(captured[0].kind === 'local-roster' && captured[0].subject === 'Acadia Parish Police Jury', 'the task is kind=local-roster with a locality-scoped subject');
  ok(captured[0].detail.exclude.includes('Sheriff') && Array.isArray(captured[0].detail.bodyKinds), 'the task detail carries the R3 scoping (bodyKinds + exclusions) for the research pass');
  ok(captured[0].detail.state === 'LA' && captured[0].detail.place === 'Acadia Parish', 'the task detail carries state + place for locality-scoped recording');
  // dedup on a re-run
  const res2 = lr.enqueueState('LA', { frame, rq: mockRq });
  ok(res2.existing === 2 && res2.enqueued === 0, 'a re-run coalesces (dedup by subject) — never floods the queue');
}

// ── the R3-scoped research prompt (buildPrompt local-roster) ────────────────────────────────────────────
{
  const prompt = rq.buildPrompt({ kind: 'local-roster', subject: 'Acadia Parish Police Jury', detail: { body: 'Police Jury', govSource: 'default-hypothesis', bodyKinds: ['Police Jury', 'Parish Council'], exclude: ['Sheriff', 'Clerk of Court', 'District Attorney'], state: 'LA', place: 'Acadia Parish' } });
  ok(/GOVERNING BODY/i.test(prompt) && /Acadia Parish/.test(prompt), 'prompt targets the governing body of the named locality');
  ok(/EXCLUDE:[^.]*Sheriff/i.test(prompt) && /District Attorney/i.test(prompt), 'prompt EXCLUDES the row offices (the census failure: grabbing the sheriff)');
  ok(/TOP-DOWN/i.test(prompt) && /official/i.test(prompt), 'prompt drives top-down from the official site');
  ok(/BODY:/.test(prompt) && /PRESIDING:/.test(prompt) && /ROSTER:/.test(prompt), 'prompt specifies the structured output contract');
  ok(/PRESUMED "Police Jury"/i.test(prompt), 'prompt carries the frame hypothesis to confirm-or-correct');
}

// ── parseLocalRoster: the richer verdict (BODY / PRESIDING / ROSTER 4-field) ─────────────────────────────
{
  const ans = [
    'RESOLVED: found the roster at acadiaparishpolicejury.org',
    'BODY: Acadia Parish Police Jury',
    'PRESIDING: Ryan L. Turner | President',
    'ROSTER: Ryan L. Turner | President | president@acadiaparishpolicejury.org | (337) 783-6885',
    'ROSTER: Jody Frey | District 1 | - | -',
    'ROSTER: Ryan L. Turner | President',   // duplicate name → deduped
  ].join('\n');
  const p = rq.parseLocalRoster(ans);
  ok(p.body === 'Acadia Parish Police Jury', 'parseLocalRoster reads the confirmed BODY name');
  ok(p.members.length === 2, 'parseLocalRoster dedups a repeated person (President listed twice → one)');
  const turner = p.members.find((m) => /Turner/.test(m.personName));
  ok(turner && turner.email === 'president@acadiaparishpolicejury.org' && /783-6885/.test(turner.phone), 'parseLocalRoster captures email + phone from a 4-field ROSTER line');
  const frey = p.members.find((m) => /Frey/.test(m.personName));
  ok(frey && frey.email === null && frey.phone === null, 'parseLocalRoster treats "-" as no-contact (never a fabricated value)');
}
ok(rq.parseLocalRoster('STILL-UNKNOWN: the official site had no roster page').members.length === 0, 'parseLocalRoster: an unresolved verdict → no members (nothing invented)');

// ── coverage: honest, against the independent denominator ────────────────────────────────────────────────
{
  const frame = { state: 'LA', count: 4, localities: [
    { name: 'Acadia Parish', body: 'Police Jury' }, { name: 'Allen Parish', body: 'Police Jury' },
    { name: 'Ascension Parish', body: 'Police Jury' }, { name: 'Orleans Parish', body: 'New Orleans City Council' },
  ] };
  const filledSet = new Set(['Acadia Parish Police Jury']);
  const cov = lr.coverage('LA', { frame, memberOf: (t) => filledSet.has(t) });
  ok(cov.denominator === 4 && cov.filled === 1 && cov.remaining === 3 && cov.pct === 25, 'coverage measures filled/denominator (1/4 = 25%), remaining honest');
}

// ── assembleDeliverable: coverage-honest rows (the artifact-router door's payload) ──────────────────────
{
  const frame = { state: 'LA', count: 3, localities: [
    { name: 'Acadia Parish', body: 'Police Jury' }, { name: 'Allen Parish', body: 'Police Jury' }, { name: 'Orleans Parish', body: 'New Orleans City Council' },
  ] };
  // mock civic store: only Acadia is filled (a verified president with contacts); the rest are empty
  const civ = { getBody: (title) => (title === 'Acadia Parish Police Jury' ? { body_key: 'acadia' } : null) };
  const getMembers = (bk) => (bk === 'acadia' ? [{ person_name: 'Ryan L. Turner', role: 'President', email: 'president@acadiaparishpolicejury.org', phone: '(337) 783-6885' }] : []);
  const d = lr.assembleDeliverable('LA', { frame, deps: { civ, getMembers } });
  ok(d.denominator === 3 && d.filled === 1, 'assembleDeliverable: filled/denominator honest (1/3)');
  const acadia = d.rows.find((r) => r.Parish === 'Acadia Parish');
  ok(acadia.Status === 'verified' && acadia['Presiding Officer'] === 'Ryan L. Turner' && /783-6885/.test(acadia.Phone), 'assembleDeliverable: a VERIFIED row carries the real officer + contacts');
  const allen = d.rows.find((r) => r.Parish === 'Allen Parish');
  ok(allen.Status === 'queued' && allen['Presiding Officer'] === '(researching)' && allen.Email === '', 'assembleDeliverable: an UNFILLED row is marked "(researching)", never blank-faked');
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
