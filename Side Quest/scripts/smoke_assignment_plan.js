/* smoke_assignment_plan.js — a request for a DELIVERABLE must be worked as one, with tools.
 *
 * Live 2026-07-21. Lucas: "I need a research paper on the last nine months of China announcements in
 * AI… the World AI conference open-sourcing to the global south, their new stacked microchip and the
 * different elements needed to build it, pyrex memory systems, and how each nation of the global
 * south that China wants in their 29-country group provides a needed rare earth material."
 *
 * Five distinct parts, one of them a 29-nation matrix. What happened: two web searches,
 * `deep-browsed 0 layer(s)` of the single excellent source she found, no document, no commitment
 * row — then "I'll compile a research brief once the sources load", which nothing in the system was
 * ever going to make true. Lucas: "that paper never populated anywhere she never used the whole
 * tool base, nothing."
 *
 * TWO causes, and the first was mine:
 *
 * 1. THE TOOL MENU WAS GONE FROM THE PACKAGE. I had gated it on `cloudOwnsAnswer` to avoid printing
 *    it twice. classifyClaimType returns 'other' for a real request, so the flag was false and the
 *    package shipped with no tools section at all:
 *        before: identity:31492 plan:1740 manifest:2378 tools:4181
 *        after:  identity:34260 plan:2082 references:366            ← gone
 *    The cloud writes EVERY reply now, so it needs the tools on EVERY reply.
 *
 * 2. THE PLAN TREATED IT AS A QUESTION. The router already knew — "route=task (assignment, conf
 *    0.8)" — but that signal never reached buildPlan, so a deliverable request was worked like
 *    something answerable in a chat message. A chat message cannot hold a research paper.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const P = require('../lib/package');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); } }

// ── the assignment plan ─────────────────────────────────────────────────────────────────────────
{
  const a = P.buildPlan({ intent: 'other', depth: { maxHops: 4 }, assignment: true });
  const q = P.buildPlan({ intent: 'other', depth: { maxHops: 4 } });

  ok(/THIS IS AN ASSIGNMENT, NOT A QUESTION/.test(a), 'an assignment is named as one');
  ok(/the deliverable is the work and your reply is only the receipt/.test(a),
    'the artifact — not the chat reply — is declared to be the work');
  ok(/BREAK IT DOWN FIRST/.test(a) && /five parts needs five lines of coverage/.test(a),
    'a multi-part request must be decomposed before searching — two searches for five parts is the bug');
  ok(/that set is the shape of the work — say how many there are/.test(a),
    'a set (29 countries) is recognised as a countable universe, not a single lookup');
  ok(/GO DEEP, NOT WIDE/.test(a) && /a link you did not read is not research/.test(a),
    'names the exact failure: deep-browsed 0 layers of the one good source');
  // ⭐ THREE STAGES — Lucas 2026-07-21: "it should create the document with the prompt and the plan
  // affixed and then build the document with a final completion to a fully formatted and branded
  // document (that last part I dont think is wired)". He was right: saga_render_* appears NOWHERE in
  // this codebase and Echo reports zero successful calls to it, ever.
  ok(/BUILD THE DOCUMENT IN THREE STAGES, starting THIS TURN/.test(a), 'the document is built in stages, beginning now');
  ok(/OPEN IT AND WRITE THE CONTRACT/.test(a) && /what they asked for, in their words/.test(a),
    'stage 1 affixes the ask AND the plan — same shape as the research runs\' contract block');
  ok(/correct the plan before you have spent an hour on the wrong thing/.test(a),
    'and the reason it goes first: it is his chance to redirect');
  // ⭐ Live 2026-07-21: she emitted saga_canvas_open_tab and STOPPED. The tab appeared on Lucas's
  // canvas with nothing in it, because "then write the contract" reads as a later step — and there
  // is no later, the turn ends.
  ok(/OPEN IT AND WRITE THE CONTRACT IN THE SAME MESSAGE/.test(a),
    'the tab and its first block go out together — a later step never comes');
  ok(/An opened tab with nothing in it is worse than no tab/.test(a),
    'and an empty tab is named as worse than none: it looks like work that happened');
  // ⭐ The first block that ever reached the durable store read {"markdown":"...plan..."} — perfect
  // structure, placeholder substance. She stopped copying MY placeholders and minted her own.
  ok(/EVERY BLOCK CARRIES ITS REAL CONTENT/.test(a), 'placeholder blocks are forbidden by name');
  ok(/Never write "\.\.\.", "TBD", "plan goes here"/.test(a), 'with the exact junk she wrote quoted');
  ok(/A block you do not yet have the content for is a block you do not write yet/.test(a),
    'and the honest alternative stated: defer the block, never stub it');
  ok(/FILL IT IN as the material arrives/.test(a), 'stage 2 grows the same tab');
  ok(/An empty section with an honest "not researched yet" is information/.test(a),
    'a gap is declared rather than omitted');
  // ⭐ 2026-07-21, Lucas's correction to my design: "she only builds in her standard markdown in
  // order to make it easier and then when the document is completed the user can request that it be
  // packaged". Polishing is OPERATOR-TRIGGERED and applies the editor's house style; letting her
  // format inside the build is how a half-finished document gets dressed up as a finished one.
  ok(/STOP THERE/.test(a) && /Plain markdown is the finished form of YOUR job/.test(a),
    'stage 3 is to STOP — plain markdown is her deliverable');
  ok(/do not reach for a render\/briefing tool/.test(a), 'SAFETY: she does not invoke the packaging tools');
  ok(/Lucas asks for it to be packaged and the house style is applied then/.test(a),
    'packaging is named as HIS command, not hers');
  ok(/Tell them it is ready for packaging; do not package it yourself/.test(a),
    'and she is told what to say instead');
  ok(/Partial and cited beats complete and promised/.test(a), 'partial-and-real beats whole-and-imaginary');

  // SAFETY (updated 2026-07-22): delegation RETURNS now (_drainAgentInbox, 895c2fc) — but async
  // (~5 min), and an assignment is this-turn in-canvas work. The plan still must not hand the
  // deliverable itself to a background agent.
  ok(!/echo-delegate/.test(a),
    'SAFETY: the assignment plan does NOT send the deliverable to <echo-delegate> — returns are async, assignments are this-turn');

  ok(!/THIS IS AN ASSIGNMENT/.test(q), 'an ordinary question gets none of this');
  ok(a.length > q.length, 'the assignment plan is strictly additive');
  // the pre-existing honesty rules must survive alongside it
  for (const rule of ['DO the thing — do not narrate it', 'A TAG YOU EMIT HAS NOT RUN YET', 'THE SUBJECT COMES FROM THE CONVERSATION']) {
    ok(a.includes(rule), `the existing rule survives: "${rule.slice(0, 40)}…"`);
  }
}

// ── the tool menu is in EVERY package ───────────────────────────────────────────────────────────
{
  const m = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  ok(/const suit = \(echoSuit && echoSuit\.connected\) \? echoSuit\.suitContextBlock\(\) : null;/.test(m),
    'REGRESSION: the tool menu is no longer gated on cloudOwnsAnswer');
  ok(!/echoSuit\.connected && cloudOwnsAnswer\) \? echoSuit\.suitContextBlock/.test(m),
    'REGRESSION: the gate that deleted tools from every non-factual turn is gone');
  ok(/identity: _identityWithoutSuit\(messages, suit\)/.test(m),
    'and duplication is solved by lifting it OUT of identity, not by withholding it');
  ok(/assignment: turnRoute && \(turnRoute\.route === 'task' \|\| isAssignment\)/.test(m),
    'the router\'s existing assignment signal now reaches the plan');
  // Rewritten 2026-07-30 (build plan 2.5). The honesty requirement is unchanged — async, ~5 min,
  // NOT material for this turn — but the entry must now also say WHERE the answer lands, because
  // that is the only thing distinguishing it from the dig. When both entries carried the same
  // "never for what Lucas is waiting on" guard, neither was ever picked and <dig> stayed dark.
  ok(/land in YOUR OWN stream within ~5 minutes, not in this conversation/.test(m),
    'the manifest labels the background agent honestly: ASYNC, ~5 min, not this-turn material');
  ok(/fork a dig instead/.test(m),
    'and points at the dig for anything whose answer belongs back in the chat (the discriminator)');
  ok(/THE ONLY TOOL WHOSE ANSWER COMES BACK TO THIS CONVERSATION/.test(m),
    'the dig leads with its homecoming — measured DARK for as long as it led with "ASYNC"');
  ok(!/Never for what Lucas is waiting on THIS turn/.test(m),
    'and the guard that swallowed the dig\'s whole use case is gone');

  // ⭐ THE BLOCK CONTRACT. Live 2026-07-21: given the tools and an assignment plan she DID open a
  // canvas tab — then guessed the block. `block_type:"text"` → "invalid block_type: text", the retry
  // returned ok, and the tab rendered "No content yet." on Lucas's screen while she reported having
  // "added a detailed outline covering all five parts". The manifest documented ONLY the table shape.
  ok(/block_type":"paragraph","data":\{"markdown"/.test(m),
    'the manifest gives the PROSE block shape — a paper is paragraphs, not a table');
  // ⭐ Live 2026-07-21: she copied the placeholders VERBATIM — a canvas tab literally titled "TITLE"
  // with tab_key "KEY" landed in the durable store — then alternated `content`/`data` and dropped
  // `block_type`, burning four hops on validation errors. Placeholders invite substitution errors;
  // a worked example shows the shape and is obviously not meant to be copied.
  ok(!/"tab_key":"KEY"/.test(m) && !/"title":"TITLE"/.test(m),
    'REGRESSION: no KEY/TITLE placeholders — she copies them literally');
  ok(/"tab_key":"china_ai_brief"/.test(m), 'the example uses real values so the SHAPE is what transfers');
  ok(/not literals to copy/.test(m), 'and says outright that it is an example');
  ok(/ALWAYS needs exactly three keys: tab_key, block_type, and data/.test(m),
    'the three required keys are named — the arg shape wobbled across every retry');
  ok(/never "content", never a bare string/.test(m), 'and the two wrong shapes she actually tried are ruled out');
  ok(/block_type":"heading","data":\{"level"/.test(m), 'and the heading shape, so a document can have sections');
  // 2026-08-04 rich-canvas build widened the palette (metric_card, callout, media, diagram…); the
  // manifest lists the full comma-separated set and still rejects anything else.
  ok(/heading, paragraph, list, code, table, chart, metric_card, callout, image, audio, video, diagram, document_file/.test(m),
    'and the exact valid block_type values, so there is nothing left to guess');
  ok(/block_type":"table","data":\{"headers"/.test(m), 'the table shape survives alongside it');

  // Packaging is listed in the manifest to be REFUSED, not offered.
  ok(/NOT YOURS TO DO — write plain markdown and stop/.test(m),
    'the manifest tells her packaging is not hers to invoke');
  ok(/operator-triggered — no tag/.test(m), 'and gives her no tag for it');
  ok(!/saga_render_executive_briefing/.test(m),
    'SAFETY: the render tools are NOT dangled in the manifest — an available polish button gets pressed on an empty document');
}

// ── HER canvas writes are mirrored to the durable store ─────────────────────────────────────────
// Live 2026-07-21: "China AI Announcements Brief (Last 9 months)" appeared on Lucas's canvas and
// `docs` stayed at 42 — the brief existed only in the running renderer and would have vanished on
// the next reboot. Two write paths: the app's own (canvasEmit → saga tool → canvasMirror → durable)
// and hers (<echo-do> → saga tool → nothing). Right action, wrong side of the door — the same class
// as a reply that is correct in the DB and never reaches him.
{
  const m = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  ok(/\^saga_canvas_\(open_tab\|add_block\)\$/.test(m),
    'her canvas tags are recognised at the dispatch site');
  ok(/require\('\.\/lib\/canvas_docs'\)\.recordTab\(\{ tabKey: key/.test(m), 'a tab she opens is written down');
  ok(/require\('\.\/lib\/canvas_docs'\)\.recordBlock\(\{ tabKey: key/.test(m), 'and so is every block she adds');
  ok(/if \(!r \|\| !r\.ok \|\| !t \|\| t\.kind !== 'do'/.test(m),
    'SAFETY: only a SUCCESSFUL write is mirrored — a rejected block must not appear in the durable store');
  // ⭐ Live 2026-07-21: the mirror lived inline in the FIRST dispatch loop only, and a document is
  // written from the FOLLOW-UP hops — "echo chain hop 2: saga_canvas_add_block → ok" while the
  // durable store still held 0 blocks. Shared now, so the two sites cannot drift apart again.
  // Match CALL statements only — `function _mirrorCanvasWrite(t, r) {` also contains the call-shaped
  // substring, so a bare count of 2 was wrong the moment the shared function existed.
  ok((m.match(/^\s*_mirrorCanvasWrite\(t, r\);$/gm) || []).length === 2,
    'BOTH dispatch sites mirror — the initial tag loop AND the follow-up hop chain');
  ok(/function _mirrorCanvasWrite/.test(m), 'via one shared function, not two copies');
  ok(/catch \(e\) \{ console\.error\('\[canvas\] mirror of her write failed:'/.test(m),
    'SAFETY: a mirror failure is logged and never costs her the live block');

  // the store really does round-trip what the mirror puts in (proven against the real module)
  const cd = require('../lib/canvas_docs');
  cd.init({ path: ':memory:' });
  cd.recordTab({ tabKey: 'china-brief', mode: 'DOC', title: 'China AI Announcements Brief' });
  cd.recordBlock({ tabKey: 'china-brief', blockId: 'h1', blockType: 'heading', data: { level: 2, text: 'World AI Conference' } });
  cd.recordBlock({ tabKey: 'china-brief', blockId: 'p1', blockType: 'paragraph', data: { markdown: 'Open-sourcing to the Global South.' } });
  const doc = (cd.all() || []).find((d) => d.tabKey === 'china-brief');
  ok(!!doc && doc.title === 'China AI Announcements Brief', 'the mirrored tab reads back');
  ok(doc.blocks.length === 2 && doc.blocks[0].blockType === 'heading' && doc.blocks[1].data.markdown,
    'with its heading and prose intact — this is what boot replays');
}

// ── the tools section actually survives the budget ──────────────────────────────────────────────
{
  const built = P.build({
    window: { num_ctx: 131072, num_predict: 2048 },
    sections: { identity: 'x'.repeat(34000), plan: P.buildPlan({ assignment: true }), references: 'r', manifest: 'm'.repeat(2400), tools: 'TOOLMENU ' + 't'.repeat(4200) },
  });
  const text = built.messages.map((s) => s.content).join('\n');
  ok(/TOOLMENU/.test(text), 'the tool menu reaches the built package');
  ok(text.indexOf('TOOLMENU') > text.indexOf('THIS IS AN ASSIGNMENT'),
    'and sits AFTER the plan — near the end, where recency helps a model reach for a tool');
  ok(P.ORDER.indexOf('tools') > P.ORDER.indexOf('plan'), 'the section order backs that up');
}

// ── identity de-duplication ─────────────────────────────────────────────────────────────────────
{
  // _identityWithoutSuit is defined in main.js; replicate its contract here against the real source.
  const m = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const fn = m.slice(m.indexOf('function _identityWithoutSuit'), m.indexOf('async function runChatTurn'));
  ok(/const i = text\.indexOf\(suit\);/.test(fn), 'it finds the suit inside the assembled identity');
  ok(/i < 0 \? text :/.test(fn), 'SAFETY: a suit that is not present leaves identity untouched');
  ok(/if \(!suit\) return text;/.test(fn), 'SAFETY: no suit at all → identity untouched');
}

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
