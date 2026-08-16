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
// MULTI-ACTION STEPS (build plan 2.4). A step is one MODEL ROUND-TRIP, and round-trips — not tool
// executions — are what the 4-step budget was really rationing. Letting one step carry several
// independent lookups is a direct engine-starvation lever: the same budget now buys up to 4× the
// evidence. Distinct from model fan-out, which stays refused; this spends TOOL calls, not tokens
// on parallel models.
const MAX_BATCH = 4;

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
    lane: opts.lane || undefined,   // spend tier for the choke-point quota gate; unset = interactive (ungated)
    headers: src.token ? { Authorization: `Bearer ${src.token}` } : {},
    // think:false UNCONDITIONALLY — the step contract is ONE clean JSON object (or plain prose for
    // the final answer); without it the model buries the step in message.thinking and the parsed
    // .text is chain-of-thought (the condenseComplete disease, same door).
    // ⭐ This was `isReasoningModel(model) ? …` and that name-list is exactly the wrong shape of
    // guard. Measured live 2026-07-31: model.operator = "deepseek-v4-flash", which the regex misses
    // (it knows "deepseek-r1"), so EVERY research gathering pass ran with thinking ENABLED and
    // pickText handed the chain-of-thought back as the answer. No operator step ever wants CoT as
    // its output, for any model, so the flag does not belong behind a model name — enumerating
    // reasoners means the next one silently reopens this. Safe on non-reasoners: decomp_lane sends
    // think:false unconditionally to gemma4:31b-cloud and runs clean all boot.
    think: false,
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
- open_page {"url":"…"}         open a SPECIFIC page in her browser and read it in full — use this to go DEEPER into a good source instead of bouncing to a new search: follow a promising link you saw, or go straight to an org's own /team, /leadership, /about, or /contact page. A blocked or JS-dead page AUTO-ESCALATES (plain fetch → archive snapshot → her vision) and the result is labeled with which door worked — so do NOT give up on a source just because the first open was walled
- forecast_query {"query":"…"}  HER OWN probability model (2026 balance-of-power: full House + Senate Monte-Carlo, calibrated). Chamber toplines always; query pulls specific races ("louisiana senate", "PA-07"). For ANY who-wins / odds / seat-count question, read THIS before reasoning from memory — it is her model, not a web guess
- web_click {"handle":"L3"}     click an element on the OPEN page by its handle from the page's "Interactive elements" list — page through a directory, open a bio, dismiss an interstitial. Reads the new page for you
- web_type {"handle":"I1","text":"…"}   type into an input on the open page — a site's OWN search box beats guessing URL shapes. Reads the result
- page_back {}                  go back one page in her browser and read where you land
- browser_read {}               read the page currently open in her browser
- file {"op":"read|write|append|list","path":"notes/x.md","content":"…"}   her workspace files
- puller_add {"company":"…","contacts":[{"name":"…","title":"…","email":"…","phone":"…","verified":true}]}   BANK the real people you found into Puller (our contact store) — it learns the company's email pattern + grades confidence. On a CONTACTS task, call this as you find each executive: name + title always; email/phone when found; verified:true ONLY if the email came from an official/public source (else it's treated as a pattern candidate)
- source_map {"focus":"optional topic"}   HER OWN SOURCE CODE — the file map of the program she runs on, RANKED by how much the rest of the code leans on each module (pass focus to pull the map toward a topic). Use for "how am I coded / where does X live"
- source_read {"path":"lib/board.js","offset":0}   read one of her own source files (read-only; code + docs only — data, logs, and secrets are unreachable). A long file returns ONE PAGE plus a note naming the exact next call — repeat with the offset it gives (or an @char from source_outline) until you have what you need; page 2 is never a guess
- source_search {"pattern":"…"}         search ALL her source for a string/regex ("where is X implemented", "who calls Y") — the whole repo is scanned, results come back file:line
- source_outline {"path":"main.js"}     the symbol map of ONE file: functions/classes/exports with line + @char addresses — navigate a huge file first, then source_read {"offset":<@char>} to start exactly at the symbol you want
- log_read {"file":"boot_postcrash_20260806.log","grep":"stall|error"}   read HER OWN boot logs (boot*.log / *.err.log only) — tail (default 200 lines) or grep. Use for "what happened in my logs / did X error"
- git_log {"limit":20,"since":"3 days ago","path":"lib/board.js"}   her own commit history, read-only — what changed in her code and when
- git_show {"ref":"HEAD~1","offset":0}   one commit's stat+diff, cursor-paged like source_read — follow the note's offset for the next page
- obs_query {"lane":"heartbeat","since_min":240,"grep":"suppressed"}   her self-watch event stream (obs_events): anomalies + lane events, newest first. Use when investigating her own recent behavior
- self_test {"suite":"smoke_board.js"}  run her own offline verification gate — ONE named suite in seconds, or omit suite for the FULL gate (minutes; use sparingly). The honest answer to "am I healthy?"
- rehearsal_create {"slug":"my-idea"}   REHEARSE a change to her own code: a full working COPY of her source (the live program is never touched). Then rehearsal_edit {"slug","path","find","replace"} (find must match EXACTLY ONCE — read the file first), rehearsal_test {"slug","suite":"smoke_x.js"} to judge it with her own gate, rehearsal_diff {"slug"} for the honest change report, rehearsal_discard {"slug"} when done. NOTHING here can change the live program — a good rehearsal ends as a diff+verdict report for Lucas
- rehearsal_write {"slug","path":"tools/x.py","content":"…"}   BUILD A NEW python tool (tools/<name>.py) you don't have yet, or its harness (scripts/smoke_<name>.js). The harness shells your python via process.env.ZOE_PY and prints PASS/FAIL; judge it with rehearsal_test {"slug","suite":"smoke_x.js"}. NEW files only (change existing source with rehearsal_edit). This is how she writes and runs her own scripts — still sandboxed, still ends as a proposal for Lucas
- analyze_data {"code":"import zoe_data\nprint(zoe_data.tables('sq'))\ncols, rows = zoe_data.query('sq', 'SELECT COUNT(*) FROM documents')\nprint(rows)"}   RUN a one-off python ANALYSIS over her OWN data, READ-ONLY (the Echo venv's python + pandas). \`import zoe_data\`; \`zoe_data.dbs()\` lists the stores (sq = short-term memory, graph = the civic KG, news, puller, electoral = the CRM); \`zoe_data.atlas()\` maps EVERY store's tables in one call — run it first when unsure where data lives; \`zoe_data.tables(db)\` / \`zoe_data.schema(db, table)\` DISCOVER one shape — always look before you query, never guess a table name; \`zoe_data.query(db, sql, params)\` → (cols, rows). DB writes are REJECTED; your prints ARE the result. Pass \`"workbench":"<slug>"\` to work in a PERSISTENT per-problem directory — files you write there survive between calls, so you can save intermediate results, re-run with fixes, and ITERATE toward a solution instead of one-shotting (no workbench = ephemeral, discarded after). Reach for this when a plain lookup can't answer — aggregate / cross-tabulate / compute over her data. This python may ALSO reach a PUBLIC data API over the network (urllib to api.open.fec.gov, projects.propublica.org, data.gov, etc.) to fetch EXTERNAL rows, then aggregate/rank them — the read-only jail applies only to the local SQLite stores; outbound HTTP is permitted. For a LARGE external aggregation (hundreds+ of rows), write ONE script that fetches + aggregates + prints the ranking. FILTER SERVER-SIDE first — public data APIs take params (office / state / cycle / min_amount / date) so you pull only the SUBSET you need, never every page (e.g. FEC schedule_e with candidate_office=H, candidate_state=FL, cycle=2024, min_amount=5000, per_page=100). If a source is STILL too big or rate-limits you, PIVOT to its BULK-DATA download and process the file LOCALLY instead of paging record-by-record — FEC bulk data at fec.gov/data/browse-data/?tab=bulk-data, IRS-990 the AWS 990 index at s3.amazonaws.com/irs-form-990, USAspending its bulk download — fetch the file ONCE into a workbench, then query it. Never page through thousands of records one at a time; when the per-record API can't finish, the bulk file IS the workaround
- skill_pull {"name":"the-skill-slug"}  pull a SKILL body off her shelf (proven procedures, replay flows, stored shapes) — the brief's SKILLS ON THE SHELF lines name what matches; pull only what you will actually follow
- rehearsal_drive_start {"slug":"my-idea","goal":"<one sentence: the change to attempt>","suite":"smoke_x.js","files":["lib/x.js"],"study":"<what you RESEARCHED about the technique + source URLs>"}   journal an ITERATING rehearsal run (one at a time) — the loop then edits, tests, and reads its own failures across ticks. RESEARCH FIRST, like any other claim: before starting, search how existing projects/docs implement the technique and READ them — then pass what you learned as "study" WITH source URLs. External code is reading material ONLY: it teaches the pattern, your own hands write the implementation, and nothing you found ever executes. rehearsal_drive_iterate {} advances it one bounded step; rehearsal_drive_status {} reads where it stands. Green ends as a PROPOSAL CARD document (it cites your study sources) — nothing ever self-adopts`;

const TOOL_SPEC_TAIL = `To use a tool, reply with ONE JSON object and nothing else:
  {"thought":"why","action":{"tool":"echo","args":{"need":"…"}}}
When several lookups DON'T DEPEND ON EACH OTHER, ask for them together in one step — you get all the results back at once and it costs you one step instead of ${MAX_BATCH}:
  {"thought":"why","actions":[{"tool":"echo","args":{"need":"…"}},{"tool":"recall","args":{"query":"…"}}]}
Up to ${MAX_BATCH} per step. Batch ONLY when no action needs another's result — if step B's arguments depend on what A returns, they are two steps, and pretending otherwise just wastes a lookup on arguments you had to guess.
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
      if (o && (o.action || o.actions || o.final !== undefined)) return o;
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
  return /"actions?"\s*:|"final"\s*:/.test(String(text || ''));
}

/**
 * The step's action list, normalised. One `action` and a list of `actions` become the same thing so
 * the loop below has exactly one shape to execute. Over-long batches are TRIMMED rather than
 * refused — the first MAX_BATCH are real work and dropping them to punish a formatting excess helps
 * nobody — and the drop is reported in history so the model can re-ask for what it lost.
 */
function actionsOf(parsed) {
  const raw = Array.isArray(parsed && parsed.actions) ? parsed.actions
    : (parsed && parsed.action ? [parsed.action] : []);
  const list = raw.filter((a) => a && typeof a.tool === 'string' && a.tool.trim())
    .map((a) => ({ tool: a.tool.trim(), args: (a.args && typeof a.args === 'object') ? a.args : {} }));
  return { list: list.slice(0, MAX_BATCH), dropped: Math.max(0, list.length - MAX_BATCH) };
}

// Tools that are side-effect-free and safe to run AT THE SAME TIME. This is the operator's own
// small menu, so naming it here is the module describing its own surface — not a guess about
// Echo's 500-tool catalog, which `echo` reaches through its own tier gate.
//
// `echo` is deliberately ABSENT even though it is the most-used tool: routeNeed may pick a WRITE
// on an interactive turn, and a maybe-write has no business in a parallel batch. It still batches
// fine — just sequentially — and the round-trip saving, which is the actual lever, is banked either
// way. Concurrency is only the latency bonus.
const READ_SAFE = new Set([
  'web_search', 'web_fetch', 'web_extract', 'news_search', 'browser_read', 'see_page',
  'recall', 'localdb', 'localdb_map', 'source_map', 'source_read', 'source_search', 'source_outline',
  'log_read', 'git_log', 'git_show', 'obs_query',
  'kg_search', 'kg_neighborhood', 'knowledge_search', 'gov_funding', 'fec_lookup',
  'bill_lookup', 'nonprofit_lookup', 'nonprofit_financials', 'forecast_query', 'skill_pull',
  'rehearsal_diff', 'rehearsal_drive_status',
]);

// Tools that must be the LAST thing in their step, because the next sensible decision depends on
// seeing what they did. All four drive the one shared browser page: batching two clicks without
// looking in between is blind clicking, and no prompt instruction reliably prevents a model from
// trying it. Anything after one of these is dropped and reported, so the model re-asks having
// actually seen the page.
const OBSERVE_AFTER = new Set(['open_page', 'web_click', 'web_type', 'page_back']);

/** Trim a batch at the first action whose result must be observed before the next is chosen. */
function cutAtObservePoint(list) {
  const i = list.findIndex((a) => OBSERVE_AFTER.has(a.tool));
  if (i === -1 || i === list.length - 1) return { list, deferred: [] };
  return { list: list.slice(0, i + 1), deferred: list.slice(i + 1) };
}

/** May these run CONCURRENTLY? Only when every one of them is known side-effect-free. */
function batchIsReadOnly(list) {
  return list.length > 1 && list.every((a) => READ_SAFE.has(a.tool));
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

// EXECUTION/PRODUCTION imperatives (D-route, 2026-08-16 drill): TASK_RE keys on research/assignment
// verbs, but a directed CODE/ANALYSIS order ("write a python script … run it … paste the output",
// "pull up the CRM and count the rows … print the numbers") carries none of them and fell through to
// route=status → the operator never fired and she narrated "I'm on it" (T6/T8). An exec imperative is
// an order to DO. Bare "run it" is deliberately EXCLUDED (an execution OBJECT is required) so "run it
// by legal" stays conversational; the interrogative-lead exclusion keeps "how do I run it?" a question.
const EXEC_RE = /\b(run (?:it|the|this|that) (?:script|query|code|analysis|again)|execute (?:it|the|this|that)|paste (?:the )?(?:output|result|numbers?|rows?|count)|print (?:the )?(?:output|result|numbers?|rows?|count)|save (?:it|the (?:output|file|script)))\b/i;
const EXEC_LEAD_RE = /^(?:please\s+)?(?:write|make|build|create|generate|compile|run|execute|pull\s+up)\b/i;
const INTERROG_LEAD_RE = /^\s*(?:how|what|where|when|why|who|which|is|are|do|does|did|can|could|should|would|will|have|has|had)\b/i;

function isDirectedTask(text) {
  const s = String(text || '');
  if (s.length < 6) return false;
  const taskHit = TASK_RE.test(s);
  const execHit = (EXEC_RE.test(s) || EXEC_LEAD_RE.test(s.trim())) && !INTERROG_LEAD_RE.test(s);   // exec imperative, not a question
  if (!taskHit && !execHit) return false;
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

// ── HISTORY COMPACTION (2.5.4 → O1 circulation spec) ─────────────────────────────────────────
// A 24-step review at full-size tool results is ~½MB of raw history — past the model window, the
// daemon silently keeps the TAIL, so the EARLIEST reads (the map, the first files) are exactly
// what dies. Compact instead: threshold derived from the ACTUAL resolved window (never a
// literal), boundary-safe (whole steps only), tool-results-first (an old step's RESULT trims to
// a stub; its step line survives), marked (a visible note names what was trimmed), verified (the
// caller re-measures). The newest keepTail steps stay verbatim — recency is where the work is.
function compactHistory(parts, { budgetChars, keepTail = 3, stubChars = 240 } = {}) {
  const size = (arr) => arr.reduce((n, p) => n + p.length, 0);
  if (size(parts) <= budgetChars) return { parts, compacted: 0 };
  const out = parts.slice();
  let compacted = 0;
  for (let i = 0; i < out.length - keepTail && size(out) > budgetChars; i++) {
    if (out[i].length <= stubChars + 160) continue;          // already small — not worth a stub
    // frame-safe: a web result carries a content-firewall frame whose head promises "only the
    // matching closer ends this block" — a bare slice would leave it open over later steps.
    out[i] = require('./content_firewall').truncateFramed(out[i], stubChars) + ' … [RESULT COMPACTED to fit the window — the step line is intact; re-run the tool if you still need the rest]';
    compacted++;
  }
  return { parts: out, compacted };
}

// Verification runs OFF the wall-clock (2.5.4: self_test out-of-band) — a minutes-long gate run
// must not eat the review's thinking budget. Its elapsed time is refunded to the loop's clock.
const FREE_CLOCK = new Set(['self_test']);

/**
 * Run the agent loop. deps.complete(messages)->{text}|string ; deps.tools = { web_search, echo,
 * browser_read, recall, file } each (args)->string. Returns { answer, steps, toolsUsed } or null.
 */
async function runOperator({ userMessage, context = '', deps = {}, maxSteps = DEFAULT_MAX_STEPS, maxMs = DEFAULT_MAX_MS, numPredict = 900, model = null, toolSpec = null, lane = null } = {}) {
  const complete = deps.complete || _operatorComplete;
  const tools = deps.tools || {};
  const nowFn = deps.now || Date.now;
  if (!userMessage || typeof complete !== 'function') return null;
  let t0 = nowFn();                 // let: FREE_CLOCK tools refund their elapsed time
  const steps = [];
  // History is an ARRAY of per-step entries (the compaction unit — boundary-safe by construction);
  // a running note tells the model when older results have been stubbed.
  const histParts = [];
  let _compactedTotal = 0;
  const _renderHistory = () => (_compactedTotal ? `\n[NOTE: ${_compactedTotal} earlier tool result(s) were compacted to stubs to fit the window — re-run a tool if you need its full output]` : '') + histParts.join('');
  // numPredict governs how big the model's response (incl. the {final:…} deliverable) can be — large
  // for directed tasks so a long list/write-up isn't truncated at generation. model = optional cloud
  // model override (per-lane); toolSpec = optional lane-scoped tool menu.
  // lane = the SPEND TIER for the quota gate at the ollama choke point (M1.1b). Autonomous callers
  // opt in ('research'/'directed'); unset stays 'interactive' (never throttled) so the reply path
  // and every legacy caller are untouched. A deferral surfaces as the caller's normal cloud-miss.
  const cOpts = { num_predict: numPredict, ...(model ? { model } : {}), ...(lane ? { lane } : {}) };
  const capChars = _contextCap();
  // The history budget is a FRACTION OF THE RESOLVED WINDOW (O1 — never a constant): ~45% of
  // num_ctx at ~3.2 chars/token leaves the rest for identity/context/user message/generation.
  // Resolution failure holds the cloud_window FLOOR's share — still window-derived, just the floor.
  let histBudget = Math.floor(require('./cloud_window').FLOOR * 3.2 * 0.45);
  try {
    const w = await require('./cloud_logic').resolveWindow(cOpts.model || null);
    if (w && w.num_ctx) histBudget = Math.floor(w.num_ctx * 3.2 * 0.45);
  } catch { /* floor share stands */ }
  let repaired = false;
  // FORCE A FINAL from the work already gathered — the same compile the out-of-steps path uses.
  const _forceFinalFromWork = async () => {
    try {
      const res = await complete([{ role: 'user', content: `You are out of tool steps. Using ONLY the work below, give Zoe the complete grounded answer to: "${String(userMessage).slice(0, capChars)}".${_renderHistory()}\n\nReply with the answer text only.` }], cOpts);
      const ft = (typeof res === 'string') ? res : ((res && res.text) || '');
      return ft.trim() || null;
    } catch { return null; }
  };
  // A chunk of model text that carried NO runnable step. Genuine PROSE is the answer. But a JSON step-object
  // that carried neither an action nor a final — the model NARRATING being done ({"thought":"I've completed
  // the review…"}) instead of emitting {"final":…} — must NOT be voiced: returning it shipped raw {"thought":…}
  // JSON to Lucas, which read as a defer ("starting on that now"). Compile the real answer from gathered work
  // instead; null (cloud down / nothing gathered) drops the turn to a normal local reply, never to raw JSON.
  const _answerFromLeftover = async (leftover) => {
    const t = String(leftover || '').trim();
    // A genuine answer is natural language — it NEVER starts with "{". Anything "{"-leading here is a JSON
    // artifact (a bare {"thought":…} narration, an actionless object, or truncated JSON — a real {"final":…}
    // was already returned upstream), and looksLikeJsonStep misses the bare-thought case, so key off the brace.
    if (t && !t.startsWith('{')) return t;            // genuine prose → the answer
    if (!steps.length) return null;                  // JSON artifact / empty + nothing gathered → nothing to voice
    return await _forceFinalFromWork();              // narrated-done / un-parseable JSON → compile from work
  };
  for (let i = 0; i < maxSteps; i++) {
    if (nowFn() - t0 > maxMs) break;   // over the wall-clock budget → stop looping, force a final below
    // Compact BEFORE building the prompt, and verify the drop actually happened (O1: eviction is
    // measured, never assumed) — an over-budget history that stubs down still reads coherently.
    if (histParts.reduce((n, p) => n + p.length, 0) > histBudget) {
      const r = compactHistory(histParts, { budgetChars: histBudget });
      histParts.length = 0; histParts.push(...r.parts);
      if (r.compacted) { _compactedTotal += r.compacted; console.log(`[operator] history compacted — ${r.compacted} older result(s) stubbed (budget ${histBudget}ch)`); }
    }
    const history = _renderHistory();
    let res;
    try { res = await complete(_buildPrompt({ userMessage, context, history, stepsLeft: maxSteps - i, toolSpec }), cOpts); }
    // A quota deferral is a PAUSE signal, not a failure — rethrow the typed error so the opt-in
    // caller can distinguish "no work happened" from "nothing new" (the false-validated grinder:
    // every deferred pass read as dry → target marked validated with zero actual work).
    catch (e) { if (e && e.deferred) throw e; return steps.length ? _finalize(steps, null) : null; }
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
          { role: 'user', content: 'That was not a parseable step. Re-emit it as EXACTLY ONE valid JSON object — {"thought":"…","action":{"tool":"…","args":{…}}}, or {"thought":"…","actions":[{"tool":"…","args":{…}},…]} for independent lookups, or {"thought":"…","final":"…"} — and nothing else.' }
        ], cOpts);
        const t2 = (typeof r2 === 'string') ? r2 : ((r2 && r2.text) || '');
        const p2 = parseAction(t2);
        if (p2) { parsed = p2; text = t2; }
      } catch { /* repair is best-effort — fall through to the prose contract */ }
    }
    if (!parsed) return _finalize(steps, await _answerFromLeftover(text));  // plain prose → answer; leaked JSON → compile
    if (parsed.final !== undefined) return _finalize(steps, parsed.final);

    // ── MULTI-ACTION STEP (2.4). One round-trip may carry several INDEPENDENT lookups. ──────────
    const { list: asked, dropped } = actionsOf(parsed);
    if (!asked.length) return _finalize(steps, await _answerFromLeftover(text));   // step object w/ no runnable tool → compile, never voice raw JSON
    const { list: batch, deferred } = cutAtObservePoint(asked);

    // Run ONE action and shape its result. Factored out so the concurrent and sequential paths
    // cannot drift — the UNSATISFIED marker in particular must apply identically to both.
    const runOne = async ({ tool, args }) => {
      const fn = tools[tool];
      let result;
      const _tStart = nowFn();
      if (typeof fn !== 'function') result = `ERROR: no tool named "${tool}".`;
      else { try { result = await fn(args); } catch (e) { result = 'ERROR: ' + (e && e.message || e); } }
      if (FREE_CLOCK.has(tool)) t0 += nowFn() - _tStart;   // out-of-band: the gate run refunds the wall-clock
      // Sized to the same knob the chat-tag lane got in the cap purge (was 3000, then re-sliced to
      // 1200 in history — the agent "read" every tool result through a 1,200-char keyhole while the
      // chat lane read 24k). One cap, applied once; history carries the same text the step stored.
      result = String(result == null ? '' : result).slice(0, capChars);
      // EXPECT-VS-ACTUAL, mechanically: an empty or failed result is a SIGNAL, not an answer. Without
      // this the loop treated "no rows" as information gathered and moved on — absence read as the
      // answer. The marker makes the next step confront it: adjust, switch tools, or say plainly it
      // was not found (which is itself an honest finding — never a silent shrug).
      const _flat = result.trim();
      if (!_flat || /^ERROR/i.test(_flat) || /^(no rows|no result|none|not found|nothing|\[\]|\{\}|null)\.?$/i.test(_flat) || /returned nothing|no result from/i.test(_flat.slice(0, 80))) {
        result += `\n[UNSATISFIED: this result did not answer the need. Change approach — different args, a different tool — or state plainly that it was not found. Do not treat absence as the answer.]`;
      }
      return { tool, args, result };
    };

    let done;
    if (batchIsReadOnly(batch)) {
      done = await Promise.all(batch.map(runOne));            // side-effect-free → run them together
    } else {
      done = [];
      for (const a of batch) done.push(await runOne(a));      // declared order, one at a time
    }
    for (const d of done) steps.push(d);

    // History labels a batch as ONE step with lettered parts, so the model reads its own request
    // back in the shape it sent — and a result it never got is NAMED rather than silently missing.
    // Built as ONE entry per step (the compaction unit).
    let entry;
    if (done.length === 1) {
      entry = `\n• step ${i + 1}: ${done[0].tool}(${JSON.stringify(done[0].args).slice(0, 300)}) → ${done[0].result}`;
    } else {
      entry = `\n• step ${i + 1} (${done.length} together):`;
      done.forEach((d, k) => { entry += `\n  ${String.fromCharCode(97 + k)}. ${d.tool}(${JSON.stringify(d.args).slice(0, 300)}) → ${d.result}`; });
    }
    if (deferred.length) {
      entry += `\n  [NOT RUN: ${deferred.map((d) => d.tool).join(', ')} — "${batch[batch.length - 1].tool}" changes what is on the page, so decide those again now that you can see its result.]`;
    }
    if (dropped) entry += `\n  [NOT RUN: ${dropped} action(s) over the ${MAX_BATCH}-per-step limit — ask again for the ones you still need.]`;
    histParts.push(entry);
  }
  // out of steps → force a final answer from what we gathered (same compile as the narrated-done path)
  return _finalize(steps, await _forceFinalFromWork());
}

module.exports = { runOperator, parseAction, looksLikeJsonStep, isDirectedTask, parseSliceResult, operatorModel, _operatorComplete, TOOL_SPEC, TOOL_SPEC_CORE, TOOL_SPEC_TAIL, DEFAULT_MAX_STEPS, actionsOf, batchIsReadOnly, cutAtObservePoint, compactHistory, FREE_CLOCK, MAX_BATCH, READ_SAFE, OBSERVE_AFTER };
