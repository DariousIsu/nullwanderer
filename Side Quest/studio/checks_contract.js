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

  // The Rainey verification agents (rainey-citation-verifier / rainey-fact-checker) emit
  // per-claim status CODES, not the word-statuses above. Legend (from the agent TOMLs):
  //   V  verified · VC verified·caveat · VP verified·paraphrase · QO quote·minor-omission ·
  //   QP quote·paraphrase · A attribution-fix · M mismatch · NK not-in-internal-KDB.
  // Cite-verifier also uses prose codes (confirmed/single_source/contradicted/unsupported/
  // broken_url). Map every code to a render verdict + a human label. V (and confirmed)
  // auto-resolve (cite-ready); everything else starts unresolved.
  const STATUS_CODE = {
    V:  { verdict: 'ok',   label: 'Verified',              resolved: true  },
    VC: { verdict: 'warn', label: 'Verified · caveat',     resolved: false },
    VP: { verdict: 'warn', label: 'Verified · paraphrase', resolved: false },
    QO: { verdict: 'warn', label: 'Quote · omission',      resolved: false },
    QP: { verdict: 'warn', label: 'Quote · paraphrase',    resolved: false },
    A:  { verdict: 'warn', label: 'Attribution fix',       resolved: false },
    M:  { verdict: 'bad',  label: 'Mismatch',              resolved: false },
    NK: { verdict: 'info', label: 'Not in KDB',            resolved: false },
    CONFIRMED:     { verdict: 'ok',   label: 'Confirmed',     resolved: true  },
    SINGLE_SOURCE: { verdict: 'warn', label: 'Single source', resolved: false },
    CONTRADICTED:  { verdict: 'bad',  label: 'Contradicted',  resolved: false },
    UNSUPPORTED:   { verdict: 'bad',  label: 'Unsupported',   resolved: false },
    BROKEN_URL:    { verdict: 'info', label: 'Broken URL',    resolved: false },
  };

  // Derive a status from a raw citation_verify match_score when no explicit label is given.
  function statusFromScore(score) {
    const s = Number(score);
    if (!Number.isFinite(s)) return 'inaccessible';
    if (s >= 0.90) return 'verified';
    if (s >= 0.60) return 'partial';
    if (s >= 0.20) return 'unverified';
    return 'unverified';
  }

  // Resolve any item (citation OR claim, code OR word OR score) → {verdict,vlabel,status,resolved}.
  // STRICT MODE (opts.strict): an item with NO recognizable status signal (no enum code, no known
  // status word, no finite match_score) is FLAGGED as a schema violation rather than silently
  // guessed via the score fallback — the deterministic validation gate (feedback-workspace-
  // determinism: reject/flag non-conforming output instead of guessing).
  function classify(c, opts = {}) {
    const code = (c.status_code || c.code || '').toString().trim().toUpperCase().replace(/\s+/g, '_');
    if (STATUS_CODE[code]) { const m = STATUS_CODE[code]; return { verdict: m.verdict, vlabel: m.label, status: code, resolved: m.resolved }; }
    let raw = (c.status || '').toString().trim().toLowerCase().replace(/\s+/g, '');
    if (!STATUS[raw]) {
      if (raw.startsWith('partial')) raw = 'partial';
      else if (raw.startsWith('verif')) raw = 'verified';
      else if (raw.startsWith('contra')) raw = 'contradicted';
      else if (raw.startsWith('inacc')) raw = 'inaccessible';
      else if (raw.startsWith('unver')) raw = 'unverified';
      else if (opts.strict && !Number.isFinite(Number(c.match_score))) {
        return { verdict: 'bad', vlabel: 'Schema violation', status: 'INVALID', resolved: false, invalid: true };
      } else raw = statusFromScore(c.match_score);
    }
    const m = STATUS[raw];
    return { verdict: m.verdict, vlabel: m.label, status: raw, resolved: m.resolvedByDefault };
  }

  // One item (citation OR Rainey claim) → one rail finding.
  function toFinding(c, i, opts) {
    const k = classify(c, opts);
    const hasFix = !!(c.suggested_replacement && c.suggested_replacement.after);
    return {
      id: c.id || `f${i + 1}`,
      label: c.label || c.claim || c.claim_text || c.text || c.quote || `claim ${i + 1}`,
      verdict: k.verdict,
      vlabel: k.vlabel,
      status: k.status,
      ev: c.evidence || c.finding || c.note || '',
      caveat: c.caveat || '',                                   // deep-verify precision caveat (VC/VP/…)
      sources_consulted: Array.isArray(c.sources_consulted) ? c.sources_consulted : [],   // deep-verify provenance
      hasFix,
      resolved: k.resolved,
      auto: k.resolved,
      locator: c.locator || '',
      invalid: !!k.invalid,
    };
  }

  // An item carrying a suggested_replacement → one drawer suggestion (diff segments).
  function toSuggestion(c, i, opts) {
    const sr = c.suggested_replacement;
    if (!sr || !sr.after) return null;
    const k = classify(c, opts);
    const label = c.label || c.claim || c.claim_text || c.text || '';
    return {
      id: c.suggestion_id || `s${i + 1}`,
      finding: c.id || `f${i + 1}`,
      verdict: k.verdict,
      vlabel: k.vlabel,
      loc: c.locator ? `${c.locator}${label ? ` · "${label}"` : ''}` : label,
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

  // Pull the item array out of any boundary shape the agents/tools produce:
  //   bare array · {citations} · {claims} (Rainey verify+fact) · {results}.
  function itemsOf(raw) {
    if (Array.isArray(raw)) return raw;
    if (!raw || typeof raw !== 'object') return [];
    return raw.citations || raw.claims || raw.results || [];
  }

  /**
   * Map Echo's verification_session findings → the studio render model.
   * Accepts a single payload OR an array of payloads (e.g. cite_verify + fact_check merged),
   * tolerating the free-form boundary. Returns { findings, suggestions, summary }.
   */
  function mapCheckResult(raw, opts = {}) {
    const payloads = Array.isArray(raw) && raw.length && typeof raw[0] === 'object' && (raw[0].citations || raw[0].claims || raw[0].results)
      ? raw : [raw];
    const items = payloads.flatMap(itemsOf);
    const findings = items.map((c, i) => toFinding(c, i, opts));
    const suggestions = items.map((c, i) => toSuggestion(c, i, opts)).filter(Boolean);
    const total = findings.length;
    const resolved = findings.filter(f => f.resolved || f.auto).length;
    const invalid = findings.filter(f => f.invalid).length;
    const byStatus = {}, byVerdict = {};
    for (const f of findings) { byStatus[f.status] = (byStatus[f.status] || 0) + 1; byVerdict[f.verdict] = (byVerdict[f.verdict] || 0) + 1; }
    return { findings, suggestions, summary: { total, resolved, invalid, byStatus, byVerdict } };
  }

  return { mapCheckResult, statusFromScore, classify, itemsOf, STATUS, STATUS_CODE };
});
