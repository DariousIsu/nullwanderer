/**
 * lib/manifest.js — the TURN MANIFEST builder (KEYSTONE Slice 1, 2026-07-25).
 *
 * The handoff between the local model and the cloud model is today a PROSE BLOB: code pre-pulls a fixed
 * slice of context, summarizes it as text, and the cloud writes a reply from that text. Prose is a lossy
 * channel — the cloud can't tell a grounded fact from an invented one (the "Municipal.com 2019 mission"
 * confab), only the salient topic gets resolved, and the local model wastes effort being a bad summarizer.
 *
 * The manifest replaces prose with COORDINATES. Every object the turn names is resolved to a stable handle
 * — `<type>:<namespace>/<id>` — that points at its whole neighborhood in the graph. The cloud reasons over
 * a tiny list of addresses and DEREFERENCES depth on demand (breadth-cheap, depth-on-demand). A coordinate
 * is ~15 tokens but relays an entire concept and everything it edges to.
 *
 * WHO DOES WHAT (the split that fixes "the local model sucks at DB retrieval"): the local model NAMES the
 * mentions (reused from intake.decompose — it already emits the full multi-object plan, the conversation
 * path just threw all but the salient one away via mention._pickObject). CODE resolves each mention to a
 * coordinate (a keyed lookup, not fuzzy retrieval — owner-world first, then the graph, mint short-term for
 * the unresolved). The cloud model only ever READS coordinates and reasons.
 *
 * "Everything in memory, long or short term, always has a fixed coordinate" (Lucas): an unresolved mention
 * is not dropped — it is MINTED a short-term coordinate so it is addressable NOW and accrues edges as she
 * learns (the Disney / LAMP-summit case: named today, filled when the flier is dropped tomorrow).
 *
 * Pure coordinate logic (toCoordinate / namespaceFor / assembleManifest) is separated from the I/O
 * orchestration (buildManifest) so the scheme is exhaustively offline-smoke-testable with injected deps.
 */
'use strict';

// Canonical entity types the manifest speaks. Aligned with intake/doc_decompose's ENTITY_TYPES, plus the
// two reserved namespaces that are not civic types at all — the self and the owner's world.
const CANON_TYPE = {
  person: 'person', people: 'person', human: 'person', individual: 'person',
  organization: 'org', org: 'org', organisation: 'org', company: 'org', agency: 'org', institution: 'org',
  place: 'place', location: 'place', gpe: 'place', city: 'place', country: 'place', state: 'place',
  event: 'event', bill: 'bill', committee: 'committee', government_body: 'gov', gov: 'gov',
  document: 'document', doc: 'document', concept: 'concept', topic: 'concept', idea: 'concept',
  work: 'work', claim: 'claim', other: 'thing', thing: 'thing', self: 'self',
};
function canonType(t) {
  const k = String(t || '').toLowerCase().replace(/[\s-]+/g, '_').replace(/[^a-z_]/g, '');
  return CANON_TYPE[k] || (k ? 'thing' : 'thing');
}

// Slugify a mention/name into the id component of a coordinate: lowercase, ascii words joined by '-'.
// Bounded so a whole-sentence mention can't become a monstrous id (the resolver upstream should have
// caught that, but the slug is the last guard).
function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-').filter(Boolean).slice(0, 6).join('-')
    .slice(0, 60) || 'unnamed';
}

// Build a coordinate string from its parts. `<type>:<namespace>/<id>`. The id is the resolved entity id
// when we have one (stable, dereferenceable), else a slug of the name (a short-term / owner-world handle).
function toCoordinate({ type, namespace, id, name } = {}) {
  const t = canonType(type);
  const ns = String(namespace || 'short').toLowerCase();
  const idPart = (id != null && String(id).trim() !== '') ? String(id).trim() : slugify(name);
  return `${t}:${ns}/${idPart}`;
}

// STATUS vocabulary — what the cloud must know about how solid a coordinate is (drives whether it speaks
// the object plainly, hedges it, or asks). Kept small and explicit.
const STATUS = {
  HELD: 'held',            // resolved to a real object we hold — deref for depth
  MINTED_NEW: 'minted-new',// unresolved but freshly minted a short-term coordinate — addressable, thin
  AMBIGUOUS: 'ambiguous',  // 2+ distinct candidates — the cloud should disambiguate or ask
  SELF: 'self',            // Zoe herself — mount from the self region, do not look up
  OWNER: 'owner',          // Lucas / his world — owner-namespace, not a civic entity
};

// Decide the namespace + status for one resolved (or unresolved) object. `resolution` is the shape
// echo_suit.resolveMention / intake.resolvePlan return: { status, object?, candidates? }. `flags` carries
// the cheap self/owner determination the caller made with db.isSelfName/isOwnerName.
function classify(object, resolution, { isSelf = false, isOwner = false } = {}) {
  // OWNER-WORLD wins first: a mention resolved against the owner-world store (Alice → the daughter, Zo →
  // Zoe self) carries its own namespace and IS held — it must never be reclassified as a civic namesake.
  const obj0 = object || (resolution && resolution.object);
  if (obj0 && obj0.ownerWorld) {
    const t = String(obj0.entity_type || '').toLowerCase();
    return { namespace: obj0.namespace || 'owner', status: t === 'self' ? STATUS.SELF : STATUS.HELD };
  }
  if (isSelf) return { namespace: 'zoe', status: STATUS.SELF };
  if (isOwner) return { namespace: 'owner', status: STATUS.OWNER };
  const rs = resolution && resolution.status;
  if (rs === 'ambiguous' && Array.isArray(resolution.candidates) && resolution.candidates.length >= 2) {
    return { namespace: 'graph', status: STATUS.AMBIGUOUS };
  }
  if (rs === 'resolved' && (object || (resolution && resolution.object))) {
    const obj = object || resolution.object;
    // an Echo/civic id vs a local graph id — best-effort namespace tag (both are dereferenceable handles)
    const ns = (obj && (obj.source === 'echo' || obj.origin === 'echo' || (obj.id != null && Number(obj.id) > 1000000))) ? 'echo' : 'graph';
    return { namespace: ns, status: STATUS.HELD };
  }
  return { namespace: 'short', status: STATUS.MINTED_NEW };
}

// PURE assembly: given the decompose plan and a parallel array of resolutions, emit the manifest object.
// No I/O — the caller supplies resolutions (from resolveFn) and the self/owner flags per object. This is
// the function the smoke drives directly.
function assembleManifest(plan, resolutions, { userName = 'Lucas', selfFlags = [], ownerFlags = [] } = {}) {
  const objects = (plan && Array.isArray(plan.objects)) ? plan.objects : [];
  const out = { user: userName, intent: (plan && plan.intent) || 'chat', objects: [], gaps: [], relations: [], temporal: null };

  objects.forEach((o, i) => {
    const res = resolutions[i] || { status: 'no-match', mention: o.mention };
    const resolved = (res && res.object) || null;
    const cls = classify(resolved, res, { isSelf: !!selfFlags[i], isOwner: !!ownerFlags[i] });
    const type = canonType(resolved && resolved.entity_type ? resolved.entity_type : o.type);
    // A self mention (Zoe/Zo) is always the canonical self coordinate. Owner-world ids ARE coordinates
    // already (e.g. 'person:owner/alice') — use them directly. Everything else composes type:namespace/id.
    let coord;
    if (cls.status === STATUS.SELF) {
      coord = 'self:zoe/core';
    } else if (resolved && resolved.ownerWorld && typeof resolved.id === 'string' && resolved.id.includes(':')) {
      coord = resolved.id;
    } else {
      const id = resolved && resolved.id != null ? resolved.id : null;
      coord = toCoordinate({ type, namespace: cls.namespace, id, name: o.mention });
    }
    const row = {
      surface: o.mention,
      coord,
      type,
      status: cls.status,
      salient: !!o.salient,
      gloss: (resolved && (resolved.summary || resolved.gloss)) ? String(resolved.summary || resolved.gloss).slice(0, 140) : null,
      candidates: (cls.status === STATUS.AMBIGUOUS && Array.isArray(res.candidates)) ? res.candidates.slice(0, 4) : undefined,
    };
    out.objects.push(row);
    // an unresolved thing the user asked us to work on is a GAP (surfaced explicitly so the cloud converts
    // silent gap-filling into an honest "I don't hold this yet") — minted-new coords are the gap set.
    if (cls.status === STATUS.MINTED_NEW) out.gaps.push({ surface: o.mention, coord });
  });

  // relations + temporal constraints ride straight through from the plan (the turn's own edge structure)
  out.relations = (plan && Array.isArray(plan.relations)) ? plan.relations.slice(0, 24) : [];
  const temporal = (plan && Array.isArray(plan.constraints)) ? plan.constraints.filter(c => c && c.kind === 'temporal') : [];
  if (temporal.length) out.temporal = temporal.map(t => t.value).filter(Boolean).join('; ') || null;
  if (plan && Array.isArray(plan.clarify) && plan.clarify.length) out.clarify = plan.clarify.slice(0, 3);
  return out;
}

// Render a manifest to the compact text block the cloud model receives. Deterministic, so the smoke can
// assert on it and so the handoff is stable/diffable. Coordinates lead; glosses are the one-line depth.
function render(manifest) {
  const lines = [];
  lines.push(`USER: ${manifest.user}`);
  lines.push(`INTENT: ${manifest.intent}`);
  lines.push('OBJECTS (state as fact ONLY what has a coordinate; deref for depth):');
  for (const o of manifest.objects) {
    const g = o.gloss ? `  ${o.gloss}` : '';
    const amb = o.candidates ? `  [ambiguous: ${o.candidates.join(' | ')}]` : '';
    lines.push(`  "${o.surface}" -> ${o.coord}  (${o.status}${o.salient ? ', salient' : ''})${g}${amb}`);
  }
  if (manifest.gaps.length) lines.push(`GAPS (you hold nothing yet — say so, do not invent): ${manifest.gaps.map(g => g.coord).join(', ')}`);
  if (manifest.temporal) lines.push(`TEMPORAL: ${manifest.temporal}`);
  if (manifest.relations.length) lines.push('EDGES: ' + manifest.relations.map(r => `${r.source} -${r.type}-> ${r.target}`).join(' · '));
  if (manifest.clarify) lines.push('CLARIFY IF NEEDED: ' + manifest.clarify.join(' / '));
  return lines.join('\n');
}

/**
 * I/O orchestration: text -> manifest. Composes the existing multi-object extractor (intake.decompose)
 * and a resolve function (echo_suit.resolveMention by default). Deps injectable for offline smokes:
 *   deps.decompose(text, {recent}) -> plan          (default: lib/intake.decompose)
 *   deps.resolve(mention, {preferType}) -> resolution (default: lib/echo_suit.resolveMention)
 *   deps.isSelfName(name) / deps.isOwnerName(name)   (default: lib/db)
 * Fail-soft: any failure yields a minimal manifest rather than throwing into the turn.
 */
async function buildManifest(text, { userName = 'Lucas', context = '', deps = {} } = {}) {
  const t = String(text || '').trim();
  if (!t) return { user: userName, intent: 'chat', objects: [], gaps: [], relations: [], temporal: null };

  const decompose = deps.decompose || ((m, o) => require('./intake').decompose(m, o));
  const resolve = deps.resolve || ((m, o) => require('./echo_suit').resolveMention(m, o));
  // OWNER-WORLD PRIOR: the tiny high-precision personal store is consulted BEFORE civic resolution, so a
  // bare "Alice" binds to the daughter, not a legislator (the whole point of the owner-world).
  const ownerResolve = deps.ownerResolve || ((n) => { try { return require('./owner_world').resolve(n); } catch { return null; } });
  const isSelfName = deps.isSelfName || ((n) => { try { return require('./db').isSelfName(n); } catch { return false; } });
  const isOwnerName = deps.isOwnerName || ((n) => { try { return require('./db').isOwnerName(n); } catch { return false; } });

  let plan;
  try { plan = require('./intake').routeDecomposition(await decompose(t, { recent: String(context || '').slice(0, 400), deps })); }
  catch { plan = { intent: 'chat', objects: [], relations: [], constraints: [], clarify: [] }; }

  const objects = Array.isArray(plan.objects) ? plan.objects : [];
  const selfFlags = objects.map(o => { try { return !!isSelfName(o.mention); } catch { return false; } });
  const ownerFlags = objects.map(o => { try { return !!isOwnerName(o.mention); } catch { return false; } });

  // Resolve each object. Self/owner mentions are NOT looked up (they'd hit civic namesakes — the Alice
  // problem); they carry their namespace directly. op==='create' means the plan already judged it new →
  // skip the resolve and let it mint short-term.
  const resolutions = [];
  for (let i = 0; i < objects.length; i++) {
    const o = objects[i];
    // owner-world FIRST — wins over civic and even over op=create (if we already hold Alice, she isn't new)
    let ow = null; try { ow = ownerResolve(o.mention); } catch {}
    if (ow && ow.object) { resolutions.push(ow); continue; }
    if (selfFlags[i] || ownerFlags[i] || o.op === 'create') { resolutions.push({ status: 'skip', mention: o.mention }); continue; }
    let r; try { r = await resolve(o.mention, { preferType: o.type || null }); } catch { r = { status: 'error', mention: o.mention }; }
    resolutions.push(r || { status: 'no-match', mention: o.mention });
  }

  const man = assembleManifest(plan, resolutions, { userName, selfFlags, ownerFlags });

  // ALWAYS MOUNT SELF: she is present on every turn, so her self-coordinate must never depend on the
  // decomposer happening to extract "Zo". Without this, a "are YOU excited?" turn had no self to deref
  // and she chased logistics instead of answering as herself (live, 2026-07-25). Prepended if absent.
  if (!man.objects.some((o) => o.coord === 'self:zoe/core')) {
    let selfGloss = null;
    try { const s = ownerResolve('Zoe'); if (s && s.object) selfGloss = s.object.summary; } catch {}
    man.objects.unshift({ surface: 'you', coord: 'self:zoe/core', type: 'self', status: STATUS.SELF, salient: false, gloss: selfGloss, candidates: undefined });
  }
  return man;
}

module.exports = {
  buildManifest, assembleManifest, render,
  toCoordinate, slugify, canonType, classify,
  CANON_TYPE, STATUS,
};
