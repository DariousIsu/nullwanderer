/**
 * lib/recall.js — memory-marker + COORDINATE expansion (ctx restructure phase 2; coord deref, THE MERGE 2026-07-26).
 *
 * Reflections + readings are shown to her as one-line MARKERS ([r188] / [m8574]) instead of full
 * text, to keep her prompt under num_ctx. When a marker is relevant she pulls the full text on
 * demand by emitting <recall ref="r188"/>. ref prefix → source table:
 *   r = reflections, m = monologue (thoughts + readings), k = knowledge, d = stored DOCUMENTS.
 * `d` is the reading-citation wire (memory slice 1 #6): a reading that came from a stored doc is
 * shown as [dN "Title"] in grounding, and pulling dN returns the DOCUMENT ITSELF — so a writer can
 * quote the paper, not the reading's 240-char gist. The call site caps the pull (toolResultChars).
 *
 * ⭐ COORDINATE DEREF (THE MERGE). The turn manifest (lib/manifest) hands the cloud OBJECT COORDINATES
 * — `<type>:<namespace>/<id>` — as compact addresses (breadth-cheap). To go DEEP on one, the cloud
 * emits `<recall coord="person:owner/alice"/>` and gets that object's neighborhood back as a
 * tool-result THIS turn. This is the SAME dereference mechanic as ref="dN", generalized to the
 * coordinate scheme, and it is the ONLY way to reach the owner-world (self/family/org) — those live in
 * a local store, unreachable by any Echo tool. Civic coordinates route to the graph neighborhood.
 * Pure parse/strip + injectable resolvers (db getters / ownerGet / graphGet) so it's testable offline.
 */
const RECALL_RE = /<recall\s+ref="([rmkd])(\d+)"\s*(?:\/>|>\s*<\/recall>)/gi;
// A coordinate deref: <recall coord="person:owner/alice"/>. The coord is <type>:<namespace>/<id>;
// kept permissive on the id part (slugs, numeric ids, echo ids) but anchored on the `type:ns/` shape.
const COORD_RE = /<recall\s+coord="([a-z]+:[a-z0-9_-]+\/[^"]+)"\s*(?:\/>|>\s*<\/recall>)/gi;

function parseRecallTags(text) {
  if (!text) return [];
  const out = [];
  let m;
  RECALL_RE.lastIndex = 0;
  while ((m = RECALL_RE.exec(text)) !== null) {
    const kind = m[1], id = parseInt(m[2], 10);
    if (kind && id) out.push({ kind, id, ref: `${kind}${id}` });
  }
  COORD_RE.lastIndex = 0;
  while ((m = COORD_RE.exec(text)) !== null) {
    const coord = String(m[1] || '').trim();
    if (coord) out.push({ kind: 'coord', coord, ref: coord });
  }
  return out;
}

function stripRecallTags(text) {
  if (!text) return text;
  return String(text)
    .replace(/<recall\s+ref="[rmkd]\d+"\s*(?:\/>|>\s*<\/recall>)/gi, '')
    .replace(/<recall\s+coord="[a-z]+:[a-z0-9_-]+\/[^"]+"\s*(?:\/>|>\s*<\/recall>)/gi, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Resolve one coordinate to its neighborhood text. Injectable so it's offline-testable:
 *   ownerGet(coord) -> { name, summary, edges:[{src,rel,dst}] } | null   (owner-world store)
 *   graphGet(coord) -> string | null                                      (civic graph neighborhood)
 * Owner-world coordinates (self:/owner/work namespaces) resolve locally and authoritatively — nothing
 * else can reach them. Everything else tries the graph. A miss is reported honestly (it is a gap, not
 * a fact to invent). Never throws.
 */
function resolveCoord(coord, { ownerGet = null, graphGet = null } = {}) {
  const c = String(coord || '').trim();
  if (!c) return { ok: false, ref: c, text: 'empty coordinate' };
  // OWNER-WORLD FIRST — self:zoe/core, person:owner/*, org:work/* live in the local store.
  try {
    const g = ownerGet ? ownerGet(c) : null;
    if (g) {
      const edges = (g.edges || [])
        .map((e) => `${e.src === c ? '' : e.src + ' '}${e.rel} ${e.dst === c ? e.src : e.dst}`.trim())
        .join('; ');
      const body = `${g.name || c}${g.summary ? ' — ' + g.summary : ''}${edges ? `\nedges: ${edges}` : ''}`;
      return { ok: true, ref: c, text: body };
    }
  } catch (e) { /* fall through to graph */ }
  // CIVIC / GRAPH coordinate.
  try {
    const t = graphGet ? graphGet(c) : null;
    if (t && String(t).trim()) return { ok: true, ref: c, text: String(t).trim() };
  } catch (e) { /* fall through to miss */ }
  return { ok: false, ref: c, text: `Nothing held for ${c} yet — this is a gap. Say you don't hold it rather than inventing detail.` };
}

// Resolve one parsed ref to its full text via injected db getters. Never throws.
function resolveRecall(db, ref) {
  try {
    if (ref.kind === 'r') { const r = db.getReflectionById(ref.id); return r ? { ok: true, ref: ref.ref, text: r.content } : miss(ref); }
    if (ref.kind === 'm') { const r = db.getMonologueById(ref.id); return r ? { ok: true, ref: ref.ref, text: r.content } : miss(ref); }
    if (ref.kind === 'k') { const rows = db.getKnowledgeByIds([ref.id]); return (rows && rows[0]) ? { ok: true, ref: ref.ref, text: rows[0].content } : miss(ref); }
    if (ref.kind === 'd') {
      const r = db.getDocumentById(ref.id);
      return (r && r.body) ? { ok: true, ref: ref.ref, text: `${r.title ? `# ${r.title}\n\n` : ''}${r.body}` } : miss(ref);
    }
    return { ok: false, ref: ref.ref, text: `Unknown recall ref "${ref.ref}".` };
  } catch (e) { return { ok: false, ref: ref.ref, text: `recall ${ref.ref} failed: ${e.message}` }; }
}
function miss(ref) { return { ok: false, ref: ref.ref, text: `No memory found for ${ref.ref}.` }; }

module.exports = { parseRecallTags, stripRecallTags, resolveRecall, RECALL_RE };
