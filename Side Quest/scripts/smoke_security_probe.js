/* smoke_security_probe.js — security self-audit, increment 4 (2026-09-04): the own-host RUNTIME probes.
 *
 * Enumerates the host's TCP listeners (netstat + tasklist, a local read), scopes findings to HER OWN
 * process tree, does ONE benign loopback GET per owned http service (capped, rate-limited) and detects a
 * DevTools/CDP endpoint. WHITE-HAT: probe-and-report — a bind she does not own is host posture in a note,
 * never a fix she claims; a non-loopback host is refused; no payloads. Driven with canned netstat /
 * tasklist / proc-tree + a canned fetch, offline.
 */
'use strict';
const path = require('path'), fs = require('fs');
const P = require('../lib/security_probe');

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`); } };

// ── canned host output ────────────────────────────────────────────────────────────────────────────
const NETSTAT = [
  '  TCP    0.0.0.0:445           0.0.0.0:0     LISTENING   4',        // System — not hers
  '  TCP    0.0.0.0:9999          0.0.0.0:0     LISTENING   5000',     // her electron on all interfaces → HIGH
  '  TCP    0.0.0.0:11434         0.0.0.0:0     LISTENING   6000',     // ollama — not hers → note only
  '  TCP    127.0.0.1:8765        0.0.0.0:0     LISTENING   5001',     // her python (loopback http) → probed, clean
  '  TCP    127.0.0.1:9222        0.0.0.0:0     LISTENING   5002',     // her chrome (loopback http) → CDP → HIGH',
  '  TCP    [::1]:22              [::]:0        LISTENING   5000',     // her electron, loopback, non-http → enumerated, not probed
  '  TCP    127.0.0.1:0                                   nope',       // malformed → skipped
].join('\n');
const TASKLIST = [
  '"System","4","Services","0","0 K"',
  '"electron.exe","5000","Console","1","1 K"',
  '"ollama.exe","6000","Console","1","1 K"',
  '"python.exe","5001","Console","1","1 K"',
  '"chrome.exe","5002","Console","1","1 K"',
].join('\n');
const exec = (cmd, args) => (/netstat/i.test(cmd) ? NETSTAT : /tasklist/i.test(cmd) ? TASKLIST : '');
// her tree: root 1 → electron 5000 → python 5001, chrome 5002; System 4 and ollama 6000 are NOT under 1
const procTree = [['1', '0'], ['5000', '1'], ['5001', '5000'], ['5002', '5000'], ['4', '0'], ['6000', '999']];
const mkRes = (status, body, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: (n) => headers[n.toLowerCase()] || null }, text: async () => body || '' });
const fetchImpl = async (url) => {
  if (/:9222\/json\/version$/.test(url)) return mkRes(200, '{"Browser":"Chrome/1","webSocketDebuggerUrl":"ws://127.0.0.1:9222/x"}');
  if (/:8765\/json\/version$/.test(url)) return mkRes(404, 'not found');
  if (/:9222\/$/.test(url)) return mkRes(200, 'devtools');
  if (/:8765\/$/.test(url)) return mkRes(200, 'ok', { server: 'uvicorn' });
  return mkRes(404, '');
};
const deps = { exec, procTree, fetchImpl, rootPid: 1 };

(async () => {
  // ── enumeration ─────────────────────────────────────────────────────────────────────────────────
  const ls = await P.enumerateListeners({ deps });
  ok(ls.length === 6, `enumerates the six LISTENING rows, skips the malformed one (${ls.length})`);
  const byPort = Object.fromEntries(ls.map((l) => [l.port, l]));
  ok(byPort['9999'] && byPort['9999'].proc === 'electron.exe' && byPort['9999'].exposure === 'all-interfaces', 'a 0.0.0.0 row is all-interfaces, pid mapped to its process name');
  ok(byPort['8765'] && byPort['8765'].exposure === 'loopback' && byPort['8765'].proc === 'python.exe', '127.0.0.1 is loopback');
  ok(byPort['22'] && byPort['22'].host === '::1' && byPort['22'].exposure === 'loopback', 'a [::1] v6 address is parsed and classified loopback');
  ok(P._classify('0.0.0.0') === 'all-interfaces' && P._classify('::') === 'all-interfaces' && P._classify('192.168.1.9') === 'other', 'classify: 0.0.0.0/:: are all-interfaces, a LAN ip is other');

  // ── the owned-asset boundary (her process tree) ──────────────────────────────────────────────────
  const owned = await P.ownedPidSet(1, { deps });
  ok(owned.size === 4 && owned.has('1') && owned.has('5000') && owned.has('5001') && owned.has('5002') && !owned.has('4') && !owned.has('6000'),
    `ownedPidSet BFS: root + its descendants only (${[...owned].sort().join(',')})`);
  ok((await P.ownedPidSet(999999, { deps })).size === 1, 'an unknown root owns only itself — never the host by accident');

  // ── probeHttp: loopback only, non-destructive ────────────────────────────────────────────────────
  ok((await P.probeHttp('192.168.1.9', '80', { deps })).skipped, 'probeHttp refuses a non-loopback host (the boundary)');
  const p8765 = await P.probeHttp('127.0.0.1', '8765', { deps });
  ok(p8765.answered && p8765.status === 200 && p8765.cdp === false, 'probeHttp GETs a loopback service: answered, not a CDP endpoint');
  const p9222 = await P.probeHttp('127.0.0.1', '9222', { deps });
  ok(p9222.answered && p9222.cdp === true, 'probeHttp detects a DevTools/CDP endpoint (/json/version carries a debugger url)');

  // ── the full pass: findings for HER exposures only ───────────────────────────────────────────────
  const rec = [];
  const r = await P.runProbeOnce({ deps: { ...deps, findings: { record: (f) => { rec.push(f); return { id: rec.length, deduped: false }; }, summary: () => ({ open: 2, bySeverity: { high: 2 }, byClass: { runtime: 2 } }) }, ledger: null } });
  ok(r.ok && r.listeners === 6 && r.recorded === 2, `runProbeOnce: 6 listeners, 2 findings recorded (${JSON.stringify({ listeners: r.listeners, probed: r.probed, recorded: r.recorded })})`);
  ok(r.probed === 3, 'probes her OWN http services via loopback (8765 + 9222 + the 0.0.0.0:9999; the v6 :22 non-http port is not probed)');
  const t = rec.map((f) => f.title).join(' | ');
  ok(/her service on all interfaces \(:9999\)/.test(t) && rec.find((f) => /:9999/.test(f.title)).severity === 'high', 'her 0.0.0.0 bind is a HIGH runtime finding');
  ok(/her remote-debugging endpoint open \(:9222\)/.test(t) && rec.find((f) => /:9222/.test(f.title)).severity === 'high', 'her live CDP endpoint is a HIGH runtime finding');
  ok(!rec.some((f) => /445|11434/.test(f.title)), 'a host/third-party bind (System:445, ollama:11434) is NEVER flagged as her finding');
  ok(rec.every((f) => f.class === 'runtime' && f.proposed_fix && f.evidence), 'every finding is class runtime with evidence + a fix');
  const noteText = r.notes.join(' || ');
  ok(/1 in her stack/.test(noteText), 'the inventory note counts her exposed binds');
  ok(/host\/third-party/.test(noteText) && /ollama\.exe:11434/.test(noteText) && /System:445/.test(noteText), 'the note REPORTS the host posture (the boundary giving) without claiming its fix');

  // ── a CDP endpoint that is ALSO all-interfaces is CRITICAL (LAN-reachable code exec) ──────────────
  const NET2 = '  TCP    0.0.0.0:9222          0.0.0.0:0     LISTENING   5002\n';
  const rec2 = [];
  await P.runProbeOnce({ deps: { exec: (c) => (/netstat/i.test(c) ? NET2 : TASKLIST), procTree, fetchImpl, rootPid: 1,
    findings: { record: (f) => { rec2.push(f); return { id: 1, deduped: false }; }, summary: () => ({ open: 1, bySeverity: {}, byClass: {} }) }, ledger: null } });
  ok(rec2.length === 1 && rec2[0].severity === 'critical' && /all interfaces/.test(rec2[0].title), 'her CDP endpoint bound to all interfaces is CRITICAL (one finding, not two)');

  // ── contract: the organ, the door, the tool ──────────────────────────────────────────────────────
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  ok(/maybeSecurityProbe = async/.test(main) && /ZOE_SECURITY_PROBES\b/.test(main), 'main.js runs the probe organ behind the ZOE_SECURITY_PROBES kill switch');
  ok(/security_probe'\)\.runProbeOnce\(/.test(main) && /last_security_probe_at/.test(main), 'the organ delegates to runProbeOnce, cooldown-gated');
  const tp = fs.readFileSync(path.join(__dirname, '..', 'lib', 'test_port.js'), 'utf8');
  ok(/\/security\/probe/.test(tp) && /runProbeOnce/.test(tp), 'POST /security/probe triggers a probe on demand (the universal tool surface)');
  ok(P.MAX_PROBES <= 100 && P.LOOPBACK.has('127.0.0.1') && P.LOOPBACK.has('::1'), 'the sweep is bounded and loopback is 127.0.0.1 + ::1 by construction');

  console.log(`\nsmoke_security_probe: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('probe smoke threw:', e); process.exit(1); });
