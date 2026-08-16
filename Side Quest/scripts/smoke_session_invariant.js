/* smoke_session_invariant.js — the "model-visible means logged" invariant (deepseek-harness borrow, 2026-08-15).
 *
 * Proves: (1) a prior USER turn replays what the model ACTUALLY saw (model_visible), not the raw content —
 * the answer-orphaning structural fix (a reply that referenced injected held-data no longer reads as
 * unfounded when the turn scrolls back); (2) transient [CONTROL …] state-directives are STRIPPED on replay
 * (a stale work-hold must never re-assert); (3) model_visible round-trips through the turns store; (4) the
 * replay wiring (context.js entries loop) and the persist site (main.js) actually exist, so they can't rot.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/smoke_session_invariant.js
 */
'use strict';
const context = require('../lib/context');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } };

console.log('_replayUserContent — the model sees what it SAW, minus transient control:');
{
  const held = 'who represents LA Senate 14?\n\n[You hold these verified rows: District 14 vacant — Larry Selders died in office]';
  ok('model_visible wins over raw content (held-data survives the scroll-back)',
    context._replayUserContent({ content: 'who represents LA Senate 14?', model_visible: held }).includes('Larry Selders'));
  ok('the raw user text is still present in the replay',
    context._replayUserContent({ content: 'x', model_visible: held }).includes('who represents LA Senate 14?'));

  const withControl = 'confirm the hold\n\n[CONTROL — STATE ALREADY CHANGED: every work project is NOW ON HOLD until Monday. Do NOT commit to any task.]';
  const replayed = context._replayUserContent({ content: 'confirm the hold', model_visible: withControl });
  ok('transient [CONTROL …] block is STRIPPED on replay (no stale-state re-assert)', !/CONTROL|ON HOLD/.test(replayed));
  ok('…but the real message survives the strip', replayed.includes('confirm the hold'));

  ok('no model_visible → falls back to raw content', context._replayUserContent({ content: 'just this' }) === 'just this');
  ok('empty model_visible → falls back to content', context._replayUserContent({ content: 'fallback', model_visible: '' }) === 'fallback');
  ok('control-ONLY model_visible collapses to content (never an empty replay)',
    context._replayUserContent({ content: 'real', model_visible: '[CONTROL — x]' }) === 'real');
}

console.log('\nturns store round-trips model_visible (SELECT * carries it):');
try {
  const os = require('os'), path = require('path');
  process.env.SQ_DB_PATH = process.env.SQ_DB_PATH || path.join(os.tmpdir(), `sq_sesinv_${process.pid}`, 'sq.db');
  const db = require('../lib/db'); db.init();
  const sid = db.startSession();
  const row = db.insertTurn({ sessionId: sid, speaker: 'user', content: 'raw text' });
  db.setTurnModelVisible(row.id, 'raw text\n\n[held: X=5]');
  const got = db.getRecentTurns(5).find((r) => r.id === row.id);
  ok('getRecentTurns row carries model_visible', !!(got && got.model_visible && got.model_visible.includes('X=5')));
  ok('and the raw content column is untouched', !!(got && got.content === 'raw text'));
} catch (e) { ok('db round-trip setup: ' + e.message, false); }

console.log('\nWIRING — the replay + persist sites actually exist (can\'t rot):');
{
  const fs = require('fs'), path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'context.js'), 'utf8');
  ok('context.js user-turn replay uses _replayUserContent (not raw t.content)',
    /role: 'user', content: _replayUserContent\(t\)/.test(src));
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  ok('main.js persists model_visible before the reply prompt',
    /setTurnModelVisible\(userTurnRow\.id, composedUserMessage\)/.test(main));
}

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
