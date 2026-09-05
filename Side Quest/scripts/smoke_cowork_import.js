/* smoke_cowork_import.js — Cowork port P1, the READ + PLAN half (2026-09-04).
 *
 * Reads a Cowork spaces.json + per-space memory files and builds an idempotent import plan. The READ half
 * is pure (READ-ONLY, injected fs); the PLAN half is idempotent by space id. Driven over a temp fixture,
 * offline. Pins: the spaces + folders + verbatim law parse, the frontmatter strip, MEMORY.md skipped,
 * idempotence (an already-imported space is a skip), and that this half WRITES NOTHING.
 */
'use strict';
const os = require('os'), path = require('path'), fs = require('fs');
const CI = require('../lib/cowork_import');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// ── a fixture cowork dir: 2 spaces, one with a memory fact + a MEMORY.md index ──────────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq_cowork_'));
const w = (rel, body) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); };
w('spaces.json', JSON.stringify({ spaces: [
  { id: 'aaa', name: 'Op-Eds', folders: [{ path: 'C:/Docs/Op-Eds' }, { path: 'C:/Work/Guides' }], instructions: 'Rainey Center branding; never use em dashes; deeply cited.', origin: 'cowork' },
  { id: 'bbb', name: 'North Dakota', folders: [{ path: 'C:/Docs/ND' }], instructions: 'ND infrastructure policy.' },
] }));
w('spaces/aaa/memory/MEMORY.md', '- [Never use em dashes](feedback_no_em_dashes.md): hard rule\n');
w('spaces/aaa/memory/feedback_no_em_dashes.md', '---\nname: Never use em dashes\ndescription: "A hard rule across all copy"\n---\nUser has a hard rule against em dashes. Use commas or restructure.');
w('spaces/bbb/memory/project_nd.md', '---\nname: ND infrastructure\n---\nMultiple ND facts here.');

// ── read ────────────────────────────────────────────────────────────────────────────────────────
const r = CI.readCoworkSpaces(dir, {});
ok(r.ok && r.spaces.length === 2, `reads the spaces.json (${r.spaces.length} spaces)`);
const op = r.spaces.find((s) => s.id === 'aaa');
ok(op && op.name === 'Op-Eds' && op.folders.length === 2 && op.folders[0] === 'C:/Docs/Op-Eds', 'a space carries its name + folder paths (flattened from {path})');
ok(op && /never use em dashes/.test(op.instructions), 'the instruction (the verbatim law) is read whole');
ok(op && op.memory.length === 1 && op.memory[0].name === 'Never use em dashes', 'a memory FACT file is read; the frontmatter name is parsed');
ok(op && op.memory[0].description === 'A hard rule across all copy' && !/^---/.test(op.memory[0].body), 'the frontmatter description parses; the body has the frontmatter stripped');
ok(op && !op.memory.some((m) => /MEMORY/i.test(m.file)), 'the MEMORY.md index is skipped — the fact files are the substance');

// ── plan: idempotent by space id ──────────────────────────────────────────────────────────────
const plan = CI.buildPlan(r.spaces, {});
ok(plan.totals.toCreate === 2 && plan.totals.toSkip === 0 && plan.totals.laws === 2 && plan.totals.facts === 2, `a fresh plan creates all (${JSON.stringify(plan.totals)})`);
const opAction = plan.create.find((a) => a.spaceId === 'aaa');
ok(opAction && opAction.law === op.instructions && opAction.facts[0].body.length > 0, 'the create action carries the verbatim law + the fact body (nothing paraphrased)');
const plan2 = CI.buildPlan(r.spaces, { imported: ['aaa'] });
ok(plan2.totals.toCreate === 1 && plan2.totals.toSkip === 1 && plan2.skip[0].spaceId === 'aaa', 'idempotent: an already-imported space is a SKIP');

// ── the summary + the no-write guarantee ────────────────────────────────────────────────────────
const sum = CI.summarize(plan);
ok(/COWORK IMPORT PLAN/.test(sum) && /Op-Eds/.test(sum) && /never use em dashes/.test(sum), 'summarize() renders a reviewable plan naming the law');
const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cowork_import.js'), 'utf8');
ok(!/writeFileSync|\.run\(|INSERT |getDb\(\)|\.record\(/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')), 'the READ+PLAN half writes NOTHING — no fs write, no DB, no record door (apply is a separate, reviewed step)');
ok(/readdirSync|readFileSync/.test(src), 'it only reads');

// ── discoverDir: injected fs finds spaces.json under the sessions tree ───────────────────────────
const fakeEnv = { APPDATA: dir + '_appdata' };
const fakeFs = {
  readdirSync: (p) => (p.endsWith('local-agent-mode-sessions') ? ['acct'] : (p.endsWith('acct') ? ['sess'] : [])),
  statSync: (p) => ({ isDirectory: () => !/spaces\.json$/.test(p), isFile: () => /spaces\.json$/.test(p) }),
};
const found = CI.discoverDir({ fs: fakeFs, env: fakeEnv });
ok(found && /acct[\\/]sess$/.test(found), 'discoverDir walks account/session to the dir holding spaces.json');
ok(CI.discoverDir({ fs: fakeFs, env: { COWORK_DIR: 'X' } }) === 'X', 'COWORK_DIR overrides discovery');

try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
console.log(`\nsmoke_cowork_import: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
