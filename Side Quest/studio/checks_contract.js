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
  // ⭐ TWO AXES, NOT ONE (2026-07-23, Lucas: "just because something has a caveat doesn't mean it
  // shouldn't be verified"). `verdict` answers DOES THE AUTHOR NEED TO ACT; `supported` answers DID
  // THE CITED SOURCE BEAR OUT THE CLAIM. They are independent, and collapsing them into `verdict`
  // alone forced "verified with a caveat" to pick a side — it picked `warn`, so the Verified count
  // excluded it. On the live Arizona op-ed that printed **"0 verified"** over a document where five
  // claims had been verified against their sources, each with a note about wording. The audit's
  // headline number said the opposite of what the audit found.
  //   supported: true  — the cited source bears the claim out (a caveat does not undo that)
  //              false — it does not (contradicted, unsupported, or attributed to the wrong body)
  //              null  — we never established it either way (unreachable, uncited, no verdict)
  const STATUS = {
    verified:     { verdict: 'ok',   label: 'Verified',     resolvedByDefault: true,  supported: true  },
    partial:      { verdict: 'warn', label: 'Partial',      resolvedByDefault: false, supported: true  },
    unverified:   { verdict: 'bad',  label: 'Unverified',   resolvedByDefault: false, supported: false },
    contradicted: { verdict: 'bad',  label: 'Contradicted', resolvedByDefault: false, supported: false },
    inaccessible: { verdict: 'info', label: 'Inaccessible', resolvedByDefault: false, supported: null  },
    // The claim carries no citation at all. `warn`, not `info`: an unsourced factual assertion in a
    // document under pre-publication review is something the author must decide about, whereas
    // `inaccessible` is a failure on OUR side of the exchange. Distinct label so the report stops
    // saying it could not reach a source that was never named.
    uncited:      { verdict: 'warn', label: 'No citation given', resolvedByDefault: false, supported: null },
  };

  // The Rainey verification agents (rainey-citation-verifier / rainey-fact-checker) emit
  // per-claim status CODES, not the word-statuses above. Legend (from the agent TOMLs):
  //   V  verified · VC verified·caveat · VP verified·paraphrase · QO quote·minor-omission ·
  //   QP quote·paraphrase · A attribution-fix · M mismatch · NS not-supported-by-cited-source ·
  //   NK not-in-internal-KDB · ERR no usable verdict.
  // Cite-verifier also uses prose codes (confirmed/single_source/contradicted/unsupported/
  // broken_url). Map every code to a render verdict + a human label. V (and confirmed)
  // auto-resolve (cite-ready); everything else starts unresolved.
  //
  // ⚠️ NS vs NK vs ERR is a GRADING boundary, not a wording preference (2026-07-23). The deep
  // verifier's rubric had redefined NK as "not supported / not found in the sources" while this table
  // still carried the Rainey agents' meaning — "I have no record in the internal KDB" — which is
  // legitimately `info` because it says nothing about the claim. The result: on a live op-ed the judge
  // correctly found that a cited NAEP page did not state the proficiency rate attributed to it, and
  // that a cited case study never mentioned the story it was cited for, and BOTH rendered as benign
  // info. gradeFor counts only bad+warn, so the document graded "Cleared for publication — no
  // outstanding issues". A finding that the cited source does not support the claim is the core defect
  // this studio exists to catch; it is `bad`.
  // `supported` per the two-axis note above. V/VC/VP/QO/QP all mean THE SOURCE BORE THE CLAIM OUT —
  // the code records what still needs fixing (a missing qualifier, a paraphrase inside quotation
  // marks), not a failure of sourcing. A is `false` on purpose: "the EPA concluded X" when it was the
  // GAO is not a verified claim, however real the underlying finding.
  const STATUS_CODE = {
    V:  { verdict: 'ok',   label: 'Verified',              resolved: true,  supported: true  },
    VC: { verdict: 'warn', label: 'Verified · caveat',     resolved: false, supported: true  },
    VP: { verdict: 'warn', label: 'Verified · paraphrase', resolved: false, supported: true  },
    QO: { verdict: 'warn', label: 'Quote · omission',      resolved: false, supported: true  },
    QP: { verdict: 'warn', label: 'Quote · paraphrase',    resolved: false, supported: true  },
    A:  { verdict: 'warn', label: 'Attribution fix',       resolved: false, supported: false },
    M:  { verdict: 'bad',  label: 'Mismatch',              resolved: false, supported: false },
    NS: { verdict: 'bad',  label: 'Not supported by cited source', resolved: false, supported: false },
    // No record in the INTERNAL knowledge base — an absence of local knowledge, not a finding about
    // the claim. Only the Rainey agent lane emits this; the deep verifier now emits NS instead.
    NK: { verdict: 'info', label: 'No internal record',    resolved: false, supported: null  },
    // We never obtained a usable verdict (unparseable or truncated model output). This is a hole in
    // the audit, not a clean bill of health — it must visibly withhold clearance rather than pass as
    // benign info, which is what a silent `code || 'NK'` fallback used to do.
    ERR: { verdict: 'warn', label: 'Not checked — judge error', resolved: false, supported: null  },
    CONFIRMED:     { verdict: 'ok',   label: 'Confirmed',     resolved: true,  supported: true  },
    SINGLE_SOURCE: { verdict: 'warn', label: 'Single source', resolved: false, supported: true  },
    CONTRADICTED:  { verdict: 'bad',  label: 'Contradicted',  resolved: false, supported: false },
    UNSUPPORTED:   { verdict: 'bad',  label: 'Unsupported',   resolved: false, supported: false },
    BROKEN_URL:    { verdict: 'info', label: 'Broken URL',    resolved: false, supported: null  },
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
    if (STATUS_CODE[code]) { const m = STATUS_CODE[code]; return { verdict: m.verdict, vlabel: m.label, status: code, resolved: m.resolved, supported: m.supported != null ? m.supported : null }; }
    let raw = (c.status || '').toString().trim().toLowerCase().replace(/\s+/g, '');
    if (!STATUS[raw]) {
      if (raw.startsWith('partial')) raw = 'partial';
      else if (raw.startsWith('verif')) raw = 'verified';
      else if (raw.startsWith('contra')) raw = 'contradicted';
      else if (raw.startsWith('inacc')) raw = 'inaccessible';
      else if (raw.startsWith('unver')) raw = 'unverified';
      else if (opts.strict && !Number.isFinite(Number(c.match_score))) {
        return { verdict: 'bad', vlabel: 'Schema violation', status: 'INVALID', resolved: false, invalid: true, supported: null };
      } else raw = statusFromScore(c.match_score);
    }
    const m = STATUS[raw];
    return { verdict: m.verdict, vlabel: m.label, status: raw, resolved: m.resolvedByDefault, supported: m.supported != null ? m.supported : null };
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
      // DID THE SOURCE BEAR IT OUT — independent of whether the author still has something to fix.
      supported: k.supported,
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
    // The SUPPORT axis, counted separately from the action axis. `verified` includes the claims whose
    // source bore them out but that still carry a caveat — reporting those only as "caveat" printed
    // "0 verified" over a document with five verified claims. `verifiedClean` is the subset needing
    // no revision, so the pair can be shown as "6 verified (4 with caveats)" without double-counting.
    const verified = findings.filter(f => f.supported === true).length;
    const verifiedClean = findings.filter(f => f.supported === true && f.verdict === 'ok').length;
    const notSupported = findings.filter(f => f.supported === false).length;
    const unchecked = findings.filter(f => f.supported == null).length;
    return { findings, suggestions,
      summary: { total, resolved, invalid, byStatus, byVerdict, verified, verifiedClean, notSupported, unchecked } };
  }

  return { mapCheckResult, statusFromScore, classify, itemsOf, STATUS, STATUS_CODE };
});
