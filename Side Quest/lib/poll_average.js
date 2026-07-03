/**
 * lib/poll_average.js — POLL AGGREGATION MODEL (Suite B, model #1 — the model the atlas never had).
 *
 * Pure function over the SHARED normalized-poll shape (what poll_wikipedia / poll_votehub emit): produces a
 * quality-weighted, recency-decayed, optionally house-effect-corrected average per answer choice, a leader/
 * margin, and a rolling trend. Storage-agnostic — runs directly on adapter output in memory; persisting +
 * surfacing is a later Suite-B wiring slice. All modeling choices live HERE (brief §0 Option 2); Suite A
 * stays descriptive. Deterministic (inject `now` for tests). No throw on bad input.
 *
 * WEIGHT = recency · sample · quality · integrity, each documented + independently testable:
 *   recency  = 0.5 ^ (ageDays / halfLifeDays)                  (age from poll end_date; missing → recencyDefault)
 *   sample   = sqrt(clamp(n, nFloor..sampleCap) / sampleCap)   (diminishing returns; missing n → nDefault)
 *   quality  = gradeWeight(538 numeric_grade)                  (only if a ratings map is supplied; else 1)
 *   integrity= internal? internalPenalty : 1  ×  partisan? partisanPenalty : 1
 *
 * House-effect correction (optional, off by default): EMPIRICAL v1 — a pollster's mean deviation from the
 * pool mean per choice is subtracted from its polls (recenters house leans). The 538 `bias_ppm` prior
 * (poll_538legacy) is a separate margin-level signal to fold in later.
 */
'use strict';

const DEFAULTS = {
  halfLifeDays: 21,      // recency half-life
  sampleCap: 1500,       // sample weight saturates here
  nFloor: 200,
  nDefault: 600,         // assumed n when a poll omits sample_size
  recencyDefault: 0.25,  // recency weight when a poll has no usable date
  internalPenalty: 0.5,  // campaign-internal poll
  partisanPenalty: 0.7,  // partisan-sponsored poll
  minPollsForHouseEffect: 2,
};

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const dayMs = 86400000;
function dateMs(s) { const t = Date.parse(String(s || '')); return Number.isFinite(t) ? t : null; }
// 538 numeric_grade (~0..3) → multiplier in [0.5, 1.5]; missing grade → 1 (neutral)
function gradeWeight(g) { return g == null ? 1 : clamp(0.5 + Number(g) * (1 / 3), 0.5, 1.5); }

function pollEndMs(p) { return dateMs(p && (p.end_date || p.start_date)); }
function isPartisan(p) { const v = p && p.partisan; return !!v && String(v).toUpperCase() !== 'NA'; }

// weight for one poll (>= 0). deps: now (ms), ratingsByPollster {pollster:{grade}}, cfg.
function pollWeight(p, { now, ratingsByPollster = {}, cfg = DEFAULTS } = {}) {
  const c = { ...DEFAULTS, ...cfg };
  const end = pollEndMs(p);
  const wRec = end == null ? c.recencyDefault : Math.pow(0.5, ((now - end) / dayMs) / c.halfLifeDays);
  const n = Number(p && p.sample_size);
  const nUsed = Number.isFinite(n) && n > 0 ? n : c.nDefault;
  const wN = Math.sqrt(clamp(nUsed, c.nFloor, c.sampleCap) / c.sampleCap);
  const rating = ratingsByPollster[p && p.pollster];
  const wQ = gradeWeight(rating ? rating.grade : null);
  const wI = (p && p.internal ? c.internalPenalty : 1) * (isPartisan(p) ? c.partisanPenalty : 1);
  return Math.max(0, wRec * wN * wQ * wI);
}

// answers[] → {choice: pct} (last wins on dup choice)
function answerMap(p) {
  const m = {};
  for (const a of (p && Array.isArray(p.answers) ? p.answers : [])) {
    if (a && a.choice && Number.isFinite(Number(a.pct))) m[a.choice] = Number(a.pct);
  }
  return m;
}

// empirical house effects: { pollster: { choice: delta } } where delta = pollsterMean − poolMean (per choice).
function computeHouseEffects(polls, cfg = DEFAULTS) {
  const c = { ...DEFAULTS, ...cfg };
  const poolSum = {}, poolN = {}, byPollster = {};
  for (const p of polls) {
    const am = answerMap(p);
    const ps = p.pollster || '(unknown)';
    (byPollster[ps] = byPollster[ps] || []).push(am);
    for (const k in am) { poolSum[k] = (poolSum[k] || 0) + am[k]; poolN[k] = (poolN[k] || 0) + 1; }
  }
  const poolMean = {}; for (const k in poolSum) poolMean[k] = poolSum[k] / poolN[k];
  const he = {};
  for (const ps in byPollster) {
    const rows = byPollster[ps];
    if (rows.length < c.minPollsForHouseEffect) continue;
    const sum = {}, cnt = {};
    for (const am of rows) for (const k in am) { sum[k] = (sum[k] || 0) + am[k]; cnt[k] = (cnt[k] || 0) + 1; }
    const d = {};
    for (const k in sum) if (poolMean[k] != null) d[k] = (sum[k] / cnt[k]) - poolMean[k];
    he[ps] = d;
  }
  return he;
}

const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();

/**
 * Weighted average over polls.
 * opts: { now=Date.now(), subject, poll_type, ratings=[]|{}, houseEffect=false, cfg }
 *   ratings: array of poll_538legacy ratings OR a {pollster:{grade}} map.
 * returns { subject, poll_type, as_of, n_polls, n_pollsters, choices:[{choice,pct,weight,n_used}],
 *           leader, runner_up, margin, applied }
 */
function average(polls, opts = {}) {
  const now = opts.now != null ? opts.now : Date.now();
  const cfg = { ...DEFAULTS, ...(opts.cfg || {}) };
  const ratingsByPollster = Array.isArray(opts.ratings)
    ? Object.fromEntries(opts.ratings.map((r) => [r.pollster, r]))
    : (opts.ratings || {});

  let pool = (Array.isArray(polls) ? polls : []).filter((p) => p && !p.is_aggregate);
  if (opts.subject) pool = pool.filter((p) => norm(p.subject) === norm(opts.subject));
  if (opts.poll_type) pool = pool.filter((p) => norm(p.poll_type) === norm(opts.poll_type));

  // Restrict to ONE consistent question: a (subject, poll_type) group can still mix incompatible
  // answer-sets (e.g. VoteHub approval polls that report Approve/Disapprove vs a stray Dem/Rep item).
  // Averaging across them is meaningless, so keep only the MODAL choice-set unless opts.choiceSet==='all'.
  let choiceSet = null;
  const sigOf = (p) => Object.keys(answerMap(p)).map(norm).sort().join('|');
  if ((opts.choiceSet || 'modal') !== 'all' && pool.length) {
    const counts = {};
    for (const p of pool) { const s = sigOf(p); if (s) counts[s] = (counts[s] || 0) + 1; }
    let bestN = -1;
    for (const s in counts) if (counts[s] > bestN) { bestN = counts[s]; choiceSet = s; }
    if (choiceSet) pool = pool.filter((p) => sigOf(p) === choiceSet);
  }

  const he = opts.houseEffect ? computeHouseEffects(pool, cfg) : null;
  const acc = {};   // choice → { wSum, wpSum, n }
  const pollsters = new Set();
  for (const p of pool) {
    const w = pollWeight(p, { now, ratingsByPollster, cfg });
    if (!(w > 0)) continue;
    pollsters.add(p.pollster || '(unknown)');
    const am = answerMap(p);
    const adj = he && he[p.pollster] ? he[p.pollster] : null;
    for (const k in am) {
      const pct = adj && adj[k] != null ? am[k] - adj[k] : am[k];
      const a = acc[k] || (acc[k] = { wSum: 0, wpSum: 0, n: 0 });
      a.wSum += w; a.wpSum += w * pct; a.n += 1;
    }
  }
  const choices = Object.keys(acc)
    .map((k) => ({ choice: k, pct: acc[k].wSum > 0 ? acc[k].wpSum / acc[k].wSum : 0, weight: acc[k].wSum, n_used: acc[k].n }))
    .sort((a, b) => b.pct - a.pct);
  const leader = choices[0] || null, runner = choices[1] || null;
  return {
    subject: opts.subject || null, poll_type: opts.poll_type || null,
    as_of: now, n_polls: pool.length, n_pollsters: pollsters.size,
    choices,
    leader: leader ? leader.choice : null,
    runner_up: runner ? runner.choice : null,
    margin: leader && runner ? Number((leader.pct - runner.pct).toFixed(2)) : null,
    applied: { houseEffect: !!opts.houseEffect, quality: Object.keys(ratingsByPollster).length > 0, halfLifeDays: cfg.halfLifeDays, choiceSet: choiceSet || 'all' },
  };
}

/**
 * Rolling trend: run `average` at a set of anchor dates (recency measured from each anchor, only polls up
 * to that anchor). opts adds { stepDays=7, points=12 } ending at `now`. Returns [{date, leader, margin, choices}].
 */
function trend(polls, opts = {}) {
  const now = opts.now != null ? opts.now : Date.now();
  const stepDays = opts.stepDays || 7, points = opts.points || 12;
  const out = [];
  for (let i = points - 1; i >= 0; i--) {
    const anchor = now - i * stepDays * dayMs;
    const upTo = (Array.isArray(polls) ? polls : []).filter((p) => { const e = pollEndMs(p); return e == null || e <= anchor; });
    const a = average(upTo, { ...opts, now: anchor });
    if (a.n_polls) out.push({ date: new Date(anchor).toISOString().slice(0, 10), leader: a.leader, margin: a.margin, choices: a.choices.map((c) => ({ choice: c.choice, pct: Number(c.pct.toFixed(2)) })) });
  }
  return out;
}

module.exports = { DEFAULTS, gradeWeight, pollWeight, computeHouseEffects, average, trend, answerMap };
