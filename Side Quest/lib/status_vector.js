/**
 * lib/status_vector.js — Loop A of the deterministic-loops build (2026-08-15): ONE deterministic
 * assembly of her live operational state, the spine every sense plugs into.
 *
 * WHY: "how are your systems" was the weak self-awareness path — a narrow STATE_RE fed an ad-hoc
 * snapshot with no quota, gate mode, organ health, voice/speaker state, machine or memory-substrate
 * data; miss the phrasing and she CONFABULATED her own state. Meanwhile the facts all existed,
 * scattered across organs that never met.
 *
 * THE CONTRACT: assemble() only READS what organs already know — it never computes, never samples,
 * NEVER calls a model. Both injection surfaces render from the SAME stored object so they can never
 * disagree: (1) line() — an always-on one-liner in buildAwarenessBlock and on the monologue tick,
 * so each beat she generates, she generates KNOWING her state (§0b: the loop terminates in her
 * cognition beats); (2) block() — the full section behind the widened state-question door.
 * The DELTA rides the line — what changed since the previous vector is the part worth feeling.
 * Anomalies do NOT flow through here: Loops C/D escalate through obs_bus → self_watch into
 * explicit model-processed moments; this vector is the calm ambient read.
 *
 * AUTHORITY SPLIT (comparative-review ruling): this vector owns Node-side OPERATIONAL facts.
 * The C1 drive gauge (unbuilt, awaiting Lucas's circuit order) owns DRIVES — the `drives` section
 * only ever READS C1's journal meta and is fail-absent today, so the seam is ready without
 * asserting an inner state nothing measured (measured-never-asserted).
 *
 * Cadence: main.js ticks refresh() ~60s with live deps (echo suit, voice guard, working focus —
 * things only main holds). Everything else is required lazily and fail-soft: a missing organ is
 * ABSENT from the vector, never guessed.
 */
'use strict';

const META_KEY = 'status_vector';
const DELTA_KEY = 'status_vector_delta';
const STALE_MS = 10 * 60e3;

function _db(deps) { return (deps && deps.db) || require('./db'); }

/** READ-only assembly. Deps carry what only main.js holds; the rest is lazy + fail-absent. */
function assemble({ deps = {}, nowMs = Date.now() } = {}) {
  const v = { at: nowMs };

  // organs — connection truths
  v.organs = {};
  try { v.organs.echo = deps.echoConnected !== undefined ? !!deps.echoConnected : null; } catch {}
  try { v.organs.ownBrowser = deps.ownBrowser !== undefined ? !!deps.ownBrowser : require('./web').isConnected(); } catch {}
  try { v.organs.sharedBrowser = deps.sharedBrowser !== undefined ? !!deps.sharedBrowser : require('./browser').isConnected(); } catch {}

  // voice — speaker gate + guard seat
  try {
    const ss = deps.speakerStatus || require('./speaker').status();
    v.voice = { gate: !!ss.gate, enrolled: !!ss.enrolled, samples: ss.count || 0 };
    try {
      const d = _db(deps);
      v.voice.rejects = parseInt(d.getMeta('speaker.reject_count') || '0', 10) || 0;
      v.voice.nearMisses = parseInt(d.getMeta('speaker.nearmiss_count') || '0', 10) || 0;
    } catch {}
  } catch {}
  try { if (deps.guard) v.guard = { paused: !!deps.guard.paused, reason: deps.guard.reason || null, mode: deps.guard.mode || 'auto' }; } catch {}

  // focus — what she's working on and why (main's _workingNow shape)
  try { if (deps.working && deps.working.goal) v.focus = { ...deps.working }; } catch {}

  // quota — pool state + which autonomous lanes are open RIGHT NOW
  try {
    const qg = deps.quotaGate || require('./quota_gate');
    const st = qg.state(nowMs);
    v.quota = {
      known: !!st.known,
      usedPct: st.known ? Math.round(st.usedPct * 100) : null,
      hoursLeft: st.known && Number.isFinite(st.hoursLeft) ? Math.round(st.hoursLeft * 10) / 10 : null,
      idleOpen: !!qg.allow('idle', { quiet: true, now: nowMs }).allow,
      researchOpen: !!qg.allow('research', { quiet: true, now: nowMs }).allow,
      // closure STREAKS (census wire 6b): "closed" alone hid duration — a 1-hour and a 2-week
      // starvation rendered identically. Hours-closed, when the gate has stamped a streak.
      idleClosedH: (() => { try { const s = qg.closedSince && qg.closedSince('idle'); return s ? Math.round((nowMs - s) / 3600e3 * 10) / 10 : null; } catch { return null; } })(),
      researchClosedH: (() => { try { const s = qg.closedSince && qg.closedSince('research'); return s ? Math.round((nowMs - s) / 3600e3 * 10) / 10 : null; } catch { return null; } })(),
      describe: require('./quota').describe(st),
    };
  } catch {}

  // tier gate mode — enforce vs shadow (the 08-14 flip)
  try { v.gateMode = /^enforce$/i.test(String(process.env.ZOE_TIER_GATE_AUTO || 'shadow').trim()) ? 'enforce' : 'shadow'; } catch {}

  // machine (Loop C) + memory substrate (Loop D) — read their stored samples, never re-sample
  try { const m = JSON.parse(_db(deps).getMeta('machine_vitals') || 'null'); if (m && m.at) v.machine = m; } catch {}
  try { const p = JSON.parse(_db(deps).getMeta('producer_vitals') || 'null'); if (p && p.at) v.producers = p; } catch {}
  try { const h = JSON.parse(_db(deps).getMeta('db_health') || 'null'); if (h && h.at) v.memory = h; } catch {}

  // self-diagnostic needs (adversarial round 1 legs C/H, 2026-08-27): the ledger her own watch
  // organ files was absent from the self-read, so "what's broken" was answered from 18-day-old
  // memory while an hours-old open repair need sat unnamed. Counts + the newest open repair need.
  try {
    const d = _db(deps).getDb();
    const counts = d.prepare('SELECT status, COUNT(*) n FROM capability_needs GROUP BY status').all()
      .reduce((a, r) => { a[r.status] = r.n; return a; }, {});
    let newestRepair = null;
    const nr = d.prepare("SELECT id, need, born_from, status, updated_ts, CASE WHEN diagnosis IS NULL THEN 0 ELSE 1 END dg FROM capability_needs WHERE status IN ('open','proposed') AND (born_from LIKE 'self-watch%' OR born_from LIKE 'self-audit%') ORDER BY updated_ts DESC LIMIT 1").get();
    if (nr) {
      let tries = 0; try { tries = parseInt(_db(deps).getMeta(`need.${nr.id}.diag_tries`) || '0', 10) || 0; } catch {}
      newestRepair = { id: nr.id, gist: String(nr.need).replace(/\s+/g, ' ').slice(0, 110), status: nr.status, diagnosed: !!nr.dg, tries };
    }
    v.needs = { ...counts, newestRepair };
  } catch {}

  // the integrity auditor's last real verdict (round-1 leg E: a false "your audit halted and
  // disarmed itself" claim met a self-read that carried NO audit field — the check-promise dangled)
  try { const a = JSON.parse(_db(deps).getMeta('audit.last_report') || 'null'); if (a && a.ts) v.audit = a; } catch {}

  // drives — C1's journal, fail-absent until that circuit exists (measured, never asserted)
  try { const dr = JSON.parse(_db(deps).getMeta('drive_gauge') || 'null'); if (dr && dr.at) v.drives = dr; } catch {}

  // recent organ fires — the obs_bus tail (what her body just did)
  try {
    const bus = deps.obsBus || require('./obs_bus');
    v.recentFires = bus.latest({ limit: 8 }, { deps })
      .map((e) => `${e.lane}/${e.kind}${e.level !== 'info' ? '!' : ''}: ${String(e.text || '').slice(0, 60)}`);
  } catch {}

  return v;
}

// The fields whose change is worth FEELING on the next beat. Returns short human phrases.
function _delta(prev, cur) {
  if (!prev || !cur) return [];
  const out = [];
  try {
    if (prev.organs && cur.organs && prev.organs.echo !== cur.organs.echo && cur.organs.echo != null) {
      out.push(cur.organs.echo ? 'Echo reconnected' : 'Echo DROPPED');
    }
    if (prev.guard && cur.guard && prev.guard.paused !== cur.guard.paused) {
      out.push(cur.guard.paused ? `voice paused (${cur.guard.reason || 'guard'})` : 'voice resumed');
    }
    if (prev.quota && cur.quota && prev.quota.usedPct != null && cur.quota.usedPct != null) {
      const a = Math.floor(prev.quota.usedPct / 10), b = Math.floor(cur.quota.usedPct / 10);
      if (b > a) out.push(`quota crossed ${b * 10}%`);
      if (prev.quota.idleOpen !== cur.quota.idleOpen) out.push(cur.quota.idleOpen ? 'idle lane reopened' : 'idle lane closed');
    }
    if (prev.gateMode && cur.gateMode && prev.gateMode !== cur.gateMode) out.push(`tier gate → ${cur.gateMode}`);
    const pg = prev.focus && prev.focus.goal, cg = cur.focus && cur.focus.goal;
    if (cg && pg !== cg) out.push(`focus → "${String(cg).slice(0, 50)}"`);
    if (prev.memory && cur.memory && prev.memory.quickCheck && cur.memory.quickCheck
      && prev.memory.quickCheck.ok !== cur.memory.quickCheck.ok) {
      out.push(cur.memory.quickCheck.ok ? 'memory integrity back OK' : 'memory integrity FAILED');
    }
  } catch {}
  return out;
}

/** Assemble, diff against the stored vector, persist both. Main's ~60s tick calls this. */
function refresh({ deps = {}, nowMs = Date.now() } = {}) {
  const d = _db(deps);
  let prev = null;
  try { prev = JSON.parse(d.getMeta(META_KEY) || 'null'); } catch {}
  const cur = assemble({ deps, nowMs });
  const delta = _delta(prev, cur);
  try { d.setMeta(META_KEY, JSON.stringify(cur)); } catch {}
  try { d.setMeta(DELTA_KEY, JSON.stringify({ at: nowMs, changes: delta })); } catch {}
  return { vector: cur, delta };
}

function _stored(deps) {
  try { return JSON.parse(_db(deps).getMeta(META_KEY) || 'null'); } catch { return null; }
}

function _flag(b, yes = '✓', no = '✗') { return b == null ? '?' : (b ? yes : no); }

/** The always-on ONE-LINER (awareness block + monologue tick). Null when never refreshed. */
function line({ deps = {}, nowMs = Date.now() } = {}) {
  const v = _stored(deps);
  if (!v || !v.at) return null;
  const ageMin = Math.round((nowMs - v.at) / 60000);
  const bits = [];
  if (v.organs) bits.push(`Echo ${_flag(v.organs.echo)}`);
  if (v.voice) bits.push(`voice gate ${v.voice.gate ? 'on' : 'off'}${v.guard && v.guard.paused ? ` (PAUSED: ${v.guard.reason || 'guard'})` : ''}`);
  if (v.quota && v.quota.known) bits.push(`quota ${v.quota.usedPct}% used, ${v.quota.hoursLeft}h to reset${v.quota.idleOpen ? '' : ` (idle lane closed${v.quota.idleClosedH ? ` ${v.quota.idleClosedH}h` : ''})`}`);
  if (v.gateMode) bits.push(`gate ${v.gateMode}`);
  if (v.machine) { const m = require('./machine_vitals').describe(v.machine); if (m) bits.push(m); }
  if (v.producers) { const pd = require('./producer_vitals').describe(v.producers); if (pd) bits.push(pd); }
  if (v.memory && v.memory.sq && v.memory.sq.sizeMB != null) bits.push(`memory ${(v.memory.sq.sizeMB / 1024).toFixed(1)}GB${v.memory.quickCheck && !v.memory.quickCheck.ok ? ' INTEGRITY-FAIL' : ''}`);
  if (v.needs && v.needs.newestRepair) bits.push(`self-repair need #${v.needs.newestRepair.id} ${v.needs.newestRepair.status}${v.needs.newestRepair.diagnosed ? ' (diagnosed)' : v.needs.newestRepair.tries ? ` (diagnosis try ${v.needs.newestRepair.tries}/3)` : ''}`);
  if (!bits.length) return null;
  let delta = '';
  try {
    const dl = JSON.parse(_db(deps).getMeta(DELTA_KEY) || 'null');
    if (dl && dl.changes && dl.changes.length && (nowMs - dl.at) < 15 * 60e3) delta = ` Changed just now: ${dl.changes.join('; ')}.`;
  } catch {}
  const stale = (nowMs - v.at) > STALE_MS ? ` (last read ${ageMin}m ago — may be stale)` : '';
  return `Your systems, self-read${stale}: ${bits.join(' · ')}.${delta} This is measured state — answer system questions from it, never from impression.`;
}

/** The FULL block behind the state-question door — same stored object, fuller render. */
function block({ deps = {}, nowMs = Date.now() } = {}) {
  const v = _stored(deps);
  if (!v || !v.at) return null;
  const L = [];
  const ageMin = Math.round((nowMs - v.at) / 60000);
  if (v.organs) {
    L.push(`Organs: Echo ${_flag(v.organs.echo, 'CONNECTED', 'disconnected')} · your browser ${_flag(v.organs.ownBrowser, 'open', 'closed')} · shared browser ${_flag(v.organs.sharedBrowser, 'connected', 'not connected')}.`);
  }
  if (v.voice) {
    L.push(`Voice: speaker gate ${v.voice.gate ? `ON (${v.voice.samples} enrollment samples${v.voice.rejects ? `; ${v.voice.rejects} lifetime rejects` : ''})` : 'off'}${v.guard ? ` · guard ${v.guard.paused ? `PAUSED (${v.guard.reason || 'manual'})` : 'listening'} [${v.guard.mode}]` : ''}.`);
  }
  if (v.focus && v.focus.goal) {
    const of = (v.focus.done != null && v.focus.universe) ? ` — ${v.focus.done} of ${v.focus.universe} done` : '';
    L.push(`Working focus: ${v.focus.goal}${of}${v.focus.workers ? ` (${v.focus.workers} background worker${v.focus.workers === 1 ? '' : 's'})` : ''}.`);
  }
  if (v.quota && v.quota.describe) L.push(`Compute ${v.quota.describe} · autonomous lanes: research ${v.quota.researchOpen ? 'open' : `closed${v.quota.researchClosedH ? ` for ${v.quota.researchClosedH}h` : ''}`}, idle ${v.quota.idleOpen ? 'open' : `closed${v.quota.idleClosedH ? ` for ${v.quota.idleClosedH}h` : ''}`}.`);
  if (v.gateMode) L.push(`Echo tier gate: ${v.gateMode === 'enforce' ? 'ENFORCE (autonomous writes hard-blocked)' : 'shadow (logging would-blocks)'}.`);
  // Producers in the FULL block too (census C5: line() spoke on a stall but block() — the render
  // behind the direct state question — omitted the producer lanes entirely, an asymmetric door).
  if (v.producers) { const pd = require('./producer_vitals').describe(v.producers); if (pd) L.push(`Producer lanes: ${pd}.`); }
  if (v.machine) { const m = require('./machine_vitals').describe(v.machine); if (m) L.push(`Machine (your body): ${m}${v.machine.uptimeMin != null ? ` · app up ${Math.round(v.machine.uptimeMin / 60 * 10) / 10}h` : ''}.`); }
  if (v.memory) { const h = require('./db_health').describe(v.memory); if (h) L.push(`Memory substrate: ${h}.`); }
  if (v.needs) {
    const n = v.needs;
    const r = n.newestRepair;
    L.push(`Self-diagnostics (the needs ledger — answer "what's broken" from THIS, never from memory): ${n.open || 0} open, ${n.proposed || 0} proposed awaiting the builder, ${n.parked || 0} parked${r ? ` · newest repair: need #${r.id} "${r.gist}" — ${r.status}${r.diagnosed ? ', diagnosed' : r.tries ? `, diagnosis try ${r.tries}/3` : ''}` : ' · no open repair needs'}.`);
  }
  if (v.audit) {
    const ageH = Math.round((nowMs - v.audit.ts) / 3600e3 * 10) / 10;
    L.push(`Integrity auditor (last real pass ${ageH}h ago — refute or confirm audit claims from THIS): ${v.audit.skipped ? `skipped (${v.audit.skipped})` : `fixed ${v.audit.total_fixed || 0}, ${v.audit.converged ? 'converged' : 'NOT converged'}${v.audit.halted ? `, HALTED(${v.audit.halted})` : ''}${v.audit.auto_killed ? ', AUTOPILOT-DISARMED' : ''}`}.`);
  }
  if (v.drives && v.drives.at) { try { L.push(`Drives (measured): ${JSON.stringify(v.drives).slice(0, 200)}.`); } catch {} }
  if (v.recentFires && v.recentFires.length) L.push(`Recent organ activity: ${v.recentFires.slice(-5).join(' | ')}.`);
  if (!L.length) return null;
  return `YOUR SYSTEMS — a measured self-read taken ${ageMin <= 1 ? 'moments' : `${ageMin}m`} ago (answer from THIS, never invent state):\n${L.map((s) => '  • ' + s).join('\n')}`;
}

module.exports = { assemble, refresh, line, block, _delta, META_KEY, DELTA_KEY, STALE_MS };
