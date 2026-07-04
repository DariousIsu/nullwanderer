/**
 * lib/graph_walk.js — the subconscious as a GRAPH-BUILDER (object-memory Slice 5).
 *
 * The idle loop's job is no longer to ruminate / free-associate (that became a noise generator that
 * produced ~180 low-value "thoughts"/hr). Its job is to GROW THE GRAPH. Each MOVE:
 *
 *   ANCHOR   — the cloud cortex reads RECENT CONVERSATION for an object she has no / a thin record of
 *   RESOLVE  — Echo-search-FIRST: exists → pull it; missing → BUILD it and fill from web + tools
 *   WALK     — flow to connected branches: enrich thin neighbours, FORGE missing connections
 *   GUARD    — after a node + connection budget, re-anchor on a fresh conversation gap (else go quiet)
 *   VOICE    — a notable move (a build, or ≥1 new connection) returns one line for Dans to speak;
 *              everything else is SILENT graph growth. Output is graph edges, not thought-rows.
 *
 * Front/Cortex: the CLOUD interprets + decides + writes (propose_*); the LOCAL model only VOICES.
 * Writes are propose_* only — pending, Echo-gated at promotion — so this is safe on the auto loop
 * (see lib/echo_tier: the 'propose' tier).
 *
 * Pure + deps-injected: cloud / web / recall / resolve / dispatch / getMeta / setMeta / now / log are
 * ALL passed in, so the whole builder is offline-testable with no model, network, or Echo. Live wiring
 * lives in monologue.js (the tick).
 */
'use strict';

// --- knobs (the guard) ------------------------------------------------------
const THIN_DEGREE = 8;            // an object below this degree is "thin" → worth filling
const THIN_FACTS = 3;             // …or with fewer than this many facts
const WALK_MAX_NODES = 5;         // nodes touched per move before we re-anchor
const WALK_MAX_CONNECTIONS = 8;   // connections proposed per move before we re-anchor
const MAX_CANDIDATES = 6;         // recent-conversation mentions we consider per move
const WALK_MAX_TRIES = 3;         // anchors we'll ATTEMPT per move before giving up (no-op-move fix)
const VISITED_TTL_MS = 6 * 3600 * 1000;   // don't re-anchor the same object within this window
const VISITED_KEY = 'graphwalk.visited';  // JSON [[key, ts], …]
const STOPNAMES = new Set(['i', 'you', 'he', 'she', 'they', 'it', 'we', 'lucas', 'zoe', 'the', 'a', 'an', 'this', 'that']);

// --- pure helpers -----------------------------------------------------------

// Tolerant JSON extraction — models wrap arrays/objects in prose or fences. Returns parsed value or null.
function parseJsonLoose(text) {
  if (text == null) return null;
  const s = String(text);
  try { return JSON.parse(s); } catch {}
  const m = s.match(/\[[\s\S]*\]|\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

// Regex fallback candidate extractor: runs of Capitalized words (proper nouns), honorifics dropped.
// Used only when the cloud extractor is unavailable/empty — keeps the walker alive offline.
function extractProperNouns(text) {
  const out = [];
  const re = /\b([A-Z][a-zA-Z0-9.'-]+(?:\s+(?:of|the|for|and|&|[A-Z][a-zA-Z0-9.'-]+)){0,5})\b/g;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    let name = m[1].replace(/^(?:Sen\.?|Senator|Rep\.?|Representative|Dr\.?|Mr\.?|Mrs\.?|Ms\.?|Gov\.?|Governor|President)\s+/i, '').trim();
    name = name.replace(/[.,;:'"]+$/, '').trim();
    const toks = name.split(/\s+/);
    if (name.length < 3) continue;
    if (toks.length === 1 && STOPNAMES.has(name.toLowerCase())) continue;
    out.push(name);
  }
  return out;
}

// null → 'missing'; low degree / few facts → 'thin'; else 'rich'. The gap classifier.
function classifyObject(obj) {
  if (!obj) return 'missing';
  const degree = Number(obj.degree) || 0;
  const facts = Array.isArray(obj.facts) ? obj.facts.length : 0;
  const committees = Array.isArray(obj.committees) ? obj.committees.length : 0;
  if (degree < THIN_DEGREE && facts < THIN_FACTS && committees === 0) return 'thin';
  return 'rich';
}

// Order assessed candidates into a work queue: missing first (build), then thin (fill, thinnest first);
// rich and recently-visited are dropped. Deterministic → smoke-testable.
function rankGaps(assessed, visitedKeys = new Set()) {
  const fresh = (assessed || []).filter(a => a && a.mention && !visitedKeys.has(visitKey(a.mention)));
  const missing = fresh.filter(a => a.kind === 'missing');
  const thin = fresh.filter(a => a.kind === 'thin')
    .sort((x, y) => (Number(x.object && x.object.degree) || 0) - (Number(y.object && y.object.degree) || 0));
  return [...missing, ...thin];
}

function visitKey(name) {
  return String(name || '').toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean).sort().join(' ');
}

// visited state (recently-worked anchors), TTL-pruned. getMeta/setMeta injected.
function loadVisited(getMeta, now) {
  let arr = [];
  try { arr = JSON.parse((getMeta && getMeta(VISITED_KEY)) || '[]'); } catch {}
  const cutoff = now - VISITED_TTL_MS;
  return (Array.isArray(arr) ? arr : []).filter(e => Array.isArray(e) && e[1] >= cutoff);
}
function visitedKeySet(getMeta, now) { return new Set(loadVisited(getMeta, now).map(e => e[0])); }
function recordVisited({ getMeta, setMeta, now, names }) {
  const arr = loadVisited(getMeta, now);
  const have = new Set(arr.map(e => e[0]));
  for (const nm of (names || [])) { const k = visitKey(nm); if (k && !have.has(k)) { arr.push([k, now]); have.add(k); } }
  try { setMeta && setMeta(VISITED_KEY, JSON.stringify(arr)); } catch {}
  return arr.length;
}

// --- cloud prompt builders (pure) -------------------------------------------

function buildCandidatePrompt(recentTurns) {
  const convo = (recentTurns || []).slice(-14).map(t => {
    const who = t.speaker === 'user' ? 'Lucas' : (t.speaker === 'ai_said' ? 'you' : t.speaker);
    return `${who}: ${String(t.content || '').replace(/\s+/g, ' ').slice(0, 280)}`;
  }).join('\n');
  return [
    { role: 'system', content: 'You extract the concrete ENTITIES (people, organizations, places, works, events, named concepts) that appear in a conversation, so a knowledge graph can be checked for gaps. Output ONLY a JSON array of the entity names, most-central first, no more than 8. No prose, no keys — just ["Name one","Name two"]. Skip pronouns, the speakers themselves, and generic words.' },
    { role: 'user', content: `Conversation:\n${convo || '(none)'}\n\nEntities as a JSON array:` }
  ];
}

function buildDossierPrompt(mention, sources, { existing = null, neighbors = [] } = {}) {
  const src = (sources || []).slice(0, 6).map((s, i) => `[S${i + 1}] ${String((s && (s.text || s.content || s.snippet)) || s || '').replace(/\s+/g, ' ').slice(0, 320)}`).join('\n');
  const have = existing ? `\nWHAT THE GRAPH ALREADY HOLDS on "${mention}" (build PAST this, do not repeat): ${String(existing.role || '')} ${(existing.facts || []).slice(0, 4).join('; ')}`.slice(0, 400) : '';
  const nbr = neighbors && neighbors.length ? `\nAlready-linked neighbours (do not re-propose these edges): ${neighbors.slice(0, 10).join(', ')}` : '';
  return [
    { role: 'system', content: 'You turn sources into a knowledge-graph object. Ground every claim in the sources; invent nothing. Output ONLY JSON of the shape {"entity_type":"person|organization|place|work|event|concept","summary":"2-4 dense factual sentences","related":[{"name":"Other Entity","type":"person|organization|...","relation":"short_relation_label"}]}. `related` = up to 6 OTHER entities this one is genuinely connected to (per the sources), each a real connection worth adding to the graph. No prose outside the JSON.' },
    { role: 'user', content: `Entity: "${mention}"${have}${nbr}\n\nSources:\n${src || '(none)'}\n\nJSON:` }
  ];
}

// --- async operations (deps injected) ---------------------------------------

// Read recent conversation → candidate entity names (cloud first, regex fallback). Deduped, capped.
async function extractCandidates(recentTurns, { cloud, log } = {}) {
  let names = [];
  if (typeof cloud === 'function') {
    try {
      const out = await cloud(buildCandidatePrompt(recentTurns), { num_predict: 200, temperature: 0.2 });
      const arr = parseJsonLoose(out);
      if (Array.isArray(arr)) names = arr.map(x => (typeof x === 'string' ? x : (x && x.name)) || '').filter(Boolean);
    } catch (e) { log && log('[graph-walk] candidate cloud extract failed: ' + e.message); }
  }
  if (!names.length) {
    const text = (recentTurns || []).filter(t => t.speaker === 'user').map(t => t.content || '').join('\n');
    names = extractProperNouns(text);
  }
  // dedup by visit-key, cap
  const seen = new Set(); const out = [];
  for (const n of names) { const k = visitKey(n); if (k && !seen.has(k)) { seen.add(k); out.push(String(n).trim()); } if (out.length >= MAX_CANDIDATES) break; }
  return out;
}

// For each candidate, Echo-first recall → classify the gap. Returns [{mention, kind, object}].
async function assessGaps(candidates, { recall, log } = {}) {
  const out = [];
  for (const mention of (candidates || [])) {
    let obj = null;
    try { obj = typeof recall === 'function' ? await recall(mention) : null; } catch (e) { log && log('[graph-walk] recall failed for ' + mention + ': ' + e.message); }
    out.push({ mention, kind: classifyObject(obj), object: obj });
  }
  return out;
}

// Add one entity to the graph — additive + auto-disambiguated (Levenshtein 0.85 → 'created' /
// 'already_exists' / 'merge_suggested', never a blind dup). Echo's propose_entity schema is
// {name, entity_type, summary?, entity_subtype?, confidence?} with additionalProperties:false — do
// NOT pass extra keys (they're rejected). Fail-soft; true iff Echo accepted.
async function proposeEntity({ dispatch, name, entity_type, summary }) {
  if (typeof dispatch !== 'function' || !name) return false;
  try {
    const args = { name, entity_type: entity_type || 'concept' };
    if (summary) args.summary = String(summary).slice(0, 1200);
    const r = await dispatch({ kind: 'do', name: 'propose_entity', args });
    return !!(r && r.ok);
  } catch { return false; }
}

// Add one edge — BOTH endpoints must already exist (we propose the entities first). Schema is
// {source_name, target_name, relation_type, confidence?}, additionalProperties:false. Fail-soft.
async function proposeRelation({ dispatch, source, target, relation_type }) {
  if (typeof dispatch !== 'function' || !source || !target || source === target) return false;
  try {
    const r = await dispatch({ kind: 'do', name: 'propose_relation', args: { source_name: source, target_name: target, relation_type: relation_type || 'related_to' } });
    return !!(r && r.ok);
  } catch { return false; }
}

// GROW the graph around one anchor gap: fill from web+tools into a dossier, propose the object (if
// missing) + its related objects + the connecting edges — all under the node/connection budget.
// Returns { built, entities, connections, related:[names], summary }.
async function growAround(gap, { web, cloud, dispatch, kgNeighbors, log } = {}) {
  const mention = gap.mention;
  let sources = [];
  if (typeof web === 'function') { try { sources = (await web(mention, 5)) || []; } catch (e) { log && log('[graph-walk] web fill failed: ' + e.message); } }

  // avoid re-proposing edges that already exist
  let neighbors = [];
  if (gap.kind !== 'missing' && gap.object && gap.object.id && typeof kgNeighbors === 'function') {
    try { neighbors = (await kgNeighbors(gap.object.id)) || []; } catch {}
  } else if (gap.object && Array.isArray(gap.object.neighbors)) {
    neighbors = gap.object.neighbors;
  }

  let dossier = null;
  if (typeof cloud === 'function') {
    try {
      const out = await cloud(buildDossierPrompt(mention, sources, { existing: gap.object, neighbors }), { num_predict: 500, temperature: 0.3 });
      dossier = parseJsonLoose(out);
    } catch (e) { log && log('[graph-walk] dossier synth failed: ' + e.message); }
  }
  if (!dossier || typeof dossier !== 'object') return { built: false, entities: 0, connections: 0, related: [], summary: '' };

  const nbrKeys = new Set(neighbors.map(visitKey));
  let entities = 0, connections = 0; const related = [];

  // 1) the anchor object itself — only if MISSING (we can't rewrite an existing one on the auto loop;
  //    for a thin object we enrich by CONNECTION, below).
  if (gap.kind === 'missing') {
    if (await proposeEntity({ dispatch, name: mention, entity_type: dossier.entity_type, summary: dossier.summary })) entities++;
  }

  // 2) related objects + the connecting edges (the "walk" / gap-fill), under budget.
  const rel = Array.isArray(dossier.related) ? dossier.related : [];
  for (const r of rel) {
    if (entities + connections >= (WALK_MAX_NODES + WALK_MAX_CONNECTIONS)) break;
    if (connections >= WALK_MAX_CONNECTIONS) break;
    const rname = String((r && r.name) || '').trim();
    if (!rname || visitKey(rname) === visitKey(mention)) continue;
    if (nbrKeys.has(visitKey(rname))) continue;   // edge already in the graph — skip
    // propose the related entity (harmless if it already exists — Echo dedups on promotion)
    if (entities < WALK_MAX_NODES && await proposeEntity({ dispatch, name: rname, entity_type: r.type, summary: '' })) entities++;
    if (await proposeRelation({ dispatch, source: mention, target: rname, relation_type: (r && r.relation) || 'related_to' })) { connections++; related.push(rname); }
  }

  return { built: gap.kind === 'missing' && entities > 0, entities, connections, related, summary: String(dossier.summary || '').trim() };
}

// One full graph-building MOVE. Orchestrates anchor → grow → record → voice. Returns a result the
// caller uses to (optionally) voice one line and log. Never throws (fail-soft everywhere).
async function runMove(deps = {}) {
  const { recentTurns = [], candidates: injected, cloud, web, recall, dispatch, kgNeighbors, getMeta, setMeta, now = () => Date.now(), log } = deps;
  const nowTs = now();
  try {
    // ANCHOR SOURCE: prefer an injected, already-sourced candidate list (idle_anchors: news → thin
    // frontier → convo). Fall back to conversation-only extraction when none is supplied (legacy path,
    // and the smoke's direct call). Each candidate carries a `source` tag for logging/steering.
    let candList;
    if (Array.isArray(injected) && injected.length) {
      candList = injected.map(c => (typeof c === 'string' ? { mention: c, source: 'convo' } : { mention: c.mention, source: c.source || 'convo' })).filter(c => c.mention);
    } else {
      candList = (await extractCandidates(recentTurns, { cloud, log })).map(m => ({ mention: m, source: 'convo' }));
    }
    if (!candList.length) return { acted: false, reason: 'no-candidates' };
    const srcByKey = new Map(candList.map(c => [visitKey(c.mention), c.source]));

    const assessed = (await assessGaps(candList.map(c => c.mention), { recall, log }))
      .map(a => ({ ...a, source: srcByKey.get(visitKey(a.mention)) || 'convo' }));
    const visited = visitedKeySet(getMeta, nowTs);
    const queue = rankGaps(assessed, visited);
    if (!queue.length) return { acted: false, reason: 'no-gap' };   // nothing worth building → go quiet

    // NO-OP-MOVE FIX: try anchors in rank order until one actually GROWS the graph (a build or a new
    // edge), up to WALK_MAX_TRIES. A dud (rich/un-connectable) anchor no longer wastes the whole move —
    // and every anchor we touch is recorded visited so we don't re-grind it next tick.
    const tried = [];
    let anchor = queue[0], grown = null;
    for (const cand of queue.slice(0, WALK_MAX_TRIES)) {
      anchor = cand;
      grown = await growAround(cand, { web, cloud, dispatch, kgNeighbors, log });
      tried.push(cand.mention);
      if (grown && (grown.built || grown.connections > 0)) break;   // productive → stop
    }
    grown = grown || { built: false, entities: 0, connections: 0, related: [], summary: '' };
    recordVisited({ getMeta, setMeta, now: nowTs, names: [...tried, ...grown.related] });

    const notable = grown.built || grown.connections > 0;
    const voiceLine = notable
      ? (grown.built
        ? `I didn't have anything on ${anchor.mention} — pulled it together${grown.connections ? ` and linked it to ${grown.related.slice(0, 2).join(' and ')}` : ''}.`
        : `Filled in ${anchor.mention} — connected it to ${grown.related.slice(0, 2).join(' and ')}.`)
      : '';
    return {
      acted: notable, anchor: anchor.mention, kind: anchor.kind, source: anchor.source,
      built: grown.built, entities: grown.entities, connections: grown.connections,
      related: grown.related, summary: grown.summary, voiceLine,
      reason: notable ? 'grew' : 'no-growth'
    };
  } catch (e) { log && log('[graph-walk] move failed: ' + (e && e.message)); return { acted: false, reason: 'error', error: e && e.message }; }
}

module.exports = {
  runMove, extractCandidates, assessGaps, growAround, proposeEntity, proposeRelation,
  parseJsonLoose, extractProperNouns, classifyObject, rankGaps, visitKey,
  loadVisited, visitedKeySet, recordVisited, buildCandidatePrompt, buildDossierPrompt,
  THIN_DEGREE, THIN_FACTS, WALK_MAX_NODES, WALK_MAX_CONNECTIONS, MAX_CANDIDATES, VISITED_TTL_MS, VISITED_KEY
};
