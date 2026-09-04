'use strict';
/*
 * lib/trajectory_mine.js — LEG B, THE TRAJECTORY-MINING ORGAN (docs/ZOE_MERGE_MAP §"trajectory (leg B)";
 * docs/HARNESS_EVOLUTION_EVALUATION §3 borrow 2, 2026-09-04): "A nightly organ mines the run ledger for
 * recurring failure classes and proposes one retest-the-kind per class." RHO's recipe (arXiv 2606.05922 —
 * mine past trajectories for recurring failure classes, no labels) over the substrate stage 4.5 C built:
 * lib/db.js `runs`. It READS the ledger, buckets terminal FAILURES (state 'failed') into classes keyed on a
 * normalized error signature, ranks each by recurrence × spread × recency, and emits a ranked brief.
 *
 * The organ (main.js maybeMineTrajectory) surfaces a class that RECURS across the window as a capability_need
 * on the SAME open→rehearse→proposal-card→Lucas pipeline that self_watch's log-anomaly needs ride — so the
 * terminal is a proposal for him, never a landed change ([[anticipation-boundary]]). self_watch mines the LOG
 * STREAM (console anomalies); this mines the RUN LEDGER (structured run outcomes) — complementary sources, so
 * leg B carries its OWN `trajectory:` born_from prefix and its OWN open-need cap and never competes with
 * self_watch's budget. The fuller paths the harness-eval names — land a data-tier winner through leg A's
 * edits ledger, queue a code-tier one to the pen (leg D) — wait on those legs; this is the mining, the brief,
 * and the needs seam that exist today.
 *
 * PURE: every function is a SELECT over an injected db handle (default the app's, like lib/run_ledger), so the
 * smoke drives it offline. Nothing here calls a model, the engine, or the network.
 */

const DEFAULT_WINDOW_DAYS = parseFloat(process.env.ZOE_TRAJECTORY_WINDOW_DAYS) || 7;
const MINT_THRESHOLD = 3;              // a class RECURS at ≥ this many failures (self_watch's threshold)
const ROLE_MIN_RUNS = 5;               // a role's fail-rate matters only above this many runs in the window
const RECENCY_HALF_LIFE_DAYS = 3;      // a class's score halves every this-many days since it last fired
const SIG_MAX = 160, SIG_HEAD = 90, SIG_TAIL = 60;   // long errors keep head + tail (the kind lives at the tail)
const DAY = 86400e3;

function _db(opts) { return (opts && opts.db) || require('./db').getDb(); }
const _n = (v) => (Number.isFinite(v) ? v : 0);

// A stable identity for "the same failure again": lowercase, ids/paths/urls/numbers blanked, whitespace
// collapsed; a long message keeps its head AND tail (self_watch's lesson: the error KIND often sits at the
// tail, so a flat head-slice folds distinct modes into one). An empty message signs by the state alone.
function signatureOf(error, state) {
  let s = String(error == null ? '' : error).trim();
  if (!s) return `<no message> (${state || 'failed'})`;
  s = s.toLowerCase()
    .replace(/[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/g, '<id>')   // uuids
    .replace(/\b[0-9a-f]{16,}\b/g, '<id>')                                                   // long hex (echo run ids)
    .replace(/\b[a-z]:\\[^\s'"]+/g, '<path>')                                                 // windows paths
    .replace(/\bhttps?:\/\/[^\s'"]+/g, '<url>')                                               // urls
    .replace(/\/[^\s'"()]{4,}/g, '<path>')                                                    // posix paths
    .replace(/\d+/g, 'N')                                                                     // any remaining number
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length <= SIG_MAX) return s;
  return `${s.slice(0, SIG_HEAD)} … ${s.slice(-SIG_TAIL)}`;
}

/**
 * Mine the run ledger over a window. Returns { window, totals, classes[], roles[], generatedAt }.
 * A CLASS is a failure signature: { sig, count, distinctDays, roles[], lanes[], executors[], firstSeen,
 * lastSeen, sampleError, sampleRunIds[], recurring, score } — only state 'failed' rows form classes
 * (a 'cancelled' run is a release/give-up/supersession, not a defect to fix; it is counted in totals and
 * a role's rate but never mined as a class). ROLES lists the roles whose failure rate is worth a look.
 */
function mine({ db, sinceMs = null, now = Date.now(), windowDays = DEFAULT_WINDOW_DAYS, minClassCount = 1 } = {}, opts) {
  const d = db || _db(opts);
  const since = Math.floor(sinceMs != null ? sinceMs : now - windowDays * DAY);
  const rows = d.prepare(
    `SELECT run_id, role, executor, lane, state, error, ended_at
       FROM runs
      WHERE ended_at >= ? AND state IN ('succeeded','failed','cancelled')`
  ).all(since);

  const totals = { runs: rows.length, succeeded: 0, failed: 0, cancelled: 0 };
  const classes = new Map();   // sig -> aggregate
  const roleAgg = new Map();   // role -> { succeeded, failed, cancelled }

  for (const r of rows) {
    const st = r.state;
    totals[st] = (totals[st] || 0) + 1;
    let ra = roleAgg.get(r.role); if (!ra) { ra = { role: r.role, succeeded: 0, failed: 0, cancelled: 0 }; roleAgg.set(r.role, ra); }
    ra[st] = (ra[st] || 0) + 1;
    if (st !== 'failed') continue;   // only real failures form classes
    const sig = signatureOf(r.error, st);
    let c = classes.get(sig);
    if (!c) { c = { sig, count: 0, roles: new Set(), lanes: new Set(), executors: new Set(), days: new Set(), firstSeen: _n(r.ended_at), lastSeen: _n(r.ended_at), sampleError: String(r.error || '').slice(0, 200), sampleRunIds: [] }; classes.set(sig, c); }
    c.count++;
    if (r.role) c.roles.add(r.role);
    if (r.lane) c.lanes.add(r.lane);
    if (r.executor) c.executors.add(r.executor);
    c.days.add(Math.floor(_n(r.ended_at) / DAY));
    if (_n(r.ended_at) < c.firstSeen) c.firstSeen = _n(r.ended_at);
    if (_n(r.ended_at) > c.lastSeen) c.lastSeen = _n(r.ended_at);
    if (c.sampleRunIds.length < 5) c.sampleRunIds.push(r.run_id);
  }

  const HL = RECENCY_HALF_LIFE_DAYS * DAY;
  const out = [];
  for (const c of classes.values()) {
    if (c.count < minClassCount) continue;
    const distinctDays = c.days.size;
    const recency = Math.pow(0.5, Math.max(0, now - c.lastSeen) / HL);
    const score = c.count * (1 + Math.log(distinctDays || 1)) * recency;
    out.push({
      sig: c.sig, count: c.count, distinctDays,
      roles: [...c.roles].sort(), lanes: [...c.lanes].sort(), executors: [...c.executors].sort(),
      firstSeen: c.firstSeen, lastSeen: c.lastSeen, sampleError: c.sampleError, sampleRunIds: c.sampleRunIds,
      recurring: c.count >= MINT_THRESHOLD,
      score: Math.round(score * 1000) / 1000,
    });
  }
  out.sort((a, b) => b.score - a.score || b.count - a.count || b.lastSeen - a.lastSeen);

  const roles = [];
  for (const ra of roleAgg.values()) {
    const total = ra.succeeded + ra.failed + ra.cancelled;
    if (total < ROLE_MIN_RUNS || ra.failed === 0) continue;
    roles.push({ role: ra.role, runs: total, succeeded: ra.succeeded, failed: ra.failed, cancelled: ra.cancelled, failRate: Math.round((ra.failed / total) * 1000) / 1000 });
  }
  roles.sort((a, b) => b.failRate - a.failRate || b.failed - a.failed);

  return { window: { sinceMs: since, now, days: windowDays }, totals, classes: out, roles, generatedAt: now };
}

// The "retest the kind" line for a class — what keeps failing, in whom, from where. First automated form of
// the law: a recurring class names a KIND to re-test, not a phrase to re-match.
function retestHint(c) {
  const who = (c.roles && c.roles.length) ? c.roles.slice(0, 3).join(', ') : 'a run';
  const where = (c.executors && c.executors.length) ? ` [${c.executors.join('/')}]` : '';
  return `${c.count}x over ${c.distinctDays}d in ${who}${where}: ${c.sampleError || c.sig}`.slice(0, 220);
}

// The compact carry for GET /trajectory and the status vector: the top classes (each with its retest hint)
// and the worst-rate roles. `mined` lets a caller pass an already-computed mine() so the organ mines once.
function brief({ db, now = Date.now(), windowDays = DEFAULT_WINDOW_DAYS, limit = 8, mined = null } = {}, opts) {
  const m = mined || mine({ db, now, windowDays }, opts);
  return {
    window: m.window,
    totals: m.totals,
    recurring: m.classes.filter((c) => c.recurring).length,
    classes: m.classes.slice(0, limit).map((c) => ({
      sig: c.sig, count: c.count, days: c.distinctDays, roles: c.roles, lanes: c.lanes, executors: c.executors,
      lastSeen: c.lastSeen, recurring: c.recurring, score: c.score, hint: retestHint(c),
    })),
    roles: m.roles.slice(0, limit),
    generatedAt: m.generatedAt,
  };
}

// The need a recurring class becomes. The TEXT is stable (count/days omitted — they change and would defeat
// the dedup); the BORN_FROM carries the signature, so re-mining the same class folds into the open row
// (lib/capability_need.record dedupes on an identical born_from) rather than forking a new need each night.
function needText(c) {
  const who = (c.roles && c.roles.length) ? c.roles.slice(0, 2).join('/') : 'a run';
  return `a recurring run failure in ${who}: ${c.sampleError || c.sig}`;
}
function needBornFrom(c) { return `trajectory:${String(c.sig || '').slice(0, 120)}`; }

module.exports = { mine, brief, signatureOf, retestHint, needText, needBornFrom, DEFAULT_WINDOW_DAYS, MINT_THRESHOLD, ROLE_MIN_RUNS };
