/**
 * Live-state introspection (self-awareness, Layer 1) — let her READ her operational state
 * instead of inferring it.
 *
 * Why: she narrates "I think I looked that up" / "let me check" with no actual view of what's
 * running. This gives her a real snapshot — mode, who's present, whether the master KB (Echo) and
 * browsers are connected, when she last searched, what threads she's carrying — surfaced when
 * Lucas asks what she's doing / what she can see / what's her status. Grounds that class of answer
 * in fact, the same way the dev ledger grounds "what have you been working on".
 *
 * Reads live state from the real subsystems (db / availability / personal / web / browser); every
 * volatile bit is dep-injectable so the snapshot is fully smoke-testable with no db or runtime.
 */

// "What are you doing / what can you see / what's your status" — current operational state.
const STATE_RE = /\b(what are you (?:doing|up to)(?: right now)?|what(?:'?s| is) (?:going on|happening) with you|what(?:'?s| is) your (?:status|state|situation)|what can you (?:see|access|do)(?: right now)?|are you (?:searching|online|connected|busy|working)(?: right now)?|what(?:'?s| is) (?:running|active|connected)|status (?:report|check)|are you (?:there|with me)|what tools do you have)\b/i;

// COVERAGE questions — "how's the research going", "how much have we covered". Separate from
// STATE_RE because they are a different question with a different answer: state is what's running
// this second, coverage is how far the whole programme has got.
//
// Wiring the standing into the snapshot without this would have been INERT for the questions it
// exists to answer — none of the natural phrasings match STATE_RE (verified against it before adding).
//
// Deliberately NARROW: every branch requires a research/coverage noun, so a social "how's it going"
// or "how are you" never drags a progress ledger into a conversational turn.
const COVERAGE_RE = /\b(?:how (?:much|many|far)\b[^?.!]{0,40}\b(?:covered?|researched?|through|along|done)|how(?:'?s| is| are)\b[^?.!]{0,25}\b(?:research|coverage|rosters?)\b|(?:research|coverage)\s+(?:progress|standing|status)|what(?:'?s| is)\s+(?:our|the)\s+coverage|how many (?:bodies|offices|states|beats|chambers)\b)/i;

function detectStateQuestion(text) { return STATE_RE.test(String(text || '')); }
function detectCoverageQuestion(text) { return COVERAGE_RE.test(String(text || '')); }

function humanAge(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

// Gather a live operational snapshot. Every field is dep-injectable; otherwise read from the real
// subsystem (fail-safe to a benign default). echoConnected has no requireable source here (the
// suit lives in main), so it's deps-only.
function snapshot(deps = {}) {
  const pick = (v, fn, fallback) => { if (v !== undefined) return v; try { return fn(); } catch { return fallback; } };
  return {
    offClock: pick(deps.offClock, () => require('./personal').isOn(), false),
    away: pick(deps.away, () => require('./availability').isAway(), false),
    echoConnected: !!deps.echoConnected,
    sharedBrowser: pick(deps.sharedBrowser, () => require('./browser').isConnected(), false),
    ownBrowser: pick(deps.ownBrowser, () => require('./web').isConnected(), false),
    lastSearchAt: pick(deps.lastSearchAt, () => parseInt(require('./db').getMeta('last_search_at') || '0', 10), 0),
    threads: pick(deps.threads, () => require('./db').getActiveOpenThreads(3) || [], []),
    // Portfolio research standing (coverage_gaps.summarize). Deps-ONLY, deliberately: computing it
    // enumerates every beat's universe (tens of thousands of targets), which is main's cached job —
    // a lazy require here would put that cost on every status question.
    research: deps.research || null,
  };
}

// Render the snapshot as a context block — only the facts that are actually true/known.
function buildBlock(snap, userName = 'Lucas', now = Date.now()) {
  if (!snap) return null;
  const lines = [];
  lines.push(`Mode: ${snap.offClock ? 'off the clock (personal time)' : 'working / on the clock'}.`);
  lines.push(`${userName} is ${snap.away ? 'marked away right now' : 'here with you right now'}.`);
  lines.push(`Master knowledge base (Echo): ${snap.echoConnected ? 'CONNECTED — you can query it with your echo tags' : 'not connected this moment'}.`);
  const browsers = [];
  if (snap.ownBrowser) browsers.push('your own browser');
  if (snap.sharedBrowser) browsers.push("Lucas's shared browser");
  lines.push(`Browser: ${browsers.length ? browsers.join(' + ') + ' open' : 'not currently open (you can open one any time)'}.`);
  if (snap.lastSearchAt) lines.push(`Last web lookup you ran: ${humanAge(now - snap.lastSearchAt)} ago.`);
  // RESEARCH STANDING — measured against real denominators, so "how's the research going" is answered
  // from arithmetic instead of impression. The wording is load-bearing: this counts BODIES/OFFICES
  // researched, NEVER people captured. A chamber being "researched" says nothing about whether its
  // roster is complete, and conflating the two is exactly how a partial run got reported as finished.
  if (snap.research && snap.research.total > 0) {
    const r = snap.research;
    lines.push(`Elected-body research standing: ${r.done} of ${r.total} bodies/offices researched (${r.pct}%) — ${r.remaining} still outstanding, across ${r.beats} beats.`);
    lines.push(`  ↳ that is BODIES worked, NOT people on file; a chamber counted here may still have an incomplete roster. Never state or imply the research is finished from this number.`);
    if (r.emptyUniverseBeats) {
      lines.push(`  ↳ ${r.emptyUniverseBeats} beat(s) have NO worklist at all — a data gap on our side, not something researched or complete.`);
    }
  }
  if (snap.threads && snap.threads.length) {
    const t = snap.threads.slice(0, 3).map(x => (x && x.content) ? x.content : String(x));
    lines.push(`Active threads you're carrying: ${t.join('; ')}.`);
  }
  return `RIGHT NOW, OPERATIONALLY — your actual live state this moment. Speak from this if ${userName} asks what you're doing, what's running, or what you can see; do NOT guess or invent state:\n${lines.map(l => '  • ' + l).join('\n')}`;
}

module.exports = { detectStateQuestion, detectCoverageQuestion, snapshot, buildBlock, humanAge, STATE_RE, COVERAGE_RE };
