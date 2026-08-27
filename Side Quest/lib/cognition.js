/**
 * lib/cognition.js — the ENRICH / RECOVERY reflex (turn→object-graph Phase 2 + the tool-executor half
 * of Phase 4). The missing half of the half-migrated brain: when the strip (332207b) demoted the local
 * model to a voice renderer, it removed the model's ability to recognize "I don't have this, let me go
 * find it." This restores that as a CLOUD cognition loop, so the local model still just voices.
 *
 * The loop (CRAG "answer-or-enrich", never dead-end, never confabulate):
 *   1. ASSESS+DRAFT in one cloud call — answer the question from the grounding we already pulled, OR
 *      emit `NEED: <the specific thing to look up>` when the grounding genuinely lacks it.
 *   2. ENRICH on a NEED — go find it: OUR knowledge graph first (search_entities + the object's
 *      neighborhood), then the live web (web_search). This is the "let me find out" that was missing.
 *   3. RE-DRAFT from grounding + what we just found.
 *   4. If it still can't be found → an HONEST "I looked and couldn't pin down X" — not a bare
 *      "records don't specify" dead-end, and never an invented answer.
 *
 * The cloud DECIDES (assess → what to look up) and DRAFTS; the code EXECUTES the read tools. The result
 * is the [say this] the front model voices. Fully fail-safe: cloud/Echo down → null → caller falls back
 * to the normal local flow. cloud + dispatch injectable (deps) for offline smoke tests.
 */
'use strict';
const cloud = require('./cloud_logic');
const echo = require('./echo_suit');
const ad = require('./answer_draft');

const NEED_RE = /^\s*NEED:\s*(.+)$/is;
// A NEED must name a SUBJECT we could go and look up. These name the ASKING instead — "the user's
// question", "a clear request", "what he wants", "clarification" — which is what a model emits when
// the message was never a question in the first place. Also catches the literal `NEED: NONE` the
// prompt now asks for. Anchored on the WHOLE need so a real lookup that merely contains one of these
// words ("the question on the Louisiana ballot") is untouched.
const DEGENERATE_NEED_RE = new RegExp(
  '^(none|n/?a|nothing|null)$'
  + '|^(the|a|an|his|her|their|lucas\'?s?|the user\'?s?|any)?\\s*(specific|clear|actual|exact|underlying|intended)?\\s*'
  + '(question|request|ask|query|intent|topic|subject|meaning|point|clarification|context)(\\s+or\\s+\\w+)?$'
  + '|^what\\s+(he|she|they|lucas|the user)\\s+(is\\s+asking|wants?|means?|needs?)',
  'i');
// Whether a turn asks for something that TURNS OVER (office holder, current fact) — and the clean topic to
// look it up by — is decided by lib/intent_parse (a fast model reads the phrasing; regex is only its
// fallback). answerGrounded consumes that structured intent instead of matching phrase patterns here, which
// is what kept breaking ("who's" vs "who is", "now" vs "the"). See intent_parse.js.

// GUARD for the heavy, visible EXCAVATION tier — a rendered page can only settle a FACT lookup. Fire freely
// for entity/encyclopedic needs (the research fuel Lucas wants), but skip subjective/advice/personal needs
// that no web page decides (else we'd pop her browser to "look up" an opinion). Deterministic. Pure.
const _NOT_EXCAVATABLE = /\b(best|worst|should i|worth it|recommend|opinion|favou?rite|pros and cons|better than|how do i feel|what should i|do you think|your (?:opinion|advice|take)|is it worth|good idea)\b/i;
function _worthExcavating(need) {
  const n = String(need || '').trim();
  if (n.length < 5) return false;
  if (_NOT_EXCAVATABLE.test(n)) return false;                                  // subjective/advice → a page won't settle it
  if (/[A-Z][a-z]/.test(n)) return true;                                       // names a proper-noun entity
  return /\b(who|what|when|where|which|whom|how many|number of|current|latest|list of|capital of|ceo of|head of|founder|population|born|died|located)\b/i.test(n);
}

// One cloud pass: draft the grounded answer, or emit NEED:<thing>. Timeless general knowledge may be
// answered from the model's own knowledge (we don't search "what is photosynthesis"); NEED is for
// OUR-records / current / live facts the grounding lacks. Returns {answer} | {need} | null.
async function _draftOrNeed(userMessage, grounding, deps = {}) {
  const askFn = deps.ask || cloud.ask;
  const want = 'You are drafting the SUBSTANCE of an answer (not a voice). Answer the question in 1-3 plain '
    + 'sentences using the GROUNDING below; well-established timeless general knowledge is also fine to use. '
    + 'No first-person, no preamble, no invented specifics (names/dates/lists) beyond the grounding or solid '
    + 'general knowledge. If the grounding contains RELEVANT material — even partial — synthesize the best '
    + 'accurate answer from it and briefly note any uncertainty (e.g. "among them" / "based on our records"). '
    + 'Output EXACTLY one line `NEED: <the single most specific thing to look up>` ONLY when the grounding is '
    + 'essentially empty or clearly about something else, so you genuinely cannot answer accurately. '
    // NOT EVERY MESSAGE IS A QUESTION. Live 2026-07-21: Lucas described his day ("coffee, the Rainey
    // all-hands at 1045, then publications, then Electrify America at 1630") and this pass emitted
    // `NEED: the user's question or request` — so the ladder ran five tiers against the ABSENCE of a
    // question and closed with "I checked our records and searched, but I couldn't pin down the user's
    // question or request." A NEED must name a SUBJECT to look up, never the asking itself.
    + 'If the message is not a question at all — a greeting, a remark, news about his day, thinking out '
    + 'loud — there is nothing to look up. Output exactly `NEED: NONE`. Never emit a NEED that names the '
    + 'question, the request, or the user\'s intent: those are not things to look up. '
    // DATE-ANCHOR. Retrieved text carries no timestamp, so an encyclopedia lead describing the LAST
    // occurrence of a recurring event reads as current. Live 2026-07-20: "When are elections this
    // year in the US?" pulled the Wikipedia elections article and answered "November 5, 2024" — the
    // tier worked, the text was simply never checked against what today is.
    + 'TODAY is given below. A relative question ("this year", "now", "current", "upcoming") is about '
    + 'TODAY, not about whatever the retrieved text happens to describe. If the grounding covers a '
    + 'DIFFERENT period than the question asks about — a past occurrence of a recurring event, a '
    + 'former office-holder — do NOT answer from it: emit a NEED for the current one instead.';
  // EASTERN day, not UTC — this is the "TODAY" the model reasons with; toISOString had her believing
  // it was tomorrow for the four hours after 8pm Eastern.
  const today = (deps.today || require('./tz').dayKey());
  let out = null;
  try {
    out = await askFn({
      // v2 — the prompt changed, and cloud_logic.ask caches on {task,v,input,want}; without the bump
      // the old verdict would be re-served from cache without ever reaching the model.
      task: 'answer_or_need', v: 2,
      input: { today, question: String(userMessage).slice(0, 800), grounding: String(grounding || '').slice(0, 4200) },
      want,
      validate: (raw) => { const t = String(raw || '').replace(/^```[a-z]*\s*|\s*```$/gi, '').trim(); return t.length > 3 ? { valid: true, value: t } : { valid: false, error: 'empty' }; },
      deps: { complete: deps.complete || ad._draftComplete, skipBudget: true }
    });
  } catch (e) { return null; }
  if (typeof out !== 'string' || !out.trim()) return null;
  const t = out.trim();
  const m = t.match(NEED_RE);
  if (m) {
    const need = m[1].trim().replace(/\s+/g, ' ').slice(0, 160);
    // BELT AND BRACES — the prompt above asks for `NEED: NONE` on a non-question, but a prompt rule is
    // not a guarantee and this particular failure is expensive: five retrieval tiers, then a refusal
    // sentence aimed at a question that was never asked. A need that names the ASKING rather than a
    // SUBJECT is definitionally unlookupable, so treat it exactly like no need at all.
    if (DEGENERATE_NEED_RE.test(need)) {
      console.log(`[cognition] degenerate NEED "${need}" → nothing to look up (not a question)`);
      return null;
    }
    return { need };
  }
  return { answer: t };
}

function _json(s) { try { return JSON.parse(s); } catch { return null; } }
// ERROR-VS-EMPTY (the starvation audit's last structural item, 08-26): every tier swallowed its
// throws into an empty result, so the closer claimed "I checked our records and searched" after the
// lookup itself DIED (Echo down, network dead, embedder hung). Each guarded call now notes its
// lane's failure; the closer claims only what ran CLEAN, and an all-failed ladder says so.
function _laneErr(deps, lane, e) { try { (deps._laneErrors = deps._laneErrors || []).push({ lane, msg: (e && e.message) || String(e || 'error') }); } catch {} }
function _rows(s) { const j = _json(s); const r = j && (j.result || j.rows || j); return Array.isArray(r) ? r : []; }
function _entLine(e) {
  if (!e || !e.name) return '';
  const sub = e.entity_subtype ? `/${e.entity_subtype}` : '';
  const sum = String(e.summary || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  return `• ${e.name} (${e.entity_type || '?'}${sub})${sum ? ' — ' + sum : ''}`;
}
// ENRICH tier 1 — OUR knowledge graph: search_entities(need) + WALK the neighborhoods of the object AND
// the top relevant hits (e.g. the "second cabinet of Donald J. Trump" entity → its appointees). The
// graph hop that turns "related records" into the actual answer. Returns text (or ''). Fail-safe.
async function _enrichGraph(need, object, deps = {}) {
  const d = deps.dispatch || echo.liveDispatch();
  if (!d || !need) return '';
  const parts = [];
  let hits = [];
  try {
    const r = await d({ kind: 'do', name: 'search_entities', args: { query: need, top_k: 6 } });
    if (r && r.ok) hits = _rows(r.text);
  } catch (e) { _laneErr(deps, 'graph', e); }
  for (const e of hits.slice(0, 6)) { const l = _entLine(e); if (l) parts.push(l); }
  const seen = new Set();
  const toWalk = [];
  const neighborNames = [];
  if (object && object.id) toWalk.push({ id: object.id, name: object.name });
  if (object && Array.isArray(object.neighbors)) for (const n of object.neighbors) neighborNames.push(n);
  for (const e of hits.slice(0, 2)) if (e && e.id) toWalk.push({ id: e.id, name: e.name });
  const _cleanEnt = (s) => String(s || '').replace(/\s*\[(?:wd:)?[^\]]*\]/gi, '').replace(/\s+/g, ' ').trim();
  for (const w of toWalk) {
    if (!w.id || seen.has(w.id)) continue; seen.add(w.id);
    try {
      // TRAVERSE THE REAL GRAPH (relations table) — kg_neighborhood returns EMPTY here. Pull the connected
      // objects AND, for a person, their CURRENT offices (HELD_OFFICE, tenure_end=null) — which IS "their
      // title" straight from the graph (Rubio → "Secretary of State"). This is the spreading-activation.
      const rel = await echo.relatedEntities(w.id, { dispatch: d, limit: 20 });
      const roles = rel.filter(r => r.relation === 'HELD_OFFICE' && r.current).map(r => _cleanEnt(r.name)).filter(Boolean);
      if (roles.length) parts.push(`${_cleanEnt(w.name) || 'It'} currently holds: ${roles.slice(0, 4).join('; ')}`);
      const named = [];
      for (const r of rel) { const nm = _cleanEnt(r.name); if (nm) { neighborNames.push(nm); named.push(nm); } }
      if (named.length) parts.push(`Connected to ${_cleanEnt(w.name) || 'it'}: ${[...new Set(named)].slice(0, 12).join(', ')}`);
    } catch (e) { _laneErr(deps, 'graph', e); }
  }
  // FOLLOW THE EDGES to the connected OBJECTS — resolve each connected entity to ITS OWN object and read
  // its title/role (which lives in the neighbor's facts: Rubio → "Secretary of State", NOT in Trump's).
  // This is the graph traversal that makes a conversation flow: "his cabinet" comes back WITH titles and
  // "their titles" resolves straight from our records instead of the flaky web tier. Deduped + capped.
  const uniq = [...new Set(neighborNames.map(n => String(n || '').trim()).filter(Boolean))].slice(0, 8);
  try {
    const titled = await echo.expandNeighbors(uniq, { dispatch: d, top: 8 });
    if (titled.length) parts.push('Connected people and their roles (from our records):\n' + titled.map(e => `  • ${e.name} — ${e.title}`).join('\n'));
  } catch (e) { _laneErr(deps, 'graph', e); }
  return { text: parts.join('\n').trim(), url: null };   // OUR KG — already local, nothing to write back
}

// ENRICH tier — WIKIPEDIA (echo_suit.wikiLookup → mediawiki_search + get_extract). The reliable, keyless
// encyclopedic recovery: this is what actually answers the who/what/current-X class the loop was DYING on
// ("current EPA administrator" → "Lee Zeldin, 17th administrator since Jan 2025"). It exists because the
// audit found DDG dead (0 results) and Echo web_search keyless — the loop's prior tiers reached nothing
// while a working tool held the answer. Returns text (or ''). Fail-safe.
// ENRICH tier — OUR OWN CONVERSATION. The ladder had no way to search what we have actually said to
// each other: every tier was civic or external. Live 2026-07-20, asked what she'd said about having a
// body, she ran graph→wiki→routed→web→excavate — the knowledge graph, Wikipedia and the open web —
// and answered "I couldn't pin down previous statements by the AI regarding its physical appearance",
// while her own June turn described exactly that. The answer was never anywhere those tiers look.
//
// Cheapest tier by far: a local embedding and a cosine sweep, no network, no cloud. It leads the
// default ladder for that reason — and because a thing WE said is more relevant to us than anything
// Wikipedia holds. Deliberately NOT first on a needs_fresh/office-holder question: a three-week-old
// remark must never outrank a current-fact lookup (that is the stale-Biden failure in a new costume).
async function _enrichConvo(need, deps = {}) {
  const retrieve = deps.retrieveTurns || ((q, o) => { try { return require('./memory').retrieveTurns(q, o); } catch { return Promise.resolve([]); } });
  let hits = [];
  // scan deep — the whole point is reaching past the recency window the default 400 covers.
  // BOUNDED (08-22): the un-bounded await hung forever when the embedder pool had no drain timer
  // (offline/smoke context) and SILENTLY TRUNCATED the suite at exit 0 — and in the live app a hung
  // embedder stalled the whole ladder. 6s then the tier honestly yields nothing.
  try {
    hits = (await new Promise((resolve) => {
      const t = setTimeout(() => { _laneErr(deps, 'convo', 'timeout — embedder hung'); resolve([]); }, deps.convoTimeoutMs || 6000);
      Promise.resolve(retrieve(need, { k: 4, minSim: 0.42, scan: 4000 }))
        .then((r) => { clearTimeout(t); resolve(r || []); })
        .catch((e) => { clearTimeout(t); _laneErr(deps, 'convo', e); resolve([]); });
    })) || [];
  } catch (e) { _laneErr(deps, 'convo', e); }
  if (!hits.length) return { text: '', url: null };
  const lines = hits.map((h) => {
    const who = h.speaker === 'user' ? 'Lucas said' : 'You said';
    return `• ${who}: ${String(h.content || '').replace(/\s+/g, ' ').slice(0, 400)}`;
  });
  return { text: 'From our own past conversation (this is what was actually said):\n' + lines.join('\n'), url: null };
}

// ENRICH tier — HER OWN NEWS STREAM (the 189-feed lane: hourly-compressed, corroborated, local).
// Live boots 47/48: three turns of "what's the latest on the war?" promised and missed while
// "Iran war live: US launches new attacks" sat CURRENT in data/news_bucket.db — the ladder had
// graph/wiki/convo/web/excavate and never once read her own freshest source. A needs_fresh
// question checks the stream FIRST now: zero network, already corroborated, updated hourly.
// FORECAST TIER (F2, PLAN_MAP §3b — Lucas: "the probability models in the forecasting workspace").
// An election odds / who-wins / seat-count / chamber-control question must be answered from HER OWN
// balance-of-power model, never a web guess or a stale training memory. Reads the last completed run
// (deps.forecast() → the lastForecast snapshot); a total no-op when no run exists or the question
// isn't forecast-shaped, so the normal ladder is untouched. Pairs with the forecast_query operator
// tool (Slice F) — this is the FRONT's version, so a casual chat question reaches the model too.
// Trigger cues are OUTCOME/PROBABILITY language only — NOT bare "majority"/"control"/"hold", which
// name OFFICES ("senate majority leader") and would false-positive. A cue + a chamber/election noun
// within 60 chars, either order.
const _FC_CUE = 'who\\s+(?:wins?|will win|takes?)|win\\s+prob\\w*|\\bodds\\b|likelihood|chances?|forecast|projec\\w*|seat\\s+count|balance\\s+of\\s+power|\\bflip\\w*|take\\s+control|control\\s+of';
const _FC_NOUN = 'senate|house|congress|chamber|midterm|2026\\s+election|the\\s+election|\\bseats?\\b';
const _FORECAST_RE = new RegExp(`\\b(?:${_FC_CUE})\\b[\\s\\S]{0,60}\\b(?:${_FC_NOUN})\\b|\\b(?:${_FC_NOUN})\\b[\\s\\S]{0,60}\\b(?:${_FC_CUE})\\b`, 'i');
function isForecastQuestion(text) { return _FORECAST_RE.test(String(text || '')); }
async function _enrichForecast(need, deps = {}) {
  try {
    const snap = deps.forecast ? deps.forecast() : null;
    if (!snap || !snap.ok) return { text: '', url: null };
    const chambers = ((snap.work || {}).sim || {}).chambers || {};
    if (!Object.keys(chambers).length) return { text: '', url: null };
    const lines = [`Her own 2026 balance-of-power model (Monte-Carlo, as of ${snap.as_of || 'this run'}${snap.illustrative ? ', ILLUSTRATIVE — no polled margins yet' : ''}). Party A is Dem-coded, B Rep-coded:`];
    for (const [ch, c] of Object.entries(chambers)) {
      lines.push(`- ${ch}: P(A control) ${(100 * (c.pA_control || 0)).toFixed(1)}%; A seats ${Number(c.seatsA_mean || 0).toFixed(0)} (80% band ${c.seatsA_p10}–${c.seatsA_p90}) of ${c.total_seats}; ${c.n_races} races simulated.`);
    }
    return { text: lines.join('\n'), url: null, source: 'forecast' };
  } catch (e) { _laneErr(deps, 'forecast', e); return { text: '', url: null }; }
}

async function _enrichNews(need, deps = {}) {
  try {
    const stories = (deps.newsStories ? deps.newsStories() : require('./news_lane').allStories()) || [];
    const qt = new Set(String(need || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length >= 3));
    if (!qt.size || !stories.length) return { text: '', url: null };
    const scored = [];
    for (const s of stories) {
      const st = String((s.title || '') + ' ' + (s.summary || '')).toLowerCase();
      let hit = 0; for (const t of qt) if (st.includes(t)) hit++;
      if (hit >= 1) scored.push({ s, hit });
    }
    if (!scored.length) return { text: '', url: null };
    scored.sort((a, b) => (b.hit - a.hit) || ((b.s.last_ts || 0) - (a.s.last_ts || 0)));
    const day = (ts) => { try { return require('./tz').dayKey(ts); } catch { return ''; } };
    // THE LATEST lives in the UPDATE rows, not the story header (sweep 2026-07-23: 55k updates and
    // the first cut of this tier never read them — "what's the latest" answered from the headline).
    const updatesFor = deps.newsUpdates || ((id) => { try { return require('./news_lane').storyDeltas(id, { limit: 50 }); } catch { return []; } });
    const top = scored.slice(0, 3).map(({ s }) => {
      const head = `• ${s.title}${s.summary ? ' — ' + String(s.summary).slice(0, 280) : ''}${s.last_ts ? ` (as of ${day(s.last_ts)})` : ''}`;
      const ups = (updatesFor(s.id) || []).slice(-2).map((u) =>
        `\n  ↳ latest: ${u.title || u.summary || ''}${u.ts ? ` (${day(u.ts)})` : ''}`).join('');
      return head + ups;
    });
    return { text: 'From my own news stream (fresh, corroborated):\n' + top.join('\n'), url: null };
  } catch (e) { _laneErr(deps, 'news', e); return { text: '', url: null }; }
}

// WIKI IS A LINKING STEP, NOT A GENERAL ANSWER SOURCE (Lucas, 2026-07-20):
//   "The wiki search should only be for a newly minted object or an object that has no wiki link."
//
// An object carrying a `wikidata_qid` has already been linked to its global identity — Echo's own
// code treats that as "the KG record is trustworthy" — so re-fetching the article adds no linkage and
// re-answers from an encyclopedia something we already hold. Firing wiki only at UNLINKED or
// newly-encountered objects is what makes the lookup an enrichment that PAYS: each hit either mints
// an object or attaches an identity that stops the next lookup going out at all.
//
// No object at all → this is newly encountered → fetch. That is the mint case.
async function _enrichWiki(need, deps = {}, { object = null } = {}) {
  if (object && object.wikidata_qid) {
    console.log(`[cognition] wiki skipped — "${String(object.name || need).slice(0, 50)}" is already linked (${object.wikidata_qid})`);
    return { text: '', url: null, skipped: 'already-linked' };
  }
  const wiki = deps.wikiLookup || ((q) => { try { return require('./echo_suit').wikiLookup(q); } catch { return Promise.resolve([]); } });
  // SALIENCE (2026-07-23 — the Pasig Cathedral miss): "parish leadership" searched BARE resolved to
  // a Philippine cathedral while the conversation had JUST established Ouachita Parish, Louisiana.
  // A two-sense term is disambiguated by the talk it came from: when the caller supplies recent
  // conversation anchors (deps.contextTerms, most-salient first) and none is already part of the
  // need, search WITH the first one; an empty result falls back to the bare need — never worse
  // than before. Wiki-only for now (the observed miss); the other tiers carry their own context.
  const _ctx = (Array.isArray(deps.contextTerms) ? deps.contextTerms : []).map((t) => String(t || '').trim()).filter((t) => t.length >= 3);
  const _needLc = String(need || '').toLowerCase();
  const _anchor = _ctx.find((t) => !_needLc.includes(t.toLowerCase()) && t.toLowerCase() !== _needLc);
  let pages = [];
  if (_anchor) { try { pages = (await wiki(`${need} ${_anchor}`)) || []; } catch (e) { _laneErr(deps, 'wiki', e); } }
  if (!pages.length) { try { pages = (await wiki(need)) || []; } catch (e) { _laneErr(deps, 'wiki', e); } }
  if (!pages.length) return { text: '', url: null };
  const url = pages[0] && pages[0].title ? 'https://en.wikipedia.org/wiki/' + encodeURIComponent(String(pages[0].title).replace(/ /g, '_')) : null;
  return { text: 'From Wikipedia:\n' + pages.map(p => `• ${p.title}: ${p.extract}`).join('\n'), url };
}

// ENRICH tier FINAL — FORENSIC EXCAVATION (lib/excavate): drive HER visible browser to the best source and
// READ THE RENDERED PAGE WITH VISION (screenshot → vision → scroll). The last resort for what the text
// tiers physically can't reach — the office-holder incumbent in a Wikipedia infobox, JS-rendered widgets,
// image-only facts. Heavy + visible on purpose (Lucas supervises); fires only after everything cheaper
// missed. Returns text (or ''). Fail-safe.
async function _enrichExcavate(need, deps = {}) {
  if (!_worthExcavating(need)) return { text: '', url: null };   // don't pop her browser for a need no page can settle
  const fn = deps.excavate || ((n) => { try { return require('./excavate').excavate(n, { deps }); } catch { return Promise.resolve(null); } });
  let r = null;
  try { r = await fn(need); } catch (e) { _laneErr(deps, 'excavate', e); }
  if (r && r.found && r.answer) return { text: `Read directly off the rendered page (${r.url || 'web'}): ${r.answer}`, url: r.url || null };
  return { text: '', url: null };
}

// ENRICH tier 2 — the live web, via the app's OWN DuckDuckGo search (lib/web_search; Echo's web_search
// has no provider keys). The "let me find out" for anything not in our records. Returns text (or '').
async function _enrichWeb(need, deps = {}) {
  const searchFn = deps.webSearch || ((q) => { try { return require('./web_search').search(q); } catch { return Promise.resolve(null); } });
  const fetchFn = deps.fetchPage || ((u) => { try { return require('./web_search').fetchPage(u, { maxChars: 3000, reuse: true }); } catch { return Promise.resolve(null); } });
  let results = [];
  try { const r = await searchFn(need); results = (r && r.results) || (Array.isArray(r) ? r : []); } catch (e) { _laneErr(deps, 'web', e); }
  if (!results.length) return { text: '', url: null };
  const parts = [];
  // FETCH the top TWO result pages — DDG snippets are often just the title, and the #1 hit can be messy
  // (Wikipedia serves raw infobox wikitext); a cleaner source (Ballotpedia etc.) at #2 carries the answer.
  const urls = results.filter(x => x && x.url).slice(0, 2);
  for (const u of urls) {
    try { const p = await fetchFn(u.url); if (p && p.ok && p.text && (p.chars != null ? p.chars : p.text.length) > 120) parts.push(`From ${p.title || u.url}:\n${require('./content_firewall').truncateFramed(p.text, 2400)}`); } catch (e) { _laneErr(deps, 'web', e); }
  }
  const snip = results.slice(0, 5).map(x => {
    const t = String((x && x.title) || '').replace(/\s+/g, ' ').trim();
    const s = String((x && x.snippet) || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    return '• ' + [t, s].filter(Boolean).join(' — ');
  }).filter(l => l.length > 3);
  if (snip.length) parts.push(snip.join('\n'));
  const url = (results.find(x => x && x.url) || {}).url || null;
  return { text: parts.join('\n\n').trim(), url };
}

// ENRICH tier 1.5 — the cloud TOOL EXECUTOR: let the cloud pick + run the right recipe / db_query / tool
// for the need (counts, lists, structured records our neighborhood-walk doesn't surface — the LAMP-count
// class). This is what the interface used to fumble with a local <echo-find>; now the cloud does it.
async function _enrichRouted(need, deps = {}) {
  const route = deps.routeNeed || ((q) => { try { return require('./echo_suit').routeNeed(q); } catch { return Promise.resolve(null); } });
  try {
    const r = await route(need);
    // ONLY genuine SUCCESS data — never feed an error / no-fit / validation message as "grounding". Doing so
    // made the model confabulate from stale training ("current SecDef" → "Lloyd Austin") AND short-circuit
    // the escalation before excavation. r.ok && !isError is the success gate; ARG/no-fit results fall through.
    if (r && r.ok && !r.isError) {
      const t = String(r.text || '').replace(/\s+/g, ' ').trim();
      if (t.length > 40 && !/^(no|nothing|I looked|could(n't| not)|error)\b/i.test(t)) {
        return { text: `Looked up in our records (${r.chose || 'tool'}): ${t.slice(0, 2400)}`, url: null };   // Echo tool — our data
      }
    }
  } catch (e) { _laneErr(deps, 'routed', e); }
  return { text: '', url: null };
}

// SELF-HEAL write-back — bank an externally-recovered answer (wiki / web / excavation / wiki-verify) onto
// the verified_fact rail so browsing FEEDS our DB (gold for research/database-building) and she's never on
// the same page twice. Non-blocking (kick, don't await): answer now, bank in the background. Only fires for
// tiers with a real source URL (graph/routed are our own data → nothing to bank). Fail-safe.
function _kickWriteBack({ query, answer, url, source, text = null, deps = {} }) {
  if (!url || !answer || !query) return;
  // INSTANCE GUARD on the bank (08-22, the poison loop's second head): p102's wrong-instance answer
  // (Colorado SB25-200 for an SB200 question) WROTE ITSELF BACK as knowledge, so the next ask found
  // it in "our own records". An answer whose bill tokens don't include the question's never banks.
  if (_instanceMismatch(query, `${answer} ${text || ''}`)) { console.log('[cognition] write-back SKIPPED — bill-instance mismatch (a wrong-instance answer must never become a record)'); return; }
  const wb = deps.writeBack || ((a) => { try { return require('./learning').captureRecovered(a); } catch { return Promise.resolve(); } });
  // content = the text that was actually read — captureRecovered's grounding gate checks the answer's
  // anchors against it, so a fused answer with invented specifics never banks under the page's URL.
  Promise.resolve().then(() => wb({ query, answer, url, source: source || 'browsing', content: text })).catch(() => {});
  // …and MINT THE OBJECTS. captureRecovered banks a flat verified_fact keyed by subject slot; this is
  // the object half, in the same encounter vocabulary every other input lane uses. It is also what
  // makes the wiki gate pay: a fetch that happens leaves the link behind, so the next question about
  // that object is answered from what we hold instead of going back out.
  const rec = deps.recordRecovery || ((a) => { try { return require('./recovery_encounters').fromRecovery(a); } catch { return Promise.resolve(0); } });
  Promise.resolve().then(() => rec({ text: text || answer, url, source: source || 'browsing' })).catch(() => {});
}

// STALENESS — active_recall tags banked facts "[VERIFIED as of YYYY-MM-DD]". A banked answer would be
// served from our DB forever (confidently stale after a role turns over). Parse those dates and, if a
// VOLATILE fact (current office/role) is past its freshness window, re-verify before trusting it. Uses the
// pure lib/staleness classifier. `now` injected for stable tests.
const _VERIFIED_TAG_RE = /\[VERIFIED as of (\d{4}-\d{2}-\d{2})[^\]]*\]\s*([^\n]+)/gi;
function _hasStaleGrounding(grounding, now) {
  let st; try { st = require('./staleness'); } catch { return false; }
  const s = String(grounding || '');
  _VERIFIED_TAG_RE.lastIndex = 0;
  let m;
  while ((m = _VERIFIED_TAG_RE.exec(s)) !== null) {
    if (st.isStale({ content: m[2], provenance: { as_of: m[1] } }, now)) return true;
  }
  return false;
}

// BILL-INSTANCE GUARD (campaign, 08-22 — the live SB25-200-for-SB200 swap): a bill number in the
// QUESTION is an identifier. A web search for "SB200 co-sponsor" surfaced Colorado's SB25-200 and
// the re-draft answered from it — the operator's own grounded line (LA SB200, Hodges) lost to a
// wrong-instance fragment, and the wrong answer got CACHED. Retrieval that carries bill tokens of
// which NONE normalizes to the question's must not become the draft's grounding. Text with no
// bill token at all PASSES (context is not a mismatch); errors fail open.
const _BILL_TOK_RE = /\b((?:[A-Za-z]\.?){1,4})[\s-]?(\d{1,5})\b/g;
const _BILL_PREFIXES = /^(?:s|h|sb|hb|ssb|hsb|sjr|hjr|scr|hcr|sr|hr|ab|lb|sf|hf)$/i;
function _billToksOf(text) {
  const out = new Set(); let m;
  const t = String(text || ''); _BILL_TOK_RE.lastIndex = 0;
  while ((m = _BILL_TOK_RE.exec(t)) !== null) {
    const letters = m[1].replace(/\./g, '');   // "S.B." → "SB"
    if (_BILL_PREFIXES.test(letters)) out.add(`${letters.toLowerCase()}${m[2]}`);
  }
  return out;
}
function _instanceMismatch(question, text) {
  try {
    const qb = _billToksOf(question);
    if (!qb.size) return false;
    const tb = _billToksOf(text);
    if (!tb.size) return false;
    return ![...qb].some((b) => tb.has(b));
  } catch { return false; }
}

// The turn's grounded answer with the enrich/recovery reflex. Returns:
//   { say, enriched, enrichSource, missed?, need? }  — the substance for the voice block, or
//   null  → cloud unavailable → caller uses the normal local flow.
async function answerGrounded({ userMessage, grounding = '', object = null, userName = 'Lucas', scope = null, deps = {} } = {}) {
  if (!userMessage) return null;
  if (!deps._laneErrors) deps._laneErrors = [];   // error-vs-empty: the tiers note lane failures here
  let g = String(grounding || '').trim();
  // INTENT PARSE (model-primary, regex fallback) runs CONCURRENTLY with the first draft — a fast cloud model
  // reads what the turn is actually asking (kind / clean topic / does-it-turn-over) so routing no longer
  // hinges on brittle phrase regexes ("who's" vs "who is", "now" vs "the"). Parallel with the draft it always
  // makes → ~zero added latency. Fail-safe: parseIntent never throws and degrades to the regex fallback.
  const _ip = () => { try { return require('./intent_parse'); } catch { return null; } };
  // deps.ask threads into parseIntent (2026-08-22): with an INJECTED ask (tests) the parse uses it and
  // resolves deterministically — the un-threaded call reached the real cloud pool from inside smokes,
  // whose drain timer never runs there, so the await never resolved and the suite SILENTLY TRUNCATED
  // at this line (exit 0 after 2 cases — the silent-green trap). Production passes no deps.ask → the
  // behavior there is exactly as before.
  const [step0, it0] = await Promise.all([
    _draftOrNeed(userMessage, g, deps),
    deps.intent ? Promise.resolve(deps.intent) : (async () => { const ip = _ip(); return ip ? ip.parseIntent(userMessage, { ask: deps.ask || null, deps }) : null; })()
  ]);
  let step = step0;
  if (!step) return null;                                    // cloud down → local flow
  const it = it0 || (_ip() ? _ip()._regexIntent(String(userMessage)) : { kind: 'other', topic: '', needs_fresh: false });
  // CURRENCY VERIFY — the grounding produced a plausible answer, but the question asks for a CURRENT fact
  // and our records may be stale. Check a fresh source (Wikipedia) and re-draft before trusting it. Only
  // fires on currency-marked questions, so normal turns pay nothing. ("what does Lee Zeldin do now?" →
  // records say "Representative" → verify → "EPA Administrator since 2025".)
  if (step.answer && (it.needs_fresh || _hasStaleGrounding(g, deps.now || Date.now()))) {
    // The model's clean topic ("President of the United States") is a far better fresh-lookup key than the raw
    // question ("who is president now?") or a junk-resolved object name — fall back to those only if it's empty.
    const topic = String(it.topic || (object && object.name) || userMessage).replace(/\[[^\]]*\]/g, '').replace(/\([^)]*\)/g, '').trim();
    // Fresh check escalates: Wikipedia lead/body first, then — for the current-office facts wiki can't
    // read off the page — EXCAVATION (her eyes on the infobox). Whichever confirms a fresh value writes
    // back (supersedes the stale one) and wins.
    for (const tier of ['news', 'wiki', 'excavate']) {
      let fresh = { text: '', url: null };
      // NOTE: `object` is deliberately NOT passed here. This is the CURRENCY-VERIFY path — "who is
      // president now?" — where wiki is checking whether a fact TURNED OVER, not linking an object.
      // The already-linked skip belongs to the enrichment ladder below; applying it here would mean a
      // linked object could never be re-verified, which is precisely the confidently-stale answer
      // (Echo still records Biden as president) this path exists to catch.
      try { fresh = (tier === 'news' ? await _enrichNews(topic, deps) : tier === 'wiki' ? await _enrichWiki(topic, deps) : await _enrichExcavate(topic, deps)) || fresh; } catch (e) { _laneErr(deps, tier, e); }
      if (!fresh.text) continue;
      if (_instanceMismatch(userMessage, fresh.text)) { console.log(`[cognition] ${tier} fresh-check DROPPED — bill-instance mismatch`); continue; }
      const gv = [`Fresh check for the current fact (${topic}):\n${fresh.text}`, g].filter(Boolean).join('\n\n');   // fresh check LEADS so the draft cap keeps the verified value, not the stale grounding it's meant to override
      const v = await _draftOrNeed(userMessage, gv, deps);
      if (v && v.answer) {
        const src = tier === 'news' ? 'news-verify' : tier === 'wiki' ? 'wiki-verify' : 'excavate-verify';
        _kickWriteBack({ query: userMessage, answer: v.answer, url: fresh.url, source: src, text: fresh.text, deps });
        return { say: v.answer, enriched: true, enrichSource: src };
      }
    }
    // Couldn't verify against a fresh source. If the "answer" was a PURE MODEL GUESS (no grounding backed it)
    // for a CURRENT fact, DO NOT serve it — an unverifiable current fact from stale training is the exact
    // confabulation this guard exists to kill: the live "who is the president?" returned stale "Joe Biden"
    // whenever the fresh check momentarily reached nothing (e.g. Echo not ready seconds after a reboot).
    // Convert to a NEED and fall through to the FULL ladder (graph/routed/web add tiers the wiki+excavate
    // verify lacked, and give a transient Echo miss a second chance); honest-miss if everything fails. A
    // grounded answer (g non-empty) is from our real records → best-effort serve is acceptable.
    if (!g) step = { need: topic };
    else return { say: step.answer, enriched: false, enrichSource: null };
  }
  if (step.answer) return { say: step.answer, enriched: false, enrichSource: null };
  if (!step.need) return null;
  const need0 = step.need;
  // ENRICH escalation: OUR graph → Wikipedia (reliable, keyless — the who/what/current-X recovery) →
  // the cloud tool-executor (specialized Echo tools: counts/lists) → last-ditch DDG. Re-draft after each;
  // stop as soon as the grounding can actually answer. This is "let me find out" — never a dead-end, never
  // invented. Wiki sits before routed/web because the audit proved those two reach nothing on simple facts.
  // Tier order by the PARSED intent kind. An OFFICE-HOLDER question ("who's the president/SecDef/CEO?") is
  // answered ONLY from FRESH external sources — our own KG (graph/routed) is precisely the stale source here
  // (Echo records Biden as president, Austin as SecDef), and it sits before the forensic tiers, so it would
  // intercept with a confidently-stale name. Exclude it. A general CURRENT fact (counts, "latest bill") keeps
  // our data but leads with wiki. Everything else leads with the graph (multi-hop/relational).
  // 'convo' (our own past turns) leads the default ladder: cheapest tier, no network, and the most
  // relevant source for anything WE said. It stays OUT of the office-holder ladder and comes late on
  // a fresh-fact question — an old remark of ours must never outrank a current-fact lookup.
  let _modes = it.kind === 'office_holder' ? ['wiki', 'web', 'excavate']
    : it.needs_fresh ? ['news', 'wiki', 'graph', 'routed', 'convo', 'web', 'excavate']
    : ['convo', 'graph', 'wiki', 'routed', 'web', 'excavate'];
  // FORECAST LEADS on an election-odds question (F2): her own model outranks every external tier —
  // it IS the answer, not a source to corroborate. No-ops through if no run exists (empty grounding).
  if (isForecastQuestion(userMessage)) _modes = ['forecast', ..._modes.filter((m) => m !== 'forecast')];
  const _tried = [];   // what we ACTUALLY reached — the miss line must not overstate it
  for (const mode of _modes) {
    if (!step || !step.need) break;
    _tried.push(mode);
    // Search key: for a fresh question the model's normalized topic ("President of the United States") is a
    // far cleaner lookup than the draft's raw NEED ("who runs the country" → the wiki "Country" article). Use
    // it.topic when the intent flagged fresh + gave one; otherwise the draft's need (entity Qs, no topic).
    const q = (it.needs_fresh && it.topic) ? it.topic : step.need;
    const res = mode === 'forecast' ? await _enrichForecast(q, deps)
              : mode === 'news' ? await _enrichNews(q, deps)
              : mode === 'convo' ? await _enrichConvo(q, deps)
              : mode === 'graph' ? await _enrichGraph(q, object, deps)
              : mode === 'wiki' ? await _enrichWiki(q, deps, { object })
              : mode === 'routed' ? await _enrichRouted(q, deps)
              : mode === 'web' ? await _enrichWeb(q, deps)
              : await _enrichExcavate(q, deps);
    if (!res || !res.text) continue;
    if (_instanceMismatch(userMessage, res.text)) { console.log(`[cognition] ${mode} retrieval DROPPED — bill-instance mismatch (the question's bill number is absent from the retrieved text; a different bill must never ground the answer)`); continue; }
    // LEAD with the freshest retrieval. It was fetched specifically for THIS need, so it is the highest-value
    // grounding; the earlier tiers already FAILED to answer, so they are the least valuable and should be the
    // part that trails off past _draftOrNeed's char cap. Proven bug (probe_truncation): grounding was already
    // pinned at the 4200-char cap by a full wiki body + two web pages BEFORE excavate ran, so excavate's
    // vision-read "Pete Hegseth" — appended LAST — fell entirely past the cap and the cloud never saw it.
    g = [`Just retrieved for this (${mode}):\n${res.text}`, g].filter(Boolean).join('\n\n');
    step = await _draftOrNeed(userMessage, g, deps);
    if (step && step.answer) {
      // SELF-HEAL — any tier that recovered from an external SOURCE (wiki/web/excavation) feeds the answer
      // back to the DB so browsing builds our knowledge and she's never on the same page twice.
      _kickWriteBack({ query: userMessage, answer: step.answer, url: res.url, source: mode, text: res.text, deps });
      return { say: step.answer, enriched: true, enrichSource: mode };
    }
  }
  // Couldn't confirm it anywhere. Honest, never a bare dead-end, never a confabulation — and the
  // claim about WHAT WAS CHECKED must itself be true. The old line asserted "I checked our records
  // and searched" unconditionally, which is the single sentence this codebase keeps getting wrong:
  // a false verification claim CLOSES the question, because Lucas has no reason to ask again. Live
  // 2026-07-20 it surfaced on "how do you aspire to be more like her?" as "I checked our records
  // and searched, but I couldn't pin down the AI's aspirations… regarding Zoe Lane" — a records
  // claim about a question that was never about records.
  // ⭐ GENERAL KNOWLEDGE IS NOT A RECORDS MISS. metacognition already holds this rule — buildDirective
  // returns null for scope 'general' ("the model is the source; never suppress it") — but the ladder
  // didn't know about scope and overrode it. Live 2026-07-20: "what are the laws of thermodynamics
  // and how are new China made chips being designed to go around them" ran graph→wiki→routed→web→
  // excavate, found no ENTITY, and answered "I checked our records and searched, but I couldn't pin
  // down China comp…" — refusing a question the model can simply answer.
  //
  // Returning null hands the turn back to the normal flow, where the writer answers from its own
  // knowledge with the full package. The refusal is reserved for questions that were actually about
  // something we should hold and don't.
  if (scope === 'general' && !object) {
    console.log(`[cognition] general-knowledge miss on "${String(need0).slice(0, 60)}" → answering from the model, not refusing`);
    return null;
  }
  // ERROR-VS-EMPTY at the closer: "I checked X" may only cover lanes that ran CLEAN. A lane whose
  // guarded call THREW (Echo down, network dead, embedder hung) was not checked — it failed. All
  // lanes failed → the honest sentence is "the lookup failed", never "it's not there".
  const _errs = deps._laneErrors || [];
  if (_errs.length) console.warn(`[cognition] ${_errs.length} lane error(s) during enrich: ${_errs.slice(0, 6).map((x) => `${x.lane}: ${String(x.msg).slice(0, 60)}`).join(' · ')}`);
  const _errLanes = [...new Set(_errs.map((x) => x.lane))];
  const _clean = _tried.filter((m) => !_errLanes.includes(m));
  if (_tried.length && !_clean.length && _errLanes.length) {
    return { say: `I tried to look that up, but the lookup itself failed on my side (${_errLanes.join(', ')}) — so treat this as a failed search, not as ${need0} being absent. I can retry in a bit.`, enriched: true, missed: true, lookupFailed: true, need: need0, tried: _tried, errLanes: _errLanes };
  }
  const _ours = _clean.includes('graph') || _clean.includes('routed');
  const _out = _clean.includes('wiki') || _clean.includes('web') || _clean.includes('excavate');
  const where = _ours && _out ? 'I checked our records and searched'
    : _ours ? 'I checked our records'
    : _out ? 'I searched'
    : 'I looked at what I have';
  const _unchecked = _errLanes.filter((l) => _tried.includes(l));
  const _uncheckedNote = _unchecked.length ? ` (my ${_unchecked.join('/')} lookup${_unchecked.length > 1 ? 's' : ''} errored, so that part went unchecked)` : '';
  return { say: `${where}, but I couldn't pin down ${need0}.${_uncheckedNote}`, enriched: true, missed: true, need: need0, tried: _tried, errLanes: _errLanes };
}

module.exports = { answerGrounded, _draftOrNeed, _enrichConvo, _enrichGraph, _enrichWiki, _enrichNews, _enrichForecast, isForecastQuestion, _enrichRouted, _enrichWeb, _enrichExcavate, _kickWriteBack, _worthExcavating, _hasStaleGrounding, _entLine, _billToksOf, _instanceMismatch, NEED_RE };
