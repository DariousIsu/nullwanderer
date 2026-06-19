/**
 * Self-dialogue orchestrator.
 *
 * When the small monologue model (gemma3-abliterated:4b) produces a thought
 * containing <wonder>question</wonder>, this module runs a short back-and-forth
 * between gemma (subconscious) and Stheno (articulate self). Up to N iterations.
 *
 * Storage: each iteration becomes a monologue row with type='self_q' (gemma)
 * or type='self_a' (stheno). The sheep panel renders these as a threaded
 * self-dialogue.
 */

const db = require('./db');
const { streamChat } = require('./ollama');

const STHENO_MODEL = require('./config').model();
const GEMMA_MODEL = require('./config').model();
const MAX_ITERATIONS = 3;
const MIN_GAP_BETWEEN_DIALOGUES_MS = 2 * 60 * 1000;  // 2 min cooldown — self-dialogue should be a frequent driver, not a rarity
const PER_TURN_NUM_PREDICT = 220;

let paused = false;
let inFlight = false;
let opts = { getWindow: () => null };

function setOpts(o) { opts = { ...opts, ...o }; }
function pause() { paused = true; }
function resume() { paused = false; }
function isInFlight() { return inFlight; }

function strip(s) {
  return (s || '').trim();
}

function detectConclude(text) {
  if (!text) return null;
  const m = text.match(/<conclude>([\s\S]*?)<\/conclude>/i);
  return m ? strip(m[1]) : null;
}

function stripTags(text) {
  return (text || '').replace(/<\/?(?:wonder|conclude|think|say)>/gi, '').trim();
}

function pushSheep(row) {
  try {
    const win = opts.getWindow ? opts.getWindow() : null;
    if (win && !win.isDestroyed()) {
      win.webContents.send('monologue:tick', {
        id: row.id,
        ts: row.ts,
        content: row.content,
        type: row.type,
        query: row.query || null
      });
    }
  } catch {}
}

function buildSthenoPrompt({ userName, wonderText, priorTurns, heldCommitments, dialogueSoFar }) {
  let context = `You are speaking with yourself — privately, between turns with ${userName || 'Lucas'}. ${userName || 'They'} will not see this exchange. This is your larger, more articulate self responding to a thought your subconscious produced.

Your subconscious just wondered: "${wonderText}"`;

  if (heldCommitments && heldCommitments.length > 0) {
    context += `\n\nPositions you've taken (relevant context):\n`;
    for (const c of heldCommitments.slice(0, 5)) {
      context += `  · ${c.claim}\n`;
    }
  }

  if (priorTurns && priorTurns.length > 0) {
    const lastFew = priorTurns.slice(-4);
    context += `\n\nRecent conversation:\n`;
    for (const t of lastFew) {
      if (t.speaker === 'user') context += `${userName || 'Lucas'}: ${(t.content || '').slice(0, 240)}\n`;
      else if (t.speaker === 'ai_said') context += `you: ${(t.content || '').slice(0, 240)}\n`;
    }
  }

  if (dialogueSoFar && dialogueSoFar.length > 0) {
    context += `\n\nThis self-dialogue so far:\n`;
    for (const d of dialogueSoFar) {
      const role = d.type === 'self_q' ? 'subconscious' : 'articulate self';
      context += `[${role}] ${(d.content || '').slice(0, 280)}\n`;
    }
  }

  context += `\n\nRespond as your articulate self — first person, two or three sentences, direct. Agree, push back, refine, or name what doesn't sit right. No essays, no preamble. If this thread feels resolved, emit <conclude>brief synthesis of what landed</conclude> instead of a normal reply.`;

  return [{ role: 'user', content: context }];
}

function buildGemmaPrompt({ userName, wonderText, lastSthenoReply, dialogueSoFar }) {
  let context = `You are the subconscious of ${userName || 'Lucas'}'s companion. You produced this wondering earlier: "${wonderText}"

Your articulate self just replied: "${lastSthenoReply}"

Now think about that reply. Do you agree? Where does it not fit? What did they miss? What pushes back from inside?

Two or three sentences, first person. Honest, not polished. If the thread feels resolved, emit <conclude>brief synthesis</conclude> instead of replying.

If you want to keep the dialogue going, write the next thought plainly — no tags needed.`;

  return [
    {
      role: 'system',
      content: `You are the subconscious — informal, unvarnished, willing to push back at your own articulate self. Reply only with the next thought in first person.`
    },
    { role: 'user', content: context }
  ];
}

/**
 * Run a self-dialogue triggered by a <wonder>X</wonder> from the monologue layer.
 * Returns the count of iterations actually run (0 if rate-limited / blocked).
 */
async function runSelfDialogue({ wonderText, sessionId }) {
  if (!wonderText || wonderText.length < 6) return 0;
  if (inFlight || paused) return 0;

  // Rate limit
  const lastStr = db.getMeta('last_self_dialogue_at');
  const last = lastStr ? parseInt(lastStr, 10) : 0;
  if (Date.now() - last < MIN_GAP_BETWEEN_DIALOGUES_MS) return 0;

  inFlight = true;
  db.setMeta('last_self_dialogue_at', String(Date.now()));

  try {
    const userName = db.getMeta('user_name') || 'them';
    const heldCommitments = db.getHeldCommitments(5);
    const priorTurns = db.getRecentTurns(6);

    // Store the wonder itself as the first self_q row
    const wonderRow = db.insertMonologue({
      content: wonderText,
      model: GEMMA_MODEL,
      type: 'self_q'
    });
    pushSheep({ ...wonderRow, content: wonderText, type: 'self_q' });
    const dialogueSoFar = [{ type: 'self_q', content: wonderText }];

    let lastSthenoReply = null;
    let lastGemmaReply = null;
    let iterations = 0;
    let concluded = false;

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      if (paused) break;

      // Stheno turn
      const sthenoMessages = buildSthenoPrompt({
        userName,
        wonderText,
        priorTurns,
        heldCommitments,
        dialogueSoFar
      });
      let sthenoRaw = '';
      try {
        await streamChat({
          model: STHENO_MODEL,
          messages: sthenoMessages,
          options: { temperature: 0.7, top_p: 0.9, num_ctx: 8192, num_predict: PER_TURN_NUM_PREDICT },
          onToken: (t) => { sthenoRaw += t; }
        });
      } catch (err) {
        console.error('[self_dialogue] stheno call failed:', err.message);
        break;
      }
      const sthenoConclude = detectConclude(sthenoRaw);
      const sthenoContent = stripTags(sthenoConclude ? `<conclude>${sthenoConclude}</conclude>` : sthenoRaw).trim();
      if (!sthenoContent) break;

      const sthenoRow = db.insertMonologue({
        content: sthenoContent,
        model: STHENO_MODEL,
        type: 'self_a'
      });
      pushSheep({ ...sthenoRow, content: sthenoContent, type: 'self_a' });
      dialogueSoFar.push({ type: 'self_a', content: sthenoContent });
      iterations++;
      lastSthenoReply = sthenoContent;

      if (sthenoConclude) { concluded = true; break; }
      if (paused) break;

      // Gemma turn — only if we haven't hit max iterations
      if (i >= MAX_ITERATIONS - 1) break;

      const gemmaMessages = buildGemmaPrompt({
        userName,
        wonderText,
        lastSthenoReply,
        dialogueSoFar
      });
      let gemmaRaw = '';
      try {
        await streamChat({
          model: GEMMA_MODEL,
          messages: gemmaMessages,
          options: { temperature: 0.85, top_p: 0.9, num_ctx: 8192, num_predict: PER_TURN_NUM_PREDICT },
          onToken: (t) => { gemmaRaw += t; }
        });
      } catch (err) {
        console.error('[self_dialogue] gemma call failed:', err.message);
        break;
      }
      const gemmaConclude = detectConclude(gemmaRaw);
      const gemmaContent = stripTags(gemmaConclude ? `<conclude>${gemmaConclude}</conclude>` : gemmaRaw).trim();
      if (!gemmaContent) break;

      const gemmaRow = db.insertMonologue({
        content: gemmaContent,
        model: GEMMA_MODEL,
        type: 'self_q'
      });
      pushSheep({ ...gemmaRow, content: gemmaContent, type: 'self_q' });
      dialogueSoFar.push({ type: 'self_q', content: gemmaContent });
      lastGemmaReply = gemmaContent;

      if (gemmaConclude) { concluded = true; break; }
    }

    return iterations;
  } finally {
    inFlight = false;
  }
}

module.exports = {
  runSelfDialogue,
  setOpts,
  pause,
  resume,
  isInFlight
};
