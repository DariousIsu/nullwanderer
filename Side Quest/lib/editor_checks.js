/**
 * lib/editor_checks.js — Editor Studio "Run checks" executor (B2 plumbing).
 *
 * Zoe OWNS the verification orchestration (architecture lock): the studio's "Run checks" button
 * drives Echo's verification spine PROGRAMMATICALLY (a studio is buttons, not chat — so this calls
 * Echo tools DIRECTLY via an injectable callTool(name,args), not through Zoe's chat tag layer),
 * then maps the result through the findings CONTRACT (studio/checks_contract.js) into the exact
 * {findings, suggestions, summary} the View B rail + drawer render, and records the run against the
 * registry (lib/editor_registry) check_runs pointer.
 *
 * Echo's flow is AGENTIC + async:
 *   rainey_open_verification_session  → session_id
 *   delegate_to_rainey_citation_verifier / _fact_checker  → background agents (their own cloud
 *     models — THIS is the A4 cloud-creds + A2 verifier-model-param gate; the run is "live" here)
 *   verification_session_status (poll) → terminal (report_ready|accepted|revised|expired)
 *   → map findings → record.
 *
 * PLUMBING vs LIVE: the full orchestration + mapping + registry recording is built + smoke-proven
 * now (mock callTool). The LIVE frontier run needs cloud creds (A4); until then call with
 * delegate:false to drive open → status → map over already-attached findings (the safe path the
 * round-trip used). The selected `model` threads through (stored on the check_run + carried in the
 * delegate prompt); a STRUCTURED model param on the verify tools lands with A2.
 */
'use strict';
const { normalizeToolResult } = require('./echo_suit');
const contract = require('../studio/checks_contract');
const registry = require('./editor_registry');

const TERMINAL = new Set(['report_ready', 'accepted', 'revised', 'expired']);

function parseJson(text) { try { return JSON.parse(text); } catch { return null; } }

// Pull the canonical citation array out of a session-status payload. cite_verify_findings /
// fact_check_findings cross the boundary as JSON strings (or objects) shaped {citations:[...]}.
function extractCitations(statusData) {
  const out = [];
  for (const key of ['cite_verify_findings', 'fact_check_findings']) {
    let v = statusData ? statusData[key] : null;
    if (typeof v === 'string') v = parseJson(v);
    if (v && Array.isArray(v.citations)) out.push(...v.citations);
    else if (Array.isArray(v)) out.push(...v);
  }
  return out;
}

// The verifier task spec handed to the background agent. The canonical pipeline + rubric come
// straight from citation_verification.toml. `model` is a soft directive until A2 adds a structured
// model param to the verify tools.
function buildVerifierPrompt({ sessionId, sourceDocPath, model = null }) {
  return [
    `Run the Rainey citation-verification pipeline for verification session ${sessionId}` +
      (sourceDocPath ? ` on document: ${sourceDocPath}.` : '.'),
    'Pipeline: extract citations → open_access_resolve → citation_verify (direct → Wayback → Google Cache)',
    '→ web_search/browse fallback → attach findings to the session.',
    'Per citation, set status by match_score: Verified ≥0.90 · Partial 0.60–0.89 · Unverified 0.20–0.59;',
    'use Contradicted when the source refutes the claim, Inaccessible when unreachable after fallbacks.',
    'Where wording differs, include suggested_replacement {before, after, source}.',
    model ? `Use the ${model} tier for this verification.` : '',
  ].filter(Boolean).join('\n');
}

/**
 * Run a verification pass for a working document.
 *   callTool(name, args) -> MCP tool result  (REQUIRED; inject echoClient.callTool or a mock)
 *   docId               -> registry pipeline_documents.id (optional; null = don't record)
 * Returns { sessionId, checkRunId, runIds, status, mapped }.
 */
async function runChecks({
  callTool, docId = null, sourceDocPath = null, author = null, sourceVersion = 1,
  model = null, tier = 'cloud', delegate = true, factCheck = true,
  pollIntervalMs = 3000, timeoutMs = 180000,
  now = () => Date.now(), sleep = (ms) => new Promise(r => setTimeout(r, ms)),
} = {}) {
  if (typeof callTool !== 'function') throw new Error('runChecks: callTool(name,args) is required');

  // 1) open the verification session
  const open = normalizeToolResult(await callTool('rainey_open_verification_session', {
    source_doc_path: sourceDocPath, author_name: author, source_version: sourceVersion,
  }));
  if (open.isError) throw new Error(`runChecks: open failed — ${open.text.slice(0, 200)}`);
  const openData = parseJson(open.text) || {};
  const sessionId = openData.session_id || openData.sessionId;
  if (!sessionId) throw new Error(`runChecks: no session_id (got ${open.text.slice(0, 120)})`);

  // 2) record the check-run pointer (authoritative state stays in skuld.verification_session)
  let checkRunId = null;
  if (docId != null) {
    checkRunId = registry.recordCheckRun(docId, {
      verificationSessionId: sessionId, tier, model, status: openData.status || 'open', version: sourceVersion,
    });
  }

  // 3) delegate to the background verifier(s) — LIVE path (gated on cloud creds)
  const runIds = {};
  if (delegate) {
    const prompt = buildVerifierPrompt({ sessionId, sourceDocPath, model });
    const cv = normalizeToolResult(await callTool('delegate_to_rainey_citation_verifier', { prompt }));
    runIds.citeVerify = (parseJson(cv.text) || {}).run_id || null;
    if (factCheck) {
      const fc = normalizeToolResult(await callTool('delegate_to_rainey_fact_checker', { prompt }));
      runIds.factCheck = (parseJson(fc.text) || {}).run_id || null;
    }
  }

  // 4) poll status until terminal (or once, when not delegating — the safe pre-creds path)
  const deadline = now() + timeoutMs;
  let statusData = {};
  for (;;) {
    const s = normalizeToolResult(await callTool('verification_session_status', { session_id: sessionId }));
    statusData = parseJson(s.text) || {};
    if (!delegate || TERMINAL.has(statusData.status)) break;
    if (now() >= deadline) break;
    await sleep(pollIntervalMs);
  }

  // 5) map findings through the contract → render model
  const mapped = contract.mapCheckResult(extractCitations(statusData));

  // 6) update the check-run pointer for index display
  if (checkRunId != null) {
    registry.updateCheckRun(checkRunId, {
      status: statusData.status || 'unknown',
      findingsCount: mapped.summary.total,
      resolvedCount: mapped.summary.resolved,
      reportRef: statusData.report_doc_path || null,
      finished: TERMINAL.has(statusData.status),
    });
  }

  return { sessionId, checkRunId, runIds, status: statusData.status || null, mapped };
}

module.exports = { runChecks, buildVerifierPrompt, extractCitations, TERMINAL };
