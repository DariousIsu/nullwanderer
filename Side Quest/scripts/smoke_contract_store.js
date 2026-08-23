'use strict';
/* smoke_contract_store.js — CONTRACT AGENT slice 0 (docs/CONTRACT_AGENT_SPEC_2026-08-22.md §4-§5).
 * The durable contract store: slots, inbox/outbox, questions-with-assumptions, the append-only
 * wavelog, and the boot resume read. The persistence case closes and REOPENS the db file — a
 * synthetic contract must survive a process death at the last committed wave. */
const path = require('path'), os = require('os'), fs = require('fs');

const dbDir = path.join(os.tmpdir(), `sq_contracts_${process.pid}`);
fs.mkdirSync(dbDir, { recursive: true });
process.env.CONTRACTS_DB_PATH = path.join(dbDir, 'contracts.db');
let cs = require('../lib/contract_store');

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`); } };

// ── open + identity ─────────────────────────────────────────────────────────────────────────────
const c = cs.openContract({
  title: 'LA data-center community benefits — slide table',
  askVerbatim: 'Pull up everything on the community benefits agreed to by Meta and Applied Digital in Louisiana.',
  originTurn: 4242,
  topicTokens: ['meta', 'applied', 'digital', 'louisiana', 'richland', 'rapides'],
  entities: ['Meta Hyperion', 'Applied Digital Delta Forge'],
  budget: { tokenEstimate: 400000 },
});
ok(c && /^ct-/.test(c.contractId) && c.status === 'open', 'openContract returns an open contract with a stable id');
ok(c.topicTokens.includes('rapides') && c.budget.tokenEstimate === 400000, 'JSON fields round-trip');
ok(cs.openContract({ title: '', askVerbatim: 'x' }) === null, 'a titleless open is refused');
ok(cs.getContract('ct-nope') === null, 'unknown id → null, no throw');

// ── slots ───────────────────────────────────────────────────────────────────────────────────────
ok(cs.upsertSlot({ contractId: c.contractId, slotId: 'richland-jobs', description: 'Richland JOBS cell' }), 'slot upsert (open)');
ok(cs.upsertSlot({ contractId: c.contractId, slotId: 'richland-taxes', description: 'Richland TAXES cell' }), 'second slot');
ok(cs.upsertSlot({ contractId: c.contractId, slotId: 'rapides-water', description: 'Rapides WATER cell' }), 'third slot');
ok(!cs.upsertSlot({ contractId: c.contractId, slotId: 'bad', description: 'x', status: 'done' }), 'an invalid slot status is refused');
ok(!cs.upsertSlot({ contractId: 'ct-nope', slotId: 'x', description: 'x' }), 'a slot on an unknown contract is refused');
ok(cs.upsertSlot({ contractId: c.contractId, slotId: 'richland-jobs', status: 'filled', contentRef: 'dataset:la_dc/richland_jobs', citations: [{ src: 'WWNO', date: '2026-07-14' }] }), 'fill preserves description when omitted');
{
  const s = cs.slots(c.contractId).find((x) => x.slotId === 'richland-jobs');
  ok(s.status === 'filled' && s.description === 'Richland JOBS cell' && s.citations[0].src === 'WWNO', 'the filled slot kept its description and holds its citation');
}

// ── wavelog: commit-before-surface + idempotent resume ──────────────────────────────────────────
const w1 = cs.beginWave(c.contractId, 'decompose + internal-first sweep');
ok(w1 && w1.waveN === 1 && !w1.resumed, 'wave 1 begins');
ok(cs.beginWave(c.contractId, 'ignored').resumed === true, 'a second begin while wave 1 is open RESUMES it (never stacks)');
ok(cs.endWave(w1.waveId, { actions: ['search', 'canvas-scan'], tokens: 1200, outcome: 'slots proposed' }), 'wave 1 ends');
ok(!cs.endWave(w1.waveId, {}), 'double-end is refused');
const w2 = cs.beginWave(c.contractId, 'external wave: gdelt + extract');
ok(w2.waveN === 2 && !w2.resumed, 'wave 2 begins fresh after wave 1 ended');
ok(cs.getContract(c.contractId).agent.waveN === 2 && cs.getContract(c.contractId).agent.lastWaveTs > 0, 'the agent beat (lastWaveTs/waveN) rides the contract — the invented-agent gate\'s positive source');

// ── inbox: steering lands at the replan seam; tombstones repair misroutes ───────────────────────
const m1 = cs.postInbox({ contractId: c.contractId, kind: 'steering', text: 'add ratepayer impacts to the dig', ackSayRef: 'say#991' });
const m2 = cs.postInbox({ contractId: c.contractId, kind: 'steering', text: 'wrong-thread message', ackSayRef: 'say#992' });
ok(m1 && m2 && cs.readInbox(c.contractId).length === 2, 'two steering messages pending');
ok(cs.tombstoneInbox(m2, 0), 'the misroute is tombstoned');
ok(cs.readInbox(c.contractId).length === 1 && cs.readInbox(c.contractId)[0].id === m1, 'a tombstoned message never reaches the agent');
ok(cs.markInboxConsumed([m1], 2) === 1, 'wave 2 consumes the steering');
ok(cs.readInbox(c.contractId).length === 0, 'consumed steering never re-applies');
ok(cs.readInbox(c.contractId, { unconsumedOnly: false }).length === 1, 'history keeps the consumed message (tombstoned stays out)');

// ── questions: a flagged default means the loop NEVER stalls ────────────────────────────────────
const q1 = cs.openQuestion({ contractId: c.contractId, slotId: 'richland-taxes', text: 'placeholder numbers or real content for the tax cell?', options: ['placeholders', 'real'], assumption: 'all 8 cells need real content', windowMs: 60 * 60 * 1000 });
ok(q1 && q1.status === 'open', 'question opens');
ok(cs.slots(c.contractId).find((x) => x.slotId === 'richland-taxes').status === 'blocked_on_question', 'its slot blocks');
ok(cs.answerQuestion(q1.questionId, { text: 'real content, all cells', turnRef: 'turn#5001' }), 'the answer lands');
ok(cs.getQuestion(q1.questionId).status === 'answered' && cs.getQuestion(q1.questionId).answer.text === 'real content, all cells', 'answer recorded');
ok(cs.slots(c.contractId).find((x) => x.slotId === 'richland-taxes').status === 'open', 'the answered slot unblocks');
ok(!cs.answerQuestion(q1.questionId, { text: 'again' }), 'a second answer is refused');

const q2 = cs.openQuestion({ contractId: c.contractId, slotId: 'rapides-water', text: 'is the waterless-cooling claim enough for the water row?', assumption: 'use it, labeled as a company claim', windowMs: 1 });
ok(q2 && cs.expireDueQuestions(Date.now() + 10).length === 1, 'the due question expires');
{
  const s = cs.slots(c.contractId).find((x) => x.slotId === 'rapides-water');
  ok(cs.getQuestion(q2.questionId).status === 'expired' && s.status === 'flagged', 'expiry → the slot is FLAGGED, not stuck');
  ok(s.flags.some((f) => f.kind === 'assumption' && /company claim/.test(f.text)), 'the assumption flag SURVIVES into the slot');
}
ok(cs.openQuestion({ contractId: c.contractId, text: 'no assumption', assumption: '', windowMs: 1000 }) === null, 'a question without a default assumption is refused');

// ── outbox: surfacings queue for the voicer ─────────────────────────────────────────────────────
const o1 = cs.postOutbox({ contractId: c.contractId, kind: 'finding', slotId: 'richland-jobs', text: 'Meta ~7,500 construction jobs at peak — the placeholder understated by 10x' });
const o2 = cs.postOutbox({ contractId: c.contractId, kind: 'judgment_call', text: 'no Rapides tax figure published — framing as tax-base + taxpayer protection unless told otherwise' });
ok(o1 && o2 && cs.unvoiced().length === 2, 'two surfacings pending');
ok(cs.postOutbox({ contractId: c.contractId, kind: 'chitchat', text: 'x' }) === null, 'an unknown surfacing kind is refused');
ok(cs.markVoiced(o1) && cs.unvoiced().length === 1 && cs.unvoiced()[0].id === o2, 'voiced surfacings drain in order');

// ── status transitions ──────────────────────────────────────────────────────────────────────────
ok(!cs.setStatus(c.contractId, 'closed'), 'open → closed directly is refused (the audit gate is unreachable-by-construction)');
ok(cs.setStatus(c.contractId, 'closing'), 'open → closing');
ok(cs.setStatus(c.contractId, 'open'), 'closing → open (a failed audit reopens)');
ok(cs.setStatus(c.contractId, 'closing') && cs.setStatus(c.contractId, 'closed'), 'closing → closed');
ok(cs.getContract(c.contractId).closedTs > 0, 'closed_ts stamped');
ok(!cs.setStatus(c.contractId, 'open'), 'closed is terminal');

// ── counts + resume read ────────────────────────────────────────────────────────────────────────
const c2 = cs.openContract({ title: 'second contract', askVerbatim: 'do the thing', topicTokens: ['thing'] });
cs.upsertSlot({ contractId: c2.contractId, slotId: 's1', description: 'one' });
const w = cs.beginWave(c2.contractId, 'wave 1'); cs.endWave(w.waveId, { outcome: 'ok' });
cs.beginWave(c2.contractId, 'wave 2 — interrupted');
cs.postInbox({ contractId: c2.contractId, kind: 'steering', text: 'pending steer' });

// ── PERSISTENCE: close the connection, reopen the same file — the reboot survival gate ──────────
cs.close();
delete require.cache[require.resolve('../lib/contract_store')];
cs = require('../lib/contract_store');
{
  const res = cs.resumeOpenContracts();
  ok(res.length === 1 && res[0].contractId === c2.contractId, 'RESUME: only the open contract comes back (the closed one stays closed)');
  ok(res[0].lastCompletedWaveN === 1 && res[0].interruptedWaveN === 2, 'RESUME: the interrupted wave is the named resume point');
  ok(res[0].counts.inboxPending === 1 && res[0].counts.slots.open === 1, 'RESUME: pending steering + open slots survive the process death');
  const wr = cs.beginWave(c2.contractId, 'ignored');
  ok(wr.resumed === true && wr.waveN === 2, 'RESUME: beginWave re-enters the interrupted wave, never stacks a new one');
  const closedCounts = cs.counts(c.contractId);
  ok(closedCounts.wavesDone === 1 && closedCounts.outboxUnvoiced === 1, 'the closed contract\'s history is intact for status truth');
}

try { cs.close(); fs.rmSync(dbDir, { recursive: true, force: true }); } catch {}

console.log(`\nsmoke_contract_store: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
