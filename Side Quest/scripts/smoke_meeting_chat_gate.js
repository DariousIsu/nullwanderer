/* smoke_meeting_chat_gate.js — she does not talk to Lucas's colleagues until he has read what she
 * would have said.
 *
 * Lucas, 2026-07-21: "get her firing correctly to me, either through the canvas or chat. I want to
 * make sure she is pulling the right things and making the right actions BEFORE she starts trying to
 * send stuff in chat."
 *
 * The audit found the wiring backwards. TWO paths could post into a room of his colleagues — a
 * model-chosen CONTRIBUTE and an auto-reply when someone says her name — and the only restraint on
 * either was a sentence in a prompt ("staying QUIET is strongly preferred"), judged by the local 12b
 * at num_ctx 8192. Everything she LEARNED, meanwhile, went to onReading — the ambient sheep panel,
 * the same rail that swallowed a real answer on 2026-07-20.
 *
 * Outward actions ungated; inward reporting invisible. This pins the inversion of that.
 *
 * The load-bearing tests are the ones asserting postChat is NEVER called while the gate is closed,
 * and that a withheld draft still reaches Lucas — silently dropping her contribution would be a
 * different failure, not a fix.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const G = require('../lib/gmeet');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); } }

// ── the gate itself ─────────────────────────────────────────────────────────────────────────────
{
  const prev = process.env.ZOE_MEET_CHAT;
  delete process.env.ZOE_MEET_CHAT;
  ok(G.meetChatOpen() === false, 'SAFETY: the meeting chat is CLOSED by default — an unset env must never open it');
  process.env.ZOE_MEET_CHAT = 'on';
  ok(G.meetChatOpen() === true, 'ZOE_MEET_CHAT=on opens it');
  process.env.ZOE_MEET_CHAT = 'ON';
  ok(G.meetChatOpen() === true, 'case-insensitive');
  for (const v of ['off', '', '0', 'true', 'yes', 'maybe']) {
    process.env.ZOE_MEET_CHAT = v;
    ok(G.meetChatOpen() === false, `SAFETY: "${v}" does NOT open the chat — only the exact word "on" does`);
  }
  if (prev === undefined) delete process.env.ZOE_MEET_CHAT; else process.env.ZOE_MEET_CHAT = prev;

  // the intro is disclosure, not contribution — it stays on unless explicitly disabled
  const p2 = process.env.ZOE_MEET_INTRO;
  delete process.env.ZOE_MEET_INTRO;
  ok(G.meetIntroOn() === true, 'the intro is ON by default — an undisclosed AI in the room is the worse failure');
  process.env.ZOE_MEET_INTRO = '0';
  ok(G.meetIntroOn() === false, 'and can be explicitly disabled');
  if (p2 === undefined) delete process.env.ZOE_MEET_INTRO; else process.env.ZOE_MEET_INTRO = p2;
}

// ── the ledger renders for review ───────────────────────────────────────────────────────────────
{
  const at = Date.parse('2026-07-21T14:45:00Z');
  const rows = [
    { at, kind: 'research', withheld: false, topic: 'Tennessee Chamber of Commerce promoting reform initiatives', ran: true },
    { at, kind: 'research', withheld: false, topic: 'already known thing', ran: false },
    { at, kind: 'connect', withheld: false, note: 'this ties to the permitting bill Russ mentioned' },
    { at, kind: 'contribute', withheld: true, understanding: 'they are debating charger siting', draft: 'Electrify America filed on this in March.' },
    { at, kind: 'reply', withheld: true, trigger: 'Sarah Hunt: Zoe, do you have the number?', draft: 'It was 412 sites.' },
  ];
  const md = G.renderLedger(rows);
  ok(/Held back from the meeting chat \(2\)/.test(md), 'withheld actions are counted and headlined');
  ok(md.indexOf('Held back') < md.indexOf('What she did'),
    'SAFETY: withheld leads — an action she wanted to take in the room is what most needs reviewing');
  ok(/would have replied: "It was 412 sites\."/.test(md), 'the withheld REPLY carries its draft');
  ok(/Sarah Hunt/.test(md), 'and who asked, so he can judge whether the moment was right');
  ok(/would have said: "Electrify America filed on this in March\./.test(md.replace(/\*\*/g, '')),
    'the withheld CONTRIBUTION carries its draft');
  ok(/context she read: they are debating charger siting/.test(md), 'with the understanding that produced it');
  // "is she pulling the right things" is unanswerable from a truncated topic — the audit hit exactly this
  ok(/Tennessee Chamber of Commerce promoting reform initiatives/.test(md),
    'research topics render IN FULL — the 40-char console truncation made a good topic look like a parse bug');
  ok(/skipped: rate-limited or already known/.test(md), 'a governed no-op is still recorded as a decision');
  ok(G.renderLedger([]) === '' && G.renderLedger() === '', 'an empty ledger renders nothing at all');
}

// ── the wiring survives ─────────────────────────────────────────────────────────────────────────
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'gmeet.js'), 'utf8');
  // BOTH outward paths must consult the gate. The auto-reply is the likelier of the two to fire.
  const posts = src.split('\n').filter((l) => /await d\.postChat\(/.test(l));
  ok(posts.length === 3, `three postChat sites (intro + reply + contribute), found ${posts.length}`);
  ok(/if \(!meetChatOpen\(\)\) \{[^]*?ledgerAdd\(\{ kind: 'reply', withheld: true/.test(src),
    'SAFETY: the addressed-by-name reply is gated');
  ok(/if \(!meetChatOpen\(\)\) \{[^]*?ledgerAdd\(\{ kind: 'contribute', withheld: true/.test(src),
    'SAFETY: the model-chosen contribution is gated');
  // withheld drafts go to onSurface (a real notification), NOT onReading (the ambient sheep rail)
  const withheldBlocks = src.split('withheld: true').slice(1, 3).join('');
  ok(/ctx\.onSurface/.test(withheldBlocks),
    'SAFETY: a withheld draft reaches Lucas through onSurface — the rail he actually watches');
  ok(/gmeet_ledger', '\[\]'/.test(src), 'the ledger resets per meeting — last week\'s drafts are not this call\'s');

  const m = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  ok(/renderLedger\(require\('\.\/lib\/gmeet'\)\.ledgerRows\(\)\)/.test(m), 'finalize renders the ledger');
  ok(/## What I did in this meeting/.test(m), 'and it lands in the meeting notes on canvas');
}

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
