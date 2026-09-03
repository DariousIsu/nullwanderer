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

// TENANT BULK-PROMOTE AWAITS THE OPERATOR (2026-07-30, inventory §3): ~146k proposals sit in the
// rainey tenant store behind the Option-B review gate — the chain that turned 8,508 documents into
// 14 promoted entities strangles exactly here. promote_tenant_proposals' own charter forbids timer
// wiring ("no silent auto-promotion"), so the ONLY correct build is VISIBILITY: the count rides
// the AWAITING-LUCAS manifest and the drain fires on HIS explicit word. Read-only count over the
// tenant DB file; fail-soft — a missing/locked DB drops the section, it never fakes a zero.
const TENANT_SQL = {
  ents: 'SELECT COUNT(*) c FROM entity_proposals',
  rels: 'SELECT COUNT(*) c FROM relation_proposals',
  ready: 'SELECT COUNT(*) c FROM entity_proposals WHERE confidence >= 0.8',
};
function _tenantPath() { return process.env.ZOE_TENANT_DB || 'C:/Users/azrae/Desktop/NX ECHO/nx-echo/data/mcps/rainey/isolated.db'; }
function _tenantShape(ents, rels, ready) {
  if (!(ents + rels)) return null;
  return {
    key: 'tenant-backlog',
    label: 'Rainey tenant backlog (bulk-promote is YOUR explicit call — say "promote the tenant backlog")',
    count: ents + rels,
    top: `${ready} entity proposal(s) at/above the 0.8 floor would ride one promote_tenant_proposals call`,
  };
}
function _tenantSection() {
  try {
    const p = _tenantPath();
    if (!require('fs').existsSync(p)) return null;
    const Database = require('better-sqlite3');
    const d = new Database(p, { readonly: true });
    let ents = 0, rels = 0, ready = 0;
    try { ents = d.prepare(TENANT_SQL.ents).get().c; } catch {}
    try { rels = d.prepare(TENANT_SQL.rels).get().c; } catch {}
    try { ready = d.prepare(TENANT_SQL.ready).get().c; } catch {}
    try { d.close(); } catch {}
    return _tenantShape(ents, rels, ready);
  } catch { return null; }
}
// OFF THE MAIN THREAD (freeze cut 6): the three COUNT(*)s walk ~146k proposals — ~1s each on the main thread
// (p256), every hourly refresh. Through the db worker (`query(dbPath, sql, params, {mode})`) the tenant file
// is opened read-only on its own thread; each count still fails soft to 0, exactly as inline.
async function _tenantSectionVia(query) {
  try {
    const p = _tenantPath();
    if (!require('fs').existsSync(p)) return null;
    const count = async (sql) => { try { const r = await query(p, sql, [], { mode: 'get' }); return Number((r && r.c) || 0); } catch { return 0; } };
    return _tenantShape(await count(TENANT_SQL.ents), await count(TENANT_SQL.rels), await count(TENANT_SQL.ready));
  } catch { return null; }
}

// ---- the read-model -----------------------------------------------------------------------------

// SECTION TIMER (freeze cut 5b): the snapshot runs inside the autonomy tick, synchronously, and the tick
// blocked the main thread 10–14s on p256/p257 with no single statement ≥1s to name. A section at or above
// the floor names itself (the tenant section's three COUNT(*)s over ~146k proposals are the known suspect).
const SLOW_SECTION_MS = 300;
function _timed(label, fn) {
  const t0 = Date.now();
  try { return fn(); }
  finally { const ms = Date.now() - t0; if (ms >= SLOW_SECTION_MS) { try { console.warn(`[approvals] slow section ${label}: ${ms}ms`); } catch {} } }
}

// `sources` is injectable for smokes; production callers omit it. `query` = the db worker's door — with
// it the tenant counts run off the main thread (freeze cut 6); without it they run inline, timed.
async function snapshot({ echoSuit = null, sources = null, query = null } = {}) {
  const secs = Array.isArray(sources)
    ? sources.slice()
    : [_timed('puller', _pullerSection), _timed('gaps', _gapsSection), _timed('rehearsal', _rehearsalSection),
       typeof query === 'function' ? await _tenantSectionVia(query) : _timed('tenant', _tenantSection),
       await _echoSection(echoSuit)];
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
