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
    + 'essentially empty or clearly about something else, so you genuinely cannot answer accurately.';
  let out = null;
  try {
    out = await askFn({
      task: 'answer_or_need', v: 1,
      input: { question: String(userMessage).slice(0, 800), grounding: String(grounding || '').slice(0, 4200) },
      want,
      validate: (raw) => { const t = String(raw || '').replace(/^```[a-z]*\s*|\s*```$/gi, '').trim(); return t.length > 3 ? { valid: true, value: t } : { valid: false, error: 'empty' }; },
      deps: { complete: deps.complete || ad._draftComplete, skipBudget: true }
    });
  } catch (e) { return null; }
  if (typeof out !== 'string' || !out.trim()) return null;
  const t = out.trim();
  const m = t.match(NEED_RE);
  if (m) return { need: m[1].trim().replace(/\s+/g, ' ').slice(0, 160) };
  return { answer: t };
}

function _json(s) { try { return JSON.parse(s); } catch { return null; } }
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
  } catch {}
  for (const e of hits.slice(0, 6)) { const l = _entLine(e); if (l) parts.push(l); }
  const seen = new Set();
  const toWalk = [];
  if (object && object.id) toWalk.push({ id: object.id, name: object.name });
  for (const e of hits.slice(0, 2)) if (e && e.id) toWalk.push({ id: e.id, name: e.name });
  for (const w of toWalk) {
    if (!w.id || seen.has(w.id)) continue; seen.add(w.id);
    try {
      const kr = await d({ kind: 'do', name: 'kg_neighborhood', args: { entity_id: w.id, top_k: 12 } });
      if (kr && kr.ok) { const ns = echo.normalizeNeighbors(_json(kr.text) || {}); if (ns.length) parts.push(`Connected to ${w.name || 'it'}: ${ns.slice(0, 12).join(', ')}`); }
    } catch {}
  }
  return parts.join('\n').trim();
}

// ENRICH tier 2 — the live web, via the app's OWN DuckDuckGo search (lib/web_search; Echo's web_search
// has no provider keys). The "let me find out" for anything not in our records. Returns text (or '').
async function _enrichWeb(need, deps = {}) {
  const searchFn = deps.webSearch || ((q) => { try { return require('./web_search').search(q); } catch { return Promise.resolve(null); } });
  const fetchFn = deps.fetchPage || ((u) => { try { return require('./web_search').fetchPage(u, { maxChars: 3000 }); } catch { return Promise.resolve(null); } });
  let results = [];
  try { const r = await searchFn(need); results = (r && r.results) || (Array.isArray(r) ? r : []); } catch {}
  if (!results.length) return '';
  const parts = [];
  // FETCH the top TWO result pages — DDG snippets are often just the title, and the #1 hit can be messy
  // (Wikipedia serves raw infobox wikitext); a cleaner source (Ballotpedia etc.) at #2 carries the answer.
  const urls = results.filter(x => x && x.url).slice(0, 2);
  for (const u of urls) {
    try { const p = await fetchFn(u.url); if (p && p.ok && p.text && p.text.length > 120) parts.push(`From ${p.title || u.url}:\n${p.text.slice(0, 2400)}`); } catch {}
  }
  const snip = results.slice(0, 5).map(x => {
    const t = String((x && x.title) || '').replace(/\s+/g, ' ').trim();
    const s = String((x && x.snippet) || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    return '• ' + [t, s].filter(Boolean).join(' — ');
  }).filter(l => l.length > 3);
  if (snip.length) parts.push(snip.join('\n'));
  return parts.join('\n\n').trim();
}

// ENRICH tier 1.5 — the cloud TOOL EXECUTOR: let the cloud pick + run the right recipe / db_query / tool
// for the need (counts, lists, structured records our neighborhood-walk doesn't surface — the LAMP-count
// class). This is what the interface used to fumble with a local <echo-find>; now the cloud does it.
async function _enrichRouted(need, deps = {}) {
  const route = deps.routeNeed || ((q) => { try { return require('./echo_suit').routeNeed(q); } catch { return Promise.resolve(null); } });
  try {
    const r = await route(need);
    if (r && (r.ok || r.text)) {
      const t = String(r.text || '').replace(/\s+/g, ' ').trim();
      if (t.length > 40) return `Looked up in our records (${r.chose || 'tool'}): ${t.slice(0, 2400)}`;
    }
  } catch {}
  return '';
}

// The turn's grounded answer with the enrich/recovery reflex. Returns:
//   { say, enriched, enrichSource, missed?, need? }  — the substance for the voice block, or
//   null  → cloud unavailable → caller uses the normal local flow.
async function answerGrounded({ userMessage, grounding = '', object = null, userName = 'Lucas', deps = {} } = {}) {
  if (!userMessage) return null;
  let g = String(grounding || '').trim();
  let step = await _draftOrNeed(userMessage, g, deps);
  if (!step) return null;                                    // cloud down → local flow
  if (step.answer) return { say: step.answer, enriched: false, enrichSource: null };
  if (!step.need) return null;
  const need0 = step.need;
  // ENRICH escalation: OUR graph first, then the live web. Re-draft after each; stop as soon as the
  // grounding can actually answer. This is "let me find out" — never a dead-end, never invented.
  for (const mode of ['graph', 'routed', 'web']) {
    if (!step || !step.need) break;
    const found = mode === 'graph' ? await _enrichGraph(step.need, object, deps)
                : mode === 'routed' ? await _enrichRouted(step.need, deps)
                : await _enrichWeb(step.need, deps);
    if (!found) continue;
    g = [g, `Just retrieved for this (${mode}):\n${found}`].filter(Boolean).join('\n\n');
    step = await _draftOrNeed(userMessage, g, deps);
    if (step && step.answer) return { say: step.answer, enriched: true, enrichSource: mode };
  }
  // couldn't confirm it anywhere — honest, never a bare dead-end, never a confabulation.
  return { say: `I checked our records and searched, but I couldn't pin down ${need0}.`, enriched: true, missed: true, need: need0 };
}

module.exports = { answerGrounded, _draftOrNeed, _enrichGraph, _enrichRouted, _enrichWeb, _entLine, NEED_RE };
