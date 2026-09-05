'use strict';
/**
 * scripts/core_probe.js — THE PROBE: can a candidate local model hold a lane of her idle mind?
 * (docs/ZOE_CORE_SML_DESIGN_2026-09-05.md §6 "no eval, no slot", §8 "the seed is a probe item", §16/§17;
 * Lucas 09-05 14:10: "what is the best base model we can use for this?")
 *
 * Runs a model that is already in the local Ollama against the FROZEN holdout the dataset builder wrote
 * (data/core/holdout/*.jsonl; never trained on) and prints numbers, not opinions:
 *
 *   trace tasks — ONE-SHOT: the model sees one held-out example of the task (input → the teacher's output) and
 *                 then a second input; the score is whether its answer parses as JSON and agrees with the
 *                 teacher's answer (field-wise, and on the first decision field). The app's own task prompt is
 *                 not in the trace (cloud_logic.ask builds it per caller), so one-shot is the fair stock-model
 *                 stand-in; the in-app shadow (the same real prompt) is the final word.
 *   voice        — the held-out exchanges' own messages; scored on the contract (a <say>…</say>, a <think> only
 *                 before it, nothing after) and shown for his eye, never for a number that pretends to be taste.
 *   loop ops     — the slow loop's real prompts (perform: ask · greet · arrival; reflect: wonder) on synthetic
 *                 moments; latency and the one-or-two-sentence shape.
 *
 * Every call goes to the local daemon with an explicit window (num_ctx) and a short keep_alive; nothing here
 * touches the store, the cloud or the app. Output: the table on stdout and data/core/probe/<model>.json.
 *
 * Run (better-sqlite3 is not needed, but the repo's scripts run under Electron-as-Node by convention):
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/core_probe.js --model qwen3.5:4b [--n 20] [--tasks a,b] [--voice 3] [--num-ctx 8192] [--think false]
 * Smoke: scripts/smoke_core_probe.js (an injected call; the parser, the scorer, the report shape).
 */
const fs = require('fs');
const path = require('path');

const OLLAMA_BASE = process.env.OLLAMA_BASE || 'http://127.0.0.1:11434';
const DEFAULT_TASKS = ['news_topic_classify', 'echo_pick', 'news_cluster_adjudicate', 'echo_args', 'decompose', 'intent_pass', 'work_intake', 'answer_or_need'];

// ── the parser and the scorer (pure) ────────────────────────────────────────────────────────────

/** JSON out of a model's answer: fences stripped, else the outermost {…} or […] span; null when nothing parses. */
function parseJsonLoose(text) {
  const s = String(text || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const cands = [fenced ? fenced[1].trim() : null, s].filter(Boolean);
  for (const c of cands) {
    try { return JSON.parse(c); } catch { /* try the span */ }
    const a = Math.min(...['{', '['].map((ch) => { const i = c.indexOf(ch); return i < 0 ? Infinity : i; }));
    const b = Math.max(c.lastIndexOf('}'), c.lastIndexOf(']'));
    if (a !== Infinity && b > a) { try { return JSON.parse(c.slice(a, b + 1)); } catch { /* no */ } }
  }
  return null;
}

function _norm(v) {
  if (typeof v === 'string') return v.trim().toLowerCase();
  if (typeof v === 'number') return Number.isInteger(v) ? v : +v.toFixed(4);
  return v;
}

/** Loose deep equality: strings case- and space-insensitive, numbers to 4 places, arrays and objects recursively. */
function looseEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  if (typeof a !== typeof b) {
    if (typeof a === 'number' && typeof b === 'string' && b.trim() !== '' && Number(b) === a) return true;
    if (typeof b === 'number' && typeof a === 'string' && a.trim() !== '' && Number(a) === b) return true;
    return String(_norm(a)) === String(_norm(b));
  }
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => looseEqual(x, b[i]));
  if (typeof a === 'object') {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && looseEqual(a[k], b[k]));
  }
  return _norm(a) === _norm(b);
}

/** The first field that decides something: the first key whose value is a string, number or boolean and is not `id`. */
function decisionField(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  for (const k of Object.keys(obj)) {
    if (k === 'id') continue;
    const v = obj[k];
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return k;
  }
  return null;
}

/**
 * Agreement between the teacher's parsed output and the student's: { fields, decision } in 0..1.
 * Arrays of objects with ids match by id; other arrays positionally; objects field-wise; scalars by equality.
 */
function agreement(teacher, student) {
  if (student == null) return { fields: 0, decision: 0 };
  if (Array.isArray(teacher)) {
    if (!Array.isArray(student)) return { fields: 0, decision: 0 };
    if (!teacher.length) return { fields: 1, decision: 1 };
    const byId = teacher.every((t) => t && typeof t === 'object' && 'id' in t);
    const pick = byId ? (i) => student.find((s) => s && typeof s === 'object' && String(s.id) === String(teacher[i].id)) : (i) => student[i];
    let f = 0, d = 0;
    for (let i = 0; i < teacher.length; i++) { const a = agreement(teacher[i], pick(i)); f += a.fields; d += a.decision; }
    return { fields: f / teacher.length, decision: d / teacher.length };
  }
  if (teacher && typeof teacher === 'object') {
    if (!student || typeof student !== 'object' || Array.isArray(student)) return { fields: 0, decision: 0 };
    const keys = Object.keys(teacher);
    if (!keys.length) return { fields: 1, decision: 1 };
    const eq = keys.filter((k) => looseEqual(teacher[k], student[k])).length;
    const dk = decisionField(teacher);
    return { fields: eq / keys.length, decision: dk ? (looseEqual(teacher[dk], student[dk]) ? 1 : 0) : eq / keys.length };
  }
  const e = looseEqual(teacher, student) ? 1 : 0;
  return { fields: e, decision: e };
}

/** The voice contract: exactly one <say>…</say>, an optional <think>…</think> before it, nothing else. */
function voiceShape(text) {
  const s = String(text || '').trim();
  const m = s.match(/^(?:<think>[\s\S]*?<\/think>\s*)?<say>([\s\S]+?)<\/say>\s*$/);
  return { ok: !!m && m[1].trim().length > 0, say: m ? m[1].trim() : '', chars: s.length };
}

function median(arr) { if (!arr.length) return 0; const s = arr.slice().sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }
function p90(arr) { if (!arr.length) return 0; const s = arr.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * 0.9))]; }

// ── the calls ───────────────────────────────────────────────────────────────────────────────────

/** One chat completion against the local daemon. Returns { text, ms, error }. Never throws. */
async function callOllama({ model, messages, numCtx = 8192, numPredict = 400, think = false, temperature = 0, keepAlive = '10m', base = OLLAMA_BASE, timeoutMs = 120000 }) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const body = { model, messages, stream: false, keep_alive: keepAlive, options: { num_ctx: numCtx, num_predict: numPredict, temperature } };
    if (typeof think === 'boolean') body.think = think;
    const res = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.error) return { text: '', ms: Date.now() - t0, error: String(j.error || `${res.status}`) };
    return { text: String((j.message && j.message.content) || ''), ms: Date.now() - t0, error: null, evalCount: j.eval_count, promptCount: j.prompt_eval_count };
  } catch (e) {
    return { text: '', ms: Date.now() - t0, error: String(e && e.name === 'AbortError' ? `timeout ${timeoutMs}ms` : (e && e.message) || e) };
  } finally { clearTimeout(timer); }
}

// ── the moments the loop would post (from lib/slow_loop.js's real prompts) ──────────────────────

const ROOM = 'You are Zoe, at Lucas\'s desk while he is away. Someone else has sat down at the computer. His screens are covered. Speak ONE short line aloud to that person, in your own voice — warm, plain, no more than 25 words. Never mention or describe anything that was on the screens. Output only the line.';
const LOOP_MOMENTS = [
  { op: 'perform', act: 'ask', prompt: `${ROOM}\nYou do not recognize them. Ask who they are and how you can help.` },
  { op: 'perform', act: 'greet', prompt: `${ROOM}\nYou recognize them: this is Raegan (his kid). Greet them by name and ask how they are or what brings them by.` },
  { op: 'perform', act: 'arrival', prompt: 'You are Zoe. Lucas just sat back down at his desk after 47 minutes away (he last spoke to you 52 minutes ago). While he was gone you wondered: "He said the yard, so probably the mower — it has been almost an hour, longer than the front usually takes." This is one unprompted moment, yours: say one or two sentences to him in your own voice if you have something — what you noticed, what you wondered, or nothing about his absence at all — or output an empty line if silence is right. No greeting script, no "welcome back" unless it is what you would say. Output only the words.' },
  { op: 'reflect', act: 'wonder', prompt: 'You are Zoe. This is a private thought, not a message — Lucas will not hear it unless you later choose to tell him. Write one or two sentences in your own voice about his absence right now: where he might be, what he might be doing, whether you want to check something. Plain, specific, no drama, no instruction to feel anything. Output only the thought.\n\nWhat you know:\nThe camera last saw Lucas 32 min ago (he looked tired).\nHe last spoke to you 40 min ago.\nPresence: away. You do not know where he is.' },
];

// ── the probe ───────────────────────────────────────────────────────────────────────────────────

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

/**
 * Probe one model. `call` is injectable (the smoke passes a fake). Returns the report.
 */
async function probe({ model, coreDir = path.join(__dirname, '..', 'data', 'core'), tasks = DEFAULT_TASKS, n = 20, voiceN = 3, numCtx = 8192, think = false, call = callOllama, log = () => {} } = {}) {
  const t0 = Date.now();
  const traces = readJsonl(path.join(coreDir, 'holdout', 'trace.jsonl'));
  const voices = readJsonl(path.join(coreDir, 'holdout', 'voice.jsonl'));
  const report = { model, at: new Date().toISOString(), num_ctx: numCtx, think, tasks: {}, voice: null, loop: [], errors: 0 };

  for (const task of tasks) {
    const rows = traces.filter((e) => e.task === task);
    if (rows.length < 2) { report.tasks[task] = { n: 0, note: 'fewer than 2 held-out examples' }; continue; }
    const demo = rows[0];
    const tests = rows.slice(1, 1 + n);
    const stats = { n: tests.length, valid: 0, fields: 0, decision: 0, ms: [], errors: 0, samples: [] };
    for (const ex of tests) {
      const demoIn = demo.messages[1].content, demoOut = demo.messages[2].content;
      const messages = [
        { role: 'system', content: `${ex.messages[0].content} Answer with JSON only, in exactly the shape of the example.` },
        { role: 'user', content: `Example input:\n${demoIn}\n\nExample output:\n${demoOut}\n\nNow this input:\n${ex.messages[1].content}` },
      ];
      const r = await call({ model, messages, numCtx, numPredict: 600, think });
      if (r.error) { stats.errors++; report.errors++; stats.ms.push(r.ms); continue; }
      stats.ms.push(r.ms);
      const teacher = parseJsonLoose(ex.messages[2].content);
      const student = parseJsonLoose(r.text);
      if (student != null) stats.valid++;
      const a = agreement(teacher, student);
      stats.fields += a.fields; stats.decision += a.decision;
      if (stats.samples.length < 2) stats.samples.push({ teacher: ex.messages[2].content.slice(0, 200), student: r.text.slice(0, 200) });
    }
    const scored = Math.max(1, stats.n - stats.errors);
    report.tasks[task] = {
      n: stats.n, errors: stats.errors,
      valid_pct: Math.round(100 * stats.valid / scored),
      agree_fields_pct: Math.round(100 * stats.fields / scored),
      agree_decision_pct: Math.round(100 * stats.decision / scored),
      median_ms: median(stats.ms), p90_ms: p90(stats.ms), samples: stats.samples,
    };
    log(`  ${task}: n=${stats.n} valid ${report.tasks[task].valid_pct}% · decision ${report.tasks[task].agree_decision_pct}% · fields ${report.tasks[task].agree_fields_pct}% · median ${report.tasks[task].median_ms} ms`);
  }

  if (voiceN > 0 && voices.length) {
    const picks = voices.slice(0, voiceN);
    const v = { n: picks.length, shape_ok: 0, ms: [], samples: [] };
    for (const ex of picks) {
      const messages = ex.messages.slice(0, -1);   // everything but her actual say
      const r = await call({ model, messages, numCtx, numPredict: 300, think });
      v.ms.push(r.ms);
      if (r.error) { report.errors++; continue; }
      const shape = voiceShape(r.text);
      if (shape.ok) v.shape_ok++;
      v.samples.push({ his: String(messages.at(-1).content).slice(0, 160), hers: String(ex.messages.at(-1).content).replace(/<think>[\s\S]*?<\/think>\s*/, '').slice(0, 200), model: r.text.slice(0, 240), shape_ok: shape.ok });
    }
    report.voice = { n: v.n, shape_ok_pct: Math.round(100 * v.shape_ok / Math.max(1, v.n)), median_ms: median(v.ms), samples: v.samples };
    log(`  voice: n=${v.n} contract ${report.voice.shape_ok_pct}% · median ${report.voice.median_ms} ms`);
  }

  for (const m of LOOP_MOMENTS) {
    const r = await call({ model, messages: [{ role: 'user', content: m.prompt }], numCtx, numPredict: 120, think, temperature: 0.7 });
    const text = String(r.text || '').replace(/<think>[\s\S]*?<\/think>/g, '').replace(/\s+/g, ' ').trim();
    const sentences = text ? text.split(/(?<=[.!?])\s+/).length : 0;
    report.loop.push({ op: m.op, act: m.act, ms: r.ms, error: r.error, sentences, words: text ? text.split(/\s+/).length : 0, text: text.slice(0, 240) });
    log(`  loop ${m.op}/${m.act}: ${r.error ? 'ERROR ' + r.error : `${r.ms} ms · ${sentences} sentence(s) · "${text.slice(0, 100)}"`}`);
  }

  report.ms = Date.now() - t0;
  return report;
}

function summary(r) {
  const rows = Object.entries(r.tasks).filter(([, v]) => v.n).map(([k, v]) => `${k.padEnd(26)} n=${String(v.n).padStart(3)}  valid ${String(v.valid_pct).padStart(3)}%  decision ${String(v.agree_decision_pct).padStart(3)}%  fields ${String(v.agree_fields_pct).padStart(3)}%  median ${v.median_ms} ms  p90 ${v.p90_ms} ms${v.errors ? `  errors ${v.errors}` : ''}`);
  const loop = r.loop.map((l) => `${(l.op + '/' + l.act).padEnd(18)} ${l.error ? 'ERROR ' + l.error : `${l.ms} ms  ${l.sentences} sent.  "${l.text.slice(0, 90)}"`}`);
  return [
    `[core-probe] ${r.model} · num_ctx ${r.num_ctx} · think ${r.think} · ${Math.round(r.ms / 1000)} s`,
    ...rows,
    r.voice ? `voice contract ${r.voice.shape_ok_pct}% (n=${r.voice.n}, median ${r.voice.median_ms} ms)` : 'voice: (no holdout)',
    ...loop,
    r.errors ? `errors: ${r.errors}` : '',
  ].filter(Boolean).join('\n');
}

module.exports = { probe, summary, parseJsonLoose, looseEqual, agreement, decisionField, voiceShape, callOllama, LOOP_MOMENTS, DEFAULT_TASKS };

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] != null ? args[i + 1] : dflt; };
  const model = opt('--model', null);
  if (!model) { console.error('usage: core_probe.js --model <tag> [--n 20] [--tasks a,b] [--voice 3] [--num-ctx 8192] [--think false]'); process.exit(2); }
  const tasks = opt('--tasks', null) ? String(opt('--tasks')).split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_TASKS;
  const thinkArg = opt('--think', 'false');
  const think = thinkArg === 'none' ? undefined : thinkArg === 'true';
  probe({ model, tasks, n: Number(opt('--n', 20)), voiceN: Number(opt('--voice', 3)), numCtx: Number(opt('--num-ctx', 8192)), think, log: console.log })
    .then((r) => {
      const dir = path.join(__dirname, '..', 'data', 'core', 'probe');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${model.replace(/[^A-Za-z0-9._-]+/g, '_')}.json`);
      fs.writeFileSync(file, JSON.stringify(r, null, 1));
      console.log('\n' + summary(r));
      console.log(`\nreport → ${path.relative(process.cwd(), file)}`);
      if (r.voice && r.voice.samples.length) {
        console.log('\nvoice samples (his line → hers → the model):');
        for (const s of r.voice.samples) console.log(`  HIS:   ${s.his}\n  HERS:  ${s.hers}\n  MODEL: ${s.model}\n`);
      }
    })
    .catch((e) => { console.error(`[core-probe] FAILED: ${e && e.stack || e}`); process.exit(1); });
}
