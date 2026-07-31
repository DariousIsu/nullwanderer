/* smoke_thinking_channel.js — the reasoning channel is captured RAW, and never enters the tag stream.
 *
 * TWO live failures, one day apart, define this contract:
 *
 * 1. DROPPED (2026-07-21 day): ollama's streaming path forwarded only `message.content`. A reasoning
 *    model (gpt-oss:120b-cloud) authors most of its generation — INCLUDING HER TOOL TAGS — in
 *    `message.thinking`. 633 tokens generated, ~180 stored; five runs of "she planned it and never
 *    acted".
 *
 * 2. INJECTED (2026-07-21 night — the fix that broke chat COMPLETELY): thinking was wrapped in
 *    <think> and fed through onToken into the TagStreamParser. But a reasoning model NARRATES its own
 *    format — "We need to respond with <think> and <say>… the strict format: <think> ... </think>
 *    <say> ... </say>" — and the parser read those MENTIONS as real tags. Every social reply became
 *    the literal three-character "..." lifted from the format recitation (#9235/#9239/#9242/#9245/
 *    #9256), while the real reply in `content` was orphaned. Lucas: "chat broke completely last
 *    night."
 *
 * THE CONTRACT: content → onToken → parser (the tag contract lives there). thinking → onThinking,
 * RAW, accumulated by the caller — recorded as her interior, scanned for tool tags with
 * parseEchoTags (which needs a complete <echo-*>…</echo-*> pair, so narration can't dispatch), and
 * NEVER spoken. A payload that can contain tag-shaped text must never enter the tag stream.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { TagStreamParser } = require('../lib/ollama');
const es = require('../lib/echo_suit');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); } }

// Replay the stream exactly as lib/ollama now routes it: content → parser, thinking → its own sink.
function replay(chunks) {
  const p = new TagStreamParser({});
  let thinking = '';
  for (const obj of chunks) {
    if (obj.message && obj.message.content) p.feed(obj.message.content);
    if (obj.message && obj.message.thinking) thinking += obj.message.thinking;
  }
  return { say: p.say, think: p.thought, mode: p.mode, thinking, thinkingTags: es.parseEchoTags(thinking) };
}

// ── ⭐ THE LIVE HIJACK, replayed — format narration must not become the reply ────────────────────
{
  const r = replay([
    { message: { thinking: 'We need to produce a response following the strict format: <think> reasoning </think><say> ... </say>. ' } },
    { message: { thinking: 'He is tired; keep it warm and short.' } },
    { message: { content: '<think>He needs warmth, not a status report.</think><say>Long days earn quiet evenings. I\'m here.</say>' } },
    { done: true },
  ]);
  ok(r.say.trim() === "Long days earn quiet evenings. I'm here.",
    'SAFETY: the reply is the CONTENT channel\'s <say> — never hijacked by format narration in thinking');
  ok(r.say.trim() !== '...', 'REGRESSION: the reply is not the literal "..." from the format recitation (the night-of-07-21 bug)');
  ok(/He needs warmth/.test(r.think), 'the contract-side interior still parses from content');
  ok(/strict format/.test(r.thinking), 'the reasoning is captured raw for the record');
  ok(r.mode === 'post', 'and the turn is not flagged truncated');
}

// ── ⭐ tags authored in the reasoning channel are recoverable ────────────────────────────────────
{
  const r = replay([
    { message: { thinking: 'Open the doc first. <echo-do name="saga_canvas_open_tab">{"mode":"DOC","tab_key":"k","title":"T"}</echo-do>' } },
    { message: { thinking: '<echo-do name="saga_canvas_add_block">{"tab_key":"k","block_type":"paragraph","data":{"markdown":"Contract."}}</echo-do>' } },
    { message: { content: '<say>Opening the doc now.</say>' } },
    { done: true },
  ]);
  ok(r.thinkingTags.length === 2, 'BOTH tool tags authored in thinking are recovered by the scan');
  ok(r.thinkingTags[1].args.data.markdown === 'Contract.', 'with their arguments intact');
  ok(r.say.trim() === 'Opening the doc now.', 'while the spoken reply stays clean');
}

// ── SAFETY: narration alone can never dispatch ──────────────────────────────────────────────────
{
  const r = replay([
    { message: { thinking: 'Maybe I should use <echo-find> here, or emit an <echo-do name="db_query"> for the counts.' } },
    { message: { content: '<say>Checking.</say>' } },
    { done: true },
  ]);
  ok(r.thinkingTags.length === 0,
    'SAFETY: MENTIONING a tag without a closing pair produces no dispatch — narration is not action');
}

// ── content-only models are byte-identical to the old behavior ──────────────────────────────────
{
  const r = replay([
    { message: { content: '<think>t</think><say>Plain reply.</say>' } },
    { done: true },
  ]);
  ok(r.say.trim() === 'Plain reply.' && r.thinking === '', 'a non-reasoning model is untouched');
}

// ── the wiring ──────────────────────────────────────────────────────────────────────────────────
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ollama.js'), 'utf8');
  ok(/onThinking && obj\.message && obj\.message\.thinking/.test(src), 'the stream forwards thinking to its OWN callback');
  ok(/onThinking\(obj\.message\.thinking\)/.test(src), 'raw, unwrapped');
  ok(!/onToken\('<think>'\)/.test(src) && !/onToken\('<\/think>'\)/.test(src),
    'REGRESSION: the <think>-wrapper injection is GONE — it let format narration hijack <say>');
  ok(/onThinking,/.test(src.slice(0, src.indexOf('const reader'))), 'streamChat accepts the callback');

  const cl = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cloud_logic.js'), 'utf8');
  ok(/onThinking: \(t\) => \{ thinking \+= t;/.test(cl), 'streamCloud accumulates the channel');
  ok(/return \{ text, thinking, model/.test(cl), 'and returns it — including on the partial path');
  ok(/return text \? \{ text, thinking, model/.test(cl), 'a partial still carries its reasoning');

  const m = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  ok(/cloudThinking = r\.thinking \|\| '';/.test(m), 'the reply turn captures the channel');
  ok(/replyWriter !== MODEL \? echoSuitLib\.parseEchoTags\(cloudThinking \|\| '', \{ deliberative: true \}\) : \[\]/.test(m),
    'and scans it for tool tags — only when the cloud actually wrote the turn');
  ok(/followupThinking = r\.thinking \|\| '';/.test(m), 'the hop chain captures it too');
  ok(/parseEchoTags\(followupThinking \|\| '', \{ deliberative: true \}\)/.test(m),
    'and scans it — the hop chain is where a document\'s next block is authored');
  // ⭐ BOTH reasoning-channel scans must pass `deliberative` (live 2026-07-31). The channel is
  // deliberation by construction, and without the bar "we will do <echo-find>…" became a live call:
  // twelve failing db_query hops, then she reported her own musing to Lucas as HIS malformed call.
  // Pinned as a PAIR so a future edit cannot quietly drop the bar from one of the two sites.
  ok((m.match(/parseEchoTags\((?:cloudThinking|followupThinking) \|\| '', \{ deliberative: true \}\)/g) || []).length === 2,
    '⭐ BOTH reasoning-channel scans hold tags to the committed bar');
  ok(!/parseEchoTags\((?:cloudThinking|followupThinking) \|\| ''\)/.test(m),
    '…and neither one scans the reasoning channel unguarded');
  ok(/const _fullThought = \[thought \|\| '', \(replyWriter !== MODEL && cloudThinking\)/.test(m),
    'the reasoning is folded into her stored interior, through the same tag-strip chain');
}

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
