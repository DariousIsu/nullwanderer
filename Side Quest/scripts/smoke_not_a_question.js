/* smoke_not_a_question.js — a message that asks nothing must not be answered as a records miss,
 * and the cloud must write EVERY reply, not only the factual ones.
 *
 * Live 2026-07-21, the first real turn after a reboot:
 *
 *   Lucas: "I am drinking some coffee getting ready for all our meetings today. We have the Rainey
 *           weekly all hands at 1045 … then the Electrify America meeting rescheduled to 1630"
 *   Zoe:   "I checked our records and searched, but I couldn't pin down the user's question or request."
 *
 * Her own interior names the mechanism exactly: "Lucas just gave a rundown of his schedule, but didn't
 * ask a specific question. The required response is the fixed statement acknowledging lack of a clear
 * request." So _draftOrNeed emitted `NEED: the user's question or request`, the ladder ran five
 * retrieval tiers against the ABSENCE of a question, and the honest-miss line closed the turn — in the
 * third person, about a question nobody asked.
 *
 * A NEED names a SUBJECT to look up. It can never name the asking itself.
 *
 * The second half guards the routing flip: `cloudOwnsAnswer` gated BOTH the retrieval ladder and the
 * reply writer, so 96% of replies came from the local 12b. The writer is now unconditional
 * (`cloudWritesReply`) while the ladder stays gated — running five tiers on "good morning" is what
 * produced the failure above.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const cog = require('../lib/cognition');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); } }

(async () => {
  // ── a NEED that names the asking → nothing to look up ────────────────────────────────────────
  const DEGENERATE = [
    'the user\'s question or request',      // the live one, verbatim
    'NONE', 'none', 'nothing', 'n/a',
    'the question', 'a clear question', 'the specific request', 'his request',
    'the underlying intent', 'clarification', 'the actual topic',
    'what he is asking', 'what Lucas wants', 'what the user means',
  ];
  for (const need of DEGENERATE) {
    const step = await cog._draftOrNeed('I am getting ready for our meetings today.', '', {
      ask: async () => `NEED: ${need}`,
    });
    ok(step === null, `degenerate need ${JSON.stringify(need)} → null (hand the turn back, do not search)`);
  }

  // ── a REAL need still flows through — the guard must not swallow lookups ──────────────────────
  const REAL = [
    'the current EPA Administrator',
    'the question on the Louisiana ballot',   // contains "question" but names a subject
    'the Rainey Group\'s publication schedule',
    'Electrify America\'s 2026 charger deployment',
    'the topic of Senate Bill 44',            // contains "topic" but names a subject
  ];
  for (const need of REAL) {
    const step = await cog._draftOrNeed('who runs the EPA?', '', { ask: async () => `NEED: ${need}` });
    ok(step && step.need === need, `real need ${JSON.stringify(need)} survives the guard`);
  }

  // ── an ANSWER is never touched ───────────────────────────────────────────────────────────────
  {
    const step = await cog._draftOrNeed('anything', '', { ask: async () => 'The meeting is at 10:45.' });
    ok(step && step.answer === 'The meeting is at 10:45.', 'a drafted answer passes through unchanged');
  }

  // ── the prompt itself tells the model not to invent a question ───────────────────────────────
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cognition.js'), 'utf8');
    ok(/not a question at all/.test(src), 'the draft prompt names the non-question case');
    ok(/NEED: NONE/.test(src), 'and gives it an explicit output');
    ok(/DEGENERATE_NEED_RE/.test(src), 'the code-side guard exists — the prompt rule is not trusted alone');
  }

  // ── the routing flip: writer unconditional, ladder still gated ───────────────────────────────
  {
    const m = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    ok(/const cloudWritesReply = process\.env\.ZOE_CLOUD_WRITES_REPLY !== '0';/.test(m),
      'the writer gate is its own flag, defaulting ON');
    // 2.5.4: the sole added condition is the direct-deliver self-review skip (a verbatim review must
    // not be re-voiced) — the FACTUAL-ONLY conjunction stays dead.
    ok(/[^\n]*if \(cloudWritesReply && !operatorReviewDirect\) \{/.test(m),
      'the cloud reply block is gated on the writer flag (+ the 2.5.4 review skip) — never factual-only');
    ok(!/if \(cloudOwnsAnswer && process\.env\.ZOE_CLOUD_WRITES_REPLY/.test(m),
      'REGRESSION: the old conjunction (factual-only writing) is gone');
    // the ladder must STAY gated — this is the half that costs five retrieval tiers
    ok(/if \(cloudOwnsAnswer \|\| personalFactQ(?: \|\| scheduleQ)?\) \{/.test(m),
      'the grounding ladder is still gated on cloudOwnsAnswer, not on the writer');
    ok(/mustCite: cloudOwnsAnswer/.test(m),
      'citation duty still tracks the FACTUAL turn, not the writer');
    // 2026-07-21 — REVERSED, and this assertion was pinning my own regression. Gating the menu on
    // cloudOwnsAnswer meant a real request ("I need a research paper on…", classified 'other') got a
    // package with NO tools section at all, which is why she never used the tool base. The menu now
    // ships on every turn; duplication is handled by lifting it out of identity instead.
    ok(/const suit = \(echoSuit && echoSuit\.connected\) \? echoSuit\.suitContextBlock\(\) : null;/.test(m),
      'the tool menu is in EVERY package — the cloud writes every reply, so it needs tools every time');
  }

  console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
