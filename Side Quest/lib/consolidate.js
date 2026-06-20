/**
 * Memory consolidation — the "extract-then-update" best-practice, ported from
 * Mem0 (docs.mem0.ai + arXiv:2504.19413) and LangMem's precision/recall guidance.
 *
 * The gap it fixes: the goal extractor APPENDED (only an exact-string dedup), so
 * 27 goals accumulated that are the SAME INTENT in different words (~10 writing,
 * ~8 computer-access, ~3 email). bge-small at a safe threshold sees them as
 * distinct, so similarity alone can't merge them — Mem0's answer is to let a small
 * LLM make the ADD / UPDATE / NOOP decision against the semantically-nearest
 * existing items. Two consumers:
 *   • the EXTRACTOR — per new candidate goal: ADD only if genuinely new, else skip.
 *   • the CONSOLIDATION pass — fold the existing sprawl into umbrella parents.
 *
 * Dependency-injected (embedFn / classifyFn) so the logic is unit-testable offline
 * without the embedder or the model. Production passes the real bge-small + Ollama.
 */

const db = require('./db');
const memory = require('./memory');
const { streamChat } = require('./ollama');
const config = require('./config');

const MODEL = config.model();
const SIM_FLOOR = 0.55;   // below this, no LLM call — auto-ADD (clearly unrelated)

// --- the LLM decision (Mem0 UPDATE_MEMORY_PROMPT, adapted to GOALS) ------------
// Given a candidate goal and the nearest existing goals, decide ONE action.
// Returns { action: 'ADD'|'NOOP', targetId? }. NOOP means "same intent as an
// existing goal — don't add a duplicate" (covers Mem0's UPDATE+NOOP for our use:
// we keep the existing canonical rather than spawning a near-twin).
async function classifyGoal(candidate, similar) {
  if (!similar || similar.length === 0) return { action: 'ADD' };
  const list = similar.map(s => `[id ${s.id}] ${s.content}`).join('\n');
  const messages = [{
    role: 'user',
    content: `You manage a list of an assistant's standing GOALS and must avoid near-duplicates that say the same thing in different words.

Existing goals most similar to a new candidate:
${list}

Candidate goal: "${candidate}"

Decide ONE action:
- ADD  → the candidate is a genuinely NEW objective not already covered above.
- NOOP → the candidate is the SAME underlying objective as one above (same intent, even if worded differently); keep the existing one, don't duplicate.

Reply with ONLY strict JSON: {"action":"ADD"} or {"action":"NOOP","target_id":<id>}`
  }];
  let raw = '';
  try {
    // num_ctx pinned to 8192 to match all other call sites — a different ctx
    // forces a full model reload (mixed-ctx thrash) on the single-GPU setup.
    await streamChat({ model: MODEL, messages, options: { temperature: 0, top_p: 1, num_ctx: 8192, num_predict: 24 }, onToken: (t) => { raw += t; } });
  } catch (e) {
    console.error('[consolidate] classify call failed:', e.message);
    return { action: 'ADD' }; // fail-open: when unsure, keep the goal (recall > precision)
  }
  return parseDecision(raw);
}

function parseDecision(raw) {
  if (!raw) return { action: 'ADD' };
  const m = raw.match(/\{[\s\S]*?\}/);
  if (!m) return { action: 'ADD' };
  try {
    const o = JSON.parse(m[0]);
    const action = String(o.action || '').toUpperCase() === 'NOOP' ? 'NOOP' : 'ADD';
    const targetId = o.target_id != null ? parseInt(o.target_id, 10) : null;
    return action === 'NOOP' && targetId ? { action: 'NOOP', targetId } : { action: 'ADD' };
  } catch { return { action: 'ADD' }; }
}

// Rank `pool` threads by cosine similarity to `text`. embedFn(text)→vector (async).
// Returns [{ id, content, sim }] for sims ≥ floor, best first, capped at `limit`.
async function similarThreads(text, pool, { embedFn = memory.embed, limit = 5, floor = SIM_FLOOR } = {}) {
  let qv = null;
  try { qv = await embedFn(text); } catch { qv = null; }
  if (!qv) return [];
  const scored = [];
  for (const t of pool) {
    let v = null;
    try { v = await embedFn(t.content); } catch { v = null; }
    if (!v) continue;
    const sim = memory.cosine(qv, v);
    if (sim >= floor) scored.push({ id: t.id, content: t.content, sim });
  }
  scored.sort((a, b) => b.sim - a.sim);
  return scored.slice(0, limit);
}

/**
 * EXTRACTOR decision for a single candidate goal: ADD (insert) or NOOP (skip,
 * it's an intent-duplicate of an existing active thread). Pure decision — does NOT
 * write. embedFn/classifyFn injectable for tests.
 */
async function decideForCandidate(candidate, { embedFn = memory.embed, classifyFn = classifyGoal } = {}) {
  const active = db.getActiveOpenThreads(50);
  if (active.length === 0) return { action: 'ADD' };
  const similar = await similarThreads(candidate, active, { embedFn });
  if (similar.length === 0) return { action: 'ADD' };
  return classifyFn(candidate, similar);
}

/**
 * CONSOLIDATION pass over existing active threads. Greedy single pass: each thread
 * is compared to the canonicals kept so far; ADD → it becomes a canonical, NOOP →
 * it's merged into the matched canonical (db.mergeOpenThread). Canonicals are
 * preferred by action_count (most-worked = the umbrella), then age.
 *
 *   apply=false → DRY RUN: returns the plan, writes nothing.
 *   apply=true  → performs the merges.
 * Returns { kept:[{id,content}], merges:[{childId,parentId,childContent,parentContent}] }.
 */
async function consolidateThreads({ apply = false, embedFn = memory.embed, classifyFn = classifyGoal } = {}) {
  const active = db.getActiveOpenThreads(200)
    .slice()
    .sort((a, b) => (b.action_count || 0) - (a.action_count || 0) || (a.created_ts || 0) - (b.created_ts || 0));

  const kept = [];        // [{ id, content, vec }]
  const merges = [];
  for (const t of active) {
    let vec = null;
    try { vec = await embedFn(t.content); } catch { vec = null; }
    // nearest kept canonical by embedding
    let near = [];
    if (vec) {
      near = kept
        .map(k => ({ id: k.id, content: k.content, sim: k.vec ? memory.cosine(vec, k.vec) : 0 }))
        .filter(x => x.sim >= SIM_FLOOR)
        .sort((a, b) => b.sim - a.sim)
        .slice(0, 5);
    }
    let decision = { action: 'ADD' };
    if (near.length > 0) decision = await classifyFn(t.content, near);

    if (decision.action === 'NOOP' && decision.targetId && kept.some(k => k.id === decision.targetId)) {
      const parent = kept.find(k => k.id === decision.targetId);
      merges.push({ childId: t.id, parentId: decision.targetId, childContent: t.content, parentContent: parent.content });
      if (apply) { try { db.mergeOpenThread(t.id, decision.targetId, { reason: 'consolidation: same-intent umbrella' }); } catch (e) { console.error('[consolidate] merge failed:', e.message); } }
    } else {
      kept.push({ id: t.id, content: t.content, vec });
    }
  }
  return { kept: kept.map(k => ({ id: k.id, content: k.content })), merges };
}

module.exports = { classifyGoal, parseDecision, similarThreads, decideForCandidate, consolidateThreads, SIM_FLOOR };
