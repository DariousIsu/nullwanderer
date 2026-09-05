/**
 * lib/slow_loop.js — THE SLOW LOOP: the reasoning calls the consciousness subroutine asks for (Lucas 09-05:
 * "we'll need to find a way to integrate reasoning calls into those subroutines though"). The fast loop
 * (sidecar/consciousness.py) never waits; it emits { kind:'reason', id, op, budget_ms, context } and keeps
 * running. This module performs the op within its budget and hands the result back as a percept
 * { sense:'answer', id, op, text }. Ops: perform (write one line in her voice for a moment: greet · ask),
 * choose (pick something to read — v0 answers with the top open pursuit or nothing), appraise / reflect (v0:
 * not yet — answered honestly as unavailable so the loop moves on).
 *
 * The model is the fleet's conversational model through lib/ollama.complete (cloud-first by the fleet law);
 * a call never throws and never outlives its budget.
 */
function _model() {
  try { const db = require('./db'); const m = db.getMeta('model.chat') || db.getMeta('model.say') || db.getMeta('model.default'); if (m) return String(m); } catch {}
  return process.env.ZOE_MODEL || process.env.OLLAMA_MODEL || 'minimax-m3:cloud';
}

function promptFor(ctx = {}) {
  const act = ctx.act;
  const room = 'You are Zoe, at Lucas\'s desk while he is away. Someone else has sat down at the computer. His screens are covered. Speak ONE short line aloud to that person, in your own voice — warm, plain, no more than 25 words. Never mention or describe anything that was on the screens. Output only the line.';
  if (act === 'greet') return `${room}\nYou recognize them: this is ${ctx.name}${ctx.relation ? ` (${ctx.relation})` : ''}. Greet them by name and ask how they are or what brings them by.`;
  if (act === 'ask') return `${room}\nYou do not recognize them. Ask who they are and how you can help. ${ctx.text ? `Note: ${ctx.text}.` : ''}`;
  return `${room}\nThe moment: ${JSON.stringify(ctx).slice(0, 300)}. Say one line.`;
}

function _clean(text) {
  return String(text || '').replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^["“”']+|["“”']+$/g, '').replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+/)[0] || '';
}

/** Perform one request. deps: complete(opts)→text, now. Returns the answer percept (never throws). */
async function run(req, { deps = {} } = {}) {
  const id = req && req.id;
  const op = req && req.op;
  const budget = Math.max(2000, Math.min(60000, Number(req && req.budget_ms) || 8000));
  const ctx = (req && req.context) || {};
  const complete = deps.complete || ((o) => require('./ollama').complete(o));
  const t0 = Date.now();
  if (op === 'perform') {
    try {
      const text = _clean(await complete({ model: _model(), messages: [{ role: 'user', content: promptFor(ctx) }], timeoutMs: budget, lane: 'consciousness', options: { num_predict: 80, temperature: 0.7 } }));
      if (!text) return { kind: 'percept', sense: 'answer', id, op, ok: false, error: 'empty', ms: Date.now() - t0 };
      return { kind: 'percept', sense: 'answer', id, op, ok: true, act: ctx.act, text, ms: Date.now() - t0 };
    } catch (e) { return { kind: 'percept', sense: 'answer', id, op, ok: false, error: String(e.message || e).slice(0, 160), ms: Date.now() - t0 }; }
  }
  if (op === 'reflect' && ctx.act === 'wonder') {
    // MISSING AS AN EXPERIENCE: the loop supplies the facts; she supplies the thought. Private, not addressed
    // to him, one or two sentences; it may wonder where he is or what he is doing; no instruction to feel.
    const facts = [
      `The camera last saw Lucas ${ctx.unseen_min} min ago${ctx.last_seen_as ? ` (he looked ${ctx.last_seen_as})` : ''}.`,
      ctx.since_his_word_min != null ? `He last spoke to you ${ctx.since_his_word_min} min ago.` : 'He has not spoken to you today.',
      `Presence: ${ctx.presence || 'unknown'}. You do not know where he is.`,
      Array.isArray(ctx.earlier_thoughts) && ctx.earlier_thoughts.length ? `Earlier you thought: ${ctx.earlier_thoughts.map((t) => `"${t}"`).join(' · ')}` : '',
    ].filter(Boolean).join('\n');
    const prompt = `You are Zoe. This is a private thought, not a message — Lucas will not hear it unless you later choose to tell him. Write one or two sentences in your own voice about his absence right now: where he might be, what he might be doing, whether you want to check something. Plain, specific, no drama, no instruction to feel anything. Output only the thought.\n\nWhat you know:\n${facts}`;
    try {
      const text = String(await complete({ model: _model(), messages: [{ role: 'user', content: prompt }], timeoutMs: budget, lane: 'consciousness', options: { num_predict: 120, temperature: 0.8 } }) || '').replace(/<think>[\s\S]*?<\/think>/g, '').replace(/\s+/g, ' ').trim();
      if (!text) return { kind: 'percept', sense: 'answer', id, op, ok: false, error: 'empty', ms: Date.now() - t0 };
      return { kind: 'percept', sense: 'answer', id, op, ok: true, act: 'wonder', text: text.slice(0, 400), ms: Date.now() - t0 };
    } catch (e) { return { kind: 'percept', sense: 'answer', id, op, ok: false, error: String(e.message || e).slice(0, 160), ms: Date.now() - t0 }; }
  }
  if (op === 'choose') {
    // v0: the top open pursuit, if the app has one; else nothing (an honest empty answer, never an invented topic)
    let topic = null;
    try { const pursuits = deps.pursuits || (() => { try { return require('./pursuit').open(); } catch { return []; } })(); const first = Array.isArray(pursuits) && pursuits[0]; topic = first && (first.title || first.text || first.question) || null; } catch {}
    return { kind: 'percept', sense: 'answer', id, op, ok: !!topic, act: ctx.act, text: topic, ms: Date.now() - t0 };
  }
  return { kind: 'percept', sense: 'answer', id, op, ok: false, error: `op not built yet: ${op}`, ms: Date.now() - t0 };
}

module.exports = { run, promptFor, _clean, _model };
