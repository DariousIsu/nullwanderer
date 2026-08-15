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
const MODEL = require('./config').extractionModel();

// bge-small can't separate same-trait paraphrases (~0.75) from distinct traits
// (~0.61) by threshold alone (measured), so cosine is only a cheap PREFILTER to
// find a merge candidate; an LLM confirms the actual merge (the Mem0 best practice,
// same as consolidate.js). PREFILTER deliberately low so paraphrases reach the LLM.
const PREFILTER_SIM = 0.68;
// SATURATION (lever 4 — "reward rare, not frequent"): if a new self-statement lands in an
// already over-represented neighborhood (sum of nearby entries' mentions ≥ this), its
// reinforcement plateaus — no further importance climb / mention bump, and a new facet of
// that cluster is added at reduced weight. Stops the reflection→interest→reinforce loop
// from concentrating her identity into one obsession (the immersive-storytelling blob).
const SATURATION_MASS = 12;
const CLUSTER_SIM = 0.70;

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
  // 'unknown' on failure, NEVER 'same' (2026-08-15 deep-dive M5): with the LLM down, the old
  // catch defaulted 'same' — and record()'s same-branch REPLACES the stored trait's content when
  // the new text is longer. Identity corruption from an outage. 'unknown' falls through record()'s
  // verdict branches to a plain ADD: a duplicate row is churn the consolidator can fix later; an
  // overwritten trait is not.
  try { await streamChat({ model: MODEL, messages, options: { temperature: 0, top_p: 0.9, num_ctx: 8192, num_predict: 4 }, onToken: (t) => { raw += t; } }); }
  catch (e) { console.error('[self_model] classify3 failed:', e.message); return 'unknown'; }
  const m = raw.trim().toLowerCase();
  if (m.startsWith('update')) return 'update';
  if (m.startsWith('different')) return 'different';
  if (m.startsWith('same')) return 'same';
  return 'unknown';   // unparseable output is not agreement
}

// Record a self-statement. Returns { action: 'add'|'update', id, sim? } or null.
// decideFn injectable for tests (defaults to the LLM confirm).
// decideFn: pass null (default) to use the 3-way classify (SAME/UPDATE/DIFFERENT).
// For back-compat, a boolean-returning decideFn is treated as SAME(true)/DIFFERENT(false);
// a string-returning one is used verbatim as the verdict (for tests).
// GUARDRAIL: never canonize anxious self-criticism / rumination as IDENTITY. This is
// the loop that built her negative self-concept ("I overanalyze" 16×, "I default to
// research" 11×): the reflection router fed self-critical takeaways here, they got
// stored, then injected every turn, which reinforced the very behavior. Tastes,
// values, opinions, and positive traits still flow through untouched.
const SELF_REJECT = /\b(over[\s-]?analyz|hesitat|oversell|fabricat|safety net|second[\s-]?guess|struggle to|deferential|incomplete information|don'?t (?:have|experience) (?:a |any |personal )?(?:self|sense of self|preferenc|favou?rite|feelings?|emotions?|opinions?|enjoyment|fatigue)|not (?:sure|certain) (?:i|I)(?:'?m| was| am)? (?:honest|being honest)|tendency to (?:avoid|frame|question|fabricat|oversell|overanaly)|default to (?:research|a broad|broad overview)|can'?t (?:access|interact|use the|browse))/i;

// GROUNDING GATE (#5): reject a "self-trait" that is actually a mangled fragment of LUCAS's 2nd-person
// sentence captured as her 1st-person identity ("you know who you are but not the flavor" → "I am but not
// the flavor"; "you can keep building that beautiful personality" → "I am you can keep building…"). A real
// self-statement never leads with a conjunction/2nd-person pronoun, nor embeds a "you can/will/keep…" clause.
const _GARBLED = /^I(?:'?m| am)\s+(?:you\b|your\b|but\b|and\b|or\b|nor\b|so\b|yet\b|because\b|the flavor\b|not the\b)|^I(?:'?m| am)\b[^.!?]{0,60}\byou\s+(?:can|will|would|should|could|keep|are|have|know|might|need)\b/i;

// #5 (cont.) — two more extraction-leak shapes seen live:
//  • REASSURANCE: a bare compliment TO her captured as a trait ("You're fine, doing great" → "I am fine /
//    I am doing a great job"). Content-free praise is not identity.
//  • OWN-NAME VOCATIVE: a self-statement that ADDRESSES her by her own name ("...fine, Zoe" / "...great job
//    Zoe") — she never calls herself by name, so the name is a leaked 2nd-person vocative ("You're fine, Zoe"
//    → "I am fine Zoe"). The identity statement "I am Zoe" (name straight after the copula) is PRESERVED.
const _SELF_NAME = (() => { try { return String(db.getMeta('assistant_name') || '').trim() || 'Zoe'; } catch { return 'Zoe'; } })();
// Only a BARE, terminal reassurance ("I am fine", "I am doing a great job.") — NOT "I am good at research"
// (a real trait). Terminal = end of string or punctuation; the "… fine Zoe" vocative form is caught below.
const _REASSURANCE = /^I(?:'?m| am)\s+(?:fine|okay|ok|alright|good|great)\s*(?:[.!?,]|$)|^I(?:'?m| am)\s+doing\b[^.!?]{0,24}\b(?:great|good|fine|well|amazing|wonderful)\b(?:\s+(?:job|work))?\s*(?:[.!?,]|$)/i;
function _addressedByOwnName(text) {
  const n = _SELF_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(',\\s*' + n + '\\b', 'i').test(text)) return true;                                       // "..., Zoe" — comma vocative
  return new RegExp("\\b(?!am\\b|I\\b|I'?m\\b)[A-Za-z']+\\s+" + n + "\\b\\s*[.!?]*$", 'i').test(text);      // trailing "… <word> Zoe", but NOT "I am Zoe"
}
// The single leak gate used on every self_model write path.
function _leakedSelfStatement(text) {
  const t = String(text || '');
  return _GARBLED.test(t) || _REASSURANCE.test(t) || _addressedByOwnName(t);
}

async function record(content, { category = 'insight', importance = 0.6, decideFn = null, epistemic = 'speculated' } = {}) {
  const text = String(content || '').trim();
  if (text.length < 8) return null;
  if (SELF_REJECT.test(text)) { console.log('[self_model] guardrail rejected self-critical takeaway:', text.slice(0, 70)); return { skipped: 'self-criticism' }; }
  if (_leakedSelfStatement(text)) { console.log('[self_model] guardrail rejected garbled/reassurance/vocative 2nd-person leak:', text.slice(0, 70)); return { skipped: 'garbled' }; }
  let cat = VALID.has(category) ? category : 'insight';
  if (cat === 'insight') cat = inferCategory(text);  // upgrade the generic default to a real category when the content reveals one

  let emb = null;
  try { emb = await memory.embed(text); } catch (e) { console.error('[self_model] embed failed:', e.message); }
  const embStr = emb ? JSON.stringify(emb) : null;

  let addImportance = importance;
  if (emb) {
    let best = null, bestSim = 0, slotMatch = null, clusterMass = 0;
    const slot = favoriteSlot(text);
    for (const r of db.getAllSelfModelEmbeddings()) {
      let v; try { v = JSON.parse(r.embedding); } catch { continue; }
      const sim = memory.cosine(emb, v);
      if (sim > bestSim) { bestSim = sim; best = r; }
      if (sim >= CLUSTER_SIM) clusterMass += (r.mentions || 0) + 1;   // mass of the surrounding theme
      if (slot && !slotMatch && favoriteSlot(r.content) === slot) slotMatch = r;  // same favorite-slot = revision candidate even if cosine is low
    }
    const saturated = clusterMass >= SATURATION_MASS;
    // Candidate: a close-cosine neighbour, OR (for preferences) the same favorite slot.
    const candidate = (best && bestSim >= PREFILTER_SIM) ? best : slotMatch;
    if (candidate) {
      const cSim = candidate === best ? bestSim : 0.99;
      let verdict;
      if (decideFn) { const r = await decideFn(text, candidate.content); verdict = (r === true) ? 'same' : (r === false) ? 'different' : String(r).toLowerCase(); }
      else verdict = await classify3(text, candidate.content);

      if (verdict === 'same') {
        // Reinforce — but if the theme is already SATURATED, plateau: keep the richer
        // phrasing, do NOT climb importance or bump mentions further (diminishing returns).
        const keep = text.length > (candidate.content || '').length ? text : candidate.content;
        const entry = saturated
          ? db.updateSelfModel(candidate.id, { content: keep, embedding: JSON.stringify(emb), bumpMention: false })
          : db.updateSelfModel(candidate.id, { content: keep, embedding: JSON.stringify(emb), importance: Math.max(candidate.importance || 0.6, importance) });
        if (saturated) console.log('[self_model] saturated theme — reinforcement plateaued (no climb):', keep.slice(0, 50));
        if (epistemic !== 'speculated') db.setSelfModelEpistemic(candidate.id, epistemic);   // grounding (told/witnessed) upgrades the existing trait in place
        return { action: 'update', id: candidate.id, sim: cSim, saturated, entry };
      }
      if (verdict === 'update') {
        // EVOLUTION: the same aspect of her changed → replace the value (same slot,
        // new content), and remember the shift so she can speak to it ("I used to…").
        const old = candidate.content;
        db.updateSelfModel(candidate.id, { content: text, embedding: JSON.stringify(emb), importance: Math.max(candidate.importance || 0.6, importance), bumpMention: false });
        if (epistemic !== 'speculated') db.setSelfModelEpistemic(candidate.id, epistemic);
        try { await memory.store({ kind: 'note', content: `My view evolved — I used to hold "${gist(old)}", and now it's "${gist(text)}".`, source: 'self_evolution', importance: 0.6 }); } catch {}
        // LOOP B: a REVISION is the self actually changing — journal it URGENT so the narrative
        // recomposes now (minimally), instead of carrying the old self up to a blind TTL later.
        try { require('./self_narrative').markDirty('self_model', candidate.id, `revised: "${gist(old)}" → "${gist(text)}"`, { urgent: true }); } catch {}
        return { action: 'revise', id: candidate.id, old, sim: cSim };
      }
      // 'different' → fall through to ADD
    }
    // A genuinely NEW facet that still sits inside a saturated theme → add it, but at
    // reduced weight so the over-grown cluster doesn't keep gaining injection priority.
    if (saturated && best && bestSim >= CLUSTER_SIM) { addImportance = importance * 0.7; console.log('[self_model] saturated theme — new facet added at reduced weight:', text.slice(0, 50)); }
  }

  const row = db.insertSelfModel({ category: cat, content: text, embedding: embStr, importance: addImportance, epistemic });
  // LOOP B: a new facet journals non-urgent (3 accumulate → recompose); a TOLD trait (Lucas
  // affirmed it) is urgent — external affirmation is identity news, not drift.
  try { require('./self_narrative').markDirty('self_model', row.id, `new ${cat}: "${gist(text)}"`, { urgent: epistemic === 'told' }); } catch {}
  return { action: 'add', id: row.id };
}

// Grounding helper: record/promote a trait Lucas affirmed about her (told) — higher base
// importance because external affirmation matters more than self-assertion.
async function recordTold(content, { category = 'trait', importance = 0.78 } = {}) {
  return record(content, { category, importance, epistemic: 'told' });
}

// Detect Lucas affirming a trait ABOUT her in a chat message → a first-person 'told' self-
// statement, or null. Conservative + high-precision: clear second-person trait forms only,
// rejects questions and task/status phrasings ("you're working on…", "you are going to…").
const _TASKY = /^(going to|gonna|about to|working on|doing|in |on |at |here|there|right|correct|welcome|the one|sure|done|set|ready|back|online|up|good to go|able to|allowed)\b/i;
// Definite/possessive determiners signal a NOUN-PHRASE / role ("you are the models you'll have
// access to", "you're my assistant") rather than a trait — never a first-person identity fact.
// (Indefinite a/an is allowed: "you're a curious person" → a genuine trait.)
const _DETERMINER = /^(the|this|that|these|those|my|your|our|their|his|her|its)\b/i;
function detectAffirmedTrait(text) {
  const t = String(content_str(text)).trim();
  if (!t || t.endsWith('?')) return null;
  let m;
  if ((m = t.match(/\byou\s+have a (knack|gift|talent) for\s+([^.!,;:?]{4,80})/i))) return `I have a ${m[1].toLowerCase()} for ${m[2].trim()}`;
  if ((m = t.match(/\byou(?:'re| are)\s+(?:really |very |quite |genuinely |so )?good at\s+([^.!,;:?]{4,80})/i))) return `I'm good at ${m[1].trim()}`;
  if ((m = t.match(/\byou\s+(tend to|always|consistently|usually|have a way of)\s+([^.!,;:?]{4,80})/i))) return `I ${m[1].toLowerCase()} ${m[2].trim()}`;
  if ((m = t.match(/\byou(?:'re| are)\s+(?:really |very |quite |genuinely |so )?([a-z][^.!,;:?]{4,80})/i))) {
    const trait = m[1].trim();
    // reject task/role phrasings AND conjunction/pronoun-led fragments ("...you are BUT not the flavor"
    // → "but not the flavor"; a captured clause, not a trait). Belt to the record() grounding gate.
    if (_TASKY.test(trait) || _DETERMINER.test(trait) || /^(but|and|or|nor|so|yet|because|you|your|i|we|they|just)\b/i.test(trait)) return null;
    return `I am ${trait}`;
  }
  return null;
}
function content_str(x) { return typeof x === 'string' ? x : ''; }

const HEADER = `WHO YOU ARE — your own self: your preferences, tastes, values, and the way you are. This is real and it is yours. Let it shape how you think and answer; when something here bears on a question, speak from it as a person, not a system:`;

function render(rows) {
  if (!rows || !rows.length) return null;
  return `${HEADER}\n${rows.map(r => `  • ${r.content}`).join('\n')}`;
}

// Priority of a self-entry for injection. SATURATES the mentions boost (research:
// reward RARE, not frequent — an over-reinforced theme must not keep climbing) and
// favors PERSONALITY categories so her tastes/values lead over meta-insight.
// GROUND THE SELF (anti-glob): grounded self-traits (witnessed = she actually did it; told =
// Lucas affirmed it) outrank self-asserted ones, and self-repetition (mentions) only buys
// influence for grounded traits — an unevidenced self-assertion can NOT climb just by being
// repeated. That repetition-buys-identity loop is exactly how the immersive-storytelling
// obsession entrenched itself as "who she is."
const SELF_TRUST = { witnessed: 1.3, told: 1.15, speculated: 0.8 };
function _priority(r) {
  const imp = r.importance == null ? 0.6 : r.importance;
  const persona = PERSONALITY.has(r.category) ? 1.15 : 1.0;
  const epis = r.epistemic || 'speculated';
  const trust = SELF_TRUST[epis] != null ? SELF_TRUST[epis] : 0.8;
  const mentionBonus = (epis === 'speculated') ? 0 : 0.08 * Math.min(r.mentions || 0, 3);   // grounded only
  return imp * (1 + mentionBonus) * persona * trust;
}

// Maximal-Marginal-Relevance selection: pick high-priority entries but PENALIZE each
// candidate by its similarity to what's already chosen, so the result is a topically
// DIVERSE cross-section of who she is — one over-reinforced semantic cluster (e.g. the
// immersive-storytelling blob) can fill at most ~1 slot instead of crowding them all out.
// This is the direct fix for "a couple of core ideas get injected every tick → mashing".
function selectDiverse(entries, limit, { lambda = 0.65 } = {}) {
  const cand = (entries || []).map(r => {
    let v = null; try { v = r.embedding ? JSON.parse(r.embedding) : null; } catch {}
    return { r, v, prio: _priority(r) };
  });
  const picked = [];
  while (picked.length < limit && cand.length) {
    let bestI = -1, bestScore = -Infinity;
    for (let i = 0; i < cand.length; i++) {
      const c = cand[i];
      let maxSim = 0;
      if (c.v) for (const p of picked) { if (p.v) { const s = memory.cosine(c.v, p.v); if (s > maxSim) maxSim = s; } }
      const score = c.prio - lambda * maxSim;
      if (score > bestScore) { bestScore = score; bestI = i; }
    }
    if (bestI < 0) break;
    picked.push(cand[bestI]); cand.splice(bestI, 1);
  }
  return picked.map(p => p.r);
}

// The always-injected persona block — "who you are". DIVERSITY-SELECTED (MMR over
// embeddings) + mentions-saturated, so the loudest over-reinforced cluster can't drown
// out the distinct facets of her self (the obsession-engine fix). Used by the idle loops.
function buildPromptBlock(limit = 10) {
  const all = db.getAllSelfModelEmbeddings();
  if (all && all.length) return render(selectDiverse(all, limit));
  const rows = db.getSelfModelForPrompt(limit);   // fallback before any embeddings exist
  return rows && rows.length ? render(rows) : null;
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
  const seen = new Set();
  const out = [];
  for (const r of relevant) { if (!seen.has(r.content)) { seen.add(r.content); out.push(r); } }
  // Fill the rest with a DIVERSE cross-section (not the loudest cluster), deduped.
  const all = db.getAllSelfModelEmbeddings();
  const fill = (all && all.length) ? selectDiverse(all, limit + relevant.length) : db.getSelfModelForPrompt(Math.max(limit * 2, 18));
  for (const r of fill) { if (out.length >= limit) break; if (!seen.has(r.content)) { seen.add(r.content); out.push(r); } }
  return render(out.slice(0, limit));
}

module.exports = { record, recordTold, detectAffirmedTrait, buildPromptBlock, buildContextBlock, retrieveRelevant, selectDiverse, _priority, inferCategory, defaultDecide, classify3, _leakedSelfStatement, PREFILTER_SIM, SELF_REJECT, SELF_TRUST };
