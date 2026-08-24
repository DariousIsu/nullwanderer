'use strict';
/* smoke_rolling_context.js — THE ROLLING CONVERSATION WINDOW (lib/rolling_context, Lucas 08-23).
 * Cloud-lane-only running transcript: verbatim tail + 75%-triggered background compacts that LAND
 * the verbatim slice as a store doc BEFORE summarizing (the doc is the truth, the summary a
 * pointer with a [dN] recall handle). Hermetic: every dep injected. */
const fs = require('fs'), path = require('path');
const rc = require('../lib/rolling_context');

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`); } };

function makeDeps({ turns = [], completeText = 'They worked the Louisiana teacher-bonus report; he corrected the scope to parish-confirmed figures only.', failLand = false, failComplete = false } = {}) {
  const meta = new Map(), docs = [];
  return {
    meta, docs, turns,
    getMeta: (k) => meta.get(k) || null,
    setMeta: (k, v) => meta.set(k, v),
    getTurnsSince: (sid, afterId) => turns.filter((t) => t.session_id === sid && t.id > afterId),
    landDoc: ({ title, body, source, ref }) => { if (failLand) return { id: null }; docs.push({ id: 100 + docs.length, title, body, source, ref }); return { id: docs[docs.length - 1].id, landed: true }; },
    complete: async () => { if (failComplete) throw new Error('cloud down'); return completeText; },
    now: () => 1000,
  };
}
const turn = (id, sid, speaker, content) => ({ id, session_id: sid, speaker, content });

(async () => {
  // ── toggle + plain assembly ───────────────────────────────────────────────────────────────────
  {
    const d = makeDeps({ turns: [turn(1, 5, 'user', 'hey'), turn(2, 5, 'ai_thought', 'private'), turn(3, 5, 'ai_said', 'hi Lucas'), turn(4, 5, 'user', 'newest raw')] });
    ok(rc.enabled(d) === false, 'the toggle defaults OFF');
    d.setMeta('context.rolling', '1');
    ok(rc.enabled(d) === true, 'meta context.rolling=1 turns it on');
    const a = rc.assemble(d, 5, { excludeId: 4 });
    ok(a.messages.length === 2 && a.messages[0].role === 'user' && a.messages[1].role === 'assistant', 'assembly: user/ai_said ride as role turns; ai_thought stays private');
    ok(!a.messages.some((m) => /newest raw/.test(m.content)), 'the just-inserted raw user turn is excluded (the caller appends its COMPOSED form)');
    ok(rc.assemble(d, 6).messages.length === 0, 'per-session isolation: another session starts empty');
  }

  // ── under threshold → no compact ──────────────────────────────────────────────────────────────
  {
    const d = makeDeps({ turns: [turn(1, 5, 'user', 'short'), turn(2, 5, 'ai_said', 'also short')] });
    const r = await rc.maybeCompact(d, 5);
    ok(r.compacted === false && /under threshold/.test(r.reason), 'a small window never compacts');
  }

  // ── over threshold → land-then-summarize, horizon advances, tail survives ─────────────────────
  {
    const big = 'x'.repeat(9000);
    const turns = []; for (let i = 1; i <= 12; i++) turns.push(turn(i, 5, i % 2 ? 'user' : 'ai_said', `turn ${i} ${big}`));
    const d = makeDeps({ turns });
    const r = await rc.maybeCompact(d, 5, { budget: 100000 });   // 12×~9k ≈ 108k > 75k threshold
    ok(r.compacted === true && r.docId === 100 && r.fromId === 1, '⭐ the 75% trigger compacts the OLDEST half');
    ok(r.toId < 12, 'a live verbatim tail ALWAYS survives the compact');
    const doc = d.docs[0];
    ok(/^Conversation window compact — session 5/.test(doc.title) && doc.source === 'context-compact' && /\*\*Lucas\*\* \(turn 1\)/.test(doc.body), 'the verbatim transcript LANDS as the durable copy (speakers + turn ids)');
    const st = JSON.parse(d.getMeta('context.rolling.5'));
    ok(st.sinceTurnId === r.toId && st.blocks.length === 1 && st.blocks[0].docId === 100, 'the horizon advances and the block records its doc');
    const a = rc.assemble(d, 5);
    ok(/<recall ref="d100"\/>/.test(a.messages[0].content) && /parish-confirmed/.test(a.messages[0].content), '⭐ assembly serves the compact block with the [dN] RECALL HANDLE + the summary');
    ok(a.tailTurns === 12 - r.toId && a.messages.length === 1 + a.tailTurns, 'only the tail past the horizon rides verbatim');
  }

  // ── summarizer failure → deterministic digest ─────────────────────────────────────────────────
  {
    const big = 'y'.repeat(9000);
    const turns = []; for (let i = 1; i <= 12; i++) turns.push(turn(i, 5, i % 2 ? 'user' : 'ai_said', `turn ${i} ${big}`));
    const d = makeDeps({ turns, failComplete: true });
    const r = await rc.maybeCompact(d, 5, { budget: 100000 });
    const st = JSON.parse(d.getMeta('context.rolling.5'));
    ok(r.compacted === true && new RegExp(`^${r.turns} turns\\.`).test(st.blocks[0].summary), 'a dead summarizer falls to the deterministic head/tail digest — never an empty block');
  }

  // ── doc-landing failure → NO compact (the durable copy is the precondition) ───────────────────
  {
    const big = 'z'.repeat(9000);
    const turns = []; for (let i = 1; i <= 12; i++) turns.push(turn(i, 5, i % 2 ? 'user' : 'ai_said', `turn ${i} ${big}`));
    const d = makeDeps({ turns, failLand: true });
    const r = await rc.maybeCompact(d, 5, { budget: 100000 });
    ok(r.compacted === false && /never compact without the durable copy/.test(r.reason) && !d.getMeta('context.rolling.5'), '⭐ no landed doc → no compact, state untouched');
  }

  // ── block overflow: older blocks collapse to doc pointers ─────────────────────────────────────
  {
    const d = makeDeps({ turns: [turn(99, 5, 'user', 'tail')] });
    const blocks = []; for (let i = 0; i < rc.MAX_BLOCKS + 2; i++) blocks.push({ docId: 200 + i, summary: `stretch ${i}`, fromId: i * 10, toId: i * 10 + 9, ts: i });
    d.setMeta('context.rolling.5', JSON.stringify({ sinceTurnId: 90, blocks }));
    const a = rc.assemble(d, 5);
    ok(/EARLIER STILL/.test(a.messages[0].content) && /doc#200/.test(a.messages[0].content) && /doc#201/.test(a.messages[0].content), 'overflow blocks collapse to one doc-pointer line');
    ok(a.messages.filter((m) => /compacted — the FULL verbatim/.test(m.content)).length === rc.MAX_BLOCKS, `only the newest ${rc.MAX_BLOCKS} blocks ride with summaries`);
  }

  // ── wiring greps ──────────────────────────────────────────────────────────────────────────────
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    ok(/const rollingCtxDeps = \(\) => \(/.test(src) && src.indexOf('const rollingCtxDeps') < src.indexOf('async function runChatTurn'), 'wiring: the deps helper is module-level, visible to runChatTurn');
    ok(/_rc\.assemble\(_rcd, currentSessionId/.test(src) && /_rc\.enabled\(_rcd\)/.test(src), 'wiring: the cloud assembly swaps in the rolling history behind the toggle');
    ok(/rollingCompactRunning/.test(src) && /maybeCompact\(deps, currentSessionId, \{ budget:/.test(src), 'wiring: the background compact tick is single-flighted, off the turn path, with the meta budget lever');
    ok(/context\.rolling\.budget/.test(src), 'wiring: the endurance budget override reads db meta');
    ok(/cloudMessages = \[_pkgSys, \.\.\._histTurns, \.\.\.\(_finalTurn \? \[_finalTurn\] : \[\]\)\]/.test(src), 'wiring: the composed final user turn rides UNCHANGED after the rolling prefix');
  }

  console.log(`\nsmoke_rolling_context: ${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})();
