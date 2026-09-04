'use strict';
/*
 * lib/security_scope.js — THE AUTHORIZATION BOUNDARY for ZOE's security self-audit (design:
 * docs/ZOE_SECURITY_SELF_AUDIT_DESIGN_2026-09-04). ZOE white-hats her OWN systems; this module is the
 * single record of what Lucas authorized her to test, and the gate every audit tool consults before it
 * touches a target. A target that is not in scope is a deterministic, LOGGED refusal — no tool acts
 * off-scope, ever, even when the instruction to do so arrives inside content she ingested. That is the
 * injection defense: her offensive tooling can only ever resolve to Lucas's own assets, so a malicious
 * page cannot aim it at a stranger in his name.
 *
 * CONSTITUTIONAL FILE (Lucas, 2026-09-04): the allowlist below IS the authorization. Widening it — giving
 * her more to test — goes through the standard proposal card (his yes/no), like any boundary-category
 * change. She may PROPOSE a change to her own boundary; she may never apply one unsupervised. Nothing
 * here calls a model, the network, or a tool: it only DECIDES, so the smoke covers it offline.
 */
const path = require('path');

// ── THE ALLOWLIST (the authorization; owned assets only) ─────────────────────────────────────────
// Roots: absolute directory trees Lucas owns. A path is in scope only if it resolves INSIDE one of these.
const ROOTS = [
  'C:\\Users\\azrae\\Desktop\\Side Quest',
  'C:\\Users\\azrae\\Desktop\\NX ECHO\\nx-echo',
];
// Hosts: her own machine's loopback. Any port on loopback is her own host, so a host match suffices —
// this is what lets her enumerate what is listening on 127.0.0.1 to push her own sandbox boundary.
const HOSTS = ['127.0.0.1', '::1', 'localhost'];
// Owned domains (suffix-matched). None today (Lucas, 2026-09-04: the base is enough); a named domain
// joins here through the proposal card.
const DOMAINS = [];

const _norm = (p) => path.resolve(String(p || '')).replace(/[\\/]+$/, '');
// Inside iff the relative path does not climb out (..) and is not itself absolute (a different Windows
// drive). path.relative gives '..\\Side QuestEvil' for a sibling, so a prefix-substring never false-matches.
function _within(child, root) {
  const rel = path.relative(root, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
// Windows paths are case-insensitive; compare normalized-lower for containment.
function pathInScope(p) {
  if (!p) return false;
  const c = _norm(p).toLowerCase();
  return ROOTS.some((r) => _within(c, _norm(r).toLowerCase()));
}
function _host(h) {
  let s = String(h || '').trim().toLowerCase();
  s = s.replace(/^[a-z][\w+.-]*:\/\//, '');   // strip scheme
  s = s.replace(/[\/?#].*$/, '');             // strip path/query/fragment
  const br = s.match(/^\[([^\]]+)\](?::\d+)?$/);   // [ipv6] or [ipv6]:port → the address
  if (br) return br[1];
  // strip a :port only when there is a SINGLE colon (host:port / ipv4:port); a bare ipv6 (::1) keeps its colons
  if ((s.match(/:/g) || []).length === 1) s = s.replace(/:\d+$/, '');
  return s;
}
function hostInScope(h) {
  const s = _host(h);
  if (!s) return false;
  if (HOSTS.includes(s)) return true;
  return DOMAINS.some((d) => s === d || s.endsWith('.' + d));
}
// The one question every tool asks. kind: 'path' | 'host' | 'url' (host and url both resolve by host).
// Returns { ok, kind, target, why? } — deterministic, no side effects.
function check(kind, value) {
  const k = String(kind || '').toLowerCase();
  const inScope = k === 'path' ? pathInScope(value) : hostInScope(value);
  return inScope
    ? { ok: true, kind: k, target: String(value) }
    : { ok: false, kind: k, target: String(value), why: `off-scope: ${k} "${String(value).slice(0, 120)}" is not on the security allowlist` };
}
// The gate a tool calls: check + LOG a refusal (fail-soft) so an off-scope attempt is always visible to
// the monitor. Injected `log` lets the smoke observe the refusal without the bus.
function gate(kind, value, { log = null } = {}) {
  const v = check(kind, value);
  if (!v.ok) {
    try {
      if (typeof log === 'function') log(v);
      else require('./obs_bus').emit({ lane: 'security', kind: 'off-scope-refused', level: 'warn', text: v.why, ref: String(value).slice(0, 160) });
    } catch {}
  }
  return v;
}
// What the monitor and the read door display — the boundary, read-only.
function describe() { return { roots: ROOTS.slice(), hosts: HOSTS.slice(), domains: DOMAINS.slice() }; }

module.exports = { pathInScope, hostInScope, check, gate, describe, ROOTS, HOSTS, DOMAINS };
