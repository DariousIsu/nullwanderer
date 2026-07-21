/* smoke_thinking_channel.js — a reasoning model's output must not be thrown away.
 *
 * ⭐ THE ROOT CAUSE OF FIVE FAILED RUNS, found 2026-07-21.
 *
 * lib/ollama's STREAMING path forwarded only `message.content`. A reasoning model
 * (gpt-oss:120b-cloud) puts most of its generation in `message.thinking`, and that was dropped on
 * the floor — silently, with no error anywhere.
 *
 * The non-streaming path had known this all along: pickText() falls back to message.thinking "so a
 * reasoner never returns empty", and the response object carries `thinking` as "a safety net for
 * callers". Only the streaming path was blind.
 *
 * Measured on the last run: 633 tokens generated, the stored thought + reply totalling 716 chars
 * (~180 tokens). The missing ~450 tokens were her TOOL TAGS. Every symptom of the day traces here —
 * four runs of "she planned it and never acted", a tag severed mid-attribute (the fragment that
 * happened to land in `content`), and a 209-token "stop" that was never a stop.
 *
 * ⚠️ THE LOAD-BEARING TEST IS THAT REASONING DOES NOT BECOME SPEECH. The parser salvages untagged
 * leading text as PROSE, so forwarding `thinking` raw would publish her private reasoning to Lucas —
 * the exact failure ("We need to emit a web search.") fixed earlier the same day. It is wrapped in
 * <think> so it lands in her interior instead.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { TagStreamParser } = require('../lib/ollama');
const es = require('../lib/echo_suit');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); } }

// Replays the exact chunk shape ollama streams, through the same logic as lib/ollama.
function replay(chunks) {
  let out = '';
  let inThinking = false;
  const emit = (t) => { out += t; };
  for (const obj of chunks) {
    const th = obj.message && obj.message.thinking;
    const ct = obj.message && obj.message.content;
    if (th) { if (!inThinking) { inThinking = true; emit('<think>'); } emit(th); }
    else if (inThinking) { inThinking = false; emit('</think>'); }
    if (ct) emit(ct);
    if (obj.done && inThinking) { inThinking = false; emit('</think>'); }
  }
  const p = new TagStreamParser({});
  p.feed(out);
  return { raw: out, say: p.say, mode: p.mode, tags: es.parseEchoTags(out) };
}

// ── ⭐ the tags come back ───────────────────────────────────────────────────────────────────────
{
  const r = replay([
    { message: { thinking: 'Plan: open the doc, add the contract. ' } },
    { message: { thinking: '<echo-do name="saga_canvas_open_tab">{"tab_key":"k","title":"T"}</echo-do>' } },
    { message: { thinking: '<echo-do name="saga_canvas_add_block">{"tab_key":"k","block_type":"paragraph","data":{"markdown":"Contract."}}</echo-do>' } },
    { message: { content: '<say>Opening the doc now.</say>' } },
    { done: true },
  ]);
  ok(r.tags.length === 2, 'BOTH tags emitted in the thinking channel are recovered');
  ok(r.tags.map((t) => t.name).join(',') === 'saga_canvas_open_tab,saga_canvas_add_block', 'in order, with their names');
  ok(r.tags[1].args.data.markdown === 'Contract.', 'and their arguments intact');
}

// ── ⭐ SAFETY: reasoning must never become speech ───────────────────────────────────────────────
{
  const r = replay([
    { message: { thinking: 'We need to emit a web search. The user probably wants Q3.' } },
    { message: { content: '<say>Pulling that now.</say>' } },
    { done: true },
  ]);
  ok(r.say.trim() === 'Pulling that now.', 'SAFETY: only the <say> content is spoken');
  ok(!/We need to emit/.test(r.say), 'SAFETY: the reasoning does NOT leak into the reply');
  ok(/<think>/.test(r.raw) && /<\/think>/.test(r.raw), 'it is wrapped so the parser files it as interior');
  ok(r.mode === 'post', 'and the turn is not falsely flagged truncated');
}

// ── ordering: the interior closes before any spoken token ───────────────────────────────────────
{
  const r = replay([
    { message: { thinking: 'thinking...' } },
    { message: { content: '<say>Hello.</say>' } },
    { done: true },
  ]);
  ok(r.raw.indexOf('</think>') < r.raw.indexOf('<say>'),
    'SAFETY: </think> closes BEFORE content — else the first spoken token vanishes into the interior');
  ok(r.say.trim() === 'Hello.', 'so the whole reply survives');
}

// ── a generation that ends mid-thought closes its own tag ───────────────────────────────────────
{
  const r = replay([{ message: { thinking: 'half a thought' } }, { done: true }]);
  ok(/<\/think>/.test(r.raw), 'SAFETY: an interior left open at `done` is closed, or the parser never leaves think mode');
  ok(r.say.trim() === '', 'a generation that only reasoned says nothing — correctly');
}

// ── content-only models are untouched ───────────────────────────────────────────────────────────
{
  const r = replay([
    { message: { content: '<think>t</think><say>Plain reply.</say>' } },
    { done: true },
  ]);
  ok(r.say.trim() === 'Plain reply.', 'a non-reasoning model behaves exactly as before');
  ok(!/<think><think>/.test(r.raw), 'and no spurious wrapper is added');
}

// ── the wiring ──────────────────────────────────────────────────────────────────────────────────
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ollama.js'), 'utf8');
  ok(/const _think = obj\.message && obj\.message\.thinking;/.test(src), 'the streaming path reads thinking');
  ok(/if \(!_inThinking\) \{ _inThinking = true; onToken\('<think>'\); \}/.test(src), 'and opens an interior for it');
  ok(/if \(obj\.done && _inThinking\)/.test(src), 'and closes it at done');
  ok(/if \(_content\) onToken\(_content\);/.test(src), 'content is emitted AFTER the interior closes');
}

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
