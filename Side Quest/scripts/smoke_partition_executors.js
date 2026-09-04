/* smoke_partition_executors.js — stage 4.5 D (2026-09-04): PARTITIONS AS EXECUTORS + THE FOLD.
 *
 * Pure halves of the swarm primitive's dispatch and fold (merge map contract parts 4 and 5):
 * lib/executor_pick decides which registry row runs a partition (an Echo agent for engine-native work —
 * bills, contact rosters — this side's worker for web research); lib/partition_fold reads an engine
 * partition's FOUND / NOT FOUND / SOURCES return and names the targets it covered by the same rule this
 * side's passes use (lib/research.targetIsCovered).
 */
'use strict';
const fs = require('fs'), path = require('path');
const P = require('../lib/executor_pick');
const F = require('../lib/partition_fold');

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`); } };

const roles = [
  { name: 'collector', executor: 'echo' }, { name: 'bill-tracker', executor: 'echo' }, { name: 'swarm-worker', executor: 'sq' }, { name: 'operator', executor: 'sq' },
];
const county = { id: 'county-commissions-fl', kind: 'entity', goal: 'every county in Florida — all 67 counties, each with its governing board AND the other county-elected offices' };
const topic = { id: 'topic-ai', kind: 'entity', lane: 'topic', goal: 'Continuously develop a deep, corroborated concept map of frontier AI. Browser-first.' };
const bills = { id: 'bills-fl-2026', kind: 'bill', goal: 'track every pinned Florida bill through committee and floor' };
const contacts = { id: 'focus-42-swarm', kind: 'entity', goal: 'compile contact information (email, phone) for the leadership of every Louisiana parish' };

// ── the pick ─────────────────────────────────────────────────────────────────────────────────────
let r = P.pick({ beat: county, targets: ['the governing body of Lee County, Florida'], roles });
ok(r.executor === 'sq' && r.role === 'swarm-worker', "a roster of governing bodies validated against the web runs on this side's worker");
r = P.pick({ beat: topic, targets: ['frontier AI labs'], roles });
ok(r.executor === 'sq', "a topic's sub-topics are web research — this side");
r = P.pick({ beat: bills, targets: ['HB 1'], roles });
ok(r.executor === 'echo' && r.role === 'bill-tracker' && /engine-native/.test(r.why), 'bills go to the bill tracker (engine-native: the bills store, LegiScan, the feeds)');
r = P.pick({ beat: contacts, targets: ['Jefferson Parish'], roles });
ok(r.executor === 'echo' && r.role === 'collector' && /P15/.test(r.why), "a contact roster goes to the collector (the CRM first, the APIs, the web last — P15)");
r = P.pick({ beat: { id: 'x', kind: 'entity', goal: 'donors and lobbyists connected to the parish councils' }, targets: [], roles });
ok(r.executor === 'echo' && r.role === 'collector', 'donors and lobbyists read as a contact roster');
r = P.pick({ beat: contacts, roles, policy: 'sq' });
ok(r.executor === 'sq' && /policy/.test(r.why), 'policy swarm.executors=sq pins every partition to this side');
r = P.pick({ beat: contacts, roles, engineConnected: false });
ok(r.executor === 'sq' && /not connected/.test(r.why), 'a disconnected engine falls to this side with the reason named');
r = P.pick({ beat: bills, roles: roles.filter((x) => x.name !== 'bill-tracker') });
ok(r.executor === 'sq' && /not in the registry/.test(r.why), 'a role missing from the registry falls to this side with the reason named');
r = P.pick({ beat: { ...county, executor: 'sq' }, roles, plan: { goal: 'contacts for every county' } });
ok(r.executor === 'sq' && /the beat pins/.test(r.why), 'a beat that pins this side wins over the goal words');
r = P.pick({ beat: { ...county, executor: 'collector' }, roles });
ok(r.executor === 'echo' && r.role === 'collector' && /names its executor/.test(r.why), 'a beat may name its executor role outright');
r = P.pick({ beat: { ...county, executor: 'echo' }, roles });
ok(r.executor === 'echo' && r.role === 'collector', 'a beat asking for the engine without a role gets the collector (the general engine-native worker)');
r = P.pick({ beat: county, plan: { shape: 'contacts', goal: 'find the email and phone of each county clerk' }, roles });
ok(r.executor === 'echo' && r.role === 'collector', "the plan's goal counts too (a focus plan asking for emails and phones)");
ok(P.pick({}).executor === 'sq' && P.pick({ beat: null, roles: [] }).role === 'swarm-worker', 'no beat, no roles → this side, never a throw');

// ── the brief an engine partition receives ─────────────────────────────────────────────────────
const b = P.brief({ goal: 'compile leadership contacts for the parishes', targets: ['Jefferson Parish', 'Orleans Parish'], index: 2, of: 3, facets: ['president', 'clerk'] });
ok(/partition 2\/3/.test(b) && /1\. Jefferson Parish\n2\. Orleans Parish/.test(b) && /Facets to establish for each target: president; clerk\./.test(b), 'the brief carries the goal, the numbered targets and the facets');
ok(/FOUND: <one line per target you established, each STARTING WITH THE TARGET NAME EXACTLY AS LISTED/.test(b) && /NOT FOUND:/.test(b) && /SOURCES:/.test(b), 'the brief asks for the FOUND / NOT FOUND / SOURCES shape the fold reads, target names leading');

// ── the fold ─────────────────────────────────────────────────────────────────────────────────────
const targets = ['Jefferson Parish', 'Orleans Parish', 'St. Charles Parish', 'Lafourche Parish'];
const out = `I worked the partition.
FOUND:
- Jefferson Parish — President Cynthia Lee Sheng; clerk Jon Gegenheimer (https://www.jeffparish.net/council)
- Orleans Parish: Council President Helena Moreno — source https://council.nola.gov/
- St. Charles Parish — no change from what the CRM holds (verified against https://www.stcharlesparish-la.gov/)
NOT FOUND:
- Lafourche Parish — the site was down; the CRM row is stale
SOURCES: https://www.jeffparish.net/council, https://council.nola.gov/, https://www.stcharlesparish-la.gov/`;
const f = F.foldFound({ output: out, targets });
ok(f.covered.length === 3 && f.covered.includes('Jefferson Parish') && f.covered.includes('Orleans Parish') && f.covered.includes('St. Charles Parish') && !f.covered.includes('Lafourche Parish'), `FOUND lines cover exactly the targets they name (${f.covered.join(', ')})`);
ok(f.notFound.length === 1 && /Lafourche/.test(f.notFound[0]) && f.found.length === 3, 'NOT FOUND is read separately; a NOT FOUND target is never covered');
ok(f.sources.length === 3 && f.sources.every((u) => /^https:\/\//.test(u)) && !f.sources.some((u) => /,$/.test(u)), 'SOURCES are the deduplicated urls, trailing punctuation stripped');
const f2 = F.foldFound({ output: 'FOUND: · the neighbor of Orleans Parish is not the target · SOURCES: none', targets: ['Plaquemines Parish'] });
ok(f2.covered.length === 0 && f2.unmatched.length === 1, 'a line that merely mentions a neighbor covers nothing (the bounded-residue rule, never a loose substring)');
const f3 = F.foldFound({ output: 'nothing in the expected shape', targets });
ok(f3.covered.length === 0 && f3.found.length === 0 && f3.notFound.length === 0, 'an output without the shape folds nothing (honest empty), never a throw');
const f4 = F.foldFound({ output: 'FOUND: Jefferson Parish — x · Jefferson Parish — again · SOURCES: https://a', targets });
ok(f4.covered.length === 1, 'a target named twice is covered once');

// ── the runtime half with injected collaborators: dispatch, close, fold ─────────────────────────
(async () => {
  const X = require('../lib/swarm_executors');
  const os = require('os');
  const Database = require('better-sqlite3');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq_swarmexec_'));
  const db = new Database(path.join(dir, 'sq.db'));
  const dbSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'db.js'), 'utf8');
  db.exec(dbSrc.match(/`CREATE TABLE IF NOT EXISTS runs \([\s\S]*?\)`/)[0].slice(1, -1));
  const L0 = require('../lib/run_ledger');
  const ledger = { start: (a) => L0.start(a, { db }), finishByEcho: (id, p) => L0.finishByEcho(id, p, { db }), live: () => L0.live({ db }), get: (id) => L0.get(id, { db }) };
  const calls = [];
  let T = 1_800_000_000_000;
  const dispatch = async (tag, opts) => {
    calls.push({ name: tag.name, args: tag.args, opts });
    if (tag.name === 'spawn_agent_async') return { ok: true, text: JSON.stringify({ run_id: `eng-${calls.length}`, state: 'queued' }) };
    if (tag.name === 'agent_status') return { ok: true, text: JSON.stringify({ run_id: tag.args.run_id, state: tag.args.run_id === 'eng-1' ? 'succeeded' : 'running' }) };
    if (tag.name === 'get_agent_output') return { ok: true, text: JSON.stringify([{ run_id: tag.args.run_id, output: 'FOUND:\n- Jefferson Parish — president X (https://a)\n- Orleans Parish — president Y (https://b)\nNOT FOUND:\n- St. Charles Parish\nSOURCES: https://a, https://b' }]) };
    return { ok: false, text: 'unknown' };
  };
  const parent = ledger.start({ role: 'swarm', executor: 'sq', trigger_kind: 'scheduled', lane: 'research', now: T });
  const d1 = await X.dispatchEchoPartition({ role: 'collector', goal: 'contacts for the parishes', targets: ['Jefferson Parish', 'Orleans Parish', 'St. Charles Parish'], index: 1, of: 2, lane: 'research', parentRunId: parent, beatId: 'focus-42-swarm', deps: { dispatch, ledger, now: () => T } });
  ok(d1.ok && d1.part.executor === 'echo' && d1.part.echo_run_id === 'eng-1' && d1.part.n === 3 && d1.part.done === false, 'dispatchEchoPartition spawns the role and returns the part record keyed on the engine run id');
  ok(calls[0].name === 'spawn_agent_async' && calls[0].args.name === 'collector' && calls[0].args.lane === 'research' && /partition 1\/2/.test(calls[0].args.prompt) && calls[0].opts.autonomous === true, "the spawn names the role, carries the parent's lane, and the brief");
  const child = ledger.get(d1.part.run_id);
  ok(child && child.executor === 'echo' && child.parent_run_id === parent && child.state === 'queued' && child.echo_run_id === 'eng-1', 'the child run is in the ledger under the parent, queued, keyed on the engine run id');
  const d2 = await X.dispatchEchoPartition({ role: 'collector', goal: 'g', targets: ['Lafourche Parish'], index: 2, of: 2, lane: 'research', parentRunId: parent, deps: { dispatch, ledger, now: () => T } });
  const bad = await X.dispatchEchoPartition({ role: 'collector', goal: 'g', targets: ['x'], index: 1, of: 1, lane: 'research', deps: { dispatch: async () => ({ ok: false, isError: true, text: 'Echo tool "spawn_agent_async" is a spawn action — refused' }), ledger } });
  ok(!bad.ok && /engine refused/.test(bad.why), "an engine refusal is a named failure the caller can fall back from (this side's worker)");
  // close: only runs older than minAgeMs, at most max per tick, skipping ids a chat watcher owns
  T += 20000;
  const c0 = await X.closeEchoRuns({ deps: { dispatch, ledger, now: T, minAgeMs: 60000 } });
  ok(c0.checked === 0, 'a run younger than minAgeMs is left alone (let the engine start it)');
  const c1 = await X.closeEchoRuns({ deps: { dispatch, ledger, now: T, pendingIds: new Set(['eng-2']) } });
  ok(c1.checked === 1 && c1.closed === 1 && ledger.get(d1.part.run_id).state === 'succeeded' && /FOUND:/.test(ledger.get(d1.part.run_id).output) && ledger.get(d2.part.run_id).state === 'queued', 'closeEchoRuns polls the open engine runs a chat watcher does not own, fetches the output on success and finishes the row');
  // fold: the FOUND lines cover the parent's targets
  const meta = { 'focus.42.covered': JSON.stringify(['Plaquemines Parish']) };
  const fold = X.foldEchoPartition({ part: d1.part, run: ledger.get(d1.part.run_id), coveredKey: 'focus.42.covered', getMeta: (k) => meta[k], setMeta: (k, v) => { meta[k] = v; } });
  ok(fold.ok && fold.covered === 2 && fold.added === 2 && fold.notFound === 1 && JSON.parse(meta['focus.42.covered']).length === 3 && JSON.parse(meta['focus.42.covered']).includes('Orleans Parish'), "the fold lands the established targets on the parent's covered list (the same list this side's passes write)");
  const fold2 = X.foldEchoPartition({ part: d1.part, run: ledger.get(d1.part.run_id), coveredKey: 'focus.42.covered', getMeta: (k) => meta[k], setMeta: (k, v) => { meta[k] = v; } });
  ok(fold2.added === 0 && JSON.parse(meta['focus.42.covered']).length === 3, 'folding twice adds nothing twice');
  ok(X.foldEchoPartition({ part: d2.part, run: ledger.get(d2.part.run_id), coveredKey: 'k', getMeta: () => null, setMeta: () => {} }).covered === 0, 'an unfinished run folds nothing');
  db.close();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}

  console.log(`\nsmoke_partition_executors: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
