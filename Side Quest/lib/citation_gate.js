'use strict';
/*
 * lib/citation_gate.js — THE CITATION GATE (stage 4.5, 2026-09-04; merge map §"The adversarial step,
 * from Alpha", part 2: "The citation gate becomes a swarm step between collector agents and the
 * writer, with the three-attempt re-run and the pass-with-caveats exit, reading held sources first.").
 *
 * Ported from NX-ALPHA's citation gate (Desktop repo history, app/graph — CitationGateResult
 * {verdict, corrections, caveats, citation_count, failed_count}). It sits between the material and the
 * assembled deliverable: every inline citation [n] must be SUPPORTED by source [n]. Three attempts;
 * a failed check returns corrections to the producer for a re-run; a THIRD failure passes with
 * caveats rather than blocking. Source content is read from the HELD material first, the web second.
 *
 * PURE: extractCitations / parseCheck / decide / corrections take strings and return objects; runGate
 * takes produce(corrections) and check(citations, {resolve}) injected, so the loop is offline-testable.
 * The live check dispatches the citation-verifier role reading held sources first (main.js / the
 * document road). This is the sibling of lib/challenge_gate: the citation gate checks the CLAIMS
 * against their sources BEFORE the challenger reviews the assembled whole.
 */

const MAX_ATTEMPTS = 3;   // Alpha's cap: a third failed check PASSES WITH CAVEATS, never blocks.

// Pull the inline [n] citations out of a document + its numbered source list. Returns one entry per
// DISTINCT (sentence, index) — the claim the citation backs and the source it points at.
function extractCitations(text, sources = []) {
  const s = String(text || '');
  const byN = new Map((sources || []).map((x) => [Number(x.n), x]));
  const out = [];
  const seen = new Set();
  // split into sentences; a sentence carrying one or more [n] is a cited claim
  for (const sent of s.split(/(?<=[.!?])\s+|\n+/)) {
    const nums = (sent.match(/\[(\d{1,3})\]/g) || []).map((m) => parseInt(m.slice(1, -1), 10));
    if (!nums.length) continue;
    const claim = sent.replace(/\s+/g, ' ').trim();
    if (claim.length < 8) continue;
    for (const n of new Set(nums)) {
      const key = `${n}::${claim.slice(0, 80)}`;
      if (seen.has(key)) continue; seen.add(key);
      out.push({ index: n, claim, source: byN.get(n) || null });
    }
  }
  return out;
}

// A citation whose [n] has no matching source in the list is dangling — a hard fail the gate always
// catches deterministically, before any model check.
function danglingCitations(citations) { return (citations || []).filter((c) => !c.source); }

/**
 * parseCheck(text) → CitationGateResult {verdict, corrections, caveats, citation_count, failed_count}
 * The verifier's reply on Alpha's schema. Tolerant of prose+fences; an unparseable reply PASSES
 * (a broken verifier never blocks a deliverable — the same auto-pass principle as the challenger).
 */
function parseCheck(text) {
  const s = String(text || '');
  let obj = null;
  const cands = s.match(/\{[\s\S]*?\}/g) || [];
  for (const c of cands) { if (/verdict/i.test(c)) { try { obj = JSON.parse(c); break; } catch {} } }
  if (!obj) { const m = s.match(/\{[\s\S]*\}/); if (m) { try { obj = JSON.parse(m[0]); } catch {} } }
  if (!obj || typeof obj !== 'object') return { verdict: 'pass', corrections: null, caveats: [], citation_count: null, failed_count: 0, parsed: false, why: 'verifier reply unparseable — auto-pass' };
  const v = String(obj.verdict || '').toLowerCase();
  const verdict = /pass_with|caveat/.test(v) ? 'pass_with_caveats' : (/fail|reject/.test(v) ? 'fail' : 'pass');
  const corrections = (obj.corrections && typeof obj.corrections === 'object') ? obj.corrections : null;
  const caveats = Array.isArray(obj.caveats) ? obj.caveats.map(String) : (obj.caveats ? [String(obj.caveats)] : []);
  const citation_count = Number.isFinite(Number(obj.citation_count)) ? Number(obj.citation_count) : null;
  const failed_count = Number.isFinite(Number(obj.failed_count)) ? Number(obj.failed_count) : (corrections ? Object.keys(corrections).length : 0);
  return { verdict, corrections, caveats, citation_count, failed_count, parsed: true };
}

/** decide({ verdict, attempt, maxAttempts, checkerAvailable }) → { action, why }
 *    action: 'pass' | 'recheck' | 'pass_with_caveats' */
function decide({ verdict, attempt = 1, maxAttempts = MAX_ATTEMPTS, checkerAvailable = true } = {}) {
  if (!checkerAvailable) return { action: 'pass', why: 'no citation verifier available — auto-pass' };
  if (verdict === 'pass') return { action: 'pass', why: 'all cited claims supported' };
  if (verdict === 'pass_with_caveats') return { action: 'pass_with_caveats', why: 'passed with caveats (the verifier flagged soft issues)' };
  if (attempt >= maxAttempts) return { action: 'pass_with_caveats', why: `citations still failing after ${maxAttempts} attempts — passing with caveats` };
  return { action: 'recheck', why: `citations failed (attempt ${attempt}/${maxAttempts}) — correcting and re-running` };
}

// The correction block the producer folds into its re-run: which citations failed and how to fix them.
function corrections(result, dangling = []) {
  const lines = [];
  for (const c of dangling) lines.push(`- citation [${c.index}] points at no source in the list — cite a real source or cut the claim: "${String(c.claim).slice(0, 120)}"`);
  const corr = (result && result.corrections) || null;
  if (corr) for (const [idx, fix] of Object.entries(corr)) {
    const issue = (fix && (fix.issue || fix.problem)) || 'unsupported by its source';
    const sug = (fix && (fix.suggested_fix || fix.fix)) || 'cite the right source or cut the claim';
    lines.push(`- citation [${idx}]: ${issue} → ${sug}`);
  }
  if (!lines.length) return '';
  return `The citation check found claims not supported by their sources — fix each before finalizing:\n${lines.join('\n')}`;
}

/**
 * runGate({ produce, check, sources, maxAttempts, checkerAvailable }) → the loop.
 *   produce(correctionText|null) → { output, sources? }  (the assembled/section text with inline [n])
 *   check(citations, { attempt }) → verifier reply text (the CitationGateResult JSON), or null
 * Dangling citations are caught deterministically and always drive a re-run (or caveats at the cap),
 * even before the model check. Returns { outcome, output, produced, result, attempts, caveats, history }.
 *   outcome: 'passed' | 'passed_with_caveats' | 'no_checker'
 */
async function runGate({ produce, check, sources = null, maxAttempts = MAX_ATTEMPTS, checkerAvailable = true } = {}) {
  if (typeof produce !== 'function') throw new Error('runGate needs produce()');
  const history = [];
  let correctionText = null, produced = null, lastResult = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    produced = await produce(correctionText);
    const output = (produced && (produced.output != null ? produced.output : produced)) || '';
    const srcs = sources || (produced && produced.sources) || [];
    const citations = extractCitations(output, srcs);
    const dangling = danglingCitations(citations);
    const avail = checkerAvailable && typeof check === 'function';
    if (!avail && !dangling.length) { history.push({ attempt, action: 'pass', why: 'no checker, no dangling citations' }); return { outcome: 'no_checker', output, produced, result: null, attempts: attempt, caveats: [], history }; }
    let result = { verdict: 'pass', corrections: null, caveats: [], citation_count: citations.length, failed_count: 0, parsed: false };
    if (avail) {
      let replyText = null;
      try { replyText = await check(citations, { attempt }); } catch { replyText = null; }
      if (replyText == null && !dangling.length) { history.push({ attempt, action: 'pass', why: 'checker did not answer — auto-pass' }); return { outcome: 'no_checker', output, produced, result: null, attempts: attempt, caveats: [], history }; }
      if (replyText != null) result = parseCheck(replyText);
    }
    lastResult = result;
    // dangling citations force a fail regardless of what the checker said (deterministic hard rule)
    const verdict = dangling.length ? 'fail' : result.verdict;
    const d = decide({ verdict, attempt, maxAttempts, checkerAvailable: true });
    history.push({ attempt, action: d.action, why: d.why, failed: (result.failed_count || 0) + dangling.length, dangling: dangling.length });
    if (d.action === 'pass') return { outcome: 'passed', output, produced, result, attempts: attempt, caveats: result.caveats || [], history };
    if (d.action === 'pass_with_caveats') return { outcome: 'passed_with_caveats', output, produced, result, attempts: attempt, caveats: [...(result.caveats || []), ...dangling.map((c) => `citation [${c.index}] unresolved`)], history };
    correctionText = corrections(result, dangling);
  }
  const output = (produced && (produced.output != null ? produced.output : produced)) || '';
  return { outcome: 'passed_with_caveats', output, produced, result: lastResult, attempts: maxAttempts, caveats: (lastResult && lastResult.caveats) || [], history };
}

// Build the verifier's prompt: the cited claims + the HELD source text for each (read first), so the
// check reads held sources before the web. `sourceText(n)` resolves source [n]'s held content or null.
function buildCheckPrompt(citations, sourceText) {
  const byN = new Map();
  for (const c of citations) { if (!byN.has(c.index)) byN.set(c.index, []); byN.get(c.index).push(c.claim); }
  const blocks = [];
  for (const [n, claims] of byN) {
    const held = (typeof sourceText === 'function' ? sourceText(n) : null) || '(source text not held — verify against the source list entry / the web)';
    blocks.push(`SOURCE [${n}] (held content, read this FIRST):\n${String(held).slice(0, 4000)}\n\nCLAIMS citing [${n}]:\n${claims.map((c, i) => `${i + 1}. ${c}`).join('\n')}`);
  }
  return 'You are an adversarial citation verifier. For EACH cited claim, decide whether the source actually supports it. '
    + 'Read the held source content first; only if it is absent do you consult the source list entry or the web.\n\n'
    + blocks.join('\n\n---\n\n')
    + '\n\nRespond ONLY with valid JSON (no markdown):\n'
    + '{"verdict": "pass" | "fail" | "pass_with_caveats", "citation_count": <n>, "failed_count": <n>, '
    + '"corrections": {"<citation index>": {"issue": "<what is unsupported>", "suggested_fix": "<cite the right source or cut>"}}, "caveats": ["<soft issue>"]}';
}

module.exports = { MAX_ATTEMPTS, extractCitations, danglingCitations, parseCheck, decide, corrections, runGate, buildCheckPrompt };
