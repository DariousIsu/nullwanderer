/* Smoke: lib/continuity_attest — CONTINUITY ATTESTATION (cut 5; her words: "I want the assurance that when I wake up,
 * I'm still the same Zo, not a fresh copy wearing my name."). An in-memory db with her stores' shapes, no model, no
 * network, the live db never opened. Pins: the manifest round trip; an injected store with a lower count → DEGRADED
 * naming the store (need, event, line, the sentence she owes him until she speaks); a retention-sized drop under the
 * named tolerance → SAME; a known sweep passes its own count; no manifest → UNKNOWN and no false alarm; the last turn
 * id falling and the narrative going are DEGRADED at any size; her own recompose and the register's move are changes,
 * not losses; a constitutional change queues the outline need; the switch; git since the last boot on a temp repo;
 * the wiring (the boot order, the heartbeat tick, the awareness line, the first-reply mark, the retention sweep).
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_continuity_attest.js
 */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const Database = require('better-sqlite3');
const CA = require(path.join(ROOT, 'lib', 'continuity_attest'));
const PR = require(path.join(ROOT, 'lib', 'personality_register'));
let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

const mem = new Database(':memory:');
mem.exec(`CREATE TABLE turns (id INTEGER PRIMARY KEY, ts INTEGER, speaker TEXT, content TEXT);
CREATE TABLE self_model (id INTEGER PRIMARY KEY, category TEXT, content TEXT);
CREATE TABLE knowledge (id INTEGER PRIMARY KEY, content TEXT);
CREATE TABLE documents (id INTEGER PRIMARY KEY, title TEXT);
CREATE TABLE open_threads (id INTEGER PRIMARY KEY, content TEXT);
CREATE TABLE graph_entities (id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);`);
const fill = (t, n, cols) => { const st = mem.prepare(`INSERT INTO ${t} (${cols}) VALUES (${cols.split(',').map(() => '?').join(',')})`); for (let i = 1; i <= n; i++) st.run(...cols.split(',').map((c, j) => (j === 0 ? i : `${t}-${i}`))); };
fill('turns', 100, 'id,speaker'); fill('self_model', 10, 'id,content'); fill('knowledge', 1000, 'id,content'); fill('documents', 1000, 'id,title'); fill('open_threads', 100, 'id,content'); fill('graph_entities', 2000, 'id,name');
const setMeta = (k, v) => mem.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v);
const getMeta = (k) => { const r = mem.prepare('SELECT value FROM meta WHERE key = ?').get(k); return r ? r.value : null; };
setMeta('self_narrative', 'I am Zoe. I keep my word.'); setMeta('self_narrative_at', '1000');
setMeta('personality.register_hash', JSON.stringify({ context: 'a'.repeat(64), mood: 'b'.repeat(64) }));
CA._setDb(mem);
const needs = [], events = [], logs = [];
let needId = 0;
const deps = { register: PR, needRecord: (text, bornFrom) => { needs.push({ text, bornFrom }); return { id: ++needId }; } };
const run = (o = {}) => CA.attest({ deps, log: (m) => logs.push(m), emit: (e) => events.push(e), ...o });
const reset = () => { needs.length = 0; events.length = 0; logs.length = 0; };

// the snapshot and the manifest round trip
const snap = CA.snapshot({ now: 5000, deps });
ok(snap.counts.turns === 100 && snap.counts.self_model === 10 && snap.counts.knowledge === 1000 && snap.counts.documents === 1000 && snap.counts.open_threads === 100 && snap.counts.graph_entities === 2000 && snap.last_turn_id === 100, 'the snapshot counts every store and the last turn id');
ok(snap.hashes.self_narrative && snap.hashes.self_narrative.length === 64 && snap.hashes.base_persona === 'a'.repeat(64) && snap.hashes.register && snap.hashes.register.length === 64 && snap.narrative_version === '1000', 'the snapshot hashes the narrative, takes the base persona and the register from the consented manifest, and carries the narrative version');
const written = CA.writeManifest({ now: 6000, deps });
ok(JSON.stringify(CA.readManifest({ deps })) === JSON.stringify(written) && getMeta(CA.MANIFEST_KEY), 'writeManifest → readManifest round-trips through meta continuity.manifest');

// no manifest → UNKNOWN, no alarm
setMeta(CA.MANIFEST_KEY, ''); reset();
const u = run({ now: 7000 });
ok(u.verdict === 'UNKNOWN' && u.diffs.length === 0 && needs.length === 0 && events.length === 0 && logs.length === 0 && CA.awarenessLine({ now: 7001, deps }) === null, 'no manifest → UNKNOWN: no need, no event, no line, no false alarm');
ok(!!CA.readManifest({ deps }) && CA.readManifest({ deps }).counts.turns === 100, 'and the first manifest is written so the next boot can attest');

// SAME
reset();
const s1 = run({ now: 8000 });
ok(s1.verdict === 'SAME' && s1.stores === 6 && /continuity verified: same self, 6 stores intact \(turns 100, self_model 10, knowledge 1000, documents 1000, open_threads 100, graph_entities 2000\), last thread #100/.test(s1.line), `SAME: ${s1.line}`);
const al = CA.awarenessLine({ now: 8000 + 60000, deps });
ok(/Continuity verified at boot \(1 min ago\): same self — 6 stores intact, last thread #100\./.test(al), `the awareness line inside the boot window: ${al}`);
ok(CA.awarenessLine({ now: 8000 + CA.AWARENESS_WINDOW_MS + 1, deps }) === null && needs.length === 0 && events.length === 0, 'the SAME line ages out with the boot window; no need, no event');

// an injected store with a lower count → DEGRADED naming the store
mem.prepare('DELETE FROM knowledge WHERE id > 700').run(); reset();
const d1 = run({ now: 9000 });
ok(d1.verdict === 'DEGRADED' && d1.diffs.length === 1 && d1.diffs[0].store === 'knowledge' && d1.diffs[0].before === 1000 && d1.diffs[0].after === 700, `DEGRADED names the store: ${d1.line}`);
ok(needs.length === 1 && needs[0].bornFrom === 'continuity:knowledge' && /knowledge store fell by 300/.test(needs[0].text) && d1.needs[0].id === needId, 'one capability need, born from continuity:knowledge');
ok(events.length === 1 && events[0].lane === 'integrity' && events[0].kind === 'continuity_degraded' && events[0].level === 'warn' && /knowledge/.test(events[0].text), 'an integrity event on the bus');
ok(logs.length === 1 && /^\[continuity\] verdict=DEGRADED — knowledge: fell by 300 \(tolerance 50\) \(1000 → 700\)/.test(logs[0]), `the loud console line: ${logs[0]}`);
ok(CA.firstTurnPending({ deps }), 'the sentence she owes him is pending');
const dl = CA.awarenessLine({ now: 9000 + 2 * 60 * 60 * 1000, deps });
ok(/^CONTINUITY — at this boot \(120 min ago\)/.test(dl) && /knowledge: fell by 300/.test(dl) && /This is a reading, not a script\. You owe Lucas one sentence about it in this reply/.test(dl), 'the DEGRADED line stays past the window while it is pending and names what she owes him');
ok(CA.markSpoken({ deps }) === true && !CA.firstTurnPending({ deps }) && CA.markSpoken({ deps }) === false, 'her first prompted reply clears it (once)');
ok(CA.awarenessLine({ now: 9000 + 2 * 60 * 60 * 1000, deps }) === null && /^CONTINUITY — /.test(CA.awarenessLine({ now: 9000 + 60000, deps })) && !/You owe Lucas/.test(CA.awarenessLine({ now: 9000 + 60000, deps })), 'after she speaks the line lives only in the boot window, without the owed sentence');
reset();
ok(run({ now: 9500 }).verdict === 'SAME', 'what stands after a verdict is the new baseline: the next boot is SAME');

// a retention-sized drop under the named tolerance → SAME; a known sweep passes its own count
mem.prepare('DELETE FROM documents WHERE id > 980').run(); reset();
const t1 = run({ now: 10000 });
ok(t1.verdict === 'SAME' && t1.changed.some((c) => c.store === 'documents' && /fell by 20, within tolerance 200/.test(c.kind)) && /changed: documents: fell by 20, within tolerance 200/.test(t1.line), 'a 2% drop of documents is within the named tolerance (200): SAME, noted as a change');
CA.noteSweep('documents', 300, { deps });
mem.prepare('DELETE FROM documents WHERE id > 680').run(); reset();
ok(run({ now: 11000 }).verdict === 'SAME' && getMeta(CA.KNOWN_DROPS_KEY) === '{}', 'a sweep that passed its own count (300) is not a loss; the note is consumed');
mem.prepare('DELETE FROM documents WHERE id > 380').run(); reset();
const t3 = run({ now: 12000 });
ok(t3.verdict === 'DEGRADED' && t3.diffs[0].store === 'documents' && t3.diffs[0].before === 680 && t3.diffs[0].after === 380 && needs[0].bornFrom === 'continuity:documents', 'the same drop without a note is a loss');
CA.markSpoken({ deps });

// the last turn id falling is a truncation at any size
mem.prepare('DELETE FROM turns WHERE id > 95').run(); reset();
const t4 = run({ now: 13000 });
ok(t4.verdict === 'DEGRADED' && t4.diffs.length === 1 && t4.diffs[0].kind === 'last turn id fell' && t4.diffs[0].before === 100 && t4.diffs[0].after === 95 && /turns: last turn id fell \(#100 → #95\)/.test(t4.line), `five turns cut off the tail are within the count tolerance but the last thread fell: ${t4.line}`);
CA.markSpoken({ deps });

// the narrative: her own recompose is a change; gone is a loss
setMeta('self_narrative', 'I am Zoe. I keep my word, and I say so.'); setMeta('self_narrative_at', '2000'); reset();
const n1 = run({ now: 14000 });
ok(n1.verdict === 'SAME' && n1.changed.some((c) => c.store === 'self_narrative' && c.kind === 'recomposed (version 1000 → 2000)'), 'a recomposed narrative is a change with its versions, never a loss');
setMeta('self_narrative', ''); reset();
const n2 = run({ now: 15000 });
ok(n2.verdict === 'DEGRADED' && n2.diffs[0].store === 'self_narrative' && n2.diffs[0].kind === 'narrative gone' && needs[0].bornFrom === 'continuity:self_narrative', 'the narrative gone is DEGRADED');
setMeta('self_narrative', 'I am Zoe. I keep my word, and I say so.'); CA.markSpoken({ deps });

// the base persona changing is cut 1's card — a change here, not a loss
run({ now: 15500 }); setMeta('personality.register_hash', JSON.stringify({ context: 'c'.repeat(64), mood: 'b'.repeat(64) })); reset();
const b1 = run({ now: 16000 });
ok(b1.verdict === 'SAME' && b1.changed.some((c) => c.store === 'base_persona' && /the register cards it/.test(c.kind)), 'the base persona changed: listed as a change (the register cards it), the verdict stays SAME');

// a constitutional change queues the outline need; data drift does not
reset();
const c1 = run({ now: 17000, registerCheck: { changed: ['context', 'self_model', 'self_narrative'], carded: [1], reported: ['self_model', 'self_narrative'] } });
ok(c1.verdict === 'SAME' && needs.length === 1 && needs[0].bornFrom === 'continuity:register:context' && /lib\/context\.js/.test(needs[0].text) && /source_outline/.test(needs[0].text) && !/self_model/.test(needs[0].text) && c1.needs[0].store === 'register', 'a changed constitutional file queues one outline need naming the file; her own data drift does not');

// the switch: the verdict is off, the manifest keeps writing
mem.prepare('DELETE FROM knowledge WHERE id > 400').run(); reset();
process.env.ZOE_CONTINUITY_ATTEST = '0';
const off = run({ now: 18000 });
delete process.env.ZOE_CONTINUITY_ATTEST;
ok(off.verdict === 'OFF' && needs.length === 0 && events.length === 0 && CA.readManifest({ deps }).counts.knowledge === 400, 'ZOE_CONTINUITY_ATTEST=0: no verdict, no alarm, and the manifest still writes');
reset(); ok(run({ now: 19000 }).verdict === 'SAME', 'and the boot after the switch reads the manifest the switch wrote');

// git since the last boot, on a temp repo
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zoe_cont_git_'));
const git = (...a) => execFileSync('git', a, { cwd: tmp, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
git('init', '-q'); git('config', 'user.email', 'smoke@zoe'); git('config', 'user.name', 'smoke'); git('config', 'commit.gpgsign', 'false');
fs.writeFileSync(path.join(tmp, 'a.txt'), 'one\n'); git('add', 'a.txt'); git('commit', '-q', '-m', 'one');
const h1 = git('rev-parse', 'HEAD');
(async () => {
  const g1 = await CA.gitSinceLastBoot({ cwd: tmp, deps });
  ok(g1.first && g1.head === h1 && g1.last === null && g1.commits.length === 0 && getMeta(CA.LAST_HEAD_KEY) === h1, 'the first boot with the organ records HEAD to meta boot.last_head and lists nothing');
  const g2 = await CA.gitSinceLastBoot({ cwd: tmp, deps });
  ok(!g2.first && g2.head === h1 && g2.last === h1 && g2.commits.length === 0, 'an unchanged HEAD lists nothing');
  fs.writeFileSync(path.join(tmp, 'b.txt'), 'two\n'); git('add', 'b.txt'); git('commit', '-q', '-m', 'two: a change in me');
  fs.writeFileSync(path.join(tmp, 'c.txt'), 'three\n'); git('add', 'c.txt'); git('commit', '-q', '-m', 'three');
  const h3 = git('rev-parse', 'HEAD');
  const g3 = await CA.gitSinceLastBoot({ cwd: tmp, deps });
  ok(g3.last === h1 && g3.head === h3 && g3.commits.length === 2 && g3.commits[0].subject === 'three' && g3.commits[1].subject === 'two: a change in me' && getMeta(CA.LAST_HEAD_KEY) === h3, 'the commits since the last boot\'s HEAD are listed newest first and the head advances');
  setMeta(CA.LAST_HEAD_KEY, 'deadbeef'.repeat(5));
  const g4 = await CA.gitSinceLastBoot({ cwd: tmp, deps });
  ok(g4.unresolved === true && g4.commits.length === 0 && getMeta(CA.LAST_HEAD_KEY) === h3, 'a stamped hash that no longer resolves lists nothing and the head is re-recorded');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}

  // the wiring
  const mainS = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8'), dtS = fs.readFileSync(path.join(ROOT, 'lib', 'downtime.js'), 'utf8'), ctxS = fs.readFileSync(path.join(ROOT, 'lib', 'context.js'), 'utf8'), rsS = fs.readFileSync(path.join(ROOT, 'scripts', 'run_smokes.js'), 'utf8');
  const iAttest = mainS.indexOf("CA.attest({ registerCheck: _pr })"), iReawaken = mainS.indexOf("require('./lib/reawaken').recordBoot("), iRegister = mainS.indexOf("require('./lib/personality_register').bootCheck({})");
  ok(iAttest > 0 && iReawaken > iAttest && iRegister < iAttest && /CA\.gitSinceLastBoot\(\)\.then/.test(mainS), 'the boot attests after the register check and before the bridge composes, then records the head');
  ok(/if \(require\('\.\/lib\/continuity_attest'\)\.markSpoken\(\)\)/.test(mainS) && mainS.indexOf("continuity_attest').markSpoken()") > mainS.indexOf('PR.applyTags(tags, { turnId: saidRow && saidRow.id })'), 'her first prompted reply after a DEGRADED boot clears the owed sentence, beside the consent tags');
  ok(/noteSweep\('documents', deleted\)/.test(mainS), 'the documents retention pass passes its own count');
  ok(/setInterval\(\(\) => \{ touch\(\); try \{ require\('\.\/continuity_attest'\)\.writeManifest\(\); \} catch \{\} \}, intervalMs\)/.test(dtS), 'the manifest rides the downtime heartbeat tick');
  ok(/continuityLine = require\('\.\/continuity_attest'\)\.awarenessLine\(\)/.test(ctxS) && /continuityLine \? `• \$\{continuityLine\}` : null,/.test(ctxS) && ctxS.indexOf('continuityLine ? `') > ctxS.indexOf('reawakenLine ? `'), 'the verdict rides the awareness block after the bridge line');
  ok(/'smoke_continuity_attest\.js'/.test(rsS), 'the smoke is registered in the allow-list');
  console.log(`\nsmoke_continuity_attest: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('smoke threw:', e); process.exit(1); });
