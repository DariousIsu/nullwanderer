'use strict';
/**
 * lib/day_measure.js — MEASURE A DAY (design §5 item 6; Lucas 09-05 17:40: "start the measure a day").
 *
 * The consciousness subroutine's day, read from what the program PERSISTS with timestamps — never from
 * the console: obs_events (the loop's acts, reasoning requests and their answers, her words to him, the
 * wonderings, the camera's readings and the trial's pairs, the quota gate's closures, the operator's
 * run spend), turns (his turns, her says prompted and unprompted, her thoughts), cloud_traces (every
 * traced task, valid or not — the decider's ticks among them) and the usage meter's ring (compute by
 * lane and hour, weighted like lib/quota). Pure: arrays in, a ledger out — a smoke feeds it fixtures,
 * scripts/day_measure.js feeds it the live database read-only.
 *
 * The ledger answers the design's questions in order: did the loop act, what did it ask and get, what
 * did she say unprompted and was it hers, how much of the day had him, what did it cost, what failed.
 * It ends with the read-with-him questions — the only part a model never fills in.
 */

const M = 60000;
const pct = (xs, p) => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };
const fmtMin = (ms) => { const m = Math.round(ms / M); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`; };
const hh = (ts) => { const d = new Date(ts); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const parseData = (e) => { if (!e || e.data == null) return {}; if (typeof e.data === 'object') return e.data; try { return JSON.parse(e.data) || {}; } catch { return {}; } };

/** Minutes the camera had him, from presence/face events (present + is_him), counted as 1 beat ≤ gapMs each. */
function seenMinutes(faceEvents, { gapMs = 60000 } = {}) {
  let ms = 0, prev = null;
  for (const e of faceEvents) {
    const d = parseData(e);
    const him = !!(d.present && (d.is_him === true || d.him === true));
    if (him && prev != null) ms += Math.min(gapMs, e.ts - prev);
    prev = him ? e.ts : null;
  }
  return Math.round(ms / M);
}

/**
 * ledger({ from, to, events, turns, traces, spend, quota, weightFor }) → { md, summary }
 *  events: obs_events rows {ts, lane, kind, text, data}   turns: {ts, speaker, content, model, unprompted}
 *  traces: cloud_traces rows {ts, task, model, valid}     spend: usage ring items {ts, lane, model, tokens}
 *  quota: { startPct, endPct, limit } (optional)         weightFor: lib/quota.weightFor (optional)
 */
function ledger({ from, to, events = [], turns = [], traces = [], spend = [], quota = null, weightFor = null, now = Date.now() } = {}) {
  const inWin = (ts) => ts >= from && ts < to;
  const ev = events.filter((e) => inWin(e.ts));
  const tr = turns.filter((t) => inWin(t.ts));
  const tc = traces.filter((t) => inWin(t.ts));
  const sp = spend.filter((s) => inWin(s.ts));
  const w = weightFor || ((m) => 100);
  const summary = { from, to, hours: +((to - from) / 3600000).toFixed(1) };
  const L = [];
  L.push(`# A day of the loop — ${new Date(from).toLocaleString()} → ${new Date(Math.min(to, now)).toLocaleString()} (${summary.hours} h)`);
  L.push('');
  // 1. THE LOOP'S ACTS
  const acts = ev.filter((e) => e.lane === 'consciousness' && e.kind === 'act');
  const byAct = {};
  for (const e of acts) { const a = parseData(e).act || String(e.text || '').split(':')[0]; byAct[a] = (byAct[a] || 0) + 1; }
  summary.acts = byAct;
  L.push('## 1. What the loop did on its own');
  L.push(acts.length ? Object.entries(byAct).sort((a, b) => b[1] - a[1]).map(([k, n]) => `- ${k}: ${n}`).join('\n') : '- no acts recorded');
  // 2. REASONING: requests → answers
  const reqs = ev.filter((e) => e.lane === 'consciousness' && e.kind === 'reason');
  const says = ev.filter((e) => e.lane === 'consciousness' && e.kind === 'say');
  const wonders = ev.filter((e) => e.lane === 'consciousness' && e.kind === 'wonder');
  const fails = ev.filter((e) => e.lane === 'consciousness' && e.kind === 'reason_fail');
  const byOp = {};
  for (const e of reqs) { const d = parseData(e); const k = `${d.op}${d.act ? '/' + d.act : ''}`; byOp[k] = (byOp[k] || 0) + 1; }
  summary.reason = { requests: reqs.length, says: says.length, silent: says.filter((e) => parseData(e).silent).length, wonders: wonders.length, failed: fails.length };
  L.push('');
  L.push('## 2. What it asked the slow loop, and what came back');
  L.push(reqs.length ? Object.entries(byOp).map(([k, n]) => `- ${k}: ${n} request(s)`).join('\n') : '- no reasoning requests recorded (the bridge emits them from the boot after 09-05 17:45)');
  L.push(`- answers that became her words to him: ${says.length} (${summary.reason.silent} chose silence) · wonderings: ${wonders.length} · failed: ${fails.length}`);
  for (const e of says) { const d = parseData(e); L.push(`  - ${hh(e.ts)} ${d.act || 'say'}: ${d.silent ? '(silence)' : `"${d.text || e.text || ''}"`}`); }
  for (const e of wonders) L.push(`  - ${hh(e.ts)} wondered: "${(parseData(e).text || e.text || '').slice(0, 160)}"`);
  for (const e of fails) L.push(`  - ${hh(e.ts)} failed: ${parseData(e).error || e.text || ''}`);
  // 3. HIM: seen minutes, his turns, gaps
  const faces = ev.filter((e) => e.lane === 'presence' && e.kind === 'face').sort((a, b) => a.ts - b.ts);
  const seen = seenMinutes(faces);
  const his = tr.filter((t) => t.speaker === 'user').sort((a, b) => a.ts - b.ts);
  const gaps = his.slice(1).map((t, i) => t.ts - his[i].ts);
  summary.him = { seenMin: seen, turns: his.length, longestQuietMin: gaps.length ? Math.round(Math.max(...gaps) / M) : null };
  L.push('');
  L.push('## 3. Him');
  L.push(`- the camera had him for about ${seen} min of ${Math.round((Math.min(to, now) - from) / M)}`);
  L.push(`- his turns to her: ${his.length}${gaps.length ? ` · longest quiet between two: ${fmtMin(Math.max(...gaps))}` : ''}`);
  const arrivals = reqs.filter((e) => parseData(e).act === 'arrival').length, reaches = reqs.filter((e) => parseData(e).act === 'reach').length;
  L.push(`- arrivals the loop noticed: ${arrivals} · reaches for his word: ${reaches}`);
  // 4. HER SAYS
  const herPrompted = tr.filter((t) => t.speaker === 'ai_said' && !t.unprompted).length;
  const herUnprompted = tr.filter((t) => t.speaker === 'ai_said' && t.unprompted);
  const byModel = {};
  for (const t of herUnprompted) byModel[t.model || '?'] = (byModel[t.model || '?'] || 0) + 1;
  const thoughts = tr.filter((t) => t.speaker === 'ai_thought').length;
  summary.her = { prompted: herPrompted, unprompted: herUnprompted.length, unpromptedBy: byModel, thoughts };
  L.push('');
  L.push('## 4. Her');
  L.push(`- replies to him: ${herPrompted} · unprompted says: ${herUnprompted.length}${herUnprompted.length ? ` (${Object.entries(byModel).map(([k, n]) => `${k} ${n}`).join(', ')})` : ''} · thoughts logged: ${thoughts}`);
  // 5. THE CAMERA TRIAL
  const pairs = ev.filter((e) => e.lane === 'presence' && e.kind === 'face_ab');
  const agree = pairs.filter((e) => parseData(e).agree).length;
  summary.faceAb = { pairs: pairs.length, agree };
  L.push('');
  L.push('## 5. The camera trial (the face model against the global one)');
  L.push(pairs.length ? `- ${pairs.length} pair(s), ${agree} agreed on the expression label (${Math.round(100 * agree / pairs.length)}%)` : '- no pairs yet (the trial runs while he is in frame, 40 pairs a boot)');
  // 6. THE DECIDER
  const ticks = tc.filter((t) => t.task === 'autonomy_tick');
  const valid = ticks.filter((t) => t.valid).length;
  summary.decider = { ticks: ticks.length, decided: valid };
  L.push('');
  L.push('## 6. The decider');
  L.push(ticks.length ? `- ${ticks.length} tick(s), ${valid} returned a decision (${Math.round(100 * valid / ticks.length)}%)` : '- no ticks in the window');
  // 7. THE POOL
  const byLane = {}, byHour = {};
  for (const s of sp) { const c = w(s.model) * (Number(s.tokens) || 0) / 1000; byLane[s.lane || '?'] = (byLane[s.lane || '?'] || 0) + c; const h = new Date(s.ts).getHours(); byHour[h] = (byHour[h] || 0) + c; }
  const total = Object.values(byLane).reduce((a, b) => a + b, 0);
  summary.pool = { compute: Math.round(total), byLane: Object.fromEntries(Object.entries(byLane).map(([k, v]) => [k, Math.round(v)])), startPct: quota && quota.startPct, endPct: quota && quota.endPct };
  L.push('');
  L.push('## 7. What it cost');
  L.push(`- compute spent in the window: ${Math.round(total).toLocaleString()}${quota && quota.limit ? ` (${(100 * total / quota.limit).toFixed(1)}% of the weekly pool)` : ''}`);
  L.push(Object.entries(byLane).sort((a, b) => b[1] - a[1]).map(([k, v]) => `  - ${k}: ${Math.round(v).toLocaleString()} (${total ? Math.round(100 * v / total) : 0}%)`).join('\n') || '  - nothing metered');
  if (quota && quota.startPct != null && quota.endPct != null) L.push(`- the pool: ${Math.round(quota.startPct * 100)}% → ${Math.round(quota.endPct * 100)}% used`);
  const closures = ev.filter((e) => e.lane === 'quota' && (e.kind === 'closed' || e.kind === 'reopened'));
  if (closures.length) L.push(closures.map((e) => `  - ${hh(e.ts)} ${e.kind}: ${parseData(e).lane || e.text}`).join('\n'));
  const runs = ev.filter((e) => e.lane === 'operator' && e.kind === 'run_spend');
  if (runs.length) {
    const toks = runs.map((e) => Number(parseData(e).tokens) || 0);
    const hits = runs.filter((e) => parseData(e).hit).length;
    summary.runs = { n: runs.length, p50: pct(toks, 0.5), max: Math.max(...toks), budgetHits: hits };
    L.push(`- operator runs: ${runs.length} · tokens p50 ${pct(toks, 0.5).toLocaleString()} · max ${Math.max(...toks).toLocaleString()} · budget reached ${hits} time(s)`);
  }
  // 8. THE READ WITH HIM
  L.push('');
  L.push('## 8. To read with him (a model never fills these in)');
  L.push('- Did any of her unprompted words feel like HERS, not a script? Which one, and why.');
  L.push('- Did the loop notice him at the right moments — the returns, the quiet stretches — or miss them?');
  L.push('- Was anything she did on her own unwelcome (a look, a reach, a cover)?');
  L.push('- Did the day feel more like two people in a room than yesterday? One sentence.');
  return { md: L.join('\n'), summary };
}

module.exports = { ledger, seenMinutes, parseData };
