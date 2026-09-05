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
  ok(cp && cp.args.project_name === 'Proposal' && cp.args.project_type === 'research_topic' && cp.args.path === 'Vault/Proposal' && cp.args.source_folder === 'C:/Docs/Proposal', 'the create goes through Echo create_project with a valid type, a Vault-relative path (THE PATH LAW) + the folder as source_folder');
  ok(r.laws === 2 && laws.includes('Rainey branding; never em dashes.'), 'every space law lands as a GLOBAL directive, verbatim');
  ok(r.ruleFacts === 1 && laws.some((l) => /Never use em dashes/.test(l)), 'a feedback_* memory file is a RULE → a directive');
  ok(r.facts === 1 && facts[0].source === 'cowork-import' && facts[0].provenance.cowork_space === 'p2' && facts[0].provenance.project === 'Proposal', 'a project_* memory file is a FACT → memory.store with Cowork provenance + the bound project');
  const mk = JSON.parse(meta['cowork.imported_spaces']);
  ok(mk.p1 && mk.p1.project === 'Op-Eds' && mk.p2 && mk.p2.action === 'created', 'the marker records each imported space → its project');
  // idempotent: a second plan built from the marker skips both
  const plan2 = CI.buildPlan(spaces, { imported: Object.keys(mk) });
  ok(plan2.totals.toCreate === 0 && plan2.totals.toSkip === 2, 'a second pass skips every imported space (idempotent by marker)');
  // the p298 lesson: a deferred RETRY must redo only the binding — a fact already stored is skipped, never re-stored
  const facts3 = [];
  const r3 = await CI.applyPlan(CI.buildPlan(spaces, {}), { deps: { ...deps, memory: { store: async (rec) => { facts3.push(rec); return { id: 1 }; } }, factExists: () => true, db: { getMeta: () => '{}', setMeta: () => {} } } });
  ok(r3.facts === 0 && r3.factsSkipped === 1 && facts3.length === 0, 'retry: a fact already in the store is SKIPPED (factsSkipped=1, 0 stored) — no duplicate rows on a deferred retry');
  ok(r.facts === 1 && r.factsSkipped === 0, 'first pass: the fact is stored once (factExists false)');
  const src2 = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cowork_import.js'), 'utf8');
  ok(/source='cowork-import' AND provenance LIKE \? AND provenance LIKE \?/.test(src2), 'the default factExists reads the store by Cowork provenance (space + file), not by content');
  // the plan carries the memory FILE name so provenance can key on it (p298: it was dropped, so the pre-check could never match)
  ok(CI.buildPlan(spaces, {}).create[0].facts[0].file === 'feedback_no_em_dashes.md', 'buildPlan carries the memory file name into the fact (provenance key)');
  ok(facts.length && facts[0].provenance.file === 'project_datacenter.md', 'the stored fact provenance carries file + space + project');

  // dedupFacts: the repair door — 3 duplicate pairs → retire the OLDER of each, keep the newest; never delete
  const kRows = [
    { id: 1, content: 'A\n\nbody', provenance: JSON.stringify({ cowork_space: 's1', project: null }) },            // older, pre-`file` (falls back to content head)
    { id: 4, content: 'A\n\nbody', provenance: JSON.stringify({ cowork_space: 's1', project: 'P' }) },             // newer twin
    { id: 2, content: 'B\n\nbody', provenance: JSON.stringify({ cowork_space: 's2', file: 'f.md', project: null }) },
    { id: 5, content: 'B\n\nbody', provenance: JSON.stringify({ cowork_space: 's2', file: 'f.md', project: 'Q' }) },
    { id: 3, content: 'C solo', provenance: JSON.stringify({ cowork_space: 's3', file: 'g.md' }) },                // no twin — untouched
    { id: 9, content: 'A\n\nbody', provenance: JSON.stringify({ cowork_space: 's1', superseded: true }) },         // already retired — ignored
  ];
  const retiredIds = [];
  const fakeDb = { prepare: () => ({ all: () => kRows }) };
  const dd = CI.dedupFacts({ deps: { db: fakeDb, retire: (id) => { retiredIds.push(id); return true; } } });
  ok(dd.retired === 2 && retiredIds.sort().join() === '1,2' && dd.kept.sort().join() === '4,5', `dedupFacts retires the OLDER copy of each pair (1,2), keeps the newest (4,5), leaves the solo + the already-retired alone (${JSON.stringify(dd)})`);
  const src3 = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cowork_import.js'), 'utf8');
  ok(/retireVerifiedFact\(id, \{ by: 'cowork-import-dedup' \}\)/.test(src3) && !/DELETE FROM knowledge/.test(src3), 'the repair RETIRES through the standard superseded door — it never DELETEs (the append-only law)');
  const tpSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'test_port.js'), 'utf8');   // read here — `tp` is declared later in this block
  ok(/dedup = false/.test(tpSrc) && /dedupFacts\(\{\}\)/.test(tpSrc), 'POST /cowork/import {dedup:true} runs the repair through the app, never a hand script');

  // fail-soft: the suit down → laws still land, the binding is DEFERRED (not marked), nothing throws
  const laws2 = [];
  const r2 = await CI.applyPlan(CI.buildPlan(spaces, {}), { deps: { ...deps, dispatch: async () => null, directives: { record: (x) => { laws2.push(x); return { id: 1 }; } }, db: { getMeta: () => '{}', setMeta: () => {} } } });
  ok(r2.deferred === 2 && r2.bound === 0 && laws2.length === 3 && /not reachable/.test(r2.notes.join(' ')), 'suit down: project binding deferred (retried next pass), laws still land, honest note');

  // ── THE FILES HALF (P2 + P3, 09-05) — read-only reads over a fixture, a plan, a bounded apply, every collaborator injected ──
  const fdir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq_cowork_files_'));
  const fw = (rel, body) => { const p = path.join(fdir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); };
  // two claude.ai project caches: one with a template + an attached file + a cached briefing; one with no template
  fw('.project-cache/u1/metadata.json', JSON.stringify({ uuid: 'u1', name: 'Op-Ed Writing', description: 'research, write and proof op-eds', prompt_template: 'You help research, analyze, write, proof read op-eds. ' + 'x'.repeat(500), synced_at: '2026-08-02' }));
  fw('.project-cache/u1/files/brief.pdf', 'PDFDATA');
  fw('.project-cache/u1/docs/Briefing.md', '# Briefing\n\nbody');
  fw('.project-cache/u2/metadata.json', JSON.stringify({ uuid: 'u2', name: 'China and the 5 year plan', description: 'd', prompt_template: '' }));
  fw('.project-cache/u2/files/plan.pdf', 'PDF');
  // the project folders on disk: Op-Eds (its space is bound), Proposal (space not bound yet), Unknown (no space); nested + a dotfile
  fw('projects/Op-Eds/OpEd_1.docx', 'DOCX');
  fw('projects/Op-Eds/drafts/OpEd_2.md', '# op-ed 2');
  fw('projects/Op-Eds/.hidden.md', 'hidden');
  fw('projects/Proposal/proposal.md', '# proposal');
  fw('projects/Unknown/z.md', 'z');
  const cache = CI.readProjectCache(fdir, {});
  ok(cache.ok && cache.projects.length === 2, `readProjectCache reads the synced claude.ai Projects (${cache.projects.length})`);
  const oe = cache.projects.find((p) => p.uuid === 'u1');
  ok(oe && oe.files.length === 1 && oe.docs.length === 1 && oe.promptTemplate.startsWith('You help research') && oe.files[0].key.length === 16, 'a project carries its attached files + cached docs (keyed by path+size+mtime) + the verbatim prompt template');
  const folders = CI.readProjectFolders(path.join(fdir, 'projects'), {});
  ok(folders.ok && folders.folders.length === 3 && folders.folders.find((f) => f.name === 'Op-Eds').files.length === 2, 'readProjectFolders walks each project folder recursively; dotfiles skipped');
  const fSpaces = [{ id: 'p1', name: 'Op-Eds', folders: [path.join(fdir, 'projects', 'Op-Eds')] }, { id: 'p2', name: 'Proposal', folders: [] }];
  const fPlanArgs = { cache: cache.projects, folders: folders.folders, spaces: fSpaces, spacesMarker: { p1: { project: 'Op-Eds' } } };
  const fplan = CI.buildFilePlan(fPlanArgs);
  ok(fplan.totals.files === 7 && fplan.totals.toIngest === 5 && fplan.totals.unbound === 2 && fplan.totals.templates === 1, `the plan: 7 files, 5 to ingest (2 bound-space + 3 claude-project), 2 unbound, 1 template (${JSON.stringify({ ...fplan.totals, byProject: undefined, byExt: undefined })})`);
  ok(fplan.items.find((i) => i.name === 'OpEd_2.md').project === 'Op-Eds' && fplan.items.find((i) => i.name === 'brief.pdf').project === null && fplan.items.find((i) => i.name === 'brief.pdf').projectHint === 'Op-Ed Writing', 'a folder file knows its bound project (by the space folder path); a claude-project file waits for the bind');
  ok(fplan.unboundSpaces.join() === 'Proposal,Unknown' && /unbound folders/.test(CI.summarizeFiles(fplan)) && /COWORK FILES PLAN/.test(CI.summarizeFiles(fplan)), 'unbound folders are NAMED in the summary — never filed into a guess');
  const k1 = fplan.items.find((i) => i.name === 'OpEd_1.docx').key, k2 = fplan.items.find((i) => i.name === 'OpEd_2.md').key;
  const fplan2 = CI.buildFilePlan({ ...fPlanArgs, filesMarker: { [k1]: { doc_id: 9 }, [k2]: { action: 'unsupported' } }, templatesMarker: { u1: { factId: 3 } } });
  ok(fplan2.totals.done === 1 && fplan2.totals.terminal === 1 && fplan2.totals.toIngest === 3 && fplan2.totals.templates === 0 && fplan2.totals.templatesDone === 1, 'idempotent by file key: done + terminal are never re-ingested; a registered template is skipped');
  const srcF = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cowork_import.js'), 'utf8').split(/THE FILES HALF/)[1].split(/const _parseBody/)[0].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ok(!/writeFileSync|\.run\(|INSERT |\.record\(|\.store\(|setMeta\(|dispatch\(/.test(srcF) && /readdirSync|statSync/.test(srcF), 'the files READ+PLAN half writes NOTHING and dispatches nothing — the apply is a separate bounded step');

  // apply — an injected suit: Op-Eds exists with an ABSOLUTE path (THE PATH LAW pre-flight normalizes it through the
  // create door before a file lands), the two claude.ai Projects are CREATED; ingest answers per file
  const calls = [];
  const mkDb = () => { const m = {}; return { getMeta: (k) => m[k], setMeta: (k, v) => { m[k] = v; }, _m: m }; };
  // a STATEFUL fake store: create_project updates the row, so a read-back after the repair sees the write
  const mkFdeps = () => {
    const echo = { 'Op-Eds': { project_name: 'Op-Eds', project_type: 'output_library', path: 'C:/Users/x/Documents/Claude/Projects/Op-Eds', domain: 'rainey' } };
    return {
      echo,
      dispatch: async (tag) => {
        calls.push(tag);
        if (tag.name === 'list_projects') return { ok: true, text: JSON.stringify({ result: Object.values(echo) }) };
        if (tag.name === 'get_project') return { ok: true, text: JSON.stringify(echo[tag.args.project_name] || { project_name: tag.args.project_name, path: `Vault/${tag.args.project_name}` }) };
        if (tag.name === 'create_project') {
          const row = echo[tag.args.project_name] || (echo[tag.args.project_name] = { project_name: tag.args.project_name, project_type: tag.args.project_type });
          const existed = !!row.path; row.path = tag.args.path;
          return { ok: true, text: JSON.stringify({ result: { action: existed ? 'updated' : 'created', path: tag.args.path } }) };
        }
        if (tag.name === 'ingest_file') {
          const n = path.basename(tag.args.source_path);
          if (/\.pdf$/.test(n)) return { ok: true, text: JSON.stringify({ action: 'unsupported', error: 'no extractor', ext: '.pdf' }) };
          if (n === 'OpEd_1.docx') return null;                                                     // a transport failure — never recorded
          return { ok: true, text: JSON.stringify({ action: 'ingested', doc_id: 100 + calls.length, project_name: tag.args.project_name }) };
        }
        if (tag.name === 'extract_entities_from_doc') return { ok: true, text: '{"ok":true}' };
        return null;
      },
      memory: { store: async (rec) => ({ id: 42, rec }) },
      skills: { register: (a) => { calls.push({ name: 'skills.register', args: a }); return { ok: true, name: 'cowork-op-ed-writing' }; } },
      db: mkDb(), now: 7000, limit: 25,
    };
  };
  const fdeps = mkFdeps();
  const fr = await CI.applyFilePlan(CI.buildFilePlan(fPlanArgs), { deps: fdeps });
  ok(fdeps.echo['Op-Eds'].path === 'Vault/Op-Eds' && calls.filter((c) => c.name === 'get_project' && c.args.project_name === 'Op-Eds').length === 2, 'the repair is READ BACK from the store (2 get_project reads: before + after) — the door\'s reply alone never makes a project safe');
  ok(fr.created === 2 && fr.bound === 0 && fr.normalized === 1, `apply: the claude.ai Projects are CREATED (2), Op-Eds' absolute path is NORMALIZED before any file lands (${JSON.stringify({ created: fr.created, normalized: fr.normalized })})`);
  const norm = calls.find((c) => c.name === 'create_project' && c.args.project_name === 'Op-Eds');
  ok(norm && norm.args.path === 'Vault/Op-Eds' && /Projects\/Op-Eds$/.test(norm.args.source_folder) && norm.args.project_type === 'output_library', 'THE PATH LAW pre-flight re-upserts Vault/<name> through the create door (same type), keeping the folder as source_folder');
  const cr = calls.filter((c) => c.name === 'create_project' && !c.args.source_folder);
  ok(cr.length === 2 && cr.every((c) => /^Vault\//.test(c.args.path)), 'a created claude.ai Project row is born Vault-relative');
  ok(fr.ingested === 2 && fr.entities === 2 && fr.terminal === 2 && fr.failed === 1 && fr.remaining === 0, `files: 2 ingested (+entities), 2 terminal (unsupported pdf), 1 transport failure (${JSON.stringify({ ingested: fr.ingested, entities: fr.entities, terminal: fr.terminal, failed: fr.failed, remaining: fr.remaining })})`);
  const ing = calls.filter((c) => c.name === 'ingest_file');
  ok(ing.length === 5 && ing.every((c) => c.args.move === false && path.isAbsolute(c.args.source_path)) && ing.some((c) => c.args.project_name === 'Op-Ed Writing') && ing.some((c) => c.args.project_name === 'Op-Eds'), 'every ingest goes through ingest_file with move=false (the Cowork side stays read-only) and the project as origin');
  const fm = JSON.parse(fdeps.db._m[CI.FILES_META]);
  ok(Object.keys(fm).length === 4 && !fm[k1] && fm[k2] && fm[k2].doc_id && Object.values(fm).some((v) => v.action === 'unsupported'), 'the marker records ingested + terminal; the transport failure is NOT recorded (retried on the next call)');
  ok(fr.templates === 1 && calls.some((c) => c.name === 'skills.register' && c.args.kind === 'guide' && c.args.bodyRef === 'fact:42' && c.args.provenance === 'cowork-import'), 'the prompt template → a knowledge row (Cowork provenance) + a writer GUIDE on the shelf pointing at it (fact:<id>)');
  ok(JSON.parse(fdeps.db._m[CI.TEMPLATES_META]).u1.factId === 42, 'the templates marker records the fact id');
  // a second call on the recorded markers: the 4 recorded keys skip, the failed one retries, the template skips
  const calls2n = calls.length;
  const fr2 = await CI.applyFilePlan(CI.buildFilePlan({ ...fPlanArgs, filesMarker: fm, templatesMarker: JSON.parse(fdeps.db._m[CI.TEMPLATES_META]) }), { deps: fdeps });
  ok(fr2.templates === 0 && !calls.slice(calls2n).some((c) => c.name === 'skills.register') && calls.slice(calls2n).filter((c) => c.name === 'ingest_file').length === 1 && fr2.failed === 1, 'the next call retries ONLY the transport failure; recorded files skip, the registered template is dropped at plan time (never re-registered)');
  const stalePlan = CI.buildFilePlan(fPlanArgs);   // a plan built BEFORE the template landed, applied AFTER: the apply-time marker skips it
  const frStale = await CI.applyFilePlan(stalePlan, { deps: fdeps });
  ok(frStale.templatesSkipped === 1 && frStale.templates === 0, 'a stale plan carrying an already-registered template: the apply-time marker skips it (templatesSkipped=1)');
  // the bounded batch: limit 2 → 2 processed, 3 remaining
  const fr3 = await CI.applyFilePlan(CI.buildFilePlan(fPlanArgs), { deps: { ...fdeps, db: mkDb(), limit: 2 } });
  ok(fr3.ingested + fr3.terminal + fr3.failed === 2 && fr3.remaining === 3, `a bounded batch: limit 2 → 2 processed, 3 remaining (${fr3.remaining})`);
  // the suit down → everything deferred, nothing marked, no template stored
  const fr4 = await CI.applyFilePlan(CI.buildFilePlan(fPlanArgs), { deps: { ...fdeps, dispatch: async () => null, db: { getMeta: () => '{}', setMeta: () => { throw new Error('must not write'); } } } });
  ok(fr4.deferred === 6 && fr4.ingested === 0 && fr4.templates === 0 && /not reachable/.test(fr4.notes.join(' ')), 'suit down: everything deferred (5 files + 1 template), nothing marked, honest note');
  // a project whose absolute path CANNOT be normalized never receives a file
  const calls5 = [], d5 = mkFdeps();
  const fr5 = await CI.applyFilePlan(CI.buildFilePlan(fPlanArgs), { deps: { ...d5, dispatch: async (tag) => { calls5.push(tag); if (tag.name === 'create_project' && tag.args.source_folder) return { ok: true, text: JSON.stringify({ result: { action: 'rejected', error: 'no' } }) }; return d5.dispatch(tag); } } });
  ok(!calls5.some((c) => c.name === 'ingest_file' && c.args.project_name === 'Op-Eds') && calls5.some((c) => c.name === 'ingest_file') && /never filed outside the Vault/.test(fr5.notes.join(' ')) && fr5.remaining === 2, `a target whose absolute path cannot be normalized gets NO file (its 2 items stay remaining); the other projects still file — nothing lands outside the Vault (remaining ${fr5.remaining})`);
  // exact-only binding for the claude.ai Projects: a prefix twin must NOT bind (34 briefings filed under a stranger)
  ok(CI.matchProject('Policy Briefings', [{ project_name: 'Policy' }], { exact: true }) === null && CI.matchProject('Policy Briefings', [{ project_name: 'policy briefings' }], { exact: true }) === 'policy briefings' && CI.matchProject('Live Events &  Webinars', [{ project_name: 'live-events' }]) === 'live-events', 'matchProject {exact}: a prefix twin never binds a claude.ai Project, only the same name does; the space rule keeps its prefix bind');
  const bplan = CI.buildFilePlan({ ...fPlanArgs, projects: [{ project_name: 'Op-Eds' }, { project_name: 'Policy' }, { project_name: 'China and the 5 Year Plan' }] });
  ok(bplan.bindings.length === 2 && bplan.bindings.find((b) => b.name === 'Op-Ed Writing').action === 'create' && bplan.bindings.find((b) => b.name === 'China and the 5 year plan').action === 'bind' && bplan.items.find((i) => i.name === 'plan.pdf').project === 'China and the 5 Year Plan' && /→ CREATE as output_library/.test(CI.summarizeFiles(bplan)) && /→ bind "China/.test(CI.summarizeFiles(bplan)), 'the plan names each claude.ai Project binding (bind by exact name / create + type) for review before the apply; a bound one\'s items know their project at plan time');
  ok(CI.buildFilePlan(fPlanArgs).bindings.every((b) => b.action === 'unread') && /unread \(suit down\)/.test(CI.summarizeFiles(CI.buildFilePlan(fPlanArgs))), 'without the projects read the bindings are honestly "unread" — decided at apply');
  ok(CI.inferProjectType('Policy Briefings') === 'output_library' && CI.inferProjectType('China and the 5 year plan') === 'research_topic', 'a briefings project is an output library; a research project a research topic');
  // THE STALE READ (p300): a store whose read-back ignores the write — the repair is NOT trusted, nothing files there
  const dS = mkFdeps(), callsS = [];
  const frS = await CI.applyFilePlan(CI.buildFilePlan(fPlanArgs), { deps: { ...dS, dispatch: async (tag) => { callsS.push(tag); if (tag.name === 'get_project' && tag.args.project_name === 'Op-Eds') return { ok: true, text: JSON.stringify({ project_name: 'Op-Eds', project_type: 'output_library', path: 'C:/Users/x/Documents/Claude/Projects/Op-Eds' }) }; return dS.dispatch(tag); } } });
  ok(frS.normalized === 0 && !callsS.some((c) => c.name === 'ingest_file' && c.args.project_name === 'Op-Eds') && callsS.some((c) => c.name === 'ingest_file') && /still reads absolute/.test(frS.notes.join(' ')) && frS.remaining === 2, `a repair whose READ-BACK is still absolute (a stale read) marks nothing normalized and files NOTHING into that project; the others still file (remaining ${frS.remaining})`);
  // a time budget bounds the batch (China's 11 PDFs are 31 MB — extraction is slow)
  const slowDeps = { ...fdeps, db: mkDb(), timeBudgetMs: 1, dispatch: async (tag) => { if (tag.name === 'ingest_file') await new Promise((r) => setTimeout(r, 8)); return fdeps.dispatch(tag); } };
  const frB = await CI.applyFilePlan(CI.buildFilePlan(fPlanArgs), { deps: slowDeps });
  ok(frB.budgetHit === true && (frB.ingested + frB.terminal + frB.failed) === 1 && frB.remaining === 4, `a time budget bounds the batch: 1 processed, 4 remaining, budgetHit (${frB.remaining})`);
  try { fs.rmSync(fdir, { recursive: true, force: true }); } catch {}

  // the doors
  const tp = fs.readFileSync(path.join(__dirname, '..', 'lib', 'test_port.js'), 'utf8');
  ok(/\/cowork\/import/.test(tp) && /applyPlan/.test(tp) && /dryRun: true/.test(tp), 'POST /cowork/import: dry-run by default, apply only on {apply:true}');
  ok(tp.indexOf("startsWith('/cowork/import-files')") > -1 && tp.indexOf("startsWith('/cowork/import-files')") < tp.indexOf("startsWith('/cowork/import')") && /applyFilePlan/.test(tp) && /summarizeFiles/.test(tp) && /Math\.min\(200/.test(tp) && /timeBudgetMs/.test(tp) && /bindings: plan\.bindings/.test(tp), 'POST /cowork/import-files sits BEFORE /cowork/import (startsWith), dry-run by default (bindings named), the apply bounded (limit ≤ 200 + a time budget)');

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  console.log(`\nsmoke_cowork_import: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('apply smoke threw:', e); process.exit(1); });
