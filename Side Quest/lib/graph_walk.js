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

const CG = require('./curation_gate');   // the citation gate: existence + fact gates over the shared grade ladder

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
    { role: 'system', content: 'You turn sources into a knowledge-graph object. Ground every claim in the sources; invent nothing. Output ONLY JSON of the shape {"entity_type":"person|organization|place|work|event|concept","summary":"2-4 dense factual sentences","related":[{"name":"Other Entity","type":"person|organization|...","relation":"short_relation_label","source":"S#"}]}. `related` = up to 6 OTHER entities this one is genuinely connected to. For EACH related entity you MUST set "source" to the [S#] label of the source that STATES this connection. If a connection is your own INFERENCE beyond what the sources say, set "source":"inferred" — be honest: an inferred connection is HELD OUT, not added to the graph. No prose outside the JSON.' },
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
async function growAround(gap, { web, cloud, dispatch, kgNeighbors, observe, log } = {}) {
  const mention = gap.mention;
  // CANONICAL name for propose_* — the exact stored graph name (with its "[Q…]" tag) so the edge targets
  // the precise node we selected, not a clean-named twin (a wikiquote doc, a lower-degree dup). Web search
  // + the dossier + the voice line all use the clean `mention`; only the writes use `canonical`.
  const canonical = (gap.object && gap.object.canonical) || mention;
  let sources = [];
  if (typeof web === 'function') { try { sources = (await web(mention, 5)) || []; } catch (e) { log && log('[graph-walk] web fill failed: ' + e.message); } }

  // avoid re-proposing edges that already exist
  let neighbors = [];
  if (gap.kind !== 'missing' && gap.object && gap.object.id && typeof kgNeighbors === 'function') {
    try { neighbors = (await kgNeighbors(gap.object.id)) || []; } catch {}
  } else if (gap.object && Array.isArray(gap.object.neighbors)) {
    neighbors = gap.object.neighbors;
  }

  let dossier = null, _rawLen = 0;
  if (typeof cloud === 'function') {
    try {
      const out = await cloud(buildDossierPrompt(mention, sources, { existing: gap.object, neighbors }), { num_predict: 3000, temperature: 0.3 });   // deep KG extraction — room for MANY facts/edges per move (cloud-leverage)
      _rawLen = (out || '').length;
      dossier = parseJsonLoose(out);
    } catch (e) { log && log('[graph-walk] dossier synth failed: ' + e.message); }
  }
  if (!dossier || typeof dossier !== 'object') { log && log(`[grow] "${mention}" sources=${sources.length} dossier=NULL (rawLen=${_rawLen}) → no enrich`); return { built: false, entities: 0, connections: 0, related: [], summary: '', held: 0 }; }

  const nbrKeys = new Set(neighbors.map(visitKey));
  let entities = 0, connections = 0, held = 0, sourceUrl = null; const related = [];
  const _relRaw = Array.isArray(dossier.related) ? dossier.related.length : 0;

  // 1) the anchor object itself — only if MISSING. EXISTENCE gate: mint only if the web pull cites it as
  //    real (≥ C). No citable source → held, never minted (kills the hallucinated-object failure mode).
  if (gap.kind === 'missing') {
    const eg = CG.gateAnchorExistence(sources);
    if (!eg.mint) {
      if (typeof observe === 'function') { try { await observe({ sourceEntity: canonical, relation: 'exists', target: null, url: eg.url, grade: eg.grade, confidence: eg.confidence, status: 'held' }); } catch {} }
      log && log(`[grow] "${mention}" existence uncited (grade ${eg.grade}) → HELD, not minted`);
      return { built: false, entities: 0, connections: 0, related: [], summary: String(dossier.summary || '').trim(), held: 1 };
    }
    if (await proposeEntity({ dispatch, name: canonical, entity_type: dossier.entity_type, summary: dossier.summary })) {
      entities++;
      if (!sourceUrl) sourceUrl = eg.url || null;
      if (typeof observe === 'function') { try { await observe({ sourceEntity: canonical, relation: 'exists', target: null, url: eg.url, grade: eg.grade, confidence: eg.confidence, status: 'promoted' }); } catch {} }
    }
  }

  // 2) related objects + the connecting edges. FACT gate: only a claim the dossier cites to a source
  //    (≥ B) enters Echo; an INFERRED claim (grade D) is HELD — "requires citation", enforced here.
  const rel = Array.isArray(dossier.related) ? dossier.related : [];
  for (const r of rel) {
    if (entities + connections >= (WALK_MAX_NODES + WALK_MAX_CONNECTIONS)) break;
    if (connections >= WALK_MAX_CONNECTIONS) break;
    const rname = String((r && r.name) || '').trim();
    if (!rname || visitKey(rname) === visitKey(mention)) continue;
    if (nbrKeys.has(visitKey(rname))) continue;   // edge already in the graph — skip
    const fg = CG.gateFact(r && r.source, sources);
    if (!fg.promote) {                            // uncited / inferred → does NOT enter the graph
      held++;
      // still record the HELD claim — the enrichment queue (what to chase a real citation for next).
      if (typeof observe === 'function') { try { await observe({ sourceEntity: canonical, relation: (r && r.relation) || 'related_to', target: rname, url: fg.url, grade: fg.grade, confidence: fg.confidence, status: 'held' }); } catch {} }
      continue;
    }
    // propose the related entity (harmless if it already exists — Echo dedups on promotion)
    if (entities < WALK_MAX_NODES && await proposeEntity({ dispatch, name: rname, entity_type: r.type, summary: '' })) entities++;
    if (await proposeRelation({ dispatch, source: canonical, target: rname, relation_type: (r && r.relation) || 'related_to' })) {
      connections++; related.push(rname);
      if (!sourceUrl) sourceUrl = fg.url || null;
      // record the CITATION for the promoted fact (the observation trail; grade + backing url).
      if (typeof observe === 'function') { try { await observe({ sourceEntity: canonical, relation: (r && r.relation) || 'related_to', target: rname, url: fg.url, grade: fg.grade, confidence: fg.confidence, status: 'promoted' }); } catch {} }
    }
  }
  log && log(`[grow] "${mention}" [${gap.kind}] sources=${sources.length} neighbors=${neighbors.length} related=${_relRaw} → +${entities} ent +${connections} conn (${held} held: uncited)`);
  return { built: gap.kind === 'missing' && entities > 0, entities, connections, related, summary: String(dossier.summary || '').trim(), held, sourceUrl };
}

// A compact, human-friendly label for a citation url — for the voiced "via …" tag. Pure.
function sourceLabel(url) {
  const u = String(url || '');
  if (!u) return '';
  if (/wikipedia\.org/i.test(u)) return 'Wikipedia';
  if (/^echo:|echo\.|wikidata\.org/i.test(u)) return /wikidata/i.test(u) ? 'Wikidata' : 'Echo corpus';
  const m = u.match(/^https?:\/\/(?:www\.)?([^/]+)/i);
  return m ? m[1] : '';
}

// WEB-FIRST layered source acquisition for an anchor (replaces bare DDG scraping — throttled + snippet-
// only + no citable artifact). Order: LIVE page (freshest — the entity's Wikipedia article; redirects
// resolve name variants like James→Jim Inhofe) → LOCAL Echo corpus (offline, robust FTS name-match) →
// web search (last resort). Returns normalized CITED sources [{text, url, source}] — every source carries
// a url so the citation gate can grade it. Pure; every fetcher injected → offline-testable.
async function fetchLayeredSources(name, { fetchPage, recallKnowledge, webSearch, wikiUrl, log } = {}) {
  const clean = String(name || '').trim();
  if (!clean) return [];
  // 1) LIVE page first — fresher than the local ZIM snapshot; a real url → archivable to a grade-A source.
  if (typeof fetchPage === 'function' && typeof wikiUrl === 'function') {
    try {
      const url = wikiUrl(clean);
      const p = await fetchPage(url);
      if (p && p.ok && p.text && p.text.length > 200) {
        return [{ text: String(p.text).slice(0, 4000), url: p.url || url, source: 'web:wikipedia', title: p.title || '' }];
      }
    } catch (e) { log && log('[graph-walk] live fetch failed: ' + (e && e.message)); }
  }
  // 2) LOCAL corpus — Echo's Wikipedia/general FTS (no network, resolves name variants by search).
  if (typeof recallKnowledge === 'function') {
    try {
      const kb = (await recallKnowledge(clean, { topK: 5 })) || [];
      const rows = kb.map((h, i) => ({ text: h.content, url: h.url || (h.source ? `${h.source}#${i + 1}` : null), source: h.source || 'echo:kb' })).filter(h => h.text && h.url);
      if (rows.length) return rows;
    } catch (e) { log && log('[graph-walk] corpus recall failed: ' + (e && e.message)); }
  }
  // 3) WEB SEARCH — last resort (snippet-only, throttle-prone).
  if (typeof webSearch === 'function') {
    try { const { results } = await webSearch(clean); return (results || []).map(r => ({ text: r.snippet, url: r.url, source: 'web:search' })).filter(h => h.text && h.url); }
    catch (e) { log && log('[graph-walk] web search failed: ' + (e && e.message)); }
  }
  return [];
}

// One full graph-building MOVE. Orchestrates anchor → grow → record → voice. Returns a result the
// caller uses to (optionally) voice one line and log. Never throws (fail-soft everywhere).
async function runMove(deps = {}) {
  const { recentTurns = [], candidates: injected, cloud, web, recall, dispatch, kgNeighbors, observe, getMeta, setMeta, now = () => Date.now(), log } = deps;
  const nowTs = now();
  try {
    // ANCHOR SOURCE: prefer an injected, already-sourced candidate list (idle_anchors: news → thin
    // frontier → convo). Fall back to conversation-only extraction when none is supplied (legacy path,
    // and the smoke's direct call). Each candidate carries a `source` tag for logging/steering.
    let candList;
    if (Array.isArray(injected) && injected.length) {
      candList = injected.map(c => (typeof c === 'string' ? { mention: c, source: 'convo' } : { mention: c.mention, source: c.source || 'convo', kind: c.kind, object: c.object })).filter(c => c.mention);
    } else {
      candList = (await extractCandidates(recentTurns, { cloud, log })).map(m => ({ mention: m, source: 'convo' }));
    }
    if (!candList.length) return { acted: false, reason: 'no-candidates' };
    const srcByKey = new Map(candList.map(c => [visitKey(c.mention), c.source]));

    // PRE-CLASSIFIED candidates (frontier: selected BY graph degree) trust that gap classification and
    // skip recallObject's rich-sweep, which would resolve a famous same-name twin and flip a genuinely
    // thin node to 'rich'. Only the unclassified tiers (news/convo) go through Echo-first assessment.
    const pre = candList.filter(c => c.kind && c.object).map(c => ({ mention: c.mention, kind: c.kind, object: c.object, source: c.source }));
    const toAssess = candList.filter(c => !(c.kind && c.object)).map(c => c.mention);
    const recalled = (await assessGaps(toAssess, { recall, log })).map(a => ({ ...a, source: srcByKey.get(visitKey(a.mention)) || 'convo' }));
    const assessed = [...pre, ...recalled];
    log && log(`[graph-walk] assessed ${assessed.length}: ${assessed.map(a => `${a.source}:${a.kind}`).join(', ') || '(none)'}`);
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
      grown = await growAround(cand, { web, cloud, dispatch, kgNeighbors, observe, log });
      tried.push(cand.mention);
      if (grown && (grown.built || grown.connections > 0)) break;   // productive → stop
    }
    grown = grown || { built: false, entities: 0, connections: 0, related: [], summary: '', held: 0 };
    recordVisited({ getMeta, setMeta, now: nowTs, names: [...tried, ...grown.related] });

    const notable = grown.built || grown.connections > 0;
    const via = sourceLabel(grown.sourceUrl);   // the citation source that verified the connections
    const _tag = via ? ` (via ${via})` : '';
    const voiceLine = notable
      ? (grown.built
        ? `I didn't have anything on ${anchor.mention} — pulled it together${grown.connections ? ` and linked it to ${grown.related.slice(0, 2).join(' and ')}` : ''}.${_tag}`
        : `Filled in ${anchor.mention} — connected it to ${grown.related.slice(0, 2).join(' and ')}.${_tag}`)
      : '';
    return {
      acted: notable, anchor: anchor.mention, kind: anchor.kind, source: anchor.source,
      // canonical = the EXACT Echo node name (with its "[M000057]"/"[wd:Q…]" tag). The clean `anchor` is
      // for display/voice; consumers that must query the graph (e.g. the KG follow-panel's query_graph)
      // need this exact form — the stripped name won't resolve ("entity not found").
      canonical: (anchor.object && anchor.object.canonical) || anchor.mention,
      built: grown.built, entities: grown.entities, connections: grown.connections,
      related: grown.related, summary: grown.summary, voiceLine, held: grown.held || 0,
      reason: notable ? 'grew' : 'no-growth'
    };
  } catch (e) { log && log('[graph-walk] move failed: ' + (e && e.message)); return { acted: false, reason: 'error', error: e && e.message }; }
}

module.exports = {
  runMove, extractCandidates, assessGaps, growAround, fetchLayeredSources, sourceLabel, proposeEntity, proposeRelation,
  parseJsonLoose, extractProperNouns, classifyObject, rankGaps, visitKey,
  loadVisited, visitedKeySet, recordVisited, buildCandidatePrompt, buildDossierPrompt,
  THIN_DEGREE, THIN_FACTS, WALK_MAX_NODES, WALK_MAX_CONNECTIONS, MAX_CANDIDATES, VISITED_TTL_MS, VISITED_KEY
};
