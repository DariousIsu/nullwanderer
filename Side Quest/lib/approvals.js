/**
 * lib/approvals.js — O4 ONE APPROVAL SURFACE: the read-model over every propose-shaped store.
 *
 * Propose→approve flows exist per-domain with different stores and gates (that is correct — their
 * semantics differ for reasons), but "what's waiting on me?" had no one answer: KG/dedup proposals
 * live in Echo, belief revisions in puller.db, capability gaps in sq.db, a green rehearsal card in
 * its run meta. This is the board pattern applied to approvals: READ ONLY — counts + the top item
 * per queue, no new store, no new writes (the driver caches a snapshot in meta, that's all).
 * Approve VERBS stay domain-specific; this only makes the waiting work legible.
 */
'use strict';

const CAP = 50;   // per-queue count cap — an exact small number beats a wrong big one; at the cap we say "50+"

// ---- sources (each fail-soft: a broken store yields null, never a throw) ------------------------

function _pullerSection() {
  try {
    const pdb = require('./puller_db');
    const rows = pdb.listRevisions({ status: 'pending' }) || [];
    if (!rows.length) return null;
    const t = rows[0] || {};
    return { key: 'puller-revisions', label: 'Puller belief revisions (propose→approve)', count: rows.length,
      top: `${t.subject_ref || t.subject_kind || '?'}: ${t.attr || '?'} ${t.from_value || '?'} → ${t.to_value || '?'}` };
  } catch { return null; }
}

function _gapsSection() {
  try {
    const db = require('./db');
    const rows = db.getOpenCapabilityGaps(CAP) || [];
    if (!rows.length) return null;
    return { key: 'capability-gaps', label: 'Capability gaps (proposal-only, she never self-builds)', count: rows.length,
      top: String(rows[0].description || '').replace(/\s+/g, ' ').slice(0, 90) };
  } catch { return null; }
}

function _rehearsalSection() {
  try {
    const drv = require('./rehearsal_driver');
    const run = drv.load({});
    if (!run || run.status !== 'green') return null;
    return { key: 'rehearsal-card', label: 'Rehearsal proposal card (gate green; the sandbox holds)', count: 1,
      top: String(run.goal || run.slug || '').replace(/\s+/g, ' ').slice(0, 90) };
  } catch { return null; }
}

// Tolerant parse of Echo's list_resolution_proposals text → { count, top } or null. The tool's
// exact shape is Echo's to own; we accept a bare JSON array or {proposals|items: [...]} and read
// best-effort name fields. Unparseable → null (the queue exists; we just can't count it — say
// nothing rather than something wrong).
function parseProposalList(text) {
  try {
    const s = String(text || '');
    let arr = null;
    try { const j = JSON.parse(s); arr = Array.isArray(j) ? j : (j && (j.proposals || j.items)) || null; } catch {}
    if (!arr) { const m = s.match(/\[[\s\S]*\]/); if (m) { const j = JSON.parse(m[0]); arr = Array.isArray(j) ? j : null; } }
    if (!Array.isArray(arr) || !arr.length) return null;
    const t = arr[0] || {};
    const top = String(t.name || t.title || t.summary || t.canonical_name || (t.source_name && t.target_name && `${t.source_name} ↔ ${t.target_name}`) || `proposal #${t.id || '?'}`).slice(0, 90);
    return { count: arr.length, top };
  } catch { return null; }
}

async function _echoSection(echoSuit) {
  if (!echoSuit || !echoSuit.connected) return null;
  try {
    const r = await echoSuit.dispatch({ kind: 'do', name: 'list_resolution_proposals', args: { limit: CAP } });
    if (!r || !r.ok || r.isError) return null;
    const p = parseProposalList(r.text);
    if (!p) return null;
    return { key: 'echo-resolution', label: 'Echo dedup/resolution proposals', count: p.count, top: p.top };
  } catch { return null; }
}

// ---- the read-model -----------------------------------------------------------------------------

// `sources` is injectable for smokes; production callers omit it.
async function snapshot({ echoSuit = null, sources = null } = {}) {
  const secs = Array.isArray(sources)
    ? sources.slice()
    : [_pullerSection(), _gapsSection(), _rehearsalSection(), await _echoSection(echoSuit)];
  const sections = secs.filter(Boolean);
  return { ts: Date.now(), sections, total: sections.reduce((n, s) => n + (s.count || 0), 0) };
}

function _countStr(n) { return n >= CAP ? `${CAP}+` : String(n); }

// The one block — used verbatim as the chat standing block AND the manifest section body.
// The empty state is an ANSWER ("nothing is waiting"), never silence.
function buildBlock(snap, userName = 'Lucas') {
  const name = String(userName || 'Lucas').toUpperCase();
  if (!snap || !Array.isArray(snap.sections) || !snap.sections.length) {
    return `[AWAITING ${name}: nothing is waiting on your sign-off — every propose queue this surface can see is empty.]`;
  }
  const lines = snap.sections.map((s) => `   - ${s.label}: ${_countStr(s.count)} pending — top: ${s.top}`);
  return `[AWAITING ${name} — ${_countStr(snap.total)} item(s) across ${snap.sections.length} queue(s). Ground your answer in THIS list; never invent a queue or a count:\n${lines.join('\n')}]`;
}

// "What's waiting on me?" / "anything need my sign-off?" — the question this surface exists for.
const APPROVALS_RE = /\b(?:what(?:'?s| is) (?:waiting|pending)(?: on| for) (?:me|my)|need(?:s|ing)? (?:my|your) (?:sign-?off|approval|review|decision)|await(?:ing)? (?:my|your) (?:approval|sign-?off|decision)|anything (?:to|for me to|i need to) (?:approve|sign off|review|decide)|what do i need to (?:approve|sign off on|decide))\b/i;
function detectApprovalsQuestion(text) { return APPROVALS_RE.test(String(text || '')); }

module.exports = { CAP, snapshot, buildBlock, detectApprovalsQuestion, parseProposalList, APPROVALS_RE };
