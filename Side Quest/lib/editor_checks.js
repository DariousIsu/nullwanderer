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
const { runHarness } = require('../studio/verify_harness');
const { makeHomeworkCheck, makeClassifier } = require('../studio/verify_model_io');

const TERMINAL = new Set(['report_ready', 'accepted', 'revised', 'expired']);

function parseJson(text) { try { return JSON.parse(text); } catch { return null; } }

// Parse a session-status findings field (cite_verify_findings / fact_check_findings), which
// crosses the boundary as a JSON string or an object. Returns the parsed payload (or null).
function parseFindings(statusData, key) {
  let v = statusData ? statusData[key] : null;
  if (typeof v === 'string') v = parseJson(v);
  return (v && typeof v === 'object') ? v : null;
}

// The EVENT-format prompt the Rainey agents expect — mirrors echo/agents/events.py
// _build_event_prompt (topic + JSON payload). The agent's system_prompt reads session_id +
// source_doc_path from this payload and calls rainey_attach_*_findings ITSELF. (A custom prose
// prompt does NOT trigger the attach — the agent just produces a canvas deliverable.) This is the
// only path that lands findings on the session for an external (non-async-loop) caller like Zoe.
function buildEventPrompt(topic, payload) {
  return `Event: ${topic}\nPayload:\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\nRespond to this event according to your purpose.`;
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

  // 3) fire the Rainey verifier + fact-checker with the EVENT-format prompt so each agent's
  //    system_prompt drives it to call rainey_attach_*_findings on THIS session.
  const runIds = {};
  if (delegate) {
    const payload = { session_id: sessionId, source_doc_path: sourceDocPath, source_version: sourceVersion, author_name: author, parent_session_id: null };
    const evt = buildEventPrompt('verification:session_open', payload);
    const cv = normalizeToolResult(await callTool('delegate_to_rainey_citation_verifier', { prompt: evt }));
    runIds.citeVerify = (parseJson(cv.text) || {}).run_id || null;
    if (factCheck) {
      const fc = normalizeToolResult(await callTool('delegate_to_rainey_fact_checker', { prompt: evt }));
      runIds.factCheck = (parseJson(fc.text) || {}).run_id || null;
    }
  }

  // 4) poll until findings are ATTACHED (the agents attach independently; there is no auto-compose
  //    for an external driver, so we wait for the findings themselves, not report_ready). Stop on
  //    both-attached, a terminal status, or timeout.
  const deadline = now() + timeoutMs;
  let statusData = {}, cite = null, fact = null;
  for (;;) {
    const s = normalizeToolResult(await callTool('verification_session_status', { session_id: sessionId }));
    statusData = parseJson(s.text) || {};
    cite = parseFindings(statusData, 'cite_verify_findings');
    fact = parseFindings(statusData, 'fact_check_findings');
    const bothIn = cite && (!factCheck || fact);
    if (!delegate || bothIn || TERMINAL.has(statusData.status)) break;
    if (now() >= deadline) break;
    await sleep(pollIntervalMs);
  }

  // 5) map both findings payloads through the contract → render model
  const mapped = contract.mapCheckResult([cite, fact].filter(Boolean));

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

/**
 * Drive the DETERMINISTIC verification harness (studio/verify_harness) for a working document —
 * the one-pathway "Run checks" of the locked design (replaces the agentic delegate path; that
 * stays available via runChecks as a fallback toggle). Builds the real injections — callTool
 * (Echo web tools), embed/cosine (bge-small), the homework-check + classify leaf (Ollama via the
 * adapters above) — and records the run against the registry.
 *
 *   callTool      (REQUIRED) async (name,args) -> MCP result
 *   workingCopy   (REQUIRED) editor_import normalized copy ({blocks:[...]})
 *   complete      (REQUIRED) ollama.complete (or a mock); the model transport
 *   embed/cosine  bge-small embedder + cosine (lib/memory) — Tier B; omit ⇒ Tier B skipped
 *   localModel    classify primary (local 24B); cheapModel: homework tier (default localModel)
 *   frontierModel + frontierBase/frontierHeaders: optional cloud escalation tier
 * Returns { checkRunId, mapped:{findings,suggestions,summary}, gate, stages }.
 */
async function runHarnessChecks({
  callTool, workingCopy, complete, docId = null, sourceDocPath = null, author = null, sourceVersion = 1,
  localModel = null, cheapModel = null, frontierModel = null, frontierBase = null, frontierHeaders = null,
  embed = null, cosine = null, tier = 'harness', onStage = null,
  // Echo's fetch rung → web_extract (trafilatura clean text + status), not web_fetch (raw-HTML
  // preview). The ladder reads the body from `text_preview` (see verify_resolve.readFetch).
  resolveOpts = { tools: { fetch: 'web_extract' } },
} = {}) {
  if (typeof callTool !== 'function') throw new Error('runHarnessChecks: callTool(name,args) is required');
  if (!workingCopy || !Array.isArray(workingCopy.blocks)) throw new Error('runHarnessChecks: workingCopy with blocks is required');
  if (typeof complete !== 'function') throw new Error('runHarnessChecks: complete(...) transport is required');
  if (!localModel) throw new Error('runHarnessChecks: localModel is required (no hardcoded model)');

  const homeworkCheck = makeHomeworkCheck({ complete, model: cheapModel || localModel });
  const classifyModel = makeClassifier({ complete, model: localModel });
  const classifyFrontier = frontierModel ? makeClassifier({ complete, model: frontierModel, base: frontierBase, headers: frontierHeaders }) : null;

  let checkRunId = null;
  if (docId != null) {
    checkRunId = registry.recordCheckRun(docId, { verificationSessionId: null, tier, model: localModel, status: 'running', version: sourceVersion });
  }

  const result = await runHarness(workingCopy, { callTool, embed, cosine, homeworkCheck, classifyModel, classifyFrontier, resolveOpts, onStage });

  if (checkRunId != null) {
    registry.updateCheckRun(checkRunId, {
      status: result.gate.proceed ? 'checked' : 'gate-aborted',
      findingsCount: result.summary.total, resolvedCount: result.summary.resolved, finished: true,
    });
  }
  return { checkRunId, mapped: { findings: result.findings, suggestions: result.suggestions, summary: result.summary }, gate: result.gate, stages: result.stages };
}

module.exports = { runChecks, runHarnessChecks, buildEventPrompt, parseFindings, TERMINAL };
