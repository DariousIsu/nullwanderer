/* studio/creator_research.js — the Creator's "Research & Assist" analyzer (clinical panel).
 *
 * Reframed from per-sentence source-hunting (which was noisy + useless) to ENTITY-CENTRIC research:
 * read the draft, pull the entities (people / orgs / places / bills / sections), and surface what
 * the operator's database already knows + complementary reading, then (cloud, opt-in) writing
 * suggestions. One deterministic pathway; the model/cloud are caged at named leaves.
 *
 *   DETECT (this module, local, 0-token, generous — the DB match gates precision)
 *     → MATCH    search_entities, name-overlap gated + typed         (main, engine retrieval)
 *     → COMPLEMENT kg_neighborhood + corpus search + web/academic     (main, retrieval; web toggled)
 *     → ADVISE    cloud writing suggestions: additions/direction/tone (main, cloud leaf, opt-in)
 *
 * This module is PURE: entity detection, the match gate, and the advisor prompt/parse. The engine
 * and cloud calls live in main. Reuses studio/creator_sources for the web/academic classifier.
 */
'use strict';

const PROSE = new Set(['heading', 'paragraph', 'list_item']);
const MAX_ENTITIES = 30;

// Connectors allowed INSIDE a proper-noun phrase ("Joseph Rainey Center for Public Policy").
// Deliberately excludes "and"/"&" — those bridge unrelated runs ("SPEED Act and Section" → junk).
const CONNECTORS = '(?:of|for|the|de|la|von|van)';
// A name word: TitleCase ("Rainey") or an ALL-CAPS acronym ("SPEED", "SAVE").
const NAMEWORD = "(?:[A-Z][a-zA-Z.'’-]*|[A-Z]{2,})";
const PHRASE_RE = new RegExp(NAMEWORD + '(?:\\s+' + CONNECTORS + '\\s+' + NAMEWORD + '|\\s+' + NAMEWORD + ')*', 'g');

// Single capitalized words that are almost always sentence-openers / function words, not entities.
const LEAD_STOP = new Set(('the a an this that these those it he she they we i but and or if when while however '
  + 'today yesterday tomorrow asked let lets meanwhile also here there now then yes no so as at in on for to of '
  + 'with from his her their our your not is are was were be been first last next new each every still even yet '
  + 'majority minority both many most some other section act bill subsection title chapter clause article paragraph').split(/\s+/));

function cleanMention(m) { return String(m || '').trim().replace(/[.,;:'’"]+$/, '').replace(/\s+/g, ' '); }

// Leading words to strip off a detected name so the mention is the bare entity (and the name-overlap
// gate isn't broken by an honorific): articles + common political/honorific titles. "Majority Leader
// John Thune" → "John Thune"; "Senator Mike Lee" → "Mike Lee"; "The Joseph Rainey Center" → "Joseph …".
const LEAD_DROP = new Set(('the a an senator sen rep representative president pres governor gov mayor dr mr mrs ms '
  + 'chairman chairwoman chair chairperson speaker leader majority minority justice judge secretary congressman '
  + 'congresswoman general attorney').split(/\s+/));
function stripLead(m) {
  let w = String(m || '').split(/\s+/);
  while (w.length > 1 && LEAD_DROP.has(w[0].toLowerCase().replace(/\.$/, ''))) w = w.slice(1);
  return w.join(' ');
}

// Generous deterministic entity detection. Over-generates on purpose — the DB match gate
// (classifyEntity) decides what actually surfaces, so recall matters more than precision here.
function detectEntities(blocks) {
  const text = (Array.isArray(blocks) ? blocks : []).filter(b => b && PROSE.has(b.type)).map(b => String(b.text || '')).join('\n');
  const out = new Map();   // norm → { mention, kind }
  const add = (raw, kind) => {
    let m = cleanMention(raw);
    if (kind === 'name') m = cleanMention(stripLead(m));   // drop honorifics/articles for clean matching
    if (m.length < 3) return;
    const words = m.split(/\s+/);
    if (words.length === 1 && LEAD_STOP.has(m.toLowerCase())) return;       // bare sentence-opener
    if (words.every(w => LEAD_STOP.has(w.toLowerCase()))) return;           // all function words
    const norm = m.toLowerCase();
    if (!out.has(norm)) out.set(norm, { mention: m, kind: kind || 'name' });
  };
  // legislative / legal patterns (typed) — run first so they win their spans
  for (const m of text.matchAll(/\b([A-Z][A-Za-z]*(?:\s+[A-Z][A-Za-z]*)*\s+Act)\b/g)) add(m[1], 'bill');
  for (const m of text.matchAll(/\bSection\s+\d+[A-Za-z]?\b/g)) add(m[0], 'legal');
  for (const m of text.matchAll(/\b(?:H\.?\s?R\.?|S\.?)\s?\d{1,5}\b/g)) add(m[0], 'bill');
  // proper-noun phrases
  for (const m of text.matchAll(PHRASE_RE)) add(m[0], 'name');
  return [...out.values()].slice(0, MAX_ENTITIES);
}

// Significant tokens of a mention for the gate: alphabetic, length ≥ 3, minus connectors/very-common
// words ("of/for/and/the/act/…") that a DB entity name often omits and would otherwise break overlap.
const GATE_STOP = new Set('of for and the de la von van or to in on at by act bill section'.split(' '));
function sigTokens(mention) {
  return (String(mention || '').toLowerCase().match(/[a-z][a-z'’-]{2,}/g) || []).filter(t => !GATE_STOP.has(t));
}
// Name-overlap gate: a search_entities hit is kept only if EVERY significant token of the mention
// appears in the matched entity's NAME (case-insensitive). This is what drops "SPEED Act" → "LD 1634"
// (the name has neither "speed" nor "act") while keeping "Mike Lee" → "LEE, MIKE [S0UT00165]".
function nameMatches(mention, entityName) {
  const name = String(entityName || '').toLowerCase();
  const toks = sigTokens(mention);
  if (!toks.length) return false;
  return toks.every(t => name.includes(t));
}

// Classify a mention's DB match from search_entities results
// ([{id,name,entity_type,entity_subtype,summary,confidence,rank}], best-first). Keeps up to 3
// name-overlap-passing candidates (the operator disambiguates). matched=false ⇒ no record.
function classifyEntity(mention, results) {
  const arr = Array.isArray(results) ? results : [];
  const kept = [];
  for (const r of arr) {
    if (!r || !nameMatches(mention, r.name)) continue;
    kept.push({
      id: r.id != null ? r.id : null,
      name: r.name || '',
      type: r.entity_type || null,
      subtype: r.entity_subtype || null,
      summary: firstLine(r.summary),
    });
    if (kept.length >= 3) break;
  }
  return { matched: kept.length > 0, candidates: kept };
}
function firstLine(s) { return String(s || '').split('\n')[0].trim().slice(0, 140); }

// ---- cloud writing-advisor leaf (prompt + parse) -------------------------------------------------
// The cloud model reads the draft + the gathered research context and proposes WRITING suggestions
// in three buckets the operator asked for: additions, directional options, tone. It is caged: it
// returns a fixed JSON shape; the operator accepts/dismisses. It never edits the document.
function buildAdvisorMessages(docText, context) {
  const ctx = (context && context.trim()) ? `\n\nWhat the operator's database already knows (use this to ground "additions"):\n${context.trim().slice(0, 3000)}` : '';
  const system = [
    'You are a clinical writing advisor embedded in a research-document editor. Read the DRAFT and',
    'propose concrete, grounded suggestions in three buckets. Be specific and brief; do NOT rewrite',
    'the document or invent facts.',
    '',
    'Return ONLY a JSON object (no prose, no code fence):',
    '{',
    '  "additions":  [ {"title":"<short>","detail":"<what to add and why, 1-2 sentences>"} ],',
    '  "directions": [ {"title":"<short>","detail":"<an option for where the piece could go>"} ],',
    '  "tone":       [ {"observation":"<current tone read>","suggestion":"<adjustment for the audience>"} ]',
    '}',
    'Each bucket: 1-3 items, omit a bucket with []. Prefer additions that draw on the database context below.',
  ].join('\n');
  const user = `DRAFT:\n${String(docText || '').slice(0, 6000)}${ctx}`;
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

function parseAdvice(modelText) {
  const s = String(modelText || '');
  const a = s.indexOf('{'); const b = s.lastIndexOf('}');
  let obj = {};
  if (a >= 0 && b > a) { try { obj = JSON.parse(s.slice(a, b + 1)); } catch { obj = {}; } }
  const arr = (v) => Array.isArray(v) ? v : [];
  const clip = (x) => String(x == null ? '' : x).slice(0, 280);
  return {
    additions: arr(obj.additions).slice(0, 5).map(x => ({ title: clip(x && x.title), detail: clip(x && x.detail) })).filter(x => x.title || x.detail),
    directions: arr(obj.directions).slice(0, 5).map(x => ({ title: clip(x && x.title), detail: clip(x && x.detail) })).filter(x => x.title || x.detail),
    tone: arr(obj.tone).slice(0, 5).map(x => ({ observation: clip(x && x.observation), suggestion: clip(x && x.suggestion) })).filter(x => x.observation || x.suggestion),
  };
}

module.exports = {
  detectEntities, classifyEntity, nameMatches, sigTokens,
  buildAdvisorMessages, parseAdvice, cleanMention,
  MAX_ENTITIES,
};
