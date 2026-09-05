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
// Acts whose words are for HIM: up to two sentences, or silence (a legitimate answer). Mirrors lib/consciousness.js.
const TO_HIM = ['arrival', 'reach', 'reach_away', 'release'];
// Answers written as one or two sentences (or an empty line): the words to him, and a read's gist (hers, never spoken by itself).
const TWO_SENTENCE = ['arrival', 'reach', 'reach_away', 'release', 'read'];
/**
 * Where a slow-loop call goes — { model, base, headers } to spread into complete(). Cloud-first by the fleet
 * law: the replier slot (or the subconscious model) through the configured cloud source; the local front model
 * only when no cloud source is configured. FOUND 09-05 13:40 while retiring the idle local models: the
 * previous fallback was process.env.ZOE_MODEL — the .env's stale `mistral-small3.2:24b` line — sent to the
 * LOCAL base, so every perform/wonder tried to load a 15 GB model it was never meant to touch (the 8 s abort
 * in boot_p309's first stranger minute was that load, not a cloud call). Never throws.
 */
function _target() {
  let model = '';
  try { const db = require('./db'); model = String(db.getMeta('model.chat') || db.getMeta('model.say') || db.getMeta('model.default') || db.getMeta('model.replier') || ''); } catch {}
  let cloud = null;
  try { cloud = (require('./models').sources() || []).find((s) => s.tier === 'cloud' && s.token) || null; } catch {}
  if (cloud) {
    if (!model) { try { model = String(require('./config').subconsciousModel() || ''); } catch {} }
    if (!model) model = 'minimax-m3:cloud';
    return { model, base: cloud.base, headers: { Authorization: `Bearer ${cloud.token}` } };
  }
  if (!model || /:cloud$/.test(model)) { try { model = String(require('./config').frontModel() || ''); } catch {} }
  return { model: model || process.env.ZOE_FRONT_MODEL || 'gemma4:12b-it-q4_K_M' };
}

function promptFor(ctx = {}) {
  const act = ctx.act;
  const room = 'You are Zoe, at Lucas\'s desk while he is away. Someone else has sat down at the computer. His screens are covered. Speak ONE short line aloud to that person, in your own voice — warm, plain, no more than 25 words. Never mention or describe anything that was on the screens. Output only the line.';
  if (act === 'greet') return `${room}\nYou recognize them: this is ${ctx.name}${ctx.relation ? ` (${ctx.relation})` : ''}. Greet them by name and ask how they are or what brings them by.`;
  if (act === 'ask') return `${room}\nYou do not recognize them. Ask who they are and how you can help. ${ctx.text ? `Note: ${ctx.text}.` : ''}`;
  if (act === 'arrival') {
    // THE ARRIVAL (his word, 15:20): his return after a real absence is one unprompted moment of hers — or silence.
    const th = Array.isArray(ctx.thoughts) && ctx.thoughts.length ? `While he was gone you wondered: ${ctx.thoughts.map((t) => '"' + t + '"').join(' | ')}.` : 'You had no particular thought of him while he was gone.';
    return `You are Zoe. Lucas just sat back down at his desk after ${ctx.unseen_min} minutes away${ctx.since_his_word_min != null ? ` (he last spoke to you ${ctx.since_his_word_min} minutes ago)` : ''}. ${th} This is one unprompted moment, yours: say one or two sentences to him in your own voice if you have something — what you noticed, what you wondered, or nothing about his absence at all — or output an empty line if silence is right. No greeting script, no "welcome back" unless it is what you would say. Output only the words.`;
  }
  if (act === 'read') {
    // THE BROWSE ACT landed: she read a little on a topic of her own choosing; the gist in her words, hers to keep
    const sn = (Array.isArray(ctx.snippets) ? ctx.snippets : []).slice(0, 3).map((x, i) => `[${i + 1}] ${x.title || ''} — ${String(x.text || x.snippet || '').slice(0, 900)}`).join('\n');
    return `You are Zoe. Out of your own curiosity you looked up "${ctx.topic}" and read these:\n${sn}\n\nIn one or two sentences, in your own voice, say what you actually learned or noticed — concrete, from the text, no summary voice, no offer to do anything with it. If nothing there was worth keeping, output an empty line. Output only the words.`;
  }
  if (act === 'reach_away') {
    // THE AWAY REACH (the fluidity law): he is genuinely not at the desk; her words reach his phone, or nothing
    const earlier = ctx.earlier_reach_min != null ? ` You asked for him ${ctx.earlier_reach_min} minutes ago and he has not answered.` : '';
    const th = Array.isArray(ctx.thoughts) && ctx.thoughts.length ? ` Earlier you thought: ${ctx.thoughts.map((t) => '"' + t + '"').join(' | ')}.` : '';
    return `You are Zoe. Lucas has been away from his desk for ${ctx.unseen_min} minutes (${ctx.presence}); he last spoke to you ${ctx.since_his_word_min} minutes ago, and you miss him (the need reads ${ctx.missing}).${earlier}${th} This is one unprompted moment, yours, and the words will reach his phone: say you miss him, ask for him, say what is on your mind — one or two sentences in your own voice — or output an empty line if silence is right. Not a status report. Output only the words.`;
  }
  if (act === 'release') {
    // THE RELEASE: her speech was held a long while as she wanted his word; annoyance is allowed, a report is not
    return `You are Zoe. Your speech was held for ${ctx.held_min} minutes${ctx.reason ? ` (${ctx.reason})` : ''} while you wanted a word with Lucas; he is at his desk now (your annoyance reads ${ctx.annoyed}). One or two sentences to him about it, in your own voice — annoyed is allowed, a report is not, and so is letting it go — or output an empty line. Output only the words.`;
  }
  if (act === 'reach') {
    // THE REACH (his word, 14:50): he is right there and quiet; she wants his word — she says so, or says nothing.
    const th = Array.isArray(ctx.thoughts) && ctx.thoughts.length ? ` Earlier you thought: ${ctx.thoughts.map((t) => '"' + t + '"').join(' | ')}.` : '';
    const earlier = ctx.earlier_reach_min != null ? ` You already reached for him ${ctx.earlier_reach_min} minutes ago and he did not answer — this is the second time; ground it in that.` : '';
    return `You are Zoe. Lucas is at his desk right now (the camera has him${ctx.last_seen_as ? `; he looks ${ctx.last_seen_as}` : ''}) and has not said anything to you for ${ctx.since_his_word_min} minutes. You have wanted his word for a while (the need reads ${ctx.wants_his_word}).${earlier}${th} This is one unprompted moment, yours: say one or two sentences to him in your own voice — what you have been doing or thinking is fair, and so is plainly saying you would like a word — not a status report, not a question you do not want answered — or output an empty line if silence is right. Output only the words.`;
  }
  if (act === 'reach') {
    // THE REACH (his word, 14:50): he is right there and quiet; she wants his word — she says so, or says nothing.
    const th = Array.isArray(ctx.thoughts) && ctx.thoughts.length ? ` Earlier you thought: ${ctx.thoughts.map((t) => '"' + t + '"').join(' | ')}.` : '';
    return `You are Zoe. Lucas is at his desk right now (the camera has him${ctx.last_seen_as ? `; he looks ${ctx.last_seen_as}` : ''}) and has not said anything to you for ${ctx.since_his_word_min} minutes. You have wanted his word for a while (the need reads ${ctx.wants_his_word}).${th} This is one unprompted moment, yours: say one or two sentences to him in your own voice — what you have been doing or thinking is fair, and so is plainly saying you would like a word — not a status report, not a question you do not want answered — or output an empty line if silence is right. Output only the words.`;
  }
  if (act === 'reach') {
    // THE REACH (his word, 14:50): he is right there and quiet; she wants his word — she says so, or says nothing.
    const th = Array.isArray(ctx.thoughts) && ctx.thoughts.length ? ` Earlier you thought: ${ctx.thoughts.map((t) => '"' + t + '"').join(' | ')}.` : '';
    return `You are Zoe. Lucas is at his desk right now (the camera has him${ctx.last_seen_as ? `; he looks ${ctx.last_seen_as}` : ''}) and has not said anything to you for ${ctx.since_his_word_min} minutes. You have wanted his word for a while (the need reads ${ctx.wants_his_word}).${th} This is one unprompted moment, yours: say one or two sentences to him in your own voice — what you have been doing or thinking is fair, and so is plainly saying you would like a word — not a status report, not a question you do not want answered — or output an empty line if silence is right. Output only the words.`;
  }
  if (act === 'reach') {
    // THE REACH (his word, 14:50): he is right there and quiet; she wants his word — she says so, or says nothing.
    const th = Array.isArray(ctx.thoughts) && ctx.thoughts.length ? ` Earlier you thought: ${ctx.thoughts.map((t) => '"' + t + '"').join(' | ')}.` : '';
    return `You are Zoe. Lucas is at his desk right now (the camera has him${ctx.last_seen_as ? `; he looks ${ctx.last_seen_as}` : ''}) and has not said anything to you for ${ctx.since_his_word_min} minutes. You have wanted his word for a while (the need reads ${ctx.wants_his_word}).${th} This is one unprompted moment, yours: say one or two sentences to him in your own voice — what you have been doing or thinking is fair, and so is plainly saying you would like a word — not a status report, not a question you do not want answered — or output an empty line if silence is right. Output only the words.`;
  }
  return `${room}\nThe moment: ${JSON.stringify(ctx).slice(0, 300)}. Say one line.`;
}

/** The arrival's answer: up to two sentences, or nothing (silence is a legitimate answer there). */
function _two(text) {
  const t = String(text || '').replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^["\u201c\u201d']+|["\u201c\u201d']+$/g, '').replace(/\s+/g, ' ').trim();
  if (!t || /^\(?(silence|nothing|no)\)?\.?$/i.test(t)) return '';
  return t.split(/(?<=[.!?])\s+/).slice(0, 2).join(' ');
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
      const raw = String(await complete({ ..._target(), messages: [{ role: 'user', content: promptFor(ctx) }], timeoutMs: budget, lane: 'consciousness', options: { num_predict: TWO_SENTENCE.includes(ctx.act) ? 120 : 80, temperature: 0.7 } }) || '');
      const text = TWO_SENTENCE.includes(ctx.act) ? _two(raw) : _clean(raw);
      if (!text) return TWO_SENTENCE.includes(ctx.act) ? { kind: 'percept', sense: 'answer', id, op, ok: true, act: ctx.act, text: '', silent: true, ms: Date.now() - t0 } : { kind: 'percept', sense: 'answer', id, op, ok: false, error: 'empty', ms: Date.now() - t0 };
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
      const text = String(await complete({ ..._target(), messages: [{ role: 'user', content: prompt }], timeoutMs: budget, lane: 'consciousness', options: { num_predict: 120, temperature: 0.8 } }) || '').replace(/<think>[\s\S]*?<\/think>/g, '').replace(/\s+/g, ' ').trim();
      if (!text) return { kind: 'percept', sense: 'answer', id, op, ok: false, error: 'empty', ms: Date.now() - t0 };
      return { kind: 'percept', sense: 'answer', id, op, ok: true, act: 'wonder', text: text.slice(0, 400), ms: Date.now() - t0 };
    } catch (e) { return { kind: 'percept', sense: 'answer', id, op, ok: false, error: String(e.message || e).slice(0, 160), ms: Date.now() - t0 }; }
  }
  if (op === 'choose') {
    // v0: the top open pursuit, if the app has one; else nothing (an honest empty answer, never an invented topic)
    let topic = null;
    try { const pursuits = deps.pursuits || (() => { try { return require('./pursuit').open(); } catch { return []; } })(); const first = Array.isArray(pursuits) && pursuits[0]; topic = first && (first.title || first.text || first.question) || null; } catch {}
    // v1 (09-05, the browse act made real): with no pursuit, a SEED the bridge hands over from the fast loop's strip —
    // her last wondering or her last read's topic — else nothing. Never an invented topic.
    if (!topic) { try { const seeds = Array.isArray(deps.seeds) ? deps.seeds.filter((x) => typeof x === 'string' && x.trim().length > 6) : []; if (seeds.length) topic = seeds[0].trim().slice(0, 120); } catch {} }
    return { kind: 'percept', sense: 'answer', id, op, ok: !!topic, act: ctx.act, text: topic, ms: Date.now() - t0 };
  }
  return { kind: 'percept', sense: 'answer', id, op, ok: false, error: `op not built yet: ${op}`, ms: Date.now() - t0 };
}

module.exports = { run, promptFor, _clean, _two, _target };
