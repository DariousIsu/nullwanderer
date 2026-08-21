'use strict';
// ── THE PROJECT SPINE (Phase 1, slice 1) ────────────────────────────────────────────────────────
// docs/DOCUMENT_PRODUCTION_PLAN_2026-08-21.md §3 Phase 1: a durable row per ongoing deliverable —
// slug, title, HIS spec (verbatim asks, append-only, including sub-scopes like "and surveillance"),
// outstanding scope items, canonical artifact ref, dataset ref (Phase 2), status. Orders BIND to a
// project (new or existing); follow-ups ATTACH scope; "where are we on X" reads the row; the gap
// plan lists projects with open scope. The artifact registry (Phase 0) is the identity layer this
// builds on — slugs come from it, and kin matching uses ITS vocabulary (one vocabulary, never two).
//
// Slice 1 = the store + bind/attach/status/list + two wire points (the intake order backstop and
// the report compose door). The conversational read-side ("where are we on X") and the gap-plan
// listing are slice 2; the multi-day continuity suite is the phase gate.

const reg = require('./artifact_registry');

function _d() { return require('./db').getDb(); }
let _dbh = null;                                   // test injection (smoke drives an in-memory db)
function _setDb(h) { _dbh = h; }
function _handle() { return _dbh || _d(); }

let _ensured = false;
function ensure() {
  const h = _handle();
  if (_ensured && !_dbh) return;
  h.exec(`CREATE TABLE IF NOT EXISTS deliverable_projects (
    slug TEXT PRIMARY KEY,
    title TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    spec_json TEXT NOT NULL DEFAULT '[]',
    scope_json TEXT NOT NULL DEFAULT '[]',
    artifact_slug TEXT,
    dataset_ref TEXT,
    created_ts INTEGER,
    updated_ts INTEGER
  )`);
  _ensured = true;
}

const SPEC_CAP = 30;   // verbatim asks kept per project (append-only; the oldest roll off)

function _parse(row) {
  if (!row) return null;
  let spec = [], scope = [];
  try { spec = JSON.parse(row.spec_json || '[]'); } catch {}
  try { scope = JSON.parse(row.scope_json || '[]'); } catch {}
  return { ...row, spec, scope };
}

function _rows() {
  ensure();
  try { return _handle().prepare('SELECT * FROM deliverable_projects ORDER BY updated_ts DESC').all(); } catch { return []; }
}

/** Best kin project for a text, or null. Matches the title, the slug's words, and every stored
 *  verbatim ask — a follow-up phrased like ANY earlier ask still finds its project.
 *  The floor sits BELOW the registry's deliberately: a follow-up's NEW sub-scope words dilute its
 *  overlap with the day-1 spec ("add surveillance bills to the anti china report" scores 0.50
 *  against a project born as "anti-China legislation: UT, AZ, TX" — exactly the shape that must
 *  bind). The blast radii differ: a wrong PROJECT bind appends a visible, correctable spec row;
 *  a wrong REGISTRY merge overwrites a canonical artifact — so the registry keeps its 0.6 and the
 *  shared 2-token intersection floor guards both. */
const PROJECT_KIN_FLOOR = 0.5;
function findProject(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  let best = null, bestScore = 0;
  for (const row of _rows()) {
    if (row.status === 'archived') continue;
    const p = _parse(row);
    let score = Math.max(reg.kinScore(t, p.title || ''), reg.kinScore(t, String(p.slug).replace(/-/g, ' ')));
    for (const s of p.spec) score = Math.max(score, reg.kinScore(t, s.text || ''));
    if (score >= PROJECT_KIN_FLOOR && score > bestScore) { best = p; bestScore = score; }
  }
  return best ? { ...best, score: bestScore } : null;
}

/** An ORDER binds to its project — existing kin project gains the verbatim ask (append-only);
 *  a genuinely new subject mints a project whose slug IS the registry's artifact slug, so the
 *  project and its canonical artifact share one identity from birth. */
function bindOrder({ text, topic, kind = 'report', now = Date.now() } = {}) {
  ensure();
  const ask = String(text || '').trim().slice(0, 400);
  const t = String(topic || text || '').trim();
  if (!t) return null;
  const h = _handle();
  const hit = findProject(t) || (ask && ask !== t ? findProject(ask) : null);
  if (hit) {
    const spec = hit.spec;
    if (ask && !spec.some((s) => s.text === ask)) spec.push({ ts: now, text: ask });
    while (spec.length > SPEC_CAP) spec.shift();
    h.prepare('UPDATE deliverable_projects SET spec_json = ?, updated_ts = ? WHERE slug = ?')
      .run(JSON.stringify(spec), now, hit.slug);
    console.log(`[projects] order binds to existing project "${hit.slug}" (kin ${hit.score.toFixed(2)}) — spec now ${spec.length} verbatim ask(s)`);
    return { slug: hit.slug, created: false };
  }
  const r = reg.resolveOrMint({ topic: t, kind });
  const title = t.slice(0, 120);
  h.prepare(`INSERT INTO deliverable_projects (slug, title, status, spec_json, scope_json, artifact_slug, created_ts, updated_ts)
             VALUES (?, ?, 'active', ?, '[]', NULL, ?, ?)
             ON CONFLICT(slug) DO UPDATE SET updated_ts = excluded.updated_ts`)
    .run(r.slug, title, JSON.stringify(ask ? [{ ts: now, text: ask }] : []), now, now);
  console.log(`[projects] order mints project "${r.slug}"`);
  return { slug: r.slug, created: true };
}

/** A follow-up sub-scope ("and surveillance", "add a per-state status table") attaches as an
 *  OPEN scope item — never a new project, never silently dropped. */
function attachScope(slug, item, { now = Date.now() } = {}) {
  ensure();
  const row = _parse(_handle().prepare('SELECT * FROM deliverable_projects WHERE slug = ?').get(slug));
  if (!row) return { ok: false, reason: 'no such project' };
  const it = String(item || '').trim().slice(0, 200);
  if (!it) return { ok: false, reason: 'empty scope item' };
  if (row.scope.some((s) => s.item.toLowerCase() === it.toLowerCase())) return { ok: true, existing: true };
  row.scope.push({ item: it, status: 'open', born_ts: now });
  _handle().prepare('UPDATE deliverable_projects SET scope_json = ?, updated_ts = ? WHERE slug = ?')
    .run(JSON.stringify(row.scope), now, slug);
  console.log(`[projects] scope attached to "${slug}": ${it.slice(0, 80)}`);
  return { ok: true, existing: false };
}

function completeScope(slug, item, { now = Date.now() } = {}) {
  ensure();
  const row = _parse(_handle().prepare('SELECT * FROM deliverable_projects WHERE slug = ?').get(slug));
  if (!row) return { ok: false, reason: 'no such project' };
  const it = String(item || '').trim().toLowerCase();
  let hit = false;
  for (const s of row.scope) if (s.item.toLowerCase() === it && s.status === 'open') { s.status = 'done'; s.done_ts = now; hit = true; }
  if (hit) _handle().prepare('UPDATE deliverable_projects SET scope_json = ?, updated_ts = ? WHERE slug = ?')
    .run(JSON.stringify(row.scope), now, slug);
  return { ok: hit };
}

/** The compose door reports a landed artifact: link it and stamp the project delivered-current.
 *  'delivered' is NOT terminal — follow-up scope re-opens work; it means the canonical artifact
 *  currently reflects the spec as far as the compose could. */
function noteCompose({ topic, artifactSlug, now = Date.now() } = {}) {
  ensure();
  const hit = findProject(topic);
  if (!hit) return null;
  _handle().prepare(`UPDATE deliverable_projects SET artifact_slug = ?, status = 'delivered', updated_ts = ? WHERE slug = ?`)
    .run(String(artifactSlug || ''), now, hit.slug);
  return { slug: hit.slug };
}

/** "Where are we on X" reads THIS. Returns the parsed row + open scope, or null. */
function statusOf(text) {
  const hit = findProject(text);
  if (!hit) return null;
  return { ...hit, openScope: hit.scope.filter((s) => s.status === 'open') };
}

function get(slug) { ensure(); return _parse(_handle().prepare('SELECT * FROM deliverable_projects WHERE slug = ?').get(slug)); }
function list({ openScopeOnly = false } = {}) {
  const all = _rows().map(_parse);
  return openScopeOnly ? all.filter((p) => p.scope.some((s) => s.status === 'open')) : all;
}

module.exports = { ensure, bindOrder, attachScope, completeScope, noteCompose, statusOf, findProject, get, list, _setDb, SPEC_CAP };
