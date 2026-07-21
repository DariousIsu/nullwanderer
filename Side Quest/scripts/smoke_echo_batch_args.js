/* smoke_echo_batch_args.js — one tag may carry a whole document.
 *
 * Live 2026-07-21, the second attempt at the China brief. The tab was created, then:
 *
 *   [route-obs] FIRST ERROR saga_canvas_add_block() → args weren't valid JSON
 *               (Unexpected non-whitespace character after JSON at position 372)
 *
 * …and she reported "Canvas created with section placeholders and queries dispatched." There were no
 * placeholders: every block died with that parse error.
 *
 * The cause is arithmetic, not carelessness. A canvas document is many blocks — a heading and a
 * paragraph per section, so ~14 for a seven-section brief — while one <echo-do> carried exactly ONE
 * JSON object and the in-turn hop cap is 4. Writing a paper one tag at a time is impossible, so she
 * batched, and a single JSON.parse threw the whole thing away.
 *
 * A batched tag now expands to one tag per object at PARSE time, so every downstream consumer —
 * dispatch, the tier gate, the canvas mirror — sees an ordinary single-argument call.
 *
 * The load-bearing tests are the ones proving prose cannot break the splitter (markdown is full of
 * braces and quotes) and that genuine garbage is still REPORTED rather than silently swallowed.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const es = require('../lib/echo_suit');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); } }

const tags = (s) => es.parseEchoTags(s);
const doTag = (body, name = 'saga_canvas_add_block') => `<echo-do name="${name}">${body}</echo-do>`;

// ── the three shapes she actually writes ────────────────────────────────────────────────────────
{
  const one = tags(doTag('{"tab_key":"K","block_type":"paragraph","data":{"markdown":"hi"}}'));
  ok(one.length === 1 && one[0].args.block_type === 'paragraph', 'a single object still parses exactly as before');
  ok(!one[0].parseError, 'with no error');

  const arr = tags(doTag('[{"tab_key":"K","block_type":"heading","data":{"level":2,"text":"A"}},{"tab_key":"K","block_type":"paragraph","data":{"markdown":"B"}}]'));
  ok(arr.length === 2, 'a JSON ARRAY becomes one tag per block');
  ok(arr[0].args.block_type === 'heading' && arr[1].args.block_type === 'paragraph', 'in the order written');
  ok(arr.every((t) => t.kind === 'do' && t.name === 'saga_canvas_add_block'), 'each carries the tool name');
  ok(arr.every((t) => !t.parseError), 'and none reports an error');

  // this is the exact shape that failed live — objects back to back, no array brackets
  const cat = tags(doTag('{"tab_key":"K","block_type":"heading","data":{"level":2,"text":"A"}}{"tab_key":"K","block_type":"paragraph","data":{"markdown":"B"}}'));
  ok(cat.length === 2, 'CONCATENATED objects also expand — the live failure at "position 372"');
  ok(cat[0].args.data.text === 'A' && cat[1].args.data.markdown === 'B', 'each keeps its own payload');
}

// ── SAFETY: prose must not be able to break the splitter ────────────────────────────────────────
{
  const braces = tags(doTag('{"tab_key":"K","block_type":"paragraph","data":{"markdown":"use {curly} braces and \\"quotes\\" inline"}}'));
  ok(braces.length === 1, 'SAFETY: braces and escaped quotes INSIDE a markdown string do not split the object');
  ok(/\{curly\}/.test(braces[0].args.data.markdown) && /"quotes"/.test(braces[0].args.data.markdown),
    'and the prose survives byte-for-byte — markdown is mostly braces and quotes');

  const nested = tags(doTag('[{"tab_key":"K","block_type":"table","data":{"headers":["a"],"rows":[["{x}"]],"caption":"}"}}]'));
  ok(nested.length === 1 && nested[0].args.data.caption === '}', 'a lone closing brace inside a string is not a boundary');
}

// ── SAFETY: a real error is still an error ──────────────────────────────────────────────────────
{
  const junk = tags(doTag('not json at all', 'x'));
  ok(junk.length === 1 && junk[0].parseError, 'SAFETY: unparseable args still report parseError — never silently dropped');
  ok(Object.keys(junk[0].args || {}).length === 0, 'and carry no invented arguments');

  const empty = tags(doTag(''));
  ok(empty.length === 1 && !empty[0].parseError, 'an empty body is not an error, just empty args');

  // a half-broken batch keeps the good blocks rather than losing the document
  const mixed = tags(doTag('{"tab_key":"K","block_type":"heading","data":{"level":2,"text":"A"}}{oops}'));
  ok(mixed.length >= 1 && mixed[0].args.data.text === 'A',
    'one malformed block in a batch does not discard the ones that parsed');
}

// ── other tag kinds are untouched ───────────────────────────────────────────────────────────────
{
  const mix = tags('<echo-find>who is X</echo-find>' + doTag('[{"a":1},{"a":2}]') + '<echo-recipe name="r"/>');
  ok(mix.filter((t) => t.kind === 'find').length === 1, 'find tags still parse');
  ok(mix.filter((t) => t.kind === 'recipe').length === 1, 'recipe tags still parse');
  ok(mix.filter((t) => t.kind === 'do').length === 2, 'and the batch expanded alongside them');
  ok(mix[0].kind === 'find' && mix[mix.length - 1].kind === 'recipe',
    'document order is preserved across the expansion');
}

// ── ⭐ a tag CUT OFF mid-write is reported, not silently lost ────────────────────────────────────
// Live 2026-07-21: generation stopped INSIDE an <echo-do> — [{"tab_key":"china_ai_hw","block_type":"
// — so the regex matched nothing, the document never happened, and the turn row was stored with
// truncated=0. The tag genuinely cannot be recovered; what matters is that it must not look like a
// turn in which she simply chose not to act.
{
  const errs = [];
  const orig = console.error;
  console.error = (...a) => errs.push(a.join(' '));
  try {
    const cut = es.parseEchoTags('Plan.\n<echo-do name="saga_canvas_add_block">[{"tab_key":"K","block_type":"');
    ok(cut.length === 0, 'an unclosed tag yields no action — it is genuinely unrecoverable');
    ok(errs.some((e) => /UNCLOSED <echo-do>/.test(e)), 'SAFETY: but it is REPORTED, loudly');
    ok(errs.some((e) => /that action was LOST/.test(e)), 'and named as a loss, not a no-op');
    errs.length = 0;
    es.parseEchoTags(doTag('{"tab_key":"K","block_type":"paragraph","data":{"markdown":"hi"}}'));
    ok(errs.length === 0, 'a well-formed tag reports nothing');
  } finally { console.error = orig; }
}

// ── the manifest asks for ONE SHORT TAG PER BLOCK ───────────────────────────────────────────────
// The array form still parses (above) and stays supported, but a long tag makes the whole document
// one fragile unit — the live truncation lost every block because no single object had closed.
// Short tags fail independently. Affordable only because the caps came off: the array form existed
// to fit a whole document into 4 tags.
{
  const m = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  ok(/Emit ONE tag per block/.test(m), 'the manifest asks for one tag per block');
  ok(/never put the whole document in a single tag/.test(m), 'and says why: a cut-off long tag loses that block');
}

// ── the dispatch cap gives canvas writes room ───────────────────────────────────────────────────
{
  const m = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  // 2026-07-21, Lucas: "no spend concern… just make sure there are not artificial caps truncating
  // requests." Both allowances were raised and the expensive-tag one is now the SAME bound as the
  // in-turn hop chain, so there is one number to reason about rather than two that can disagree.
  ok(/_canvasWrites\.slice\(0, 60\)/.test(m),
    'canvas writes get their own allowance — clipping a 14-block document is what leaves an empty tab');
  ok(/_otherTags\.slice\(0, MAX_ECHO_HOPS\)/.test(m),
    'expensive tags are bounded by the hop budget, not a separate hardcoded number');
  ok(/const MAX_ECHO_HOPS = require\('\.\/lib\/config'\)\.maxEchoHops\(\)/.test(m),
    'and that budget is CONFIGURATION, not a literal buried in the file');
  ok(/block_type":"heading"[^\n]*block_type":"paragraph"/.test(m),
    'the manifest shows the batched array form, so there is nothing left to guess');
}

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
