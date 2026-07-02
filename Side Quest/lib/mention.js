/**
 * lib/mention.js — the tiered mention→object front door: "what entity is this turn about?"
 *
 * Replaces the brittle regex that mis-read "Who is Donald Trump?" as the entity "Who" (→ a lobby firm),
 * which starved the object-memory pull. Two tiers, cheapest-sufficient-first (RAGate-style selective
 * escalation):
 *
 *   TIER 1 — local NER (lib/ner, bert-base-NER on the in-process WASM runtime): explicit cased
 *            person/org/place at ~5 ms, no cloud, no GPU. Handles the common "Who is X?" case.
 *   TIER 2 — cloud `decompose` (lib/intake): casing-robust + pronoun/anaphora + KG-specific types
 *            (bill/committee/government_body). Fires ONLY when tier 1 finds nothing, so most turns
 *            never pay the cloud round-trip.
 *
 * (A future TIER-1.5 GLiNER for local zero-shot KG types was deferred — the `gliner` npm package had a
 * broken onnxruntime-web dependency; the cloud tier covers its cases today.)
 *
 * Returns { mention, kgType, source } or null. The caller (active_recall) keeps a robust regex as a
 * tier-3 fallback for when BOTH the NER model and the cloud are unavailable. Never throws.
 */
const ner = require('./ner');

// Escalate a tier-1 miss to the cloud unless it's plainly not worth a round-trip (empty / too short).
// Kept deliberately permissive for v1 — the escalation predicate is the main knob the tuning harness
// (scripts/tune_mention.js) dials in; over-escalation only costs a cached, budgeted fast-model call.
function _shouldEscalate(text) {
  const t = String(text || '').trim();
  if (t.length < 6) return false;
  return true;
}

// CONVERSATIONAL COREFERENCE — bind a bare partial name to the fuller name just used in the dialogue.
// The break this fixes: "who are his cabinet? → Lee Zeldin, Ryan Zinke…" then "what does Lee do?" —
// NER tags the bare surname "Lee", and a prominence-ranked FTS resolve returns Curt Lee (a lobbyist) /
// Mike Lee (a senator), NOT the Lee Zeldin we were just discussing. Anaphora against the recent turns is
// exactly what makes a conversation flow through the graph. Deterministic, most-recent-wins: only fires
// when the mention is a single name-token that is a component of a multi-token proper name in context.
// Returns the fuller name, or null when there's no such antecedent (leave the mention untouched).
const _PROPER_NAME_RE = /\b[A-Z][A-Za-z.'’\-]+(?:\s+[A-Z][A-Za-z.'’\-]+)+\b/g;
function _expandFromContext(mention, context) {
  const m = String(mention || '').trim();
  const ctx = String(context || '');
  if (m.length < 2 || /\s/.test(m) || !ctx) return null;   // multi-word mention isn't a partial → skip
  const low = m.toLowerCase().replace(/[.,]+$/, '');
  const names = ctx.match(_PROPER_NAME_RE) || [];
  let hit = null;   // context is oldest→newest, so the LAST matching full name is the most recent antecedent
  for (const name of names) {
    const toks = name.split(/\s+/);
    if (toks.length < 2) continue;
    if (toks.some(tk => tk.toLowerCase().replace(/[.,]+$/, '') === low)) hit = name;
  }
  return (hit && hit.toLowerCase() !== m.toLowerCase()) ? hit : null;
}

// Pick the single object to look up from a decompose plan: the salient resolve target first, then any
// resolve target, then the first object. Mirrors intake.salientTargets' intent for a single-pull turn.
function _pickObject(plan) {
  const objs = (plan && Array.isArray(plan.objects)) ? plan.objects : [];
  if (!objs.length) return null;
  return objs.find(o => o.salient && o.op === 'resolve')
      || objs.find(o => o.op === 'resolve')
      || objs.find(o => o.salient)
      || objs[0];
}

// Detect the salient entity mention (+ its KG type) for the object pull. context = recent turns (helps
// the cloud tier resolve pronouns/anaphora). deps.noCloud forces local-only (offline / budget-guard).
async function detectMention(text, { context = '', deps = {} } = {}) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return null;

  let result = null;

  // TIER 1 — local NER
  try {
    const top = await ner.topMention(t);
    if (top && top.mention) result = { mention: top.mention, kgType: top.kgType || null, score: top.score, source: 'ner' };
  } catch (e) { /* fall through to cloud */ }

  // TIER 2 — cloud decompose (selective)
  if (!result && !deps.noCloud && _shouldEscalate(t)) {
    try {
      const intake = require('./intake');
      const raw = await intake.decompose(t, { recent: String(context || '').slice(0, 400), deps });
      const plan = intake.routeDecomposition(raw);
      const obj = _pickObject(plan);
      if (obj && obj.mention) result = { mention: obj.mention, kgType: obj.type || null, source: 'decompose' };
    } catch (e) { /* fall through → null */ }
  }

  if (!result) return null;

  // COREFERENCE — expand a bare surname/given-name to the fuller name just used in the conversation, so
  // the object-pull resolves the person we're actually discussing ("Lee" → "Lee Zeldin"), not a
  // prominence-ranked stranger. Applied to BOTH tiers; tier-1 NER never saw `context` on its own.
  const expanded = _expandFromContext(result.mention, context);
  if (expanded) { result.mention = expanded; result.source += '+ctx'; }

  return result;
}

module.exports = { detectMention, _shouldEscalate, _pickObject, _expandFromContext };
