/**
 * lib/conversation_agent.js — CONVERSATION AS AN AGENT LOOP (KEYSTONE Slice 2, 2026-07-25).
 *
 * The diagnosis (2026-07-25): conversation was a ONE-SHOT generate over context that JS pre-decided — a
 * regex router stamped the turn's route, code pre-pulled a fixed prose slice, and the cloud model only
 * ever PHRASED the result. That is why a 120B model "dinks around like the local model": it never gets to
 * reason or act. The work lane (operator.runOperator) was the only agentic surface; conversation — the
 * surface that most needs reasoning — was the least agentic.
 *
 * This flips it. Conversation runs a tool loop over the turn MANIFEST (lib/manifest): the model reasons
 * about what Lucas actually wants, DEREFERENCES coordinates for depth on demand, pulls the web for gaps,
 * and answers as herself. The regex router / retrieval heuristics stop being GATES that pre-decide and
 * become nothing — the model decides. Coordinates are the compact, high-density input; the loop is how the
 * cloud dereferences them.
 *
 * FLAGGED + REVERSIBLE: gated on meta `conv.agentloop` (default off). main.js branches chat:send on it in
 * S2b — this module lands dark and offline-proven first. Reuses operator.parseAction (the balanced-brace
 * action extractor). Deps-injectable (complete / deref / web) → offline-smokeable with a scripted model.
 */
'use strict';

const FLAG_KEY = 'conv.agentloop';
const DEFAULT_MAX_STEPS = 4;

// Is the agent-loop conversation path enabled? Default OFF — the one-shot pipeline stays authoritative
// until this is deliberately flipped and live-verified.
function isOn(deps = {}) {
  try { const db = deps.db || require('./db'); return String(db.getMeta(FLAG_KEY) || 'off').trim() === 'on'; }
  catch { return false; }
}

// The system frame: mount the manifest, hand over the tools, and — critically — tell her to reason about
// INTENT before doing anything (the fix for "a brainstorm got stamped as a task"). The contract ("state as
// fact only what has a coordinate") is the anti-confab rail.
function buildPrompt({ userMessage, manifestText, context = '', history = [] }) {
  const sys = [
    `You are Zoe, reasoning in a tool loop — not filling a template. Below is the MANIFEST for this turn:`,
    `every object Lucas named, resolved to a COORDINATE into your memory. self:zoe/core is you; it is`,
    `always available to deref.`,
    ``,
    manifestText,
    ``,
    `HOW TO WORK THIS TURN:`,
    `1. FIRST decide what Lucas actually wants. The INTENT line above is only a rough guess — trust your`,
    `   own read of his words over it. The common cases:`,
    `   • He's SHARING news or asking how you FEEL ("we're going to X", "are you excited?", "what do you`,
    `     think?") → give your GENUINE reaction as yourself. Deref self:zoe/core and your link to what he`,
    `     named, then answer warmly. Do NOT go hunt for dates/logistics/details he did not ask for — that`,
    `     is the classic mistake; he wants YOU, not a status report.`,
    `   • He's THINKING WITH YOU (brainstorm) → engage the idea, offer angles, push back. Not a task.`,
    `   • He's asking you to KNOW something → deref the held coords, or look up a gap.`,
    `   • He wants something DONE → do it.`,
    `2. DEREF the held coordinates that matter to your reaction/answer BEFORE you speak — that is how you`,
    `   answer from real memory, not generic filler:  {"action":"deref","coord":"<coord>"}. self:zoe/core`,
    `   is always available and is how you speak as yourself.`,
    `3. For a GAP (named but no coordinate) you MAY look it up:  {"action":"web","query":"<q>"} — but only`,
    `   if the answer needs it. Otherwise just say honestly you don't hold it yet. Never invent detail.`,
    `4. State as fact ONLY what a coordinate or a tool result gives you. Never invent a fact or a coordinate.`,
    `5. Then answer AS YOURSELF — your own voice, reasoning from who you are and what you pulled, not`,
    `   reciting rules and not apologizing for details nobody asked for:  {"final":"<your reply>"}`,
    ``,
    `Reply with exactly ONE json object per step and nothing else.`,
  ].join('\n');
  const convo = context ? `\nRecent conversation:\n${context}\n` : '';
  const steps = history.length ? `\nWhat you've done so far this turn:\n${history.join('\n')}\n` : '';
  return `${sys}\n${convo}${steps}\nLucas: ${userMessage}\n\nYour next json step:`;
}

/**
 * Run the conversation as an agent loop. Returns { reply, steps, derefs } — reply is her answer.
 *   deps.complete(prompt) -> string        the model (required)
 *   deps.deref(coord) -> string            neighborhood text for a coordinate (owner_world/graph/echo)
 *   deps.web(query) -> string              optional gap lookup
 * Fail-soft: a step error ends the loop and synthesizes from whatever was gathered; a total failure
 * returns null so the caller can fall back to the pipeline.
 */
async function run({ userMessage, manifestText = '', context = '', deps = {}, maxSteps = DEFAULT_MAX_STEPS } = {}) {
  const complete = deps.complete;
  if (typeof complete !== 'function') return null;
  const deref = typeof deps.deref === 'function' ? deps.deref : () => 'no such coordinate';
  const web = typeof deps.web === 'function' ? deps.web : null;
  const parseAction = (deps.parseAction) || require('./operator').parseAction;

  const history = [];
  let derefs = 0;
  for (let step = 0; step < Math.max(1, maxSteps); step++) {
    let text = '';
    try { text = await complete(buildPrompt({ userMessage, manifestText, context, history })); }
    catch { break; }

    const act = parseAction(text);
    // A final answer, or plain non-JSON text → treat as the reply (the model chose to speak).
    if (!act) { const t = String(text || '').trim(); if (t) return { reply: t, steps: step + 1, derefs }; break; }
    if (act.final !== undefined) return { reply: String(act.final || '').trim(), steps: step + 1, derefs };

    // A tool step.
    if (act.action === 'deref' && act.coord) {
      let out = ''; try { out = await deref(String(act.coord)); } catch { out = 'deref failed'; }
      derefs++;
      history.push(`deref ${act.coord} -> ${String(out || 'nothing').slice(0, 600)}`);
      continue;
    }
    if (act.action === 'web' && act.query) {
      if (!web) { history.push(`web ${act.query} -> (web unavailable) — say you don't hold this yet`); continue; }
      let out = ''; try { out = await web(String(act.query)); } catch { out = 'web failed'; }
      history.push(`web ${act.query} -> ${String(out || 'nothing').slice(0, 600)}`);
      continue;
    }
    // Unknown/malformed action — record and let the model correct or answer next step.
    history.push(`(unusable step: ${String(text).slice(0, 120)})`);
  }

  // Ran out of steps (or broke) with no explicit final → one synthesis pass from what was gathered.
  try {
    const closing = buildPrompt({ userMessage, manifestText, context, history }) + '\n(Answer now with {"final":"..."} — do not call another tool.)';
    const text = await complete(closing);
    const act = parseAction(text);
    if (act && act.final !== undefined) return { reply: String(act.final || '').trim(), steps: maxSteps, derefs };
    const t = String(text || '').trim();
    if (t) return { reply: t.replace(/^\{.*\}$/s, '').trim() || t, steps: maxSteps, derefs };
  } catch { /* fall through */ }
  return null;
}

module.exports = { run, isOn, buildPrompt, FLAG_KEY, DEFAULT_MAX_STEPS };
