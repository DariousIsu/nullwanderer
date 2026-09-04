'use strict';
/*
 * lib/markers.js — THE SUB-AGENT RESULT CONTRACT (stage 4.5, 2026-09-04; merge map §"The adversarial
 * step, from Alpha", part 3: "Markers become the sub-agent result contract: compact content plus
 * pointers into the memory map, so the assembler and the challenger read by address.").
 *
 * WHY (the usage principle in code, from Alpha's graph): an area agent returns ~500-800 tokens plus
 * MEMORY MARKERS — pointers to what it stored in the lower memory layers, never the raw data. "That
 * marker discipline is the usage principle in code, fresh context per agent and small calls, because
 * no agent ever carries another's raw findings." Side Quest today does the opposite: the operator
 * carries raw findings forward and the context grows until it truncates — a large part of why a
 * research paper stalls. A marker is a store ADDRESS the assembler and challenger resolve on demand.
 *
 * Ported from NX-ALPHA MemoryMarker {marker_id, type, source_layer, source_key, summary,
 * retrieval_query} (Desktop repo history, app/graph/state.py), adapted to this program's stores: a
 * marker's `ref` is a store address (a document id, an entity id, a fact id, a note path, a covered
 * target, a url), and `resolve` reads it by address through injected resolvers — so the whole contract
 * is pure and offline-testable, and fail-soft live (an unresolvable marker is dropped, never a throw).
 */

// The store a marker points into. `document`/`entity`/`fact`/`note` are memory-map layers; `target`
// is a covered roster entry; `url`/`tool_result`/`analysis` carry their own ref (a url, a run id, a note).
const MARKER_TYPES = Object.freeze(['document', 'entity', 'fact', 'note', 'target', 'url', 'tool_result', 'analysis']);
const CONTENT_CAP = 4000;     // the compact deliverable an agent returns inline — bounded, never a raw dump
const DIGEST_CAP = 1200;      // what the assembler/challenger CARRY per sub-result (marker summaries, not raw)

const _s = (v) => (v == null ? '' : String(v));

// Normalize one marker; null when it has no usable type+ref.
function marker({ type, ref, summary = '', query = '', id = null } = {}) {
  const t = _s(type).trim().toLowerCase();
  const r = _s(ref).trim();
  if (!MARKER_TYPES.includes(t) || !r) return null;
  return { id: id ? _s(id) : `${t}:${r}`, type: t, ref: r, summary: _s(summary).trim().slice(0, 240), query: _s(query).trim().slice(0, 200) };
}

// Parse a MARKERS block: each line is "type:ref — summary" or "[[type:ref]] summary" or "type:ref (query: …)".
function _parseMarkerLines(block) {
  const out = [];
  for (const raw of _s(block).split(/\n|(?:\s·\s)/)) {
    let line = raw.replace(/^[\s\-•*]+/, '').trim();
    if (!line) continue;
    const bb = /^\[\[([a-z_]+):([^\]]+)\]\]\s*(.*)$/i.exec(line);
    if (bb) { const m = marker({ type: bb[1], ref: bb[2], summary: bb[3] }); if (m) out.push(m); continue; }
    const qm = /\(query:\s*([^)]+)\)\s*$/i.exec(line); let query = '';
    if (qm) { query = qm[1]; line = line.slice(0, qm.index).trim(); }
    // "type:<ref>" or "type:<ref> — <summary>". The ref may contain spaces (a target name), so it runs
    // to the first SPACE-DELIMITED dash (a url's own hyphens/slashes are not space-delimited and stay whole).
    const cm = /^([a-z_]+)\s*[:=]\s*(.+)$/i.exec(line);
    if (cm) {
      let ref = cm[2].trim(), summary = '';
      const sep = /\s[—–]\s|\s-\s/.exec(ref);
      if (sep) { summary = ref.slice(sep.index + sep[0].length).trim(); ref = ref.slice(0, sep.index).trim(); }
      const m = marker({ type: cm[1], ref: ref.replace(/[,;]+$/, ''), summary, query });
      if (m) out.push(m);
    }
  }
  // dedupe on id, keep the first (richest summary tends to come first)
  const seen = new Set(); return out.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
}

function _section(text, name, next) {
  const s = _s(text);
  const m = new RegExp(`(?:^|\\n)\\s*${name}\\s*:\\s*`, 'i').exec(s);
  if (!m) return '';
  let rest = s.slice(m.index + m[0].length), cut = rest.length;
  for (const n of next) { const r = new RegExp(`(?:^|\\n)\\s*${n}\\s*:`, 'i').exec(rest); if (r && r.index < cut) cut = r.index; }
  return rest.slice(0, cut).trim();
}

/**
 * parseResult(text) → { summary, content, markers[], sources[], parsed }
 * The return shape resultContract() asks for: SUMMARY / CONTENT / MARKERS / SOURCES. Tolerant — a
 * missing section is empty; a reply with no shape at all becomes {content: the whole text} so a
 * legacy agent's prose is never lost (it just carries no addresses).
 */
function parseResult(text) {
  const s = _s(text);
  const NAMES = ['SUMMARY', 'CONTENT', 'MARKERS', 'SOURCES'];
  const summary = _section(s, 'SUMMARY', NAMES);
  let content = _section(s, 'CONTENT', NAMES);
  const markers = _parseMarkerLines(_section(s, 'MARKERS', NAMES));
  const srcBlock = _section(s, 'SOURCES', NAMES);
  const sources = Array.from(new Set((srcBlock.match(/https?:\/\/[^\s)\]>,;"']+/g) || []).map((u) => u.replace(/[.,;:]+$/, ''))));
  const anyShape = !!(summary || content || markers.length || srcBlock);
  if (!anyShape) content = s.trim();     // legacy prose — kept, but addressless
  return { summary: summary.slice(0, 400), content: content.slice(0, CONTENT_CAP), markers, sources, parsed: anyShape };
}

/**
 * resultContract({compactWords}) — the instruction appended to a sub-agent's task so it returns the
 * contract instead of a raw dump. Storing the raw findings is the agent's OWN job (it has the tools);
 * a marker points at what it stored, so the assembler reads by address, never by carrying the raw.
 */
function resultContract({ compactWords = 250 } = {}) {
  return '\n\nYour reply IS the return value, and it MUST be COMPACT — never a raw dump. Store your raw findings '
    + 'in the stores you already use (documents, entities, facts, notes, sources); your reply carries only POINTERS '
    + `to them. Keep CONTENT under ~${compactWords} words. End in this exact shape:\n`
    + 'SUMMARY: <one line — what you established>\n'
    + 'CONTENT: <the compact deliverable: the findings in brief, no raw pastes>\n'
    + 'MARKERS: <one per line, each a pointer to what you STORED — "type:ref — summary", where type is one of '
    + `${MARKER_TYPES.join(', ')} and ref is the store address (a document id, an entity id, a fact id, a note path, `
    + 'a covered target, or a url); add "(query: <terms>)" when a retrieval query helps>\n'
    + 'SOURCES: <the urls/records behind the found items>';
}

/**
 * digest(result, {maxChars}) — the COMPACT form the assembler and the challenger carry in context:
 * the summary, the bounded content, and the marker SUMMARIES (their addresses), never the raw data
 * behind them. This is what keeps a swarm's context from growing with every sub-result.
 */
function digest(result, { maxChars = DIGEST_CAP } = {}) {
  const r = (result && result.markers) ? result : parseResult(_s(result));
  const parts = [];
  if (r.summary) parts.push(r.summary);
  if (r.content) parts.push(r.content);
  if (r.markers.length) parts.push('markers: ' + r.markers.map((m) => `${m.type}:${m.ref}${m.summary ? ` (${m.summary})` : ''}`).join('; '));
  if (r.sources.length) parts.push('sources: ' + r.sources.join(', '));
  let out = parts.join('\n');
  if (out.length > maxChars) out = out.slice(0, maxChars - 1) + '…';
  return out;
}

/**
 * resolve(marker, resolvers) — read the raw data a marker points at, BY ADDRESS. `resolvers` maps a
 * marker type to (ref, marker) → text (sync or async). Fail-soft: an unknown type, a missing resolver,
 * or a resolver that throws returns null — the assembler simply has one fewer address to read, never
 * a crash. This is the ONLY door that pulls raw data back, and it is called on demand, not by default.
 */
async function resolve(mk, resolvers = {}) {
  if (!mk || !mk.type) return null;
  const fn = resolvers[mk.type];
  if (typeof fn !== 'function') return null;
  try { const t = await fn(mk.ref, mk); return t == null ? null : _s(t); } catch { return null; }
}

/** resolveAll(markers, resolvers, {maxChars}) — read a set of markers by address, bounded. For the
 * moment the assembler genuinely needs the raw (a final pass), not the steady state. */
async function resolveAll(markers = [], resolvers = {}, { maxChars = 24000 } = {}) {
  const out = [];
  let used = 0;
  for (const mk of markers || []) {
    const t = await resolve(mk, resolvers);
    if (!t) continue;
    const block = `--- ${mk.type}:${mk.ref}${mk.summary ? ` (${mk.summary})` : ''} ---\n${t}`;
    if (used + block.length > maxChars) break;
    out.push(block); used += block.length + 2;
  }
  return out.join('\n\n');
}

module.exports = { MARKER_TYPES, CONTENT_CAP, DIGEST_CAP, marker, parseResult, resultContract, digest, resolve, resolveAll };
