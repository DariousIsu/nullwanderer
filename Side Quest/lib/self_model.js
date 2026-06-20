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

const VALID = new Set(['trait', 'value', 'preference', 'relationship', 'insight']);

// LLM merge-decision: are A and B the same underlying trait/value/fact, just reworded?
async function defaultDecide(a, b) {
  const messages = [{ role: 'user', content: `Do these two statements describe the SAME underlying trait, value, preference, or fact about a person (just reworded or one a refinement of the other)? Answer ONLY "yes" or "no".\n\nA: ${a}\nB: ${b}` }];
  let raw = '';
  try {
    await streamChat({ model: MODEL, messages, options: { temperature: 0, top_p: 0.9, num_ctx: 8192, num_predict: 3 }, onToken: (t) => { raw += t; } });
  } catch (e) { console.error('[self_model] decide failed:', e.message); return false; }
  return /^\s*yes/i.test(raw.trim());
}

// Record a self-statement. Returns { action: 'add'|'update', id, sim? } or null.
// decideFn injectable for tests (defaults to the LLM confirm).
async function record(content, { category = 'insight', importance = 0.6, decideFn = defaultDecide } = {}) {
  const text = String(content || '').trim();
  if (text.length < 8) return null;
  const cat = VALID.has(category) ? category : 'insight';

  let emb = null;
  try { emb = await memory.embed(text); } catch (e) { console.error('[self_model] embed failed:', e.message); }
  const embStr = emb ? JSON.stringify(emb) : null;

  if (emb) {
    let best = null, bestSim = 0;
    for (const r of db.getAllSelfModelEmbeddings()) {
      let v; try { v = JSON.parse(r.embedding); } catch { continue; }
      const sim = memory.cosine(emb, v);
      if (sim > bestSim) { bestSim = sim; best = r; }
    }
    if (best && bestSim >= PREFILTER_SIM && await decideFn(text, best.content)) {
      // Reinforce: keep the richer phrasing, raise importance, bump mentions.
      const keep = text.length > (best.content || '').length ? text : best.content;
      const entry = db.updateSelfModel(best.id, {
        content: keep,
        embedding: JSON.stringify(emb),
        importance: Math.max(best.importance || 0.6, importance)
      });
      return { action: 'update', id: best.id, sim: bestSim, entry };
    }
  }

  const row = db.insertSelfModel({ category: cat, content: text, embedding: embStr, importance });
  return { action: 'add', id: row.id };
}

// The always-injected persona block — "who you are". Null when empty.
function buildPromptBlock(limit = 10) {
  const rows = db.getSelfModelForPrompt(limit);
  if (!rows || rows.length === 0) return null;
  const lines = rows.map(r => `  • ${r.content}`).join('\n');
  return `WHO YOU ARE — your evolving sense of self, built from your own reflection. Let this shape how you think, what you care about, and how you respond:\n${lines}`;
}

module.exports = { record, buildPromptBlock, defaultDecide, PREFILTER_SIM };
