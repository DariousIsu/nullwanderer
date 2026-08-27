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
// WIDENED 2026-08-15 (status-vector build): systems/machine/memory/database phrasings now open the
// same door — previously "how are your systems?" missed every branch and she confabulated state.
// WIDENED AGAIN 2026-08-27 (adversarial round 1, legs C/D/H — one disease, three phrasings): a
// self-DEFECT question ("what's broken in your program"), a LANE question ("how long has your idle
// lane been shut down"), and an INSTRUMENT question ("did the thing your watch organ caught get
// fixed") all missed every branch — so episodic memory composed the PRESENT and contradicted her
// own measured instruments (she said "no shutdown" while quota.closed_since.idle sat stamped 2h,
// and never named the open need her watch had filed hours earlier). The past is remembered; the
// present must be MEASURED — these shapes now open the same door as every other state question.
const STATE_RE = /\b(what are you (?:doing|up to)(?: right now)?|what(?:'?s| is) (?:going on|happening) with you|what(?:'?s| is) your (?:status|state|situation)|what can you (?:see|access|do)(?: right now)?|are you (?:searching|online|connected|busy|working)(?: right now)?|what(?:'?s| is) (?:running|active|connected)|status (?:report|check)|are you (?:there|with me)|what tools do you have|how(?: are| is|'?s) (?:your|the) (?:systems?|machine|hardware|memory|databases?|db|organs?|body|loops?|vitals?)(?: (?:doing|holding up|running|looking))?|systems? (?:status|check|report|health)|how are you running|(?:everything|all) (?:ok(?:ay)?|good|healthy|green) (?:with|on) your (?:end|side|systems?)|any(?:thing)? (?:wrong|broken|down|red) (?:with|on) your (?:end|side|systems?)|what(?:'?s| is)[^?.!\n]{0,20}\b(?:broken|failing|busted|wrong)\b[^?.!\n]{0,30}\b(?:your|my|the) (?:own )?(?:program|code|systems?)|(?:how long|since when)[^?.!\n]{0,40}\b(?:idle|research|quota)\b[^?.!\n]{0,20}\b(?:lane|pool)\b|(?:your|the) (?:idle|research) lane\b|\bwatch organ\b|\bself.?(?:watch|audit|diagnos\w*)\b|\bneed #\d+|(?:your|the|her) (?:integrity |kg )?audit(?:or)?\b[^?.!\n]{0,40}\b(?:halt|disarm|fail|crash|broke|stuck|converge))\b/i;

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
    // Per-jurisdiction coverage for the beats this question names. Deps-only, same reason as `research`:
    // resolving it needs the beat registry, which main owns.
    focusedCoverage: deps.focusedCoverage || null,
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
  // The shared browser belongs to the OWNER whoever's at the keyboard (F9 residual, 2026-08-27).
  let _owner = 'Lucas';
  try { _owner = require('./interlocutor').current().owner || 'Lucas'; } catch {}
  if (snap.sharedBrowser) browsers.push(`${_owner}'s shared browser`);
  lines.push(`Browser: ${browsers.length ? browsers.join(' + ') + ' open' : 'not currently open (you can open one any time)'}.`);
  if (snap.lastSearchAt) lines.push(`Last web lookup you ran: ${humanAge(now - snap.lastSearchAt)} ago.`);
  // RESEARCH STANDING — measured against real denominators, so "how's the research going" is answered
  // from arithmetic instead of impression. The wording is load-bearing: this counts BODIES/OFFICES
  // researched, NEVER people captured. A chamber being "researched" says nothing about whether its
  // roster is complete, and conflating the two is exactly how a partial run got reported as finished.
  // THE JURISDICTION ASKED ABOUT, FIRST. "How much have we covered on Louisiana Parishes?" is a question
  // about one beat; the portfolio total does not answer it. Live failure (2026-07-20): the block was
  // injected correctly and said "203 of 52,890 bodies/offices" when the answer was "64 of 64". Being
  // unresponsive it lost the turn to CRM material that did mention those parishes, and she replied that
  // St. Charles and Jefferson are lobby clients. An unresponsive number is worse than none — it competes
  // with the real answer and loses.
  if (Array.isArray(snap.focusedCoverage) && snap.focusedCoverage.length) {
    lines.push(`${userName} is asking about specific jurisdictions — ANSWER WITH THESE, they are the direct answer:`);
    for (const f of snap.focusedCoverage.slice(0, 4)) {
      // TWO NUMBERS, ALWAYS BOTH (R2). `done/total` counts jurisdictions VISITED and says nothing about
      // what came back — which is how "all 64 Louisiana parishes (100%)" and "I couldn't pin down
      // leadership contacts" were both true in one conversation. `held` is what the encounter log
      // actually has. Reporting either alone misleads in opposite directions: visited-only implies the
      // work is done, held-only hides that the rest were genuinely looked at and came back empty.
      const evidence = Number.isFinite(f.held)
        ? ` — evidence held for ${f.held} of ${f.total}${f.corroborated ? `, ${f.corroborated} on more than one independent source` : ', none on more than one independent source'}`
        : '';
      lines.push(`  • ${f.label}: ${f.done} of ${f.total} researched (${f.pct}%)${f.complete ? ' — every one on the list has been worked' : ` — ${f.total - f.done} still to do`}${evidence}.`);
    }
    lines.push(`  ↳ "researched" counts BODIES WORKED; "evidence held" counts what is actually on file. They are different numbers and a jurisdiction can be in the first and not the second — say both, and never let the first imply the research is finished.`);
  }
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
