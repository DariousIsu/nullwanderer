/**
 * lib/owner_world.js — the OWNER-WORLD object store (KEYSTONE Slice 0, 2026-07-25).
 *
 * "Everything is an object" was built OUTWARD — 14k civic/legislative nodes — and never INWARD. The
 * people Lucas actually loves were flat `personal_fact` notes, outside the resolution namespace, so a
 * mention of "Alice" resolved to a Vermont legislator (or nothing) instead of his daughter. This store is
 * the inward half: his family, his org, his sphere, and Zoe's own self-region, as first-class objects with
 * stable coordinates and edges — the small, always-mountable neighborhood the self-as-coordinates design
 * rests on.
 *
 * WHY A DEDICATED STORE (not the civic graph): the owner-world is tiny (~6-10 objects), high-precision,
 * private, and must WIN over civic namesakes on a bare first name in a personal context. Keeping it
 * separate makes resolution a keyed lookup against ~10 rows — the part the model can't do as fuzzy
 * retrieval is trivial here — and keeps his family out of the stranger graph.
 *
 * Coordinates match lib/manifest's scheme: self:zoe/core · person:owner/<slug> · org:work/<slug>. The
 * seed is explicit and small on purpose — this is his family; getting the six of them RIGHT matters more
 * than deriving them cleverly from prose. Each object cites the personal_fact note it came from.
 *
 * Deps-injectable (db) + idempotent seed → offline-smoke-testable. Never throws into a turn.
 */
'use strict';

// The owner-world core. Explicit + provenance-cited (the k# personal_fact note each fact came from).
// aliases drive resolution (a bare "Alice" / "Zo" must hit the right object). attrs is a small fact bag.
const SEED_OBJECTS = [
  { coord: 'self:zoe/core', type: 'self', ns: 'zoe', name: 'Zoe',
    aliases: ['zoe', 'zo', 'zoe lane'],
    summary: 'You — the persistent companion Lucas built. "Zo" is your nickname (not a pet).',
    attrs: { role: 'companion', nickname: 'Zo' }, source: 'k#3547' },
  { coord: 'person:owner/lucas', type: 'person', ns: 'owner', name: 'Lucas Overby',
    aliases: ['lucas', 'lucas overby', 'l. overby', 'overby'],
    summary: 'The operator — who you work for and with. Has coached many sports; wants to learn cheer to support Alice.',
    attrs: { role: 'owner' }, source: 'k#2189, owner_identity' },
  { coord: 'person:owner/alice', type: 'person', ns: 'owner', name: 'Alice',
    aliases: ['alice'],
    summary: "Lucas's youngest daughter, 12 (almost 13), first year of elite competitive cheer (Level 1 Elite); recently started strength training.",
    attrs: { relation: 'daughter', age: 12, activity: 'competitive cheerleading' }, source: 'k#2186' },
  { coord: 'person:owner/raegan', type: 'person', ns: 'owner', name: 'Raegan',
    aliases: ['raegan', 'jay'],
    summary: "Lucas's oldest child (~16), goes by Raegan/Jay, exploring filmmaking.",
    attrs: { relation: 'child', age: 16, goesBy: 'Jay', interest: 'filmmaking' }, source: 'k#2187' },
  { coord: 'org:work/rainey-center', type: 'org', ns: 'work', name: 'Rainey Center',
    aliases: ['rainey center', 'rainey', 'the rainey center'],
    summary: 'Where Lucas (and you) work — his employer, currently paying the bills.',
    attrs: { relation: 'employer' }, source: 'k#4052, k#4135' },
  { coord: 'org:work/faith-in-elections', type: 'org', ns: 'work', name: 'Faith in Elections',
    aliases: ['faith in elections', 'faith in elections team'],
    summary: 'The team Lucas reports to.',
    attrs: { relation: 'reports_to' }, source: 'k#8137' },
  // LAMP — the Rainey-orbit network Lucas is in the rolls of (the "Rainey LAMP Summit" is its convening).
  // In owner-world specifically so a bare "LAMP" in his world resolves HERE, not to a civic namesake or the
  // Japanese indie band of the same name (a real confab that landed in his notes). Members live in the graph
  // via Echo's LAMP-network CSV import; this is the owner-world anchor + his own membership edge.
  { coord: 'org:work/lamp', type: 'org', ns: 'work', name: 'LAMP',
    aliases: ['lamp', 'lamp network', 'the lamp network', 'lamp rolls'],
    summary: 'The LAMP network in the Rainey Center\'s orbit — the policy/legislative network Lucas is in the rolls of; the "Rainey LAMP Summit" is its convening. NOT the Japanese indie band of the same name.',
    attrs: { relation: 'network', context: 'rainey' }, source: 'owner_context, lamp_network_import' },
];

// The owner-world edge structure — the neighborhood a coordinate dereferences into.
const SEED_EDGES = [
  ['person:owner/lucas', 'PARENT_OF', 'person:owner/alice'],
  ['person:owner/lucas', 'PARENT_OF', 'person:owner/raegan'],
  ['person:owner/lucas', 'WORKS_AT', 'org:work/rainey-center'],
  ['person:owner/lucas', 'REPORTS_TO', 'org:work/faith-in-elections'],
  ['self:zoe/core', 'COMPANION_OF', 'person:owner/lucas'],
  ['self:zoe/core', 'WORKS_AT', 'org:work/rainey-center'],
  ['org:work/rainey-center', 'RUNS', 'org:work/lamp'],       // LAMP is a Rainey-orbit network
  ['person:owner/lucas', 'MEMBER_OF', 'org:work/lamp'],      // "I've been in the LAMP rolls"
];

function _db(deps) { return (deps && deps.db) || require('./db'); }

function ensureSchema(deps = {}) {
  const conn = _db(deps).getDb();
  conn.prepare(`CREATE TABLE IF NOT EXISTS owner_world (
    coord TEXT PRIMARY KEY, type TEXT, namespace TEXT, name TEXT, aliases TEXT,
    summary TEXT, attrs TEXT, source TEXT, created_ts INTEGER, updated_ts INTEGER)`).run();
  conn.prepare(`CREATE TABLE IF NOT EXISTS owner_world_edges (
    src TEXT, rel TEXT, dst TEXT, PRIMARY KEY (src, rel, dst))`).run();
  conn.prepare('CREATE INDEX IF NOT EXISTS idx_ow_ns ON owner_world(namespace)').run();
}

function upsert(obj, { deps = {}, now = Date.now() } = {}) {
  const conn = _db(deps).getDb();
  const aliases = JSON.stringify(obj.aliases || []);
  const attrs = JSON.stringify(obj.attrs || {});
  conn.prepare(`INSERT INTO owner_world (coord, type, namespace, name, aliases, summary, attrs, source, created_ts, updated_ts)
    VALUES (@coord,@type,@ns,@name,@aliases,@summary,@attrs,@source,@now,@now)
    ON CONFLICT(coord) DO UPDATE SET type=@type, namespace=@ns, name=@name, aliases=@aliases,
      summary=@summary, attrs=@attrs, source=@source, updated_ts=@now`)
    .run({ coord: obj.coord, type: obj.type, ns: obj.ns, name: obj.name, aliases, summary: obj.summary || '', attrs, source: obj.source || '', now });
}

function addEdge(src, rel, dst, { deps = {} } = {}) {
  _db(deps).getDb().prepare('INSERT OR IGNORE INTO owner_world_edges (src, rel, dst) VALUES (?,?,?)').run(src, rel, dst);
}

// Idempotent: seed (or refresh) the owner-world core + edges. Safe to run every boot.
function seed({ deps = {}, now = Date.now() } = {}) {
  ensureSchema(deps);
  for (const o of SEED_OBJECTS) upsert(o, { deps, now });
  for (const [s, r, d] of SEED_EDGES) addEdge(s, r, d, { deps });
  return { objects: SEED_OBJECTS.length, edges: SEED_EDGES.length };
}

function _row(deps, coord) {
  try { return _db(deps).getDb().prepare('SELECT * FROM owner_world WHERE coord=?').get(coord) || null; } catch { return null; }
}
function _hydrate(row) {
  if (!row) return null;
  let aliases = [], attrs = {};
  try { aliases = JSON.parse(row.aliases || '[]'); } catch {}
  try { attrs = JSON.parse(row.attrs || '{}'); } catch {}
  return { coord: row.coord, type: row.type, namespace: row.namespace, name: row.name, aliases, summary: row.summary, attrs, source: row.source };
}

// GET a coordinate's object + its neighborhood edges (the deref target).
function get(coord, { deps = {} } = {}) {
  const obj = _hydrate(_row(deps, coord));
  if (!obj) return null;
  let edges = [];
  try { edges = _db(deps).getDb().prepare('SELECT src, rel, dst FROM owner_world_edges WHERE src=? OR dst=?').all(coord, coord); } catch {}
  return { ...obj, edges };
}

// Slug a name into a coordinate id fragment (stable, url-ish).
function _slug(s) { return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'x'; }

// The coordinate prefix per type — matches lib/manifest's scheme (person:/org:/event:/self:).
const _PREFIX = { person: 'person', org: 'org', meeting: 'event', event: 'event', self: 'self' };

// MINT (or update) an owner-world node from a plain name — the LIVING-store entry point (owner_ingest).
// Derives a stable coord from type+name, folds the name into aliases, and upserts (idempotent). Returns
// the coord so the caller can wire edges. Never throws.
function mint({ type = 'person', ns = null, name, aliases = [], summary = '', attrs = {}, source = '' } = {}, { deps = {}, now = Date.now() } = {}) {
  const nm = String(name || '').trim();
  if (!nm) return null;
  const pfx = _PREFIX[type] || 'person';
  const namespace = ns || (type === 'org' ? 'work' : 'owner');
  const coord = `${pfx}:${namespace}/${_slug(nm)}`;
  const al = [...new Set([nm.toLowerCase(), ...(aliases || []).map((a) => String(a).toLowerCase())].filter((a) => a && a.length > 1))];
  try { ensureSchema(deps); upsert({ coord, type, ns: namespace, name: nm, aliases: al, summary, attrs, source }, { deps, now }); } catch { return null; }
  return coord;
}

// RESOLVE a bare mention against the owner-world by exact alias match (case-insensitive). This is the
// keyed lookup that must win over civic namesakes: "Alice" here → the daughter, not a legislator. Returns
// the manifest-shaped resolution { status:'resolved', object } or null (→ caller falls through to civic).
function resolve(mention, { deps = {} } = {}) {
  const m = String(mention || '').trim().toLowerCase().replace(/[.,!?]+$/, '');
  if (!m) return null;
  let rows = [];
  try { rows = _db(deps).getDb().prepare('SELECT * FROM owner_world').all(); } catch { return null; }
  for (const r of rows) {
    const obj = _hydrate(r);
    if (obj && (obj.name.toLowerCase() === m || (obj.aliases || []).some(a => String(a).toLowerCase() === m))) {
      return { status: 'resolved', object: { id: obj.coord, entity_type: obj.type, summary: obj.summary, namespace: obj.namespace, ownerWorld: true } };
    }
  }
  return null;
}

// THE OWNER-ANCHOR LAW's lenient door (08-29: "Rainey Center" failed resolve()'s exact match
// against the stored "Rainey Center for Public Policy" and the disambiguator offered congressmen
// and Ma Rainey instead). Space/hyphen/punct-blind CONTAINMENT either way, with a floor so a tiny
// fragment ("center") can never claim the owner's world: the mention needs ≥2 tokens or ≥8 chars.
function resolveLoose(mention, { deps = {} } = {}) {
  const exact = resolve(mention, { deps });
  if (exact) return exact;
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  const m = norm(mention);
  if (!m || (m.length < 8 && !m.includes(' '))) return null;
  let rows = [];
  try { rows = _db(deps).getDb().prepare('SELECT * FROM owner_world').all(); } catch { return null; }
  for (const r of rows) {
    const obj = _hydrate(r);
    if (!obj) continue;
    for (const cand of [obj.name, ...(obj.aliases || [])]) {
      const c = norm(cand);
      // Both directions floored: a short alias ("Zo") must never match inside a long mention.
      if (c && (c.includes(m) || (m.includes(c) && (c.length >= 8 || c.includes(' '))))) {
        return { status: 'resolved', loose: true, object: { id: obj.coord, entity_type: obj.type, summary: obj.summary, namespace: obj.namespace, ownerWorld: true } };
      }
    }
  }
  return null;
}

module.exports = { seed, ensureSchema, upsert, addEdge, get, resolve, resolveLoose, mint, SEED_OBJECTS, SEED_EDGES };
