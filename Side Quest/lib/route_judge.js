'use strict';
/**
 * route_judge.js — the MODEL TIER behind the turn-router (2026-08-16, Lucas: "regex has a high fail rate").
 *
 * The turn-router's regex/signal cascade is a cheap deterministic FILTER that classifies the ~95% of turns
 * whose intent is lexically clear. When two strong signals disagree (isStatusReq AND factual, isAssignment
 * AND factual, factual AND personalFactQ), the cascade breaks the tie with a hardcoded precedence that can be
 * wrong — because intent is semantic and no regex can arbitrate. turn_router.resolveTurnRoute escalates ONLY
 * those conflicting turns here, to a single bounded model call that picks among the candidate routes. Mirrors
 * lib/importance.js / lib/renag_judge.js: tiny prompt, num_predict small, temperature 0, its own cloud model.
 *
 * FAIL-OPEN: any error / empty / out-of-menu reply → null, and resolveTurnRoute keeps the cheap decision. The
 * model only ever REFINES a genuinely ambiguous call; it never sees the clear majority (cost stays bounded).
 *
 * Run: node scripts/smoke_route_judge.js (injected classify — no network); live model proof in the drill log.
 */
const { streamChat } = require('./ollama');
const config = require('./config');

const MODEL = config.importanceModel();

// One-line description per route — what the user WANTS, phrased so the boundaries are sharp.
const _DESC = {
  task:     'TASK — a work assignment: go build / produce / compute / run a deliverable ("write a script and run it", "build me a brief", "count the contacts by state")',
  lookup:   'LOOKUP — a question about the EXTERNAL WORLD (people, orgs, bills, data, current events) that needs grounding or search — INCLUDING asking for the status, latest, or an attribute of an external thing ("the bill\'s current status", "latest on the hurricane")',
  status:   'STATUS — a check on how YOUR OWN active work is progressing ("how\'s the roster coming", "any update on that", "where are we so far")',
  answer:   'ANSWER — a question about shared history, a past decision you two made, or your own state / code, answered from memory (NOT the web)',
  contacts: 'CONTACTS — asking to list or pull people / contacts you already hold',
  converse: 'CONVERSE — chit-chat, opinion, or brainstorming with no concrete deliverable',
};
const _WORD2ROUTE = { TASK: 'task', LOOKUP: 'lookup', STATUS: 'status', ANSWER: 'answer', CONTACTS: 'contacts', CONVERSE: 'converse' };

// Parse the model's one-word reply into a route, validated against the candidate menu (if given).
function parseRoute(raw, candidates = null) {
  const m = String(raw || '').toUpperCase().match(/\b(TASK|LOOKUP|STATUS|ANSWER|CONTACTS|CONVERSE)\b/);
  if (!m) return null;
  const route = _WORD2ROUTE[m[1]];
  if (Array.isArray(candidates) && candidates.length && !candidates.includes(route)) return null;
  return route;
}

/**
 * classifyRoute(text, opts?) → Promise<route | null>
 *   candidates — restrict the menu + validate the answer to these routes (the router passes the conflict set)
 *   classify   — optional sync/async override for deterministic tests; bypasses the model
 * Returns a route string, or null (→ the router keeps its cheap decision).
 */
async function classifyRoute(text, { candidates = null, model = MODEL, classify = null } = {}) {
  const s = String(text || '').trim();
  if (!s) return null;
  if (typeof classify === 'function') { try { return (await classify(s, candidates)) || null; } catch { return null; } }

  const routes = (Array.isArray(candidates) && candidates.length) ? candidates.filter((r) => _DESC[r]) : Object.keys(_DESC);
  if (!routes.length) return null;
  const menu = routes.map((r) => _DESC[r]).join('\n');
  const words = routes.map((r) => r.toUpperCase());
  const messages = [{
    role: 'user',
    content:
`Classify what this user message is asking for. Pick the single best-fit option:

${menu}

Message: "${s.slice(0, 500)}"

Reply with ONLY one word: ${words.join(' or ')}.`,
  }];

  let raw = '';
  try {
    await streamChat({
      model,
      messages,
      options: { temperature: 0, top_p: 1, num_ctx: 8192, num_predict: 6 },
      think: false,
      onToken: (tk) => { raw += tk; },
    });
  } catch (e) {
    console.error('[route_judge] classify call failed:', e.message);
    return null;   // fail-open → router keeps the cheap decision
  }
  return parseRoute(raw, candidates);
}

module.exports = { classifyRoute, parseRoute, MODEL };
