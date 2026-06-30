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
const { completeDetailed } = require('./ollama');

const DEFAULT_MAX_STEPS = 4;       // keep the loop snappy for chat latency
const DEFAULT_MAX_MS = 45000;      // hard wall-clock budget so a turn can NEVER block for minutes

// The agent LOOP wants speed (several quick "which tool next" decisions), not deep single-shot
// reasoning — so default to the fast utility model, not the 120B reasoner (which made turns take
// ~2 min). Override with db meta model.operator (e.g. gpt-oss:120b) for deeper-but-slower.
function operatorModel() {
  try { return require('./db').getMeta('model.operator') || models.getModelFor('editor', null) || 'gemma4:31b'; }
  catch { return 'gemma4:31b'; }
}

// Real cloud call bound to the operator model. opts.model overrides (lets a caller run a specific lane
// on a specific cloud model — e.g. the deep lane on the 120B reasoner, the web lane on fast gemma).
// Returns {text, usage} or null (no cloud).
async function _operatorComplete(messages, opts = {}) {
  const src = (models.sources() || []).find(s => s.tier === 'cloud' && s.token);
  if (!src) return null;
  const model = opts.model || operatorModel();
  return completeDetailed({
    model, messages, base: src.base,
    headers: src.token ? { Authorization: `Bearer ${src.token}` } : {},
    options: { temperature: 0.4, top_p: 0.9, repeat_penalty: 1.3, num_ctx: opts.num_ctx || 16384, num_predict: opts.num_predict || 700 }
  });
}

// Core tool menu. The curated Echo READ tools (echo_tier.operatorReadSpec) are appended below so the
// operator reaches for the right structured source deliberately; the generic `echo` tool still covers
// the long tail of the 500+ surface.
const TOOL_SPEC_CORE = `TOOLS (call exactly ONE per step):
- web_search {"query":"…"}      search the open web + read the top result (current facts, news, prices, finding a page/video)
- open_page {"url":"…"}         open a SPECIFIC page in her browser and read it in full — use this to go DEEPER into a good source instead of bouncing to a new search: follow a promising link you saw, or go straight to an org's own /team, /leadership, /about, or /contact page
- echo {"need":"…"}             OUR private data + 500+ research tools (legislative/gov/CRM/knowledge-graph) — say the need in plain words (use this for anything the named ECHO DATA TOOLS below don't cover)
- browser_read {}               read the page currently open in her browser
- recall {"query":"…"}          semantic search of her OWN memory (past conversations, facts, notes she's kept)
- localdb {"sql":"SELECT …"}    query her OWN local memory store DIRECTLY — read-only SELECT over her tables (knowledge, notes, open_threads, monologue, self_model…). Use this to look across ALL of her stored memory, not just the top semantic hits. Run localdb_map first if you don't know the tables.
- localdb_map {}                list her local store's tables + row counts
- file {"op":"read|write|append|list","path":"notes/x.md","content":"…"}   her workspace files

YOU HAVE TWO FIRST-CLASS DATABASES — use BOTH as needed: localdb (her own accumulated memory) and echo (OUR research databases: the knowledge graph, vault, CRM, gov/legal/financial records, plus db_query for raw SELECTs across them). Before answering "do we have / what do we know" from guesswork, check them.`;

const TOOL_SPEC_TAIL = `To use a tool, reply with ONE JSON object and nothing else:
  {"thought":"why","action":{"tool":"web_search","args":{"query":"…"}}}
When you're ready to answer, do NOT use JSON — just write the COMPLETE answer as plain text (this is what lets a long list or write-up come through whole and untruncated; never cut it short).
Ground every claim in what the tools returned. If a tool errors or finds nothing, say so honestly — never invent. Prefer answering once you have enough; don't over-search.`;

const TOOL_SPEC = (() => {
  let readSpec = '';
  try { readSpec = require('./echo_tier').operatorReadSpec(); } catch {}
  return [TOOL_SPEC_CORE, readSpec, TOOL_SPEC_TAIL].filter(Boolean).join('\n\n');
})();

function _buildPrompt({ userMessage, context, history, stepsLeft, toolSpec = null }) {
  return [{
    role: 'user',
    content: `You are the cognition/agent for Zoe (a local AI). DECIDE and ACT to fully handle this turn for her; she will voice your answer in her own words.

${context ? 'CONTEXT (her memory/state relevant to this turn):\n' + String(context).slice(0, 3000) + '\n\n' : ''}USER MESSAGE:
${String(userMessage).slice(0, 1500)}

${toolSpec || TOOL_SPEC}

${history ? 'WORK SO FAR:' + history + '\n' : ''}Steps remaining: ${stepsLeft}. Respond with ONE JSON object now.`
  }];
}

// Parse the model's JSON step. Tolerant: grabs the first {...} block. Returns {thought?, action?, final?}
// or null if no JSON object is present.
function parseAction(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    if (o && (o.action || o.final !== undefined)) return o;
    return null;
  } catch { return null; }
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
  for (let i = 0; i < maxSteps; i++) {
    if (nowFn() - t0 > maxMs) break;   // over the wall-clock budget → stop looping, force a final below
    let res;
    try { res = await complete(_buildPrompt({ userMessage, context, history, stepsLeft: maxSteps - i, toolSpec }), cOpts); }
    catch (e) { return steps.length ? _finalize(steps, null) : null; }
    if (res == null) return steps.length ? _finalize(steps, null) : null;   // no cloud configured
    const text = (typeof res === 'string') ? res : (res.text || '');
    const parsed = parseAction(text);
    if (!parsed) return _finalize(steps, text.trim() || null);              // plain prose → treat as the answer
    if (parsed.final !== undefined) return _finalize(steps, parsed.final);
    const tool = parsed.action && parsed.action.tool;
    const args = (parsed.action && parsed.action.args) || {};
    const fn = tools[tool];
    let result;
    if (typeof fn !== 'function') result = `ERROR: no tool named "${tool}".`;
    else { try { result = await fn(args); } catch (e) { result = 'ERROR: ' + (e && e.message || e); } }
    result = String(result == null ? '' : result).slice(0, 3000);
    steps.push({ tool, args, result });
    history += `\n• step ${i + 1}: ${tool}(${JSON.stringify(args).slice(0, 300)}) → ${result.slice(0, 1200)}`;
  }
  // out of steps → force a final answer from what we gathered
  try {
    const res = await complete([{ role: 'user', content: `You are out of tool steps. Using ONLY the work below, give Zoe the complete grounded answer to: "${String(userMessage).slice(0, 800)}".${history}\n\nReply with the answer text only.` }], cOpts);
    const text = (typeof res === 'string') ? res : ((res && res.text) || '');
    return _finalize(steps, text.trim() || null);
  } catch { return _finalize(steps, null); }
}

module.exports = { runOperator, parseAction, isDirectedTask, parseSliceResult, operatorModel, _operatorComplete, TOOL_SPEC, TOOL_SPEC_CORE, TOOL_SPEC_TAIL, DEFAULT_MAX_STEPS };
