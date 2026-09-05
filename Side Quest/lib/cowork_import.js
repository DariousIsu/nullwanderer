'use strict';
/*
 * lib/cowork_import.js — Cowork port P1, the READ + PLAN half (2026-09-04). His 11 Claude Cowork "spaces"
 * (docs/ZOE_BUILD_PLAN §2, row P1) → a reviewable ZOE import PLAN.
 *
 * Reads the Cowork spaces.json and the per-space memory/ files — READ-ONLY on the Cowork side — and builds
 * an IDEMPOTENT plan: one project per space carrying its folder links, its instruction as a VERBATIM
 * project law (his words, per the "instructions are LAWS" rule), and its memory files as project facts
 * (the Armstrong attribution rule, the no-em-dash rule, the ND canonical facts, the datacenter framings).
 * This half only reads and plans — it writes NOTHING; the APPLY half lands the plan through ZOE's own
 * doors deliberately, after Lucas reviews the plan (importing his operator laws is consequential). Pure
 * over an injected fs so the smoke drives it over a fixture, offline. Idempotent by space id.
 */
const path = require('path');

// The Cowork account/session dir holding spaces.json (COWORK_DIR overrides; else discovered under APPDATA).
function discoverDir({ fs = require('fs'), env = process.env } = {}) {
  if (env.COWORK_DIR) return env.COWORK_DIR;
  const root = path.join(env.APPDATA || '', 'Claude', 'local-agent-mode-sessions');
  try {
    for (const acct of fs.readdirSync(root)) {
      const ap = path.join(root, acct);
      let stat; try { stat = fs.statSync(ap); } catch { continue; }
      if (!stat.isDirectory()) continue;
      for (const sess of fs.readdirSync(ap)) {
        const sp = path.join(ap, sess, 'spaces.json');
        try { if (fs.statSync(sp).isFile()) return path.join(ap, sess); } catch {}
      }
    }
  } catch {}
  return null;
}

// Strip a markdown frontmatter block, returning { name, description, body }.
function _frontmatter(text) {
  const t = String(text || '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(t);
  if (!m) return { name: null, description: null, body: t.trim() };
  const fm = m[1];
  const name = (/^name:\s*(.+)$/m.exec(fm) || [])[1];
  const desc = (/^description:\s*(.+)$/m.exec(fm) || [])[1];
  return { name: name ? name.trim().replace(/^["']|["']$/g, '') : null, description: desc ? desc.trim().replace(/^["']|["']$/g, '') : null, body: (m[2] || '').trim() };
}

/**
 * Read the Cowork spaces + their memory files. Returns [{ id, name, folders:[path], instructions,
 * origin, memory:[{ file, name, description, body }] }]. READ-ONLY. `deps.fs` injectable.
 */
function readCoworkSpaces(dir, { deps = {} } = {}) {
  const fs = deps.fs || require('fs');
  const base = dir || discoverDir({ fs });
  if (!base) return { ok: false, why: 'no Cowork spaces.json found (set COWORK_DIR)', spaces: [] };
  let doc;
  try { doc = JSON.parse(fs.readFileSync(path.join(base, 'spaces.json'), 'utf8')); }
  catch (e) { return { ok: false, why: `spaces.json unreadable: ${e.message}`, spaces: [] }; }
  const raw = Array.isArray(doc) ? doc : (doc.spaces || []);
  const spaces = raw.map((s) => {
    const id = s.id || s.uuid || '';
    const folders = (s.folders || []).map((f) => (typeof f === 'string' ? f : (f && f.path) || '')).filter(Boolean);
    const memDir = path.join(base, 'spaces', id, 'memory');
    const memory = [];
    try {
      for (const name of fs.readdirSync(memDir)) {
        if (/^MEMORY\.md$/i.test(name)) continue;   // the index file — the fact files are the substance
        const p = path.join(memDir, name);
        try { if (!fs.statSync(p).isFile()) continue; } catch { continue; }
        const fm = _frontmatter(fs.readFileSync(p, 'utf8'));
        memory.push({ file: name, name: fm.name || name.replace(/\.md$/, ''), description: fm.description, body: fm.body });
      }
    } catch { /* no memory dir for this space */ }
    return { id, name: s.name || s.title || '(unnamed)', folders, instructions: (s.instructions || s.customInstructions || '').trim(), origin: s.origin || null, memory };
  }).filter((s) => s.id);
  return { ok: true, base, spaces };
}

/**
 * Build the idempotent import plan. `imported` is the set of space ids already ported (from meta
 * cowork.imported_spaces); a space already imported is a 'skip'. Returns { create:[...], skip:[...],
 * totals }. Each create action names the project, the folder links, the verbatim law, and the facts —
 * everything the APPLY half needs, nothing it writes here.
 */
function buildPlan(spaces, { imported = [] } = {}) {
  const done = new Set(imported);
  const create = [], skip = [];
  for (const s of (spaces || [])) {
    const action = {
      spaceId: s.id, name: s.name, folders: s.folders,
      law: s.instructions || null,             // his verbatim instruction → a project-scoped law (never paraphrased)
      facts: s.memory.map((m) => ({ file: m.file, name: m.name, description: m.description || null, bytes: Buffer.byteLength(m.body || '', 'utf8'), body: m.body })),   // `file` rides into provenance (the p298 dedup lesson: it was dropped here)
    };
    (done.has(s.id) ? skip : create).push(action);
  }
  const factCount = create.reduce((n, a) => n + a.facts.length, 0);
  const withLaw = create.filter((a) => a.law).length;
  return { create, skip, totals: { spaces: (spaces || []).length, toCreate: create.length, toSkip: skip.length, laws: withLaw, facts: factCount } };
}

/** A human dry-run summary — one block per space to be created, so Lucas reviews before any write. */
function summarize(plan) {
  const lines = [`COWORK IMPORT PLAN — ${plan.totals.toCreate} to create, ${plan.totals.toSkip} already imported; ${plan.totals.laws} laws, ${plan.totals.facts} facts`];
  for (const a of plan.create) {
    lines.push(`\n• ${a.name}  [${a.spaceId.slice(0, 8)}]`);
    if (a.folders.length) lines.push(`    folders: ${a.folders.join(' · ')}`);
    if (a.law) lines.push(`    law: "${a.law.slice(0, 140)}${a.law.length > 140 ? '…' : ''}"`);
    for (const f of a.facts) lines.push(`    fact: ${f.name} (${f.bytes}c)${f.description ? ` — ${f.description.slice(0, 60)}` : ''}`);
  }
  for (const a of plan.skip) lines.push(`\n• ${a.name} — already imported (skip)`);
  return lines.join('\n');
}

// ── THE APPLY HALF (Lucas 09-04: "is it that binary?" — no: ONE project object per space, both halves) ──
// Bind each Cowork space onto its EXISTING Echo project (the May-20 Build 1 migration already created 9
// of the 11 — the same Rainey projects cataloged from two sides), create the missing rows through Echo's
// create_project door, land every law as a GLOBAL directive (his word: all global, verbatim), and every
// memory file as a directive (feedback_* = a rule in his words) or a memory fact (project_* = a fact).
// Idempotent: a marker in meta cowork.imported_spaces; directives dedupe by text; the project door upserts.
// Fail-soft per space — a down suit defers the project binding and never blocks the SQ-side laws.

const IMPORT_META = 'cowork.imported_spaces';
const PROJECT_TYPE_HINT = [               // the Cowork space → an Echo workflow type, for the rows that must be created
  [/legislative|tracker/i, 'tracker'],
  [/verification|fact check/i, 'verification_workspace'],
  [/polling/i, 'source_archive'],
  [/op-ed|quick hit|article|live event|webinar|list builder|briefing/i, 'output_library'],
  [/north dakota|permitting|proposal|research/i, 'research_topic'],
];
function inferProjectType(name) { for (const [re, t] of PROJECT_TYPE_HINT) if (re.test(name)) return t; return 'research_topic'; }
function _norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\b(on|and|the|of|amp)\b/g, ' ').replace(/\s+/g, ' ').trim(); }
/** The existing Echo project a space binds to: exact normalized name, else (unless `exact`) a prefix either way. */
function matchProject(spaceName, projects, { exact = false } = {}) {
  const n = _norm(spaceName);
  const names = (projects || []).map((p) => (typeof p === 'string' ? p : p.project_name)).filter(Boolean);
  const hit = names.find((p) => _norm(p) === n) || null;
  if (hit || exact) return hit;   // the claude.ai Projects bind by EXACT name only — a prefix twin must never swallow their documents
  return names.find((p) => { const m = _norm(p); return m.length >= 6 && (n.startsWith(m) || m.startsWith(n)); }) || null;
}
function readMarker(db) { try { return JSON.parse(db.getMeta(IMPORT_META) || '{}') || {}; } catch { return {}; } }
// Has this Cowork memory file already been stored as a fact? (provenance carries the space id + file.) The
// first live apply (p298) raced the suit attach: the binding deferred, the facts landed, and the retry
// stored them AGAIN — memory.store's dedup did not fold them. A deferred retry must redo ONLY the binding.
function _factExists(space, file) {
  try {
    const d = require('./db').getDb();
    return !!d.prepare("SELECT 1 FROM knowledge WHERE source='cowork-import' AND provenance LIKE ? AND provenance LIKE ? LIMIT 1")
      .get(`%"cowork_space":"${space}"%`, `%"file":"${file}"%`);
  } catch { return false; }
}

/**
 * Apply the plan. `deps`: dispatch (echo_suit.dispatch — null when the suit is down), directives,
 * memory, db, now. Returns { bound, created, laws, ruleFacts, facts, deferred, notes, perSpace }.
 */
async function applyPlan(plan, { deps = {} } = {}) {
  const dispatch = deps.dispatch || require('./echo_suit').dispatch;
  const directives = deps.directives || require('./directives');
  const memory = deps.memory || require('./memory');
  const db = deps.db || require('./db');
  const nowMs = deps.now || Date.now();
  const factExists = deps.factExists || _factExists;
  const out = { bound: 0, created: 0, laws: 0, ruleFacts: 0, facts: 0, factsSkipped: 0, deferred: 0, notes: [], perSpace: [] };
  const marker = readMarker(db);

  // one read of the existing Echo projects — the binding target
  let projects = null;
  try {
    const r = await dispatch({ kind: 'do', name: 'list_projects', args: {} });
    if (r && r.ok) { const data = JSON.parse(r.text); projects = Array.isArray(data && data.result) ? data.result : (Array.isArray(data) ? data : []); }
  } catch {}
  if (!projects) out.notes.push('Echo suit not reachable — project binding deferred; laws + facts land SQ-side');

  for (const a of (plan.create || [])) {
    const row = { spaceId: a.spaceId, name: a.name, project: null, action: null };
    // 1. the project object: bind to the existing Echo project, or create the row
    if (projects) {
      const hit = matchProject(a.name, projects);
      if (hit) { row.project = hit; row.action = 'bound'; out.bound++; }
      else {
        try {
          // THE PATH LAW (09-05): a project's `path` is Vault-RELATIVE — ingest_file files documents at
          // corpus_root/path and pathlib drops the base for an absolute path, so the first live apply
          // (which passed the Cowork folder here) would have filed the vault copies INTO his working
          // folder. Vault/<name> is the migration's own convention; the folder rides as source_folder,
          // passed only-when-set (guard #15 — the Echo door normalizes an absolute path the same way).
          const args = { project_name: a.name, project_type: inferProjectType(a.name), path: `Vault/${a.name}`, domain: 'rainey' };
          if (a.folders[0]) args.source_folder = a.folders[0];
          const r = await dispatch({ kind: 'do', name: 'create_project', args });
          const res = r && r.ok ? JSON.parse(r.text) : null;
          const body = res && res.result ? res.result : res;
          if (body && body.action && body.action !== 'rejected') { row.project = a.name; row.action = body.action; out.created++; }
          else { row.action = 'create-failed'; out.notes.push(`${a.name}: create_project ${(body && body.error) || 'failed'}`); }
        } catch (e) { row.action = 'create-failed'; out.notes.push(`${a.name}: ${e.message}`); }
      }
    } else { row.action = 'deferred'; out.deferred++; }
    // 2. the law — global, verbatim (his word)
    if (a.law) { try { if (directives.record(a.law, { turnId: null, now: nowMs })) out.laws++; } catch (e) { out.notes.push(`${a.name}: law ${e.message}`); } }
    // 3. the memory files: feedback_* = a rule in his words → directive; project_* = a fact → memory
    for (const f of (a.facts || [])) {
      const isRule = /^feedback_/i.test(f.file || '') || /^(never|always|do not|don't)\b/i.test(f.name || '');
      try {
        if (isRule) { if (directives.record(`${f.name}: ${f.body}`.slice(0, 400), { turnId: null, now: nowMs })) out.ruleFacts++; }
        else if (factExists(a.spaceId, f.file)) { out.factsSkipped++; }   // already stored — a deferred retry redoes only the binding
        else { const r = await memory.store({ kind: 'fact', content: `${f.name}\n\n${f.body}`, source: 'cowork-import', importance: 0.7, level: 'fact', provenance: { cowork_space: a.spaceId, file: f.file, project: row.project } }); if (r) out.facts++; }
      } catch (e) { out.notes.push(`${a.name}: fact ${f.name} ${e.message}`); }
    }
    // 4. the marker — only a bound/created space is "imported"; a deferred one is retried next pass
    if (row.project) marker[a.spaceId] = { project: row.project, action: row.action, at: nowMs };
    out.perSpace.push(row);
  }
  try { db.setMeta(IMPORT_META, JSON.stringify(marker)); } catch {}
  return out;
}

/**
 * THE REPAIR DOOR. The first live apply (p298) raced the suit attach and a retry stored each fact twice.
 * Retire the OLDER copy of every duplicate cowork-import fact — RETIRE, never delete (the append-only law):
 * importance → 0.2 + provenance.superseded through learning.retireVerifiedFact, the same door every other
 * superseded fact uses. The NEWEST copy is kept (it carries the bound project). Groups by Cowork space +
 * file, falling back to the content head for rows written before `file` rode into provenance. Runs
 * through the app's own db — a repair door, never a hand-run script against the live file.
 */
function dedupFacts({ deps = {} } = {}) {
  const d = deps.db || require('./db').getDb();
  const retire = deps.retire || ((id) => require('./learning').retireVerifiedFact(id, { by: 'cowork-import-dedup' }));
  const rows = d.prepare("SELECT id, content, provenance FROM knowledge WHERE source='cowork-import' ORDER BY id").all();
  const groups = new Map();
  for (const r of rows) {
    let p = {}; try { p = JSON.parse(r.provenance || '{}') || {}; } catch {}
    if (p.superseded) continue;   // already retired — never counted again
    const k = `${p.cowork_space || ''}|${p.file || String(r.content || '').slice(0, 60)}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r.id);
  }
  let retired = 0; const kept = [];
  for (const ids of groups.values()) {
    if (ids.length < 2) continue;
    kept.push(ids[ids.length - 1]);                       // the newest carries the bound project
    for (const id of ids.slice(0, -1)) { try { if (retire(id)) retired++; } catch {} }
  }
  return { groups: groups.size, duplicates: retired, retired, kept };
}

// ── THE FILES HALF — Cowork ports P2 + P3 (2026-09-05; docs/ZOE_BUILD_PLAN §2 rows P2, P3) ─────────
// P2: the 3 synced claude.ai Projects (.project-cache/<uuid>/{metadata.json, files/, docs/}) → ONE project
// object each (bind to the existing Echo project or create it — the P1 law), the prompt_template → a
// writer-role GUIDE on the skill shelf (its body in the knowledge store with Cowork provenance; the shelf
// row points at it as fact:<id>), the attached files + the cached briefings → documents.
// P3: the 10 project folders under Documents\Claude\Projects (122 files) → documents filed under the
// SPACE's bound project (a folder IS a space's folder; its name is the space's name).
// Every document lands through Echo's own ingest_file door with the project as its origin (birth
// context) + extract_entities_from_doc — the promote pass's locked recipe — and NEVER move=true: the
// Cowork side stays read-only. Idempotent by file key (path + size + mtime) in meta cowork.imported_files;
// a TERMINAL door answer (unsupported / extraction_failed) is recorded so it never re-tries; a TRANSPORT
// failure (suit down, a locked file, a rejected path) is NOT recorded — the next pass retries it (the p298
// lesson). Bounded per call (`limit`): the door is re-invoked until `remaining` is 0.
// THE PATH LAW pre-flight: before filing, every target project's stored path is read back; an ABSOLUTE
// one (the two rows the first apply created) is re-upserted to Vault/<name> through the same create door
// — the repair rides the app's own suit, never a hand script.

const FILES_META = 'cowork.imported_files';
const TEMPLATES_META = 'cowork.imported_templates';
const TERMINAL_ACTIONS = new Set(['unsupported', 'extraction_failed']);

function discoverProjectsRoot({ env = process.env } = {}) {
  if (env.COWORK_PROJECTS_DIR) return env.COWORK_PROJECTS_DIR;
  const home = env.USERPROFILE || env.HOME || '';
  return home ? path.join(home, 'Documents', 'Claude', 'Projects') : null;
}
function _fileKey(abs, st) {
  return require('crypto').createHash('sha1').update(`${String(abs).replace(/\\/g, '/').toLowerCase()}|${st.size}|${Math.round(st.mtimeMs || 0)}`).digest('hex').slice(0, 16);
}
function _fileRec(fs, abs, name) {
  let st; try { st = fs.statSync(abs); } catch { return null; }
  if (!st.isFile()) return null;
  return { key: _fileKey(abs, st), abs, name, ext: path.extname(name).toLowerCase(), bytes: st.size, mtimeMs: Math.round(st.mtimeMs || 0) };
}
function _listFiles(fs, dir) {
  const out = [];
  let names = []; try { names = fs.readdirSync(dir); } catch { return out; }
  for (const n of names) { if (n.startsWith('.')) continue; const r = _fileRec(fs, path.join(dir, n), n); if (r) out.push(r); }
  return out;
}
function _walk(fs, dir, out, depth = 0) {
  if (depth > 6) return;
  let names = []; try { names = fs.readdirSync(dir); } catch { return; }
  for (const n of names) {
    if (n.startsWith('.')) continue;
    const abs = path.join(dir, n);
    let st; try { st = fs.statSync(abs); } catch { continue; }
    if (st.isDirectory()) _walk(fs, abs, out, depth + 1);
    else { const r = _fileRec(fs, abs, n); if (r) out.push(r); }
  }
}

/** The 3 synced claude.ai Projects under <cowork dir>/.project-cache. READ-ONLY. `deps.fs` injectable. */
function readProjectCache(base, { deps = {} } = {}) {
  const fs = deps.fs || require('fs');
  const root = base || discoverDir({ fs, env: deps.env || process.env });
  if (!root) return { ok: false, why: 'no Cowork dir found (set COWORK_DIR)', projects: [] };
  const cacheDir = path.join(root, '.project-cache');
  const projects = [];
  let ids = []; try { ids = fs.readdirSync(cacheDir); } catch { return { ok: true, projects, note: 'no .project-cache under the Cowork dir' }; }
  for (const id of ids) {
    const pd = path.join(cacheDir, id);
    let meta = null; try { meta = JSON.parse(fs.readFileSync(path.join(pd, 'metadata.json'), 'utf8')); } catch { continue; }
    projects.push({
      uuid: meta.uuid || id, name: (meta.name || id).trim(), description: (meta.description || '').trim(),
      promptTemplate: (meta.prompt_template || '').trim(), syncedAt: meta.synced_at || null,
      files: _listFiles(fs, path.join(pd, 'files')), docs: _listFiles(fs, path.join(pd, 'docs')),
    });
  }
  return { ok: true, base: cacheDir, projects };
}

/** The project folders on disk (Documents\Claude\Projects\<space name>\…). READ-ONLY, recursive. */
function readProjectFolders(root, { deps = {} } = {}) {
  const fs = deps.fs || require('fs');
  const base = root || discoverProjectsRoot({ env: deps.env || process.env });
  if (!base) return { ok: false, why: 'no Documents\\Claude\\Projects dir (set COWORK_PROJECTS_DIR)', folders: [] };
  let names = []; try { names = fs.readdirSync(base); } catch (e) { return { ok: false, why: `projects dir unreadable: ${e.message}`, folders: [] }; }
  const folders = [];
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const abs = path.join(base, name);
    try { if (!fs.statSync(abs).isDirectory()) continue; } catch { continue; }
    const files = []; _walk(fs, abs, files);
    folders.push({ name, abs, files });
  }
  return { ok: true, base, folders };
}

function readFilesMarker(db) { try { return JSON.parse(db.getMeta(FILES_META) || '{}') || {}; } catch { return {}; } }
function readTemplatesMarker(db) { try { return JSON.parse(db.getMeta(TEMPLATES_META) || '{}') || {}; } catch { return {}; } }
const _normPath = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** The space a project folder belongs to: its path is one of the space's folders, else its name is the space's name. */
function spaceForFolder(folder, spaces) {
  const fp = _normPath(folder.abs);
  return (spaces || []).find((s) => (s.folders || []).some((f) => _normPath(f) === fp))
    || (spaces || []).find((s) => _norm(s.name) === _norm(folder.name)) || null;
}

/**
 * Build the files plan. Every file becomes an item {key, abs, name, ext, bytes, origin, project, status};
 * status = 'new' (to ingest) | 'done' | 'terminal' (recorded by the marker) | 'unbound' (its space has no
 * bound project yet — run /cowork/import first). Claude-project items carry project=null + projectHint
 * until the apply binds/creates their project. Templates: one per claude.ai Project with a prompt_template
 * not yet registered. READ-ONLY; writes nothing.
 */
function buildFilePlan({ cache = [], folders = [], spaces = [], spacesMarker = {}, filesMarker = {}, templatesMarker = {}, projects = null } = {}) {
  const items = [];
  const status = (rec) => { const m = filesMarker[rec.key]; if (!m) return 'new'; return m.doc_id ? 'done' : 'terminal'; };
  // the claude.ai Projects' binding decisions, named for review: bind by EXACT name (a prefix twin never
  // swallows 34 briefings) or create; `projects` = Echo's list when the door could read it, else 'unread'
  const bindings = cache.map((p) => {
    const hit = projects ? matchProject(p.name, projects, { exact: true }) : null;
    return { uuid: p.uuid, name: p.name, action: hit ? 'bind' : (projects ? 'create' : 'unread'), project: hit || p.name, type: inferProjectType(p.name) };
  });
  for (const p of cache) {
    const b = bindings.find((x) => x.uuid === p.uuid);
    const project = b.action === 'bind' ? b.project : null;
    for (const rec of [...p.files, ...p.docs]) items.push({ ...rec, origin: { kind: 'claude-project', id: p.uuid, name: p.name }, project, projectHint: b.project, status: status(rec), prior: filesMarker[rec.key] || null });
  }
  const unboundSpaces = new Set();
  for (const f of folders) {
    const sp = spaceForFolder(f, spaces);
    const project = sp && spacesMarker[sp.id] && spacesMarker[sp.id].project ? spacesMarker[sp.id].project : null;
    if (!project) unboundSpaces.add(f.name);
    for (const rec of f.files) items.push({ ...rec, origin: { kind: 'space', id: sp ? sp.id : null, name: sp ? sp.name : f.name }, project, projectHint: sp ? sp.name : f.name, status: project ? status(rec) : 'unbound', prior: filesMarker[rec.key] || null });
  }
  const templates = cache.filter((p) => p.promptTemplate && !templatesMarker[p.uuid]).map((p) => ({ uuid: p.uuid, name: p.name, description: p.description, body: p.promptTemplate }));
  const totals = { files: items.length, toIngest: 0, done: 0, terminal: 0, unbound: 0, bytes: 0, byProject: {}, byExt: {}, templates: templates.length, templatesDone: cache.filter((p) => p.promptTemplate && templatesMarker[p.uuid]).length };
  for (const it of items) {
    totals.bytes += it.bytes;
    if (it.status === 'new') totals.toIngest++; else if (it.status === 'done') totals.done++; else if (it.status === 'terminal') totals.terminal++; else totals.unbound++;
    const pk = it.projectHint; totals.byProject[pk] = totals.byProject[pk] || { files: 0, bytes: 0, toIngest: 0 }; totals.byProject[pk].files++; totals.byProject[pk].bytes += it.bytes; if (it.status === 'new') totals.byProject[pk].toIngest++;
    totals.byExt[it.ext || '(none)'] = (totals.byExt[it.ext || '(none)'] || 0) + 1;
  }
  return { items, templates, bindings, totals, unboundSpaces: [...unboundSpaces] };
}

/** A human dry-run summary, per project. */
function summarizeFiles(plan) {
  const t = plan.totals;
  const lines = [`COWORK FILES PLAN — ${t.files} files (${(t.bytes / 1048576).toFixed(1)} MB): ${t.toIngest} to ingest, ${t.done} done, ${t.terminal} terminal, ${t.unbound} unbound; ${t.templates} template(s) to register (${t.templatesDone} done)`];
  for (const [name, v] of Object.entries(t.byProject).sort((a, b) => b[1].files - a[1].files)) lines.push(`• ${name}: ${v.files} files, ${(v.bytes / 1048576).toFixed(1)} MB, ${v.toIngest} to ingest`);
  lines.push(`by type: ${Object.entries(t.byExt).sort((a, b) => b[1] - a[1]).map(([e, n]) => `${e} ${n}`).join(' · ')}`);
  for (const b of (plan.bindings || [])) lines.push(`• claude.ai Project "${b.name}" → ${b.action === 'bind' ? `bind "${b.project}"` : (b.action === 'create' ? `CREATE as ${b.type}` : 'unread (suit down) — decided at apply')}`);
  for (const tp of plan.templates) lines.push(`• template: ${tp.name} (${tp.body.length}c) → a writer guide on the shelf`);
  if (plan.unboundSpaces.length) lines.push(`⚠ unbound folders (run POST /cowork/import {apply:true} first): ${plan.unboundSpaces.join(' · ')}`);
  return lines.join('\n');
}

const _parseBody = (r) => { try { const d = JSON.parse(r.text); return d && d.result && typeof d.result === 'object' ? d.result : d; } catch { return null; } };
const _isAbsolute = (p) => /^([A-Za-z]:|\/|\\)/.test(String(p || '').trim());
const _knowledgeId = (r) => (r == null ? null : (typeof r === 'object' ? (r.id ?? r.lastInsertRowid ?? null) : (Number(r) || null)));

/**
 * Apply the files plan — ONE bounded batch. `deps`: dispatch, db, memory, skills, now, limit (default 25).
 * Returns { bound, created, normalized, templates, templatesSkipped, ingested, entities, terminal, failed,
 * deferred, remaining, notes, perProject }.
 */
async function applyFilePlan(plan, { deps = {} } = {}) {
  const dispatch = deps.dispatch || require('./echo_suit').dispatch;
  const db = deps.db || require('./db');
  const memory = deps.memory || require('./memory');
  const skills = deps.skills || require('./skills');
  const nowMs = deps.now || Date.now();
  const limit = Math.max(1, Number(deps.limit) || 25);
  const timeBudgetMs = Number(deps.timeBudgetMs) || 0;
  const out = { bound: 0, created: 0, normalized: 0, templates: 0, templatesSkipped: 0, ingested: 0, entities: 0, terminal: 0, failed: 0, deferred: 0, remaining: 0, budgetHit: false, notes: [], perProject: {} };
  const filesMarker = readFilesMarker(db);
  const templatesMarker = readTemplatesMarker(db);
  const call = async (name, args) => { try { const r = await dispatch({ kind: 'do', name, args }); return r && r.ok && !r.isError ? r : null; } catch { return null; } };

  // 0. the suit — a down suit defers everything (never marks; the p298 lesson)
  let projects = null;
  const lp = await call('list_projects', {});
  if (lp) { const d = _parseBody(lp); projects = Array.isArray(d) ? d : (d && Array.isArray(d.result) ? d.result : []); }
  const pending = plan.items.filter((it) => it.status === 'new' && (it.project || it.origin.kind === 'claude-project'));
  if (!projects) { out.deferred = pending.length + plan.templates.length; out.remaining = pending.length; out.notes.push('Echo suit not reachable — nothing filed; retried on the next call'); return out; }

  // 1. the claude.ai Projects: bind by EXACT name or create (the P1 law), then every item of theirs knows its project
  const projectByOrigin = {};
  const bindings = plan.bindings || [...new Map(plan.items.filter((i) => i.origin.kind === 'claude-project').map((i) => [i.origin.id, { uuid: i.origin.id, name: i.origin.name, type: inferProjectType(i.origin.name) }])).values()];
  for (const b of bindings) {
    const hit = matchProject(b.name, projects, { exact: true });
    if (hit) { projectByOrigin[b.uuid] = hit; out.bound++; continue; }
    const r = await call('create_project', { project_name: b.name, project_type: b.type || inferProjectType(b.name), path: `Vault/${b.name}`, domain: 'rainey' });
    const body = r ? _parseBody(r) : null;
    if (body && body.action && body.action !== 'rejected') { projectByOrigin[b.uuid] = b.name; out.created++; projects.push({ project_name: b.name, path: `Vault/${b.name}` }); }
    else out.notes.push(`${b.name}: create_project ${(body && body.error) || 'unreachable'} — its files wait`);
  }
  for (const it of plan.items) if (!it.project && it.origin.kind === 'claude-project' && projectByOrigin[it.origin.id]) it.project = projectByOrigin[it.origin.id];

  // 2. THE PATH LAW pre-flight — every target project's stored path must be Vault-relative before a file lands
  const targets = [...new Set(plan.items.filter((it) => it.status === 'new' && it.project).map((it) => it.project))];
  const safe = new Set();
  for (const name of targets) {
    const g = await call('get_project', { project_name: name });
    const proj = g ? _parseBody(g) : null;
    if (!proj || proj.error) { out.notes.push(`${name}: get_project ${(proj && proj.error) || 'unreachable'} — its files wait`); continue; }
    if (_isAbsolute(proj.path)) {
      const args = { project_name: name, project_type: proj.project_type || inferProjectType(name), path: `Vault/${name}`, source_folder: proj.path };
      if (proj.domain) args.domain = proj.domain;
      const r = await call('create_project', args);
      const body = r ? _parseBody(r) : null;
      if (!(body && body.action && body.action !== 'rejected' && !_isAbsolute(body.path))) { out.notes.push(`${name}: absolute path could not be normalized — its files wait (never filed outside the Vault)`); continue; }
      // READ IT BACK — the door's answer is not the proof; the stored row is. On p300 a cache between
      // us and the engine (the suit's route memo, before `create_` joined its write set) served the
      // pre-write row here on the next batch; a file must never be filed on a path that only the
      // door's reply says is safe.
      const g2 = await call('get_project', { project_name: name });
      const back = g2 ? _parseBody(g2) : null;
      if (!back || back.error || _isAbsolute(back.path)) { out.notes.push(`${name}: path still reads absolute after the repair (a stale read) — its files wait (never filed outside the Vault)`); continue; }
      out.normalized++; out.notes.push(`${name}: path normalized ${proj.path} → ${back.path}`);
    }
    safe.add(name);
  }

  // 3. the prompt templates → the knowledge store + a writer guide on the shelf (cheap; before the files)
  for (const tp of plan.templates) {
    if (templatesMarker[tp.uuid]) { out.templatesSkipped++; continue; }
    try {
      const r = await memory.store({ kind: 'fact', content: `${tp.name} — prompt template (claude.ai Project)\n\n${tp.body}`, source: 'cowork-import', importance: 0.7, level: 'fact', provenance: { claude_project: tp.uuid, kind: 'prompt_template', project: projectByOrigin[tp.uuid] || null } });
      const id = _knowledgeId(r);
      if (!id) { out.notes.push(`${tp.name}: template not stored`); continue; }
      const reg = skills.register({ name: `cowork-${tp.name}`, triggerDesc: `${tp.name}: ${tp.description || 'his claude.ai Project instructions'}`.slice(0, 140), kind: 'guide', bodyRef: `fact:${id}`, provenance: 'cowork-import', nowMs });
      templatesMarker[tp.uuid] = { factId: id, skill: reg && reg.name, at: nowMs };
      out.templates++;
    } catch (e) { out.notes.push(`${tp.name}: template ${e.message}`); }
  }

  // 4. the files — one bounded batch through ingest_file (+entities), the promote pass's locked recipe
  const promote = require('./promote');
  const queue = plan.items.filter((it) => it.status === 'new' && it.project && safe.has(it.project));
  let done = 0;
  const started = Date.now();
  for (const it of queue) {
    if (done >= limit) break;
    if (timeBudgetMs > 0 && done > 0 && Date.now() - started > timeBudgetMs) { out.budgetHit = true; break; }   // the rest keep their turn
    done++;
    const pp = out.perProject[it.project] = out.perProject[it.project] || { ingested: 0, terminal: 0, failed: 0 };
    const r = await call('ingest_file', { source_path: it.abs, project_name: it.project, move: false });
    const body = r ? _parseBody(r) : null;
    const action = body && body.action;
    const docId = body ? promote.parseEchoDocId(body) : null;
    if (action === 'ingested' && docId) {
      let ents = false;
      if (await call('extract_entities_from_doc', { doc_id: docId })) { ents = true; out.entities++; }
      filesMarker[it.key] = { doc_id: docId, project: it.project, name: it.name, origin: it.origin.kind, entities: ents, at: nowMs };
      out.ingested++; pp.ingested++;
    } else if (TERMINAL_ACTIONS.has(action)) {
      filesMarker[it.key] = { action, error: String(body.error || '').slice(0, 160), project: it.project, name: it.name, origin: it.origin.kind, at: nowMs };
      out.terminal++; pp.terminal++;
    } else {
      out.failed++; pp.failed++;   // transport / locked / rejected — NOT recorded; the next call retries it
      if (out.notes.length < 12) out.notes.push(`${it.name}: ${action || 'no answer'} ${String((body && body.error) || (r && r.text) || '').slice(0, 100)}`);
    }
  }
  out.remaining = queue.length - done + plan.items.filter((it) => it.status === 'new' && it.project && !safe.has(it.project)).length;
  try { db.setMeta(FILES_META, JSON.stringify(filesMarker)); db.setMeta(TEMPLATES_META, JSON.stringify(templatesMarker)); } catch {}
  return out;
}

module.exports = {
  readCoworkSpaces, buildPlan, summarize, discoverDir, applyPlan, dedupFacts, matchProject, inferProjectType, readMarker, IMPORT_META, _frontmatter,
  // the files half (P2 + P3)
  readProjectCache, readProjectFolders, discoverProjectsRoot, buildFilePlan, summarizeFiles, applyFilePlan, spaceForFolder, readFilesMarker, readTemplatesMarker, FILES_META, TEMPLATES_META, TERMINAL_ACTIONS,
};
