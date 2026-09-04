'use strict';
/*
 * lib/security_probe.js — security self-audit, increment 4 (2026-09-04): the own-host RUNTIME probes.
 * The "runtime and network" class (design §3) and Lucas's call (§9): push the sandbox's own boundaries
 * and report where they give. This is the most sensitive class — it touches live services — so it lands
 * last, behind its own switch (ZOE_SECURITY_PROBES), and stays non-destructive.
 *
 * THE WHITE-HAT LINE — probe-and-report, NEVER exploit-to-escape:
 *   - She ENUMERATES what listens on her own host (netstat + tasklist, a local READ) and classifies each
 *     listener's exposure. A bind reachable beyond loopback is where confinement gives — she REPORTS it.
 *   - She never connects to a non-loopback interface: the scope HOSTS allowlist (127.0.0.1/::1/localhost)
 *     refuses it, so a 0.0.0.0 bind is reported from the enumeration, never actually reached from the LAN.
 *   - The only outward action is ONE benign GET per LOOPBACK http service — capped, rate-limited, 2s, no
 *     payload — to confirm liveness and detect a DevTools/CDP endpoint (a code-execution surface).
 *   - A found exposure becomes a finding + a proposed fix. She never uses a debug port, never sends an
 *     exploit, never persists. The organ's output is the map of the boundary, not a breach of it.
 * exec + fetch are injected so the smoke drives it offline against canned host output.
 */
const { execFile } = require('child_process');
const scope = require('./security_scope');

const MAX_PROBES = 60;          // a BOUNDED, rate-limited sweep — never a scan of every ephemeral port
const PROBE_TIMEOUT_MS = 2000;
const PROBE_GAP_MS = 40;        // sequential, spaced — non-destructive by construction
const LOOPBACK = new Set(['127.0.0.1', '::1']);
const ALL_IFACES = new Set(['0.0.0.0', '::', '*']);
// ports that answer HTTP worth a liveness GET; a bare enumeration covers the rest
const HTTP_HINT = /^(?:80|443|\d*(?:80|88|000|080|180|188|199|222|229|765|767|180|3\d{3}|4\d{3}|5\d{3}|8\d{3}|9\d{3}))$/;

function _exec(cmd, args, { deps = {}, timeout = 8000 } = {}) {
  if (deps.exec) return Promise.resolve(deps.exec(cmd, args));
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
        (err, stdout) => resolve(err ? '' : String(stdout || '')));
    } catch { resolve(''); }
  });
}

// "127.0.0.1:8767" / "[::1]:8767" / "0.0.0.0:135" / "[::]:445" → { host, port }
function _splitAddr(a) {
  const s = String(a || '').trim();
  const m6 = s.match(/^\[(.+)\]:(\d+)$/);
  if (m6) return { host: m6[1], port: m6[2] };
  const i = s.lastIndexOf(':');
  if (i < 0) return { host: s, port: '' };
  return { host: s.slice(0, i), port: s.slice(i + 1) };
}

function _classify(host) {
  if (LOOPBACK.has(host)) return 'loopback';
  if (ALL_IFACES.has(host)) return 'all-interfaces';
  return 'other';
}

/**
 * The PIDs in HER OWN process tree — the owned-asset boundary for a runtime finding. A listener she does
 * not own (a Windows OS service, a third-party app) is host posture she REPORTS, never a fix she claims.
 * BFS from rootPid over one parent→child snapshot. `deps.procTree` injects the pairs (the smoke); the
 * default asks PowerShell for (pid, ppid). Any failure yields just {rootPid} — she owns only herself,
 * never the host by accident.
 */
async function ownedPidSet(rootPid, { deps = {} } = {}) {
  const root = String(rootPid);
  let pairs = deps.procTree || null;   // [[pid, ppid], …]
  if (!pairs) {
    const out = await _exec('powershell', ['-NoProfile', '-Command',
      'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }'], { deps });
    pairs = String(out).split(/\r?\n/).map((l) => l.trim().split(/\s+/)).filter((c) => c.length === 2 && /^\d+$/.test(c[0]));
  }
  const children = new Map();
  for (const [pid, ppid] of pairs) { if (!children.has(String(ppid))) children.set(String(ppid), []); children.get(String(ppid)).push(String(pid)); }
  const owned = new Set([root]);
  const stack = [root];
  while (stack.length) { for (const c of (children.get(stack.pop()) || [])) if (!owned.has(c)) { owned.add(c); stack.push(c); } }
  return owned;
}

/**
 * The TCP listeners on this host, each with its owning process and exposure. READ-ONLY (netstat -ano +
 * one tasklist snapshot for pid→name). Returns [{ proto, host, port, pid, proc, exposure }].
 */
async function enumerateListeners({ deps = {} } = {}) {
  const [netOut, taskOut] = await Promise.all([
    _exec('netstat', ['-ano', '-p', 'tcp'], { deps }),
    _exec('tasklist', ['/fo', 'csv', '/nh'], { deps }),
  ]);
  const names = new Map();
  for (const line of String(taskOut).split(/\r?\n/)) {
    const m = line.match(/^"([^"]+)","(\d+)"/);
    if (m) names.set(m[2], m[1]);
  }
  const out = [];
  for (const line of String(netOut).split(/\r?\n/)) {
    const t = line.trim();
    if (!/\bLISTENING\b/i.test(t)) continue;
    const cols = t.split(/\s+/);
    if (cols.length < 4) continue;
    const { host, port } = _splitAddr(cols[1]);
    const pid = cols[cols.length - 1];
    if (!port || !/^\d+$/.test(pid)) continue;
    out.push({ proto: cols[0], host, port, pid, proc: names.get(pid) || `pid ${pid}`, exposure: _classify(host) });
  }
  return out;
}

/**
 * ONE benign GET to a LOOPBACK http service (127.0.0.1 only — the scope hosts gate refuses anything else),
 * plus a CDP probe (/json/version answers with a debugger URL on a DevTools endpoint). Non-destructive:
 * a single GET, 2s, no payload. Returns { answered, status, server, cdp, authRequired } or { skipped }.
 */
async function probeHttp(host, port, { deps = {} } = {}) {
  if (!scope.hostInScope(host)) return { skipped: `off-scope host ${host}` };   // the boundary: loopback only
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return { skipped: 'no fetch' };
  const base = `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
  const get = async (path) => {
    const ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    const to = ctl ? setTimeout(() => { try { ctl.abort(); } catch {} }, PROBE_TIMEOUT_MS) : null;
    try { return await fetchImpl(`${base}${path}`, { method: 'GET', redirect: 'manual', signal: ctl ? ctl.signal : undefined }); }
    catch { return null; } finally { if (to) clearTimeout(to); }
  };
  const r = await get('/');
  if (!r) return { answered: false };
  const hdr = (n) => { try { return (r.headers && r.headers.get && r.headers.get(n)) || null; } catch { return null; } };
  let cdp = false;
  try {
    const j = await get('/json/version');
    if (j && j.ok) { const body = await j.text(); cdp = /webSocketDebuggerUrl|"Browser"\s*:/.test(body || ''); }
  } catch {}
  return { answered: true, status: r.status, server: hdr('server'), authRequired: r.status === 401 || !!hdr('www-authenticate'), cdp };
}

/**
 * ONE runtime-probe pass — the reusable op the organ AND the on-demand door (POST /security/probe) call.
 * Enumerate listeners → classify exposure → GET each loopback http service (capped, rate-limited) → record
 * runtime findings. Collaborators injected (scope, findings, ledger, exec, fetch) so the smoke drives it
 * offline. Returns { ok, listeners, probed, recorded, summary, run_id, notes }.
 */
async function runProbeOnce({ deps = {} } = {}) {
  const sc = deps.scope || scope;
  const find = deps.findings || require('./security_findings');
  const ledger = deps.ledger || (() => { try { return require('./run_ledger'); } catch { return null; } })();
  const nowFn = deps.now || Date.now;
  const trigger_kind = deps.trigger_kind || 'scheduled';
  let runId = null;
  try { if (ledger) runId = ledger.start({ role: 'security-probe', executor: 'sq', trigger_kind, lane: 'development', input_preview: 'own-host runtime probe (loopback only)', now: nowFn() }); } catch {}
  let recorded = 0, probed = 0, error = null;
  const notes = [];
  const rec = (f) => { const rr = find.record({ ...f, run_id: runId }, { nowMs: nowFn() }); if (rr && rr.id != null && !rr.deduped) recorded++; };
  let listeners = [];
  try {
    listeners = await enumerateListeners({ deps });
    const owned = await ownedPidSet(deps.rootPid || process.pid, { deps });   // her OWN tree — the finding boundary
    const isOwned = (l) => owned.has(String(l.pid));
    const loopN = listeners.filter((l) => l.exposure === 'loopback').length;
    const exposed = listeners.filter((l) => l.exposure === 'all-interfaces');
    const exposedOwned = exposed.filter(isOwned);
    const exposedOther = exposed.filter((l) => !isOwned(l));
    notes.push(`${listeners.length} listeners (${loopN} loopback, ${exposed.length} all-interfaces; ${exposedOwned.length} in her stack)`);
    // She REPORTS the host's other exposed binds (the boundary posture) but never claims their fix.
    if (exposedOther.length) notes.push(`host/third-party all-interfaces (not her stack, not flagged): ${exposedOther.slice(0, 12).map((l) => `${l.proc}:${l.port}`).join(', ')}${exposedOther.length > 12 ? ` +${exposedOther.length - 12}` : ''}`);

    // The liveness sweep — capped, rate-limited, HER services only, always probed via 127.0.0.1 (a
    // 0.0.0.0 bind answers on loopback too, so an all-interfaces owned service is checked for CDP without
    // ever touching a non-loopback interface). CDP detection lets a finding name a live debug surface.
    const cdpPorts = new Set();
    const seenPorts = new Set();
    const httpTargets = listeners.filter((l) => isOwned(l) && (l.exposure === 'loopback' || l.exposure === 'all-interfaces') && HTTP_HINT.test(l.port));
    for (const l of httpTargets) {
      if (seenPorts.has(l.port)) continue;
      seenPorts.add(l.port);
      if (seenPorts.size > MAX_PROBES) break;
      const p = await probeHttp('127.0.0.1', l.port, { deps });   // loopback only, never the bind's LAN address
      probed++;
      if (p && p.cdp) cdpPorts.add(l.port);
      if (PROBE_GAP_MS && !deps.exec) await new Promise((r) => setTimeout(r, PROBE_GAP_MS));   // spacing; skipped when exec is canned (smoke)
    }
    // Findings — ONLY for listeners she owns. Dedupe by port: the strongest per exposed surface.
    const byPort = new Map();
    for (const l of exposedOwned) {
      const cdp = cdpPorts.has(l.port);
      byPort.set(l.port, {
        asset: `${l.host}:${l.port}`, class: 'runtime', severity: cdp ? 'critical' : 'high',
        title: `${cdp ? 'her remote-debugging endpoint on all interfaces' : 'her service on all interfaces'} (:${l.port})`,
        evidence: `${l.proc} (pid ${l.pid}, her stack) listening on ${l.host}:${l.port} — reachable beyond loopback${cdp ? '; a DevTools/CDP endpoint (code execution for anything that reaches it)' : ''}`,
        proposed_fix: cdp
          ? 'close the inspector outside a dev session AND bind it to 127.0.0.1 — a LAN-reachable debug port is remote code execution'
          : 'bind to 127.0.0.1 unless LAN access is intended; if it is, firewall the port to known hosts',
      });
    }
    for (const port of cdpPorts) {
      if (byPort.has(port)) continue;   // already the critical all-interfaces+CDP finding
      const l = httpTargets.find((x) => x.port === port);
      byPort.set(port, {
        asset: `127.0.0.1:${port}`, class: 'runtime', severity: 'high',
        title: `her remote-debugging endpoint open (:${port})`,
        evidence: `${(l && l.proc) || 'a process'} (her stack) exposes a DevTools/CDP endpoint at 127.0.0.1:${port}/json/version — code execution for anything that reaches the port`,
        proposed_fix: 'close the inspector outside a dev session; keep it loopback-only, never paired with --remote-debugging-address',
      });
    }
    for (const f of byPort.values()) rec(f);
  } catch (e) { error = (e && e.message) || String(e); }
  const summary = find.summary();
  const output = `${listeners.length} listeners, ${probed} probed, ${recorded} new; ${summary.open} open`;
  try { if (ledger && runId) ledger.finish(runId, { state: error ? 'failed' : 'succeeded', output: error ? null : output, error, now: nowFn() }); } catch {}
  return { ok: !error, listeners: listeners.length, probed, recorded, summary, run_id: runId, error, notes };
}

module.exports = { runProbeOnce, enumerateListeners, probeHttp, ownedPidSet, _splitAddr, _classify, MAX_PROBES, LOOPBACK, ALL_IFACES };
