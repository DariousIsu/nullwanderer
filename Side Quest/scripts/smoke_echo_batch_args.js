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

// ── the dispatch cap gives canvas writes room ───────────────────────────────────────────────────
{
  const m = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  ok(/_canvasWrites\.slice\(0, 24\)/.test(m),
    'canvas writes get their own allowance — clipping a 14-block document at 4 is what leaves an empty tab');
  ok(/_otherTags\.slice\(0, 4\)/.test(m),
    'SAFETY: the cap on EXPENSIVE tags (searches, agents) is unchanged at 4');
  ok(/block_type":"heading"[^\n]*block_type":"paragraph"/.test(m),
    'the manifest shows the batched array form, so there is nothing left to guess');
}

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
