/* smoke_tag_contract.js — the tag contract is a PROXY for completeness, not the thing itself.
 *
 * TagStreamParser sets truncated=1 whenever a stream ends without a closing </say>. That is sound
 * for the LOCAL model, whose generation really is cut off mid-tag when it runs out of budget. The
 * cloud writer is different: it honours the contract on most turns and simply omits the closing tag
 * on others, having said everything it meant to say.
 *
 * Measured live 2026-07-20: 3 of 18 cloud replies flagged truncated; ZERO were actually cut
 * mid-sentence. Two costs — the per-writer truncation metric (the number this whole arc is judged
 * on) is poisoned, and the cut-off recovery would REGENERATE a complete cloud answer on the local
 * 12b, which is precisely the quality regression the cloud writer exists to remove.
 *
 * Plus the renderer latch that put a real answer in the sheep panel while the chat sat on "…".
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ollama = require('../lib/ollama');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); } }

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const chat = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'chat.js'), 'utf8');

// ── the parser still flags a genuinely cut-off reply ────────────────────────────────────────────
// This is what must NOT be weakened: a real mid-sentence cut still has to be caught.
{
  ok(ollama.sayLooksCutOff('…and I will get that', 1) === true, 'a reply ending mid-clause is still cut off');
  ok(ollama.sayLooksCutOff('Lucas.', 1) === true, 'a too-short reply is still cut off');
  ok(ollama.sayLooksCutOff('There are 64 parishes in Louisiana.', 1) === false,
    'a COMPLETE sentence flagged truncated is not actually cut off — the false-positive shape');
  ok(ollama.sayLooksCutOff('anything', 0) === false, 'not flagged → never cut off');
}

// ── ⭐ a completed cloud stream is not a truncation ──────────────────────────────────────────────
{
  ok(/let cloudComplete = false;/.test(main), 'the turn tracks whether the cloud stream finished');
  ok(/cloudComplete = !r\.partial;/.test(main),
    'completeness comes from streamCloud partial flag — the real signal, not tag closure');
  ok(/if \(cloudComplete && cloudDoneReason !== 'length' && say && say\.trim\(\) && truncated\) \{/.test(main),
    'a complete cloud reply with unclosed tags is cleared — UNLESS done_reason=length (audit S19: a real output-cap truncation keeps its flag)');
  ok(/else if \(cloudDoneReason === 'length' && truncated\)/.test(main),
    '⭐ S19: a length-capped cloud reply is kept truncated, not false-completed');
  const at = main.indexOf("if (cloudComplete && cloudDoneReason !== 'length' && say && say.trim() && truncated)");
  const fin = main.indexOf('let { thought, say, post, truncated } = parser.finalize()');
  const recov = main.indexOf('const _sayCutOff =');
  ok(fin > 0 && at > fin, 'the correction runs AFTER finalize');
  ok(recov > 0 && at < recov,
    'and BEFORE the cut-off recovery — otherwise a complete cloud answer gets regenerated on the local 12b');
}

// ── a STALLED cloud stream must still report truncated ──────────────────────────────────────────
// streamCloud returns partial:true when the watchdog fires mid-generation. That truncation is real
// and must survive, or a genuinely cut-off answer would be silently recorded as clean.
{
  ok(/partial \? ' \(PARTIAL — stream stalled\)' : ''/.test(main), 'a partial stream is logged as such');
  ok(!/cloudComplete = true;/.test(main), 'REGRESSION: completeness is never asserted unconditionally');
}

// ── ⭐ THE RENDERER LATCH ────────────────────────────────────────────────────────────────────────
// `unpromptedActive` is set on an autonomous stream's first token and cleared only by that stream's
// complete. A suppressed heartbeat / silenced monologue leaves it set forever, and every later reply
// is filed in the sheep panel while the chat shows "…". Nothing self-heals it short of a reload.
{
  ok(/if \(promptedReplyPending && !currentAiTurnDiv && unpromptedActive\)/.test(chat),
    'a pending prompted reply CLEARS a stale unprompted latch');
  const clear = chat.indexOf('if (promptedReplyPending && !currentAiTurnDiv && unpromptedActive)');
  const route = chat.indexOf('if (!currentAiTurnDiv && !unpromptedActive) {');
  const buffer = chat.indexOf('if (unpromptedActive) { unpromptedBuffer += token; return; }');
  ok(clear > 0 && route > clear, 'the latch is cleared BEFORE the destination is chosen');
  ok(buffer > 0 && clear < buffer, 'and before the token would be swallowed into the sheep buffer');
  ok(/stale unpromptedActive latch cleared/.test(chat), 'and it is logged, not silently corrected');
}

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
