/**
 * TagStreamParser leak regression test (lib/ollama.js).
 * Reproduces the CrushOn-session "thought leak": the model emitted <thoughts>
 * blocks (not <think>) interleaved with <file-append> and NO <say>, and the old
 * parser dumped the whole interior into the visible reply. Asserts the new parser
 * captures interior, fires NO say tokens for that case, and still handles the
 * normal / plain-reply / prose-without-say shapes. No Ollama, no DB.
 *
 * Run: $env:ELECTRON_RUN_AS_NODE=1; .\node_modules\.bin\electron.cmd scripts\smoke_tag_parser.js
 */
const { TagStreamParser } = require('../lib/ollama');

let pass = 0, fail = 0;
const ok = (n, c, detail) => { if (c) { pass++; console.log(`  ✓ ${n}${detail ? ' — ' + detail : ''}`); } else { fail++; console.log(`  ✗ ${n}${detail ? ' — ' + detail : ''}`); } };

// Run a full string through the parser in small chunks, capturing every token
// that reaches the visible channel (onSayToken). Returns { said, streamed, thought }.
function run(full, chunkSize = 7) {
  let streamed = '';
  const p = new TagStreamParser({ onSayToken: (t) => { streamed += t; } });
  for (let i = 0; i < full.length; i += chunkSize) p.feed(full.slice(i, i + chunkSize));
  const { thought, say, post, truncated } = p.finalize();
  return { said: say, streamed, thought, post, truncated };
}

console.log('Normal <think>/<say>:');
{
  const r = run('<think>weighing it</think>\n<say>Here is my answer.</say>');
  ok('thought captured', r.thought === 'weighing it');
  ok('say captured', r.said === 'Here is my answer.');
  ok('streamed == say', r.streamed.trim() === 'Here is my answer.');
}

console.log('\nTHE LEAK CASE — <thoughts> blocks + <file-append>, no <say>:');
{
  const leak =
    '<thoughts>I\'m glad you\'re building additional tools.</thoughts>\n' +
    '<file-append path="notes/personal_life.md">I am wrapping my head around having a personal life.</file-append>\n' +
    '<thoughts>I also want to make sure I\'m not overanalyzing.</thoughts>\n' +
    '<file-append path="notes/personal_life.md">A less structured approach.</file-append>\n' +
    '<thoughts>Additionally, I\'m curious about the new tools.</thoughts>';
  const r = run(leak);
  ok('NO interior text leaked to say', !/glad you're building|overanalyzing|curious about the new/i.test(r.said), JSON.stringify(r.said).slice(0, 60));
  ok('NO file-append leaked to say', !/file-append|personal_life\.md/i.test(r.said));
  ok('NOTHING streamed to the visible channel', r.streamed.trim() === '', JSON.stringify(r.streamed).slice(0, 40));
  ok('interior WAS captured as thought', /glad you're building/i.test(r.thought));
  ok('all three interior blocks captured', /glad you're building/i.test(r.thought) && /overanalyzing/i.test(r.thought) && /curious about the new/i.test(r.thought));
}

console.log('\n<thinking> singular variant, with a real <say>:');
{
  const r = run('<thinking>quick take</thinking><say>Got it.</say>');
  ok('thinking captured as interior', r.thought === 'quick take');
  ok('say intact', r.said === 'Got it.');
}

console.log('\n<think>…</think> then prose reply WITHOUT <say> tags (legit shape):');
{
  const r = run('<think>private</think>\nThat sounds good to me.');
  ok('prose survives as say', /that sounds good to me\./i.test(r.said));
  ok('private thought not in say', !/private/i.test(r.said));
}

console.log('\nPlain reply, no tags at all:');
{
  const r = run('Just a normal answer.');
  ok('emitted as say', r.said === 'Just a normal answer.');
}

console.log('\nTHE "<think" LEAK — generation truncated mid-open-tag (front 12B cut off at the marker):');
{
  const r = run('<think');   // the exact shape stored in ai_said #5535/#5537
  ok('truncated "<think" does NOT reach say', r.said === '', JSON.stringify(r.said));
  ok('nothing streamed to visible channel', r.streamed.trim() === '');
}
{
  const r = run('<think>reasoning cut off here and then it stops');  // open seen, never closed
  ok('unclosed <think> body stays in thought, not say', r.said === '' && /reasoning cut off/i.test(r.thought));
}
{
  const r = run('Here is my point.<think');   // real say then a truncated marker
  ok('trailing "<think" scrubbed, real prose kept', /here is my point\./i.test(r.said) && !/think/i.test(r.said));
}

console.log('\nsayLooksCutOff — the CUT-OFF reply detector (regenerate a truncated non-empty say):');
{
  const cut = require('../lib/ollama').sayLooksCutOff;
  // the live failures
  ok('"Lucas." (short, truncated) → cut off', cut('Lucas.', 1) === true);
  ok('"…will get that" (unterminated, truncated) → cut off', cut('I\'m diving in now and will get that', 1) === true);
  ok('"On it" (very short, truncated) → cut off', cut('On it', 1) === true);
  ok('mid-clause truncation → cut off', cut('First I will gather the rosters, then', 1) === true);
  // must NOT regenerate these
  ok('complete sentence that merely lost its </say> → NOT cut off',
    cut('I am on it now, pulling the full roster together for you.', 1) === false);
  ok('a complete reply (truncated=0) → never cut off',
    cut('Lucas.', 0) === false);
  ok('empty say → not "cut off" (empty-recovery handles it)', cut('', 1) === false);
  ok('question ending, long, truncated → complete enough', cut('So which of the two chambers do you want me to start with?', 1) === false);
  ok('ends with quote+period → complete', cut('He told me plainly, "we have all sixty-four."', 1) === false);
  ok('null/undefined → false', cut(null, 1) === false && cut(undefined, 1) === false);
}

console.log('\nTHE POST CHANNEL (2026-08-15 deep-dive F1 — the documented tag position must survive):');
{
  // tags AFTER </say> — exactly where the reply package says to put them — ride the post channel
  const r = run('<think>t</think><say>Putting this on your canvas now.</say>\n<echo-do name="saga_canvas_add_block">{"tab_key":"k"}</echo-do>');
  ok('say stays clean', r.said === 'Putting this on your canvas now.');
  ok('the post-say tag is CAPTURED, not discarded', /<echo-do name="saga_canvas_add_block">/.test(r.post));
  ok('ending in tags is NOT truncation', r.truncated === 0);
}
{
  // a tag BETWEEN </think> and <say> (the other silent-discard zone) also survives
  const r = run('<think>plan</think>\n<recall>the Monroe files</recall>\n<say>One moment.</say>');
  ok('between-section tag rides post', /<recall>the Monroe files<\/recall>/.test(r.post));
  ok('say unaffected by the between capture', r.said === 'One moment.');
}
{
  // no <say> at all: the salvage still strips tags from the VISIBLE say, but the raw
  // buffer rides post — strip-AND-RUN, never strip-and-silently-drop
  const r = run('<think>x</think>\n<echo-do name="save_document">{"t":1}</echo-do>');
  ok('no-say salvage keeps the say tag-free', !/echo-do/.test(r.said));
  ok('but the tag is still executable from post', /<echo-do name="save_document">/.test(r.post));
}
{
  // plain conforming replies carry an EMPTY post — no phantom scans
  const r = run('<think>weighing</think><say>Done.</say>');
  ok('a clean reply has an empty post channel', r.post === '');
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
