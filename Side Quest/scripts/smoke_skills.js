/* Smoke: lib/skills — O1 THE SKILL SHELF (slice 5). Deterministic: in-memory db + injected readers.
 * The shelf's contract: trigger surface cheap and permanent, bodies dereference on pull.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_skills.js
 */
'use strict';
const skills = require('../lib/skills');
const procedures = require('../lib/procedures');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const os = require('os');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

const mem = new Database(':memory:');
mem.exec(`CREATE TABLE skills (name TEXT PRIMARY KEY, trigger_desc TEXT NOT NULL, kind TEXT NOT NULL,
  body_ref TEXT, applies TEXT, provenance TEXT, uses INTEGER NOT NULL DEFAULT 0, last_used_ts INTEGER, created_ts INTEGER NOT NULL);
  CREATE TABLE procedures (id INTEGER PRIMARY KEY, kind TEXT, name TEXT, trigger_text TEXT, steps TEXT,
  check_text TEXT, applicability TEXT, provenance TEXT, met INTEGER DEFAULT 0, unmet INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active', created_ts INTEGER, last_used_ts INTEGER)`);
const deps = { db: { getDb: () => mem } };

// --- register: the trigger surface contract ---
const r1 = skills.register({ name: 'Join a Google Meet', triggerDesc: 'join a scheduled Google Meet call from its invite link', kind: 'flow', bodyRef: 'gmeet_join.json', deps, nowMs: 1000 });
ok(r1.ok && r1.name === 'join-a-google-meet', 'register slugs the name and lands the row');
ok(!skills.register({ name: 'x', triggerDesc: 'y', kind: 'sorcery', deps }).ok, 'an unknown kind refuses');
const long = skills.register({ name: 'long-trigger', triggerDesc: 'w'.repeat(400), kind: 'shape', bodyRef: 'body', deps, nowMs: 1000 });
ok(long.ok && skills.get('long-trigger', { deps }).trigger_desc.length === skills.TRIGGER_MAX, 'the trigger line clamps to the shelf contract (≤140)');
skills.register({ name: 'Join a Google Meet', triggerDesc: 'join a Google Meet call from a calendar invite link', kind: 'flow', bodyRef: 'gmeet_join.json', deps, nowMs: 2000 });
ok(mem.prepare("SELECT COUNT(*) n FROM skills WHERE name = 'join-a-google-meet'").get().n === 1, 're-register upserts — one row, refreshed trigger');

// --- match: token overlap over the permanent surface ---
skills.register({ name: 'verify-fec-committee', triggerDesc: 'verify an FEC committee identity before landing enrichment edges', kind: 'shape', bodyRef: 'Check the registry id first.', deps, nowMs: 1500 });
const m1 = skills.match({ text: 'I need to join the Google Meet call for the huddle', deps });
ok(m1.length >= 1 && m1[0].name === 'join-a-google-meet', 'a matching turn surfaces the right skill first');
ok(skills.match({ text: 'completely unrelated words about gardening tulips', deps }).length === 0, 'no overlap → nothing surfaces (silence beats filler)');
const lines = skills.matchLines({ text: 'join the google meet call', deps });
ok(/SKILLS ON THE SHELF/.test(lines) && /skill_pull tool/.test(lines) && !/Steps \(/.test(lines), 'matchLines carries trigger lines + the pull tool — never a body');

// --- manifest: top-K + the honest total ---
const man = skills.manifestLines({ limit: 2, deps });
ok(man.length === 3 && /1 more on the shelf/.test(man[2]), 'manifest is bounded and names what it left off');
ok(skills.manifestLines({ deps: { db: { getDb: () => { const d = new Database(':memory:'); return d; } } } }).length === 0, 'an empty/missing shelf drops the section');

// --- resolveBody: dereference by kind, use recorded ---
const shape = skills.resolveBody('verify-fec-committee', { deps, nowMs: 3000 });
ok(shape.ok && /registry id first/.test(shape.text), "kind 'shape': the body lives on the row");
ok(skills.get('verify-fec-committee', { deps }).uses === 1, 'a pull records the use');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-smoke-'));
fs.writeFileSync(path.join(tmpDir, 'gmeet_join.json'), JSON.stringify({ description: 'join a meet', steps: [{ action: 'open', url: 'https://meet.google.com' }, { action: 'click', selector: '#join', note: 'the join button' }] }));
const flow = skills.resolveBody('join-a-google-meet', { deps, nowMs: 3000 });
ok(flow.ok, "kind 'flow': resolves (real recipes dir on live; unreadable file degrades to the trigger line)");
const flowInj = (() => {
  skills.register({ name: 'tmp-flow', triggerDesc: 'a temp flow for the smoke', kind: 'flow', bodyRef: 'gmeet_join.json', deps, nowMs: 1000 });
  return skills.resolveBody('tmp-flow', { deps: { ...deps, readFile: (p) => fs.readFileSync(path.join(tmpDir, path.basename(p)), 'utf8') }, nowMs: 3000 });
})();
ok(flowInj.ok && /Steps \(2\)/.test(flowInj.text) && /join button/.test(flowInj.text), "kind 'flow': steps render from the recipe file");
mem.prepare("INSERT INTO procedures (id,kind,name,trigger_text,steps,check_text,met,unmet,status,created_ts) VALUES (7,'procedure','Chase the official roster','filling a county board roster','1. county site 2. minutes PDFs','all seats named',4,1,'active',1000)").run();
skills.register({ name: 'chase-the-official-roster', triggerDesc: 'fill a county board roster from official sources', kind: 'procedure', bodyRef: '7', deps, nowMs: 1000 });
const proc = skills.resolveBody('chase-the-official-roster', { deps, nowMs: 3000 });
ok(proc.ok && /met 4\/5/.test(proc.text) && /minutes PDFs/.test(proc.text), "kind 'procedure': the body carries the steps + the honest track record");
ok(!skills.resolveBody('never-registered', { deps }).ok, 'a miss is honest, never invented');

// --- births: proven procedures self-promote; syncFlows registers the disk ---
ok(!skills.promoteFromProcedures({ id: 9, name: 'young', trigger_text: 'x', met: 2 }, { deps }).ok, 'met<3 does not promote — the shelf holds PROVEN competence');
mem.prepare("INSERT INTO procedures (id,kind,name,trigger_text,met,unmet,status,created_ts) VALUES (11,'procedure','Corroborate via state registries','corroborating single-source org claims',2,0,'active',1000)").run();
procedures.recordUse(11, { met: true, deps, nowMs: 4000 });
ok(!!skills.get('corroborate-via-state-registries', { deps }), 'procedures.recordUse crossing met≥3 births the shelf row (the O1 birth)');
const n1 = skills.syncFlows({ dir: tmpDir, deps, nowMs: 5000 });
const n2 = skills.syncFlows({ dir: tmpDir, deps, nowMs: 6000 });
ok(n1 === 1 && n2 === 1 && skills.get('gmeet_join', { deps }), 'syncFlows registers disk recipes idempotently');

// --- the pull tag: complete self-closing only ---
ok(skills.parseSkillTags('let me check <skill name="join-a-google-meet"/> first')[0].name === 'join-a-google-meet', 'a complete tag parses');
ok(skills.parseSkillTags('you could use <skill name="x">...').length === 0 && skills.parseSkillTags('use a <skill> tag').length === 0, 'narration and incomplete tags never dispatch');
ok(!/<skill/.test(skills.stripSkillTags('a <skill name="join-a-google-meet"/> b')), 'the tag strips from display');

try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
