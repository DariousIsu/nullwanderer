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
    // NOVEL SCOPE (slice 2): the follow-up's tokens the project has never seen — "and
    // surveillance", "with sponsors" — attach as an OPEN scope item BEFORE the ask joins the
    // spec (afterwards nothing would read as novel). A pure re-order carries nothing novel and
    // attaches nothing. The scope item is the whole topic phrase — his words, greppable.
    const known = new Set(reg.tokensOf(`${hit.title || ''} ${String(hit.slug).replace(/-/g, ' ')} ${hit.spec.map((s) => s.text).join(' ')}`));
    const novel = reg.tokensOf(t).filter((w) => !known.has(w));
    const spec = hit.spec;
    if (ask && !spec.some((s) => s.text === ask)) spec.push({ ts: now, text: ask });
    while (spec.length > SPEC_CAP) spec.shift();
    h.prepare('UPDATE deliverable_projects SET spec_json = ?, updated_ts = ? WHERE slug = ?')
      .run(JSON.stringify(spec), now, hit.slug);
    console.log(`[projects] order binds to existing project "${hit.slug}" (kin ${hit.score.toFixed(2)}) — spec now ${spec.length} verbatim ask(s)`);
    if (novel.length) {
      attachScope(hit.slug, t.slice(0, 200), { now });
      console.log(`[projects] novel scope (${novel.join(', ')}) → attached as an open item`);
    }
    return { slug: hit.slug, created: false, novel };
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
  const _next = String(artifactSlug || '');
  // THE POINTER GUARD (C1c catch 08-26): a kin-band compose (spine 0.5 ≤ score < registry 0.6)
  // minted a SIBLING artifact and this UPDATE repointed the project's canonical at it — the spine
  // lost its truth to a fragment-born near-dupe. An established pointer never moves to a DIFFERENT
  // slug from a mere compose landing; re-renders of the canonical keep the same slug.
  if (hit.artifact_slug && _next && hit.artifact_slug !== _next) {
    console.log(`[projects] compose-link REFUSED — project "${hit.slug}" keeps canonical "${hit.artifact_slug}"; landed artifact "${_next}" is a sibling (registry/spine drift)`);
    return { slug: hit.slug, drift: true };
  }
  _handle().prepare(`UPDATE deliverable_projects SET artifact_slug = ?, status = 'delivered', updated_ts = ? WHERE slug = ?`)
    .run(_next, now, hit.slug);
  return { slug: hit.slug };
}

/** "Where are we on X" reads THIS. Returns the parsed row + open scope, or null. */
function statusOf(text) {
  const hit = findProject(text);
  if (!hit) return null;
  return { ...hit, openScope: hit.scope.filter((s) => s.status === 'open') };
}

// ── slice 2b: the SCOPE-ADD order (continuity leg-B catch, 2026-08-21) ─────────────────────────
// "(also) fold Y into the X report" / "add Y to the X report" / "the X report should also cover
// Y" is an order about an EXISTING deliverable — it names the project AND the new content, but
// carries no produce-verb, so intake's deliverable-order detector (the only bind seam) missed
// every variant and the spine never heard the scope. Live: she acked "folding it in now" while
// the row stayed empty. The detector is narrow (deliverable noun required, both halves ≥3 chars)
// and the wiring additionally requires findProject() to HIT — unmatched subjects fall through.
const _DELIV_NOUN = 'report|brief|briefing|dossier|write-?up|writeup|summary|memo|document|one-?pager';
const _SCOPE_ADD_RES = [
  // fold/add/include/put/work Y into|to|in the X <noun>
  new RegExp(`\\b(?:also\\s+)?(?:fold|add|include|put|work|weave|roll)\\s+(.+?)\\s+(?:into|to|in)\\s+(?:the|our|my)\\s+(.+?)\\s+(?:${_DELIV_NOUN})\\b`, 'i'),
  // the X <noun> should (also) cover|include|get Y
  new RegExp(`\\b(?:the|our|my)\\s+(.+?)\\s+(?:${_DELIV_NOUN})\\s+should\\s+(?:also\\s+)?(?:cover|include|get|carry|have)\\s+(.+?)\\s*[.?!]?$`, 'i'),
];
function detectScopeAdd(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 300) return null;
  let m = t.match(_SCOPE_ADD_RES[0]);
  if (m) { const item = m[1].trim(), target = m[2].trim(); if (item.length >= 3 && target.length >= 3) return { item, target }; }
  m = t.match(_SCOPE_ADD_RES[1]);
  if (m) { const target = m[1].trim(), item = m[2].trim(); if (item.length >= 3 && target.length >= 3) return { item, target }; }
  return null;
}

/** The full scope-add flow: resolve the target to its project, attach the item as open scope,
 *  and append the verbatim ask to the spec. No project → null (the caller falls through). */
function applyScopeAdd({ text, now = Date.now() } = {}) {
  const sa = detectScopeAdd(text);
  if (!sa) return null;
  const proj = findProject(sa.target);
  if (!proj) return null;
  bindOrder({ text, topic: sa.target, now });          // verbatim ask joins the spec (kin-binds, never mints here)
  attachScope(proj.slug, sa.item, { now });
  console.log(`[projects] scope-add order → project "${proj.slug}": ${sa.item.slice(0, 80)}`);
  return { slug: proj.slug, item: sa.item };
}

// ── slice 2: the conversational read-side ───────────────────────────────────────────────────────
// "Where are we on X" is a STATUS ask — it reads the project row, never re-runs the work and
// never guesses. The detector is deliberately narrow (a status shape + a subject tail); the door
// in main.js additionally requires statusOf() to HIT, so an unmatched subject falls through to
// normal conversation untouched — zero false-positive blast radius.
const _STATUS_ASK_RE = /\b(?:where (?:are we|do we stand|do things stand)|what(?:'|’)?s the status|status|any progress|how(?:'|’)?s it (?:coming|going))\b[^.?!]*?\b(?:on|of|with)\s+(.+?)\s*[.?!]?$/i;
function detectStatusAsk(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 200) return null;
  const m = t.match(_STATUS_ASK_RE);
  if (!m || !m[1]) return null;
  const subject = m[1].replace(/^(?:the|our|my|that)\s+/i, '').trim();
  return subject.length >= 3 ? { subject } : null;
}

/** Grounded facts for the status reply — everything from the row + the registry, nothing
 *  generated. Returns null when no project matches (the door falls through). */
function statusBrief(text) {
  const p = statusOf(text);
  if (!p) return null;
  const L = [];
  L.push(`PROJECT: ${p.title || p.slug} (status: ${p.status})`);
  if (p.artifact_slug) {
    let art = null; try { art = reg.get(p.artifact_slug); } catch {}
    if (art) L.push(`CANONICAL ARTIFACT: ${art.rel_path} — version ${art.version}, last updated ${new Date(art.updated_ts || 0).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} ET`);
  } else {
    L.push('CANONICAL ARTIFACT: none landed yet');
  }
  if (p.openScope.length) L.push(`OPEN SCOPE (still to fold in): ${p.openScope.map((s) => `"${s.item}"`).join('; ')}`);
  else L.push('OPEN SCOPE: none — the artifact reflects the spec as ordered');
  const lastAsk = p.spec.length ? p.spec[p.spec.length - 1] : null;
  L.push(`SPEC: ${p.spec.length} verbatim ask(s) on record${lastAsk ? `; latest: "${String(lastAsk.text).slice(0, 140)}"` : ''}`);
  return { slug: p.slug, brief: L.join('\n') };
}

function get(slug) { ensure(); return _parse(_handle().prepare('SELECT * FROM deliverable_projects WHERE slug = ?').get(slug)); }
function list({ openScopeOnly = false } = {}) {
  const all = _rows().map(_parse);
  return openScopeOnly ? all.filter((p) => p.scope.some((s) => s.status === 'open')) : all;
}

module.exports = { ensure, bindOrder, attachScope, completeScope, noteCompose, statusOf, findProject, detectStatusAsk, statusBrief, detectScopeAdd, applyScopeAdd, get, list, _setDb, SPEC_CAP, PROJECT_KIN_FLOOR };
