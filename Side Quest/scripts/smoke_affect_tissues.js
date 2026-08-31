/* Smoke: the AFFECT TISSUES (B2/B3 — docs/AFFECT_SUBSTRATE_RESEARCH_2026-08-31.md) + the driver.
 * Hermetic: builds a FIXTURE sq.db and a FIXTURE weights db in tmp (no dependency on the ignored
 * data/lexicons — the suite runs on any checkout), spawns the real python tissues against them, and
 * proves: appraisal-with-reasons (win→joy, his words→warmth, intake→interest), FAtiMA decay, the
 * WASABI mood coupling, per-subject impressions (valence/attachment/wonder + mandatory reasons),
 * WORD-BOUNDARY subject matching (the single-token disease), REPLAY DETERMINISM (identical inputs →
 * identical manifest bytes), and THE READ-ONLY RAIL (the fixture db's bytes are untouched by a
 * full tissue pass). Wiring pins hold the tick hook + the driver's layering contract.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_affect_tissues.js
 */
'use strict';
const os = require('os'), path = require('path'), fs = require('fs');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

const ROOT = path.join(__dirname, '..');
const PY = process.env.ECHO_PYTHON || 'python';
const T = 1788200000000;                       // fixed epoch — determinism demands no wall clock
const H = 3600e3;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sq_tissue_'));
const dbPath = path.join(tmp, 'sq.db');
const wPath = path.join(tmp, 'weights.db');
const dirA = path.join(tmp, 'a'), dirB = path.join(tmp, 'b');

// ── fixture sq.db (only the tables/columns the tissues read) ────────────────────────────────────
{
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE obs_events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, lane TEXT, kind TEXT, level TEXT, text TEXT, ref TEXT, data TEXT);
    CREATE TABLE turns (id INTEGER PRIMARY KEY, session_id INTEGER, ts INTEGER, speaker TEXT, content TEXT);
    CREATE TABLE monologue (id INTEGER PRIMARY KEY, ts INTEGER, content TEXT, type TEXT, query TEXT);
    CREATE TABLE owner_world (coord TEXT PRIMARY KEY, type TEXT, namespace TEXT, name TEXT, aliases TEXT, summary TEXT, attrs TEXT, source TEXT, created_ts INTEGER, updated_ts INTEGER);`);
  db.prepare("INSERT INTO obs_events (ts,lane,kind,level,text,ref) VALUES (?,?,?,?,?,?)")
    .run(T - 10 * 60e3, 'pursuit', 'win', 'info', 'resolved: paid-by-road-delivery donor-brief', 'rq:42');
  db.prepare("INSERT INTO obs_events (ts,lane,kind,level,text,ref) VALUES (?,?,?,?,?,?)")
    .run(T - 9 * 60e3, 'machine', 'anomaly', 'warn', 'disk headroom low', 'disk');
  const turn = db.prepare("INSERT INTO turns (id,session_id,ts,speaker,content) VALUES (?,1,?,?,?)");
  turn.run(101, T - 30 * 60e3, 'user', 'This is wonderful work, I love the great progress here');
  turn.run(102, T - 20 * 60e3, 'user', 'Alice was amazing and wonderful at cheer practice today');
  turn.run(103, T - 15 * 60e3, 'ai_said', 'Alicia Vermont filed the county report; nothing else moved');
  const mono = db.prepare("INSERT INTO monologue (id,ts,content,type) VALUES (?,?,?,'reading')");
  mono.run(1, T - 50 * 60e3, 'a wonderful great development in the field');
  mono.run(2, T - 40 * 60e3, 'this progress is amazing and wonderful to see');
  mono.run(3, T - 35 * 60e3, 'great wonderful strides reported again');
  db.prepare("INSERT INTO owner_world (coord,type,namespace,name,aliases,summary) VALUES (?,?,?,?,?,?)")
    .run('person:owner/alice', 'person', 'owner', 'Alice', '[]', 'The daughter, 12, cheer.');
  db.prepare("INSERT INTO owner_world (coord,type,namespace,name,aliases,summary) VALUES (?,?,?,?,?,?)")
    .run('pet:owner/rex', 'pet', 'owner', 'Rex', '[]', 'The good dog.');
  db.prepare("INSERT INTO turns (id,session_id,ts,speaker,content) VALUES (104,1,?, 'user', 'Rex came along to the park')").run(T - 12 * 60e3);
  db.close();
}
// ── fixture weights db (a dozen VAD terms is a lexicon in miniature) ────────────────────────────
{
  const w = new Database(wPath);
  w.exec('CREATE TABLE vad (term TEXT PRIMARY KEY, v REAL, a REAL, d REAL); CREATE TABLE emolex (term TEXT, emotion TEXT, PRIMARY KEY(term,emotion)); CREATE TABLE epa (kind TEXT, term TEXT, e REAL, p REAL, a REAL, PRIMARY KEY(kind,term)); CREATE TABLE act_eqn (eqn_set TEXT, eqn_type TEXT, gender TEXT, z TEXT, c TEXT); CREATE TABLE warriner (term TEXT PRIMARY KEY, v REAL, a REAL, d REAL, v_sd REAL, a_sd REAL, d_sd REAL);');
  const ins = w.prepare('INSERT INTO vad VALUES (?,?,?,?)');
  for (const [t2, v, a, d] of [
    ['wonderful', 0.8, 0.4, 0.5], ['love', 0.9, 0.5, 0.5], ['great', 0.7, 0.3, 0.5],
    ['amazing', 0.85, 0.5, 0.5], ['progress', 0.5, 0.2, 0.4], ['work', 0.2, 0.1, 0.3],
    ['terrible', -0.8, 0.5, -0.4], ['awful', -0.85, 0.5, -0.4], ['report', 0.0, 0.0, 0.0],
    ['county', 0.0, 0.0, 0.0], ['development', 0.3, 0.1, 0.2], ['strides', 0.4, 0.2, 0.3],
  ]) ins.run(t2, v, a, d);
  // ACT fixture — HAND-COMPUTABLE equation set (both genders identical): tau_k = 0.5·f_k + 0.1,
  // so every act_core result below is verifiable on paper. Emotion table: T = 0.1 + 0.5·M.
  const eq = w.prepare('INSERT INTO act_eqn VALUES (?,?,?,?,?)');
  for (const g of ['f', 'm']) {
    eq.run('us2010', 'impressionabo', g, 'Z000000000', Array(9).fill('0.1').join(' '));
    for (let k = 0; k < 9; k++) {
      const sel = 'Z' + '0'.repeat(k) + '1' + '0'.repeat(8 - k);
      const row = Array(9).fill('0'); row[k] = '0.5';
      eq.run('us2010', 'impressionabo', g, sel, row.join(' '));
    }
    eq.run('us2010', 'emotionid', g, 'Z000000', '0.1 0.1 0.1');
    for (let k = 0; k < 3; k++) {
      const sel = 'Z' + '0'.repeat(k) + '1' + '0'.repeat(5 - k);
      const row = ['0', '0', '0']; row[k] = '0.5';
      eq.run('us2010', 'emotionid', g, sel, row.join(' '));
    }
  }
  const epaIns = w.prepare('INSERT INTO epa VALUES (?,?,?,?,?)');
  epaIns.run('identity', 'friend', 2.0, 1.0, 0.5);
  epaIns.run('identity', 'stranger', 0.0, 0.0, 0.0);
  epaIns.run('identity', 'daughter', 2.4, 0.8, 1.2);
  epaIns.run('behavior', 'greet', 1.5, 0.5, 0.5);
  epaIns.run('modifier', 'calm', 0.2, 0.2, 0.2);
  epaIns.run('modifier', 'tense', -1.0, 0.5, 1.5);
  w.close();
}

const hash = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const run = (script, stateDir, now) => spawnSync(PY, [path.join(ROOT, 'tissues', script), '--db', dbPath, '--weights', wPath, '--state-dir', stateDir, '--now', String(now)], { encoding: 'utf8', timeout: 60000 });
const dbHashBefore = hash(dbPath);

// ── appraisal tissue: appraise → instances with reasons → mood ─────────────────────────────────
const r1 = run('tissue_appraisal.py', dirA, T);
ok(r1.status === 0, `appraisal: exits 0 (${(r1.stderr || '').trim().slice(0, 120) || 'clean'})`);
const manA = JSON.parse(fs.readFileSync(path.join(dirA, 'manifest_appraisal.json'), 'utf8'));
const names = manA.emotions.map((e) => e.name);
ok(names.includes('joy'), `appraisal: the pursuit win minted JOY (${names.join(',')})`);
ok(names.includes('distress'), 'appraisal: machine stress minted DISTRESS');
ok(names.includes('warmth'), 'appraisal: his positive words minted WARMTH (the affiliation signal, lexicon-read)');
ok(names.includes('interest'), 'appraisal: positive intake tone minted INTEREST');
ok(manA.emotions.every((e) => e.reason && e.reason.length > 10), '⭐ appraisal: EVERY instance carries a reason (the manifest law)');
const joy = manA.emotions.find((e) => e.name === 'joy');
ok(/paid-by-road-delivery/.test(joy.reason), 'appraisal: the joy reason names the actual win');
const warmth = manA.emotions.find((e) => e.name === 'warmth');
ok(/turn#101/.test(warmth.reason) && /lexicon hits/.test(warmth.reason), 'appraisal: the warmth reason cites the turn + the words that carried it');
ok(manA.mood.x > 0 && ['warm', 'bright', 'even'].includes(manA.mood.band), `appraisal: net-positive impulses lift the mood point (x=${manA.mood.x}, band=${manA.mood.band})`);
ok(manA.mood.x < 0.95, `⭐ appraisal: a heavy pass reads ELEVATED, never pinned at the rail (x=${manA.mood.x} — the v2 saturation lesson, squashed on day one)`);
ok(/translates, never invents/.test(manA.law), 'appraisal: the division-of-labor law rides the manifest');

// ── replay determinism: fresh state dir, same inputs, same now → identical bytes ────────────────
run('tissue_appraisal.py', dirB, T);
ok(fs.readFileSync(path.join(dirA, 'manifest_appraisal.json'), 'utf8') === fs.readFileSync(path.join(dirB, 'manifest_appraisal.json'), 'utf8'),
  '⭐ REPLAY DETERMINISM: identical inputs → identical appraisal manifest, byte for byte');

// ── decay: re-run dir A 3h later with no new events → intensities fade, nothing re-minted ──────
const r3 = run('tissue_appraisal.py', dirA, T + 3 * H);
ok(r3.status === 0, 'appraisal decay pass: exits 0');
const manA2 = JSON.parse(fs.readFileSync(path.join(dirA, 'manifest_appraisal.json'), 'utf8'));
const joy2 = manA2.emotions.find((e) => e.name === 'joy');
ok(manA2.fresh_appraisals === 0, 'decay pass: cursors held — no event appraised twice (the corpse-reuse rail)');
ok(!joy2 || joy2.intensity < joy.intensity, `decay pass: joy faded (${joy.intensity} → ${joy2 ? joy2.intensity : 'pruned'}) — FAtiMA half-life`);
ok(Math.abs(manA2.mood.y) <= Math.abs(manA.mood.y) + 0.001 || manA2.mood.x < manA.mood.x, 'decay pass: the mood point relaxes toward home, never lurches');

// ── impression tissue: per-subject feeling with reasons ─────────────────────────────────────────
const r4 = run('tissue_impression.py', dirA, T);
ok(r4.status === 0, `impression: exits 0 (${(r4.stderr || '').trim().slice(0, 120) || 'clean'})`);
const manI = JSON.parse(fs.readFileSync(path.join(dirA, 'manifest_impressions.json'), 'utf8'));
const alice = manI.subjects.find((s) => s.coord === 'person:owner/alice');
ok(!!alice, 'impression: Alice (owner world) got an impression');
ok(alice.encounters === 1, `⭐ impression: WORD-BOUNDARY matching — "Alicia Vermont" never counts as an Alice encounter (${alice.encounters} encounter)`);
ok(alice.valence > 0.3, `impression: the cheer-practice praise reads warm (valence ${alice.valence})`);
ok(alice.attachment > 0, `impression: attachment grows from real contact × owner orbit (${alice.attachment})`);
ok(alice.wonder > 0.4, `impression: a thin summary + fresh contact itches to be researched (wonder ${alice.wonder})`);
ok(alice.reasons.length >= 2 && /turn ids 102/.test(alice.reasons[0]) && /tone carried by/.test(alice.reasons[1]),
  '⭐ impression: reasons are MANDATORY and name the encounters + the words');
// B5-lite (09-01, built during the hold): the EPA fundamental from her own world-summary's identity word
ok(alice.epa && alice.epa.word === 'daughter' && alice.epa.e === 2.4, `⭐ B5-lite: Alice carries her EPA fundamental via the identity word 'daughter' (e=${alice.epa && alice.epa.e})`);
ok(alice.reasons.some((r) => /identity 'daughter'/.test(r)), 'B5-lite: the EPA carries its reason (the word and the dictionary)');
const rex = manI.subjects.find((s) => s.coord === 'pet:owner/rex');
ok(!!rex && rex.epa === null, 'B5-lite: no identity word in the dictionary → epa null, honestly absent (never guessed)');
ok(rex.valence === 0 && /valence rests at 0 honestly/.test(rex.reasons[1]), 'impression: a lexicon-silent encounter leaves valence at 0 with the honest reason');
const r5 = run('tissue_impression.py', dirB, T);
ok(r5.status === 0 && fs.readFileSync(path.join(dirA, 'manifest_impressions.json'), 'utf8') === fs.readFileSync(path.join(dirB, 'manifest_impressions.json'), 'utf8'),
  '⭐ REPLAY DETERMINISM: impression manifest identical byte for byte');

// ── THE READ-ONLY RAIL: five tissue passes later, the live db's bytes are untouched ────────────
ok(hash(dbPath) === dbHashBefore, '⭐ THE RO RAIL: the fixture sq.db is byte-identical after every pass (tissues cannot write a live db)');

// ── wiring pins: the tick hook + the driver's layering contract ─────────────────────────────────
{
  const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  ok(/affect_tissues'\)\.maybeRun\(\{ deps: \{ lastUserTurnTs \} \}\)/.test(mainSrc), '⭐ wiring: the tissue driver rides the existing 10-min tick (no new timer)');
  const drv = fs.readFileSync(path.join(ROOT, 'lib', 'affect_tissues.js'), 'utf8');
  ok(/PRIORITY_BELOW_NORMAL/.test(drv), 'driver: children run below-normal priority (lose every scheduling fight)');
  ok(/KILL_KEY = 'swarm\.tissues'/.test(drv), 'driver: one kill switch (swarm.tissues=off)');
  ok(/for \(const t of TISSUES\)/.test(drv) && /await _runOne/.test(drv), 'driver: sequential by contract — one tissue at a time');
  ok(/RUN_TIMEOUT_MS = 60/.test(drv) && /child\.kill\(\)/.test(drv), 'driver: hard timeout, killed on breach');
  ok(/IDLE_FLOOR_MS = 5 \* 60/.test(drv), 'driver: idle-gated — never during his conversation');
  const app = fs.readFileSync(path.join(ROOT, 'tissues', 'tissue_appraisal.py'), 'utf8');
  const common = fs.readFileSync(path.join(ROOT, 'tissues', 'affect_common.py'), 'utf8');
  ok(/mode=ro/.test(common), 'tissues: every db open is mode=ro (analysis_lane posture)');
  ok(!/import (requests|ollama|openai|torch)/.test(app), 'tissues: zero model calls, zero network — float arithmetic only');
  // First-live-run cures (2026-08-31, caught by the liveproof — the first pass appraised his
  // turns #7-#23, years-old fossils, and its warmth reasons led with "have/get/sure/on"):
  ok(/seed_cursor\(db, "turns", since_id, MAX_TURNS\)/.test(app) && /observes from the tail/.test(app),
    '⭐ birth-cursor rule: a newborn tissue reads the TAIL of each table, never row 1 (no fossil appraisal, no history crawl)');
  ok(/POLAR_FLOOR = 0\.2/.test(common) && /abs\(v\) >= \{POLAR_FLOOR\}/.test(common),
    '⭐ polar filter: near-neutral function words never contribute to a reading (NRC PolarSubset practice)');
}
// polar filter behavior: a text of only mild/neutral words yields NO reading (fail-absent), so
// "county report filed" can never mint an emotion instance.
{
  const w2 = new Database(wPath, { readonly: true });
  const mild = w2.prepare("SELECT COUNT(*) c FROM vad WHERE term IN ('report','county') AND abs(v) >= 0.2").get().c;
  w2.close();
  ok(mild === 0, 'polar filter: the neutral fixture words sit below the floor (the reading correctly refuses)');
}

// ── B4: manifestLine — the ONE consumer door (mood's measured block), fail-absent ───────────────
{
  const at = require(path.join(ROOT, 'lib', 'affect_tissues.js'));
  const line = at.manifestLine({ nowMs: T + 10 * 60e3, stateDir: dirB });
  ok(!!line && /felt now:/.test(line) && /warmth/.test(line) && /interest/.test(line), `B4 manifestLine: renders the top named feelings with reasons (${String(line).slice(0, 80)}…)`);
  ok(/closest subject: Alice/.test(line) && /attachment/.test(line), 'B4 manifestLine: the top impression rides with its numbers');
  ok(/by the affect tissues/.test(line), 'B4 manifestLine: provenance-stamped (a reading, with its instrument and age)');
  ok(at.manifestLine({ nowMs: T + 2 * H, stateDir: dirB }) === null, 'B4 FAIL-ABSENT: stale manifests (>45m) → null (the mood prompt is byte-identical)');
  ok(at.manifestLine({ nowMs: T, stateDir: tmp }) === null, 'B4 FAIL-ABSENT: no manifests at all → null');
  const moodSrc = fs.readFileSync(path.join(ROOT, 'lib', 'mood.js'), 'utf8');
  ok(/affect_tissues'\)\.manifestLine/.test(moodSrc) && /tissueLine = undefined/.test(moodSrc) && /_measured/.test(moodSrc),
    '⭐ B4 wiring: mood.compose consults the manifest line beside the vector line, injectable + fail-absent');
}

// ── THE ACT CORE (tissues/act_core.py) — hand-computable fixture: tau_k = 0.5·f_k + 0.1 ────────
{
  const py = `
import json, sys; sys.path.insert(0, r'${path.join(ROOT, 'tissues').replace(/\\/g, '\\\\')}')
from act_core import ActCore
c = ActCore(r'${wPath.replace(/\\/g, '\\\\')}')
ev = c.event('friend', 'greet', 'stranger')
ob = c.optimal_behavior([2.0, 1.0, 0.5], [0.0, 0.0, 0.0])
em = c.emotion([2.0, 1.0, 0.5], [0.6, 0.6, 0.6])
ew = c.emotion_word([2.0, 1.0, 0.5], [0.6, 0.6, 0.6])
nr = c.nearest('modifier', [-1.0, 0.5, 1.5])
print(json.dumps({'ev': ev, 'ob': ob, 'em': em, 'ew': ew, 'nr': nr}))
c.close()`;
  const r = spawnSync(PY, ['-c', py], { encoding: 'utf8', timeout: 30000 });
  ok(r.status === 0, `act_core: runs against the fixture weights (${(r.stderr || '').trim().slice(0, 100) || 'clean'})`);
  const a = JSON.parse(r.stdout || '{}');
  const near = (x, want, eps = 1e-6) => Math.abs(x - want) < eps;
  ok(a.ev && a.ev.ok && near(a.ev.tau[0], 1.1) && near(a.ev.tau[3], 0.85) && near(a.ev.tau[8], 0.1),
    '⭐ act_core: impression formation matches the hand computation (tau = 0.5·f + 0.1, all 9 slots)');
  ok(near(a.ev.deflection, 1.49, 0.005), `act_core: deflection = Σ(f−tau)² = 1.49 on paper (${a.ev.deflection})`);
  ok(a.ev.per_slot && near(a.ev.per_slot.Ae, 0.81, 0.005) && near(a.ev.per_slot.Oe, 0.01, 0.005),
    'act_core: the per-slot breakdown carries the WHERE (the reasons field)');
  ok(/friend/.test(a.ev.reason) && /us2010/.test(a.ev.reason), 'act_core: the reason names the words and the equation set');
  ok(a.ob && a.ob.every((x) => near(x, 0.2, 1e-6)),
    `⭐ act_core: the deflection-minimizing behavior solves EXACTLY (B = [0.2,0.2,0.2] analytically; got ${JSON.stringify(a.ob.map((x) => +x.toFixed(4)))})`);
  ok(a.em && a.em.every((x) => near(x, 1.0, 1e-6)),
    '⭐ act_core: the emotion solve inverts the table exactly (T = 0.1 + 0.5·M → M = [1,1,1])');
  ok(a.ew && a.ew.word === 'calm', `act_core: the emotion labels via nearest modifier (${a.ew && a.ew.word})`);
  ok(a.nr && a.nr[0] === 'tense' && near(a.nr[1], 0), 'act_core: nearest() finds an exact dictionary hit at distance 0');
  const missing = spawnSync(PY, ['-c', py.replace("'friend', 'greet'", "'nobody', 'greet'")], { encoding: 'utf8', timeout: 30000 });
  ok(missing.status === 0 && /not in the dictionary: nobody/.test(missing.stdout),
    'act_core: an out-of-dictionary word refuses honestly (never guesses an EPA)');
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
