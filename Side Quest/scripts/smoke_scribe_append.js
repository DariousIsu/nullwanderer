/* smoke_scribe_append.js — the meeting notes must not eat themselves.
 *
 * Lucas, 2026-07-21: "it also looks like we are eating our meeting notes."
 *
 * Caught live, mid-Huddle. An hour of minutes had become 749 characters opening with:
 *
 *     **Topics**
 *     - All previous topics remain in effect.
 *
 * Six words in place of the meeting's first hour. The cause was structural, not a bad model: every
 * ~6 caption lines the scribe handed the model ALL minutes so far plus the new lines and asked for
 * "the UPDATED minutes", then overwrote its own source with the result. A lossy re-encode loop, told
 * "do not repeat points" — which a model reasonably reads as "don't restate earlier topics" — and
 * finally .slice(-12000), which keeps the tail and eats the START of the meeting.
 *
 * That rolling rewrite existed to fit a small context. The largest meeting on record is 47,352 chars
 * (~12k tokens) against a 131,072-token window, so the whole transcript fits in 9% of it.
 *
 * Fixed in two moves, and these tests pin both:
 *   1. The live pass summarizes ONLY its own window and APPENDS — losing an earlier segment is no
 *      longer expressible, because no later call can reach one.
 *   2. finalize() writes the record in ONE pass over the RAW TRANSCRIPT on the big model, so the
 *      authoritative minutes never descend from a summary at all.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const S = require('../lib/meeting_scribe');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); } }

// ── the segment prompt cannot ask for a rewrite ─────────────────────────────────────────────────
{
  const p = S.buildSegmentPrompt('Bill: we need the Summit dates.', { at: '10:45' });
  ok(/ONLY this stretch/.test(p), 'the live pass is scoped to its own window');
  ok(/from 10:45/.test(p), 'and stamped, so the segments stay ordered');
  ok(/never write a placeholder like "previous topics still apply"/i.test(p),
    'SAFETY: the exact failure phrasing is named and forbidden');
  ok(/not yours to edit/.test(p), 'and earlier minutes are declared out of reach');
  ok(!/Minutes so far/.test(p) && !/UPDATED minutes/.test(p),
    'REGRESSION: prior minutes are NOT fed back in — that feedback loop IS the bug');
  ok(!/do not repeat points/.test(p),
    'REGRESSION: the instruction a model read as "drop the earlier topics" is gone');
}

// ── the digest reads what was actually SAID ─────────────────────────────────────────────────────
{
  const p = S.buildDigestPrompt('Bill Dunne: Summit dates by Friday.\nSarah Hunt: I will circulate.', { title: 'Rainey Weekly Huddle', roster: 'Bill Dunne, Sarah Hunt' });
  ok(/Rainey Weekly Huddle/.test(p) && /Bill Dunne, Sarah Hunt/.test(p), 'the digest knows the meeting and the room');
  ok(/WHOLE meeting from its opening to its close — not just the end/.test(p),
    'SAFETY: it is told to cover the opening, the part the old loop always lost');
  ok(/Open questions/.test(p), 'unresolved threads are captured, not just decisions');
  ok(/if a stretch is garbled or the captions dropped, say so/i.test(p),
    'SAFETY: a gap is reported, never smoothed over');
  ok(/Invent nothing and infer nothing/.test(p), 'and nothing is invented to fill it');
}

// ── an oversized meeting is BUILT WHOLE, never trimmed ──────────────────────────────────────────
// Lucas 2026-07-21: "instead of eating an existing meeting if full it should build the meeting
// document as a whole." buildDigestPrompt used to end in .slice(-400000) — the same tail-eating bug
// one layer up, and it would have deleted the START of a long meeting exactly as the rolling rewrite
// did. It is gone; planChunks splits instead.
{
  ok(!/slice\(-400000\)/.test(fs.readFileSync(path.join(__dirname, '..', 'lib', 'meeting_scribe.js'), 'utf8')),
    'REGRESSION: the digest no longer truncates the transcript');

  const lines = Array.from({ length: 400 }, (_, i) => `Speaker ${i % 5}: line ${i} of the meeting`);
  const text = lines.join('\n');
  const chunks = S.planChunks(text, 2000);
  ok(chunks.length > 1, 'an oversized transcript splits');
  ok(chunks.every((c) => c.length <= 2000), 'every chunk fits the budget');
  // THE property that matters: nothing is lost and nothing is reordered.
  ok(chunks.join('\n') === text, 'SAFETY: the chunks reassemble to the EXACT original — no line dropped, no reorder');
  ok(chunks.every((c) => !/^\S*line \d+ of the meeti$/m.test(c)), 'splits land on line boundaries, never mid-line');

  ok(S.planChunks(text, 10_000_000).length === 1, 'a transcript that fits is one pass');
  ok(S.planChunks('', 2000).length === 0 && S.planChunks(null, 2000).length === 0, 'empty in → nothing out');
  // one line longer than the whole budget is emitted WHOLE rather than cut
  const huge = 'Speaker: ' + 'x'.repeat(5000);
  ok(S.planChunks(huge, 1000).join('\n') === huge, 'SAFETY: an over-long single line survives intact rather than being cut to fit');

  // the budget leaves room for the reply
  ok(S.inputBudgetChars(32768, 6000) < 32768 * 4, 'the input budget subtracts the output budget');
  ok(S.inputBudgetChars(131072, 6000) > S.inputBudgetChars(32768, 6000), 'a bigger window buys a bigger budget');
  ok(S.inputBudgetChars(0, 0) >= 4000, 'a nonsense window still yields a usable floor');
}

// ── a PART knows it is not the opening; a MERGE may not summarize ───────────────────────────────
{
  const p = S.buildPartPrompt('Bill: hello', { i: 3, n: 5, title: 'Rainey Weekly Huddle', roster: 'Bill Dunne' });
  ok(/section 3 of 5/.test(p), 'a part knows its position');
  ok(/do NOT describe this as the opening/.test(p),
    'SAFETY: a middle section is told not to narrate itself as the start of the meeting');
  ok(/only pass anyone will make over these lines/.test(p), 'and that anything it omits is lost for good');
  ok(!/do NOT describe this as the opening/.test(S.buildPartPrompt('x', { i: 1, n: 3 })),
    'section 1 IS the opening, so it is not told otherwise');

  const m = S.buildMergePrompt(['- topic A', '- topic B'], { title: 'Huddle' });
  ok(/This is a MERGE, not a summary/.test(m), 'SAFETY: the merge is told it is not a summarization');
  ok(/EVERY topic, decision, action item and open question above must appear/.test(m), 'everything must survive');
  ok(/Do NOT shorten, generalise, rank, or drop anything for being minor/.test(m), 'and compression is named and forbidden');
  ok(/keep BOTH and note the disagreement/.test(m), 'a conflict between sections is preserved, not resolved away');
  ok(/topic A/.test(m) && /topic B/.test(m), 'the parts are actually carried into the prompt');
}

// ── the calendar supplies surnames the captions never had ───────────────────────────────────────
{
  const b = S.peopleBlock({ roster: 'Megan, Bill Dunne', invited: 'Megan Sibley, Bill Dunne, Clark Powers' });
  ok(/People heard speaking: Megan, Bill Dunne/.test(b), 'who actually spoke is ours, from the captions');
  ok(/Everyone invited .*Megan Sibley/.test(b),
    'the calendar list rides along — "Sibley" appears ZERO times in the captions, which is why Google could attribute and we could not');
  ok(/use these spellings and full names/.test(b), 'and it is given as the spelling authority');
  ok(S.peopleBlock({}) === '', 'no people known → no block');
  ok(/Everyone invited/.test(S.buildDigestPrompt('t', { invited: 'Megan Sibley' })), 'the digest carries it');
  ok(/Everyone invited/.test(S.buildPartPrompt('t', { i: 1, n: 2, invited: 'Megan Sibley' })), 'and so does every part');
}

// ── append-only, and the OLDEST survive ─────────────────────────────────────────────────────────
{
  const store = new Map();
  const db = require('../lib/db');
  const _get = db.getMeta, _set = db.setMeta;
  db.getMeta = (k) => (store.has(k) ? store.get(k) : null);
  db.setMeta = (k, v) => { store.set(k, String(v)); };
  try {
    for (let i = 1; i <= 3; i++) S.appendSegment({ at: `10:0${i}`, text: `- point ${i}` });
    const segs = S.segments();
    ok(segs.length === 3 && segs[0].text === '- point 1', 'segments accumulate in order');
    ok(/10:01[\s\S]*point 1[\s\S]*10:03[\s\S]*point 3/.test(S.minutes()),
      'the live view renders every segment, oldest first');

    // a runaway meeting drops from the MIDDLE and says so — never the opening
    for (let i = 4; i <= 120; i++) S.appendSegment({ at: `11:${i}`, text: `- point ${i}` });
    const many = S.segments();
    ok(many.length <= 81, 'the segment list is bounded');
    ok(many[0].text === '- point 1', 'SAFETY: the OPENING of the meeting survives the bound');
    ok(many[many.length - 1].text === '- point 120', 'and so does the close');
    ok(many.some((r) => /intermediate segment\(s\) omitted/.test(r.text)),
      'SAFETY: a drop is DECLARED in the record, never silent');

    // reset clears the room for the next meeting
    S.reset();
    ok(S.segments().length === 0, 'segments are per-meeting — last week\'s minutes are not this week\'s');
  } finally { db.getMeta = _get; db.setMeta = _set; }
}

// ── the wiring ──────────────────────────────────────────────────────────────────────────────────
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'meeting_scribe.js'), 'utf8');
  ok(/appendSegment\(\{ at, text: seg \}\)/.test(src), 'the live tick appends');
  ok(!/setMeta\('scribe_minutes', updated\.slice\(-12000\)\)/.test(src),
    'REGRESSION: the rewrite-and-truncate line is gone');
  ok(/d\.rawTranscript \? await d\.rawTranscript\(\) : await rawTranscriptForMeeting\(\)/.test(src),
    'finalize digests from the RAW transcript, injectable for tests (async since it now reads the calendar)');
  ok(/digestWhole\(d, raw\.text, opts\)/.test(src), 'and routes through the build-whole path, not a single truncating call');
  ok(/merged\.length < joined\.length \* 0\.5/.test(src),
    'SAFETY: a merge that came back short is REJECTED and the sections ship whole');
  ok(/w\.num_ctx > numCtx/.test(src),
    'the resolved window is only trusted when it BEATS the configured one — cloud_window fails safe to 8192');
  ok(/started \? rows\.filter\(\(r\) => r\.ts >= started\) : rows/.test(src),
    'SAFETY: a recurring series reuses its Meet code — the digest must not fold in last week\'s session');
  ok(/scribe_last_minutes/.test(src), 'the full digest is handed back, not just the recap');

  const m = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  ok(/scribe\.lastMinutes\(\) \|\| _liveMinutes/.test(m),
    'main reads the minutes AFTER finalize — reading them first captured only the degraded live view');
}

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
