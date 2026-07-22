/**
 * lib/autonomy.js — the idle tick DECIDES (docs/SUBCONSCIOUS_AUTONOMY_DESIGN.md, S1–S4).
 *
 * Lucas, 2026-07-20: "the cloud model should be getting enough to start making independent
 * decisions … autonomously in the pursuit of growing and cleaning the database or building
 * projects." And 2026-07-22: "she only looks up people for contact. She doesn't explore ideas,
 * and she doesn't engage on her own."
 *
 * Before this module, code picked every idle move (beat round-robin, graph-walk gap ranking over
 * proper nouns from recent chat) and the cloud only narrated. This is the inversion:
 *   S1 buildManifest — the live state of her OWN stores as counts and keys (absence gaps,
 *      cardinality universes, uncorroborated encounter clusters, her interests, her stalest
 *      threads) + what the last N ticks chose. Counts and keys, never rows.
 *   S2 decide — ONE structured cloud call: "given this state, what is the single highest-value
 *      move right now?" Returns a TYPED plan. `nothing` is a first-class answer — a decision
 *      layer that can never decline becomes a make-work generator.
 *   S3 buildOperatorBrief — the plan becomes a bounded operator run (the executor lives in
 *      main.js where the tools are). Reads wide, writes stay tier-gated (autonomous=true).
 *   S4 build — a `build` move instructs a real markdown artifact into notes/autonomy/ (the
 *      7-day audit measured 3,121 thoughts / 0 artifacts; this is the missing producer).
 *
 * Non-negotiables carried from the design: every tick emits a report line; never claim work
 * that did not happen (history records OUTCOMES, not plans); a wrong choice is cheap (bounded
 * steps/tokens, `nothing` always available); the tick's subject must never leak into chat
 * (only the heavily rate-limited `engage` move may speak, through the announce door).
 *
 * Pure decision logic + deps-injected IO → offline-smokeable (scripts/smoke_autonomy.js).
 */
'use strict';

const MOVES = ['research', 'fill-gap', 'corroborate', 'clean', 'build', 'maintain', 'engage', 'nothing'];
const HISTORY_KEY = 'autonomy.history';
const HISTORY_MAX = 12;

// ---- S1: THE TICK MANIFEST -------------------------------------------------
// Every source is independently guarded: a missing table or a failed query drops that section
// (and logs), never the manifest. Counts and keys, never rows — same lever as lib/package.js.
function _ago(now, ts) {
  if (!ts) return 'never';
  const d = Math.max(0, now - ts);
  if (d < 3600e3) return Math.round(d / 60e3) + 'm ago';
  if (d < 86400e3) return Math.round(d / 3600e3) + 'h ago';
  return Math.round(d / 86400e3) + 'd ago';
}

function buildManifest({ db = null, now = Date.now(), deps = {} } = {}) {
  const dbm = db || require('./db');
  let d = null;
  try { d = dbm.getDb(); } catch { /* no db → empty manifest, decide() will decline */ }
  const sections = [];
  const counts = {};
  const grab = (label, fn) => {
    try { const s = fn(); if (s) sections.push(s); }
    catch (e) { console.error(`[autonomy] manifest source failed (${label}):`, e.message); }
  };

  grab('absence', () => {
    const n = d.prepare('SELECT COUNT(*) n FROM absence').get().n;
    counts.absence = n;
    if (!n) return '';
    const top = d.prepare('SELECT subject, predicate, attempts, last_attempt_ts FROM absence ORDER BY attempts ASC, last_attempt_ts ASC LIMIT 5').all();
    return `• NAMED GAPS (absence): ${n.toLocaleString()} things we established we do NOT have. Least-tried:\n`
      + top.map((r) => `   - ${r.subject} — ${r.predicate} (tried ${r.attempts}×, last ${_ago(now, r.last_attempt_ts)})`).join('\n');
  });

  grab('cardinality', () => {
    const n = d.prepare('SELECT COUNT(*) n FROM cardinality').get().n;
    const conflicts = d.prepare('SELECT COUNT(*) n FROM cardinality WHERE conflict_seats IS NOT NULL').get().n;
    counts.cardinality = n; counts.cardinalityConflicts = conflicts;
    if (!n) return '';
    let line = `• COUNTABLE UNIVERSES (cardinality): ${n} bodies with a known denominator`;
    if (conflicts) {
      const c = d.prepare('SELECT body, seats, conflict_seats FROM cardinality WHERE conflict_seats IS NOT NULL LIMIT 3').all();
      line += `; ${conflicts} carry a CONFLICT worth resolving:\n` + c.map((r) => `   - ${r.body}: ${r.seats} vs ${r.conflict_seats}`).join('\n');
    }
    return line;
  });

  grab('encounters', () => {
    const n = d.prepare('SELECT COUNT(*) n FROM encounters').get().n;
    counts.encounters = n;
    if (!n) return '';
    const unknown = d.prepare("SELECT COUNT(*) n FROM encounters WHERE authority = 'unknown'").get().n;
    // Largest single-source object clusters = the best corroboration targets (one origin vouches
    // for many claims and nothing else does).
    const singles = d.prepare(`
      SELECT object_label, COUNT(*) c FROM encounters
      WHERE object_label IS NOT NULL AND object_key IN (
        SELECT object_key FROM encounters GROUP BY object_key HAVING COUNT(DISTINCT COALESCE(origin_host, source_ref, 'x')) = 1
      ) GROUP BY object_key ORDER BY c DESC LIMIT 3`).all();
    return `• CLAIMS HELD (encounters): ${n.toLocaleString()}, ${unknown.toLocaleString()} with UNKNOWN authority.`
      + (singles.length ? ` Largest single-source clusters (uncorroborated):\n` + singles.map((r) => `   - ${r.object_label} (${r.c} claims, one source)`).join('\n') : '');
  });

  grab('interests', () => {
    const rows = d.prepare("SELECT topic, weight, mastery, visits, last_visited_ts FROM interests WHERE status='active' ORDER BY weight DESC LIMIT 10").all();
    counts.interests = rows.length;
    if (!rows.length) return '';
    return `• YOUR OWN INTERESTS (ideas to explore, not contact lookups):\n`
      + rows.map((r) => `   - ${r.topic} (weight ${(+r.weight).toFixed(2)}, mastery ${(+r.mastery).toFixed(2)}, ${r.visits} visits, last ${_ago(now, r.last_visited_ts)})`).join('\n');
  });

  grab('open_threads', () => {
    const active = d.prepare("SELECT COUNT(*) n FROM open_threads WHERE status IN ('active','pending')").get().n;
    counts.openThreads = active;
    if (!active) return '';
    const stale = d.prepare("SELECT content, last_touched_ts FROM open_threads WHERE status IN ('active','pending') ORDER BY last_touched_ts ASC LIMIT 5").all();
    return `• YOUR OPEN THREADS (${active} active/pending; stalest first — commitments YOU made):\n`
      + stale.map((r) => `   - "${String(r.content || '').replace(/\s+/g, ' ').slice(0, 140)}" (untouched ${_ago(now, r.last_touched_ts)})`).join('\n');
  });

  grab('inbox', () => {
    // Finished delegated work the drain banked (meta autonomy.inbox_recent) — unabsorbed results
    // are prime material: open them, build from them, or tell Lucas about them.
    let items = [];
    try { items = JSON.parse(dbm.getMeta('autonomy.inbox_recent') || '[]') || []; } catch {}
    if (!Array.isArray(items) || !items.length) return '';
    return `• FINISHED DELEGATED WORK (returned to you, not yet absorbed):\n`
      + items.slice(-5).map((it) => `   - [${it.agent || 'agent'}] ${it.title}${it.kind ? ` (${it.kind})` : ''}${it.summary ? ` — ${it.summary.slice(0, 160)}` : ''}`).join('\n');
  });

  grab('week', () => {
    // Lucas's calendar (lib/week_context, cached by the driver's refresh) — the people he is about
    // to meet are PRIME material: research who they are before the meeting, or engage with a timely,
    // conversational question about it. Facts only here (`lines`), no chat-voice guidance.
    const wc = (deps.weekContext || require('./week_context')).cached();
    if (!wc || !wc.lines) return '';
    return `• HIS CALENDAR THIS WEEK (who he just met and is about to meet — knowing THESE people beats generic exploration):\n${wc.lines}`;
  });

  grab('stories', () => {
    // Developing stories she follows (lib/story_follow) — only the DELTA since each was last raised.
    // Facts here; the engage licensing lives in the decision prompt. The [story #N] token is the
    // machine handle an engage target carries so the driver can mark the story raised.
    const lines = (deps.storyFollow || require('./story_follow')).manifestLines({ limit: 5, nowMs: now });
    if (!lines || !lines.length) return '';
    counts.developingStories = lines.length;
    return `• DEVELOPING STORIES YOU FOLLOW (what moved since you last saw it):\n${lines.join('\n')}`;
  });

  grab('maintenance', () => {
    // Echo pass status, cached by the driver (meta autonomy.pass_status, ~6h) — a stale loop is a
    // maintain-move candidate. Facts + age only; the allowlist itself rides the maintain brief.
    let cached = null;
    try { cached = JSON.parse(dbm.getMeta('autonomy.pass_status') || 'null'); } catch {}
    if (!cached || !cached.text) return '';
    counts.passStatusAgeMs = now - (cached.ts || now);
    return `• MAINTENANCE & ANALYSIS LOOPS (Echo pass status as of ${_ago(now, cached.ts)}):\n${String(cached.text).replace(/\s+$/g, '').slice(0, 700)}`;
  });

  grab('board', () => {
    // The workstream board (lib/board, conductor 2a) — what is ALREADY running, so the decision never
    // starts a second run of a kind in flight and can see which resources are held.
    const lines = (deps.board || require('./board')).manifestLines({ nowMs: now });
    if (!lines || !lines.length) return '';
    counts.boardLines = lines.length;
    return `• WHAT IS RUNNING IN YOU NOW (the workstream board — never start a duplicate of a running kind):\n${lines.join('\n')}`;
  });

  return { text: sections.join('\n'), counts };
}

// ---- history: what the last N ticks chose and what CAME OF IT --------------
function historyRead(getMeta) {
  try { const a = JSON.parse((getMeta && getMeta(HISTORY_KEY)) || '[]'); return Array.isArray(a) ? a : []; }
  catch { return []; }
}
function historyPush({ getMeta, setMeta }, entry) {
  const a = historyRead(getMeta);
  a.push(entry);
  while (a.length > HISTORY_MAX) a.shift();
  try { setMeta(HISTORY_KEY, JSON.stringify(a)); } catch {}
  return a;
}
function historyBlock(history, now = Date.now()) {
  if (!history || !history.length) return '';
  return 'YOUR RECENT TICKS (do not repeat a move that just ran or keeps yielding nothing):\n'
    + history.slice(-8).map((h) => `   - ${_ago(now, h.ts)}: ${h.move}${h.target ? ` → ${String(h.target).slice(0, 80)}` : ''} → ${h.outcome || '?'}`).join('\n');
}

// ---- S2: THE CLOUD CHOOSES -------------------------------------------------
const DECISION_WANT = `You are the autonomous work-chooser for Zoe — a dedicated research assistant with her own databases, ~100 public data sources, the open web, and her own interests. Nobody is prompting her right now; YOU decide what this idle tick does.

Pick the SINGLE highest-value move and reply with ONLY strict JSON (no prose outside it):
{"move":"research|fill-gap|corroborate|clean|build|engage|nothing",
 "target":"<a key/name taken from the STATE — the gap, universe, cluster, interest, or thread>",
 "why":"<one honest line>",
 "steps":["<plain-language intent, e.g. 'search our own records for X', 'read the org's own site'>", "..."],
 "expect":"<what success would concretely look like>",
 "say":"<engage move ONLY: the exact 2-4 sentence message to send>"}

The moves:
- research: EXPLORE AN IDEA — one of her interests, an open thread, or a question the state raises. Depth over breadth; the point is understanding, not contact lookup.
- fill-gap: go get a NAMED absence gap or missing members of a countable universe.
- corroborate: take a single-source cluster and find an INDEPENDENT second source for its claims.
- clean: inspect and report on duplicates/conflicts (writes are gated — your product is a precise report).
- build: turn material she ALREADY HOLDS into a real markdown document (a brief, a gap report, a synthesis).
- maintain: run ONE curated maintenance loop on her own stores (the brief names the allowlist — an integrity-audit report, a full-corpus dedup proposal sweep). Products are REPORTS and PROPOSALS; nothing applies unattended. Prefer it when MAINTENANCE & ANALYSIS LOOPS shows a loop gone stale.
- engage: say something to Lucas NOW — a genuine finding or a direction question. Use RARELY, only when you have something real; "say" must carry the exact message, grounded in the state above, no invented facts.
- nothing: a first-class answer. If no move is clearly worth its cost, decline honestly.

Rules: at most 4 steps. Never plan work you cannot check. State "expect" as something CHECKABLE — the run is verified against it afterward, and a history line saying "expect NOT met" means that approach is not working: change it, don't repeat it. FINISHED DELEGATED WORK in the state is high-priority: absorb it (build from it, or engage Lucas about it) before starting new work of the same kind. Do not choose a target your recent ticks show as just-run or repeatedly dry. Variety matters across ticks — contacts are ALREADY covered by another lane, so prefer ideas, gaps, corroboration, and building over anything contact-shaped. The one exception: PEOPLE ON HIS CALENDAR. If the state shows an upcoming meeting whose attendees we hold little on, researching them before he walks in is among the highest-value moves available — and a past meeting is a natural, grounded engage ("how did X go?"). DEVELOPING STORIES YOU FOLLOW are the other licensed opening: a development in a story you two discussed is a real reason to speak, not padding — an engage there says what CHANGED (never re-narrate the story), and its target must be the exact [story #N] token from that line so the raise is recorded.`;

function validateDecision(raw) {
  try {
    const m = String(raw || '').match(/\{[\s\S]*\}/);
    if (!m) return { valid: false, error: 'no JSON object' };
    const o = JSON.parse(m[0]);
    if (!MOVES.includes(o.move)) return { valid: false, error: `move must be one of ${MOVES.join('|')}` };
    const out = {
      move: o.move,
      target: String(o.target || '').replace(/\s+/g, ' ').slice(0, 200),
      why: String(o.why || '').replace(/\s+/g, ' ').slice(0, 300),
      steps: (Array.isArray(o.steps) ? o.steps : []).slice(0, 4).map((s) => String(s || '').replace(/\s+/g, ' ').slice(0, 200)).filter(Boolean),
      expect: String(o.expect || '').replace(/\s+/g, ' ').slice(0, 240),
      say: String(o.say || '').trim().slice(0, 900),
    };
    if (!out.why) return { valid: false, error: 'why is required' };
    if (out.move !== 'nothing' && out.move !== 'engage' && !out.target) return { valid: false, error: 'target required for a work move' };
    if (out.move === 'engage' && out.say.length < 40) return { valid: false, error: 'engage requires a real "say" message (≥40 chars)' };
    return { valid: true, value: out };
  } catch (e) { return { valid: false, error: e.message }; }
}

/**
 * One structured decision call. deps.ask injectable (offline smoke); the live path goes through
 * cloud_logic.ask → cached/budgeted/traced, on the deep reasoner with think:false + real headroom.
 */
async function decide({ manifestText = '', history = [], now = Date.now(), deps = {} } = {}) {
  if (!manifestText || !manifestText.trim()) return null;   // nothing to choose from → no call
  const ask = deps.ask || require('./cloud_logic').ask;
  const model = (() => { try { return require('./config').deepReasonerModel(); } catch { return null; } })();
  return ask({
    task: 'autonomy_tick', v: 1,
    input: { state: manifestText, history: historyBlock(history, now) },
    want: DECISION_WANT,
    validate: validateDecision,
    model,
    numPredict: 1500,      // the reasoner floor — below it the answer starves in hidden thinking
    think: false,          // the decision is the OUTPUT, not the chain-of-thought
  });
}

// ---- S3: the plan becomes a bounded operator brief -------------------------
function slugify(s) {
  return String(s || 'work').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'work';
}

const _HONESTY = `Report ONLY what your tools actually returned; if a lookup fails or comes back empty, say so plainly — an honest gap beats a confident guess. Never describe an action you did not take.`;

function buildOperatorBrief(decision, { now = Date.now() } = {}) {
  const d = decision || {};
  const steps = (d.steps && d.steps.length) ? `\nSuggested path (adapt as the evidence leads):\n${d.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}` : '';
  const expect = d.expect ? `\nSuccess looks like: ${d.expect}` : '';
  switch (d.move) {
    case 'research':
      return `AUTONOMOUS RESEARCH — explore this in depth: ${d.target}. ${d.why}${steps}${expect}\nGo deep, not wide: read what you open, connect it to what our own records hold, and finish with the 3-5 most substantive things you learned (cited to their sources). ${_HONESTY}`;
    case 'fill-gap':
      return `AUTONOMOUS GAP-FILL — we have established we DO NOT HAVE: ${d.target}. ${d.why}${steps}${expect}\nFind it from a citable source (our records first, then the open web). If it truly cannot be found, say exactly what you tried — that keeps the gap honest. ${_HONESTY}`;
    case 'corroborate':
      return `AUTONOMOUS CORROBORATION — these claims rest on ONE source: ${d.target}. ${d.why}${steps}${expect}\nFind an INDEPENDENT second source (different site/org, not a mirror of the first) that confirms or contradicts the core claims. State clearly which claims you could and could not corroborate. ${_HONESTY}`;
    case 'clean':
      return `AUTONOMOUS HYGIENE PASS — inspect: ${d.target}. ${d.why}${steps}${expect}\nUse localdb/echo READS to characterize the problem precisely (which rows, what pattern, how many). Writes are gated, so your product is a precise, actionable report of what should change. ${_HONESTY}`;
    case 'build': {
      const path = `notes/autonomy/${new Date(now).toISOString().slice(0, 10)}-${slugify(d.target)}.md`;
      return `AUTONOMOUS BUILD — produce a real document about: ${d.target}. ${d.why}${steps}${expect}\nGather the material (our own records FIRST — this is a synthesis of what we hold, filled in from the web only where our records are thin), then SAVE the finished markdown with the file tool: {"op":"write","path":"${path}","content":"<the full document>"}. Plain markdown — headings, paragraphs, lists — no styling. End your answer with one line naming the saved path and what it contains. ${_HONESTY}`;
    }
    case 'maintain': {
      let allow = '';
      try { allow = require('./echo_tier').maintainSpec(); } catch {}
      return `AUTONOMOUS MAINTENANCE — run this curated loop on our own stores: ${d.target}. ${d.why}${steps}${expect}\nThe ONLY loops allowed on this move (each is report-only or proposal-only unattended; safety args are forced mechanically, so run them plainly):\n${allow}\nUse the echo tool to run the loop, READ its result, and finish with a precise report: what it found, the counts (violations / proposals / oversized blocks), and what — if anything — is worth Lucas applying. ${_HONESTY}`;
    }
    default:
      return `AUTONOMOUS PASS — ${d.target || 'the chosen work'}. ${d.why}${steps}${expect}\n${_HONESTY}`;
  }
}

// ---- S3: EXPECT vs ACTUAL — the verify the design specified ----------------
// The plan carries `expect` ("what success looks like"); this is the stage that CHECKS it. One
// cheap structured call: did the run's actual answer meet the stated expectation? The verdict
// rides the history entry, so the NEXT decision sees "expect NOT met" and stops repeating a move
// that only looks like it works. Fail-soft: no expect / no answer / cloud down → null (unverified).
function _validateExpectVerdict(raw) {
  try {
    const m = String(raw || '').match(/\{[\s\S]*\}/);
    if (!m) return { valid: false, error: 'no JSON object' };
    const o = JSON.parse(m[0]);
    if (typeof o.met !== 'boolean') return { valid: false, error: 'missing boolean "met"' };
    return { valid: true, value: { met: o.met, why: String(o.why || '').replace(/\s+/g, ' ').slice(0, 200) } };
  } catch (e) { return { valid: false, error: e.message }; }
}
async function verifyExpect({ decision, opRes, deps = {} } = {}) {
  const d = decision || {};
  if (!d.expect || !opRes || !opRes.answer || !String(opRes.answer).trim()) return null;
  const ask = deps.ask || require('./cloud_logic').ask;
  try {
    return await ask({
      task: 'autonomy_verify', v: 1,
      input: {
        expected: d.expect,
        actual: String(opRes.answer).slice(0, 4000),
        artifacts: (opRes.steps || []).filter((s) => s.tool === 'file').map((s) => s.args && s.args.path).filter(Boolean),
      },
      want: `Did the ACTUAL result genuinely meet the EXPECTED outcome? Judge strictly — a partial or hedged result that dodges the expectation is NOT met. Reply ONLY strict JSON: {"met": true|false, "why": "<one honest line>"}.`,
      validate: _validateExpectVerdict,
      numPredict: 200, think: false,
    });
  } catch (e) { console.error('[autonomy] expect verify failed:', e.message); return null; }
}

// ---- outcome: record what HAPPENED, not what was planned -------------------
function summarizeOutcome(decision, opRes, { now = Date.now(), verify = null } = {}) {
  const d = decision || {};
  const artifacts = [];
  let toolsUsed = [];
  if (opRes && Array.isArray(opRes.steps)) {
    toolsUsed = opRes.steps.map((s) => s.tool);
    for (const s of opRes.steps) {
      if (s.tool === 'file' && s.args && /^(write|append)$/i.test(String(s.args.op || '')) && s.args.path && !/^ERROR/i.test(String(s.result || ''))) {
        artifacts.push(String(s.args.path));
      }
    }
  }
  const ok = !!(opRes && opRes.answer && String(opRes.answer).trim());
  let outcome = !opRes ? 'no-run (cloud unavailable)' : ok
    ? `ok — ${toolsUsed.length} tool step${toolsUsed.length === 1 ? '' : 's'}${artifacts.length ? `, artifact: ${artifacts.join(', ')}` : ''}`
    : 'ran but produced no answer';
  if (verify && typeof verify.met === 'boolean') {
    outcome += `; expect ${verify.met ? 'MET' : 'NOT met'}${verify.why ? ` — ${verify.why}` : ''}`;
  }
  return {
    entry: { ts: now, move: d.move, target: d.target, outcome, ...(verify ? { expectMet: verify.met } : {}) },
    report: `[autonomy] chose=${d.move} target="${String(d.target || '').slice(0, 60)}" steps=${toolsUsed.length} ok=${ok ? 1 : 0} artifacts=${artifacts.length}${verify ? ` expect=${verify.met ? 'met' : 'NOT-met'}` : ''}`,
    artifacts, ok, toolsUsed,
  };
}

// ---- the delegation RETURN PATH (pure parts) -------------------------------
// Echo's agent_inbox holds finished agent work "the operator hasn't yet opened" — and nothing on
// Zoe's side ever read it, so a delegated run left and its result died in the queue (the handoff's
// own manifest warned "it does NOT report back"). The driver drains it; these helpers parse and
// dedupe so the drain is smokeable.
function parseAgentInbox(text) {
  try {
    const m = String(text || '').match(/\[[\s\S]*\]/);
    if (!m) return [];
    const arr = JSON.parse(m[0]);
    return (Array.isArray(arr) ? arr : []).map((it) => ({
      title: String((it && it.title) || '').slice(0, 160),
      summary: String((it && it.summary) || '').replace(/\s+/g, ' ').slice(0, 400),
      agent: String((it && (it.agent_name || it.agent)) || '').slice(0, 60),
      kind: String((it && it.deliverable_kind) || '').slice(0, 40),
      canvasTab: String((it && it.canvas_tab) || '').slice(0, 80),
      createdAt: String((it && it.created_at) || '').slice(0, 40),
    })).filter((it) => it.title || it.summary);
  } catch { return []; }
}
function inboxSeenKey(item) {
  return `${(item && item.title) || ''}::${(item && item.createdAt) || ''}`.slice(0, 200);
}

module.exports = {
  MOVES, HISTORY_KEY, HISTORY_MAX,
  buildManifest, historyRead, historyPush, historyBlock,
  decide, validateDecision, DECISION_WANT,
  buildOperatorBrief, summarizeOutcome, slugify,
  verifyExpect, _validateExpectVerdict, parseAgentInbox, inboxSeenKey,
};
