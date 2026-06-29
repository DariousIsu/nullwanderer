/**
 * Cloud tool-router (Front/Cortex P3) — generalizes the brittle regex intent-nets into ONE cloud
 * decision. When the conversational front reaches for NO tool on a question it can't answer from
 * memory, the cloud Reasoner decides the surface: open-web lookup, OUR private data (Echo), or
 * nothing. The harness then dispatches through the EXISTING, already-gated paths (liveLookup /
 * echoSuit.routeNeed). So tool-calling lives in the cortex, not on the front model.
 *
 * SAFE SURFACES ONLY: her own browser (web) + Echo (our data). It does NOT route the shared
 * browser, the desktop os_* layer, or email — those stay gated / interceptor-driven. Conservative:
 * a light question gate avoids a cloud call on chit-chat; the planner defaults to "none". Fail-safe:
 * cloud down / malformed → { surface:'none' }, never throws. deps.ask injectable for tests.
 */
'use strict';
const cloud = require('./cloud_logic');

// A cheap gate so we never spend a cloud call on non-lookup chatter. Question / request shaped only.
// A "?" anywhere, OR a question-word at the START (so a declarative "that IS funny" doesn't trip
// the bare aux verbs), OR an explicit lookup/request verb anywhere.
const Q_RE = /\?|^\s*(what|whats|what's|who|whom|whose|when|where|which|how|why|is|are|was|were|did|does|do|can|could|would|has|have)\b|\b(find|look\s*up|search|pull\s*up|pull|fetch|get me|show me|tell me|remind me|list|how much|how many)\b/i;
function looksLikeLookup(text) {
  const s = String(text || '').trim();
  if (s.length < 6) return false;
  return Q_RE.test(s);
}

// Decide the tool surface for a turn. Returns { surface:'web'|'echo'|'none', arg, reason }.
async function planTool({ userMessage, deps = {} } = {}) {
  if (!looksLikeLookup(userMessage)) return { surface: 'none', reason: 'not a lookup' };
  const ask = deps.ask || cloud.ask;
  let plan = null;
  try {
    plan = await ask({
      task: 'tool_route', v: 1,
      input: { user: String(userMessage).slice(0, 600) },
      want: 'Decide whether answering this message needs an EXTERNAL lookup, and which source. Output ONLY JSON: '
        + '{"surface":"web"|"echo"|"none","arg":"the search query or data need","reason":"short"}. '
        + 'web = the OPEN INTERNET (current events, prices, weather, public facts, anything not private to us). '
        + 'echo = OUR PRIVATE data (the Rainey vault, our entity/contact/bill/LAMP knowledge graph, our own papers/records). '
        + 'none = answerable from memory or ordinary conversation. Your OWN past conversation / what you and the user discussed / your chat history is MEMORY → "none", never echo. Be conservative: choose "none" unless an external lookup is clearly needed.',
      validate: (raw) => {
        const m = String(raw || '').match(/\{[\s\S]*\}/);
        if (!m) return { valid: false, error: 'no json' };
        try { const o = JSON.parse(m[0]); return (o && o.surface) ? { valid: true, value: o } : { valid: false, error: 'no surface' }; }
        catch (e) { return { valid: false, error: e.message }; }
      }
    });
  } catch (e) { console.error('[tool_router] plan failed:', e.message); return { surface: 'none', reason: 'error' }; }
  if (!plan || !plan.surface || !['web', 'echo', 'none'].includes(plan.surface)) return { surface: 'none', reason: 'no plan' };
  if ((plan.surface === 'web' || plan.surface === 'echo') && !String(plan.arg || '').trim()) return { surface: 'none', reason: 'no arg' };
  return plan;
}

module.exports = { planTool, looksLikeLookup };
