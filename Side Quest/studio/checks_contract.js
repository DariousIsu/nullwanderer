/*
 * Editor Studio — the findings CONTRACT between Echo's verification spine and
 * the studio's render model (View B rail + suggestions drawer).
 *
 * Echo's `verification_session` findings cross the MCP boundary as a free-form
 * object (rainey_attach_cite_verify_findings takes `findings: object`,
 * additionalProperties:true). That means the SHAPE is convention, not schema —
 * so we pin it here, grounded in the canonical process (citation_verification.toml):
 * per-citation status ∈ {verified, partial, unverified, contradicted, inaccessible}
 * derived from citation_verify match_score (Verified ≥0.90 · Partial 0.60–0.89 ·
 * Unverified 0.20–0.59 · Contradicted · Inaccessible).
 *
 * mapCheckResult() turns that canonical shape into the exact objects the harness
 * renders (FINDINGS[] for the rail, SUGGESTIONS[] for the drawer), so the UI
 * never sees Echo's raw payload and the seam stays one well-tested function.
 *
 * Runs in Node (smoke) and the browser (harness): CommonJS + window fallback.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.EditorChecks = api;
})(this, function () {
  'use strict';

  // status → render verdict (the kit's pill classes) + display label.
  //   verified      → ok    (cite-ready, no action)
  //   partial       → warn  (related text, wording differs)
  //   unverified    → bad   (source accessible, quote not found)
  //   contradicted  → bad   (source says the opposite)
  //   inaccessible  → info  (couldn't reach after fallbacks — operator finds another source)
  const STATUS = {
    verified:     { verdict: 'ok',   label: 'Verified',     resolvedByDefault: true  },
    partial:      { verdict: 'warn', label: 'Partial',      resolvedByDefault: false },
    unverified:   { verdict: 'bad',  label: 'Unverified',   resolvedByDefault: false },
    contradicted: { verdict: 'bad',  label: 'Contradicted', resolvedByDefault: false },
    inaccessible: { verdict: 'info', label: 'Inaccessible', resolvedByDefault: false },
  };

  // Derive a status from a raw citation_verify match_score when the agent didn't
  // label it explicitly. Contradicted/Inaccessible can't come from score alone —
  // those must be set by the agent; score only separates verified/partial/unverified.
  function statusFromScore(score) {
    const s = Number(score);
    if (!Number.isFinite(s)) return 'inaccessible';
    if (s >= 0.90) return 'verified';
    if (s >= 0.60) return 'partial';
    if (s >= 0.20) return 'unverified';
    return 'unverified';
  }

  function normStatus(c) {
    const raw = (c.status || '').toString().trim().toLowerCase().replace(/\s+/g, '');
    if (STATUS[raw]) return raw;
    // tolerate "partiallyverified" etc.
    if (raw.startsWith('partial')) return 'partial';
    if (raw.startsWith('verif')) return 'verified';
    if (raw.startsWith('contra')) return 'contradicted';
    if (raw.startsWith('inacc')) return 'inaccessible';
    if (raw.startsWith('unver')) return 'unverified';
    return statusFromScore(c.match_score);
  }

  // One canonical citation → one rail finding.
  function toFinding(c, i) {
    const st = normStatus(c);
    const meta = STATUS[st];
    const hasFix = !!(c.suggested_replacement && c.suggested_replacement.after);
    return {
      id: c.id || `f${i + 1}`,
      label: c.label || c.claim || c.quote || `citation ${i + 1}`,
      verdict: meta.verdict,
      vlabel: meta.label,
      status: st,
      ev: c.evidence || c.note || '',
      hasFix,
      // verified auto-resolves (cite-ready); everything else starts unresolved.
      resolved: meta.resolvedByDefault,
      auto: st === 'verified',
      locator: c.locator || '',
    };
  }

  // A citation that carries a suggested_replacement → one drawer suggestion,
  // pre-split into the diff segments the drawer renders.
  function toSuggestion(c, i) {
    const sr = c.suggested_replacement;
    if (!sr || !sr.after) return null;
    const st = normStatus(c);
    const meta = STATUS[st];
    return {
      id: c.suggestion_id || `s${i + 1}`,
      finding: c.id || `f${i + 1}`,
      verdict: meta.verdict,
      vlabel: meta.label,
      loc: c.locator ? `${c.locator}${c.label ? ` · "${c.label}"` : ''}` : (c.label || ''),
      before: sr.before_pre || '',
      beforeX: sr.before || c.quote || '',
      beforeRest: sr.before_post || '',
      after: sr.after_pre || '',
      afterO: sr.after || '',
      afterRest: sr.after_post || '',
      src: sr.source || c.url || '',
      state: 'pending',
    };
  }

  /**
   * Map Echo's verification_session findings → the studio render model.
   * Accepts either { citations:[...] } or a bare array of citations, tolerating
   * the free-form boundary. Returns { findings, suggestions, summary }.
   */
  function mapCheckResult(raw) {
    const cites = Array.isArray(raw) ? raw
      : (raw && Array.isArray(raw.citations)) ? raw.citations
      : (raw && Array.isArray(raw.results)) ? raw.results
      : [];
    const findings = cites.map(toFinding);
    const suggestions = cites.map(toSuggestion).filter(Boolean);
    const total = findings.length;
    const resolved = findings.filter(f => f.resolved || f.auto).length;
    const byStatus = {};
    for (const f of findings) byStatus[f.status] = (byStatus[f.status] || 0) + 1;
    return { findings, suggestions, summary: { total, resolved, byStatus } };
  }

  return { mapCheckResult, statusFromScore, STATUS };
});
