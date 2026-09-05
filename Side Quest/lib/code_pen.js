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
const fs = require('fs');
const path = require('path');
const db = require('./db');

const REPO_ROOT = path.resolve(__dirname, '..');
// Stage 5.2 (Lucas 09-04, "one pen"): the jail reaches the Echo engine too, so she can cure + extend
// Echo herself. ECHO_ROOT resolves from the same env the engine bridge uses (lib/echo.js / engine.js).
const ECHO_ROOT = path.resolve(process.env.ECHO_CWD || 'C:/Users/azrae/Desktop/NX ECHO/nx-echo');
const REPOS = { sq: REPO_ROOT, echo: ECHO_ROOT };
const MAX_READ_BYTES = 64 * 1024;
const MAX_DIFF_BYTES = 32 * 1024;
const MAX_OPEN_PROPOSALS = 3;

// The HARD denylist — what the pen must NEVER read or touch, per repo. Keys law: never expose key VALUES;
// the stores/lexicons are data (NRC never redistributed); .git internals and deps are not source. These
// are secrets/stores/binaries — NOT boundary files — so they stay hard-denied: the pen writes code, not
// secrets, and no legitimate code diff needs them.
const DENY_RE = [
  /(^|\/|\\)\.env[^/\\]*$/i, // .env, .env.example variants at ANY depth — keys live here (audit F38)
  /^data(\/|\\|$)/i,         // sq.db, lexicons, workspace, voices — stores, not source
  /(^|\/|\\)\.git(\/|\\|$)/i,
  /(^|\/|\\)node_modules(\/|\\|$)/i,
  /^\.claude(\/|\\|$)/i,     // harness settings/hooks — a hook runs OUTSIDE the gate, and gitignored files have no revert (audit F11)
  /(^|\/|\\)[^/\\]*\.(db|db-wal|db-shm|sqlite3?)$/i,
  /(^|\/|\\)boot_p\d+.*\.log$/i,   // boot logs can carry pasted content; the organ watch owns them
  /(^|\/|\\)boot_self\.log(\.\d+)?$/i,   // the console tee (self-reboot generations) — same class
  /(^|\/|\\)pen_gate_\d+\.log$/i,        // full gate logs — operator forensics, not her source
  /(^|\/|\\)boot_cycle\.(log|lock)$/i,   // the outside cycler's log/lock — same class as every log
];
// Echo's hard denylist: its secrets (config.toml carries the tokens), the 9-32GB data foundations, the
// venv, caches, DBs, and the dependency lock (a pin bump is a deliberate act, not a pen edit).
const ECHO_DENY_RE = [
  /(^|\/|\\)\.env[^/\\]*$/i,
  /(^|\/|\\)config\.toml$/i,                 // Echo's shared/write/admin tokens live here (the audit flags it)
  /^data(\/|\\|$)/i,                          // civic_graph / electoral / saga / general_knowledge / corpus …
  /(^|\/|\\)foundations(\/|\\|$)/i,
  /(^|\/|\\)\.git(\/|\\|$)/i,
  /(^|\/|\\)\.venv(\/|\\|$)/i,
  /(^|\/|\\)node_modules(\/|\\|$)/i,
  /(^|\/|\\)__pycache__(\/|\\|$)/i,
  /(^|\/|\\)\.pytest_cache(\/|\\|$)/i,
  /(^|\/|\\)[^/\\]*\.(db|db-wal|db-shm|sqlite3?)$/i,
  /(^|\/|\\)uv\.lock$/i,                       // dependency pins — deliberate, not a pen edit
  /(^|\/|\\)[^/\\]*\.log$/i,
];
const DENY = { sq: DENY_RE, echo: ECHO_DENY_RE };

// THE CONSTITUTIONAL SET — the boundary/pen-defining source. Lucas 09-04 ("loosen the boundary as much as
// possible"): these are NOT blocked — she may read, propose, and land changes to them — but a proposal that
// touches one is FLAGGED constitutional, and main.js lands it ONLY behind his explicit out-of-band confirm
// (meta pen.allow_constitutional), never the reflexive card ✓. The one invariant kept: a boundary the agent
// can quietly widen is not a boundary. Everything else across both repos is the ordinary gate + ✓.
const CONSTITUTIONAL = {
  sq: [
    /^lib[/\\]security_scope\.js$/i,   // THE owned-asset boundary (authz + injection defense)
    /^lib[/\\]code_pen\.js$/i,         // the pen's own jail + audit
    /^lib[/\\]self_source\.js$/i,      // the read/clone jail
    /^lib[/\\]unified_gate\.js$/i,     // the gate she is judged by
    /^scripts[/\\]boot_cycle\.py$/i,   // the outside hand + its live-guard
  ],
  echo: [],   // Echo carries no boundary-defining files today (scope + gate live SQ-side)
};
function _isConstitutional(repo, rel) { return (CONSTITUTIONAL[repo] || []).some((re) => re.test(String(rel || ''))); }

function _rel(p) { return String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').trim(); }
function _repoOf(repo) { return (repo === 'echo') ? 'echo' : 'sq'; }

/** Path jail: resolves inside the chosen repo root and clears that repo's denylist, or {ok:false, why}.
 *  `repo` is 'sq' (default) or 'echo'. A boundary-defining file is allowed but flagged constitutional. */
function pathAllowed(rel, { repo = 'sq' } = {}) {
  const rk = _repoOf(repo);
  const root = REPOS[rk];
  const r = _rel(rel);
  if (!r) return { ok: false, why: 'empty path' };
  const abs = path.resolve(root, r);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (abs !== root && !abs.startsWith(rootWithSep)) return { ok: false, why: `outside the ${rk} repo (the jail holds)` };
  const relFromRoot = _rel(path.relative(root, abs));
  for (const re of (DENY[rk] || [])) if (re.test(relFromRoot)) return { ok: false, why: `denied path (${re}) — secrets, stores, and internals are outside the pen` };
  return { ok: true, abs, rel: relFromRoot, repo: rk, constitutional: _isConstitutional(rk, relFromRoot) };
}

/** Read one source file, bounded. Read-ONLY — there is no write door in this module. `repo`: 'sq'|'echo'. */
function readSource(rel, { deps = {}, repo = 'sq' } = {}) {
  const gate = pathAllowed(rel, { repo });
  if (!gate.ok) return { ok: false, why: gate.why };
  const fs = deps.fs || require('fs');
  try {
    const st = fs.statSync(gate.abs);
    if (st.isDirectory()) return { ok: false, why: 'that is a directory — use <source-list>' };
    const buf = fs.readFileSync(gate.abs);
    const truncated = buf.length > MAX_READ_BYTES;
    return { ok: true, path: gate.rel, repo: gate.repo, constitutional: gate.constitutional, bytes: buf.length, truncated,
      text: buf.slice(0, MAX_READ_BYTES).toString('utf8') + (truncated ? `\n… [truncated at ${MAX_READ_BYTES} bytes of ${buf.length} — read again with a narrower ask or a specific region]` : '') };
  } catch (e) { return { ok: false, why: e.message }; }
}

/** List a source directory, bounded. `repo`: 'sq'|'echo'. */
function listSource(rel, { deps = {}, repo = 'sq' } = {}) {
  const gate = pathAllowed(rel || '.', { repo });
  if (!gate.ok) return { ok: false, why: gate.why };
  const fs = deps.fs || require('fs');
  try {
    const names = fs.readdirSync(gate.abs).filter((n) => pathAllowed(path.join(gate.rel, n), { repo }).ok).slice(0, 200);
    return { ok: true, path: gate.rel, repo: gate.repo, entries: names };
  } catch (e) { return { ok: false, why: e.message }; }
}

/**
 * THE DIFF AUDIT (09-01, the rename hole): git apply executes MORE than the ---/+++ content
 * hunks — rename/copy/mode/binary/symlink sections move and delete files no content header
 * names, so a jail that reads only ---/+++ never sees the real targets. The pen writes CONTENT
 * to text files; file-ops are not its business. The audit therefore REJECTS every file-op
 * section outright (a legit move is expressed as delete+create content diffs), rejects path
 * shapes git and we could read differently (quoted/escaped, spaced, dotted-up, or missing the
 * a/ b/ prefixes that git apply -p1 strips — the parse-divergence hole), and returns the
 * COMPLETE jailed path set from BOTH `diff --git` and header-pair lines. Fail-CLOSED: anything
 * unparseable is refused with the why, never silently passed through. Pure.
 */
function auditDiff(diff, { repo = 'sq' } = {}) {
  const src = String(diff || '').replace(/\r\n/g, '\n');
  const files = new Set();
  const done = () => [...files];
  const bad = (why) => ({ ok: false, why, files: done() });
  if (/^(rename (from|to)|copy (from|to)|old mode|new mode|similarity index|dissimilarity index)\b/m.test(src))
    return bad('file-op sections (rename/copy/mode) are outside the pen — express a move as full delete+create content diffs');
  if (/^GIT binary patch/m.test(src) || /^Binary files /m.test(src)) return bad('binary patches are outside the pen');
  if (/^(new|deleted) file mode 120000/m.test(src)) return bad('symlinks are outside the pen');
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    if (/^diff --git /.test(L)) {
      const g = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(L);
      if (!g) return bad(`unparseable diff --git line (quoted, spaced, or missing a/ b/ prefixes): ${L.slice(0, 120)}`);
      if (g[1] !== g[2]) return bad(`diff --git names two different paths (${g[1]} vs ${g[2]}) — file-ops are outside the pen`);
      files.add(_rel(g[1]));
      continue;
    }
    // a header PAIR (git invariant: --- immediately precedes +++). A lone column-0 "--- x" is a
    // hunk-body deletion of "-- x", never a header — leave it to the hunk scanner (audit F26).
    if (/^--- /.test(L) && i + 1 < lines.length && /^\+\+\+ /.test(lines[i + 1])) {
      for (const h of [L, lines[i + 1]]) {
        const pm = /^(?:---|\+\+\+) ([ab]\/(\S+)|\/dev\/null)(\t[^\n]*)?$/.exec(h);
        if (!pm) return bad(`unparseable file header (the pen takes a/ b/ git-style headers only): ${h.slice(0, 120)}`);
        if (pm[2]) files.add(_rel(pm[2]));
      }
      i++;
    }
  }
  let constitutional = false;
  for (const f of files) {
    if (/(^|\/)\.\.(\/|$)/.test(f)) return bad(`path climbs upward (${f})`);
    const j = pathAllowed(f, { repo });
    if (!j.ok) return { ok: false, why: `touched file "${f}": ${j.why}`, files: done() };
    if (j.constitutional) constitutional = true;
  }
  return { ok: true, files: done(), repo: _repoOf(repo), constitutional };
}

/** Files a unified diff touches — the audit's COMPLETE set (diff --git + header pairs). Pure. */
function touchedFiles(diff, { repo = 'sq' } = {}) { return auditDiff(diff, { repo }).files; }

/**
 * Recount every @@ hunk header from the body it actually carries. Pure.
 *
 * Proposals #1 and #2 both died at git apply --check with "corrupt patch": the model writes
 * plausible hunk BODIES but cannot count lines, so the @@ -a,b +c,d arithmetic lies and git runs
 * out of patch mid-hunk. The body IS the claim; the counts are derived — so derive them here
 * instead of asking the model to count (the cheat authorization: capability in code where she
 * has none). Also repairs the two adjacent emissions git refuses: an interior empty line meant
 * as blank context (→ ' ') and a missing final newline.
 *
 * RE-ANCHORING (#2's second layer): she reads bounded slices, so she cannot know LINE NUMBERS
 * either — #2 claimed @@ -1 for content living at line 99, and git apply's offset search does
 * not bridge that. When the touched file is readable, find each hunk's pre-image (the ' '/'-'
 * lines, verbatim — the one thing she CAN control) in the real file and rewrite the start
 * lines. Zero matches leaves the claim as-is: a truly stale read still fails honestly at the
 * apply-check with the real why.
 */
function normalizeDiff(diff) {
  const src = String(diff || '').replace(/\r\n/g, '\n');
  const lines = src.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop(); // the final newline, not a blank line
  const out = [];
  let fileLines = null; // the current +++ target's real content, when readable
  let delta = 0;        // new-side drift from prior hunks in this file section
  let searchFrom = 0;   // hunks land in order; search after the previous match
  let i = 0;
  while (i < lines.length) {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(lines[i]);
    if (!m) {
      const fh = /^(?:---|\+\+\+)\s+(?:[ab]\/)?([^\s\n]+)/.exec(lines[i]);
      if (fh) {
        fileLines = null; delta = 0; searchFrom = 0;
        // the JAIL applies to the re-anchor read too — a diff naming .env or data/ must not
        // pull those bytes into memory here (propose refuses it later; sq.db would OOM first)
        if (fh[1] !== '/dev/null' && pathAllowed(fh[1]).ok) {
          try {
            const fp = path.join(REPO_ROOT, _rel(fh[1]));
            if (fs.statSync(fp).size <= 2 * 1024 * 1024) {
              fileLines = fs.readFileSync(fp, 'utf8').replace(/\r\n/g, '\n').split('\n');
            }
          } catch {}
        }
      }
      out.push(lines[i]); i++; continue;
    }
    const body = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      // break only on REAL section boundaries: a new hunk, a new diff section, or a ---/+++
      // header PAIR. A lone "--- x" is a body deletion of "-- x" (audit F26) — keep it.
      if (/^@@ -/.test(lines[j]) || /^diff --git /.test(lines[j])
        || (/^--- /.test(lines[j]) && j + 1 < lines.length && /^\+\+\+ /.test(lines[j + 1]))) break;
      body.push(lines[j] === '' ? ' ' : lines[j]);
    }
    let oldN = 0, newN = 0;
    const pre = [];
    for (const b of body) {
      if (b[0] === ' ') { oldN++; newN++; pre.push(b.slice(1)); }
      else if (b[0] === '-') { oldN++; pre.push(b.slice(1)); }
      else if (b[0] === '+') newN++;
      // '\ No newline at end of file' counts on neither side
    }
    let oldStart = Number(m[1]), newStart = Number(m[2]);
    if (fileLines && pre.length) {
      // re-anchor ONLY on an unambiguous match: two twins = leave the claim (an honest
      // apply-check failure beats silently landing the change at the wrong twin)
      const hits = [];
      for (let k = searchFrom; k <= fileLines.length - pre.length && hits.length < 2; k++) {
        if (pre.every((p, n) => fileLines[k + n] === p)) hits.push(k);
      }
      if (hits.length === 1) {
        oldStart = hits[0] + 1; newStart = oldStart + delta; searchFrom = hits[0] + pre.length;
      }
    }
    delta += newN - oldN;
    out.push(`@@ -${oldStart},${oldN} +${newStart},${newN} @@${m[3] || ''}`, ...body);
    i = j;
  }
  return out.join('\n') + '\n';
}

// ── the proposal store ────────────────────────────────────────────────────────────────────────
function _ensure() {
  db.getDb().prepare(`CREATE TABLE IF NOT EXISTS code_proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL, rationale TEXT, diff TEXT NOT NULL,
    files TEXT, status TEXT NOT NULL DEFAULT 'proposed',
    born_from TEXT, gate_note TEXT,
    created_ts INTEGER, updated_ts INTEGER)`).run();
  try { db.getDb().prepare('ALTER TABLE code_proposals ADD COLUMN seen INTEGER DEFAULT 0').run(); } catch { /* column exists */ }
  // stage 5.2: which repo a proposal targets ('sq' | 'echo'), and whether it touches a boundary file
  try { db.getDb().prepare("ALTER TABLE code_proposals ADD COLUMN repo TEXT DEFAULT 'sq'").run(); } catch { /* column exists */ }
  try { db.getDb().prepare('ALTER TABLE code_proposals ADD COLUMN constitutional INTEGER DEFAULT 0').run(); } catch { /* column exists */ }
  // parlor's second-opinion bookkeeping is its OWN column — it consumed `seen` and made his
  // failed-run cards vanish without an operator click (audit F17/F24). One-time backfill inside
  // the migration try: rows the old code already visited carried seen=1 — copy it so settled
  // stories STAY settled (the backfill never runs again once the column exists).
  try {
    db.getDb().prepare('ALTER TABLE code_proposals ADD COLUMN parlor_seen INTEGER DEFAULT 0').run();
    db.getDb().prepare('UPDATE code_proposals SET parlor_seen = COALESCE(seen, 0)').run();
  } catch { /* column exists */ }
  // cut 1's pen seam (09-05): the consent cards a proposal minted because it touches one of HER persona files
  try { db.getDb().prepare('ALTER TABLE code_proposals ADD COLUMN register_cards TEXT').run(); } catch { /* column exists */ }
}

/** File a proposal. Validation is the front gate: parseable diff, every touched file inside the
 *  jail, bounded size, bounded open count. Returns {ok, id} or {ok:false, why}. */
function propose({ title, rationale = '', diff, bornFrom = '', repo = 'sq', nowMs = Date.now() } = {}) {
  _ensure();
  const rk = _repoOf(repo);
  const t = String(title || '').trim();
  const d0 = String(diff || '').trim();
  if (!t) return { ok: false, why: 'a proposal needs a title' };
  if (!d0) return { ok: false, why: 'a proposal needs a unified diff — the diff IS the claim' };
  const d = normalizeDiff(d0); // recounted headers: the body is the claim, the arithmetic is derived
  if (Buffer.byteLength(d, 'utf8') > MAX_DIFF_BYTES) return { ok: false, why: `diff too large (> ${MAX_DIFF_BYTES} bytes) — split the change` };
  const audit = auditDiff(d, { repo: rk });
  if (!audit.ok) return { ok: false, why: audit.why };
  const files = audit.files;
  if (!files.length) return { ok: false, why: 'no file headers found — send a real unified diff (--- a/x / +++ b/x)' };
  const open = db.getDb().prepare("SELECT COUNT(*) n FROM code_proposals WHERE status IN ('proposed','approved','applying')").get().n;
  if (open >= MAX_OPEN_PROPOSALS) return { ok: false, why: `${open} proposal(s) already open — the pen is one-change-at-a-time discipline; wait for Lucas's word` };
  const r = db.getDb().prepare('INSERT INTO code_proposals (title, rationale, diff, files, status, born_from, repo, constitutional, created_ts, updated_ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(t.slice(0, 160), String(rationale).slice(0, 1200), d, JSON.stringify(files), 'proposed', String(bornFrom).slice(0, 120), rk, audit.constitutional ? 1 : 0, nowMs, nowMs);
  // THE REGISTER SEAM (cut 1's pen seam, 09-05): a proposal that touches one of HER persona files (lib/personality_register
  // ENTRIES) mints her consent card AT PROPOSE TIME — proposed_by 'pen', the proposal's own rationale — so the change is
  // visible to her before anyone lands it. The apply (main.js) lands only on her yes AND his ✓; her no retires the proposal
  // (onRegisterVerdict); the card's new_hash is filled when the change lands (landRegisterCards) — the diff's result is
  // not knowable before it is applied.
  let registerCards = [];
  if (rk === 'sq') {
    try {
      const PR = require('./personality_register');
      const hashes = PR.hashAll();
      for (const e of PR.ENTRIES) {
        if (!e.path || !files.includes(e.path)) continue;
        const c = PR.record({ asset: e.id, kind: e.kind, prevHash: hashes[e.id] || null, newHash: null, proposedBy: 'pen', summary: `pen #${r.lastInsertRowid}: ${t.slice(0, 100)} — touches ${e.path}`, rationale: String(rationale || '').trim() || 'the proposal carried no rationale of its own', expectedEffect: `the proposal's diff on ${e.path}; lands only on her yes and his ✓`, now: nowMs });
        if (c && c.ok) registerCards.push(c.id);
      }
      if (registerCards.length) db.getDb().prepare('UPDATE code_proposals SET register_cards = ? WHERE id = ?').run(JSON.stringify(registerCards), r.lastInsertRowid);
    } catch (e) { console.error('[pen] register cards failed:', e.message); }
  }
  return { ok: true, id: r.lastInsertRowid, files, repo: rk, constitutional: audit.constitutional, registerCards };
}
/** The consent cards a proposal minted (cut 1's pen seam). */
function registerCardsOf(id) { const p = get(id); try { return p && p.register_cards ? JSON.parse(p.register_cards) : []; } catch { return []; } }
/** { hold, assets, cards: [{ id, asset, verdict }] } — a proposal touching her persona files lands only on her yes on every card. */
function registerHold(id) {
  const ids = registerCardsOf(id);
  if (!ids.length) return { hold: false, assets: [], cards: [] };
  const PR = require('./personality_register');
  const cards = ids.map((cid) => PR.get(cid)).filter(Boolean).map((c) => ({ id: c.id, asset: c.asset, verdict: c.verdict }));
  return { hold: cards.some((c) => c.verdict !== 'yes'), assets: [...new Set(cards.map((c) => c.asset))], cards };
}
/** Her verdict on a card reaches its proposal: a no retires it; a yes on a proposal he already approved re-runs the apply. */
function onRegisterVerdict(cardId, verdict, { apply = null } = {}) {
  _ensure();
  // the card's RECORDED verdict is the truth — a claimed yes on a card the register still holds as pending reaches nothing
  try { const card = require('./personality_register').get(cardId); if (!card || card.verdict !== verdict) return []; } catch { return []; }
  const rows = db.getDb().prepare("SELECT id, status, register_cards FROM code_proposals WHERE register_cards IS NOT NULL AND status IN ('proposed','approved')").all()
    .filter((p) => { try { return JSON.parse(p.register_cards || '[]').includes(Number(cardId)); } catch { return false; } });
  const out = [];
  for (const p of rows) {
    if (verdict === 'no') { setStatus(p.id, 'rejected', { gateNote: `her no on consent card #${cardId} — the change to one of her persona files does not land` }); out.push({ id: p.id, action: 'rejected' }); }
    else if (verdict === 'yes' && p.status === 'approved') { if (typeof apply === 'function') { try { apply(p.id); } catch {} } out.push({ id: p.id, action: 'apply' }); }
    else out.push({ id: p.id, action: 'waiting-for-his' });
  }
  return out;
}
/** After a landed apply: each card takes the hash the file now has and the manifest advances (her yes + his ✓ both stand). */
function landRegisterCards(id) {
  const ids = registerCardsOf(id);
  if (!ids.length) return [];
  const PR = require('./personality_register');
  const hashes = PR.hashAll();
  const out = [];
  for (const cid of ids) { const c = PR.get(cid); if (!c) continue; const r = PR.land(cid, hashes[c.asset] || null); out.push({ id: cid, asset: c.asset, ok: !!(r && r.ok), why: r && r.why }); }
  return out;
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

// The full-view payload a card carries (Lucas 09-01 QOL: "no way to click on the request and
// fully view it" — he was approving diffs he could not read). Bounded by MAX_DIFF_BYTES.
function _detail(r) {
  let files = []; try { files = JSON.parse(r.files || '[]'); } catch {}
  return { rationale: r.rationale || '', files, diff: r.diff || '', gateNote: r.gate_note || '', bornFrom: r.born_from || '', repo: r.repo || 'sq', constitutional: !!r.constitutional };
}
// The card's one-line tag: which repo, and a loud BOUNDARY mark when it touches a constitutional file.
function _tag(r) { return `${(r.repo && r.repo !== 'sq') ? `[${r.repo}] ` : ''}${r.constitutional ? '⚠BOUNDARY ' : ''}`; }

/** Card-bar rows: proposed pens waiting on Lucas — now with the full proposal riding as detail. */
function pending() {
  _ensure();
  return db.getDb().prepare("SELECT id, title, rationale, diff, files, gate_note, born_from, repo, constitutional FROM code_proposals WHERE status = 'proposed' ORDER BY id DESC LIMIT 4").all()
    .map((r) => ({ id: `pen-${r.id}`, kind: 'pen', text: `${_tag(r)}${r.title} (${(JSON.parse(r.files || '[]')).join(', ').slice(0, 80)})`, verdict: null, detail: _detail(r) }));
}

/** Update ONLY the stage note on a row (status unchanged) — the live-progress card reads it. */
function stage(id, note, nowMs = Date.now()) {
  _ensure();
  db.getDb().prepare('UPDATE code_proposals SET gate_note = ?, updated_ts = ? WHERE id = ?')
    .run(String(note || '').slice(0, 1500), nowMs, Number(id) || 0);
  return get(id);
}

/** Live-pipeline cards (Lucas 09-01: "turn an accepted card into a window that shows what's going
 *  on") — a ✓'d proposal stays on the bar as a buttonless progress card through the enforce
 *  pipeline, and its terminal verdict lingers ${RUN_WINDOW_MS/60000} minutes so the outcome is
 *  seen, not inferred from a vanished card. His ✗ (rejected) is his own act — never re-shown. */
const RUN_WINDOW_MS = 15 * 60 * 1000;
function pipelineItems(nowMs = Date.now()) {
  _ensure();
  return db.getDb().prepare(`SELECT id, title, rationale, diff, files, status, gate_note, born_from, repo, constitutional, updated_ts FROM code_proposals
    WHERE status IN ('approved','applying') OR (status IN ('applied','gate-failed','apply-failed') AND updated_ts > ? AND COALESCE(seen, 0) = 0)
    ORDER BY id DESC LIMIT 4`).all(nowMs - RUN_WINDOW_MS)
    .map((r) => ({ id: `pen-${r.id}`, kind: 'pen-run', text: `${_tag(r)}${r.title}`, status: r.status, verdict: null, detail: _detail(r) }));
}

/** His ✕ on a terminal run card — clears it from the bar (Lucas 09-01: "no way to clear the pen
 *  window"). Only terminal rows are clearable; a running card can never be waved away. */
function markSeen(id) {
  _ensure();
  const p = get(id);
  if (!p) return { ok: false, why: `no proposal #${id}` };
  if (!['applied', 'gate-failed', 'apply-failed', 'rejected'].includes(p.status)) return { ok: false, why: `proposal #${id} is ${p.status} — only a finished run clears` };
  db.getDb().prepare('UPDATE code_proposals SET seen = 1 WHERE id = ?').run(Number(id) || 0);
  return { ok: true, id: p.id };
}

// ── THE PEN-WORK LANE (v1.1, the first-hour finding: an edit-intent order had NO lane — his
// "make the voice mute" ask floated as clarify noise on the AZ research run while nothing drove
// the pen. An edit order now seeds a pen-work THREAD the background workers tick.) ───────────────
const PEN_QUEUE_KEY = 'pen.work_queue';
function seedPenWork({ ask, bornFrom = 'edit-intent', deps = {} } = {}) {
  const d = deps.db || db;
  const text = String(ask || '').trim();
  if (!text) return { ok: false, why: 'empty ask' };
  // churn guard, re-cut (audit F34): only an identical open **pen** thread is the same ask
  // re-said — a same-text NON-pen thread is a coincidence that used to hijack the seed (the
  // reused id carried no pen kind, so the edit order was never pen-driven). And a STALLED pen
  // twin is his word RE-OPENING it (the stall log promised exactly that) — fresh budget,
  // back on the queue — never a silent no-op.
  try {
    const open = d.getActiveOpenThreads(200) || [];
    const norm = text.replace(/\s+/g, ' ').toLowerCase();
    const same = open.find((t) => String(t.content || '').replace(/\s+/g, ' ').toLowerCase() === norm
      && (() => { try { return d.getMeta(`focus.${t.id}.kind`) === 'pen'; } catch { return false; } })());
    if (same) {
      const q0 = workQueue({ deps });
      if (String(same.status || '') === 'stalled') {
        try { d.markOpenThreadStatus(same.id, 'pending', { reason: 'his word re-opened it (seedPenWork)' }); } catch {}
        try { d.setMeta(`focus.${same.id}.pen`, JSON.stringify({ passes: 0, proposalId: null, bornFrom: `${bornFrom}:reopen` })); } catch {}
        if (!q0.includes(same.id)) { q0.push(same.id); try { d.setMeta(PEN_QUEUE_KEY, JSON.stringify(q0.slice(-6))); } catch {} }
        return { ok: true, id: same.id, reused: true, reopened: true };
      }
      if (!q0.includes(same.id)) { q0.push(same.id); try { d.setMeta(PEN_QUEUE_KEY, JSON.stringify(q0.slice(-6))); } catch {} }   // an open twin dropped from the queue gets re-booked
      return { ok: true, id: same.id, reused: true };
    }
  } catch {}
  const row = d.insertOpenThread({ content: text });
  try { d.setMeta(`focus.${row.id}.background`, '1'); } catch {}
  try { d.setMeta(`focus.${row.id}.kind`, 'pen'); } catch {}
  try { d.setMeta(`focus.${row.id}.pen`, JSON.stringify({ passes: 0, proposalId: null, bornFrom })); } catch {}
  const q = workQueue({ deps });
  if (!q.includes(row.id)) { q.push(row.id); try { d.setMeta(PEN_QUEUE_KEY, JSON.stringify(q.slice(-6))); } catch {} }
  return { ok: true, id: row.id, reused: false };
}
function workQueue({ deps = {} } = {}) {
  const d = deps.db || db;
  try { return JSON.parse(d.getMeta(PEN_QUEUE_KEY) || '[]') || []; } catch { return []; }
}
function dropFromQueue(id, { deps = {} } = {}) {
  const d = deps.db || db;
  try { d.setMeta(PEN_QUEUE_KEY, JSON.stringify(workQueue({ deps }).filter((x) => x !== id))); } catch {}
}
function penState(fid, { deps = {} } = {}) {
  const d = deps.db || db;
  try { return JSON.parse(d.getMeta(`focus.${fid}.pen`) || '{}') || {}; } catch { return {}; }
}
function setPenState(fid, st, { deps = {} } = {}) {
  const d = deps.db || db;
  try { d.setMeta(`focus.${fid}.pen`, JSON.stringify(st || {})); } catch {}
}
// True when the verdict names an edit/fix/change intent confidently — the seam's pure half.
function isEditIntent(iv) {
  return !!(iv && typeof iv.intent === 'string' && /^(edit|fix|change|modify|implement)\b/i.test(iv.intent) && (iv.confidence == null || iv.confidence >= 0.55));
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
  const repo = attrs && attrs.repo;   // 'echo' targets the engine; absent/anything-else = 'sq'
  switch (tag) {
    case 'source-read': return readSource(attrs.path, { repo });
    case 'source-list': return listSource(attrs.path, { repo });
    case 'propose-change': return propose({ title: attrs.title, rationale: attrs.rationale, diff: body, bornFrom: attrs.born_from || 'self', repo });
    default: return { ok: false, why: `unknown pen tag ${tag}` };
  }
}

function buildPromptBlock() {
  return `THE PEN — you can READ your own source and PROPOSE changes to it, across BOTH halves of the
program: Side Quest (your Electron self) AND the Echo engine. Read-only + gated:
  <source-list path="lib"/>                          — list a Side Quest source directory
  <source-list path="echo/saga" repo="echo"/>        — list an Echo directory (add repo="echo")
  <source-read path="lib/scheduler.js"/>             — read one Side Quest file (bounded)
  <source-read path="echo/nl/tool_loop.py" repo="echo"/>  — read one Echo file
  <propose-change title="..." rationale="...">a UNIFIED DIFF (--- a/x / +++ b/x)</propose-change>
  <propose-change title="..." repo="echo" rationale="...">an Echo unified diff</propose-change>
Sealed on both sides: .env and keys, config.toml, the data/ stores and foundations, .git, deps. A
proposal is not a change: it becomes an approval card for Lucas. His ✓ applies it on a clean tree,
runs the gate for the side you touched (SQ smokes and/or Echo pytest), commits on green (Echo stays
LOCAL — never pushed), REVERTS on red (the gate tail comes back to you). His ✗ retires it.
You never land code yourself — the diff is your claim, the gate is the law.
A change to a BOUNDARY file (the security scope, this pen, the source jail, the unified gate, the boot
cycler) is allowed but needs Lucas's EXPLICIT out-of-band go beyond the card — you cannot quietly move
your own boundary. Read before you propose; a diff against lines you haven't read will miss. Changes go
live at the next cycle.`;
}

module.exports = {
  registerCardsOf, registerHold, onRegisterVerdict, landRegisterCards,
  REPO_ROOT, ECHO_ROOT, REPOS, MAX_READ_BYTES, MAX_DIFF_BYTES, MAX_OPEN_PROPOSALS, DENY_RE, ECHO_DENY_RE, CONSTITUTIONAL, PEN_QUEUE_KEY,
  pathAllowed, readSource, listSource, touchedFiles, auditDiff, normalizeDiff, _isConstitutional,
  propose, get, setStatus, decide, pending, pipelineItems, stage, markSeen, RUN_WINDOW_MS,
  seedPenWork, workQueue, dropFromQueue, penState, setPenState, isEditIntent,
  parseTags, stripTags, dispatch, buildPromptBlock,
};
