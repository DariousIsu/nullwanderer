/**
 * Running conversation-state summary — Piece 3 of the conversation harness.
 *
 * A compact, incrementally-updated "where we are now" summary of the LIVE conversation
 * (recursive summarization, Wang et al. 2023, arXiv:2308.15022). After each exchange it
 * folds the latest turn into the prior summary (old + new → new), so the conversation's
 * ARC is carried in ~120 words even after the raw turns scroll out of the 14-turn recency
 * window. This is what keeps her on-thread over a long exchange — and the substrate the
 * future voice gate depends on, where there's no scrollback to lean on.
 *
 * Scaffolding, not asked of the model on the hot path: the update runs ASYNC after her
 * reply is sent (non-blocking, one cheap bounded call), and the result is injected next turn.
 * See docs/CONVERSATION_HARNESS.md.
 */
const db = require('./db');
const { streamChat } = require('./ollama');
const config = require('./config');

const MAX_WORDS = 120;

async function _modelGenerate(messages) {
  let out = '';
  await streamChat({
    model: config.extractionModel(),
    messages,
    options: { temperature: 0.2, top_p: 0.9, num_ctx: 8192, num_predict: 200 },
    onToken: (t) => { out += t; }
  });
  return out.trim();
}

// Fold the latest exchange into the running summary. Call AFTER the reply is sent (async,
// non-blocking). `generate` is injectable so the smoke can run model-free + deterministic.
//
// WATERMARK-DRIVEN, not caller-driven. This used to fold exactly the (userMsg, aiSay) it was handed,
// from the single main say path — but the chat handler has ~30 early returns that reply and return
// before reaching that call (protocol intercept, preference answer, contacts route, tool followups,
// deep/swarm verbs). Everything they said was silently never folded. Measured 2026-07-20:
//
//   session 589 — 247 real turns, turn_count 15        sessions of 116 / 88 / 81 turns — NO summary
//
// So the fold now reads what it has NOT yet seen (turns newer than `last_turn_id`) and catches up,
// which makes it correct no matter which path produced the reply, and self-healing over a backlog.
// The passed-in userMsg/aiSay are still honoured as a hint when there is no watermark yet.
// One fold per session at a time. The fold is now triggered from TWO places — after a reply on the
// main path, and at the start of a turn to catch up whatever the early-return paths skipped — so
// without this both could read the same watermark and summarise the same turns twice.
const _inFlight = new Set();

async function update(sessionId, userMsg, aiSay, { generate = _modelGenerate } = {}) {
  if (sessionId && _inFlight.has(sessionId)) return null;
  if (sessionId) _inFlight.add(sessionId);
  try {
    if (!sessionId) return null;
    const prev = db.getConversationState(sessionId);
    const watermark = (prev && prev.last_turn_id) || 0;
    let pending = [];
    try { pending = db.unfoldedTurns(sessionId, watermark) || []; } catch { pending = []; }
    // Nothing unfolded and nothing handed in → nothing to do.
    if (!pending.length && !(userMsg || aiSay)) return null;
    const old = (prev && prev.summary) ? prev.summary : '(none yet — this is the start of the conversation)';
    // Prefer the real unfolded turns; fall back to the hint the caller passed (first fold of a
    // session, before any turn rows exist for it).
    const exchange = pending.length
      ? pending.map(t => `${t.speaker === 'user' ? 'Lucas' : 'You (Zoe)'}: ${String(t.content || '').slice(0, 700)}`).join('\n')
      : `Lucas: ${(userMsg || '').slice(0, 1200)}\nYou (Zoe): ${(aiSay || '').slice(0, 1200)}`;
    const label = pending.length > 2 ? `EXCHANGES SINCE YOUR LAST NOTE (${pending.length} turns)` : 'LATEST EXCHANGE';
    const messages = [
      { role: 'system', content: `You keep a terse running summary of your ongoing conversation with Lucas — private notes to yourself so you never lose the thread. You are Zoe; he is Lucas.` },
      { role: 'user', content: `Update the running summary with the exchange(s) below. Keep it UNDER ${MAX_WORDS} words. Capture what you've discussed, concrete facts Lucas shared (about himself, his life, his work), and where the conversation is right now. Write terse notes ("Lucas mentioned…", "we're on…"). Do NOT invent anything not present in the exchange or prior summary. Output ONLY the updated summary, no preamble.\n\nCURRENT SUMMARY:\n${old}\n\n${label}:\n${exchange}` }
    ];
    let summary = await generate(messages);
    if (!summary) return null;
    summary = summary.replace(/^\s*(updated\s+summary|summary)\s*:?\s*/i, '').trim().slice(0, 1500);
    if (!summary) return null;
    // Advance the watermark to the last turn we actually folded. Only on success — a failed
    // generate must leave the watermark alone so the next fold retries the same turns rather
    // than skipping them.
    const newWatermark = pending.length ? pending[pending.length - 1].id : null;
    db.upsertConversationState(sessionId, summary, null, newWatermark);
    return summary;
  } catch (e) { console.error('[convo_state] update failed:', e.message); return null; }
  finally { if (sessionId) _inFlight.delete(sessionId); }
}

// The labeled "where we are now" block for the chat prompt (null until a summary exists).
function buildBlock(sessionId, userName) {
  try {
    const row = db.getConversationState(sessionId);
    if (!row || !row.summary) return null;
    return `WHERE THIS CONVERSATION IS — your running memory of the thread you're on with ${userName || 'Lucas'} (this is what you've actually talked about; stay consistent with it, don't contradict or re-introduce it):\n${row.summary}`;
  } catch { return null; }
}

module.exports = { update, buildBlock, MAX_WORDS };
