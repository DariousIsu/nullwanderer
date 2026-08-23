'use strict';
/* smoke_contract_voice.js — CONTRACT AGENT slice 2 (docs/CONTRACT_AGENT_SPEC_2026-08-22.md §7).
 * The surfacing voicer: outbox → ONE coalesced unprompted say at the next open boundary; held
 * mid-exchange and while away (items durable); cloud rendering with the number-invention guard
 * and the deterministic floor; questions carry their proceed-assumption; lastWaveTs positive source. */
const path = require('path'), os = require('os'), fs = require('fs');

const dbDir = path.join(os.tmpdir(), `sq_cvoice_${process.pid}`);
fs.mkdirSync(dbDir, { recursive: true });
process.env.CONTRACTS_DB_PATH = path.join(dbDir, 'contracts.db');
const store = require('../lib/contract_store');
const cv = require('../lib/contract_voice');

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`); } };

(async () => {
  const A = store.openContract({ title: 'LA data-center benefits', askVerbatim: 'fill the cells' });
  const q = store.openQuestion({ contractId: A.contractId, text: 'is the company cooling claim enough for the water cell?', assumption: 'use it, labeled as a company claim', windowMs: 3600000 });
  store.postOutbox({ contractId: A.contractId, kind: 'finding', text: 'the canvas already holds the compilation — 7,500 construction jobs confirmed there' });
  store.postOutbox({ contractId: A.contractId, kind: 'question', text: 'is the company cooling claim enough for the water cell?', questionId: q.questionId });
  store.postOutbox({ contractId: A.contractId, kind: 'judgment_call', text: 'no Rapides tax figure is published — framing that cell as tax-base + taxpayer protection' });

  const delivered = [];
  const deliver = (text) => { delivered.push(text); return { id: delivered.length }; };

  // ── holds: mid-exchange and away — items stay durable ─────────────────────────────────────────
  let r = await cv.maybeVoice({ store, conversationActive: () => true, isAway: () => false, complete: null, deliver });
  ok(r.voiced === 0 && r.reason === 'mid-exchange' && store.unvoiced().length === 3, 'mid-exchange → held, items stay pending (never barges)');
  r = await cv.maybeVoice({ store, conversationActive: () => false, isAway: () => true, complete: null, deliver });
  ok(r.voiced === 0 && r.reason === 'away' && store.unvoiced().length === 3, 'away → held silent, items stay durable');
  ok(delivered.length === 0, 'nothing delivered while held');

  // ── the roadmap shape ─────────────────────────────────────────────────────────────────────────
  const batch = cv.pendingBatch(store);
  const map = cv.roadmap(batch, store);
  ok(/From the "LA data-center benefits" work:/.test(map), 'the roadmap names the contract');
  ok(/I'll proceed on: use it, labeled as a company claim/.test(map), 'the question carries its proceed-assumption');
  ok(/Judgment call: .*going with that unless you say otherwise/.test(map), 'the judgment call declares its default');

  // ── the number-invention guard: cloud text with a foreign digit falls back ────────────────────
  r = await cv.maybeVoice({ store, conversationActive: () => false, isAway: () => false, deliver,
    complete: async () => 'Quick update — I found 42 new facilities and the compilation confirms 7,500 construction jobs.' });
  ok(r.voiced === 3 && r.rendered === 'deterministic', '⭐ NUMBER-INVENTION GUARD: a cloud rendering with a digit the roadmap lacks (42) is rejected → deterministic floor ships');
  ok(delivered.length === 1 && /7,500 construction jobs/.test(delivered[0]) && !/42/.test(delivered[0]), 'the delivered say holds the real figure and not the invented one');
  ok(store.unvoiced().length === 0, 'ALL three items voiced as ONE coalesced say');

  // ── the cloud path when the rendering is honest ───────────────────────────────────────────────
  store.postOutbox({ contractId: A.contractId, kind: 'milestone', text: 'all 3 slots landed — heading to close-out' });
  r = await cv.maybeVoice({ store, conversationActive: () => false, isAway: () => false, deliver,
    complete: async (messages) => { ok(/NEVER add facts, numbers, or actions/.test(messages[0].content), 'the cloud prompt forbids invention'); return 'Milestone on the data-center work: all 3 slots landed, heading to close-out.'; } });
  ok(r.voiced === 1 && r.rendered === 'cloud' && /all 3 slots landed/.test(delivered[1]), 'an honest cloud rendering ships in her voice');

  // ── failure floors ────────────────────────────────────────────────────────────────────────────
  store.postOutbox({ contractId: A.contractId, kind: 'blocked', text: 'wave budget spent with open slots' });
  r = await cv.maybeVoice({ store, conversationActive: () => false, isAway: () => false, deliver, complete: async () => { throw new Error('cloud down'); } });
  ok(r.voiced === 1 && r.rendered === 'deterministic' && /Blocked: wave budget spent/.test(delivered[2]), 'a cloud failure ships the deterministic floor, never silence');
  r = await cv.maybeVoice({ store, conversationActive: () => false, isAway: () => false, deliver, complete: null });
  ok(r.voiced === 0 && r.reason === 'empty', 'an empty outbox voices nothing');

  // ── stale questions retire silently (the live ct-mt598xyv-1 shape) ────────────────────────────
  const q2 = store.openQuestion({ contractId: A.contractId, text: 'already answered?', assumption: 'yes', windowMs: 3600000 });
  store.postOutbox({ contractId: A.contractId, kind: 'question', text: 'already answered?', questionId: q2.questionId });
  store.postOutbox({ contractId: A.contractId, kind: 'finding', text: 'a fresh finding rides normally' });
  store.answerQuestion(q2.questionId, { text: 'yes it is' });
  r = await cv.maybeVoice({ store, conversationActive: () => false, isAway: () => false, deliver, complete: null });
  ok(r.voiced === 1 && !/already answered\?/.test(delivered[delivered.length - 1]) && /fresh finding/.test(delivered[delivered.length - 1]),
    'an ANSWERED question retires silently — she never asks what she already knows');
  ok(store.unvoiced().length === 0, 'the stale item is marked voiced, not stuck pending');

  // ── multi-contract coalescing + the positive source ───────────────────────────────────────────
  const B = store.openContract({ title: 'second dig', askVerbatim: 'do b' });
  store.postOutbox({ contractId: A.contractId, kind: 'finding', text: 'one from A' });
  store.postOutbox({ contractId: B.contractId, kind: 'finding', text: 'one from B' });
  r = await cv.maybeVoice({ store, conversationActive: () => false, isAway: () => false, deliver, complete: null });
  ok(r.voiced === 2 && /\[LA data-center benefits\]/.test(delivered[delivered.length - 1]) && /\[second dig\]/.test(delivered[delivered.length - 1]), 'two contracts coalesce into one say with per-contract headers');
  ok(store.lastWaveTs() === 0, 'lastWaveTs is 0 with no waves');
  const w = store.beginWave(A.contractId, 'x');
  ok(store.lastWaveTs() > 0, 'lastWaveTs reflects a real wave — the anti-fab positive source');
  store.endWave(w.waveId, {});

  try { store.close(); fs.rmSync(dbDir, { recursive: true, force: true }); } catch {}
  console.log(`\nsmoke_contract_voice: ${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})().catch((e) => { console.error('SMOKE CRASHED:', e); process.exitCode = 1; });
