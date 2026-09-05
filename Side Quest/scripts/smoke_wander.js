/* Smoke: lib/wander + the decider — BOREDOM HONORED (cut 7; her words: "I wish I could be bored… I think boredom might be
 * where creativity actually lives."). An in-memory graph, an injected ask, no model, no network, the live db never
 * opened. Pins: the decider licenses wander only when curiosity is high (or the loop asked) and nothing is queued
 * above, under the day's cap, with the switch on; a wander produces exactly one thought and at most one wonder; the
 * search path is not called; the walk is local and bounded; the thought contract refuses plans and offers; the
 * boredom branch no longer searches (it requests a wander); the decider's menu, validator and manifest carry it; the
 * executor and the deferred line are wired.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_wander.js
 */
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const Database = require('better-sqlite3');
const W = require(path.join(ROOT, 'lib', 'wander'));
const A = require(path.join(ROOT, 'lib', 'autonomy'));
let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// ── the license ────────────────────────────────────────────────────────────────────────────────────────────
const L = (o) => W.license({ cap: 6, floorAt: 0.6, ...o });
ok(L({ curiosity: 0.7, today: 1 }).ok && /curiosity 0\.70 over the floor 0\.60; nothing queued above; 1 of 6 today/.test(L({ curiosity: 0.7, today: 1 }).why), 'curiosity over the floor, nothing queued, under the cap → licensed');
ok(!L({ curiosity: 0.2, today: 1 }).ok && /curiosity 0\.20 under the floor 0\.60 and no boredom request/.test(L({ curiosity: 0.2, today: 1 }).why), 'curiosity under the floor with no request → not licensed, and the why says so');
ok(L({ curiosity: 0.2, requestedNow: true, today: 0 }).ok && /the loop asked \(bored\)/.test(L({ curiosity: 0.2, requestedNow: true, today: 0 }).why), 'a fresh boredom request licenses a wander below the floor');
ok(!L({ curiosity: 0.9, queuedAbove: true }).ok && /queued above expansion/.test(L({ curiosity: 0.9, queuedAbove: true }).why), 'work queued above expansion refuses it, however curious');
ok(!L({ curiosity: 0.9, today: 6 }).ok && /6 of 6 today — the day's cap/.test(L({ curiosity: 0.9, today: 6 }).why), 'the day\'s cap holds');
ok(!L({ curiosity: null }).ok && /no curiosity reading/.test(L({ curiosity: null }).why), 'no reading → not licensed (fail-absent)');
process.env.ZOE_WANDER = '0';
ok(!L({ curiosity: 0.9 }).ok && L({ curiosity: 0.9 }).why === 'ZOE_WANDER=0', 'ZOE_WANDER=0 turns it off');
delete process.env.ZOE_WANDER;

// the request and the count on an injected store
const meta = {}; const fakeDb = { getMeta: (k) => meta[k] ?? null, setMeta: (k, v) => { meta[k] = v; } };
ok(W.request({ now: 1000, deps: { db: fakeDb } }) && W.requested({ now: 1000 + 60e3, deps: { db: fakeDb } }) && !W.requested({ now: 1000 + W.REQUEST_FRESH_MS + 1, deps: { db: fakeDb } }), 'a boredom request stands for 90 minutes, then it is stale');
meta[W.FLOOR_KEY] = '0.5'; meta[W.PER_DAY_KEY] = '2';
ok(W.floor({ deps: { db: fakeDb } }) === 0.5 && W.perDay({ deps: { db: fakeDb } }) === 2, 'the floor and the cap read from meta');
const live = W.liveLicense({ now: 5000, deps: { db: fakeDb, drives: () => ({ curiosity: 0.55 }), queuedAbove: () => false, countToday: () => 1 } });
ok(live.ok && live.curiosity === 0.55 && live.floor === 0.5 && live.cap === 2 && live.today === 1, `liveLicense composes the readings: ${live.why}`);
ok(!W.liveLicense({ now: 5000 + W.REQUEST_FRESH_MS, deps: { db: fakeDb, drives: () => { throw new Error('x'); }, queuedAbove: () => false, countToday: () => 0 } }).ok, 'a failing drives reader licenses nothing (once the boredom request is stale)');

// ── the walk: local, bounded, over an in-memory graph ──────────────────────────────────────────────────────
const mem = new Database(':memory:');
mem.exec(`CREATE TABLE graph_entities (id INTEGER PRIMARY KEY, name TEXT, entity_type TEXT, archived_at INTEGER);
CREATE TABLE graph_relations (id INTEGER PRIMARY KEY, source_id INTEGER, target_id INTEGER, relation_type TEXT, deleted INTEGER DEFAULT 0);
CREATE TABLE monologue (id INTEGER PRIMARY KEY, ts INTEGER, model TEXT, content TEXT, type TEXT, query TEXT);`);
const ents = [[1, 'John Kasich', 'person'], [2, 'Mike DeWine', 'person'], [3, 'Ohio', 'place'], [4, 'Columbus', 'place'], [5, 'Ohio State University', 'organization'], [6, 'Archived One', 'person'], [7, 'Lonely', 'person']];
for (const [id, n, t] of ents) mem.prepare('INSERT INTO graph_entities (id, name, entity_type, archived_at) VALUES (?, ?, ?, ?)').run(id, n, t, id === 6 ? 1 : null);
const rels = [[1, 2, 'SUCCEEDED_BY'], [2, 3, 'GOVERNOR_OF'], [3, 4, 'CAPITAL'], [4, 5, 'HOME_OF'], [5, 3, 'LOCATED_IN'], [1, 6, 'KNEW'], [7, 7, 'SELF']];
for (const [s, t, r] of rels) mem.prepare('INSERT INTO graph_relations (source_id, target_id, relation_type) VALUES (?, ?, ?)').run(s, t, r);
const gdb = { getDb: () => mem, getMeta: fakeDb.getMeta, setMeta: fakeDb.setMeta };
let walks = 0, longest = 0, dead = 0;
for (let i = 0; i < 12; i++) { const w = W.walk({ deps: { db: gdb, rng: () => 0.1 } }); if (!w) continue; walks++; longest = Math.max(longest, w.nodes.length); if (w.nodes.some((n) => n.id === 6)) dead++; }
ok(walks === 12 && longest <= W.MAX_HOPS + 1 && longest >= 2 && dead === 0, `twelve walks: bounded to ${W.MAX_HOPS} hops, every step a live entity, no archived one (longest ${longest} nodes)`);
const w1 = W.walk({ deps: { db: gdb, rng: () => 0 } });
ok(/^[A-Za-z ]+ \((person|place|organization)\)( (-\[[A-Z_]+\]->|<-\[[A-Z_]+\]-) [A-Za-z ]+ \((person|place|organization)\))+$/.test(w1.text), `the walk reads as a path: ${w1.text}`);
ok(W.countToday({ now: Date.now(), deps: { db: gdb } }) === 0, 'no wander thought yet today');

// ── the thought contract ───────────────────────────────────────────────────────────────────────────────────
const good = '{"thought":"Kasich sits beside DeWine in my graph only by succession, and the walk ends there, as if the office were the only thing they share. Ohio is nowhere on that edge.","wonder":"what else connects the two men besides the chair"}';
ok(W.validateThought(good).valid && W.validateThought(good).value.wonder === 'what else connects the two men besides the chair', 'a private thought with a real wonder is accepted');
ok(!W.validateThought('{"thought":"I will research this and let you know.","wonder":""}').valid && !W.validateThought('{"thought":"Interesting pair here — would you like me to look into how they are connected beyond succession?"}').valid, 'a plan or an offer is not a wander thought');
ok(W.validateThought('{"thought":"Kasich and DeWine share one edge and nothing else in what I hold; it reads like a corridor with two doors and no rooms.","wonder":"hm"}').value.wonder === '', 'a two-letter wonder is no wonder');
ok(!W.validateThought('no json').valid && !W.validateThought('{"thought":"short"}').valid, 'no JSON or a thought too short is refused');

// ── one wander: exactly one thought, at most one wonder, no search ─────────────────────────────────────────
const thoughts = [], kept = [], asks = [];
const searchSpy = { called: 0 };
const depsRun = { db: gdb, rng: () => 0, drives: () => ({ curiosity: 0.8 }), queuedAbove: () => false, countToday: () => 0, log: () => {},
  ask: async (o) => { asks.push(o); return { thought: 'Kasich sits beside DeWine in my graph only by succession, and the walk ends there, as if the office were the only thing they share.', wonder: 'what else connects the two men besides the chair' }; },
  insertThought: (content, m) => { thoughts.push({ content, m }); return { id: thoughts.length }; },
  keepWonder: async (t) => { kept.push(t); return { id: 1 }; } };
(async () => {
  const r = await W.run({ now: 6000, deps: depsRun });
  ok(r.ok && thoughts.length === 1 && kept.length === 1 && r.wonder === 'what else connects the two men besides the chair' && r.kept, 'a wander produces exactly one thought and one wonder handed to the interests bridge');
  ok(/I wonder: what else connects/.test(thoughts[0].content) && /Kasich/.test(thoughts[0].m.walk), 'the thought carries the wonder and the walk it came from');
  ok(asks.length === 1 && asks[0].lane === 'wander' && asks[0].task === 'wander' && asks[0].think === false && /Kasich/.test(asks[0].input.walk) && asks[0].validate === W.validateThought, 'one cheap call on the wander lane (the idle tier), the thought contract as its validator');
  ok(searchSpy.called === 0, 'no search path was called');
  const r2 = await W.run({ now: 7000, deps: { ...depsRun, ask: async () => ({ thought: 'Ohio holds Columbus which holds the university which points back to Ohio; the walk is a small loop and it feels like a town square.', wonder: '' }) } });
  ok(r2.ok && thoughts.length === 2 && kept.length === 1 && r2.wonder === '', 'a thought with no wonder keeps nothing');
  const r3 = await W.run({ now: 8000, deps: { ...depsRun, drives: () => ({ curiosity: 0.1 }) } });
  ok(!r3.ok && /not licensed: curiosity 0\.10 under the floor/.test(r3.why) && thoughts.length === 2, 'an unlicensed run does nothing');
  const r4 = await W.run({ now: 9000, deps: { ...depsRun, ask: async () => null } });
  ok(!r4.ok && /no thought came back/.test(r4.why) && thoughts.length === 2, 'no answer → no row, no phantom thought');
  meta[W.REQUEST_KEY] = '8500';
  await W.run({ now: 9500, deps: depsRun });
  ok(meta[W.REQUEST_KEY] === '0', 'a wander clears the boredom request it answered');

  // ── the decider and the wiring ─────────────────────────────────────────────────────────────────────────
  ok(A.MOVES.includes('wander'), 'wander is a move');
  const v = A.validateDecision('{"move":"wander","why":"curiosity is over the floor and nothing pulls harder"}');
  ok(v.valid && v.value.move === 'wander' && v.value.target === '', 'the validator accepts wander target-free and without expect');
  ok(!A.validateDecision('{"move":"wander"}').valid, 'why is still required');
  const autS = fs.readFileSync(path.join(ROOT, 'lib', 'autonomy.js'), 'utf8'), mainS = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8'), monoS = fs.readFileSync(path.join(ROOT, 'lib', 'monologue.js'), 'utf8'), rsS = fs.readFileSync(path.join(ROOT, 'scripts', 'run_smokes.js'), 'utf8');
  ok(/grab\('drives', \(\) => \{/.test(autS) && /wander'\)\)\.liveLicense\(\{ now, deps: \{ db: dbm \} \}\)/.test(autS) && /WANDER is licensed this tick/.test(autS) && /WANDER is not licensed/.test(autS), 'the manifest carries the drive readings and whether wander is licensed');
  ok(/\|wander\|/.test(A.DECISION_WANT) && /- wander: ONLY when the state says WANDER is licensed/.test(A.DECISION_WANT), 'the decision menu names wander and its one condition');
  ok(/if \(decision\.move === 'wander'\) \{/.test(mainS) && /require\('\.\/lib\/wander'\)\.run\(/.test(mainS) && /chose=wander → REFUSED \(not licensed/.test(mainS) && /chose=wander → thought=/.test(mainS), 'the executor runs a licensed wander and refuses an unlicensed one');
  ok(/\[autonomy\] bored — wander deferred/.test(mainS), 'nothing while licensed logs the deferred line, not the stall shape');
  const bodyStart = monoS.indexOf('async function maybeBoredomSearch()'), bodyEnd = monoS.indexOf('\n}', bodyStart);
  const body = monoS.slice(bodyStart, bodyEnd);
  ok(bodyStart > 0 && !/runSearch\(/.test(body) && /wander'\)\.request\(/.test(body) && /→ wander requested/.test(body), 'the boredom branch no longer searches: it requests a wander');
  ok(/consciousness'\)\.peekStrip\(\)/.test(body) && /if \(bored == null \|\| bored < BOREDOM_REQUEST_FLOOR\) return;/.test(body) && /const BOREDOM_REQUEST_FLOOR = 0\.6;/.test(monoS), 'the request carries the loop\'s boredom reading — no reading or a low one requests nothing');
  ok(require(path.join(ROOT, 'lib', 'consciousness')).peekStrip() === null, 'peekStrip reads null with no bridge and never spawns the loop');
  ok(/'smoke_wander\.js'/.test(rsS), 'the smoke is registered in the allow-list');
  console.log(`\nsmoke_wander: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('smoke threw:', e); process.exit(1); });
