/* Smoke: lib/ner.js — the local NER tier (mention→object chain, tier 1).
 * PURE tests (span aggregation) always run offline/deterministic → gate-safe.
 * LIVE tests (real bert-base-NER) run only if the model loads (cached in data/models); otherwise SKIP,
 * so the offline gate never fails on a missing model download.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_ner.js
 */
'use strict';
const ner = require('../lib/ner');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// ---- PURE: span aggregation from synthetic token rows (no model) ----
(() => {
  // "Who is Donald Trump?" — B-/I-PER with offsets → one clean "Donald Trump" person span.
  const rows1 = [
    { entity: 'B-PER', word: 'Donald', score: 0.99, start: 7, end: 13 },
    { entity: 'I-PER', word: 'Trump', score: 0.99, start: 14, end: 19 },
  ];
  const s1 = ner._aggregate(rows1, 'Who is Donald Trump?');
  ok(s1.length === 1 && s1[0].text === 'Donald Trump' && s1[0].kgType === 'person', 'B-/I-PER → "Donald Trump" (person)');

  // offsets keep punctuation intact: "John F. Kennedy" must NOT become "John F . Kennedy"
  const txt2 = 'Who is John F. Kennedy?';
  const rows2 = [
    { entity: 'B-PER', word: 'John', score: 0.99, start: 7, end: 11 },
    { entity: 'I-PER', word: 'F', score: 0.98, start: 12, end: 13 },
    { entity: 'I-PER', word: '.', score: 0.9, start: 13, end: 14 },
    { entity: 'I-PER', word: 'Kennedy', score: 0.99, start: 15, end: 22 },
  ];
  const s2 = ner._aggregate(rows2, txt2);
  ok(s2.length === 1 && s2[0].text === 'John F. Kennedy', 'offsets slice original → "John F. Kennedy" intact');

  // no offsets → punctuation-aware join fallback
  ok(ner._joinTokens(['John', 'F', '.', 'Kennedy']) === 'John F. Kennedy', 'join fallback attaches punctuation');
  ok(ner._joinTokens(['Heritage', 'Found', '##ation']) === 'Heritage Foundation', 'join fallback merges ## wordpieces');

  // ORG mapping + two adjacent DIFFERENT entities split
  const rows3 = [
    { entity: 'B-ORG', word: 'Heritage', score: 0.99, start: 0, end: 8 },
    { entity: 'I-ORG', word: 'Foundation', score: 0.99, start: 9, end: 19 },
    { entity: 'B-PER', word: 'Kevin', score: 0.99, start: 24, end: 29 },
  ];
  const s3 = ner._aggregate(rows3, 'Heritage Foundation and Kevin');
  ok(s3.length === 2 && s3[0].kgType === 'organization' && s3[1].kgType === 'person', 'ORG span + adjacent PER split into two');

  // MISC dropped (kgType null), score floor works via detect()’s filter is separate; here just mapping
  const s4 = ner._aggregate([{ entity: 'B-MISC', word: 'Republican', score: 0.9, start: 0, end: 10 }], 'Republican');
  ok(s4.length === 1 && s4[0].kgType === null, 'MISC → kgType null (dropped downstream)');
})();

// ---- LIVE: real bert-base-NER on the exact strings that broke the regex ----
(async () => {
  const up = await ner.warm();
  if (!up) { console.log('  ⚠ NER model unavailable (no cache/offline) — skipping LIVE tests'); }
  else {
    const trump = await ner.topMention('Who is Donald Trump?');
    ok(trump && trump.mention === 'Donald Trump' && trump.kgType === 'person', `LIVE "Who is Donald Trump?" → ${JSON.stringify(trump)}`);
    const her = await ner.topMention('What is the Heritage Foundation?');
    ok(her && /Heritage Foundation/.test(her.mention) && her.kgType === 'organization', `LIVE "What is the Heritage Foundation?" → ${JSON.stringify(her)}`);
    const jfk = await ner.topMention('Who is John F. Kennedy?');
    ok(jfk && jfk.mention === 'John F. Kennedy' && jfk.kgType === 'person', `LIVE "Who is John F. Kennedy?" → ${JSON.stringify(jfk)}`);
    const none = await ner.topMention('What did we decide about the op-ed?');
    ok(none === null, `LIVE no-entity turn → null (${JSON.stringify(none)})`);
    const lower = await ner.topMention('who is john curtis?');
    // cased model MISSES lowercase → null is EXPECTED (escalates to the cloud tier). Documented, not a bug.
    ok(lower === null, `LIVE lowercase miss → null (expected; escalates to cloud) (${JSON.stringify(lower)})`);
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
