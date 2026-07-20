/*
 * Editor Studio — verification harness ORCHESTRATOR (verify_harness): THE ONE PATHWAY.
 *
 * The studio's "Run checks" button drives exactly this, in this fixed order, every time:
 *   extract → resolve → match → preflight → classify → contract  (EDITOR_TAB_SPEC, FROZEN).
 * One deterministic control flow; one standardized output ({findings, suggestions, summary}); the
 * model caged at one leaf behind the preflight gate. No branching model-driven orchestration.
 *
 * Everything that touches the outside world is INJECTED — callTool (Echo web tools), embed/cosine
 * (bge-small), homeworkCheck (cheap-tier gate), classifyModel/classifyFrontier (the leaf). This
 * module itself does ZERO I/O, so it runs identically offline (stubs) and live (real adapters);
 * lib/editor_checks builds the real adapters, the smoke builds stubs.
 *
 * Runs in Node (offline smoke) and the browser: CommonJS + window fallback.
 */
(function (root, factory) {
  const req = (typeof require !== 'undefined') ? require : null;
  const mods = req ? {
    extract: req('./verify_extract'), resolve: req('./verify_resolve'), match: req('./verify_match'),
    preflight: req('./verify_preflight'), classify: req('./verify_classify'), contract: req('./checks_contract'),
  } : {
    extract: root.VerifyExtract, resolve: root.VerifyResolve, match: root.VerifyMatch,
    preflight: root.VerifyPreflight, classify: root.VerifyClassify, contract: root.EditorChecks,
  };
  const api = factory(mods);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.VerifyHarness = api;
})(this, function (M) {
  'use strict';
  const { extractUnits } = M.extract;
  const { resolveUnits } = M.resolve;
  const { matchUnits } = M.match;
  const { buildCandidates, preflight } = M.preflight;
  const { classifyAll } = M.classify;
  const contract = M.contract;

  // decided band → contract status word (gray/weak never reach "decided" — they're residue).
  const BAND_STATUS = { verified: 'verified', unsupported: 'unverified', contradicted: 'contradicted', inaccessible: 'inaccessible' };

  /**
   * Run the full deterministic verification pass over a working copy.
   * @param {object} workingCopy  editor_import shape ({ blocks: [...] })
   * @param {object} opts
   *   callTool         async (name,args) -> MCP result        (REQUIRED for resolve)
   *   embed, cosine    bge-small embedder + cosine            (Tier B; absent ⇒ skipped)
   *   homeworkCheck    async (samples, prompt) -> [{uid,ok}]  (preflight gate; absent ⇒ ungated)
   *   classifyModel    async ({claim,passage}) -> {status_code,note,confidence?}   (local leaf)
   *   classifyFrontier async ({claim,passage}) -> {...}        (cloud escalation; optional)
   *   extractOpts, resolveOpts, matchOpts, preflightOpts, classifyOpts  (per-stage overrides)
   *   onStage(name, payload)  optional progress callback
   * @returns {Promise<{findings, suggestions, summary, gate, stages}>}
   */
  async function runHarness(workingCopy, opts = {}) {
    const tick = (name, payload) => { try { opts.onStage && opts.onStage(name, payload); } catch {} };
    if (typeof opts.callTool !== 'function') throw new Error('runHarness: callTool(name,args) is required');

    // 1) extract
    const units = extractUnits(workingCopy, opts.extractOpts || {}).units;
    tick('extract', { units: units.length });

    // 2) resolve
    const resolved = await resolveUnits(units, opts.callTool, opts.resolveOpts || {});
    tick('resolve', { resolved: resolved.filter(r => r.resolved).length, total: resolved.length });

    // 3) match
    const matched = await matchUnits(units, (u, i) => resolved[i],
      Object.assign({ embed: opts.embed, cosine: opts.cosine }, opts.matchOpts || {}));
    tick('match', { bands: matched.map(m => m.band) });

    // 4) preflight gate
    const candidates = buildCandidates(units, matched);
    const gate = await preflight(candidates, Object.assign({ homeworkCheck: opts.homeworkCheck }, opts.preflightOpts || {}));
    tick('preflight', { proceed: gate.proceed, reason: gate.reason, decided: gate.decided.length, residue: gate.residue.length });

    // 5) judge the RELEASED residue (held residue is surfaced, not judged). DEEP path when injected:
    //    opts.deepVerify(residue) -> [{uid,status_code,caveat,evidence_quote,sources_consulted,...}]
    //    (studio/verify_deepcheck — reads primary sources, cross-checks, precision-aware). Else the
    //    single caged classify leaf. Same status enum either way, so the contract is unchanged.
    const classified = gate.proceed
      ? (typeof opts.deepVerify === 'function'
          ? await opts.deepVerify(gate.residue)
          : await classifyAll(gate.residue, Object.assign({ model: opts.classifyModel, frontier: opts.classifyFrontier }, opts.classifyOpts || {})))
      : [];
    tick('classify', { classified: classified.length, deep: typeof opts.deepVerify === 'function', gated: gate.sample && gate.sample.gated });

    // 6) assemble standardized contract items (decided bands + classified residue + held residue)
    const byUid = Object.fromEntries(candidates.map(c => [c.uid, c]));
    const items = [];
    for (const c of gate.decided) {
      items.push({ id: c.uid, label: c.claim, status: BAND_STATUS[c.band] || 'unverified', locator: c.uid, match_score: c.match_score, url: c.source_url, evidence: `match: ${c.band} (score ${c.match_score})` });
    }
    for (const c of classified) {
      const cand = byUid[c.uid] || {};
      items.push({ id: c.uid, label: cand.claim || c.uid, status_code: c.status_code,
        finding: c.caveat || c.note, evidence: c.evidence_quote || c.note,
        caveat: c.caveat || '', sources_consulted: c.sources_consulted || [],
        locator: c.uid, url: cand.source_url });
    }
    // held residue (gate aborted) → surfaced as not-checked (NK/info), never silently dropped
    const held = gate.heldResidue || [];
    for (const c of held) {
      items.push({ id: c.uid, label: c.claim, status_code: 'NK', locator: c.uid, url: c.source_url, finding: `not checked — preflight held batch: ${gate.reason}`, evidence: `not checked — preflight held batch: ${gate.reason}` });
    }

    const rendered = contract.mapCheckResult({ claims: items }, { strict: true });

    // 7) FACT CHECK — the second lane. Everything above answered ONE question: is the claim correctly
    //    sourced to the source the document CITED? This asks a different one: what does the rest of
    //    the record say? It searches for INDEPENDENT sources and reports corroboration and
    //    counter-evidence for the author to weigh. Advisory by construction — it never rules on the
    //    author's sourcing and never contributes to a hold, so it runs after the citation verdicts
    //    are already fixed and cannot influence them.
    let factcheck = { items: [], summary: { checked: 0, corroborated: 0, contested: 0, mixed: 0, none: 0, ran: false } };
    if (typeof opts.factCheck === 'function' && candidates.length) {
      const fcItems = await opts.factCheck(candidates.map(c => ({
        uid: c.uid, claim: c.claim, text: c.claim, kind: c.kind || null, sourceUrl: c.source_url || null,
      })));
      const list = Array.isArray(fcItems) ? fcItems.filter(Boolean) : [];
      factcheck = {
        items: list,
        summary: {
          checked: list.length,
          corroborated: list.filter(f => f.stance === 'corroborated').length,
          contested: list.filter(f => f.stance === 'contested').length,
          mixed: list.filter(f => f.stance === 'mixed').length,
          none: list.filter(f => f.stance === 'no-independent-source').length,
          countering: list.reduce((n, f) => n + ((f.countering || []).length), 0),
          ran: true,
        },
      };
    }
    tick('factcheck', factcheck.summary);

    return Object.assign({}, rendered, {
      // `findings/suggestions/summary` stay the CITATION lane's, so the grade and every existing
      // consumer keep meaning exactly what they meant. Fact check rides alongside, never inside.
      citation: { findings: rendered.findings, suggestions: rendered.suggestions, summary: rendered.summary },
      factcheck,
      gate: { proceed: gate.proceed, reason: gate.reason, sample: gate.sample, layer0: gate.layer0 },
      stages: { units: units.length, resolved, matched, classified, candidates },
    });
  }

  return { runHarness, BAND_STATUS };
});
