/*
 * lib/kg_provenance.js — BULK provenance for the knowledge-graph surface. Read-only.
 *
 * The object model says a thing is real because it has been ENCOUNTERED, and that each further source
 * raises certainty (lib/encounters.js). Until now the 3D graph could not SEE any of that: every node
 * drew at the same weight whether one stray filing mentioned it once or forty independent documents
 * agreed on it. This module is the read half that lets the surface draw the difference — corroboration
 * as mass, thin evidence as a ghost, a refuted claim as a scar.
 *
 * Why a separate module rather than a function in lib/encounters.js: that file is the substrate and
 * belongs to another lane. Nothing here writes, and nothing here re-implements grading — a GRADE is
 * read-time and per-claim by design (encounters.gradeClaim), which is the right call for one object and
 * the wrong shape for six hundred nodes a frame. What a renderer can afford is the countable half:
 * how many encounters, how many independent origins, where it was born, and whether anything
 * authoritative ever vouched for it. Grades stay where they belong, behind a click (kg:profile).
 *
 * KEY JOIN. encounters.object_key is `<namespace>:<normalised label>` across a closed namespace set
 * (measured live 2026-07-22: event, name, place, person, org, thing, document, gov, body). A graph node
 * only knows its display name, so we expand each label into every namespace and let the unique index on
 * object_key do the work — an indexed IN-list, never a table scan. Rows are then folded back together by
 * the label half, because `person:jane doe` and `name:jane doe` (its type claim) are encounters with the
 * SAME thing, and counting them separately would understate what she actually holds.
 */
'use strict';

let _db = null;
const db = () => (_db || (_db = require('./db')));

// The namespaces encounters.objectKey() mints, plus `name:` for type claims (lib/object_type.js).
const NAMESPACES = ['person', 'org', 'gov', 'body', 'place', 'event', 'concept', 'thing', 'document', 'name'];

// Mirrors encounters.objectKey()'s generic normalisation. Deliberately NOT a second normaliser with its
// own opinions — if this drifts from that one, lookups silently miss and every node reads as unprovenanced.
function normLabel(s) {
  return String(s == null ? '' : s).toLowerCase().trim().replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
}
// A strong-id tag is identity, not part of the name (T2). `person:` keys keep the brackets, `name:` keys
// strip them — so both spellings have to be asked for or half the evidence goes missing.
const stripIds = (s) => String(s == null ? '' : s).replace(/\[[^\]]*\]/g, ' ');
const hasStrongId = (s) => /\[[^\]]+\]/.test(String(s == null ? '' : s));

const SQL_KEY_CHUNK = 600;          // well under SQLite's variable ceiling, and one indexed seek per key
// better-sqlite3 is synchronous, so every uncached sweep blocks the main process. The short-term reconciler
// re-polls every 5s and provenance moves far slower than that, so the TTL is what keeps a ~20-140ms scan from
// landing six times a minute. Measured 2026-07-22: 478 nodes cold ≈ 143ms, warm ≈ 20ms, cached 0ms.
const CACHE_TTL_MS = 60000;
const CACHE_CAP = 6000;
const _cache = new Map();           // display label → { at, p }

// Swallowing is right in production — a provenance miss must never stop the graph drawing — but a silent
// catch also hides a real break behind "every node happens to have no evidence", which is a plausible
// enough picture to go unnoticed. The last failure is kept so a smoke can ask instead of guess.
let _lastError = null;
const lastError = () => _lastError;

function _variantsFor(label) {
  const a = normLabel(label), b = normLabel(stripIds(label));
  return a === b ? [a] : [a, b];
}

function _blank() {
  return { encounters: 0, sources: 0, bornLane: null, bornHost: null, bornAt: null, authoritative: 0, ordinary: 0, refuted: 0 };
}

// Fold one SQL group into an accumulating per-label summary. Counts add across namespaces; the BIRTH is
// the earliest row seen for any of them (a thing is born once, whichever namespace first recorded it).
function _fold(into, row) {
  into.encounters += row.n || 0;
  into.authoritative += row.auth_n || 0;
  into.ordinary += row.ord_n || 0;
  // Distinct origins can't be summed across namespaces without double-counting a host that appears in
  // both, so take the largest single-namespace count: a conservative FLOOR on independence, never a claim
  // of more corroboration than exists. Overstating independence is the one error worth refusing here.
  if ((row.srcs || 0) > into.sources) into.sources = row.srcs || 0;
  if (into._firstId == null || (row.first_id != null && row.first_id < into._firstId)) {
    into._firstId = row.first_id;
    into.bornLane = row.born_lane || null;
    into.bornHost = row.born_host || null;
    into.bornAt = row.born_at || null;
  }
}

/*
 * forLabels(labels) → Map<displayLabel, provenance>
 *
 * provenance = { encounters, sources, bornLane, bornHost, bornAt, authoritative, ordinary, refuted, weak }
 *   weak — nothing authoritative and nothing even ordinary has vouched for it: every encounter is
 *          `unknown` or `stated` authority. This is the honest "go look" state (encounters.js §stated),
 *          and it is what the surface draws as a ghost. NOT the same as unproven — see kg:profile for
 *          the graded read.
 *
 * Never throws: a missing table or a bad label yields an absent entry, and the surface simply draws the
 * node the way it always did. Provenance is an enrichment, never a gate on rendering.
 */
function forLabels(labels, { useCache = true } = {}) {
  const out = new Map();
  const list = (Array.isArray(labels) ? labels : []).filter((l) => l != null && String(l).trim());
  if (!list.length) return out;

  const now = Date.now();
  const need = [];                       // labels we actually have to hit the DB for
  const byVariant = new Map();           // normalised variant → [display labels wanting it]
  for (const label of list) {
    if (out.has(label)) continue;
    const hit = useCache ? _cache.get(label) : null;
    if (hit && now - hit.at < CACHE_TTL_MS) { out.set(label, hit.p); continue; }
    need.push(label);
    for (const v of _variantsFor(label)) {
      if (!v) continue;
      if (!byVariant.has(v)) byVariant.set(v, []);
      byVariant.get(v).push(label);
    }
  }
  if (!need.length) return out;

  const acc = new Map();                 // display label → accumulating summary
  for (const label of need) acc.set(label, _blank());

  const variants = [...byVariant.keys()];
  const keys = [];
  for (const v of variants) for (const ns of NAMESPACES) keys.push(ns + ':' + v);

  try {
    const d = db().getDb();
    // ONE min/max aggregate (MIN(id)) so SQLite's documented bare-column rule holds: source_kind,
    // origin_host and ingested_at are then guaranteed to come from the EARLIEST row — the birth. Adding a
    // second min/max (a MAX(ingested_at) for "last seen") would make all three undefined, which is why
    // last-seen is deliberately absent here rather than quietly wrong.
    const sql = (n) => `
      SELECT substr(object_key, instr(object_key, ':') + 1) AS lbl,
             COUNT(*) AS n,
             COUNT(DISTINCT origin_host) AS srcs,
             MIN(id) AS first_id,
             source_kind AS born_lane,
             origin_host AS born_host,
             ingested_at AS born_at,
             SUM(CASE WHEN authority IN ('official','operator','verified') THEN 1 ELSE 0 END) AS auth_n,
             SUM(CASE WHEN authority = 'ordinary' THEN 1 ELSE 0 END) AS ord_n
        FROM encounters
       WHERE object_key IN (${new Array(n).fill('?').join(',')})
       GROUP BY lbl`;
    for (let i = 0; i < keys.length; i += SQL_KEY_CHUNK) {
      const chunk = keys.slice(i, i + SQL_KEY_CHUNK);
      const rows = d.prepare(sql(chunk.length)).all(...chunk);
      for (const r of rows) {
        for (const label of (byVariant.get(r.lbl) || [])) { const a = acc.get(label); if (a) _fold(a, r); }
      }
    }
  } catch (e) { _lastError = e && e.message; /* no encounters table / query failed — every node stays unprovenanced, which renders fine */ }

  // Refutations are sparse by design (508 rows against 102k encounters, 2026-07-22), so this is a small
  // second pass rather than a join — and a failure here must not cost the counts already gathered.
  try {
    const d = db().getDb();
    for (let i = 0; i < keys.length; i += SQL_KEY_CHUNK) {
      const chunk = keys.slice(i, i + SQL_KEY_CHUNK);
      const rows = d.prepare(
        `SELECT substr(object_key, instr(object_key, ':') + 1) AS lbl, COUNT(*) AS n
           FROM known_incorrect WHERE object_key IN (${new Array(chunk.length).fill('?').join(',')}) GROUP BY lbl`
      ).all(...chunk);
      for (const r of rows) {
        for (const label of (byVariant.get(r.lbl) || [])) { const a = acc.get(label); if (a) a.refuted += r.n || 0; }
      }
    }
  } catch (e) { _lastError = e && e.message; /* table may not exist yet; absence of a refutation is not proof of correctness (§7) */ }

  for (const [label, a] of acc) {
    delete a._firstId;
    a.weak = a.encounters > 0 && a.authoritative === 0 && a.ordinary === 0;
    a.strongId = hasStrongId(label);
    out.set(label, a);
    if (_cache.size >= CACHE_CAP) _cache.clear();       // cheap bound; provenance is re-derivable
    _cache.set(label, { at: now, p: a });
  }
  return out;
}

// Attach provenance onto {id}-shaped graph nodes in place. The surface reads node.prov.
function attach(nodes) {
  try {
    const arr = Array.isArray(nodes) ? nodes : [];
    if (!arr.length) return arr;
    const p = forLabels(arr.map((n) => n && n.id));
    for (const n of arr) { const v = n && p.get(n.id); if (v) n.prov = v; }
    return arr;
  } catch (e) { return nodes; }
}

module.exports = { forLabels, attach, normLabel, NAMESPACES, lastError, _cache };
