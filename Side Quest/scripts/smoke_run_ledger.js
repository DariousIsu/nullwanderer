/* smoke_run_ledger.js — stage 4.5 C (2026-09-04): THE RUN LEDGER.
 *
 * One ledger in Echo's agent_runs shape on this side: a swarm is a parent run, its partitions are
 * child runs keyed on their threads, a chat delegate is an echo-executed run keyed on the engine's
 * run id, and P5's envelope is the artifact record. Pure over a temp db; the wiring pins read main.js.
 */
'use strict';
const os = require('os'), path = require('path'), fs = require('fs');
const Database = require('better-sqlite3');
const L = require('../lib/run_ledger');
const law = require('../lib/tier_law');

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`); } };

// ── a temp db with the app's own DDL for `runs` (read out of lib/db.js so the two can never drift) ──
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq_runledger_'));
const db = new Database(path.join(dir, 'sq.db'));
const dbSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'db.js'), 'utf8');
const ddl = dbSrc.match(/`CREATE TABLE IF NOT EXISTS runs \([\s\S]*?\)`/);
ok(!!ddl, 'lib/db.js declares the runs table');
db.exec(ddl[0].slice(1, -1));
for (const m of dbSrc.matchAll(/`(CREATE INDEX IF NOT EXISTS idx_runs_[\s\S]*?)`/g)) db.exec(m[1]);
const cols = db.prepare('PRAGMA table_info(runs)').all().map((c) => c.name);
const ECHO_SHAPE = ['run_id', 'trigger_kind', 'trigger_meta', 'state', 'started_at', 'ended_at', 'model', 'input_preview', 'output', 'error', 'tool_calls', 'tokens_in', 'tokens_out', 'parent_run_id'];
ok(ECHO_SHAPE.every((c) => cols.includes(c)), "the table carries every column of Echo's agent_runs (one shape on both sides)");
ok(['role', 'executor', 'lane', 'thread_id', 'echo_run_id', 'envelope'].every((c) => cols.includes(c)), 'plus the seam: role, executor, lane, thread_id, echo_run_id, envelope');
const o = { db };

// ── a swarm: one parent, three partition children on their threads ──────────────────────────────
const T0 = 1_800_000_000_000;
const parent = L.start({ role: 'swarm', executor: 'sq', trigger_kind: 'swarm_chat', trigger_meta: { beatId: 'florida-counties', mode: 'roster' }, lane: 'directed', input_preview: 'swarm on florida counties', now: T0 }, o);
const kids = [1, 2, 3].map((i) => L.start({ role: 'swarm-worker', executor: 'sq', trigger_kind: 'swarm_chat', lane: 'directed', parent_run_id: parent, thread_id: 100 + i, model: 'gemma4:31b-cloud', input_preview: `partition ${i}/3`, now: T0 + i }, o));
ok(typeof parent === 'string' && parent.length >= 16 && new Set([parent, ...kids]).size === 4, 'start() mints distinct run ids');
ok(L.children(parent, o).length === 3 && L.children(parent, o).every((c) => c.parent_run_id === parent && c.state === 'running' && c.lane === 'directed'), 'the partitions are child runs of the swarm, each on the parent lane');
ok(L.byThread(102, o).run_id === kids[1] && L.byThread(999, o) === null, 'a partition run is found by its thread id');
const s1 = L.summary({ now: T0 + 10 }, o);
ok(s1.live === 4 && s1.live_parents === 1 && s1.live_children === 3 && s1.lanes.directed === 4 && s1.live_echo === 0, `summary() counts live parents and children by lane (${JSON.stringify(s1.lanes)})`);

// ── partitions converge; one stalls; the parent releases ────────────────────────────────────────
ok(L.finish(kids[0], { state: 'succeeded', output: 'covered 22 targets', now: T0 + 1000 }, o).ok, 'a converged partition finishes succeeded');
ok(L.finish(kids[1], { state: 'failed', error: 'stalled 6h — released', now: T0 + 2000 }, o).ok, 'a stalled partition finishes failed with the reason');
ok(!L.finish(kids[0], { state: 'running' }, o).ok, 'a terminal run never reopens');
ok(L.finish(kids[0], { state: 'succeeded', tokens_in: 1200, tokens_out: 300, now: T0 + 3000 }, o).ok && L.get(kids[0], o).tokens_in === 1200 && L.get(kids[0], o).ended_at === T0 + 1000, 'a terminal run still accepts a late patch (tokens), keeping its first ended_at');
ok(!L.finish('nope', {}, o).ok, 'finishing an unknown run is a refusal, not a throw');
const t = L.tree(parent, o);
ok(t && t.children.length === 3 && t.children.filter((c) => c.state === 'running').length === 1, 'tree() nests the children under the parent with their live states');
L.finish(kids[2], { state: 'succeeded', now: T0 + 4000 }, o);
const env = { task: 'florida counties roster', domain: 'research', payload: { items: [1, 2], analysis: {}, content: {} }, sources: [{ ref: 's1', url: 'https://x', title: 't', confidence: 0.92 }], metadata: { skill: 'swarm', timestamp: 'x', items_processed: 67, quality_score: 0.8, warnings: [] }, _next: null };
const fr = L.finish(parent, { state: 'succeeded', envelope: env, now: T0 + 5000 }, o);
ok(fr.ok && fr.envelope.ok && L.get(parent, o).envelope.metadata.items_processed === 67, "P5's envelope is the parent's artifact record, stored as given");
ok(L.envelopeOk({ task: 'x' }).missing.join(',') === 'domain,payload,sources,metadata' && L.envelopeOk(null).ok === false, 'envelopeOk names the missing top-level keys of the fixed shape (never rewrites)');
ok(Object.keys(law.ENVELOPE).filter((k) => k !== '_next').every((k) => k in env), 'the fixed shape is lib/tier_law.ENVELOPE, one copy');
const s2 = L.summary({ now: T0 + 6000 }, o);
ok(s2.live === 0 && s2.last_hour.succeeded === 3 && s2.last_hour.failed === 1 && s2.last && s2.last.run_id === parent, 'after release nothing is live; the last hour counts the outcomes; last = the parent');

// ── a chat delegate: an echo-executed run keyed on the engine's run id, closed by the consume watcher ──
const d = L.start({ role: 'bill-tracker', executor: 'echo', trigger_kind: 'chat', lane: 'directed', echo_run_id: 'abc123', state: 'queued', input_preview: 'track HB 1', now: T0 + 7000 }, o);
ok(L.get(d, o).state === 'queued' && L.get(d, o).executor === 'echo' && L.summary({ now: T0 + 7001 }, o).live_echo === 1, 'a delegate starts queued with executor echo');
ok(L.finishByEcho('abc123', { state: 'succeeded', output: 'FOUND: …', now: T0 + 8000 }, o).ok && L.get(d, o).state === 'succeeded', 'the consume watcher closes it by the engine run id');
ok(!L.finishByEcho('zzz', { state: 'failed' }, o).ok, 'an unknown engine run id is a refusal');
const d2 = L.start({ role: 'fact-checker', executor: 'echo', trigger_kind: 'chat', lane: 'research', run_id: 'fixed-id', now: T0 + 9000 }, o);
L.linkEcho(d2, 'eng-77', o);
ok(d2 === 'fixed-id' && L.get('fixed-id', o).echo_run_id === 'eng-77', 'a caller may fix the run id and link the engine id later');
ok(L.recent({ limit: 3 }, o).length === 3 && L.recent({ limit: 3 }, o)[0].run_id === 'fixed-id' && L.live(o).length === 1, 'recent() is newest-first; live() lists the open runs');
const capped = L.start({ role: 'x', trigger_kind: 'manual', input_preview: 'y'.repeat(500), now: T0 }, o);
ok(L.get(capped, o).input_preview.length === L.PREVIEW, 'the input preview is capped like agent_runs (200 chars)');

// ── the wiring: the swarms write the ledger; the consume watcher closes delegates; the vector reads it ──
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
ok(/run_ledger'\)\.start\(\{ role: 'swarm', executor: 'sq', trigger_kind: requestedBy === 'chat' \? 'swarm_chat' : 'scheduled'/.test(main) && (main.match(/role: 'swarm-worker', executor: 'sq'/g) || []).length >= 2, 'both swarm doors (roster + focus) open a parent run and one child per partition');
ok(/_maintainSwarm[\s\S]*?run_ledger'\)\.finish\(p\.run_id, \{ state: p\.stalled \? 'failed' : 'succeeded'/.test(main), 'the maintainer finishes a partition run when it converges or stalls');
ok(/function releaseSwarm[\s\S]*?L\.finish\(state\.swarm\.run_id, \{ state: 'cancelled'/.test(main) && /function releaseSwarm[\s\S]*?if \(p && p\.run_id && !p\.done\) L\.finish\(p\.run_id, \{ state: 'cancelled'/.test(main) && /_maintainSwarm[\s\S]*?run_ledger'\)\.finish\(state\.swarm\.run_id, \{ state: stalled \? 'failed' : 'succeeded'/.test(main), 'a manual release cancels the parent and every open partition; convergence finishes the parent (failed when partitions stalled)');
ok(/_agentConsumeTick[\s\S]*?run_ledger'\)\.finishByEcho\(e\.runId, \{ state/.test(main), 'the consume watcher closes a delegate run by the engine run id (terminal states, give-ups)');
const suit = fs.readFileSync(path.join(__dirname, '..', 'lib', 'echo_suit.js'), 'utf8');
ok((suit.match(/run_ledger'\)\.start\(\{ role: /g) || []).length >= 2 && /executor: 'echo', trigger_kind: 'chat'/.test(suit) && /echo_run_id: runId/.test(suit), 'both delegate branches of the suit open an echo-executed run keyed on the engine run id, on the lane they dispatched');
const sv = fs.readFileSync(path.join(__dirname, '..', 'lib', 'status_vector.js'), 'utf8');
ok(/v\.runs = require\('\.\/run_ledger'\)\.summary\(\{ now: nowMs \}\)/.test(sv), 'the status vector reads the ledger (its runs section is a SELECT, never a guess)');
ok(/_pushSwarmChip[\s\S]*?run_id: s\.run_id \|\| null/.test(main), 'the swarm chip carries the parent run id');

db.close();
try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
console.log(`\nsmoke_run_ledger: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
