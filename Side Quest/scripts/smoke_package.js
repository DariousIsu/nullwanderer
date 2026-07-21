/* smoke_package.js — the local model's output is a ROADMAP, and it is bounded and measured.
 *
 * The cloud gets a fresh context every call, so whatever is not in the package does not exist for
 * that turn. Two failure modes, both silent: an overflowing package drops its tail, an underfilled
 * one pays frontier prices for a window it never uses. Every assertion here exists because one of
 * those would otherwise pass unnoticed — which is exactly how num_ctx sat at 8192 for months.
 *
 * Pure module, no I/O — nothing is stubbed because nothing is fetched.
 */
'use strict';
const P = require('../lib/package');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); } }

const rep = (r, name) => r.report.sections.find((s) => s.name === name);

// ── the budget follows the WINDOW, and reserves room for the reply ──────────────────────────────
{
  const small = P.inputBudgetChars({ num_ctx: 8192, num_predict: 2048 });
  const big = P.inputBudgetChars({ num_ctx: 131072, num_predict: 2048 });
  ok(big > small * 10, 'a 131k window buys an order of magnitude more package than 8k');
  ok(small < 8192 * P.CHARS_PER_TOKEN, 'the reply budget is reserved, not spent on input');
  ok(P.inputBudgetChars({ num_ctx: 1000, num_predict: 900 }) >= 2000, 'a floor keeps a tiny window usable');
}

// ── ⭐ SURVIVAL ORDER: who she is and what was asked outrank retrieved text ──────────────────────
{
  const big = 'g'.repeat(200000);
  const r = P.build({
    budgetChars: 4000,
    sections: {
      identity: 'You are Zoe.', request: 'What are the laws of thermodynamics?',
      plan: 'HOW TO WORK THIS TURN: …', manifest: 'm'.repeat(5000),
      tools: 't'.repeat(5000), memory: 'm'.repeat(5000), grounding: big,
    },
  });
  const c = r.messages[0].content;
  ok(c.includes('You are Zoe.'), 'identity survives a hard squeeze');
  ok(c.includes('What are the laws of thermodynamics?'), 'the REQUEST survives — it is never the thing dropped');
  ok(c.includes('HOW TO WORK THIS TURN'), 'the plan survives');
  ok(rep(r, 'grounding').trimmed, 'grounding is trimmed first');
  ok(rep(r, 'grounding').chars < 200000, 'grounding actually shrank');
  for (const n of ['identity', 'request', 'plan']) ok(!rep(r, n).trimmed, `${n} is never trimmed`);
}

// ── ⭐ an oversized UNTRIMMABLE section must not silently delete the tool menu ────────────────────
// The live first run: identity 30,635c against a 22,118c budget → every weighted budget went to 0 →
// _trim returned only its own marker → "manifest:37↓ tools:37↓". The cloud got 37 characters where
// the tool menu belonged and answered with no tools. Nothing errored.
{
  const r = P.build({
    budgetChars: 22118,
    sections: {
      identity: 'i'.repeat(30635),
      manifest: 'm'.repeat(900), tools: 't'.repeat(5000), grounding: 'g'.repeat(9000),
    },
  });
  ok(rep(r, 'identity').chars === 30635, 'a huge identity is still delivered whole');
  ok(rep(r, 'manifest').chars >= 400, 'REGRESSION: the manifest survives at its floor, never a 37-char stub');
  ok(rep(r, 'tools').chars >= 1200, 'REGRESSION: the tool menu survives at its floor');
  ok(r.report.fit > 1, 'REPORTED as over budget rather than hidden — the operator can see it');
}

// ── a stub is worse than an absence ──────────────────────────────────────────────────────────────
// A truncated tool menu invites calls to tools it no longer lists. Below the floor: drop and say so.
{
  const r = P.build({ budgetChars: 100, sections: { identity: 'i'.repeat(100000), tools: 't'.repeat(5000) } });
  const t = rep(r, 'tools');
  ok(t.chars >= 1200 || t.dropped === true, 'tools is either usable or explicitly DROPPED — never a stub');
  if (t.dropped) {
    ok(!r.messages[0].content.includes('t'.repeat(50)), 'a dropped section is genuinely absent from the package');
    ok(r.report.droppedAny === true, 'the drop is flagged in the report');
    ok(/DROPPED/.test(P.describe(r.report)), 'and named in the one-line log');
  }
  ok(t.raw === 5000, 'the original size is still reported so the loss is quantifiable');
}

// ── content SHORTER than its floor is untouched (the floor is a floor, not a pad) ─────────────────
{
  const r = P.build({ budgetChars: 50000, sections: { identity: 'i', manifest: 'short manifest' } });
  ok(rep(r, 'manifest').chars === 14 && !rep(r, 'manifest').trimmed, 'a small manifest passes through as-is');
  ok(!rep(r, 'manifest').dropped, 'and is NOT dropped for being under the floor');
}

// ── ⭐ THE MANIFEST CARRIES COUNTS AND KEYS, NEVER ROWS ──────────────────────────────────────────
{
  const m = P.buildManifest([
    { key: 'puller.targets', label: 'people/orgs', count: 238475, how: '<echo-recipe name="find-person" arg="NAME"/>' },
    { key: 'doc_contacts', label: 'contacts with an email', count: 42, how: 'contacts query, state=LA' },
    { key: 'news.stories', label: 'tracked stories', count: null, how: '<echo-find>news on X</echo-find>' },
    { key: 'empty.store', label: 'nothing', count: 0, how: 'n/a' },
  ]);
  ok(/238,475/.test(m), 'counts are rendered readably');
  ok(/find-person/.test(m), 'the HOW is included — a count with no key is not actionable');
  ok(/news\.stories/.test(m) && /some/.test(m), 'an unknown count still lists the store (else it can never be asked for)');
  ok(!/empty\.store/.test(m), 'an EMPTY store is omitted — it would only buy a wasted hop');
  ok(m.length < 800, 'the manifest is tens of tokens, not thousands — the whole point');
  ok(P.buildManifest([]) === '', 'no stores → no block');
}

// ── ⭐ THE PLAN: hard commands, back-check, depth ────────────────────────────────────────────────
{
  const p = P.buildPlan({ intent: 'a physics question plus a claim about chip design', depth: { maxHops: 3 }, mustCite: true, unresolved: ['which fab process'] });
  ok(/up to 3 tool call/.test(p), 'the DEPTH budget is stated, not left to guess');
  ok(/BACK-CHECK/.test(p), 'a back-check step is commanded');
  ok(/didn't look|didn’t look/.test(p), 'the honesty rule is explicit: not-having differs from not-looking');
  ok(/Cite the source/.test(p), 'mustCite adds the citation command');
  ok(/which fab process/.test(p), 'known gaps are handed over rather than rediscovered');
  ok(/Answer the question that was asked/.test(p), 'answering the actual question is a hard command');
  // ⭐ ACTION honesty is separate from FACT honesty and failed on its own. Live: "I've added the
  // 28,721 leadership contacts to your canvas" — no canvas write ever happened, no contacts-query
  // ran all day. A wrong fact can be corrected; a described-but-untaken action is unverifiable.
  ok(/DO the thing — do not narrate it/.test(p), 'commands the tag be EMITTED, not described');
  ok(/Emitting the tag IS the action/.test(p), 'names the distinction explicitly');
  // ⭐ WHERE the tags go was never stated, and that is why "do the thing" kept failing on turns where
  // she plainly intended to act. Live 2026-07-21 her interior read "- Create a Canvas document… -
  // Add an introductory paragraph block… Executing actions now." and she emitted ZERO tags: the
  // <think>/<say> contract she was given had no slot for one.
  ok(/WHERE THE TAGS GO: AFTER the closing <\/say>/.test(p), 'the tag position is stated');
  ok(/Not inside <think> — thinking about a tag does not run it/.test(p),
    'and thinking about an action is distinguished from taking it');
  ok(/emitted no tag after <\/say> did nothing at all/.test(p),
    'a described-but-untagged action is named as nothing at all');
  // the position must actually work: say stays clean, the turn is NOT flagged truncated, tags parse
  {
    const { TagStreamParser } = require('../lib/ollama');
    const es = require('../lib/echo_suit');
    const out = '<think>t</think><say>Starting now.</say>\n<echo-do name="saga_canvas_open_tab">{"tab_key":"k"}</echo-do>';
    const parser = new TagStreamParser({});
    parser.feed(out);
    ok(parser.say.trim() === 'Starting now.', 'a tag after </say> does not pollute what Lucas reads');
    ok(parser.mode === 'post', 'SAFETY: and the turn is NOT flagged truncated for ending in tags');
    ok(es.parseEchoTags(out).length === 1, 'and the tag is still dispatched');
  }
  // 2026-07-21 — REWRITTEN, because the old rule was unsatisfiable. It asked her to wait until she
  // "saw the result", but the reply is composed at main.js:6700 and the tags dispatch at :7350,
  // afterwards: seeing the result in the same message is architecturally impossible. Three false
  // completion claims in one day, each with a different cause. The rule now states the mechanical
  // fact — the tag has not run yet — instead of asking for something that cannot be done.
  ok(/A TAG YOU EMIT HAS NOT RUN YET/.test(p), 'states the mechanical fact, not an exhortation');
  ok(/finished and sent before any tool in it is dispatched/.test(p),
    'explains WHY the past tense is always wrong here');
  ok(/THAT is the moment to confirm what actually landed, including if it failed/.test(p),
    'and points to where confirmation legitimately belongs — the follow-up');
  ok(!/unless you emitted its tag this turn AND saw the result/.test(p),
    'REGRESSION: the unsatisfiable "saw the result" wording is gone');
  ok(/I've added|I've put it on your canvas/.test(p), 'quotes the exact false phrasings that occurred');
  ok(/say what you would need/.test(p), 'an honest "I can\'t" is offered as the alternative');
  // ⭐ <echo-find> searches the TOOL CATALOGUE, not the world. Live 2026-07-21: asked for a paper on
  // Chinese semiconductor announcements she fired four <echo-find> calls and got back, four times,
  // "I looked for an Echo tool for … but nothing fit … this may be an open-web question." Our data is
  // US civic records — "our database first" walked her into an empty catalogue and she never reached
  // the web.
  ok(/<echo-find> looks for a TOOL in our catalogue — it does not search the world/.test(p),
    'the scope of echo-find is stated plainly');
  ok(/go straight to the open web/.test(p), 'an off-domain subject skips Echo entirely');
  ok(/Two <echo-find> misses in a row/.test(p), 'and repeated misses are a signal to change tool, not to retry');
}

// ── the manifest also lists what she can PRODUCE ────────────────────────────────────────────────
// A capability with no key is a capability that gets narrated: she knew a canvas existed but had no
// way to reach it, so she described the outcome instead.
{
  const m = P.buildManifest(
    [{ key: 'doc_contacts', label: 'rows', count: 100, how: 'db_query' }],
    { actions: [{ key: 'canvas sheet', label: 'a real tab', how: '<echo-do name="saga_canvas_open_tab">…' }] },
  );
  ok(/WHAT YOU CAN PRODUCE/.test(m), 'actions are listed separately from stores');
  ok(/emit the tag and it happens/.test(m), 'and framed as real, not aspirational');
  ok(/canvas sheet/.test(m) && /saga_canvas_open_tab/.test(m), 'the action carries its actual tag');
  ok(/WHAT YOU CAN REACH/.test(m), 'stores still listed alongside');
  const noActs = P.buildManifest([{ key: 'x', count: 1 }]);
  ok(!/WHAT YOU CAN PRODUCE/.test(noActs), 'no actions → no empty section');
  const onlyActs = P.buildManifest([], { actions: [{ key: 'canvas sheet', how: 'tag' }] });
  ok(/WHAT YOU CAN PRODUCE/.test(onlyActs) && !/WHAT YOU CAN REACH/.test(onlyActs),
    'actions alone still render');
}

// ── plan defaults + the DB-before-web ordering ──────────────────────────────────────────────────
{
  const p = P.buildPlan({ intent: 'factual', depth: { maxHops: 3 }, mustCite: true });
  ok(/database first/i.test(p), 'our own DB is ordered before the open web — the token-spend lever');
  // ⭐ "recipe" is Echo's word for a saved DATA query and collides with the everyday meaning. Live:
  // asked for a burger recipe, she emitted <echo-find>classic beef burger 80/20 chuck</echo-find>
  // and Echo replied "unknown recipe 'Classic Beef Burger 80/20 Chuck'". The old wording here
  // ("prefer ONE well-chosen recipe") pushed her into it.
  ok(/NOT a recipe in any everyday sense/.test(p), 'the recipe/recipe collision is called out explicitly');
  ok(/cooking/.test(p), 'names the exact case that failed');
  ok(/do NOT reach for a tool at all; just answer/.test(p),
    'off-domain questions are told to skip tools entirely, not to search harder');
  ok(!/Prefer ONE well-chosen recipe over several broad searches/.test(p),
    'REGRESSION: the wording that caused it is gone');
  const bare = P.buildPlan({});
  ok(/up to 3 tool call/.test(bare), 'a sane default depth with no args');
  ok(!/Cite the source/.test(bare), 'citation command only when asked for');
  ok(/DO the thing — do not narrate it/.test(bare), 'action honesty is unconditional, not opt-in');
}

// ── the report makes BOTH failure modes visible ──────────────────────────────────────────────────
{
  const under = P.build({ budgetChars: 100000, sections: { identity: 'short', request: 'hi' } });
  ok(under.report.fit < 0.05, 'an underfilled package is reported — we are paying for unused window');
  ok(under.report.trimmedAny === false, 'nothing trimmed → flagged false');
  const over = P.build({ budgetChars: 500, sections: { identity: 'i', grounding: 'g'.repeat(50000) } });
  ok(over.report.trimmedAny === true, 'a trim is always flagged');
  ok(rep(over, 'grounding').raw === 50000, 'the ORIGINAL size is retained so the loss is quantifiable');
  ok(/fit \d+%/.test(P.describe(over.report)), 'describe() gives a one-line per-turn log');
}

// ── trimming never cuts mid-word ─────────────────────────────────────────────────────────────────
{
  const t = P._trim('alpha beta gamma delta epsilon zeta eta theta', 20);
  ok(!/\balph$|\bbet$|\bgamm$/.test(t.split(' […')[0]), 'no mid-word cut');
  ok(/trimmed/.test(t), 'the trim is announced in-band so the model knows it is not the whole picture');
  const para = P._trim('para one text here\n\npara two text here\n\npara three', 30);
  ok(/para one/.test(para), 'prefers a paragraph boundary');
  ok(P._trim('short', 100) === 'short', 'under budget → untouched, no marker');
}

// ── section order is stable and complete ─────────────────────────────────────────────────────────
{
  // `references` added 2026-07-21 — what the NAMES mean has to arrive before any section that talks
  // about them, so it sits straight after the plan and ahead of manifest/tools/memory/grounding.
  ok(P.ORDER.join(',') === 'identity,request,plan,references,manifest,tools,memory,grounding', 'survival order is pinned');
  ok([...P.UNTRIMMABLE].every((n) => P.ORDER.includes(n)), 'every untrimmable section is in the order');
  const wsum = Object.values(P.WEIGHTS).reduce((a, b) => a + b, 0);
  ok(wsum < 1, 'weights leave headroom for the tool results the cloud will pull');
}

// ── WIRING: the packager is actually in front of the cloud call ─────────────────────────────────
// Built-but-not-connected is this codebase's signature failure, so assert the seam itself.
{
  const fs = require('fs'), path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  ok(/const pkg = require\('\.\/lib\/package'\)/.test(src), 'main.js builds the package for the cloud turn');
  ok(/pkg\.buildManifest\(inv, \{ actions:/.test(src),
    'the manifest is built from the live DB inventory AND the real action keys');
  ok(/saga_canvas_open_tab/.test(src) && /echo-delegate/.test(src),
    'canvas and delegation carry their actual tags — a capability with no key gets narrated instead');
  ok(/pkg\.buildPlan\(\{/.test(src), 'the plan/roadmap is built');
  // 2026-07-21: identity is now `_identityWithoutSuit(messages, suit)` rather than the raw join.
  // Everything the local side assembled still rides the UNTRIMMABLE slot with ONE deliberate
  // exception — the Echo tool menu is lifted out and delivered in the budgeted `tools` slot instead.
  //
  // This IS a weakening and it is worth naming: the menu moves from untrimmable to trimmable (weight
  // 0.14, floor 1200, dropped WHOLE below that rather than stubbed). Accepted because it was
  // previously buried at the top of a 34k identity blob and demonstrably not used, and because at
  // 39k/464k the budget is nowhere near starvation. If packages ever approach the window, this is the
  // first thing to re-check.
  ok(/sections: \{ identity: _identityWithoutSuit\(messages, suit\)/.test(src),
    "today's tuned prompt rides the UNTRIMMABLE slot — the packager can only ADD, never silently drop it");
  ok(/function _identityWithoutSuit/.test(src) && /if \(!suit\) return text;/.test(src),
    'and the ONLY thing lifted out is the tool menu, which is re-delivered in its own budgeted slot');
  // Budgeting against a DIFFERENT window than the call gets is silently catastrophic — it was, live.
  ok(/resolveWindow\(db\.getMeta\('model\.replier'\) \|\| null\)/.test(src),
    'the package is budgeted via cloud_logic.resolveWindow — the same model the call will use');
  ok(!/window: await require\('\.\/lib\/cloud_window'\)\.resolve\(\{ model: db\.getMeta/.test(src),
    'REGRESSION: no longer budgets on a possibly-null model.replier (that returned the 8192 floor)');
  const cl = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cloud_logic.js'), 'utf8');
  ok(/async function resolveWindow/.test(cl) && /streamCloud, resolveWindow/.test(cl),
    'resolveWindow is exported and shares streamCloud\'s model resolution');
  ok(/\[package\] \$\{pkg\.describe/.test(src), 'package size is logged per turn — observable, not inferred');
  ok(/cloudMessages = built\.messages/.test(src), 'the built package is what actually gets sent');
}

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
