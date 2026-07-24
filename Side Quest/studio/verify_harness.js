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

  // A `a<block>.s<sentence>` locator → a sortable position. Unparseable locators sort last.
  // (block * 1e4 leaves room for any realistic sentence count without the two fields colliding.)
  function locatorRank(loc) {
    const m = /^a(\d+)\.s(\d+)$/.exec(String(loc || ''));
    return m ? (parseInt(m[1], 10) * 1e4 + parseInt(m[2], 10)) : Number.MAX_SAFE_INTEGER;
  }

  // decided band → contract status word (gray/weak never reach "decided" — they're residue).
  const BAND_STATUS = { verified: 'verified', unsupported: 'unverified', contradicted: 'contradicted', inaccessible: 'inaccessible', uncited: 'uncited' };

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

    // 3) match — against EVERY source the citation resolved to. A note that cites two sources gets
    //    both scored and the better one wins; matchUnit already accepts a list and picks the best.
    const matched = await matchUnits(units, (u, i) => {
      const r = resolved[i];
      return (r && Array.isArray(r.alternates) && r.alternates.length) ? [r, ...r.alternates] : r;
    }, Object.assign({ embed: opts.embed, cosine: opts.cosine }, opts.matchOpts || {}));
    tick('match', { bands: matched.map(m => m.band) });

    // 4) preflight gate
    const candidates = buildCandidates(units, matched);
    // ⚠️ THE DEEP JUDGE MUST READ THE CITED SOURCE, NOT THE MATCHER'S FAVOURITE SENTENCE.
    // `buildCandidates` carries `passage = rubric.best_passage`, which is ONE sentence the cheap
    // lexical/embedding pass liked most. lib/editor_checks was handing that to verify_deepcheck as
    // `sourceText`, and since it clears MIN_BODY the judge's own "fetch the full document if the
    // snippet is thin" branch never fired — so the module documented as "READS the primary source
    // deeply" was in fact ruling on a single sentence chosen by the thing it exists to second-guess.
    // Live consequence: on a 202,673-char cited PDF the matcher picked a 3rd-grade-retention
    // sentence, the judge saw only that, and reported a correct citation as unsupported — twice,
    // through two other fixes, because the passage never changed. Attach the FULL text of whichever
    // resolved source actually won the match; `passage` stays as the fallback.
    for (let i = 0; i < candidates.length; i++) {
      const r = resolved[i];
      if (!r) continue;
      const all = [r].concat(Array.isArray(r.alternates) ? r.alternates : []);
      const won = all.find(s => s && s.source_url && s.source_url === candidates[i].source_url) || all[0];
      if (won && won.source_text) candidates[i].source_text = won.source_text;
    }
    // The paragraph each claim sits in. A sentence that leans on its paragraph for meaning ("Only 25
    // percent of eighth graders do.") cannot be searched on its own — the fact-check lane uses this
    // to give such a query back the subject the sentence borrowed.
    {
      const blockText = {};
      for (const b of (workingCopy.blocks || [])) if (b && b.anchor) blockText[b.anchor] = String(b.text || '');
      const anchorOf = {};
      for (const u of units) anchorOf[u.uid] = u.anchor;
      for (const c of candidates) { const t = blockText[anchorOf[c.uid]]; if (t) c.context = t.slice(0, 1200); }
    }
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
      // Quote the passage that decided it. "match: verified (score 1)" tells an author nothing they
      // can check — and when the deciding signal was a bare number, nothing they can DISPUTE either.
      const ev = c.passage
        ? `match: ${c.band} (score ${c.match_score}) — cited source says: “${String(c.passage).trim().slice(0, 300)}”`
        : `match: ${c.band} (score ${c.match_score})`;
      // An "inaccessible" that does not say WHAT was tried is an unfalsifiable verdict — the author
      // cannot tell a dead link from a reader we lack. Append the readers that gave up and why.
      const why = (c.band === 'inaccessible' && c.trail && c.trail.length)
        ? ` — tried: ${c.trail.filter(t => t && t.ok === false && t.reason).map(t => `${t.tool || t.step} (${t.reason})`).join(', ')}`
        : '';
      items.push({ id: c.uid, label: c.claim, status: BAND_STATUS[c.band] || 'unverified', locator: c.uid,
        match_score: c.match_score, url: c.source_url, evidence: ev + why,
        // Sources consulted must include what the CHEAP path read, not only what the deep judge read.
        sources_consulted: c.source_url ? [{ url: c.source_url, title: c.source_url }] : [] });
    }
    for (const c of classified) {
      const cand = byUid[c.uid] || {};
      // Say when the source came from a neighbouring sentence's marker rather than this one's.
      const inh = cand.inherited_marker ? ` (checked against ${cand.inherited_marker}, carried from the preceding sentence — this sentence carries no marker of its own)` : '';
      items.push({ id: c.uid, label: cand.claim || c.uid, status_code: c.status_code,
        finding: (c.caveat || c.note) + inh, evidence: (c.evidence_quote || c.note) + inh,
        caveat: c.caveat || '', sources_consulted: c.sources_consulted || [],
        locator: c.uid, url: cand.source_url });
    }
    // Held residue (gate aborted) → surfaced as NOT CHECKED, never silently dropped.
    // ERR, not NK: these claims were never examined, and NK grades as `info`, which gradeFor treats
    // as costless — so an aborted gate could hand back "Cleared for publication" over a batch nothing
    // ever read. ERR grades as warn and withholds that clearance, which is the honest reading of
    // "the gate broke before we got to these".
    const held = gate.heldResidue || [];
    for (const c of held) {
      const note = `not checked — preflight held the batch: ${gate.reason}`;
      items.push({ id: c.uid, label: c.claim, status_code: 'ERR', locator: c.uid, url: c.source_url, finding: note, evidence: note });
    }

    // DOCUMENT ORDER. The three loops above append by STAGE (settled at match → judged → held), and
    // both the rail and the report print "Claims listed in document order" over the result. On the
    // Arizona ESA op-ed that put the opening sentence fifth. Stage of processing is our business, not
    // the author's — they read top to bottom. Sort by the locator's anchor + sentence index (uids are
    // minted `a<block>.s<sentence>` by verify_extract), keeping anything unparseable at the end in
    // its original relative position.
    items.sort((a, b) => locatorRank(a.locator) - locatorRank(b.locator));
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
        context: c.context || null,
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
