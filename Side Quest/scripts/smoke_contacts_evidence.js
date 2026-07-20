/* smoke_contacts_evidence.js — the encounter log becomes visible in an answer (R1).
 *
 * Everything before this made the substrate correct without changing a single answer. This is the first
 * reader, so it is the first place the substrate can MISLEAD rather than merely be wrong internally.
 *
 * One rule governs every assertion here: AN UNGRADED CLAIM MUST READ AS UNGRADED, NEVER AS FACT. A
 * blank cell reads as "fine". An absent row reads as "nothing to say". Both are worse than the truth,
 * which for most of this corpus is "one document said so, and we cannot prove that document was
 * independent of any other".
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_contacts_evidence.js
 */
'use strict';
const cq = require('../lib/contacts_query');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', m); } };
const cell = cq.evidenceCell;

// ── every state gets WORDS ───────────────────────────────────────────────────────────────────────
ok(cell(null) === 'not in evidence log',
  'CRITICAL: a contact the log has never seen SAYS SO — a blank cell would read as "fine"');
ok(cell({ grade: null, stated: false }) === 'unverified', 'present but ungraded reads as unverified');
ok(cell({ grade: null, stated: true }) === 'said, not verified',
  'CRITICAL: known only because someone SAID it is labelled as such, never left blank');
ok(cell({ grade: 'A-', sources: 6 }) === 'A- · 6 sources', 'a graded claim shows its grade and count');
ok(cell({ grade: 'B', sources: 1 }) === 'B · 1 source', 'singular reads as "1 source", not "1 sources"');

// THE MOST COMMON STATE IN THIS CORPUS, and the one most likely to mislead.
ok(cell({ grade: 'C', sources: 1, unproven: true }) === 'C · 1 source (unproven)',
  'CRITICAL: a single source with unrecoverable provenance is marked unproven — "C · 1 source" alone would overstate it');
ok(cell({ grade: 'C', sources: 1, unproven: false }) === 'C · 1 source',
  '…and a source we CHECKED is not marked unproven — the two states must stay distinguishable');

// ── attaching evidence to rows ───────────────────────────────────────────────────────────────────
{
  const rows = [{ name: 'Melissa Bosch' }, { name: 'Lucas Overby' }, { name: 'Nobody Known' }];
  const lookup = (n) => (n === 'Melissa Bosch' ? { grade: 'C', sources: 1, unproven: true }
    : n === 'Lucas Overby' ? { grade: 'A-', sources: 6 } : null);
  const out = cq.withEvidence(rows, lookup);
  ok(out.length === 3 && out[0].evidenceLabel === 'C · 1 source (unproven)', 'the log verdict rides on the row');
  ok(out[1].evidenceLabel === 'A- · 6 sources', 'a well-attested person shows it');
  ok(out[2].evidenceLabel === 'not in evidence log', 'CRITICAL: an unknown person is never silently blank');
  ok(out[0].name === 'Melissa Bosch', 'the original row survives intact');
}
{
  // A failing lookup must degrade to "unknown", never to an implied clean bill.
  const out = cq.withEvidence([{ name: 'X' }], () => { throw new Error('db down'); });
  ok(out[0].evidenceLabel === 'not in evidence log', 'CRITICAL: a lookup failure reads as unknown, not as verified');
  ok(cq.withEvidence(null, null).length === 0 && cq.withEvidence([{ name: 'Y' }]).length === 1,
    'missing lookup / null rows → no throw');
}

// ── the table names both measurements ────────────────────────────────────────────────────────────
{
  const sel = {
    rows: cq.withEvidence([
      { name: 'Melissa Bosch', email: 'm@x.gov', company: 'Bosch & Statham', title: 'CPA', confidence: 0.8 },
      { name: 'Nobody Known', email: null, company: null, title: null, confidence: 0.9 },
    ], (n) => (n === 'Melissa Bosch' ? { grade: 'C', sources: 1, unproven: true } : null)),
    total: 2, shown: 2, withEmail: 1,
  };
  const t = cq.toTable(sel);
  ok(t.headers.includes('Evidence'), 'the table carries an Evidence column');
  ok(t.headers.includes('Puller conf.') && !t.headers.includes('Confidence'),
    'CRITICAL: the extractor’s confidence is NAMED — two different measurements must not both read as "Confidence"');
  // The gap that naming exposes: 80% sure of a fact that one unproven document asserts.
  ok(t.rows[0][4] === '80%' && t.rows[0][5] === 'C · 1 source (unproven)',
    'CRITICAL: a high extractor confidence sits beside weak evidence, visibly');
  ok(t.rows[1][5] === 'not in evidence log', 'and an unknown contact says so in its own row');
  // The caption reports CORROBORATION, not "has a grade". Checked live: every Louisiana row had a
  // grade and every one was `C · 1 source`, so "12 of 12 carry graded evidence" read as reassurance
  // while saying the opposite of what the data meant.
  ok(/0 of 2 shown rest on more than one independent source/.test(t.caption),
    'CRITICAL: the caption counts CORROBORATED rows — a grade alone is not reassurance');
}
{
  // The honest zero: a list where nothing is corroborated must say so, not merely omit it.
  const sel = { rows: cq.withEvidence([{ name: 'A' }, { name: 'B' }], () => null), total: 2, shown: 2, withEmail: 0 };
  ok(/0 of 2 shown rest on more than one independent source/.test(cq.toTable(sel).caption),
    'CRITICAL: zero is stated plainly, not left to inference');
  // …and a genuinely corroborated row is counted.
  const good = { rows: cq.withEvidence([{ name: 'A' }, { name: 'B' }], (n) => (n === 'A' ? { grade: 'A-', sources: 6 } : { grade: 'C', sources: 1 })), total: 2, shown: 2, withEmail: 0 };
  ok(/1 of 2 shown rest on more than one independent source/.test(cq.toTable(good).caption),
    'a multi-source row counts; a single-source one does not, whatever its grade');
}

// ── the one line handed to whoever WRITES the answer ─────────────────────────────────────────────
//
// The live failure this closes: the canvas table said `C · 1 source` on every row and "0 rest on more
// than one independent source" in its caption, while the spoken sentence above it read "I've added the
// 28,721 leadership contacts". The table was honest; the sentence was written from counts that say how
// MUCH was found and nothing about whether any of it is supported.
{
  const mk = (lookup, n) => ({ rows: cq.withEvidence(Array.from({ length: n }, (_, i) => ({ name: `P${i}` })), lookup) });

  const none = cq.evidenceSummary(mk(() => null, 3));
  ok(/0 of 3 shown rest on more than one independent source/.test(none)
    && /3 not in the evidence log at all/.test(none),
    'CRITICAL: a wholly unsupported list says so in words the answer-writer can use verbatim');

  const mixed = cq.evidenceSummary(mk((nm) => (nm === 'P0' ? { grade: 'A-', sources: 6 } : nm === 'P1' ? { grade: 'C', sources: 1 } : null), 3));
  ok(/1 of 3 shown rest on more than one independent source/.test(mixed), 'corroborated rows are counted');
  ok(/1 on a single source/.test(mixed) && /1 not in the evidence log at all/.test(mixed),
    'CRITICAL: single-sourced and never-seen are REPORTED SEPARATELY — collapsing them hides which is which');

  // Silence has to be distinguishable from "nothing supports this".
  ok(cq.evidenceSummary({ rows: [{ name: 'A' }] }) === null,
    'CRITICAL: rows with no evidence attached → null, so a caller can tell "nothing to say" from "nothing supports it"');
  ok(cq.evidenceSummary({ rows: [] }) === null && cq.evidenceSummary(null) === null && cq.evidenceSummary({}) === null,
    'empty/missing → null, never throws');

  // A fully corroborated list must not carry the caveats it has not earned.
  const good = cq.evidenceSummary(mk(() => ({ grade: 'A-', sources: 4 }), 2));
  ok(/2 of 2 shown rest on more than one independent source/.test(good)
    && !/single source/.test(good) && !/not in the evidence log/.test(good),
    'a well-supported list reads clean — the caveats appear only when they are true');
}

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
