/**
 * lib/recall.js — memory-marker expansion (ctx restructure phase 2).
 *
 * Reflections + readings are shown to her as one-line MARKERS ([r188] / [m8574]) instead of full
 * text, to keep her prompt under num_ctx. When a marker is relevant she pulls the full text on
 * demand by emitting <recall ref="r188"/>. ref prefix → source table:
 *   r = reflections, m = monologue (thoughts + readings), k = knowledge.
 * Pure parse/strip + an injectable resolve (db getters passed in) so it's testable offline.
 */
const RECALL_RE = /<recall\s+ref="([rmk])(\d+)"\s*(?:\/>|>\s*<\/recall>)/gi;

function parseRecallTags(text) {
  if (!text) return [];
  const out = [];
  let m;
  RECALL_RE.lastIndex = 0;
  while ((m = RECALL_RE.exec(text)) !== null) {
    const kind = m[1], id = parseInt(m[2], 10);
    if (kind && id) out.push({ kind, id, ref: `${kind}${id}` });
  }
  return out;
}

function stripRecallTags(text) {
  if (!text) return text;
  return String(text)
    .replace(/<recall\s+ref="[rmk]\d+"\s*(?:\/>|>\s*<\/recall>)/gi, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Resolve one parsed ref to its full text via injected db getters. Never throws.
function resolveRecall(db, ref) {
  try {
    if (ref.kind === 'r') { const r = db.getReflectionById(ref.id); return r ? { ok: true, ref: ref.ref, text: r.content } : miss(ref); }
    if (ref.kind === 'm') { const r = db.getMonologueById(ref.id); return r ? { ok: true, ref: ref.ref, text: r.content } : miss(ref); }
    if (ref.kind === 'k') { const rows = db.getKnowledgeByIds([ref.id]); return (rows && rows[0]) ? { ok: true, ref: ref.ref, text: rows[0].content } : miss(ref); }
    return { ok: false, ref: ref.ref, text: `Unknown recall ref "${ref.ref}".` };
  } catch (e) { return { ok: false, ref: ref.ref, text: `recall ${ref.ref} failed: ${e.message}` }; }
}
function miss(ref) { return { ok: false, ref: ref.ref, text: `No memory found for ${ref.ref}.` }; }

module.exports = { parseRecallTags, stripRecallTags, resolveRecall, RECALL_RE };
