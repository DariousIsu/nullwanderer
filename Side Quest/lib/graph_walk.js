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
const corroboration = require('./corroboration');     // C2 — independent-source counting
const confModel = require('./confidence_model');      // C3 — calibrated confidence
const { parseValidTime } = require('./doc_decompose'); // C1 — shared valid-time-from-prose parser
const { runDecayPass } = require('./decay_pass');      // C4 — per-predicate confidence decay → re-verify

const DECAY_FLOOR = 0.5;   // an edge whose confidence has decayed below this needs a fresh citation

// --- knobs (the guard) ------------------------------------------------------
const THIN_DEGREE = 8;            // an object below this degree is "thin" → worth filling
const THIN_FACTS = 3;             // …or with fewer than this many facts
const WALK_MAX_NODES = 5;         // nodes touched per move before we re-anchor
const WALK_MAX_CONNECTIONS = 8;   // connections proposed per move before we re-anchor
const MAX_CANDIDATES = 6;         // recent-conversation mentions we consider per move
const WALK_MAX_TRIES = 3;         // anchors we'll ATTEMPT per move before giving up (no-op-move fix)
const VISITED_TTL_MS = 6 * 3600 * 1000;   // don't re-anchor the same object within this window
const SATURATED_TTL_MS = 4 * VISITED_TTL_MS;   // a 0-YIELD (saturated) anchor lingers 4× longer — stop re-grinding nodes whose neighbourhood we already covered (audit: 96.5% of effort on pre-existing/saturated nodes)
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

// Normalize an LLM relation label → an OPEN-VOCABULARY relation type: UPPER_SNAKE_CASE so it's consistent
// with the core types, queryable, and churn-mergeable ("interim provost" → INTERIM_PROVOST). The EXACT
// original phrase is preserved separately on the edge metadata (title) — nothing the LLM produced is lost;
// this is the "let it in, mark, churn" contract (Lucas 2026-07-10) applied to relation types.
function normalizeRelType(label) {
  const s = String(label || '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
  return s || 'RELATED_TO';
}

// visited state (recently-worked anchors), TTL-pruned. getMeta/setMeta injected.
function loadVisited(getMeta, now) {
  let arr = [];
  try { arr = JSON.parse((getMeta && getMeta(VISITED_KEY)) || '[]'); } catch {}
  // per-entry TTL: a saturated entry (3rd slot === 's') lingers SATURATED_TTL_MS,
  // a normal one VISITED_TTL_MS — so a 0-yield node isn't re-ground at the 6h mark.
  return (Array.isArray(arr) ? arr : []).filter(e => {
    if (!Array.isArray(e)) return false;
    const ttl = e[2] === 's' ? SATURATED_TTL_MS : VISITED_TTL_MS;
    return e[1] >= now - ttl;
  });
}
function visitedKeySet(getMeta, now) { return new Set(loadVisited(getMeta, now).map(e => e[0])); }
function recordVisited({ getMeta, setMeta, now, names, saturated = false }) {
  const arr = loadVisited(getMeta, now);
  const have = new Set(arr.map(e => e[0]));
  for (const nm of (names || [])) { const k = visitKey(nm); if (k && !have.has(k)) { arr.push(saturated ? [k, now, 's'] : [k, now]); have.add(k); } }
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
  // Give the model ENOUGH of each source to actually FIND + cite a connection (a 320-char snippet starved
  // citations → most edges came back "inferred" and were held). ~1400 chars/source lets it cite deeper facts.
  const src = (sources || []).slice(0, 6).map((s, i) => `[S${i + 1}] ${String((s && (s.text || s.content || s.snippet)) || s || '').replace(/\s+/g, ' ').slice(0, 1400)}`).join('\n');
  const have = existing ? `\nWHAT THE GRAPH ALREADY HOLDS on "${mention}" (build PAST this, do not repeat): ${String(existing.role || '')} ${(existing.facts || []).slice(0, 4).join('; ')}`.slice(0, 400) : '';
  const nbr = neighbors && neighbors.length ? `\nAlready-linked neighbours (do not re-propose these edges): ${neighbors.slice(0, 10).join(', ')}` : '';
  return [
    // MULTI-CITE (C2 grounding-quality): each connection lists EVERY source that independently states it.
    // A connection carried by two INDEPENDENT sources clears the promotion floor (0.94); a single source
    // (0.88) is proposed but parked for corroboration. So citing all supporting sources is what makes an
    // edge LAND, not just enter the queue — hence "list every [S#] that states it", not just one.
    { role: 'system', content: 'You turn sources into a knowledge-graph object. Ground every claim in the sources; invent nothing. Output ONLY JSON of the shape {"entity_type":"person|organization|place|work|event|concept","summary":"2-4 dense factual sentences","related":[{"name":"Other Entity","type":"person|organization|...","relation":"short_relation_label","sources":["S#", ...],"when":"year or year-range the sources state this connection became/was true, e.g. 2023 or 2015-2019; empty if undated"}]}. `related` = up to 6 OTHER entities this one is genuinely connected to. For EACH related entity, set "sources" to the list of ALL [S#] labels whose text STATES this connection — cite EVERY source that independently supports it, not just one (independent corroboration is what confirms a fact). Set "when" ONLY from an explicit date in the sources — never guess. If a connection is your own INFERENCE beyond what the sources say, set "sources":[] (empty) — be honest: an inferred, uncited connection is HELD OUT, not added to the graph. No prose outside the JSON.' },
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

// Add one entity — additive + auto-disambiguated (→ 'created'/'proposed'/'already_exists'/
// 'already_proposed'/'merge_suggested'/'rejected'). TRUTHFUL accounting: the transport `ok` is ALWAYS true
// on a successful call, so we parse the tool ACTION, not r.ok (the old bug that made +ent a fiction).
// Returns { ok, isNew, action, error }: `ok` = the name is now PRESENT (created/proposed/already_*), a valid
// basis to edge/promote it; `isNew` = a FRESH write we should count. Non-present actions are LOGGED. Fail-soft.
async function proposeEntity({ dispatch, name, entity_type, summary, confidence, log }) {
  if (typeof dispatch !== 'function' || !name) return { ok: false, isNew: false, action: 'skipped' };
  try {
    // T5 — do not mint `concept` for something nobody typed. The graph-walk is the lane that produced
    // 11,732 of them, and `|| 'concept'` was the whole mechanism. Ask the evidence, then be honest.
    const _decided = require('./mint_type').decideType(name, entity_type, { lookup: (n) => require('./object_type').typeOf(n) });
    const args = { name, entity_type: _decided.type };
    if (summary) args.summary = String(summary).slice(0, 1200);
    // Carry the GRADE confidence (curation_gate cap: A=1.0 / B=0.95 / C=0.80 …) so Echo's hybrid
    // promotion gate can auto-promote well-cited (A/B) proposals and queue weaker (C/D) ones for review.
    if (typeof confidence === 'number') args.confidence = confidence;
    const r = await dispatch({ kind: 'do', name: 'propose_entity', args });
    if (!r || !r.ok) return { ok: false, isNew: false, action: 'dispatch_failed' };
    let rep = null; try { rep = JSON.parse(r.text); } catch {}
    const action = (rep && rep.action) || 'unknown';
    const isNew = action === 'created' || action === 'proposed';
    const present = isNew || action === 'already_exists' || action === 'already_proposed';
    if (!present && action !== 'unknown') log && log(`[grow] entity "${name}": ${action}${rep && rep.error ? ' — ' + rep.error : ''}`);
    return { ok: present, isNew, action, error: rep && rep.error };
  } catch { return { ok: false, isNew: false, action: 'threw' }; }
}

// Add one edge — BOTH endpoints must resolve in the PUBLIC corpus (propose_relation_tenant rejects otherwise).
// TRUTHFUL: an edge only WROTE if action==='proposed'; a 'rejected' (endpoint-not-found) wrote NOTHING, so we
// must NOT count it (the old r.ok bug counted every rejection as a connection). LOG the reason so a refused
// edge can be routed (→ short-term) instead of silently dropped. Returns { ok, action, error }. Fail-soft.
async function proposeRelation({ dispatch, source, target, relation_type, confidence, metadata, allowOpen, log }) {
  if (typeof dispatch !== 'function' || !source || !target || source === target) return { ok: false, action: 'skipped' };
  try {
    const args = { source_name: source, target_name: target, relation_type: relation_type || 'related_to' };
    if (typeof confidence === 'number') args.confidence = confidence;   // calibrated → Echo promotion gate
    if (metadata) args.relation_metadata = JSON.stringify(metadata);    // C1 provenance (source_set/valid-time)
    if (allowOpen) args.allow_open_type = true;                         // OPEN-VOCAB: keep the LLM's accurate label as the type
    const r = await dispatch({ kind: 'do', name: 'propose_relation', args });
    if (!r || !r.ok) return { ok: false, action: 'dispatch_failed' };
    let rep = null; try { rep = JSON.parse(r.text); } catch {}
    const action = (rep && rep.action) || 'unknown';
    if (action !== 'proposed') log && log(`[grow] edge "${source}" -[${relation_type || 'related_to'}]→ "${target}": ${action}${rep && rep.error ? ' — ' + rep.error : ''}`);
    return { ok: action === 'proposed', action, error: rep && rep.error };
  } catch { return { ok: false, action: 'threw' }; }
}

// GROW the graph around one anchor gap: fill from web+tools into a dossier, propose the object (if
// missing) + its related objects + the connecting edges — all under the node/connection budget.
// Returns { built, entities, connections, related:[names], summary }.
async function growAround(gap, { web, cloud, dispatch, kgNeighbors, observe, promoteOne, landLocalEdge, log } = {}) {
  const mention = gap.mention;
  // CANONICAL name for propose_* — the exact stored graph name (with its "[Q…]" tag) so the edge targets
  // the precise node we selected, not a clean-named twin (a wikiquote doc, a lower-degree dup). Web search
  // + the dossier + the voice line all use the clean `mention`; only the writes use `canonical`.
  let canonical = (gap.object && gap.object.canonical) || mention;
  // S3b — route [grow]'s endpoint NAMES through the SAME resolution gate before proposing, so a hub/variant
  // ("United States Senate") resolves to its canonical Echo node instead of rejecting → re-minting. Fail-soft +
  // additive: only ever swaps in a precision-safe canonical name; on any miss/error it keeps the original.
  const _gateDeps = (typeof dispatch === 'function') ? require('./resolution_live').makeLiveDeps(dispatch) : null;
  const canonResolve = async (nm) => {
    if (!_gateDeps || !nm) return nm;
    try {
      const _rr = await require('./resolution_gate').preResolve(nm, {}, { deps: _gateDeps, fallback: null });
      return (_rr && _rr.status === 'resolved' && _rr.object && _rr.object.name) ? _rr.object.name : nm;
    } catch { return nm; }
  };
  canonical = await canonResolve(canonical);
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
  let entities = 0, connections = 0, held = 0, rejected = 0, landedLocal = 0, sourceUrl = null; const related = []; const links = [];
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
    const ea = await proposeEntity({ dispatch, name: canonical, entity_type: dossier.entity_type, summary: dossier.summary, confidence: eg.confidence, log });
    if (ea.isNew) {
      entities++;
      if (!sourceUrl) sourceUrl = eg.url || null;
      if (typeof observe === 'function') { try { await observe({ sourceEntity: canonical, relation: 'exists', target: null, url: eg.url, grade: eg.grade, confidence: eg.confidence, status: 'promoted' }); } catch {} }
      // STREAMING (record pipeline): land the new node INLINE the instant it's grounded, so its edges
      // become proposable in THIS same move (propose_relation needs live endpoints) instead of waiting for
      // the batch drain. Armed via promoteOne (present only when the ingest lane is enabled). Fail-soft.
      if (typeof promoteOne === 'function') { try { await promoteOne({ kind: 'entity', name: canonical }); } catch {} }
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
    const rcanon = await canonResolve(rname);   // S3b: canonicalize the related endpoint before proposing (fail-soft → rname)
    if (nbrKeys.has(visitKey(rname))) continue;   // edge already in the graph — skip
    const fg = CG.gateFact(r && (r.sources != null ? r.sources : r.source), sources);   // list-aware (multi-cite) w/ legacy single fallback
    if (!fg.promote) {                            // uncited / inferred → does NOT enter the graph
      held++;
      // still record the HELD claim — the enrichment queue (what to chase a real citation for next).
      if (typeof observe === 'function') { try { await observe({ sourceEntity: canonical, relation: (r && r.relation) || 'related_to', target: rname, url: fg.url, grade: fg.grade, confidence: fg.confidence, status: 'held' }); } catch {} }
      continue;
    }
    // propose the related entity (harmless if it already exists — Echo dedups on promotion)
    if (entities < WALK_MAX_NODES) {
      const re = await proposeEntity({ dispatch, name: rcanon, entity_type: r.type, summary: '', confidence: fg.confidence, log });
      if (re.isNew) {
        entities++;
        // inline-promote the neighbour too, so the edge below has BOTH endpoints live (record pipeline).
        // No-op/skip if it already exists or is below the grounded floor — same gate as the batch drain.
        if (typeof promoteOne === 'function') { try { await promoteOne({ kind: 'entity', name: rname }); } catch {} }
      }
    }
    // C1/C2/C3 provenance + calibrated confidence (mirrors doc_decompose): per-edge
    // source_set + valid-time from prose; confidence from the independent-source count.
    const vt = parseValidTime(r && r.when);
    // OPEN-VOCABULARY relation (Lucas 2026-07-10): keep the LLM's ACCURATE label — that's the point of the
    // LLM being here — as the relation type (UPPER_SNAKE), and preserve the exact phrase in meta.title for the
    // churn passes to verify against. No longer flattened to a core type or rejected by the whitelist.
    const relLabel = String((r && r.relation) || 'related to').trim();
    const relType = normalizeRelType(relLabel);
    // source_set = ALL independently-cited urls (C2): corroboration counts distinct families across them,
    // so a two-independent-source edge calibrates to 0.94 (lands) vs a single source's 0.88 (parked).
    const meta = { source_set: (fg.urls && fg.urls.length) ? fg.urls.slice() : (fg.url ? [fg.url] : []), url: fg.url || null, grade: fg.grade, title: relLabel };
    if (vt.valid_from != null) meta.valid_from = vt.valid_from;
    if (vt.valid_to != null) meta.valid_to = vt.valid_to;
    const corrN = corroboration.corroborationCount(meta.source_set);
    meta.corroboration = corrN;
    const conf = confModel.calibratedConfidence({ grade: fg.grade, corroboration: corrN });
    const rr = await proposeRelation({ dispatch, source: canonical, target: rcanon, relation_type: relType, confidence: conf, metadata: meta, allowOpen: true, log });
    if (rr.ok) {                                    // action==='proposed' — the edge ACTUALLY landed as a proposal
      connections++; related.push(rname); links.push({ name: rname, rel: relLabel });   // relLabel = the LLM's exact phrase → voice variety
      if (!sourceUrl) sourceUrl = fg.url || null;
      // record the CITATION for the promoted fact (the observation trail; grade + backing url).
      if (typeof observe === 'function') { try { await observe({ sourceEntity: canonical, relation: (r && r.relation) || 'related_to', target: rname, url: fg.url, grade: fg.grade, confidence: conf, status: 'promoted', valid_from: vt.valid_from, valid_to: vt.valid_to }); } catch {} }
    } else {
      rejected++;   // truthful: Echo refused (endpoint-not-found etc.) — logged in proposeRelation
      // CROSS-DB (short-term catch, option 2): the edge is CITED (uncited claims already `continue`d out
      // above at the fact gate) — its ONLY problem is a YOUNG ENDPOINT not yet in Echo's public corpus. Don't
      // drop it: land it in the LOCAL short-term graph (lib/graph_memory), which MINTS the missing endpoint as
      // an epistemic-'read' node so the edge survives and takes churn touches. It crosses UP to Echo later
      // (the daily graph stage's promote-up arm) once the endpoint independently grounds. Fail-soft: a bad
      // local write can never break the move.
      if (typeof landLocalEdge === 'function') {
        try {
          const lr = await landLocalEdge({
            source: canonical, target: rname, type: relType, epistemic: 'read', confidence: conf,
            proposedBy: 'graph-walk-shortterm',   // provenance: THIS lane (the young-endpoint catch) so its yield is separately countable/auditable
            sourceObj: { kind: 'reading', ref: fg.url || null, excerpt: String(dossier.summary || '').slice(0, 160) },
            validFrom: vt.valid_from
          });
          if (lr && lr.ok) landedLocal++;   // NOT pushed to `related`: a short-term landing stays OUT of the voiced + visited set (weakest rung — silent, never named as a "flagged" link)
        } catch { /* fail-soft */ }
      }
    }
  }
  log && log(`[grow] "${mention}" [${gap.kind}] sources=${sources.length} neighbors=${neighbors.length} related=${_relRaw} → +${entities} ent +${connections} conn (${held} held: uncited${rejected ? `, ${rejected} rejected${landedLocal ? ` → ${landedLocal} landed short-term` : ''} (see edge logs)` : ''})`);
  return { built: gap.kind === 'missing' && entities > 0, entities, connections, related, links, summary: String(dossier.summary || '').trim(), held, rejected, landedLocal, sourceUrl };
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
async function fetchLayeredSources(name, { fetchPage, recallKnowledge, webSearch, wikiUrl, log, maxSources = 3 } = {}) {
  const clean = String(name || '').trim();
  if (!clean) return [];
  const out = [];
  const seenFam = new Set();   // independence keys already held (corroboration.sourceFamily) — dedupe mirrors
  // add a source ONLY if it's from a NEW independent family (so we don't stack Wikipedia mirrors as if they
  // were independent confirmations — the anti-echo-chamber rule that corroboration enforces downstream).
  const take = (row) => {
    if (!row || !row.url || !row.text || out.length >= maxSources) return;
    const fam = corroboration.sourceFamily(row.url);
    if (fam && seenFam.has(fam)) return;
    if (fam) seenFam.add(fam);
    out.push(row);
  };
  // 1) PRIMARY: live Wikipedia page — richest text, redirect-resolves name variants (James→Jim Inhofe).
  if (typeof fetchPage === 'function' && typeof wikiUrl === 'function') {
    try {
      const url = wikiUrl(clean);
      const p = await fetchPage(url);
      if (p && p.ok && p.text && p.text.length > 200) take({ text: String(p.text).slice(0, 4000), url: p.url || url, source: 'web:wikipedia', title: p.title || '' });
    } catch (e) { log && log('[graph-walk] live fetch failed: ' + (e && e.message)); }
  }
  // 2) INDEPENDENT corroborators: web search, keeping only DIFFERENT-family results. A connection cited to
  //    two independent families calibrates to 0.94 (clears the promotion floor) vs a lone source's 0.88
  //    (parked for later corroboration). One Wikipedia page can't corroborate itself — this is the C2
  //    grounding-quality lift that lets a walk-built edge actually LAND, not just queue. Bounded + fail-soft.
  if (typeof webSearch === 'function' && out.length < maxSources) {
    try {
      const { results } = await webSearch(clean);
      for (const r of (results || [])) { if (out.length >= maxSources) break; if (r && r.url && r.snippet) take({ text: r.snippet, url: r.url, source: 'web:search' }); }
    } catch (e) { log && log('[graph-walk] web search failed: ' + (e && e.message)); }
  }
  // 3) LOCAL corpus — only if we STILL have nothing (offline / everything dry). Echo's Wikipedia FTS is the
  //    same family as (1), so it's a text fallback, not an independent corroborator.
  if (!out.length && typeof recallKnowledge === 'function') {
    try {
      const kb = (await recallKnowledge(clean, { topK: 5 })) || [];
      kb.forEach((h, i) => take({ text: h.content, url: h.url || (h.source ? `${h.source}#${i + 1}` : null), source: h.source || 'echo:kb' }));
    } catch (e) { log && log('[graph-walk] corpus recall failed: ' + (e && e.message)); }
  }
  return out;
}

// One full graph-building MOVE. Orchestrates anchor → grow → record → voice. Returns a result the
// DECAY-CHECK the anchor's existing edges (C4). The walk is ALREADY visiting this node's neighbourhood,
// so checking its edges for staleness here is FREE coverage — the walk does BOTH: grows the graph AND
// flags facts whose confidence has decayed below the floor (a role/office edge halves in ~1.5yr). Each
// stale edge lands a 'reverify' observation in Zoe's short-term buffer (the re-verify work-list). A fact
// with a PREDETERMINED TERMINATION (valid_to already passed) is NOT gradual decay — that's the nightly
// termination pass's job — so it's skipped here. Returns the count flagged. Fail-soft, never throws.
async function decayVisitedEdges(objId, { kgEdges, observe, now, floor = DECAY_FLOOR, anchorName = null } = {}) {
  if (typeof kgEdges !== 'function' || !objId) return 0;
  let edges = [];
  try { edges = (await kgEdges(objId)) || []; } catch { return 0; }
  const nowSec = Math.floor((Number(now) || 0) / 1000);
  const facts = [];
  for (const e of (Array.isArray(edges) ? edges : [])) {
    const vt = e && e.validTo != null ? Number(e.validTo) : null;   // world-time end
    if (vt != null && isFinite(vt) && vt > 0 && vt < nowSec) continue;   // already terminated → nightly's job, not decay
    facts.push({ predicate: e.relation, confidence: e.confidence, lastVerifiedMs: e.createdAt != null ? Number(e.createdAt) * 1000 : null, target_name: e.name });
  }
  const { reverify } = runDecayPass(facts, { now, floor });
  for (const f of reverify) {
    if (typeof observe === 'function') {
      try { await observe({ sourceEntity: anchorName || '', relation: f.predicate, target: f.target_name, confidence: f.decayed, status: 'reverify' }); } catch { /* fail-soft */ }
    }
  }
  return reverify.length;
}

// caller uses to (optionally) voice one line and log. Never throws (fail-soft everywhere).
async function runMove(deps = {}) {
  const { recentTurns = [], candidates: injected, cloud, web, recall, dispatch, kgNeighbors, kgEdges, observe, promoteOne, getMeta, setMeta, now = () => Date.now(), log } = deps;
  // LOCAL short-term edge landing (option 2): defaults to graph_memory.recordRelation (mints young endpoints
  // locally). Injectable so the offline smoke can observe it. Lazy-require avoids a load-order cycle.
  const landLocalEdge = deps.landLocalEdge || ((a) => require('./graph_memory').recordRelation(a));
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
      grown = await growAround(cand, { web, cloud, dispatch, kgNeighbors, observe, promoteOne, landLocalEdge, log });
      tried.push(cand.mention);
      if (grown && (grown.built || grown.connections > 0 || (grown.landedLocal || 0) > 0)) break;   // productive → stop
    }
    grown = grown || { built: false, entities: 0, connections: 0, related: [], summary: '', held: 0, landedLocal: 0 };
    // A local short-term landing IS productive growth (the edge exists + will churn / cross up later), so an
    // anchor that only produced short-term edges is not wastefully marked saturated. It stays VOICE-silent
    // though (weakest rung — a young-endpoint buffer write, not a claim worth announcing).
    const notable = grown.built || grown.connections > 0 || (grown.landedLocal || 0) > 0;
    // Diminishing-returns steer: the productive anchor + the new neighbours get the
    // normal window; every anchor we TRIED that yielded nothing is "saturated" and
    // lingers 4× longer so the walk stops re-grinding covered nodes each 6h.
    const satTried = tried.filter(m => !(notable && m === anchor.mention));
    recordVisited({ getMeta, setMeta, now: nowTs, names: notable ? [anchor.mention, ...grown.related] : [] });
    recordVisited({ getMeta, setMeta, now: nowTs, names: satTried, saturated: true });
    // DECAY (C4): we just touched this node — decay-check its existing edges for free (build + decay = both).
    // Stale ones → 'reverify' observations in the short-term buffer. Only the acted anchor with a real id.
    let reverified = 0;
    if (typeof kgEdges === 'function' && anchor.object && anchor.object.id) {
      try { reverified = await decayVisitedEdges(anchor.object.id, { kgEdges, observe, now: nowTs, anchorName: (anchor.object && anchor.object.canonical) || anchor.mention }); } catch { /* fail-soft */ }
    }
    const via = sourceLabel(grown.sourceUrl);   // the citation source she read while proposing
    const _tag = via ? ` (via ${via})` : '';
    // VOICE — a MOVE writes PROPOSALS, not live edges: an accepted propose_* only QUEUES in
    // tenant_rainey.*_proposals (pending Echo's promotion gate) and may never land in civic_graph. So the
    // thought must report what she ACTUALLY did — began a record / proposed a link still to confirm — and
    // must NOT assert a completed graph write ("linked it to X"), which confabulates an edge the live graph
    // doesn't hold (the "L. Overby → Oregonian/Forbes: 0 edges" finding). Honest, tentative register.
    // Name each link WITH the LLM's relation phrase (variety: "secretary of the interior → Barack Obama"),
    // not a flat "link to X". Echo-PROPOSED links only (short-term catches excluded above → no voice leak).
    const _rp = (s) => String(s || 'related to').replace(/_/g, ' ').slice(0, 42);
    const _links = (grown.links || []).slice(0, 2);
    const _rel = _links.length
      ? _links.map((l) => `${_rp(l.rel)} → ${l.name}`).join('; ')
      : grown.related.slice(0, 2).join(' and ');
    // Register matches the MEASURED landing rate of each channel (2026-07-10): object proposals DO promote
    // (~20-min ingest batches) → "queued for promotion"; her LINK proposals pool in tenant_rainey and rarely
    // land → "flagged" (a weaker claim, honest until the landing lane is fixed). Never assert a live edge.
    // VOICE ONLY SUBSTANTIVE MOVES: a new record, or a real Echo link. A move whose only product is a
    // short-term catch (or a thin touch that reached Echo with nothing) stays SILENT — no filler. (Retired
    // "Spent a little time on X": low-signal, it dominated her monologue and read as all she could think.)
    const voiceLine = grown.built
      ? `Started a record for ${anchor.mention} — queued for promotion${_links.length ? `; first links: ${_rel}` : ''}.${_tag}`
      : (grown.connections
        ? `Flagged for ${anchor.mention}: ${_rel} — for review.${_tag}`
        : '');
    return {
      acted: notable, anchor: anchor.mention, kind: anchor.kind, source: anchor.source,
      // canonical = the EXACT Echo node name (with its "[M000057]"/"[wd:Q…]" tag). The clean `anchor` is
      // for display/voice; consumers that must query the graph (e.g. the KG follow-panel's query_graph)
      // need this exact form — the stripped name won't resolve ("entity not found").
      canonical: (anchor.object && anchor.object.canonical) || anchor.mention,
      built: grown.built, entities: grown.entities, connections: grown.connections,
      related: grown.related, links: grown.links || [], summary: grown.summary, voiceLine, held: grown.held || 0,
      landedLocal: grown.landedLocal || 0,
      reverify: reverified,
      reason: notable ? 'grew' : 'no-growth'
    };
  } catch (e) { log && log('[graph-walk] move failed: ' + (e && e.message)); return { acted: false, reason: 'error', error: e && e.message }; }
}

module.exports = {
  runMove, decayVisitedEdges, extractCandidates, assessGaps, growAround, fetchLayeredSources, sourceLabel, proposeEntity, proposeRelation,
  parseJsonLoose, extractProperNouns, classifyObject, rankGaps, visitKey, normalizeRelType,
  loadVisited, visitedKeySet, recordVisited, buildCandidatePrompt, buildDossierPrompt,
  THIN_DEGREE, THIN_FACTS, WALK_MAX_NODES, WALK_MAX_CONNECTIONS, MAX_CANDIDATES, VISITED_TTL_MS, SATURATED_TTL_MS, VISITED_KEY
};
