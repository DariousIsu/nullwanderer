/**
 * lib/active_recall.js — ACTIVE database integration: "what do I already know about X?" across ALL
 * her stores, consulted BEFORE she researches or answers.
 *
 * The waste this kills: she holds 600+ knowledge notes + an entity/relation graph, yet re-derives
 * things she already knows from the web (and re-checks facts she already has). Lucas: "a lot of this
 * information she already knows without realizing it." So: unify recall, and let coverage CHANGE
 * behavior — rich hit → build on it / answer; thin → research. (Self-RAG / Adaptive-RAG: decide
 * whether you even need to retrieve; HippoRAG: recall across the memory graph.)
 *
 * Stores: knowledge notes via memory.retrieveScored (spans reflection_knowledge, learning,
 * verified_fact, interest_summary, trajectories — embeddings + floor-gated) + best-effort
 * entity/relation facts from the graph. retrieveFn/graphFn injectable for offline tests.
 * (Named active_recall — lib/recall.js is the unrelated <recall> marker-expander.)
 */
const memory = require('./memory');

const RICH_NOTES = 3;   // ≥ this many on-topic notes (or any verified_fact, or graph facts) = "rich"

// A resolved Echo OBJECT this substantial = we already hold the target's whole record → rich, don't
// re-research (the Curtis fix: his degree-320 dossier is one quick_lookup away). A degree-1 stub
// with no facts does NOT flip coverage — it falls through to notes like before.
function _objectRich(obj) { return !!(obj && (obj.degree >= 8 || (obj.facts || []).length >= 4 || (obj.committees || []).length >= 1)); }
function _hasObject(obj) { return !!(obj && ((obj.facts || []).length || (obj.committees || []).length || (obj.neighbors || []).length)); }

async function recall(topic, { k = 6, minRelevance = 0.33, retrieveFn = null, graphFn = null, echoFn = null, objectFn = null, object = true } = {}) {
  const t = String(topic || '').trim();
  if (!t) return { topic: t, notes: [], facts: [], object: null, coverage: 'thin', echo: 0 };
  const retrieve = retrieveFn || ((q) => memory.retrieveScored(q, { k, minRelevance }));
  let local = []; try { local = (await retrieve(t)) || []; } catch { local = []; }
  let facts = []; try { facts = (graphFn ? graphFn(t) : _graphFacts(t)) || []; } catch { facts = []; }
  // ECHO-SEARCH-FIRST: resolve the target to its canonical Echo OBJECT and pull the whole thing in
  // ONE cheap call (facts + bio + committees + degree) — the mandatory first move that #2915 skipped.
  // Only for entity-shaped targets (a name/short phrase, not a paragraph) so we don't quick_lookup prose.
  let obj = null;
  if (object && _looksLikeEntity(t)) { try { obj = (objectFn ? await objectFn(t) : await _echoObject(t)) || null; } catch { obj = null; } }
  // ECHO MASTER DB: query the system-of-record corpus (search_knowledge) — the real "she already
  // knows it" pool. Reference-not-copy: snippets surface into recall, never copied into sq.db.
  let echoHits = []; try { echoHits = (echoFn ? await echoFn(t) : await _echoSearch(t)) || []; } catch { echoHits = []; }
  const notes = local.concat(echoHits);
  const rich = _objectRich(obj) || notes.length >= RICH_NOTES || local.some(n => n.source === 'verified_fact') || facts.length >= 3 || echoHits.length >= 2;
  return { topic: t, notes, facts, object: obj, coverage: rich ? 'rich' : 'thin', echo: echoHits.length };
}
// Entity-shaped = a name/short phrase we can hand to quick_lookup (single-name → dossier), not a
// full sentence. Keeps the object pull cheap + on-target.
function _looksLikeEntity(t) { const toks = String(t).trim().split(/\s+/); return toks.length >= 1 && toks.length <= 6; }
function _echoSearch(topic) { try { return require('./echo_suit').recallKnowledge(topic); } catch { return Promise.resolve([]); } }
function _echoObject(topic) { try { return require('./echo_suit').recallObject(topic); } catch { return Promise.resolve(null); } }

// The resolved OBJECT as render-ready lines — leads the prior-knowledge block: "you already hold
// this person's whole record." Pure (no Echo dep) so active_recall stays offline-testable.
function _objectLines(obj, { maxFacts = 10 } = {}) {
  if (!obj) return [];
  const head = `[object] ${obj.name || '(unnamed)'}${obj.type ? ` — ${obj.type}${obj.subtype ? '/' + obj.subtype : ''}` : ''}${obj.degree ? `, degree ${obj.degree}` : ''}${obj.role ? ` — ${obj.role}` : ''}`;
  const lines = [head];
  for (const f of (obj.facts || []).slice(0, maxFacts)) lines.push(`  • ${f}`);
  if ((obj.committees || []).length) lines.push(`  • committees: ${obj.committees.join('; ')}`);
  if ((obj.neighbors || []).length) lines.push(`  • related: ${obj.neighbors.slice(0, 8).join(', ')}`);
  return lines;
}

// Best-effort entity/relation recall from the graph. Match topic tokens to entities, pull neighbors.
// Fully defensive — any shape mismatch / uninitialized graph → []; the notes carry recall regardless.
function _graphFacts(topic) {
  let gm; try { gm = require('./graph_memory'); } catch { return []; }
  const toks = String(topic).toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 4).slice(0, 4);
  const out = []; const seen = new Set();
  for (const tok of toks) {
    let e = null; try { e = gm.getEntity(tok); } catch {}
    if (!e) continue;
    let ns = []; try { ns = gm.neighbors(e.name || tok, { limit: 5 }) || []; } catch {}
    for (const n of ns) { const s = _relStr(n); if (s && !seen.has(s)) { seen.add(s); out.push(s); if (out.length >= 6) return out; } }
  }
  return out;
}
function _relStr(n) {
  if (!n || typeof n !== 'object') return null;
  if (n.source && n.type && n.target) return `${n.source} ${String(n.type).toLowerCase().replace(/_/g, ' ')} ${n.target}`;
  if (n.name && n.summary) return `${n.name}: ${n.summary}`;
  return n.summary || n.name || null;
}

function _tag(src) {
  if (src && src.startsWith('echo:')) return src;   // [echo:wikipedia] — from the master DB
  return src === 'learning' ? 'learned' : src === 'interest_summary' ? 'summary' : src === 'trajectory' ? 'did' : 'note';
}

// The prior-knowledge block for a research/focus tick — now active: a rich hit tells her to build
// PAST what she holds, not re-derive it. (learning.buildPriorKnowledgeBlock delegates here.)
async function knowledgeBlock(topic, opts = {}) {
  const r = await recall(topic, opts);
  if (!r.notes.length && !r.facts.length && !_hasObject(r.object)) return null;
  const lines = [`WHAT YOU ALREADY KNOW about "${r.topic.replace(/\s+/g, ' ').slice(0, 80)}" (from your own memory — you may already hold this without realizing):`];
  // Lead with the resolved Echo object — the whole record we already hold on the target.
  if (_hasObject(r.object)) for (const l of _objectLines(r.object)) lines.push(l);
  for (const n of r.notes) {
    const s = (n.content || '').replace(/\s+/g, ' ').slice(0, 180);
    if (!s) continue;
    if (n.source === 'verified_fact') {
      let p = {}; try { p = n.provenance ? JSON.parse(n.provenance) : {}; } catch {}
      lines.push(`  [VERIFIED as of ${p.as_of || 'recently'}] ${s}`);
    } else lines.push(`  [${_tag(n.source)}] ${s}`);
  }
  for (const f of r.facts) lines.push(`  [graph] ${f}`);
  if (lines.length === 1) return null;
  if (r.coverage === 'rich') {
    lines.push(`You ALREADY hold substantial knowledge here — do NOT restate it or look it up again. Find the ONE thing you do not yet know and learn THAT. Extend the frontier; do not circle.`);
  } else {
    lines.push(`You know a little here — build on it; find the next concrete thing, don't restart.`);
  }
  return lines.join('\n');
}

// First-person consolidation she "reads" instead of re-searching (the active-gate output).
function formatConsolidation(r) {
  const lines = [`I checked my own memory on "${r.topic.replace(/\s+/g, ' ').slice(0, 80)}" before looking it up — I already know:`];
  if (_hasObject(r.object)) for (const l of _objectLines(r.object, { maxFacts: 6 })) lines.push(l.replace(/^\[object\]\s*/, '• ').replace(/^\s+•/, '  •'));
  for (const n of r.notes.slice(0, 5)) { const s = (n.content || '').replace(/\s+/g, ' ').slice(0, 180); if (s) lines.push(`• ${s}`); }
  for (const f of r.facts.slice(0, 4)) lines.push(`• ${f}`);
  lines.push(`Rather than re-research this, I should build on it — what specifically don't I know yet?`);
  return lines.join('\n');
}

async function coverage(topic, opts = {}) { return (await recall(topic, opts)).coverage; }

module.exports = { recall, knowledgeBlock, formatConsolidation, coverage, _graphFacts, _relStr, _objectLines, _objectRich, _looksLikeEntity, RICH_NOTES };
