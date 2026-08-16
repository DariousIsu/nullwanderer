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

  // SELF/OWNER GUARD (2026-07-10): the operator addressing Zoe by name ("Hey Zo", "Zoe, …") or referring to
  // himself ("what is MY name / what office did I run for") is NOT a civic entity to look up. Suppress the
  // mention so the turn answers from self/owner knowledge instead of disambiguating her own name — or his —
  // among same-name civic records (the "which Zoe / which Z do you mean?" failure). Only bare self/owner names
  // match (isSelfName/isOwnerName are exact-alias), so a real "Zoe Halfmann" / "Lucas Smith" is untouched.
  //
  // ⚠️ Suppression returns { mention: null, self: true } — NOT a bare null. Returning null made this
  // guard CAUSE the failure it was written to prevent: the caller reads null as "no mention found" and
  // falls through to its regex fallback, which grabs the leading capitalized run — so "Hey Zoe, what are
  // the laws of thermodynamics…" suppressed "Zoe" here and then resolved "HEY ZOE" instead, hit four
  // civic Zoes, and asked Lucas which one he meant instead of answering (live, 2026-07-20). The flag
  // lets the caller tell "nothing to look up" apart from "deliberately not looking this up".
  try {
    const db = require('./db');
    const m = result.mention || '';
    // a bare initial ("Z" from "Hey Zo") is never a civic entity — suppress it before it disambiguates junk
    if (m.replace(/[^a-zA-Z0-9]/g, '').length <= 1) return { mention: null, self: true, source: 'self-guard' };
    if (db.isSelfName(m) || db.isOwnerName(m) || db.isPeerName(m)) return { mention: null, self: true, source: 'self-guard' };
  } catch { /* db not ready → leave mention as-is */ }

  return result;
}

// Is this mention just Zoe or Lucas being ADDRESSED or INTRODUCING THEMSELVES — lead-in, punctuation
// and all?
//
// db.isSelfName/isOwnerName are exact-alias by design (so a real "Zoe Halfmann" still resolves), which
// means they miss the forms people actually write. Strip the lead-in and trailing punctuation, then
// defer to the exact-alias check — a SUPERSTRING like "Zoe Lofgren" keeps its extra name token and
// correctly does NOT match, so every civic namesake stays reachable.
//
// TWO FAMILIES, both seen live on 2026-07-20:
//   VOCATIVE   "Hey Zoe, what are the laws of thermodynamics…"  → resolved "Hey Zoe" → 4 civic Zoes
//   SELF-INTRO "I'm Zoe Lane…"                                  → resolved "I'm Zoe Lane" → same
// The second is her introducing herself and being told she might be a US Representative. Any lead-in
// that is not part of a name has to come off before the alias check, or every new phrasing is a new
// bug — which is precisely how the vocative fix shipped and then missed this one hours later.
const _GREETING_RE = /^(?:hey|hi|hello|yo|hiya|heya|ok|okay|so|um|uh|well|good\s+(?:morning|afternoon|evening)|hey\s+there)[\s,]+/i;
// Self-identification lead-ins: "I'm X", "I am X", "this is X", "my name is X", "it's X", "call me X".
const _INTRO_RE = /^(?:i'?m|i\s+am|im|this\s+is|that'?s|it'?s|my\s+name\s+is|name'?s|call\s+me|you'?re|your\s+name\s+is)[\s,]+/i;

function isVocativeSelf(mention, deps = {}) {
  let m = String(mention || '').trim();
  if (!m) return false;
  // Loop over BOTH families so stacked lead-ins peel ("Hey, I'm Zoe Lane" → "Zoe Lane").
  let prev = null;
  while (m !== prev) {
    prev = m;
    m = m.replace(_GREETING_RE, '').replace(_INTRO_RE, '').trim();
  }
  m = m.replace(/^[^A-Za-z0-9]+/, '').replace(/[^A-Za-z0-9.'’\-]+$/, '').trim();
  if (!m) return false;
  try {
    const db = deps.db || require('./db');
    return !!(db.isSelfName(m) || db.isOwnerName(m) || db.isPeerName(m));
  } catch { return false; }
}

module.exports = { detectMention, isVocativeSelf, _shouldEscalate, _pickObject, _expandFromContext, _GREETING_RE, _INTRO_RE };
