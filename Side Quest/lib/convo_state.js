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
    model: config.model(),
    messages,
    options: { temperature: 0.2, top_p: 0.9, num_ctx: 8192, num_predict: 200 },
    onToken: (t) => { out += t; }
  });
  return out.trim();
}

// Fold the latest exchange into the running summary. Call AFTER the reply is sent (async,
// non-blocking). `generate` is injectable so the smoke can run model-free + deterministic.
async function update(sessionId, userMsg, aiSay, { generate = _modelGenerate } = {}) {
  try {
    if (!sessionId || !(userMsg || aiSay)) return null;
    const prev = db.getConversationState(sessionId);
    const old = (prev && prev.summary) ? prev.summary : '(none yet — this is the start of the conversation)';
    const messages = [
      { role: 'system', content: `You keep a terse running summary of your ongoing conversation with Lucas — private notes to yourself so you never lose the thread. You are Zoe; he is Lucas.` },
      { role: 'user', content: `Update the running summary with the latest exchange below. Keep it UNDER ${MAX_WORDS} words. Capture what you've discussed, concrete facts Lucas shared (about himself, his life, his work), and where the conversation is right now. Write terse notes ("Lucas mentioned…", "we're on…"). Do NOT invent anything not present in the exchange or prior summary. Output ONLY the updated summary, no preamble.\n\nCURRENT SUMMARY:\n${old}\n\nLATEST EXCHANGE:\nLucas: ${(userMsg || '').slice(0, 1200)}\nYou (Zoe): ${(aiSay || '').slice(0, 1200)}` }
    ];
    let summary = await generate(messages);
    if (!summary) return null;
    summary = summary.replace(/^\s*(updated\s+summary|summary)\s*:?\s*/i, '').trim().slice(0, 1500);
    if (!summary) return null;
    db.upsertConversationState(sessionId, summary, null);
    return summary;
  } catch (e) { console.error('[convo_state] update failed:', e.message); return null; }
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
