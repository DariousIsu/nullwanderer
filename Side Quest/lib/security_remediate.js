'use strict';
/*
 * lib/security_remediate.js — security self-audit, increment 5.3 (2026-09-04): the REMEDIATION FOLD.
 *
 * A finding that only sits recorded is intel, not a fix. This routes each OPEN finding to its remediation
 * lane, exactly as the design (§5.3) draws it:
 *   - a CODE-FIXABLE finding (a source diff inside the pen's jail — a wildcard CORS, a TLS-verify-off, a
 *     0.0.0.0 bind, a renderer-hardening slip) becomes a PEN-WORK thread: she reads the file and proposes
 *     the diff, gated (and now reaching Echo files, stage 5.2). The ask tells her to DISMISS the finding
 *     instead of forcing a change if the use is intended and safe (EVERY-RED-IS-MINE: investigate first).
 *   - an OPERATOR-ACTION finding (rotate a leaked secret, upgrade a vulnerable dependency, untrack a
 *     secret-bearing file, close a port) becomes a capability_need CARD Lucas decides on.
 *
 * BOUNDED BY CONSTRUCTION. 196 dependency advisories must NEVER become 196 cards: operator findings
 * AGGREGATE into ONE card per class (dependency / secret / config / runtime), each with a STABLE born_from
 * so a re-scan folds into the same card instead of piling new ones. Code-fixable configs are few and seed
 * one pen-work thread each. IDEMPOTENT: a routed finding moves open→proposed, so the next pass never
 * re-files it. Nothing here changes a system — a pen proposal and a needs card both end on Lucas's yes/no.
 * Collaborators injected (findings, pen, capabilityNeed) so the smoke drives it offline.
 */

// Config titles whose fix is a SOURCE DIFF the pen can author (not an operator action). A "tracked by
// git" / "secret assignment" finding is a rotate/untrack — operator, not a diff.
const CODE_FIXABLE = /permissive CORS|TLS verification|renderer hardening|renderer sandbox|service on all interfaces|credentials embedded|debug inspector/i;
const ECHO_ASSET = /nx-echo|NX ECHO/i;

function _base(p) { return String(p || '').split(/[\\/]/).pop(); }

/**
 * Route the open findings to their remediation lanes. Returns { pens, cards, routed, byLane }.
 * `deps`: findings, pen, capabilityNeed (defaults to the real libs); nowMs.
 */
function routeOpenFindings({ deps = {}, nowMs = Date.now(), limit = 2000 } = {}) {
  const find = deps.findings || require('./security_findings');
  const pen = deps.pen || require('./code_pen');
  const need = deps.capabilityNeed || require('./capability_need');
  const open = find.list({ status: 'open', limit, deps });

  let pens = 0, cards = 0;
  const dep = [], sec = [], runtime = [], cfg = [];
  const markProposed = (f) => { try { find.setStatus(f.id, 'proposed', { deps, nowMs }); } catch {} };

  for (const f of open) {
    const trackedSecretFile = f.class === 'config' && /tracked by git/i.test(f.title);
    if (f.class === 'config' && CODE_FIXABLE.test(f.title) && !trackedSecretFile) {
      const repoHint = ECHO_ASSET.test(f.asset) ? ' (this is in the Echo repo — propose with repo="echo")' : '';
      try {
        pen.seedPenWork({
          ask: `Security fix: ${f.title} — ${f.evidence}. Proposed fix: ${f.proposed_fix}.${repoHint} Read the file first; if this is an intended, safe use, say so and dismiss the finding rather than changing it.`,
          bornFrom: `security:${f.sig || f.id}`, deps,
        });
        pens++; markProposed(f);
      } catch {}
    } else if (f.class === 'dependency') dep.push(f);
    else if (f.class === 'runtime') runtime.push(f);
    else if (f.class === 'secret' || trackedSecretFile) sec.push(f);
    else cfg.push(f);
  }

  const fileCard = (bucket, text, born) => {
    if (!bucket.length) return;
    try { const r = need.record(text, { bornFrom: born, deps, nowMs }); if (r && r.id) cards++; } catch {}
    for (const f of bucket) markProposed(f);
  };

  if (dep.length) {
    const bySev = dep.reduce((a, f) => { a[f.severity] = (a[f.severity] || 0) + 1; return a; }, {});
    const top = dep.filter((f) => f.severity === 'critical').concat(dep.filter((f) => f.severity === 'high'))
      .slice(0, 3).map((f) => f.title.replace(/^\S+ in /, '')).join(', ');
    fileCard(dep, `Security: ${dep.length} dependency advisories (${bySev.critical || 0} critical, ${bySev.high || 0} high, ${bySev.medium || 0} medium) to UPGRADE. Top: ${top}. Full list: the security findings (class=dependency).`, 'security:dependency');
  }
  fileCard(sec, `Security: ${sec.length} hardcoded/tracked secrets to ROTATE — move the values to env / the OS keychain, untrack the file (git rm --cached), and rotate anything ever committed. Files: ${[...new Set(sec.map((f) => _base(f.asset)))].slice(0, 5).join(', ')}.`, 'security:secret');
  fileCard(runtime, `Security: ${runtime.length} own-host runtime exposure(s) to close/rebind (a LAN-reachable bind or a live debug port). See the security findings (class=runtime).`, 'security:runtime');
  fileCard(cfg, `Security: ${cfg.length} config finding(s) to review. See the security findings (class=config).`, 'security:config');

  return { pens, cards, routed: pens + dep.length + sec.length + runtime.length + cfg.length,
    byLane: { pens, dependency: dep.length, secret: sec.length, runtime: runtime.length, config: cfg.length } };
}

module.exports = { routeOpenFindings, CODE_FIXABLE };
