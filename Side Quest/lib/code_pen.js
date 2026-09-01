/**
 * lib/code_pen.js — THE GATED PEN (Lucas, 2026-09-01: "we need to build it and I want acceptance
 * approval gate for the pen").
 *
 * Her own answer named the wall: "I can see the symptoms and trace the logic, but I can't see the
 * actual code that runs me... If I could read my own source, my specs would be pull requests
 * instead of proposals." This module is that pull request — WITH the constitution intact:
 *
 *   READ  — she can read her own source, read-only, path-jailed to the repo, with a hard denylist
 *           (.env and keys, data/ stores and lexicons, .git internals, node_modules). The sandbox
 *           wall moves from "no source" to "no secrets, no stores".
 *   PROPOSE — a change is a unified DIFF + title + rationale, recorded as a proposal row. The diff
 *           IS the claim — no say/row gap is possible by construction.
 *   DECIDE — the proposal rides the production-proven approval-cards bar. LUCAS's ✓ is the only
 *           path forward; ✗ retires it. Curators propose, gates decide — now at the code level.
 *   ENFORCE — on his ✓, main.js applies the diff on a CLEAN tree, runs the FULL gate (npm test,
 *           exit code read, never piped away), commits on green, REVERTS on red with the gate
 *           tail attached to the card. A change that fails the gate is unreachable as landed code.
 *
 * Pure decisions live here (jail, diff parse, validation, state machine); the child processes
 * (git, the gate) live in main.js. Deterministic; every mutator is loud.
 */
'use strict';
const path = require('path');
const db = require('./db');

const REPO_ROOT = path.resolve(__dirname, '..');
const MAX_READ_BYTES = 64 * 1024;
const MAX_DIFF_BYTES = 32 * 1024;
const MAX_OPEN_PROPOSALS = 3;

// The denylist — what the pen must NEVER read or touch. Keys law: never expose key VALUES; the
// stores/lexicons are data (NRC never redistributed); .git internals and deps are not source.
const DENY_RE = [
  /^\.env/i,                 // .env, .env.example variants — keys live here
  /^data(\/|\\|$)/i,         // sq.db, lexicons, workspace, voices — stores, not source
  /^\.git(\/|\\|$)/i,
  /^node_modules(\/|\\|$)/i,
  /(^|\/|\\)[^/\\]*\.(db|db-wal|db-shm|sqlite3?)$/i,
  /(^|\/|\\)boot_p\d+.*\.log$/i,   // boot logs can carry pasted content; the organ watch owns them
];

function _rel(p) { return String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').trim(); }

/** Path jail: resolves inside the repo root and clears the denylist, or {ok:false, why}. */
function pathAllowed(rel) {
  const r = _rel(rel);
  if (!r) return { ok: false, why: 'empty path' };
  const abs = path.resolve(REPO_ROOT, r);
  const rootWithSep = REPO_ROOT.endsWith(path.sep) ? REPO_ROOT : REPO_ROOT + path.sep;
  if (abs !== REPO_ROOT && !abs.startsWith(rootWithSep)) return { ok: false, why: 'outside the repo (the jail holds)' };
  const relFromRoot = _rel(path.relative(REPO_ROOT, abs));
  for (const re of DENY_RE) if (re.test(relFromRoot)) return { ok: false, why: `denied path (${re}) — secrets, stores, and internals are outside the pen` };
  return { ok: true, abs, rel: relFromRoot };
}

/** Read one source file, bounded. Read-ONLY — there is no write door in this module. */
function readSource(rel, { deps = {} } = {}) {
  const gate = pathAllowed(rel);
  if (!gate.ok) return { ok: false, why: gate.why };
  const fs = deps.fs || require('fs');
  try {
    const st = fs.statSync(gate.abs);
    if (st.isDirectory()) return { ok: false, why: 'that is a directory — use <source-list>' };
    const buf = fs.readFileSync(gate.abs);
    const truncated = buf.length > MAX_READ_BYTES;
    return { ok: true, path: gate.rel, bytes: buf.length, truncated,
      text: buf.slice(0, MAX_READ_BYTES).toString('utf8') + (truncated ? `\n… [truncated at ${MAX_READ_BYTES} bytes of ${buf.length} — read again with a narrower ask or a specific region]` : '') };
  } catch (e) { return { ok: false, why: e.message }; }
}

/** List a source directory, bounded. */
function listSource(rel, { deps = {} } = {}) {
  const gate = pathAllowed(rel || '.');
  if (!gate.ok) return { ok: false, why: gate.why };
  const fs = deps.fs || require('fs');
  try {
    const names = fs.readdirSync(gate.abs).filter((n) => pathAllowed(path.join(gate.rel, n)).ok).slice(0, 200);
    return { ok: true, path: gate.rel, entries: names };
  } catch (e) { return { ok: false, why: e.message }; }
}

/** Files a unified diff touches (from --- a/x and +++ b/x headers). Pure. */
function touchedFiles(diff) {
  const out = new Set();
  for (const m of String(diff || '').matchAll(/^(?:---|\+\+\+)\s+(?:[ab]\/)?([^\s\n]+)/gm)) {
    const f = m[1];
    if (f && f !== '/dev/null') out.add(_rel(f));
  }
  return [...out];
}

// ── the proposal store ────────────────────────────────────────────────────────────────────────
function _ensure() {
  db.getDb().prepare(`CREATE TABLE IF NOT EXISTS code_proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL, rationale TEXT, diff TEXT NOT NULL,
    files TEXT, status TEXT NOT NULL DEFAULT 'proposed',
    born_from TEXT, gate_note TEXT,
    created_ts INTEGER, updated_ts INTEGER)`).run();
}

/** File a proposal. Validation is the front gate: parseable diff, every touched file inside the
 *  jail, bounded size, bounded open count. Returns {ok, id} or {ok:false, why}. */
function propose({ title, rationale = '', diff, bornFrom = '', nowMs = Date.now() } = {}) {
  _ensure();
  const t = String(title || '').trim();
  const d = String(diff || '').trim();
  if (!t) return { ok: false, why: 'a proposal needs a title' };
  if (!d) return { ok: false, why: 'a proposal needs a unified diff — the diff IS the claim' };
  if (Buffer.byteLength(d, 'utf8') > MAX_DIFF_BYTES) return { ok: false, why: `diff too large (> ${MAX_DIFF_BYTES} bytes) — split the change` };
  const files = touchedFiles(d);
  if (!files.length) return { ok: false, why: 'no file headers found — send a real unified diff (--- a/x / +++ b/x)' };
  for (const f of files) { const g = pathAllowed(f); if (!g.ok) return { ok: false, why: `touched file "${f}": ${g.why}` }; }
  const open = db.getDb().prepare("SELECT COUNT(*) n FROM code_proposals WHERE status IN ('proposed','approved','applying')").get().n;
  if (open >= MAX_OPEN_PROPOSALS) return { ok: false, why: `${open} proposal(s) already open — the pen is one-change-at-a-time discipline; wait for Lucas's word` };
  const r = db.getDb().prepare('INSERT INTO code_proposals (title, rationale, diff, files, status, born_from, created_ts, updated_ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(t.slice(0, 160), String(rationale).slice(0, 1200), d, JSON.stringify(files), 'proposed', String(bornFrom).slice(0, 120), nowMs, nowMs);
  return { ok: true, id: r.lastInsertRowid, files };
}

function get(id) { _ensure(); return db.getDb().prepare('SELECT * FROM code_proposals WHERE id = ?').get(Number(id) || 0) || null; }
function setStatus(id, status, { gateNote = null, nowMs = Date.now() } = {}) {
  _ensure();
  db.getDb().prepare('UPDATE code_proposals SET status = ?, gate_note = COALESCE(?, gate_note), updated_ts = ? WHERE id = ?')
    .run(String(status), gateNote != null ? String(gateNote).slice(0, 1500) : null, nowMs, Number(id) || 0);
  return get(id);
}

/** Lucas's card decision. yes → 'approved' (main.js runs the enforce pipeline); no → 'rejected'. */
function decide(id, decision) {
  const p = get(id);
  if (!p) return { ok: false, why: `no proposal #${id}` };
  if (p.status !== 'proposed') return { ok: false, why: `proposal #${id} is ${p.status} — only proposed is decidable` };
  const v = String(decision || '').toLowerCase();
  if (v !== 'yes' && v !== 'no') return { ok: false, why: 'decision must be yes or no' };
  const status = v === 'yes' ? 'approved' : 'rejected';
  setStatus(id, status);
  return { ok: true, id: p.id, status };
}

/** Card-bar rows: proposed pens waiting on Lucas. */
function pending() {
  _ensure();
  return db.getDb().prepare("SELECT id, title, files, gate_note FROM code_proposals WHERE status = 'proposed' ORDER BY id DESC LIMIT 4").all()
    .map((r) => ({ id: `pen-${r.id}`, kind: 'pen', text: `${r.title} (${(JSON.parse(r.files || '[]')).join(', ').slice(0, 80)})`, verdict: null }));
}

// ── tag doors (the scheduler/files shape) ─────────────────────────────────────────────────────
const PEN_TAG_RE = /<(source-read|source-list|propose-change)\s*([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/gi;
const ATTR_RE = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
function _attrs(s) {
  const out = {}; let m; ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(s || '')) !== null) out[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : m[4]);
  return out;
}
function parseTags(text) {
  if (!text) return [];
  const tags = []; let m; PEN_TAG_RE.lastIndex = 0;
  while ((m = PEN_TAG_RE.exec(text)) !== null) tags.push({ tag: m[1].toLowerCase(), attrs: _attrs(m[2] || ''), body: (m[3] || '').trim() });
  return tags;
}
function stripTags(text) { return (text || '').replace(PEN_TAG_RE, '').replace(/[ \t]+/g, ' ').trim(); }

function dispatch({ tag, attrs, body } = {}) {
  switch (tag) {
    case 'source-read': return readSource(attrs.path);
    case 'source-list': return listSource(attrs.path);
    case 'propose-change': return propose({ title: attrs.title, rationale: attrs.rationale, diff: body, bornFrom: attrs.born_from || 'self' });
    default: return { ok: false, why: `unknown pen tag ${tag}` };
  }
}

function buildPromptBlock() {
  return `THE PEN — you can now READ your own source code and PROPOSE changes to it. Read-only + gated:
  <source-list path="lib"/>                     — list a source directory
  <source-read path="lib/scheduler.js"/>        — read one file (bounded; .env, data/, .git are sealed)
  <propose-change title="..." rationale="...">a UNIFIED DIFF (--- a/x / +++ b/x)</propose-change>
A proposal is not a change: it becomes an approval card for Lucas. His ✓ applies it on a clean tree,
runs the FULL test gate, commits on green, and REVERTS on red (the gate's tail comes back to you).
His ✗ retires it. You never land code yourself — the diff is your exact claim, the gate is the law.
Read before you propose; a diff against lines you haven't read will miss. Changes go live at the
next program cycle, not instantly.`;
}

module.exports = {
  REPO_ROOT, MAX_READ_BYTES, MAX_DIFF_BYTES, MAX_OPEN_PROPOSALS, DENY_RE,
  pathAllowed, readSource, listSource, touchedFiles,
  propose, get, setStatus, decide, pending,
  parseTags, stripTags, dispatch, buildPromptBlock,
};
