/* Smoke: THE REPLY LANE IS SINGLE-VOICE (Phase 0 of the document-production plan, failure #7).
 * Live 2026-08-21: a slow async tool-followup was still streaming s:'reply' when the next
 * prompted turn began — the renderer funnels every reply token into ONE live bubble, so the two
 * generations zipped character-by-character into a garbled message. lib/reply_lane.js is the
 * arbiter; this smoke unit-drives every branch of the state machine, then pins the wiring in
 * main.js (chat:send + fireToolFollowup) and the renderer seal.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_reply_lane.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const lane = require('../lib/reply_lane');

// silence the arbiter's own warnings during the unit drive
const _warn = console.warn; console.warn = () => {};

// --- 1. the sequential flow (main say → followup → chain hop) never arbitrates ---
lane._reset();
{
  const sent = [];
  const turn = lane.open('turn');
  const send = turn.feed((t) => sent.push(t));
  ok(send('a') && send('b'), 'turn tokens stream');
  ok(turn.complete() === 'live', "the turn completes 'live'");
  const fu = lane.open('followup');
  const fsend = fu.feed((t) => sent.push(t));
  ok(fsend('c'), 'a followup AFTER the turn streams freely (lane was released)');
  ok(fu.complete() === 'live', "the sequential followup completes 'live'");
  const hop = lane.open('followup');
  ok(hop.feed((t) => sent.push(t))('d') && hop.complete() === 'live', 'a chain hop after release streams freely');
  ok(sent.join('') === 'abcd', 'every sequential token reached the sender in order');
  ok(lane._state().active === null && lane._state().muted.length === 0, 'lane clean after the sequential flow');
}

// --- 2. THE LIVE BUG: a streaming followup loses the lane to the next prompted turn ---
lane._reset();
{
  const fuOut = [], turnOut = [];
  const fu = lane.open('followup');
  const fuSend = fu.feed((t) => fuOut.push(t));
  fuSend('x'); fuSend('y');                       // the slow async followup is mid-stream
  const turn = lane.open('turn');
  const turnSend = turn.feed((t) => turnOut.push(t));
  ok(turnSend('1') === true, "the prompted turn's first token TAKES the lane");
  ok(fuSend('z') === false, 'the dispossessed followup token DROPS — no character zip');
  ok(turnSend('2') === true, 'the turn keeps streaming clean');
  ok(fuOut.join('') === 'xy' && turnOut.join('') === '12', 'each sender saw only its own stream');
  ok(fu.complete() === 'demoted', "the loser's completion is DEMOTED (unprompted door, never the live bubble)");
  ok(turn.complete() === 'live', "the winner's completion closes the bubble normally");
}

// --- 3. sticky mute: a muted stream NEVER resumes, even after the lane frees ---
lane._reset();
{
  const fu = lane.open('followup');
  const fuSend = fu.feed(() => {});
  fuSend('x');
  const turn = lane.open('turn');
  turn.feed(() => {})('1');
  turn.complete();                                 // lane is free again
  ok(fuSend('tail') === false, 'the muted stream cannot replay its tail into a fresh bubble');
  ok(fu.complete() === 'demoted', 'and still demotes at completion');
}

// --- 4. preemptForTurn: a new turn mutes the live async stream BEFORE its first token ---
lane._reset();
{
  const fu = lane.open('followup');
  const fuSend = fu.feed(() => {});
  fuSend('x');
  lane.preemptForTurn();                           // chat:send entry — quiet thinking-dots window
  ok(fuSend('y') === false, 'the stale stream is silent while the new turn thinks');
  ok(fu.complete() === 'demoted', 'and demotes at completion');
  ok(lane._state().active === null, 'the lane is free for the new turn');
  lane.preemptForTurn();                           // idle entry — nothing to mute
  ok(lane._state().muted.length === 0, 'preempting a free lane is a no-op');
}

// --- 5. two concurrent followups: the second is born muted ---
lane._reset();
{
  const a = lane.open('followup'); const aSend = a.feed(() => {});
  const b = lane.open('followup'); const bSend = b.feed(() => {});
  aSend('x');
  ok(bSend('y') === false, 'a second concurrent followup MUTES instead of zipping');
  ok(aSend('z') === true, 'the first keeps the lane');
  ok(b.complete() === 'demoted' && a.complete() === 'live', 'verdicts: first live, second demoted');
}

// --- 6. a double-send: the newer turn takes the lane from the older turn ---
lane._reset();
{
  const t1 = lane.open('turn'); const s1 = t1.feed(() => {});
  s1('a');
  const t2 = lane.open('turn'); const s2 = t2.feed(() => {});
  ok(s2('b') === true, 'the newer turn streams');
  ok(s1('c') === false, 'the older turn is muted');
  ok(t1.complete() === 'demoted' && t2.complete() === 'live', 'newest prompted turn always wins');
}

console.warn = _warn;

// --- 7. the wiring is pinned in the sources ---
const main = read('main.js');
const chat = read('renderer/chat.js');
ok(/_replyLane\.preemptForTurn\(\);/.test(main), 'chat:send preempts the lane at turn entry');
ok(/_replyLane\.open\('turn'\)/.test(main), "chat:send opens a 'turn' claim");
ok(/emit:\s*_laneClaim\.feed\(_rawSend\)/.test(main), "the main stream emits through the turn claim");
ok(/_rawEmit:\s*_rawSend/.test(main), 'the RAW sender rides io for followups to wrap with their own claim');
ok(/_replyLane\.open\('followup'\)/.test(main), "fireToolFollowup opens a 'followup' claim");
ok(/_laneClaim\.feed\(io\._rawEmit \|\| io\.emit\)/.test(main), 'the followup wraps the raw sender, not the turn-claimed one');
ok(/else if \(_laneClose\(\) === 'live'\) \{/.test(main), "the followup delivery is gated on the lane verdict");
ok(/s: 'preempted' \}\); \} catch \{\}\s*\n\s*\}/.test(main) || /unprompted: true, say: sayOut, s: 'preempted'/.test(main),
  'a demoted followup delivers through the unprompted door (s:preempted), never the live bubble');
ok(/try \{ _laneClose\(\); \} catch \{\}/.test(main), 'the outer finally always releases the lane (a throw never wedges it)');
ok(/_laneClose\(\);\s*\n\s*\/\/ ECHO CHAIN/.test(main), 'the lane releases BEFORE chain recursion — a parent never mutes its own child hop');
ok(/sealing a half-streamed bubble/.test(chat) && /currentAiTurnDiv = null;\s*\n\s*currentAiSaidNode = null;\s*\n\s*liveSayBuffer = '';\s*\n\s*promptedReplyPending = true;/.test(chat),
  'the renderer SEALS the previous bubble on send — a new turn always opens fresh');
ok(/s: 'preempted', unprompted: true/.test(main), "a demoted TURN completion is stamped s:'preempted' too");

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
