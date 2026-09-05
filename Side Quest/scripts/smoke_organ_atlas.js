/* Smoke: lib/organ_atlas — THE ORGAN ATLAS (cut 11; her words: "You can't meaningfully own something you can't see.").
 * A synthetic corpus in the self audit's shape + an in-memory table; then the REAL corpus, read-only. Pins: a file's row
 * (prefixes, switches, meta keys, lane, smoke, header, exports); the seed writes every lib organ; a re-seed marks a vanished
 * file stale (kept, reported as a finding) and never deletes; "which organ owns my mood" resolves to lib/mood.js with its
 * switch; the brief line; the rank boost for the source map; the organ-question detector; the real shelf: every lib file
 * with a [prefix] log line is covered; the wiring (the audit's pass seeds the atlas, the map ranks by organ, the self-
 * question carries the line, the hard-test kind exists, the smoke is registered).
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_organ_atlas.js
 */
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const Database = require('better-sqlite3');
const OA = require(path.join(ROOT, 'lib', 'organ_atlas'));
let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// ── a synthetic corpus ─────────────────────────────────────────────────────────────────────────────────────
const moodSrc = `/**\n * lib/mood.js — her mood dynamics: valence, arousal, the decay.\n */\nconst db = require('./db');\nfunction tick() { if (process.env.ZOE_MOOD_OFF === '1') return; db.setMeta('mood.current', '1'); console.log('[mood] tick'); }\nfunction current() { return db.getMeta('mood.current'); }\nmodule.exports = { tick, current };\n`;
const voiceSrc = `// lib/voice.js — her voice as a channel\nasync function speak(t) { const r = await require('./ollama').complete({ messages: [], lane: 'presence' }); console.warn('[voice] spoke'); return r; }\nmodule.exports = { speak };\n`;
const quietSrc = `// lib/quiet.js — an organ that logs nothing\nmodule.exports = { a: 1 };\n`;
const corpus = { files: { 'lib/mood.js': { text: moodSrc }, 'lib/voice.js': { text: voiceSrc }, 'lib/quiet.js': { text: quietSrc }, 'scripts/smoke_mood.js': { text: '// smoke' }, 'main.js': { text: '// main' } }, docsText: '' };
const rows = OA.scan({ corpus });
const mood = rows.find((r) => r.organ === 'mood');
ok(rows.length === 3 && rows.map((r) => r.organ).join(',') === 'mood,quiet,voice', 'scan covers every lib organ, sorted, and nothing else');
ok(mood && mood.file === 'lib/mood.js' && mood.log_prefix.join() === 'mood' && mood.kill_switch.join() === 'ZOE_MOOD_OFF' && mood.meta_keys.join() === 'mood.current' && mood.smoke === 'scripts/smoke_mood.js' && mood.owner_lane === 'main' && /her mood dynamics/.test(mood.header) && mood.exports.join() === 'tick,current', `a row carries the prefix, the switch, the meta key, the smoke, the lane, the header and the exports: ${JSON.stringify({ ...mood, header: undefined })}`);
const voice = rows.find((r) => r.organ === 'voice');
ok(voice.owner_lane === 'presence' && voice.log_prefix.join() === 'voice' && voice.smoke === null && voice.kill_switch.length === 0, 'a lane literal names the owner lane; no smoke, no switch reads as such');

// ── the table: seed, re-seed, stale ────────────────────────────────────────────────────────────────────────
const mem = new Database(':memory:');
OA._setDb(mem);
const s1 = OA.seed({ corpus, now: 1000 });
ok(s1.total === 3 && s1.changed === 3 && s1.stale.length === 0 && s1.findings.length === 0 && OA.rows().length === 3 && OA.get('mood').kill_switch.join() === 'ZOE_MOOD_OFF', 'the first seed writes every organ');
const s2 = OA.seed({ corpus, now: 2000 });
ok(s2.total === 3 && s2.changed === 0 && OA.get('mood').updated_ts === 1000 && OA.get('mood').seen_ts === 2000, 'an unchanged re-seed touches seen, never updated');
const corpus2 = { files: { ...corpus.files }, docsText: '' }; delete corpus2.files['lib/quiet.js'];
corpus2.files['lib/mood.js'] = { text: moodSrc.replace('ZOE_MOOD_OFF', 'ZOE_MOOD_DISABLED') };
const s3 = OA.seed({ corpus: corpus2, now: 3000 });
ok(s3.total === 2 && s3.changed === 1 && s3.stale.join() === 'quiet' && s3.findings.length === 1 && s3.findings[0].detector === 'stale-atlas-entry' && /lib\/quiet\.js/.test(s3.findings[0].text), 'a vanished file is marked stale and reported as a finding');
ok(OA.get('quiet') && OA.get('quiet').stale === true && OA.rows().length === 2 && OA.get('mood').kill_switch.join() === 'ZOE_MOOD_DISABLED' && OA.get('mood').updated_ts === 3000, 'the stale entry is kept, not deleted; a changed switch updates the row');

// ── the questions ──────────────────────────────────────────────────────────────────────────────────────────
const q = OA.lookup('which organ owns my mood?');
ok(q && q.organ === 'mood' && q.file === 'lib/mood.js' && q.kill_switch.join() === 'ZOE_MOOD_DISABLED' && q.why.some((w) => /its name is mood/.test(w)), `"which organ owns my mood" resolves to lib/mood.js and its switch (${q && q.why.join('; ')})`);
ok(OA.lookup('what file handles your voice')?.organ === 'voice' && OA.lookup('where is my mood coded')?.organ === 'mood', 'two more phrasings resolve');
ok(OA.lookup('tell me about the weather in Baton Rouge') === null && OA.lookup('') === null, 'a question naming no organ resolves to nothing');
const l = OA.line('which organ owns my mood');
ok(/^THE ORGAN THIS NAMES: lib\/mood\.js — lib\/mood\.js — her mood dynamics/.test(l) && /it logs as \[mood\]/.test(l) && /its switch: ZOE_MOOD_DISABLED/.test(l) && /its smoke: scripts\/smoke_mood\.js/.test(l) && /its meta keys: mood\.current/.test(l) && /source_read \{"path":"lib\/mood\.js"\}/.test(l), `the brief line names the file, the lane, the prefix, the switch, the smoke, the meta keys and the read: ${l.slice(0, 120)}`);
ok(OA.rankBoost('how is my mood coded').rel === 'lib/mood.js' && OA.rankBoost('how is my mood coded').boost === 60 && OA.rankBoost('the parish roster') === null, 'the source map gets a rank boost for the organ a focus names');
ok(OA.detectOrganQuestion('Which organ owns my mood?') && OA.detectOrganQuestion('what module handles your voice') && OA.detectOrganQuestion('where is my mood coded') && OA.detectOrganQuestion('how do I turn off your camera sense'), 'the organ-question detector reads four phrasings');
ok(!OA.detectOrganQuestion('What is the capital of Louisiana?') && !OA.detectOrganQuestion('which parish handles the permits'), 'a worldly question is not an organ question');

// ── the real shelf, read-only ──────────────────────────────────────────────────────────────────────────────
const real = require(path.join(ROOT, 'lib', 'self_audit')).collectCorpus({ root: ROOT });
const realRows = OA.scan({ corpus: real });
const libFiles = Object.keys(real.files).filter((p) => p.startsWith('lib/'));
const prefixed = libFiles.filter((p) => new RegExp(OA.PREFIX_RE.source).test(real.files[p].text));
ok(realRows.length === libFiles.length && prefixed.every((p) => realRows.some((r) => r.file === p && r.log_prefix.length)), `the seed covers every lib organ (${realRows.length}); every one with a [prefix] log line (${prefixed.length}) carries its prefix`);
const rq = OA.lookup('which organ owns my mood', { rowsIn: realRows });
const rc = OA.lookup('which organ runs my continuity attestation at boot', { rowsIn: realRows }), rw = OA.lookup('what organ handles the wander', { rowsIn: realRows });
ok(rq && rq.file === 'lib/mood.js' && rc && rc.file === 'lib/continuity_attest.js' && rw && rw.file === 'lib/wander.js', `on the real shelf: mood → ${rq && rq.file}, the continuity attestation → ${rc && rc.file} (not its one-word namesake), the wander → ${rw && rw.file}`);

// ── the wiring ─────────────────────────────────────────────────────────────────────────────────────────────
const saS = fs.readFileSync(path.join(ROOT, 'lib', 'self_audit.js'), 'utf8'), ssS = fs.readFileSync(path.join(ROOT, 'lib', 'self_source.js'), 'utf8'), mainS = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8'), htS = fs.readFileSync(path.join(ROOT, 'scripts', 'hard_test.js'), 'utf8'), rsS = fs.readFileSync(path.join(ROOT, 'scripts', 'run_smokes.js'), 'utf8');
ok(/organ_atlas'\)\.scan\(\{ corpus \}\)/.test(saS) && /organ_atlas'\)\.seedRows\(\{ rows: atlasRows/.test(saS) && /_seedAtlas\(out\.atlas, out\.findings/.test(saS) && /sa\.sweep\(corpus/.test(fs.readFileSync(path.join(ROOT, 'scripts', 'self_audit_pass.js'), 'utf8')), 'the self audit\'s sweep scans the atlas in the child and the parent seeds the table');
ok(/organ_atlas'\)\.rankBoost\(focus\)/.test(ssS) && /score \+= organBoost\.boost/.test(ssS) && /organ_atlas'\)\.detectOrganQuestion\(s\)/.test(ssS), 'the source map ranks by organ and an organ question counts as a self-question');
ok(/organ_atlas'\)\.line\(userMessage\)/.test(mainS), 'the operator brief carries the atlas line when a self-question names an organ');
ok(/name: 'which_organ'/.test(htS) && (htS.match(/which organ|what (module|file) (owns|handles)|where is (my|your) [a-z ]+ coded/gi) || []).length >= 3, 'the hard test has a which_organ kind with three phrasings');
ok(/'smoke_organ_atlas\.js'/.test(rsS), 'the smoke is registered in the allow-list');
console.log(`\nsmoke_organ_atlas: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
