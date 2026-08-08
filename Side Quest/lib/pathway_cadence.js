/*
 * lib/pathway_cadence.js — M8.4: THE SELF-TEST CADENCE (2026-08-08).
 *
 * The pathway suite (scripts/pathway_suite.js, M8.3) proves the REAL pipeline through the inside
 * access port — but only when someone runs it. This organ runs it unattended: once nightly, in the
 * deep-idle Eastern window, ONLY when the quota gate clears the idle tier, and files every failure
 * as a capability_need row (born_from `pathway:<case>`, so a case that fails night after night
 * FOLDS into one recurring need instead of piling rows). The program finds its own weeds.
 *
 * Gates, in order (every skip is loggable; the first skip of a day IS logged — a cadence that
 * never fires and never says why is the silence disease):
 *   enabled  — ZOE_PATHWAY_CADENCE=0 (env) or meta pathway.cadence='0' turns it off
 *   daily    — meta pathway.last_run_day, stamped BEFORE the run so a crash cannot retry all night
 *   window   — 02:00–06:00 Eastern (all displayed/gated time is Eastern — the clock doctrine)
 *   idle     — Lucas's last turn ≥ 30 min ago (the suite's own per-case guard is 185s; the LAUNCH
 *              bar is deliberately deeper — a nightly test must never shoulder into a live session)
 *   quota    — quota_gate.allow('idle'): the STRICTEST tier floor; if idle work is allowed there is
 *              real headroom for ~5 real turns
 *
 * The suite runs as a CHILD PROCESS (ELECTRON_RUN_AS_NODE) so its turns arrive through the port
 * exactly like any outside driver — what is tested is what runs.
 */
'use strict';

const NIGHT_START_H = 2;                 // Eastern; Lucas's observed quiet hours
const NIGHT_END_H = 6;
const IDLE_MIN_MS = 30 * 60 * 1000;      // launch bar — deeper than the port's 120s per-turn guard
const CHILD_MAX_MS = 60 * 60 * 1000;     // 6 cases x (185s inter-case idle + 300s maxMs) + margin

function easternParts(now = Date.now()) {
  try {
    const d = new Date(now);
    const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(d));
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
    return { hour, day };
  } catch { const d = new Date(now); return { hour: d.getHours(), day: d.toISOString().slice(0, 10) }; }
}

/** decide(...) → { run, reason, day? }. Pure — every gate in one testable place. */
function decide({ now = Date.now(), lastRunDay = '', userIdleMs = 0, quotaAllow = true, quotaReason = '', enabled = true } = {}) {
  const { hour, day } = easternParts(now);
  if (!enabled) return { run: false, reason: 'disabled (ZOE_PATHWAY_CADENCE=0 / meta pathway.cadence=0)' };
  if (day === lastRunDay) return { run: false, reason: `already ran today (${day})` };
  if (hour < NIGHT_START_H || hour >= NIGHT_END_H) return { run: false, reason: `outside the ${NIGHT_START_H}-${NIGHT_END_H}h ET window (now ${hour}h ET)` };
  if (userIdleMs < IDLE_MIN_MS) return { run: false, reason: `Lucas was active ${Math.round(userIdleMs / 60000)}m ago (launch bar ${IDLE_MIN_MS / 60000}m)` };
  if (!quotaAllow) return { run: false, reason: `quota holds it: ${quotaReason}` };
  return { run: true, reason: `night window ${day} ${hour}h ET, deep idle, quota clear`, day };
}

/** parseResults(stdout) → { cases:[{name, ok, detail}], pass, fail, tallied }. The suite's line
 * format is our own deterministic contract: "[name] running… PASS|FAIL|ERROR…" + indented
 * missing/forbidden detail lines + a final tally. */
function parseResults(stdout) {
  const text = String(stdout || '');
  const cases = [];
  let cur = null;
  for (const line of text.split('\n')) {
    const m = line.match(/^\[([a-z0-9-]+)\] running… (.*)$/);
    if (m) { cur = { name: m[1], ok: /^PASS/.test(m[2]), detail: /^PASS/.test(m[2]) ? '' : m[2].trim() }; cases.push(cur); continue; }
    if (cur && /^\s+(missing|forbidden matched):/.test(line)) cur.detail += (cur.detail ? '; ' : '') + line.trim();
  }
  const t = text.match(/pathway_suite: (\d+) passed, (\d+) failed/);
  return {
    cases,
    pass: t ? Number(t[1]) : cases.filter((c) => c.ok).length,
    fail: t ? Number(t[2]) : cases.filter((c) => !c.ok).length,
    tallied: !!t,
  };
}

/** Spawn the suite as a real outside driver. Resolves { code, out, err } — never rejects. */
function runSuite({ appDir, execPath = process.execPath } = {}) {
  const cp = require('child_process');
  const path = require('path');
  return new Promise((resolve) => {
    let out = '', err = '';
    let child;
    try {
      child = cp.spawn(execPath, [path.join(appDir, 'scripts', 'pathway_suite.js'), '--run'], {
        cwd: appDir, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true,
      });
    } catch (e) { return resolve({ code: -1, out: '', err: String(e.message) }); }
    const killer = setTimeout(() => { try { child.kill(); } catch {} err += `\n[killed at ${CHILD_MAX_MS / 60000}m]`; }, CHILD_MAX_MS);
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('close', (code) => { clearTimeout(killer); resolve({ code, out, err }); });
    child.on('error', (e) => { clearTimeout(killer); resolve({ code: -1, out, err: String(e.message) }); });
  });
}

/** One cadence tick (call hourly). All impure edges injected so the whole organ smokes offline. */
async function tick({
  getMeta, setMeta,
  userIdleMs,                    // () => ms since Lucas's last turn
  quotaAllow,                    // () => { allow, reason } (quota_gate.allow('idle'))
  appDir,
  recordNeed = null,             // (need, {bornFrom, nowMs}) => { id } (capability_need.record)
  log = console.log,
  runSuiteImpl = runSuite,       // injectable for tests
  nowMs = Date.now(),
} = {}) {
  const enabled = String(process.env.ZOE_PATHWAY_CADENCE || getMeta('pathway.cadence') || '1').trim() !== '0';
  const qa = quotaAllow();
  const d = decide({
    now: nowMs, lastRunDay: getMeta('pathway.last_run_day') || '', userIdleMs: userIdleMs(),
    quotaAllow: !!(qa && qa.allow), quotaReason: (qa && qa.reason) || '', enabled,
  });
  if (!d.run) {
    const day = easternParts(nowMs).day;
    if ((getMeta('pathway.last_skip_day') || '') !== day && !/already ran today/.test(d.reason)) {
      setMeta('pathway.last_skip_day', day);
      log(`[pathway] nightly suite skipped — ${d.reason}`);
    }
    return { ran: false, reason: d.reason };
  }
  setMeta('pathway.last_run_day', d.day);   // stamp FIRST — a crashed run must not retry all night
  log(`[pathway] nightly suite starting (${d.reason})`);
  const r = await runSuiteImpl({ appDir });
  const res = parseResults(r.out);
  try { setMeta('pathway.last_result', JSON.stringify({ at: nowMs, pass: res.pass, fail: res.fail, code: r.code })); } catch {}
  log(`[pathway] nightly: ${res.pass} passed, ${res.fail} failed (exit ${r.code})`);
  if (!res.cases.length) log(`[pathway] suite produced NO case lines — head: ${String(r.out || r.err).replace(/\s+/g, ' ').slice(0, 200)}`);
  for (const c of res.cases.filter((x) => !x.ok)) {
    log(`[pathway] FAIL ${c.name}: ${c.detail || '(no detail)'}`);
    try {
      if (recordNeed) {
        const n = recordNeed(`pathway case "${c.name}" regressed — ${(c.detail || 'no detail captured').slice(0, 140)}`, { bornFrom: `pathway:${c.name}`, nowMs });
        if (n && n.id) log(`[pathway] filed need #${n.id} for ${c.name}`);
      }
    } catch (e) { log(`[pathway] need filing failed for ${c.name}: ${e.message}`); }
  }
  return { ran: true, pass: res.pass, fail: res.fail, cases: res.cases, code: r.code };
}

module.exports = { decide, parseResults, runSuite, tick, easternParts, NIGHT_START_H, NIGHT_END_H, IDLE_MIN_MS };
