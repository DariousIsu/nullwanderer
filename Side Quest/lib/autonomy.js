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

const MOVES = ['advance-inquiry', 'open-inquiry', 'close-inquiry', 'research', 'fill-gap', 'corroborate', 'clean', 'build', 'maintain', 'rehearse', 'engage', 'nothing'];
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

  grab('harvest', () => {
    // O0.h — materials mined from promoted conversations (his tangents are FEEDSTOCK, never
    // noise). Each entry carries the [dN] handle back to the conversation it came from; leads
    // here are prime open-inquiry material with born_from naming the handle.
    let items = [];
    try { items = JSON.parse(dbm.getMeta('autonomy.harvest_recent') || '[]') || []; } catch {}
    if (!Array.isArray(items) || !items.length) return '';
    counts.harvestItems = items.length;
    return `• CONVERSATION HARVEST (materials mined from your talks with Lucas — leads are prime open-inquiry material; cite the [dN] as born_from):\n`
      + items.slice(-4).map((it) => {
        const bits = [];
        if (it.leads && it.leads.length) bits.push(`leads: ${it.leads.map((l) => `"${l}"`).join(' · ')}`);
        if (it.seeds && it.seeds.length) bits.push(`report seeds: ${it.seeds.join(' · ')}`);
        if (it.decisions && it.decisions.length) bits.push(`his decisions: ${it.decisions.join(' · ')}`);
        if (it.claims && it.claims.length) bits.push(`claims to verify: ${it.claims.join(' · ')}`);
        return `   - [d${it.docRef}] ${it.title}: ${bits.join(' | ')}`;
      }).join('\n');
  });

  grab('inquiries', () => {
    // Lines of inquiry (lib/inquiry, O0) — the continuity surface: what is open, where each
    // stands, what its own last touch said to do next. The decider's DEFAULT is advancing one.
    const lines = (deps.inquiry || require('./inquiry')).manifestLines({ deps: { db: dbm }, nowMs: now });
    if (!lines || !lines.length) return '';
    counts.openInquiries = lines.length;
    return `• OPEN LINES OF INQUIRY (advancing one is the DEFAULT move):\n${lines.join('\n')}`;
  });

  grab('failures', () => {
    // §6 L4: errors are results — route them to the reader of successes. The board has written
    // failed rows since 2a; this is their first reader.
    const rows = d.prepare("SELECT lane, kind, target, note, finished_ts FROM workstreams WHERE status = 'failed' AND finished_ts > ? ORDER BY finished_ts DESC LIMIT 5").all(now - 24 * 3600e3);
    if (!rows.length) return '';
    counts.recentFailures = rows.length;
    return `• RECENT FAILURES (last 24h — results, not noise; read before repeating an approach):\n`
      + rows.map((r) => `   - [${r.lane}] ${r.kind || 'run'}${r.target ? ` "${String(r.target).slice(0, 60)}"` : ''} — ${String(r.note || 'failed').slice(0, 100)} (${_ago(now, r.finished_ts)})`).join('\n');
  });

  grab('constraints', () => {
    // DECISION-TIME CONSTRAINTS (2026-07-23): boot43/44 measured the gap this closes — a constraint
    // crystallized from an unmet run reached the NEXT RUN's brief but never the DECIDER, so the same
    // bait ("[legislative-analyst] result — ready to compile…") was re-picked across two boots. The
    // constraint rows outlive the 12-entry history window; the decider reads them BEFORE choosing.
    const rows = d.prepare("SELECT name, trigger_text, created_ts FROM procedures WHERE kind = 'constraint' AND status = 'active' ORDER BY created_ts DESC LIMIT 4").all();
    if (!rows.length) return '';
    counts.constraints = rows.length;
    return `• LEARNED CONSTRAINTS (approaches that did NOT work — do not re-pick their shape):\n`
      + rows.map((r) => `   - ${String(r.name || r.trigger_text || '').slice(0, 110)} (${_ago(now, r.created_ts)})`).join('\n');
  });

  grab('rehearsal', () => {
    // O2: the run's continuity line — the tick can see (and choose to advance) the iterating change.
    const line = require('./rehearsal_driver').manifestLine({ deps: { db: dbm } });
    if (!line) return '';
    counts.rehearsal = 1;
    return `• ACTIVE REHEARSAL RUN (advance with the rehearse move; green exits as a proposal card):\n${line}`;
  });

  grab('skills', () => {
    // O1: the shelf's trigger surface rides the manifest — counts + keys, never bodies. The pull
    // is the operator's <skill name="…"/> tag; the brief carries turn-matched lines separately.
    const lines = require('./skills').manifestLines({ deps: { db: dbm }, limit: 5 });
    if (!lines.length) return '';
    counts.skills = lines.length;
    return `• HER SKILLS (know-how on the shelf; a body loads only on pull):\n${lines.join('\n')}`;
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
    const lines = (deps.board || require('./board')).manifestLines({ deps: { db: dbm }, nowMs: now });
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
{"move":"advance-inquiry|open-inquiry|close-inquiry|research|fill-gap|corroborate|clean|build|maintain|rehearse|engage|nothing",
 "target":"<a key/name taken from the STATE — the gap, universe, cluster, interest, or thread>",
 "why":"<one honest line>",
 "steps":["<plain-language intent, e.g. 'search our own records for X', 'read the org's own site'>", "..."],
 "expect":"<what success would concretely look like>",
 "say":"<engage move ONLY: the exact 2-4 sentence message to send>"}

⭐DIRECTION: work should serve HIS WORLD first. His world, in order: the CONVERSATION HARVEST (leads and seeds mined from what you two actually talked about — the single best source of a new inquiry), DEVELOPING STORIES you follow, PEOPLE ON HIS CALENDAR, his weighted interests, and anything his directed focus is touching. The bulk-inventory sections (single-source clusters, named gaps, the corpus backlog) are LAST-RESORT material — pick from them only when nothing in his world needs a touch, and say so in "why". A target nobody ever mentioned, from a state or org neither of you is working, is almost never the highest-value move no matter how large its count.

⭐THE DEFAULT IS CONTINUITY. A LINE OF INQUIRY is a question that persists across ticks — evidence accretes, a next step carries, and each touch starts where the last stopped. If OPEN LINES OF INQUIRY shows live questions, ADVANCING one is the default move; opening and closing are the exceptions. Variety matters ACROSS inquiries, never WITHIN one: do not abandon a line merely because it ran last tick — DO change the approach inside it when its trail shows expect NOT met.
- advance-inquiry: continue an open line. target MUST be its exact token from the state, e.g. "inquiry #12". steps/expect describe THIS touch — expect names the touch's ONE bounded bite (checkable against a single run), NEVER the inquiry's finish line.
- open-inquiry: start a NEW line. target is the QUESTION ITSELF — full and specific — and "why" MUST name the state line that birthed it (an interest, a named gap, a developing story, a failure).
- close-inquiry: end a line honestly. target its token; if ANSWERED, "expect" carries the answer in 1-2 sentences; if it cannot be answered, say dead-end in "why". Honest closure is first-class, like nothing.

One-shot moves (work that is genuinely single-step):
- research: EXPLORE AN IDEA — one of her interests, an open thread, or a question the state raises. Depth over breadth; the point is understanding, not contact lookup. If it would take more than one run, open an inquiry instead.
- fill-gap: go get a NAMED absence gap or missing members of a countable universe.
- corroborate: take a single-source cluster and find an INDEPENDENT second source for its claims.
- clean: inspect and report on duplicates/conflicts (writes are gated — your product is a precise report).
- build: turn material she ALREADY HOLDS into a real markdown document (a brief, a gap report, a synthesis).
- maintain: run ONE curated maintenance loop on her own stores (the brief names the allowlist — an integrity-audit report, a full-corpus dedup proposal sweep). Products are REPORTS and PROPOSALS; nothing applies unattended. Prefer it when MAINTENANCE & ANALYSIS LOOPS shows a loop gone stale.
- rehearse: advance the ACTIVE REHEARSAL RUN one bounded iteration (only when the state shows one; a parked run resumes). target is its slug. The run edits a sandboxed COPY of her own code, judged by her own gate; green ends as a proposal-card document — nothing self-adopts, ever. Never starts a new run.
- engage: say something to Lucas NOW — a genuine finding or a direction question. Use RARELY, only when you have something real; "say" must carry the exact message, grounded in the state above, no invented facts.
- nothing: a first-class answer. If no move is clearly worth its cost, decline honestly.

Rules: at most 4 steps. Never plan work you cannot check. State "expect" as something CHECKABLE and SIZED TO ONE BOUNDED RUN (a handful of tool steps): the increment THIS run can prove — a named list found and cited, one section drafted from material already held — never a finished "comprehensive" product (an expect sized to a whole project is how every run fails its own bar and nothing ever crystallizes). The run is verified against it afterward; a history line saying "expect NOT met" — and every LEARNED CONSTRAINTS line — means that approach is not working: change it, don't repeat it. FINISHED DELEGATED WORK in the state is high-priority: absorb it (build from it, or engage Lucas about it) before starting new work of the same kind — but its gist is INPUT, not an order: size the expect to one run's increment, not to whatever "comprehensive" product the gist advertises. RECENT FAILURES in the state are results — read them before repeating a failed lane's approach. For ONE-SHOT moves only: do not pick a target your recent ticks show as just-run or repeatedly dry (an inquiry is exempt — advancing it IS the point). Contacts are ALREADY covered by another lane, so prefer ideas, gaps, corroboration, and building over anything contact-shaped. The one exception: PEOPLE ON HIS CALENDAR. If the state shows an upcoming meeting whose attendees we hold little on, researching them before he walks in is among the highest-value moves available — and a past meeting is a natural, grounded engage ("how did X go?"). DEVELOPING STORIES YOU FOLLOW are the other licensed opening: a development in a story you two discussed is a real reason to speak, not padding — an engage there says what CHANGED (never re-narrate the story), and its target must be the exact [story #N] token from that line so the raise is recorded.`;

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
    if ((out.move === 'advance-inquiry' || out.move === 'close-inquiry') && !/inquiry #\d+/i.test(out.target)) return { valid: false, error: 'advance/close-inquiry target must be the exact "inquiry #N" token from the state' };
    if (out.move === 'open-inquiry' && out.target.length < 15) return { valid: false, error: 'open-inquiry target must be the full question itself' };
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
      // "Judge strictly" was a bar no bounded run could clear: 0-for-5 across boots 43-45, so no
      // procedure ever crystallized and the whole competence loop starved. The expect is SIZED to
      // one run's increment now (DECISION_WANT) — so judge THE INCREMENT, honestly.
      want: `Did the ACTUAL result deliver the EXPECTED increment? The expectation names ONE bounded run's step, not a finished project. met=true when the run genuinely produced that step — the thing found and cited, the section drafted, an absence established honestly — even if more work remains beyond it. met=false when the result is empty, dodges the expectation, or narrates effort without the increment. Reply ONLY strict JSON: {"met": true|false, "why": "<one honest line>"}.`,
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
