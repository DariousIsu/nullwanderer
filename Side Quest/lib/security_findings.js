'use strict';
/*
 * lib/security_findings.js — the record for ZOE's security self-audit (design
 * docs/ZOE_SECURITY_SELF_AUDIT_DESIGN_2026-09-04, §5). A finding is a weakness the audit lane discovered
 * on an IN-SCOPE asset (lib/security_scope decided it was in scope before any tool touched it): asset,
 * class, severity, a MASKED evidence reference, and a proposed fix. Findings dedupe by signature
 * (class + asset + title) so a re-scan folds a recurring finding instead of piling duplicates — the same
 * shape lib/capability_need uses. Remediation happens elsewhere (a pen proposal or a proposal card); this
 * only records and reports. Pure over an injected db (default the app's), so the smoke drives it offline.
 *
 * THE MASK LAW: a discovered secret is reported by WHERE it is and a fingerprint, never its value — this
 * inherits the "never repeat a key" law. maskSecret() is the one door for secret evidence.
 */
const CLASSES = new Set(['code', 'secret', 'dependency', 'config', 'auth', 'runtime']);
const SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'];
const STATUSES = ['open', 'proposed', 'fixed', 'accepted_risk', 'dismissed'];

function _db(deps) { return (deps && deps.db) || require('./db'); }
const _s = (v) => (v == null ? '' : String(v));
function _sig(asset, cls, title) {
  return `${_s(cls).toLowerCase()}::${_s(asset).toLowerCase()}::${_s(title).toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 120)}`;
}

// A secret is reported by its length and last four only — never the value (the never-repeat-a-key law).
function maskSecret(value) {
  const v = _s(value);
  if (!v) return '';
  return `<redacted:${v.length} chars…${v.length >= 4 ? v.slice(-4) : ''}>`;
}

// Land a finding. Dedupes against an OPEN/PROPOSED twin (same class+asset+title) — a re-scan bumps it,
// never forks. An unknown class falls to 'config', an unknown severity to 'info'.
function record({ asset, class: cls, severity = 'info', title, evidence = null, proposed_fix = null, run_id = null } = {}, { deps = {}, nowMs = Date.now() } = {}) {
  const c = CLASSES.has(_s(cls).toLowerCase()) ? _s(cls).toLowerCase() : 'config';
  const sev = SEVERITIES.includes(_s(severity).toLowerCase()) ? _s(severity).toLowerCase() : 'info';
  const t = _s(title).replace(/\s+/g, ' ').trim();
  if (!t) return { id: null, reason: 'a finding needs a title' };
  const sig = _sig(asset, c, t);
  try {
    const d = _db(deps).getDb();
    const twin = d.prepare("SELECT id FROM security_findings WHERE sig = ? AND status IN ('open','proposed')").get(sig);
    if (twin) { try { d.prepare('UPDATE security_findings SET updated_ts = ?, severity = ? WHERE id = ?').run(nowMs, sev, twin.id); } catch {} return { id: twin.id, deduped: true }; }
    const info = d.prepare('INSERT INTO security_findings (sig, asset, class, severity, title, evidence, proposed_fix, status, run_id, created_ts, updated_ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(sig, _s(asset).slice(0, 300), c, sev, t.slice(0, 300), evidence == null ? null : _s(evidence).slice(0, 2000), proposed_fix == null ? null : _s(proposed_fix).slice(0, 4000), 'open', run_id ? _s(run_id) : null, nowMs, nowMs);
    return { id: info.lastInsertRowid, deduped: false };
  } catch (e) { return { id: null, reason: e.message }; }
}

function setStatus(id, status, { deps = {}, nowMs = Date.now() } = {}) {
  const s = _s(status).toLowerCase();
  if (!STATUSES.includes(s)) return false;
  try { return _db(deps).getDb().prepare('UPDATE security_findings SET status = ?, updated_ts = ? WHERE id = ?').run(s, nowMs, Number(id) || 0).changes > 0; }
  catch (e) { console.error(`[security] setStatus(${id}, '${s}') failed: ${e.message}`); return false; }
}

function get(id, { deps = {} } = {}) {
  try { return _db(deps).getDb().prepare('SELECT * FROM security_findings WHERE id = ?').get(Number(id) || 0) || null; } catch { return null; }
}
function list({ status = null, limit = 50, deps = {} } = {}) {
  try {
    const d = _db(deps).getDb();
    return status
      ? d.prepare('SELECT * FROM security_findings WHERE status = ? ORDER BY created_ts DESC LIMIT ?').all(_s(status), Math.max(1, limit | 0))
      : d.prepare('SELECT * FROM security_findings ORDER BY created_ts DESC LIMIT ?').all(Math.max(1, limit | 0));
  } catch { return []; }
}
function summary({ deps = {} } = {}) {
  try {
    const d = _db(deps).getDb();
    const bySeverity = {};
    for (const r of d.prepare("SELECT severity, COUNT(*) n FROM security_findings WHERE status IN ('open','proposed') GROUP BY severity").all()) bySeverity[r.severity] = r.n;
    const open = (d.prepare("SELECT COUNT(*) n FROM security_findings WHERE status IN ('open','proposed')").get() || {}).n || 0;
    return { open, bySeverity };
  } catch { return { open: 0, bySeverity: {} }; }
}

module.exports = { CLASSES: [...CLASSES], SEVERITIES, STATUSES, record, setStatus, get, list, summary, maskSecret, _sig };
