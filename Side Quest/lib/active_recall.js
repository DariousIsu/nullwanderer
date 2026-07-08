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

async function recall(topic, { k = 6, minRelevance = 0.33, context = '', retrieveFn = null, graphFn = null, echoFn = null, objectFn = null, prominenceFn = null, docFn = null, newsFn = null, resolveFn = null, object = true } = {}) {
  const t = String(topic || '').trim();
  if (!t) return { topic: t, notes: [], facts: [], object: null, coverage: 'thin', echo: 0, mention: null, identityNote: null, precedenceFact: null, streamHits: [], ambiguous: null };
  const retrieve = retrieveFn || ((q) => memory.retrieveScored(q, { k, minRelevance }));
  let local = []; try { local = (await retrieve(t)) || []; } catch { local = []; }
  let facts = []; try { facts = (graphFn ? graphFn(t) : _graphFacts(t)) || []; } catch { facts = []; }
  // ECHO-SEARCH-FIRST: resolve the target to its canonical Echo OBJECT and pull the whole thing in
  // ONE cheap call (facts + bio + committees + degree) — the mandatory first move that #2915 skipped.
  // Only for entity-shaped targets (a name/short phrase, not a paragraph) so we don't quick_lookup prose.
  // ECHO-SEARCH-FIRST also works on a PHRASE: when the topic isn't a bare name (the idle loop hands us
  // "Senator John Curtis personal background"), EXTRACT the entity and pull ITS object — so a web-first
  // idle search on someone we already hold as a rich object is caught and short-circuited.
  let obj = null, mentionUsed = null, identityNote = null, ambiguous = null;
  if (object) {
    // MENTION → OBJECT via the tiered chain (lib/mention): local NER (fast) → cloud decompose
    // (casing/pronoun/KG-type) → robust regex fallback. Replaces the capitalized-run regex that mis-read
    // "Who is Donald Trump?" as the entity "Who" (→ a lobby firm), starving the pull. objectFn (tests)
    // stays on the deterministic regex path so the offline gate needs no model/cloud.
    let det = null;
    if (!objectFn) { try { det = await require('./mention').detectMention(t, { context }); } catch {} }
    const entTopic = (det && det.mention) || extractEntity(t) || (_looksLikeEntity(t) ? t : null);
    const preferType = (det && det.kgType) || null;
    mentionUsed = entTopic;
    if (entTopic) {
      if (objectFn) { try { obj = await objectFn(entTopic) || null; } catch { obj = null; } }
      else {
        // DISAMBIGUATING resolve — route the pull through resolveMention so 2+ genuinely-DIFFERENT same-name
        // entities we hold in Echo (distinct QIDs) surface as an ASK instead of a silent wrong pick (the
        // instance-blind bug). A single/thin/nil resolve falls back to the direct object pull — unchanged
        // behavior for a lone thin hold (a degree-1 contact). Fail-soft.
        try {
          const resolve = resolveFn || ((m, o) => require('./echo_suit').resolveMention(m, o));
          const rm = await resolve(entTopic, { preferType, context: null });
          if (rm && rm.status === 'ambiguous' && Array.isArray(rm.candidates) && rm.candidates.length >= 2) ambiguous = { mention: entTopic, candidates: rm.candidates.slice(0, 4), candidateObjs: (rm.candidateObjs || []).slice(0, 4) };
          else if (rm && rm.status === 'resolved' && rm.object) obj = rm.object;
          else obj = await _echoObject(entTopic, preferType) || null;
        } catch { try { obj = await _echoObject(entTopic, preferType) || null; } catch { obj = null; } }
      }
    }
    // RELEVANCE GATE — reject a junk FTS resolve (a FL bill for "Cuban Missile Crisis", "Hispanic Heritage
    // Foundation" for "Heritage Foundation", "AH DEFENSE LLC" for "Secretary of Defense") so we never ground
    // on — or half-trust — the wrong object. Junk → null → the cloud/wiki answers cleanly. Live path only;
    // objectFn (offline tests) keeps its deterministic object.
    if (obj && !objectFn) { try { if (!require('./echo_suit')._relevanceGate(entTopic, obj)) obj = null; } catch {} }
    // PROMINENCE GATE (R1) — the KG ranks people by degree (= bill-cosponsorship volume), so a bare famous
    // name resolves to a high-degree, QID-less STATE legislator while the real referent (e.g. JFK the
    // President, absent from this civic graph) is who's meant. If a far-more-prominent same-name human exists
    // on Wikidata, DECLINE the civic namesake (obj→null → the enrich/wiki ladder answers about the prominent
    // one) and surface an IDENTITY note so the answer footnotes the record we do hold. Live path only (external
    // Wikidata probe); offline tests inject prominenceFn. Fail-soft — any miss keeps the resolved object.
    if (obj && (prominenceFn || !objectFn)) {
      try {
        const pc = prominenceFn ? await prominenceFn(entTopic, obj) : await require('./echo_suit').prominenceCheck(entTopic, obj);
        if (pc && pc.status === 'mismatch') { identityNote = pc.note || null; obj = null; }
      } catch {}
    }
  }
  // ECHO MASTER DB: query the system-of-record corpus (search_knowledge) — the real "she already
  // knows it" pool. Reference-not-copy: snippets surface into recall, never copied into sq.db.
  let echoHits = []; try { echoHits = (echoFn ? await echoFn(t) : await _echoSearch(t)) || []; } catch { echoHits = []; }
  const notes = local.concat(echoHits);
  // DATA-STREAM RECALL — factor in the OTHER short-term stores she'd otherwise be blind to: landed DOCUMENTS
  // (meeting notes / research dossiers / API + email + canvas) and tracked NEWS. Both are topic-searched +
  // capped, and returned SEPARATELY so a rich KG object can't hide them (main.js/knowledgeBlock surface them
  // independently). Live defaults gated to !retrieveFn (the offline-test signal — every recall smoke injects
  // retrieveFn) so the gate is unaffected; docFn/newsFn injectable for tests. Fail-soft — a store miss never breaks recall.
  let streamHits = [];
  try {
    const docs = docFn ? (await docFn(t)) : (retrieveFn ? [] : _docRecall(t));   // retrieveFn injected = offline test → skip live stores
    const news = newsFn ? (await newsFn(t)) : (retrieveFn ? [] : _newsRecall(t));
    streamHits = _docNotes(docs).concat(Array.isArray(news) ? news : []);
  } catch {}
  const rich = _objectRich(obj) || notes.length >= RICH_NOTES || local.some(n => n.source === 'verified_fact') || facts.length >= 3 || echoHits.length >= 2;
  // PRECEDENCE — a fresh, deliberate verified_fact about this object leads over its (stale) KG dossier.
  let precedenceFact = null;
  if (obj) { try { precedenceFact = _precedenceFact(obj, notes, mentionUsed); } catch {} }
  return { topic: t, notes, facts, object: obj, coverage: rich ? 'rich' : 'thin', echo: echoHits.length, mention: mentionUsed, identityNote, precedenceFact, streamHits, ambiguous };
}
// Entity-shaped = a name/short phrase we can hand to quick_lookup (single-name → dossier), not a
// full sentence. Keeps the object pull cheap + on-target.
function _looksLikeEntity(t) { const toks = String(t).trim().split(/\s+/); return toks.length >= 1 && toks.length <= 6; }
// Pull the entity out of a longer phrase: the longest run of Capitalized words (a proper noun), leading
// honorifics dropped ("Senator John Curtis personal background" → "John Curtis"; "Fifth Element soundtrack
// chart" → "Fifth Element"). null when no proper noun (so a generic musing doesn't trigger an object pull).
// tier-3 fallback (both NER + cloud unavailable): a HARDENED capitalized-run extractor. Interrogatives
// and question verbs are treated as run-BREAKERS (never part of an entity), and surrounding punctuation is
// stripped per word — so "Who is Donald Trump?" yields "Donald Trump", not "Who" (the original bug). Cased
// only by nature; lowercase names are the NER/cloud tiers' job.
const _ENT_TITLES = new Set([
  'senator', 'sen', 'rep', 'representative', 'dr', 'mr', 'mrs', 'ms', 'gov', 'governor', 'president', 'pres', 'the', 'a', 'an',
  'who', 'what', 'which', 'when', 'where', 'why', 'how', 'whose', 'whom',   // interrogatives
  'is', 'are', 'was', 'were', 'do', 'does', 'did', 'tell', 'me', 'about', 'of',  // question glue
]);
function extractEntity(text) {
  // strip surrounding punctuation per token so a sentence-final entity ("Trump?") isn't split off
  const words = String(text || '').split(/\s+/)
    .map(w => w.replace(/^[^A-Za-z0-9]+/, '').replace(/[^A-Za-z0-9.'’\-]+$/, ''))
    .filter(Boolean);
  let best = [], cur = [];
  for (const w of words) {
    const key = w.toLowerCase().replace(/[.?!,]+$/, '');
    if (!_ENT_TITLES.has(key) && /^[A-Z][A-Za-z'’.\-]*$/.test(w)) cur.push(w);   // stoplist words break the run
    else { if (cur.length > best.length) best = cur; cur = []; }
  }
  if (cur.length > best.length) best = cur;
  const name = best.join(' ').replace(/[.,]+$/, '').trim();
  return name.replace(/\s+/g, '').length >= 3 ? name : null;
}
function _echoSearch(topic) { try { return require('./echo_suit').recallKnowledge(topic); } catch { return Promise.resolve([]); } }
function _echoObject(topic, preferType = null) { try { return require('./echo_suit').recallObject(topic, preferType ? { preferType } : {}); } catch { return Promise.resolve(null); } }
// DATA-STREAM stores (the lanes chat/research were blind to). Keyword recall over landed DOCUMENTS and a
// topic query over tracked NEWS stories. Fail-soft → []. Live-only (require the app's DBs); tests inject.
function _docRecall(topic) { try { return require('./doc_store').recall(topic, 4) || []; } catch { return []; } }
function _newsRecall(topic) { try { const nl = require('./news_lane'); return nl.storiesAsNotes(nl.storiesForTopic(topic, { k: 4 }), { max: 4 }); } catch { return []; } }
// doc candidates (doc_store shape {title, markdown, source}) → knowledge-shaped notes, artifact-tagged so
// grounding shows their provenance ("[doc:meeting_notes] ..."). Pure.
function _docNotes(cands) {
  return (Array.isArray(cands) ? cands : []).slice(0, 4).map(d => ({
    content: `${d.title ? d.title + ': ' : ''}${String(d.markdown || '').replace(/\s+/g, ' ').slice(0, 240)}`.trim(),
    source: `doc:${d.source || 'document'}`,
  })).filter(n => n.content);
}

// ── PRECEDENCE GATE (reconciliation §5 — the Pam Bondi fix) ─────────────────────────────────────────────
// A FRESH, deliberately-banked verified_fact about the resolved object's subject must LEAD the grounding
// over the object's (possibly stale) KG dossier. Without this a RICH Echo object dominates: main.js drops
// the notes when the object is rich, so the cited correction ("Bondi served as AG until 2026-04-02") never
// reaches the grounding and recall serves the stale record ("Bondi is the AG"). reconcile.precedence makes
// the call; authority is derived from HOW the fact was banked (a deliberate correction — she excavated it or
// Lucas told her — is authoritative), so no capture-code change. Only VOLATILE facts (roles/offices — the
// class that turns over) can supersede a dossier detail. Returns the winning fact note, or null. Pure.
// Authority from HOW the fact was banked. DELIBERATE recovery — the enrich loop went and looked it up
// (capturedBy = the tier that found it: wiki / wiki-verify / web / excavate / routed / graph), or a chat
// correction, or the canonical identity seed — is authoritative (3). Only PASSIVE realtime capture (banked
// from text she happened to read) is de-rated (2); unknown provenance is conservatively 2. Derived at
// grounding time so capture code stays untouched. (Audit fix: the prior regex whitelist matched 'excavat'/
// 'web' but MISSED the wiki tier — the commonest recovery path — capping deliberate wiki corrections at 2 so
// volatile ones never cleared the bar. Whitelisting-deliberate was fragile; de-rate the one passive source.)
const _PC_PASSIVE_CAPTURE = /^realtime$/i;
function _factAuthority(prov) {
  const by = String((prov && prov.capturedBy) || '').trim();
  if (!by || _PC_PASSIVE_CAPTURE.test(by)) return 2;
  return 3;
}
function _coreKeyOf(s) { try { return require('./echo_suit')._coreNameKey(s); } catch { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim(); } }
// Subset containment on the name tokens — "Pam Bondi" ⊆ the object's core key, but "Jane Smith" ⊄ "John Smith"
// (a shared surname alone must NOT match). Pure.
function _subjectMatches(a, b) {
  const A = String(a || '').split(' ').filter(Boolean), B = String(b || '').split(' ').filter(Boolean);
  if (!A.length || !B.length) return false;
  const [short, longSet] = A.length <= B.length ? [A, new Set(B)] : [B, new Set(A)];
  return short.every(t => longSet.has(t));
}
// The belief-REVISION domain: a role/office/status fact — the kind that goes stale in a dossier and that a
// correction overturns. This is the precedence trigger, NOT the fact's own ttl_class: "Bondi served as AG
// until 2026-04-02" reads as a CLOSED (permanent-classified) historical statement, yet it revises the
// object's CURRENT-role claim ("is the AG"). Gating on role/office language captures that while excluding
// minor events ("voted yes on HR123") that should never override the whole dossier. Reuses office terms.
const _ROLE_RE = /\b(president|vice[\s-]?president|potus|secretary|attorney general|administrator|director|governor|senator|representative|congress(?:man|woman|person)|minister|chancellor|premier|mayor|chair(?:man|woman|person)?|c[eo]o|cto|ambassador|speaker|justice|commissioner|chief|leader|office|title|role|serves?\s+as|served\s+as|appointed|resign(?:ed|s|ation)?|stepp?ed\s+down|removed|ousted|confirmed\s+as|sworn\s+in|took\s+office|left\s+office|no\s+longer|until\s+\d)\b/i;
function _precedenceFact(obj, notes, mention, deps = {}) {
  const R = deps.reconcile || (() => { try { return require('./reconcile'); } catch { return null; } })();
  if (!R || !obj) return null;
  const objKey = _coreKeyOf(obj.name) || _coreKeyOf(mention);
  if (!objKey) return null;
  let best = null;
  for (const n of (notes || [])) {
    if (!n || n.source !== 'verified_fact') continue;
    let prov = {}; try { prov = n.provenance ? (typeof n.provenance === 'string' ? JSON.parse(n.provenance) : n.provenance) : {}; } catch {}
    const subjKey = _coreKeyOf(prov.subject || prov.subject_key || '');
    if (!subjKey || !_subjectMatches(objKey, subjKey)) continue;      // the fact must be ABOUT this object
    const value = String(n.content || '');
    if (!_ROLE_RE.test(value)) continue;                             // belief-revision domain only (role/office/status)
    const fact = { value, as_of: prov.as_of || null, ttl_class: R.classifyTtl(value), tier: 'single-source', authority: _factAuthority(prov), status: 'open' };
    if (R.precedence(fact, obj) !== 'short-term-wins') continue;
    if (!best || String(prov.as_of || '') > String(best.asOf || '')) best = { content: value, asOf: prov.as_of || null, subject: prov.subject || subjKey };
  }
  return best;
}

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
  if (src && (src.startsWith('echo:') || src.startsWith('doc:'))) return src;   // [echo:wikipedia] / [doc:meeting_notes]
  if (src === 'news') return 'news';   // the tracked news lane
  return src === 'learning' ? 'learned' : src === 'interest_summary' ? 'summary' : src === 'trajectory' ? 'did' : 'note';
}

// The prior-knowledge block for a research/focus tick — now active: a rich hit tells her to build
// PAST what she holds, not re-derive it. (learning.buildPriorKnowledgeBlock delegates here.)
async function knowledgeBlock(topic, opts = {}) {
  const r = await recall(topic, opts);
  if (!r.notes.length && !r.facts.length && !_hasObject(r.object) && !(r.streamHits && r.streamHits.length)) return null;
  const lines = [`WHAT YOU ALREADY KNOW about "${r.topic.replace(/\s+/g, ' ').slice(0, 80)}" (from your own memory — you may already hold this without realizing):`];
  // PRECEDENCE — a fresh verified fact leads over the record and supersedes any stale role/office detail in it.
  if (r.precedenceFact) lines.push(`  [MOST CURRENT — verified${r.precedenceFact.asOf ? ` as of ${r.precedenceFact.asOf}` : ''}; supersedes older role/office details in the record below] ${r.precedenceFact.content}`);
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
  // DATA STREAMS — landed documents (meetings / dossiers / API / email) + tracked news on this topic.
  for (const sh of (r.streamHits || [])) { const s = (sh.content || '').replace(/\s+/g, ' ').slice(0, 200); if (s) lines.push(`  [${_tag(sh.source)}] ${s}`); }
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

module.exports = { recall, knowledgeBlock, formatConsolidation, coverage, _graphFacts, _relStr, _objectLines, _objectRich, _looksLikeEntity, extractEntity, RICH_NOTES };
