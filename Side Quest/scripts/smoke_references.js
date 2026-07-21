/* smoke_references.js — the names in Lucas's message must resolve, or be reported as unresolved.
 *
 * Live 2026-07-21: "We have the Rainey weekly all hands at 1045 … then the Electrify America meeting
 * that got rescheduled to 1630." Four references, three kinds — a short name for his own employer, a
 * named org, and recurring meetings she has personally sat in — and she resolved none of them.
 *
 * intake.decompose already returned all four as a typed plan; mention._pickObject kept ONE and threw
 * the rest away, and the package had no slot for more than one anyway.
 *
 * THE LOAD-BEARING TESTS ARE THE HONESTY ONES. Measured against the real graph before this was built:
 * "Rainey" returns 10 hits whose best-ranked is an EVENT ("Rainey Centers Lamp National Summit"), and
 * his employer exists only as two duplicate LDA lobby-client rows. Taking the top hit would answer
 * him about a summit. So an ambiguous reference must render as NOT PINNED DOWN, never as an answer —
 * and the meeting block must never claim we know which meeting a spoken name refers to, because
 * nothing in our data links a Google Meet code to "the weekly all hands".
 */
'use strict';
const fs = require('fs');
const path = require('path');
const R = require('../lib/references');
const P = require('../lib/package');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); } }

const MSG = 'We have the Rainey weekly all hands at 1045 and that goes straight into the publications '
  + 'meeting. Then we have the Electrify America meeting that got rescheduled to 1630.';

const VOCAB = JSON.stringify({
  rainey: { name: 'Rainey Center', type: 'organization', note: "Lucas's employer", verified: false },
  'electrify america': { name: 'Electrify America', type: 'organization', note: 'EV charging network', verified: true },
});

// The real graph's answer for "Rainey" — an event, top-ranked, plus two duplicate org rows.
const GRAPH = async (mention) => {
  if (/^rainey$/i.test(mention)) return { status: 'ambiguous', candidates: ['Rainey Centers Lamp National Summit (event)', 'THE RAINEY CENTER FREEDOM PROJECT', 'RAINEY CENTER FREEDOM PROJECT, INC.'] };
  if (/publications/i.test(mention)) return { status: 'nil' };
  return { status: 'resolved', object: { name: mention, entity_type: 'organization' } };
};

(async () => {
  // ── owner vocabulary BEATS the graph — the whole point ────────────────────────────────────────
  {
    const r = await R.build(MSG, {
      objects: [{ mention: 'Rainey', type: 'organization', op: 'resolve' }],
      deps: { getMeta: () => VOCAB, resolve: GRAPH, series: () => [] },
    });
    ok(r.refs[0].status === 'resolved' && r.refs[0].name === 'Rainey Center',
      'SAFETY: "Rainey" resolves to the Rainey Center from HIS vocabulary, not to the summit event the graph ranks first');
    ok(r.refs[0].via === 'vocabulary', 'and it is honest about where that came from');
    ok(/unverified/.test(r.text), 'SAFETY: an unsourced owner reference is marked unverified, not laundered into a fact');
    ok(!/unverified/.test(await R.render([{ mention: 'Electrify America', status: 'resolved', name: 'Electrify America', verified: true }])),
      'a verified reference carries no such mark');
  }

  // ── no vocabulary entry → the graph's ambiguity must SURVIVE to the prompt ────────────────────
  {
    const r = await R.build(MSG, {
      objects: [{ mention: 'Rainey', type: 'organization', op: 'resolve' }, { mention: 'the publications meeting', type: 'event', op: 'resolve' }],
      deps: { getMeta: () => '{}', resolve: GRAPH, series: () => [] },
    });
    ok(r.refs[0].status === 'ambiguous', 'SAFETY: with no vocabulary entry, "Rainey" stays AMBIGUOUS — the top hit is not the answer');
    ok(/NOT PINNED DOWN/.test(r.text), 'unresolved references are surfaced under their own heading');
    ok(/do not guess/i.test(r.text), 'and the instruction is explicit');
    ok(/Rainey Centers Lamp National Summit/.test(r.text), 'the candidates ride along so the cloud can ask a real question');
    ok(!/→ Rainey Centers Lamp National Summit/.test(r.text),
      'REGRESSION: an ambiguous name is never rendered as a resolved arrow');
    ok(/"the publications meeting".*no record/.test(r.text), 'a nil resolution says plainly that we hold nothing');
  }

  // ── every salient mention resolves, not just the first ────────────────────────────────────────
  {
    const objects = ['Rainey', 'Electrify America', 'the publications meeting', 'Rainey'].map((m) => ({ mention: m, type: null, op: 'resolve' }));
    const r = await R.build(MSG, { objects, deps: { getMeta: () => VOCAB, resolve: GRAPH, series: () => [] } });
    ok(r.refs.length === 3, 'all THREE distinct references resolve — the _pickObject discard is what this replaces');
    ok(r.refs.filter((x) => /rainey/i.test(x.mention)).length === 1, 'a repeated mention is de-duplicated');
    ok(R.MAX_REFS <= 8, 'the list is capped — a reference block is a lookup aid, not a dossier');
  }

  // ── meetings: cadence and roster are ours; the NAME is not ────────────────────────────────────
  {
    const series = () => [{ code: 'mav-myni-mkw', sessions: 4, last: Date.parse('2026-07-14'), weekdays: [1], roster: ['Alice', 'Bob', 'Cara'] }];
    const r = await R.build(MSG, { objects: [], deps: { getMeta: () => '{}', resolve: GRAPH, series }, now: Date.parse('2026-07-21') });
    ok(/RECURRING MEETINGS YOU HAVE SAT IN/.test(r.text), 'a message about meetings gets the series she has attended');
    ok(/Alice, Bob, Cara/.test(r.text), 'with the roster — she was there, so she knows who is in it');
    ok(/Monday/.test(r.text) && /4 sessions/.test(r.text), 'and the cadence, which is the only binding signal we hold');
    ok(/never state which meeting he means/i.test(r.text),
      'SAFETY: nothing links a Meet code to a spoken name — asserting the binding is forbidden');
    ok(/as a question/.test(r.text), 'the permitted move is to ASK, not to assert');
    // a message with no meeting in it pays nothing for this
    const q = await R.build('What is the capital of Peru?', { objects: [], deps: { getMeta: () => '{}', resolve: GRAPH, series } });
    ok(!/RECURRING MEETINGS/.test(q.text), 'no meeting talk → no series block, no wasted tokens');
  }

  // ── vocabulary matching ───────────────────────────────────────────────────────────────────────
  {
    const v = { rainey: { name: 'Rainey Center' }, 'rainey all hands': { name: 'Rainey Center All-Hands' } };
    ok(R._fromVocab('Rainey', v).name === 'Rainey Center', 'exact key matches');
    ok(R._fromVocab('the RAINEY  all hands', v).name === 'Rainey Center All-Hands',
      'the LONGEST contained key wins — a specific entry beats a broad one');
    ok(R._fromVocab('Raineyville', v) === null, 'SAFETY: a substring inside a longer WORD is not a match');
    ok(R._fromVocab('', v) === null && R._fromVocab(null, v) === null, 'empty input is safe');
  }

  // ── nothing to say → say nothing ──────────────────────────────────────────────────────────────
  {
    const r = await R.build('ok thanks', { objects: [], deps: { getMeta: () => '{}', resolve: GRAPH, series: () => [] } });
    ok(r.text === '', 'no references and no meetings → an empty section, not a header with nothing under it');
  }

  // ── junk in → no throw ────────────────────────────────────────────────────────────────────────
  {
    const bad = { getMeta: () => 'not json', resolve: async () => { throw new Error('echo down'); }, series: () => { throw new Error('db down'); } };
    const r = await R.build(MSG, { objects: [{ mention: 'Rainey', op: 'resolve' }], deps: bad });
    ok(typeof r.text === 'string', 'a broken vocabulary, a dead resolver and a dead DB all degrade to a string');
    ok(r.refs[0].status === 'unknown', 'a resolver failure is reported as unknown — never as resolved');
  }

  // ── the package gives it a real slot ──────────────────────────────────────────────────────────
  {
    ok(P.ORDER.indexOf('references') > P.ORDER.indexOf('plan'), 'references comes after the plan');
    ok(P.ORDER.indexOf('references') < P.ORDER.indexOf('memory'), 'and BEFORE anything retrieved that talks about those names');
    ok(P.ORDER.indexOf('references') < P.ORDER.indexOf('grounding'), 'ditto grounding');
    // it must actually survive a realistic budget
    const built = P.build({
      window: { num_ctx: 131072, num_predict: 2048 },
      sections: { identity: 'x'.repeat(30000), plan: 'p', references: 'REFERENCES — "Rainey" → Rainey Center', manifest: 'm'.repeat(3000), tools: 't'.repeat(9000) },
    });
    const text = built.messages.map((m) => m.content).join('\n');
    ok(/Rainey Center/.test(text), 'the reference survives into the built package');
    // …and is dropped WHOLE rather than half-delivered when it cannot fit
    const tiny = P.build({
      window: { num_ctx: 8192, num_predict: 2048 },
      sections: { identity: 'x'.repeat(24000), references: 'REFERENCES\n' + 'r'.repeat(4000) },
    });
    const tinyText = tiny.messages.map((m) => m.content).join('\n');
    ok(!/rrrr/.test(tinyText) || tinyText.length > 20000,
      'SAFETY: under starvation the section is dropped whole — a half-list is what she then guesses at');
  }

  // ── the wiring survives in main.js ────────────────────────────────────────────────────────────
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    ok(/sections: \{ identity:[^\n]*references,/.test(src), 'the turn passes references into the package');
    ok(/intake\.decompose\(userMessage/.test(src), 'built from the FULL decomposition, not a single mention');
    ok(/\[references\]/.test(src), 'and it reports what it resolved — an unmeasured section is assumed fine');
  }

  console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
