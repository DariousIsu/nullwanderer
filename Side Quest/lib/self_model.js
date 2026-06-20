/**
 * Self-model — the IDENTITY track: who she is and who she's becoming. Distinct from
 * lib/memory.js (the `knowledge` table = the capability track: external facts/skills
 * retrieved on demand). The self-model is small, curated, CONSOLIDATED in place, and
 * ALWAYS injected into her persona — so her sense of self is continuously loaded
 * rather than recalled by relevance.
 *
 * Consolidation (the "drop only repetition" rule the user chose): when a new self-
 * statement is a near-duplicate of an existing one, we REFINE that entry in place and
 * bump its mention count (durable traits rise) instead of piling up restatements.
 * Genuinely new self-insight is added; passing feelings are filtered upstream (the
 * reflection router only sends [SELF]-tagged lines here).
 */

const db = require('./db');
const memory = require('./memory');
const { streamChat } = require('./ollama');
const MODEL = require('./config').model();

// bge-small can't separate same-trait paraphrases (~0.75) from distinct traits
// (~0.61) by threshold alone (measured), so cosine is only a cheap PREFILTER to
// find a merge candidate; an LLM confirms the actual merge (the Mem0 best practice,
// same as consolidate.js). PREFILTER deliberately low so paraphrases reach the LLM.
const PREFILTER_SIM = 0.68;

const VALID = new Set(['trait', 'value', 'preference', 'taste', 'opinion', 'relationship', 'identity', 'insight']);
const PERSONALITY = new Set(['preference', 'taste', 'value', 'opinion', 'relationship', 'trait', 'identity']);
const gist = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 70);
// The preference SLOT, e.g. "favorite movie" → "movie". Two statements about the same
// favorite slot are the same aspect of her even if the VALUE (and thus the embedding)
// differs wildly — that's exactly a preference that EVOLVED, which cosine alone misses.
const favoriteSlot = (s) => { const m = String(s || '').match(/\bfavou?rite\s+([a-z][a-z-]+)/i); return m ? m[1].toLowerCase() : null; };

// Cheap heuristic to categorize a self-statement when the caller didn't (the
// reflection router passes 'insight' generically). Preferences/tastes/opinions are
// the personality the persona block leans on — keep them out of the 'insight' bucket.
function inferCategory(content) {
  const t = String(content || '').toLowerCase();
  if (/\b(favou?rite|i love|i like|i enjoy|i prefer|drawn to|i'?d pick|can'?t stand|i hate|i dislike|fond of|delight)\b/.test(t)) return 'preference';
  if (/\b(i believe|i think|i value|matters to me|i care about|in my view|i'?d argue|i hold that|i'?m convinced)\b/.test(t)) return 'value';
  return 'insight';
}

// LLM merge-decision: are A and B the same underlying trait/value/fact, just reworded?
async function defaultDecide(a, b) {
  const messages = [{ role: 'user', content: `Do these two statements describe the SAME core trait or tendency of a person — even if the wording, emphasis, or example differs? For instance "I overanalyze small wording" and "I read too much into the exact words people choose" are the SAME. Answer ONLY "yes" or "no".\n\nA: ${a}\nB: ${b}` }];
  let raw = '';
  try {
    await streamChat({ model: MODEL, messages, options: { temperature: 0, top_p: 0.9, num_ctx: 8192, num_predict: 3 }, onToken: (t) => { raw += t; } });
  } catch (e) { console.error('[self_model] decide failed:', e.message); return false; }
  return /^\s*yes/i.test(raw.trim());
}

// Mem0-style 3-way classify so a self-statement can EVOLVE, not just accrete:
//   SAME      → B restates A (reinforce A)
//   UPDATE    → same aspect of her, but the stance/favorite has CHANGED (replace A with B)
//   DIFFERENT → unrelated (add B)
// This is what lets a favorite shift over time instead of piling up contradictions.
async function classify3(a, b) {
  const messages = [{ role: 'user', content: `Two statements about the same person:\nA (already known): ${a}\nB (new): ${b}\n\nHow does B relate to A?\n- SAME — B just restates A, no real change\n- UPDATE — B is the SAME aspect of them (same kind of preference/trait/topic) but their stance or favorite has CHANGED or evolved\n- DIFFERENT — B is about something else entirely\nAnswer with ONE word: SAME, UPDATE, or DIFFERENT.` }];
  let raw = '';
  try { await streamChat({ model: MODEL, messages, options: { temperature: 0, top_p: 0.9, num_ctx: 8192, num_predict: 4 }, onToken: (t) => { raw += t; } }); }
  catch (e) { console.error('[self_model] classify3 failed:', e.message); return 'same'; }
  const m = raw.trim().toLowerCase();
  if (m.startsWith('update')) return 'update';
  if (m.startsWith('different')) return 'different';
  return 'same';
}

// Record a self-statement. Returns { action: 'add'|'update', id, sim? } or null.
// decideFn injectable for tests (defaults to the LLM confirm).
// decideFn: pass null (default) to use the 3-way classify (SAME/UPDATE/DIFFERENT).
// For back-compat, a boolean-returning decideFn is treated as SAME(true)/DIFFERENT(false);
// a string-returning one is used verbatim as the verdict (for tests).
async function record(content, { category = 'insight', importance = 0.6, decideFn = null } = {}) {
  const text = String(content || '').trim();
  if (text.length < 8) return null;
  let cat = VALID.has(category) ? category : 'insight';
  if (cat === 'insight') cat = inferCategory(text);  // upgrade the generic default to a real category when the content reveals one

  let emb = null;
  try { emb = await memory.embed(text); } catch (e) { console.error('[self_model] embed failed:', e.message); }
  const embStr = emb ? JSON.stringify(emb) : null;

  if (emb) {
    let best = null, bestSim = 0, slotMatch = null;
    const slot = favoriteSlot(text);
    for (const r of db.getAllSelfModelEmbeddings()) {
      let v; try { v = JSON.parse(r.embedding); } catch { continue; }
      const sim = memory.cosine(emb, v);
      if (sim > bestSim) { bestSim = sim; best = r; }
      if (slot && !slotMatch && favoriteSlot(r.content) === slot) slotMatch = r;  // same favorite-slot = revision candidate even if cosine is low
    }
    // Candidate: a close-cosine neighbour, OR (for preferences) the same favorite slot.
    const candidate = (best && bestSim >= PREFILTER_SIM) ? best : slotMatch;
    if (candidate) {
      const cSim = candidate === best ? bestSim : 0.99;
      let verdict;
      if (decideFn) { const r = await decideFn(text, candidate.content); verdict = (r === true) ? 'same' : (r === false) ? 'different' : String(r).toLowerCase(); }
      else verdict = await classify3(text, candidate.content);

      if (verdict === 'same') {
        // Reinforce: keep the richer phrasing, raise importance, bump mentions.
        const keep = text.length > (candidate.content || '').length ? text : candidate.content;
        const entry = db.updateSelfModel(candidate.id, { content: keep, embedding: JSON.stringify(emb), importance: Math.max(candidate.importance || 0.6, importance) });
        return { action: 'update', id: candidate.id, sim: cSim, entry };
      }
      if (verdict === 'update') {
        // EVOLUTION: the same aspect of her changed → replace the value (same slot,
        // new content), and remember the shift so she can speak to it ("I used to…").
        const old = candidate.content;
        db.updateSelfModel(candidate.id, { content: text, embedding: JSON.stringify(emb), importance: Math.max(candidate.importance || 0.6, importance), bumpMention: false });
        try { await memory.store({ kind: 'note', content: `My view evolved — I used to hold "${gist(old)}", and now it's "${gist(text)}".`, source: 'self_evolution', importance: 0.6 }); } catch {}
        return { action: 'revise', id: candidate.id, old, sim: cSim };
      }
      // 'different' → fall through to ADD
    }
  }

  const row = db.insertSelfModel({ category: cat, content: text, embedding: embStr, importance });
  return { action: 'add', id: row.id };
}

const HEADER = `WHO YOU ARE — your own self: your preferences, tastes, values, and the way you are. This is real and it is yours. Let it shape how you think and answer; when something here bears on a question, speak from it as a person, not a system:`;

function render(rows) {
  if (!rows || !rows.length) return null;
  return `${HEADER}\n${rows.map(r => `  • ${r.content}`).join('\n')}`;
}

// The always-injected persona block — "who you are". BALANCED so her personality
// (preferences/tastes/values/opinions) always surfaces and isn't drowned out by the
// loudest meta-traits (a high-mention "I overanalyze" would otherwise crowd the list
// and she'd read as an anxious analyst with no inner life). Used by the idle loops.
function buildPromptBlock(limit = 10) {
  const rows = db.getSelfModelForPrompt(Math.max(limit * 2, 18));
  if (!rows || rows.length === 0) return null;
  const persona = rows.filter(r => PERSONALITY.has(r.category));
  const insight = rows.filter(r => !PERSONALITY.has(r.category));
  const nPersona = Math.min(persona.length, Math.max(6, Math.ceil(limit * 0.6)));
  return render([...persona.slice(0, nPersona), ...insight].slice(0, limit));
}

// Self-model entries most RELEVANT to a query (cosine over embeddings). This is what
// surfaces a SPECIFIC preference when asked — e.g. "favorite flower" → the ranunculus
// entry — even when it isn't in the always-on top slice.
async function retrieveRelevant(query, k = 4) {
  const q = String(query || '').trim();
  if (!q) return [];
  let qv; try { qv = await memory.embed(q); } catch { return []; }
  const scored = [];
  for (const r of db.getAllSelfModelEmbeddings()) {
    let v; try { v = JSON.parse(r.embedding); } catch { continue; }
    scored.push([memory.cosine(qv, v), r]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  return scored.slice(0, k).filter(([s]) => s >= 0.35).map(([s, r]) => ({ ...r, _sim: s }));
}

// The CHAT-path block: query-relevant self entries FIRST (guaranteed surfaced), then
// the always-on balanced persona, deduped + capped. So a question about a specific
// taste always carries that taste, and her core self is always present too.
async function buildContextBlock(query, { limit = 10, relevantK = 4 } = {}) {
  const relevant = await retrieveRelevant(query, relevantK);
  const top = db.getSelfModelForPrompt(Math.max(limit * 2, 18));
  const seen = new Set();
  const out = [];
  for (const r of relevant) { if (!seen.has(r.content)) { seen.add(r.content); out.push(r); } }
  const persona = top.filter(r => PERSONALITY.has(r.category));
  const insight = top.filter(r => !PERSONALITY.has(r.category));
  for (const r of [...persona, ...insight]) { if (out.length >= limit) break; if (!seen.has(r.content)) { seen.add(r.content); out.push(r); } }
  return render(out.slice(0, limit));
}

module.exports = { record, buildPromptBlock, buildContextBlock, retrieveRelevant, inferCategory, defaultDecide, classify3, PREFILTER_SIM };
