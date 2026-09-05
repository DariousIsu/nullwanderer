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
// The no-write guarantee is scoped to the READ+PLAN half (everything above the APPLY marker): the apply
// half deliberately holds the write doors, and it runs only on an explicit {apply:true}, never on a read.
const readHalf = src.split(/THE APPLY HALF/)[0].replace(/\/\*[\s\S]*?\*\//g, '');
ok(!/writeFileSync|\.run\(|INSERT |getDb\(\)|\.record\(|\.store\(|setMeta\(/.test(readHalf), 'the READ+PLAN half writes NOTHING — no fs write, no DB, no record/store door (apply is a separate, reviewed step)');
ok(/readdirSync|readFileSync/.test(readHalf), 'it only reads');
ok(/THE APPLY HALF/.test(src) && /async function applyPlan/.test(src), 'the apply half exists below the marker, as its own explicit step');

// ── discoverDir: injected fs finds spaces.json under the sessions tree ───────────────────────────
const fakeEnv = { APPDATA: dir + '_appdata' };
const fakeFs = {
  readdirSync: (p) => (p.endsWith('local-agent-mode-sessions') ? ['acct'] : (p.endsWith('acct') ? ['sess'] : [])),
  statSync: (p) => ({ isDirectory: () => !/spaces\.json$/.test(p), isFile: () => /spaces\.json$/.test(p) }),
};
const found = CI.discoverDir({ fs: fakeFs, env: fakeEnv });
ok(found && /acct[\\/]sess$/.test(found), 'discoverDir walks account/session to the dir holding spaces.json');
ok(CI.discoverDir({ fs: fakeFs, env: { COWORK_DIR: 'X' } }) === 'X', 'COWORK_DIR overrides discovery');

// ── THE APPLY HALF — offline, every collaborator injected ────────────────────────────────────────
(async () => {
  // matchProject: the Cowork name binds to the existing Echo project (exact, or a prefix either way)
  const echoProjects = [{ project_name: 'Permitting Reform Sec 401' }, { project_name: 'Op-Eds' }, { project_name: 'live-events' }, { project_name: 'North Dakota' }];
  ok(CI.matchProject('Permitting reform on Sec 401', echoProjects) === 'Permitting Reform Sec 401', 'matchProject: "Permitting reform on Sec 401" binds to "Permitting Reform Sec 401" (stopwords + case ignored)');
  ok(CI.matchProject('Live Events &  Webinars', echoProjects) === 'live-events', 'matchProject: "Live Events & Webinars" binds to "live-events" (prefix)');
  ok(CI.matchProject('Proposal', echoProjects) === null, 'matchProject: an unknown space matches nothing (→ create)');
  ok(CI.inferProjectType('Legislative Tracker') === 'tracker' && CI.inferProjectType('Op-Eds') === 'output_library' && CI.inferProjectType('Proposal') === 'research_topic', 'inferProjectType maps a space to a valid Echo workflow type');

  const dispatched = [], laws = [], facts = [], meta = {};
  const deps = {
    dispatch: async (tag) => {
      dispatched.push(tag);
      if (tag.name === 'list_projects') return { ok: true, text: JSON.stringify({ result: echoProjects }) };
      if (tag.name === 'create_project') return { ok: true, text: JSON.stringify({ result: { action: 'created', project_name: tag.args.project_name } }) };
      return null;
    },
    directives: { record: (rule) => { laws.push(rule); return { id: laws.length }; } },
    memory: { store: async (rec) => { facts.push(rec); return { id: facts.length }; } },
    db: { getMeta: (k) => meta[k], setMeta: (k, v) => { meta[k] = v; } },
    now: 5000,
  };
  const spaces = [
    { id: 'p1', name: 'Op-Eds', folders: ['C:/Docs/Op-Eds'], instructions: 'Rainey branding; never em dashes.', memory: [{ file: 'feedback_no_em_dashes.md', name: 'Never use em dashes', body: 'hard rule' }] },
    { id: 'p2', name: 'Proposal', folders: ['C:/Docs/Proposal'], instructions: 'R&D of new concepts.', memory: [{ file: 'project_datacenter.md', name: 'datacenter', body: 'three framings' }] },
  ];
  const r = await CI.applyPlan(CI.buildPlan(spaces, {}), { deps });
  ok(r.bound === 1 && r.created === 1 && r.perSpace.find((s) => s.name === 'Op-Eds').project === 'Op-Eds', `apply: an existing space BINDS, a missing one is CREATED (${JSON.stringify({ bound: r.bound, created: r.created })})`);
  const cp = dispatched.find((t) => t.name === 'create_project');
  ok(cp && cp.args.project_name === 'Proposal' && cp.args.project_type === 'research_topic' && cp.args.path === 'C:/Docs/Proposal', 'the create goes through Echo create_project with a valid type + the folder as path');
  ok(r.laws === 2 && laws.includes('Rainey branding; never em dashes.'), 'every space law lands as a GLOBAL directive, verbatim');
  ok(r.ruleFacts === 1 && laws.some((l) => /Never use em dashes/.test(l)), 'a feedback_* memory file is a RULE → a directive');
  ok(r.facts === 1 && facts[0].source === 'cowork-import' && facts[0].provenance.cowork_space === 'p2' && facts[0].provenance.project === 'Proposal', 'a project_* memory file is a FACT → memory.store with Cowork provenance + the bound project');
  const mk = JSON.parse(meta['cowork.imported_spaces']);
  ok(mk.p1 && mk.p1.project === 'Op-Eds' && mk.p2 && mk.p2.action === 'created', 'the marker records each imported space → its project');
  // idempotent: a second plan built from the marker skips both
  const plan2 = CI.buildPlan(spaces, { imported: Object.keys(mk) });
  ok(plan2.totals.toCreate === 0 && plan2.totals.toSkip === 2, 'a second pass skips every imported space (idempotent by marker)');
  // fail-soft: the suit down → laws still land, the binding is DEFERRED (not marked), nothing throws
  const laws2 = [];
  const r2 = await CI.applyPlan(CI.buildPlan(spaces, {}), { deps: { ...deps, dispatch: async () => null, directives: { record: (x) => { laws2.push(x); return { id: 1 }; } }, db: { getMeta: () => '{}', setMeta: () => {} } } });
  ok(r2.deferred === 2 && r2.bound === 0 && laws2.length === 3 && /not reachable/.test(r2.notes.join(' ')), 'suit down: project binding deferred (retried next pass), laws still land, honest note');

  // the door
  const tp = fs.readFileSync(path.join(__dirname, '..', 'lib', 'test_port.js'), 'utf8');
  ok(/\/cowork\/import/.test(tp) && /applyPlan/.test(tp) && /dryRun: true/.test(tp), 'POST /cowork/import: dry-run by default, apply only on {apply:true}');

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  console.log(`\nsmoke_cowork_import: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('apply smoke threw:', e); process.exit(1); });
