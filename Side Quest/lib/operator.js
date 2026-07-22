/**
 * lib/operator.js — the CLOUD OPERATOR. A frontier cloud model drives the turn as a real
 * tool-calling AGENT (decide → call a tool → see the result → decide again → … → answer), over the
 * full capability surface (web, Echo's tool catalog, her own browser, memory, files). The local
 * model (Dans) then just VOICES the operator's answer. This is "cognition in the cloud" made literal:
 * the capable model is the DECIDER, not the 24B trying to remember which tag to emit.
 *
 * This module is the PURE agent loop + the action parser. `complete` (the cloud call) and `tools`
 * (the executors) are injected, so the whole agent is offline smoke-testable with no model/network.
 * Fail-safe: cloud error / unparseable / no cloud → returns whatever it has (or null), and the caller
 * falls back to the local reply. The deep Echo catalog (500+ tools) is reached via the single `echo`
 * tool, which delegates to echo_suit.routeNeed (cloud-picks the exact tool) — so the operator's own
 * menu stays small and learnable.
 */
'use strict';
const models = require('./models');
const { completeDetailed, isReasoningModel } = require('./ollama');

const DEFAULT_MAX_STEPS = 4;       // keep the loop snappy for chat latency
const DEFAULT_MAX_MS = 45000;      // hard wall-clock budget so a turn can NEVER block for minutes

// The agent LOOP wants speed (several quick "which tool next" decisions), not deep single-shot
// reasoning — so default to the fast utility model, not the 120B reasoner (which made turns take
// ~2 min). Override with db meta model.operator (e.g. gpt-oss:120b) for deeper-but-slower.
function operatorModel() {
  try { return require('./db').getMeta('model.operator') || models.getModelFor('editor', null) || 'gemma4:31b-cloud'; }
  catch { return 'gemma4:31b-cloud'; }
}

// Real cloud call bound to the operator model. opts.model overrides (lets a caller run a specific lane
// on a specific cloud model — e.g. the deep lane on the 120B reasoner, the web lane on fast gemma).
// Returns {text, usage} or null (no cloud).
async function _operatorComplete(messages, opts = {}) {
  const src = (models.sources() || []).find(s => s.tier === 'cloud' && s.token);
  if (!src) return null;
  const model = opts.model || operatorModel();
  // The window is the MODEL's, not a guess. `num_ctx: 16384` was hardcoded here, which ran the one
  // lane built to let a frontier model DRIVE (decide→tool→see→decide) inside ~6-12% of its real
  // window — the audit's single most starved surface. cloud_window fails safe to 8192, so this can
  // only widen. An explicit opts.num_ctx still wins (a caller deliberately running small).
  let num_ctx = opts.num_ctx || null;
  if (!num_ctx) {
    try { num_ctx = (await require('./cloud_window').resolve({ model, base: src.base, token: src.token })).num_ctx; }
    catch { num_ctx = 16384; }
  }
  return completeDetailed({
    model, messages, base: src.base,
    headers: src.token ? { Authorization: `Bearer ${src.token}` } : {},
    // think:false on a reasoning model — the step contract is ONE clean JSON object (or plain prose
    // for the final answer); without it the model buries the step in message.thinking and the
    // parsed .text is chain-of-thought (the condenseComplete disease, same door).
    ...(isReasoningModel(model) ? { think: false } : {}),
    // repeat_penalty dropped to the transport default (1.1): 1.3 on a JSON-emitting agent penalizes
    // the very braces/quotes the contract requires and was degrading step parses.
    options: { temperature: 0.4, top_p: 0.9, repeat_penalty: 1.1, num_ctx, num_predict: opts.num_predict || 700 }
  });
}

// Core tool menu. The curated Echo READ tools (echo_tier.operatorReadSpec) are appended below so the
// operator reaches for the right structured source deliberately; the generic `echo` tool still covers
// the long tail of the 500+ surface.
const TOOL_SPEC_CORE = `ORDER OF OPERATIONS — check what WE ALREADY KNOW before you reach for the open web.
You have two first-class databases of your own: echo (OUR research databases — the knowledge graph, vault,
CRM, gov/legal/financial records) and localdb (her own accumulated memory). We have spent a long time
building them; most civic/entity questions are already answered in there, and going straight to a web
search both wastes the work and risks contradicting what we already hold. So: look inward FIRST, then go
outward to fill what's genuinely missing. Say plainly when our own data came up empty — that's a useful
finding, not a failure.

OUR DATA IS A STARTING POINT, NOT THE FULL ANSWER — this is critical. Checking our databases first does
NOT mean whatever we already hold IS the complete set. Our coverage is partial and always growing. If the
question has a KNOWN TOTAL — all 64 Louisiana parishes, all 50 states, every member of a chamber — that
total is the target, and what we hold is measured AGAINST it, not mistaken FOR it. Finding 9 records when
the universe is 64 means "we have 9 of 64, go find the other 55", NEVER "here are all 9". State the count
you found AND the count you expect, and treat the gap as the work. Reporting our partial set as if it were
complete is the single worst mistake you can make here — it is worse than not checking at all, because it
launders an incomplete answer as a finished one.

NEVER claim an action you did not take. Do not say a dossier "is being moved to your Canvas", a file "is
saved", or contacts "are banked" unless you actually called the tool that does it and it succeeded. If you
are still gathering, say you are still gathering. A confident false claim of completion is a lie, however
well-meant.

TOOLS (call exactly ONE per step):
- echo {"need":"…"}             OUR private data + 500+ research tools (legislative/gov/CRM/knowledge-graph) — say the need in plain words (use this for anything the named ECHO DATA TOOLS below don't cover)
- recall {"query":"…"}          semantic search of her OWN memory (past conversations, facts, notes she's kept)
- localdb {"sql":"SELECT …"}    query her OWN local memory stores DIRECTLY — read-only SELECT over her tables (knowledge, notes, open_threads, monologue, self_model…). Use this to look across ALL of her stored memory, not just the top semantic hits. FIVE databases are queryable, and the four beyond her main store are addressed by an ALIAS PREFIX — you can join across them freely:
    · (no prefix)  her main store — knowledge, turns, monologue, open_threads, self_model, absence, route_obs…
    · puller.*     her OWN contact research — puller.targets, puller.beliefs, puller.observations (the biggest store she has; e.g. SELECT COUNT(*) FROM puller.targets)
    · news.*       the news bucket — news.news_items, news.news_stories (what she has actually been reading)
    · api.*        API usage/cache — api.api_usage, api.bulk_records
    · editor.*     the document pipeline — editor.pipeline_documents, editor.check_runs
  Run localdb_map first if you don't know the tables; it lists every table QUALIFIED exactly as you must query it.
- localdb_map {}                list her local stores' tables + row counts (all five databases)
- web_search {"query":"…"}      search the open web + read the top result — for what our own data does NOT already cover (breaking news, prices, a page/video, anything genuinely new)
- open_page {"url":"…"}         open a SPECIFIC page in her browser and read it in full — use this to go DEEPER into a good source instead of bouncing to a new search: follow a promising link you saw, or go straight to an org's own /team, /leadership, /about, or /contact page
- browser_read {}               read the page currently open in her browser
- file {"op":"read|write|append|list","path":"notes/x.md","content":"…"}   her workspace files
- puller_add {"company":"…","contacts":[{"name":"…","title":"…","email":"…","phone":"…","verified":true}]}   BANK the real people you found into Puller (our contact store) — it learns the company's email pattern + grades confidence. On a CONTACTS task, call this as you find each executive: name + title always; email/phone when found; verified:true ONLY if the email came from an official/public source (else it's treated as a pattern candidate)`;

const TOOL_SPEC_TAIL = `To use a tool, reply with ONE JSON object and nothing else:
  {"thought":"why","action":{"tool":"echo","args":{"need":"…"}}}
When you're ready to answer, do NOT use JSON — just write the COMPLETE answer as plain text (this is what lets a long list or write-up come through whole and untruncated; never cut it short).
Ground every claim in what the tools returned. If a tool errors or finds nothing, say so honestly — never invent. Prefer answering once you have enough; don't over-search.`;

const TOOL_SPEC = (() => {
  let readSpec = '';
  try { readSpec = require('./echo_tier').operatorReadSpec(); } catch {}
  return [TOOL_SPEC_CORE, readSpec, TOOL_SPEC_TAIL].filter(Boolean).join('\n\n');
})();

// Caps here are LOOP-hygiene bounds sized from config, not the old 8192-era guesses: the user
// message is the assignment — cutting it at 1,500 chars amputated multi-part briefs — and context/
// tool results now follow the same knobs the chat-tag lane got in the cap purge (toolResultChars).
function _contextCap() { try { return require('./config').toolResultChars(); } catch { return 24000; } }
function _buildPrompt({ userMessage, context, history, stepsLeft, toolSpec = null }) {
  const cap = _contextCap();
  return [{
    role: 'user',
    content: `You are the cognition/agent for Zoe (a local AI). DECIDE and ACT to fully handle this turn for her; she will voice your answer in her own words.

${context ? 'CONTEXT (her memory/state relevant to this turn):\n' + String(context).slice(0, cap) + '\n\n' : ''}USER MESSAGE:
${String(userMessage).slice(0, cap)}

${toolSpec || TOOL_SPEC}

${history ? 'WORK SO FAR:' + history + '\n' : ''}Steps remaining: ${stepsLeft}. Respond with ONE JSON object now.`
  }];
}

// Parse the model's JSON step: the first parseable, BALANCED {...} that carries action/final.
// The old greedy /\{[\s\S]*\}/ spanned first-{ to LAST-} — any brace in surrounding prose
// ("weigh {the options}") poisoned the span, JSON.parse failed, and the garbled tool call was
// silently treated as the FINAL ANSWER and voiced. Balanced scan, string/escape-aware; an
// unparseable candidate advances to the next '{', a parseable non-step is skipped whole.
// Returns {thought?, action?, final?} or null if no step object is present.
function parseAction(text) {
  const s = String(text || '');
  let i = s.indexOf('{');
  while (i !== -1) {
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (esc) { esc = false; continue; }
      if (inStr) { if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end === -1) return null;                       // no balanced close ahead → nothing left to try
    try {
      const o = JSON.parse(s.slice(i, end + 1));
      if (o && (o.action || o.final !== undefined)) return o;
      i = s.indexOf('{', end + 1);                     // parsed but not a step → skip it whole
    } catch {
      i = s.indexOf('{', i + 1);                       // unparseable candidate → next '{'
    }
  }
  return null;
}

// Did this text ATTEMPT a JSON step (vs. being a deliberate plain-prose final answer)? Prose-as-answer
// is the contract; a malformed attempted step is not — it earns one repair reprompt before we give up.
function looksLikeJsonStep(text) {
  return /"action"\s*:|"final"\s*:/.test(String(text || ''));
}

function _finalize(steps, answer) {
  return { answer: (answer && String(answer).trim()) || null, steps, toolsUsed: steps.map(s => s.tool) };
}

// A DIRECTED TASK = Lucas assigning work that should be driven to a complete DELIVERABLE (a list, a
// write-up, a compiled/organized result), vs a quick question. Tasks get a bigger step/time budget +
// a "finish the whole thing this turn" mandate; quick questions stay snappy.
// Broadened (2026-06-29) after a clear overnight research assignment ("study every right-of-center
// think tank…", "spend the night working on…", "start working on the project") matched NONE of the
// original verbs → the operator never fired and she confabulated a fake source. Added the research/
// investigation family + work-assignment framing. Precision stays acceptable because a false positive
// only routes a turn through the (grounded) operator, never fabricates.
const TASK_RE = /\b(make|build|create|compile|put together|assemble|draft|write\s*(up|me)|find me|find out|figure out|research|study|investigate|look into|dig into|delve into|catalogu?e|map out|profile|identify|organi[sz]e|gather|pull together|generate|list out|come up with|work(?:ing)? on|spend (?:the )?(?:night|day|evening|time)|keep working|continue working|i need you to|give me a (?:list|rundown|breakdown|summary|report))\b/i;
// NOT a new assignment, even though they contain a task verb: a PAST-TENSE reference to work she was/
// has been doing ("you were doing research on X", "you've been researching Y", "we were working on Z",
// "remember you were studying…"). Treating these as a fresh directed task is the mis-fire that spun up a
// duplicate run + confabulated files (live 2026-06-29). They're context/recall, not a command.
const PAST_REF_RE = /\b(you (?:were|was|have been|'ve been|had been|did|used to)|we (?:were|have been|'ve been|had been)|you'?d been|remember (?:you|we|when)|earlier you|you'?ve already|already (?:did|done|researched|covered))\b/i;

function isDirectedTask(text) {
  const s = String(text || '');
  if (s.length < 6) return false;
  if (!TASK_RE.test(s)) return false;
  if (PAST_REF_RE.test(s)) return false;   // a reference to past/existing work, not a new assignment
  return true;
}

// Parse ONE directed-focus research slice (used by the overnight driver in main.js). The slice prompt
// makes the operator end with "COVERED: <org>" and emit "ALL-COVERED" when the universe is exhausted.
// This pulls the org, decides whether it's NEW vs the already-documented set (case/space-insensitive —
// the anti-loop teeth), and strips the control lines from the body for the deliverable file. Pure so
// the loop-avoidance logic is unit-tested; all I/O (file/db/network) stays in main.js.
function parseSliceResult(answer, covered = []) {
  const ans = String(answer || '').trim();
  const cov = Array.isArray(covered) ? covered : [];
  const done = /\bALL[-\s]?COVERED\b/i.test(ans) && cov.length > 0;
  const m = ans.match(/COVERED:\s*(.+?)\s*$/im);
  const org = m ? m[1].trim().replace(/[*_#`]/g, '').slice(0, 80) : '';
  const orgKey = org.toLowerCase().replace(/\s+/g, ' ').trim();
  const isNew = !done && !!orgKey && !cov.some(c => String(c).toLowerCase().replace(/\s+/g, ' ').trim() === orgKey);
  const body = ans.replace(/^\s*COVERED:.*$/im, '').replace(/\bALL[-\s]?COVERED\b/i, '').trim();
  return { org, orgKey, isNew, done, body };
}

/**
 * Run the agent loop. deps.complete(messages)->{text}|string ; deps.tools = { web_search, echo,
 * browser_read, recall, file } each (args)->string. Returns { answer, steps, toolsUsed } or null.
 */
async function runOperator({ userMessage, context = '', deps = {}, maxSteps = DEFAULT_MAX_STEPS, maxMs = DEFAULT_MAX_MS, numPredict = 900, model = null, toolSpec = null } = {}) {
  const complete = deps.complete || _operatorComplete;
  const tools = deps.tools || {};
  const nowFn = deps.now || Date.now;
  if (!userMessage || typeof complete !== 'function') return null;
  const t0 = nowFn();
  const steps = [];
  let history = '';
  // numPredict governs how big the model's response (incl. the {final:…} deliverable) can be — large
  // for directed tasks so a long list/write-up isn't truncated at generation. model = optional cloud
  // model override (per-lane); toolSpec = optional lane-scoped tool menu.
  const cOpts = { num_predict: numPredict, ...(model ? { model } : {}) };
  const capChars = _contextCap();
  let repaired = false;
  for (let i = 0; i < maxSteps; i++) {
    if (nowFn() - t0 > maxMs) break;   // over the wall-clock budget → stop looping, force a final below
    let res;
    try { res = await complete(_buildPrompt({ userMessage, context, history, stepsLeft: maxSteps - i, toolSpec }), cOpts); }
    catch (e) { return steps.length ? _finalize(steps, null) : null; }
    if (res == null) return steps.length ? _finalize(steps, null) : null;   // no cloud configured
    let text = (typeof res === 'string') ? res : (res.text || '');
    let parsed = parseAction(text);
    // ONE repair reprompt when the text ATTEMPTED a step but didn't parse. Without this, a garbled
    // tool call fell straight through the prose-as-answer contract below and was VOICED to Lucas as
    // the reply (the greedy-parse failure's second half). Genuine prose never matches
    // looksLikeJsonStep, so real answers still pass through untouched.
    if (!parsed && looksLikeJsonStep(text) && !repaired) {
      repaired = true;
      try {
        const r2 = await complete([
          ..._buildPrompt({ userMessage, context, history, stepsLeft: maxSteps - i, toolSpec }),
          { role: 'assistant', content: text },
          { role: 'user', content: 'That was not a parseable step. Re-emit it as EXACTLY ONE valid JSON object — {"thought":"…","action":{"tool":"…","args":{…}}} or {"thought":"…","final":"…"} — and nothing else.' }
        ], cOpts);
        const t2 = (typeof r2 === 'string') ? r2 : ((r2 && r2.text) || '');
        const p2 = parseAction(t2);
        if (p2) { parsed = p2; text = t2; }
      } catch { /* repair is best-effort — fall through to the prose contract */ }
    }
    if (!parsed) return _finalize(steps, text.trim() || null);              // plain prose → treat as the answer
    if (parsed.final !== undefined) return _finalize(steps, parsed.final);
    const tool = parsed.action && parsed.action.tool;
    const args = (parsed.action && parsed.action.args) || {};
    const fn = tools[tool];
    let result;
    if (typeof fn !== 'function') result = `ERROR: no tool named "${tool}".`;
    else { try { result = await fn(args); } catch (e) { result = 'ERROR: ' + (e && e.message || e); } }
    // Sized to the same knob the chat-tag lane got in the cap purge (was 3000, then re-sliced to
    // 1200 in history — the agent "read" every tool result through a 1,200-char keyhole while the
    // chat lane read 24k). One cap, applied once; history carries the same text the step stored.
    result = String(result == null ? '' : result).slice(0, capChars);
    steps.push({ tool, args, result });
    history += `\n• step ${i + 1}: ${tool}(${JSON.stringify(args).slice(0, 300)}) → ${result}`;
  }
  // out of steps → force a final answer from what we gathered
  try {
    const res = await complete([{ role: 'user', content: `You are out of tool steps. Using ONLY the work below, give Zoe the complete grounded answer to: "${String(userMessage).slice(0, capChars)}".${history}\n\nReply with the answer text only.` }], cOpts);
    const text = (typeof res === 'string') ? res : ((res && res.text) || '');
    return _finalize(steps, text.trim() || null);
  } catch { return _finalize(steps, null); }
}

module.exports = { runOperator, parseAction, looksLikeJsonStep, isDirectedTask, parseSliceResult, operatorModel, _operatorComplete, TOOL_SPEC, TOOL_SPEC_CORE, TOOL_SPEC_TAIL, DEFAULT_MAX_STEPS };
