/**
 * lib/graph_extract.js — structured extraction of GROUNDED readings into the graph
 * (anti-glob follow-up #3). When she reads a real external page, pull the factual
 * entity/relation triples it asserts into her graph as epistemic 'read' facts, with the
 * reading as the source. This is how the canonical graph gets populated with real-world
 * structure she can think FROM (factsForPrompt) instead of her own speculation.
 *
 * Small-model friendly: a constrained predicate vocab + a strict line format + a parser
 * that rejects pronouns and sentence-shaped "entities" so a sloppy generation can't pollute
 * the graph (mirrors echo/extraction's closed-vocab classifier approach).
 */
const db = require('./db');
const gm = require('./graph_memory');
const { streamChat } = require('./ollama');
const MODEL = require('./config').model();

const EXTRACT_MIN_GAP_MS = 5 * 60 * 1000;   // at most one extraction per 5 min (bounded cost)
const MIN_TEXT_LEN = 200;

// Closed-ish predicate vocab — keep it aligned with Echo's [graph] spirit for clean federation.
const VOCAB = [
  'WORKS_FOR', 'PART_OF', 'LOCATED_IN', 'RELATED_TO', 'CREATED', 'LEADS', 'MEMBER_OF',
  'FOCUSES_ON', 'REGULATES', 'FUNDS', 'OPPOSES', 'SUPPORTS', 'MET_WITH', 'RESPONSIBLE_FOR',
  'SUCCEEDS', 'CITES', 'SPONSORED', 'AFFECTS'
];

function buildPrompt(text) {
  return [{
    role: 'user',
    content: `Extract factual relationships the text BELOW actually asserts, as triples. Output ONLY lines of the form:\nSource | RELATION | Target\n\nRELATION must be UPPER_SNAKE from this list (use RELATED_TO if none fit): ${VOCAB.join(', ')}.\nSource and Target must be CONCRETE NAMED ENTITIES (a person, org, place, bill, program) — never a pronoun, never a whole sentence.\nOnly relationships the text states; do NOT infer, generalize, or invent. Max 6 lines. If there are none, output exactly: NONE\n\nTEXT:\n${String(text || '').slice(0, 2000)}`
  }];
}

// Parse "Source | RELATION | Target" lines into clean triples. Rejects pronouns and
// sentence-shaped fields so model slop can't enter the graph.
function parseTriples(raw) {
  const out = [];
  const PRONOUN = /^(it|he|she|they|this|that|these|those|the text|we|i|you)$/i;
  for (const line of String(raw || '').split('\n')) {
    const parts = line.split('|');
    if (parts.length !== 3) continue;
    const s = parts[0].trim().replace(/^[-*\d.)\s]+/, '');
    const rel = parts[1].trim().toUpperCase().replace(/\s+/g, '_');
    const t = parts[2].trim();
    if (!s || !t || !rel) continue;
    if (s.length > 60 || t.length > 60) continue;                 // a sentence, not an entity
    if (s.split(/\s+/).length > 6 || t.split(/\s+/).length > 6) continue;
    if (PRONOUN.test(s) || PRONOUN.test(t)) continue;
    if (!/^[A-Z][A-Z_]+$/.test(rel)) continue;
    out.push({ source: s, type: rel, target: t });
    if (out.length >= 6) break;
  }
  return out;
}

async function extractTriples(text, deps = {}) {
  const extract = deps.extract || (async (txt) => {
    let raw = '';
    await streamChat({
      model: deps.MODEL || MODEL,
      messages: buildPrompt(txt),
      options: { temperature: 0.2, top_p: 0.9, num_ctx: 8192, num_predict: 200 },
      onToken: (tok) => { raw += tok; }
    });
    return raw;
  });
  let raw = '';
  try { raw = await extract(text); } catch { return []; }
  return parseTriples(raw);
}

// Record extracted triples as GROUNDED ('read') graph facts, with the reading as source.
async function ingestReading({ text, ref = null, excerpt = null, deps = {} } = {}) {
  const triples = await extractTriples(text, deps);
  let recorded = 0;
  for (const tr of triples) {
    try {
      const r = gm.recordRelation({
        source: tr.source, target: tr.target, type: tr.type,
        epistemic: 'read', proposedBy: 'reading-extract',
        sourceObj: { kind: 'reading', ref, excerpt: excerpt || null }
      });
      if (r && r.relationId) recorded++;
    } catch { /* skip a bad triple */ }
  }
  return { triples: triples.length, recorded };
}

// Throttled, best-effort wrapper for the live reading path (fire-and-forget; self-contained
// error handling so it can never reject into the idle loop).
async function maybeIngestReading({ text, ref } = {}) {
  try {
    const last = parseInt(db.getMeta('last_graph_extract_at') || '0', 10);
    if (Date.now() - last < EXTRACT_MIN_GAP_MS) return { skipped: 'throttled' };
    if (!text || text.length < MIN_TEXT_LEN) return { skipped: 'thin' };
    db.setMeta('last_graph_extract_at', String(Date.now()));
    return await ingestReading({ text, ref, excerpt: String(text || '').slice(0, 160) });
  } catch (e) { return { error: e.message }; }
}

module.exports = { parseTriples, extractTriples, ingestReading, maybeIngestReading, buildPrompt, VOCAB };
