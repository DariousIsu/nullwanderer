/*
 * lib/review_fanout.js — O5 review fan-out, the PURE half (M2.5.4). A WIDE self-review ("review
 * your whole program", "audit all of lib") exceeds one context — the reason it was impossible for
 * her in one sitting — so the file list is SHARDED across Echo code-reviewer delegates (each reads
 * its files itself via fs_read_file; NX_ECHO_FS_ROOTS scopes what it may see) and the parent
 * COMPILES their returns. O5's load-bearing contract: isolation in, conclusions out.
 *
 * Pure: scope detection, deterministic shard math, the delegate task spec, run-id/state parsing,
 * and the compile prompt. Spawn / poll / deliver I/O lives in main.js (_reviewFanoutTick).
 */
'use strict';

// A WIDE review names whole-tree scope. "review your reply pipeline" (the M2.5.4 milestone ask)
// is NARROW — it must keep the single-context direct path, so breadth needs an explicit marker:
// a breadth word near a code-scope word, or the inherently-wide "codebase"/"lib/".
const WIDE_RE = /\b(?:whole|entire|all(?:\s+of)?|full|every)\b[\s\S]{0,40}\b(?:program|code\s?base|code|lib\b|source|files)|\bcode\s?base\b|\ball\s+your\s+libs?\b|\blib\/(?:\s|$)/i;
function isWideReview(text) { return WIDE_RE.test(String(text || '')); }

// Balanced greedy shard: biggest file first onto the currently-lightest shard, so three delegates
// finish in roughly the same wall-clock instead of one carrying main-sized files alone.
// Deterministic (stable sort by bytes desc, then path) — the same tree always shards the same way.
function shardFiles(files, shards = 3) {
  const n = Math.max(1, shards | 0);
  const fs = (Array.isArray(files) ? files : [])
    .filter((f) => f && f.path)
    .map((f) => ({ path: String(f.path), bytes: Number(f.bytes) || 0 }))
    .sort((a, b) => (b.bytes - a.bytes) || (a.path < b.path ? -1 : 1));
  const out = Array.from({ length: n }, () => ({ files: [], bytes: 0 }));
  for (const f of fs) {
    const lightest = out.reduce((a, b) => (b.bytes < a.bytes ? b : a));
    lightest.files.push(f);
    lightest.bytes += f.bytes;
  }
  return out.filter((s) => s.files.length).map((s) => s.files);
}

// The task spec a code-reviewer delegate receives verbatim. Paths are ABSOLUTE — the delegate's
// fs_read_file resolves against NX_ECHO_FS_ROOTS, not against any working directory.
function buildShardTask({ goal = '', files = [], index = 0, total = 1 } = {}) {
  const list = (Array.isArray(files) ? files : []).map((f) => `- ${f.path}`).join('\n');
  return `SHARD ${index + 1}/${total} of Zoe's self-review.\n\nREVIEW GOAL: ${String(goal).slice(0, 500)}\n\nYOUR ASSIGNED FILES (fs_read_file each one IN FULL — raise max_bytes if truncated; report any you could not read as UNREAD, never silently skip):\n${list}\n\nFollow your output shape exactly: SHARD / FILES READ / FINDINGS (each cited file:line) / SHARD SUMMARY. Label this shard "shard-${index + 1}".`;
}

// spawn_agent_async returns {run_id, state:"queued", ...} — as dispatch text it arrives JSON-ish.
function parseRunId(text) {
  const m = String(text || '').match(/["']?run_id["']?\s*[:=]\s*["']([\w.-]+)["']/);
  return m ? m[1] : null;
}

// agent_status text → the run's state word (queued/running/succeeded/failed/cancelled).
function parseRunState(text) {
  const m = String(text || '').match(/["']?state["']?\s*[:=]\s*["']([a-z_]+)["']/i);
  return m ? m[1].toLowerCase() : null;
}
function isTerminal(state) { return ['succeeded', 'failed', 'cancelled'].includes(String(state || '').toLowerCase()); }

// get_agent_output rows carry {output: "..."} — pull the longest output string in the result.
function parseRunOutput(text) {
  const s = String(text || '');
  let best = '';
  for (const m of s.matchAll(/"output"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
    let candidate = '';
    try { candidate = JSON.parse(`"${m[1]}"`); } catch { candidate = m[1]; }
    if (candidate.length > best.length) best = candidate;
  }
  return best;
}

// The parent's compile contract: shard reports in, ONE review out. Findings survive verbatim with
// their file:line citations — the compiler organizes and judges, it never invents or re-derives.
function buildCompilePrompt({ goal = '', reports = [] } = {}) {
  const body = (Array.isArray(reports) ? reports : [])
    .map((r, i) => `--- SHARD ${i + 1} (${r.label || 'unlabelled'}${r.state && r.state !== 'succeeded' ? `, ${r.state}` : ''}) ---\n${String(r.output || '(no output)').slice(0, 12000)}`)
    .join('\n\n');
  return [
    { role: 'system', content: `You are compiling a code review from per-shard delegate reports into ONE professional review document. Rules — these are absolute:\n• Ground ONLY in the shard reports — never invent a finding, a file, or a line number; every finding keeps its file:line citation from the report it came from.\n• Organize by severity (high → med → low), dedupe cross-shard repeats (keep the richest version), and keep each shard's UNREAD files and failures visible in a coverage note — never paper over a shard that failed or files that went unread.\n• Open with a 3-4 sentence overall assessment grounded in the shard summaries.\n• Close with "## Coverage" stating files read per shard and anything unread or failed.\nOutput Markdown only — no preamble.` },
    { role: 'user', content: `REVIEW GOAL: ${String(goal).slice(0, 500)}\n\nTHE SHARD REPORTS:\n${body}\n\nCompile the single review now.` }
  ];
}

module.exports = { isWideReview, shardFiles, buildShardTask, parseRunId, parseRunState, isTerminal, parseRunOutput, buildCompilePrompt, WIDE_RE };
