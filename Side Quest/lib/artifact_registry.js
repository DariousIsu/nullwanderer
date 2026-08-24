'use strict';
// ── ARTIFACT REGISTRY v0 ────────────────────────────────────────────────────────────────────────
// Phase 0 of the document-production plan (Root A / failure #5, live 2026-08-21): documents had
// NO IDENTITY. Every compose minted a fresh file keyed on the raw topic string, so one project
// piled up slug-siblings (four anti-China reports in one day: the hollow one, the his-sentence
// slug, the 7-state, the unified) — she then anchored to a STALE sibling, declared its count the
// truth, and called her own earlier claim fabricated while the real report sat unnoticed.
//
// The registry is the ONE table that says what "the report on X" IS:
//   project slug → canonical file path + title + topic + version + updated_ts
// • The compose side (buildReportFromHeld) resolves the topic through resolveOrMint(): a kin
//   topic (token overlap with a registered project) REUSES that project's slug and canonical
//   path — the file UPDATES in place, version++ — and only a genuinely new subject mints.
// • The read side (the pull-up doors) asks matchAsk() FIRST: a subject that resolves to a
//   registered project opens the canonical current version, never a filename guess.
// v0 is deliberately narrow: topic-token identity, one canonical artifact per project. The P1
// project spine (deliverable_projects, verbatim spec, scope items) builds on this table.

function _d() { return require('./db').getDb(); }
let _dbh = null;                                   // test injection (smoke drives an in-memory db)
function _setDb(h) { _dbh = h; }
function _handle() { return _dbh || _d(); }

let _ensured = false;
function ensure() {
  const h = _handle();
  if (_ensured && !_dbh) return;
  h.exec(`CREATE TABLE IF NOT EXISTS artifact_registry (
    slug TEXT PRIMARY KEY,
    rel_path TEXT NOT NULL,
    title TEXT,
    topic TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_ts INTEGER,
    updated_ts INTEGER
  )`);
  _ensured = true;
}

// Topic identity = the CONTENT tokens. Deliverable nouns and connective filler never
// distinguish projects ("anti-China bills" and "anti-China legislation" are ONE project).
const _STOP = new Set(('a an the and or of on in at to for by with about from into over under per ' +
  'state states statewide report reports reporting bill bills legislation doc docs document documents note notes ' +
  'new current latest full final complete updated fresh quick short compact simple brief ' +
  'list lists summary overview recap rundown breakdown sheet sheets table tables ' +
  'that this it his her my your our their them you she him they ' +
  'make build write draft compose put drop place post knock give pull need want').split(' '));
function tokensOf(text) {
  const out = [];
  const seen = new Set();
  for (const w of String(text || '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length < 3 || _STOP.has(w) || seen.has(w)) continue;
    seen.add(w); out.push(w);
  }
  return out;
}

// Kin test: intersection over the SMALLER token set (a narrow ask still resolves to its wide
// project), floor of 2 shared tokens so a single generic word never merges two projects.
function _overlap(aToks, bToks) {
  if (!aToks.length || !bToks.length) return 0;
  const b = new Set(bToks);
  const inter = aToks.filter((t) => b.has(t)).length;
  if (inter < 2) return 0;
  return inter / Math.min(aToks.length, b.size);
}

const KIN_FLOOR = 0.6;

function _rows() {
  ensure();
  try { return _handle().prepare('SELECT * FROM artifact_registry ORDER BY updated_ts DESC').all(); } catch { return []; }
}

/** Best registered project for a topic/ask, or null. Matches against each row's topic AND slug
 *  tokens (the slug holds the minting topic's content words even if topic drifted). */
function _bestMatch(text) {
  const toks = tokensOf(text);
  if (!toks.length) return null;
  let best = null, bestScore = 0;
  for (const r of _rows()) {
    const score = Math.max(_overlap(toks, tokensOf(r.topic)), _overlap(toks, tokensOf(String(r.slug).replace(/-/g, ' '))));
    if (score >= KIN_FLOOR && score > bestScore) { best = r; bestScore = score; }
  }
  return best ? { ...best, score: bestScore } : null;
}

/** COMPOSE SIDE. A kin topic reuses its project (same slug, same canonical file, version+1 on
 *  record); a new subject mints a stable content-token slug. Never writes — record() does. */
function resolveOrMint({ topic, kind = 'report' } = {}) {
  const t = String(topic || '').trim();
  const hit = _bestMatch(t);
  if (hit) {
    console.log(`[artifact-registry] topic resolves to project "${hit.slug}" (overlap ${hit.score.toFixed(2)}) — canonical ${hit.rel_path} updates in place (v${hit.version} → v${hit.version + 1})`);
    return { slug: hit.slug, relPath: hit.rel_path, nextVersion: hit.version + 1, existing: true };
  }
  let slug = kind;
  for (const w of tokensOf(t)) { if ((slug + '-' + w).length > 60) break; slug += '-' + w; }   // whole tokens only — never a mid-word cut
  if (slug === kind) slug = `${kind}-untitled`;
  return { slug, relPath: `notes/${slug}.md`, nextVersion: 1, existing: false };
}

/** Record a landed compose: upsert the project row, version = prior+1 (or 1). */
function record({ slug, relPath, title, topic, now = Date.now() } = {}) {
  ensure();
  const h = _handle();
  const cur = h.prepare('SELECT version FROM artifact_registry WHERE slug = ?').get(slug);
  if (cur) {
    h.prepare('UPDATE artifact_registry SET rel_path = ?, title = ?, topic = ?, version = version + 1, updated_ts = ? WHERE slug = ?')
      .run(relPath, String(title || ''), String(topic || ''), now, slug);
    return { slug, version: cur.version + 1 };
  }
  h.prepare('INSERT INTO artifact_registry (slug, rel_path, title, topic, version, created_ts, updated_ts) VALUES (?, ?, ?, ?, 1, ?, ?)')
    .run(slug, relPath, String(title || ''), String(topic || ''), now, now);
  return { slug, version: 1 };
}

/** READ SIDE. "the report on X" / "the anti-China report" → the canonical current artifact,
 *  shaped like a product-ledger note hit so presentHeldProduct serves it unchanged. */
function matchAsk(subject) {
  const hit = _bestMatch(subject);
  if (!hit) return null;
  return {
    kind: 'note',
    path: hit.rel_path,
    title: String(hit.title || hit.slug),
    ts: hit.updated_ts || hit.created_ts || Date.now(),
    label: `${hit.title || hit.slug} (canonical, v${hit.version})`,
    slug: hit.slug,
    version: hit.version,
  };
}

function get(slug) { ensure(); try { return _handle().prepare('SELECT * FROM artifact_registry WHERE slug = ?').get(slug) || null; } catch { return null; } }
function list() { return _rows(); }

/** Shared kin test for the P1 project spine — ONE identity vocabulary across stores, so the
 *  registry and deliverable_projects can never drift apart on what counts as "the same subject". */
function kinScore(aText, bText) { return _overlap(tokensOf(aText), tokensOf(bText)); }

module.exports = { resolveOrMint, record, matchAsk, get, list, tokensOf, kinScore, ensure, _setDb, KIN_FLOOR };
