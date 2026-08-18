'use strict';
/**
 * lib/chain_guard.js — the ANALYSIS + REPLAN layer for the echo-chain loop (fireToolFollowup, main.js).
 *
 * Principle (Lucas, 2026-08-18): no retry loop should hammer an approach it already knows fails. A loop
 * may take its full MAX_ECHO_HOPS budget, but each attempt must be DIFFERENT. So:
 *   - an EXACT repeat of a lookup already tried this turn is REFUSED (re-running it cannot help);
 *   - every NO-PROGRESS hop (empty retrieval, or a refused repeat) gets an analyze→replan nudge that
 *     names what was already tried and pushes a genuinely different approach (another tool/tier, or the
 *     web) — the chain CONTINUES, it does not die;
 *   - only when the no-progress budget is spent (she has run out of new approaches, or is hammering a
 *     known failure) does the loop fall back to an honest miss.
 *
 * A PRODUCTIVE chain — each hop returning new data toward the answer — resets the no-progress streak
 * and keeps its full MAX_ECHO_HOPS budget; this layer only bites a chain that keeps failing.
 *
 * Only RETRIEVAL tags are judged. A write/build hop (canvas add_block, propose, create/update)
 * legitimately returns little or no text and must NEVER be blocked or counted, or it resurrects the
 * document-chain-stall class this codebase already paid to fix.
 *
 * Pure + smoke-tested (scripts/smoke_chain_guard.js). No I/O, no requires.
 */

// A `do` tool whose job is looking something up (empty result = no progress). Writes / builds / heavy
// ops (create_*, update_*, propose_*, saga_canvas_*, run_*, promote_*, ...) do NOT match.
const RETRIEVAL_DO_RE = /^(?:search|get_|list_|find_|quick_lookup|db_query|kg_|knowledge_|contact_facets|bill_facets|summarize_universe|stats|research_brief)/i;

function isRetrievalTag(tag) {
  if (!tag || !tag.kind) return false;
  if (tag.kind === 'find' || tag.kind === 'recipe') return true;
  if (tag.kind === 'do') return RETRIEVAL_DO_RE.test(String(tag.name || ''));
  return false;
}

// Stable signature: the same tag + arg run twice in one turn is never progress.
function tagSignature(tag) {
  if (!tag || !tag.kind) return '';
  if (tag.kind === 'recipe') return `recipe:${String(tag.name || '').toLowerCase()}:${String(tag.arg == null ? '' : tag.arg).trim().toLowerCase()}`;
  if (tag.kind === 'find') return `find:${String(tag.query || '').trim().toLowerCase()}`;
  if (tag.kind === 'do') { let a = ''; try { a = JSON.stringify(tag.args || {}); } catch {} return `do:${String(tag.name || '').toLowerCase()}:${a}`; }
  return String(tag.kind);
}

// Human label for the "already tried" list — the tool/recipe name, not the full arg blob.
function tagLabel(tag) {
  if (!tag || !tag.kind) return '';
  if (tag.kind === 'recipe') return `recipe ${String(tag.name || '').trim()}`.trim();
  if (tag.kind === 'do') return String(tag.name || 'tool');
  if (tag.kind === 'find') return 'find';
  return String(tag.kind);
}

// After this many CONSECUTIVE no-progress retrieval hops (empty or refused-repeat), stop replanning
// and force the honest miss. Lucas 08-18: give her the FULL hop budget of DIFFERENT tries before she
// concedes — so this defaults to the same 12 as maxEchoHops, and main.js passes the live MAX_ECHO_HOPS
// as the ceiling so the two always track. A productive chain resets the streak on any real result.
const NOPROGRESS_CEILING = 12;

function newState() { return { seen: new Set(), tried: new Set(), noProgress: 0 }; }

/**
 * Fold one chain hop into the per-turn state and decide what the loop should do.
 * @param {{seen?:Set<string>, tried?:Set<string>, noProgress?:number}} state  mutable, carried on `io`
 * @param {{signature:string, label?:string, emptyThisHop:boolean, retrieval:boolean}} hop
 * @param {number} [ceiling]
 * @returns {{repeat:boolean, needsReplan:boolean, exhausted:boolean}}
 */
function evaluateHop(state, { signature, label, emptyThisHop, retrieval }, ceiling = NOPROGRESS_CEILING) {
  if (!state.seen) state.seen = new Set();
  if (!state.tried) state.tried = new Set();
  if (typeof state.noProgress !== 'number') state.noProgress = 0;
  const seenBefore = !!signature && state.seen.has(signature);
  if (signature) state.seen.add(signature);
  if (retrieval && label) state.tried.add(label);
  const repeat = seenBefore && !!retrieval;
  const noProgress = !!retrieval && (repeat || !!emptyThisHop);
  state.noProgress = noProgress ? state.noProgress + 1 : 0;   // any real progress resets the streak
  return { repeat, needsReplan: noProgress, exhausted: state.noProgress >= ceiling };
}

// The analyze→replan directive injected after a no-progress hop: name what failed, demand something
// different, and point at the web when our records likely don't hold it.
function replanNote(state, { userName = 'them' } = {}) {
  const tried = (state && state.tried && state.tried.size) ? Array.from(state.tried).join(', ') : 'the lookups so far';
  return `[ANALYZE & REPLAN — you've tried: ${tried}, and none produced the answer. Do NOT repeat any of them. Ask WHY they came up empty (our records may simply not hold this), then try a GENUINELY DIFFERENT approach — a different tool or recipe, or cross to the web (<web-open>… or <echo-do name="web_search">{"query":"…"}</echo-do>) if it's public info we don't store. If you've truly run out of new approaches, tell ${userName} plainly what you couldn't find and offer to look it up on the web — do not keep trying the same kind of lookup.]`;
}

// The final honest-miss directive when the no-progress ceiling is hit — she has replanned and still
// cannot land it (or is hammering a known failure).
function honestMissNote(state, { userName = 'them' } = {}) {
  const tried = (state && state.tried && state.tried.size) ? Array.from(state.tried).join(', ') : 'several lookups';
  return `[STOP LOOPING — you've tried ${tried} without landing it. Answer ${userName} NOW in your own voice: say plainly what you were looking for and could not find, and offer a concrete next step (e.g. look it up live on the web). Do NOT run another lookup and do NOT say you are fetching, checking, or gathering.]`;
}

module.exports = { tagSignature, tagLabel, isRetrievalTag, evaluateHop, replanNote, honestMissNote, newState, NOPROGRESS_CEILING, RETRIEVAL_DO_RE };
