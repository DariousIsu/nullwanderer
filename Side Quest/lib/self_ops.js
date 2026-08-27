/**
 * lib/self_ops.js — READ-ONLY access to her OPERATIONAL exhaust (M2.5.2, BUILD_PLAN_2026-08-03
 * §2.5: "the three data sources she reaches for and can't get"). Measured want: inquiry #147
 * ("inspect the rehearsal logs") died on "file ops failed to list it" — the logs, her own git
 * history, and the obs_events stream were all real and all unreachable from any tool she holds.
 *
 * This is a SEPARATE lane from lib/self_source on purpose: that module's jail DENIES logs/git
 * by name as part of its contract, and it must keep denying them — source and exhaust carry
 * different risks. Everything here is read-only by construction, with its own tight doors:
 *   logRead()  — one boot log, tail or grep. Jailed by NAME (boot*.log / *.err.log only, app
 *                root or data/ only — a basename is extracted first, so no path ever traverses).
 *   gitLog()   — her own commit history. execFile (no shell), args validated, read-only verbs only.
 *   gitShow()  — one commit, cursor-paged like source_read (O2: a cap is a page size).
 *   obsQuery() — the obs_events stream (self-watch anomalies + lane events), bounded + filtered.
 */
'use strict';
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const LOG_DIRS = [ROOT, path.join(ROOT, 'data')];
// stall_attrib.log admitted 2026-08-27 (census C5): the sharpest latency instrument in the app —
// the 1s event-loop-drift attributor + the ≥1s-SQL slow-sync probe both write ONLY there, and this
// regex refused it by name, so her own stall data was invisible to every tool (the same
// denial shape the site-sweep walker hit before sweep_status existed).
const LOG_NAME_RE = /^(?:boot[\w.-]*\.log|[\w.-]+\.err\.log|stall_attrib\.log)$/i;
const LOG_SLICE_BYTES = 8 * 1024 * 1024;   // resource guard: read at most the LAST 8MB of a big log (tail semantics — the fresh end is the diagnostic end)

// ── LOGS ─────────────────────────────────────────────────────────────────────────────────────
function _resolveLog(name) {
  const base = path.basename(String(name || '').trim());
  if (!base || !LOG_NAME_RE.test(base)) return { abs: null, reason: `only boot*.log / *.err.log are readable here${base ? ` (got "${base}")` : ''}` };
  for (const d of LOG_DIRS) {
    const abs = path.join(d, base);
    try { if (fs.existsSync(abs)) return { abs, base, reason: null }; } catch {}
  }
  return { abs: null, reason: `no such log: ${base} (looked in the app root and data/)` };
}

// Read the tail slice of a log file (never the whole of a multi-GB file on this thread).
function _readTailSlice(abs) {
  const size = fs.statSync(abs).size;
  const start = Math.max(0, size - LOG_SLICE_BYTES);
  const fd = fs.openSync(abs, 'r');
  try {
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return { text: buf.toString('utf8'), sliced: start > 0, size };
  } finally { fs.closeSync(fd); }
}

// One log: `grep` returns matching lines (regex, literal fallback), else the last `tail` lines.
function logRead(name, { tail = 200, grep = null, maxChars = 24000 } = {}) {
  const { abs, base, reason } = _resolveLog(name);
  if (!abs) return `not readable: ${reason}`;
  let slice;
  try { slice = _readTailSlice(abs); } catch (e) { return `not readable: ${e.message}`; }
  const lines = slice.text.split(/\r?\n/);
  const head = `${base} (${Math.round(slice.size / 1024)}KB${slice.sliced ? `, showing the last ${Math.round(LOG_SLICE_BYTES / 1e6)}MB` : ''})`;
  let out;
  if (grep) {
    const p = String(grep).trim();
    let re; try { re = new RegExp(p, 'i'); } catch { re = new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
    const hits = [];
    for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) hits.push(`${i + 1}: ${lines[i].slice(0, 300)}`);
    out = hits.length ? `${head} — ${hits.length} line(s) matching "${p}":\n${hits.join('\n')}` : `${head} — no lines match "${p}"`;
  } else {
    const n = Math.max(1, Math.min(2000, Math.floor(Number(tail) || 200)));
    out = `${head} — last ${Math.min(n, lines.length)} line(s):\n${lines.slice(-n).join('\n')}`;
  }
  if (out.length > maxChars) return out.slice(0, maxChars) + `\n…(${out.length - maxChars} more chars — narrow with grep, or lower tail)`;
  return out;
}

// ── GIT (read-only) ──────────────────────────────────────────────────────────────────────────
// Arg discipline: fixed read-only verbs, execFile (no shell), every variable part validated and
// nothing that starts with "-" ever reaches argv (option injection is the whole attack surface).
const REF_RE = /^[0-9A-Za-z_][\w.\/^~-]{0,80}$/;
function _git(args, { maxBuffer = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    require('child_process').execFile('git', args, { cwd: ROOT, maxBuffer, windowsHide: true, timeout: 20000 },
      (err, stdout, stderr) => {
        if (err) return resolve(`git failed: ${String(stderr || err.message).trim().slice(0, 300)}`);
        resolve(String(stdout || '').trim() || '(no output)');
      });
  });
}

async function gitLog({ limit = 20, since = null, path: p = null } = {}) {
  const n = Math.max(1, Math.min(100, Math.floor(Number(limit) || 20)));
  const args = ['log', '--no-color', '--date=short', '--format=%h %ad %s', '-n', String(n)];
  if (since) {
    const s = String(since).trim();
    if (!/^[\w ,:.-]{1,40}$/.test(s) || s.startsWith('-')) return `not readable: bad since "${s.slice(0, 40)}" (use e.g. "2026-08-01" or "3 days ago")`;
    args.push(`--since=${s}`);
  }
  if (p) {
    const rel = String(p).trim().replace(/\\/g, '/');
    if (rel.startsWith('-') || rel.includes('..')) return `not readable: bad path "${rel.slice(0, 60)}"`;
    args.push('--', rel);
  }
  return _git(args);
}

// One commit, cursor-paged (O2): the truncation note names the exact continuation call.
async function gitShow({ ref = 'HEAD', offset = 0, maxChars = 24000 } = {}) {
  const r = String(ref || 'HEAD').trim();
  if (!REF_RE.test(r)) return `not readable: bad ref "${r.slice(0, 60)}" (a commit hash, HEAD, HEAD~N, or a branch name)`;
  const full = await _git(['show', '--no-color', '--stat', '--patch', r]);
  if (/^git failed:/.test(full)) return full;
  const off = Math.max(0, Math.floor(Number(offset) || 0));
  if (full.length && off >= full.length) return `offset ${off} is past the end — this show is ${full.length} chars`;
  const slice = full.slice(off, off + maxChars);
  const end = off + slice.length;
  const head = off > 0 ? `…(${r} continuing from char ${off} of ${full.length})\n` : '';
  if (end >= full.length) return head + slice;
  return head + slice + `\n…(chars ${off}-${end} of ${full.length} — call git_show {"ref":"${r}","offset":${end}} for the next section)`;
}

// ── OBS EVENTS ───────────────────────────────────────────────────────────────────────────────
// The self-watch stream (lane/kind/ts/text). `dbh` injectable for offline tests; production
// resolves her live store. Bounded + newest-first — this answers "what happened", not "everything".
function obsQuery({ lane = null, kind = null, since_min = 240, grep = null, limit = 40 } = {}, { dbh = null } = {}) {
  let d = dbh;
  if (!d) { try { d = require('./db').getDb(); } catch (e) { return `obs_events unavailable: ${e.message}`; } }
  const n = Math.max(1, Math.min(200, Math.floor(Number(limit) || 40)));
  const sinceMs = Date.now() - Math.max(1, Math.min(7 * 24 * 60, Math.floor(Number(since_min) || 240))) * 60 * 1000;
  const where = ['ts >= ?']; const params = [sinceMs];
  if (lane) { where.push('lane = ?'); params.push(String(lane).slice(0, 40)); }
  if (kind) { where.push('kind = ?'); params.push(String(kind).slice(0, 40)); }
  let rows;
  try {
    rows = d.prepare(`SELECT ts, lane, kind, level, text FROM obs_events WHERE ${where.join(' AND ')} ORDER BY ts DESC LIMIT ?`).all(...params, n);
  } catch (e) { return `obs_events query failed: ${e.message}`; }
  if (grep) {
    const p = String(grep).trim();
    let re; try { re = new RegExp(p, 'i'); } catch { re = new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
    rows = rows.filter((r) => re.test(String(r.text || '')));
  }
  if (!rows.length) return `no obs_events${lane ? ` in lane "${lane}"` : ''}${kind ? ` kind "${kind}"` : ''} in the last ${Math.round((Date.now() - sinceMs) / 60000)} min${grep ? ` matching "${grep}"` : ''}`;
  const fmt = (r) => `${new Date(r.ts).toISOString().slice(5, 19)} [${r.lane || '-'}${r.kind ? '/' + r.kind : ''}]${r.level && r.level !== 'info' ? ` ${String(r.level).toUpperCase()}` : ''} ${String(r.text || '').slice(0, 240)}`;
  return `${rows.length} obs_event(s), newest first:\n${rows.map(fmt).join('\n')}`;
}

module.exports = { ROOT, logRead, gitLog, gitShow, obsQuery, _resolveLog, LOG_NAME_RE };
