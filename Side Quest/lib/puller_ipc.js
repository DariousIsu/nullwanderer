/**
 * lib/puller_ipc.js — Puller's main-process bridge (Slice 1: read-only dossier surface).
 *
 * The renderer (renderer/dossier.{html,js}) can't touch better-sqlite3, so it asks here. This module
 * owns the IPC handlers + the dossier AGGREGATOR (buildDossier) that joins the store rows into one
 * view shape. All read-only in this slice. Kept as its own module so main.js only adds a require +
 * register() call (a single isolatable hunk vs the concurrent session's edits).
 *
 * Aggregation joins lib/puller_db rows with the pure belief math in studio/puller_beliefs so the UI
 * can show, per the target's domain, the live email-pattern belief distribution (the §4 store made
 * legible) without re-deriving anything itself.
 *
 * Slice 4 (write actions): the dossier's operator actions — mark-verification (the negatives funnel),
 * decide-revision (accept/reject the flip), mark-dedicated (grade-A → 100%), and promote — are wired
 * to studio/puller_revise + lib/puller_db here. Every write handler returns the freshly-rebuilt
 * dossier so the renderer just re-paints. PROMOTE writes locally + records crm_id; the Echo-contact
 * write is a seam (echoContactWrite) left unset until the reboot probe confirms a write path.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const db = require('./puller_db');
const beliefs = require('../studio/puller_beliefs');
const confidence = require('../studio/puller_confidence');
const revise = require('../studio/puller_revise');
const exporter = require('../studio/puller_export');
const priors = require('../studio/puller_priors');
const negatives = require('../studio/puller_negatives');

// Seam for the eventual Echo contact write (Slice 5). Unset until a write path is confirmed on
// reboot; promote() degrades to local status + export. Set via setEchoContactWrite(fn).
let echoContactWrite = null;
function setEchoContactWrite(fn) { echoContactWrite = typeof fn === 'function' ? fn : null; }

function init() { try { db.init(); } catch (e) { console.error('[puller] db init failed:', e.message); } }

// Per-domain email-pattern belief, made legible: each candidate pattern with its current Beta belief
// + raw hits/misses, the leading one flagged, and the catch-all warning. Empty when no domain.
function domainPatternView(domain) {
  if (!domain) return null;
  const state = db.getPatternState(domain);
  const best = beliefs.bestPattern(state);
  const patterns = beliefs.PATTERN_PRIORITY.map(p => {
    const e = (state.patterns && state.patterns[p]) || { hits: 0, misses: 0 };
    return {
      pattern: p,
      belief: beliefs.currentBelief(state, p),
      hits: e.hits | 0,
      misses: e.misses | 0,
      best: p === best,
      dead: beliefs.isPatternDead(state, p),
    };
  }).sort((a, b) => b.belief - a.belief);
  return { domain, isCatchAll: beliefs.isCatchAll(state), infraBlocked: beliefs.looksInfraBlocked(state), best, patterns };
}

// The full dossier view for one target: identity + evidence timeline + derived beliefs + the pending
// revisions awaiting a decision + the retest queue + the domain pattern distribution.
function buildDossier(targetId) {
  const target = db.getTarget(targetId);
  if (!target) return null;
  const pendingForTarget = db.listRevisions({ status: 'pending', targetId });
  // domain-level (email_pattern) revisions carry target_id=null — fold them in for this domain too
  const domainRevs = target.domain
    ? db.listRevisions({ status: 'pending' }).filter(r => r.subject_kind === 'pattern' && r.subject_ref === target.domain)
    : [];
  const revisions = [...pendingForTarget, ...domainRevs];
  const observations = db.listObservations(targetId);
  const beliefList = db.listBeliefs(targetId);
  // axis-1 qualification for the held email value (grade ladder, capped ratchet) — the send-safety read
  const emailBelief = beliefList.find(b => b.type === 'email');
  const qualification = emailBelief
    ? confidence.qualify(observations.filter(o => o.attr === 'email'), emailBelief.value)
    : null;
  return {
    target,
    observations,
    beliefs: beliefList,
    qualification,   // { grade, confidence, conflicted, note, capBy } for the held email
    revisions,
    retests: db.listRetests({ status: 'queued' }).filter(r => r.target_id === targetId),
    domainPattern: domainPatternView(target.domain),
  };
}

function listTargets(opts = {}) {
  return db.listTargets(opts).map(t => ({
    id: t.id, kind: t.kind, name: t.name, company: t.company, domain: t.domain,
    function: t.function, status: t.status, crm_id: t.crm_id, last_accessed_at: t.last_accessed_at,
  }));
}

function register(ipcMain) {
  init();
  ipcMain.handle('puller:list-targets', (_e, opts = {}) => {
    try { return { ok: true, targets: listTargets(opts || {}) }; }
    catch (e) { console.error('[puller] list-targets failed:', e.message); return { ok: false, error: e.message, targets: [] }; }
  });
  ipcMain.handle('puller:get-dossier', (_e, { targetId } = {}) => {
    try {
      const dossier = buildDossier(targetId);
      return dossier ? { ok: true, dossier } : { ok: false, error: 'target not found' };
    } catch (e) { console.error('[puller] get-dossier failed:', e.message); return { ok: false, error: e.message }; }
  });

  // ---- write actions (Slice 4) — each returns the rebuilt dossier so the renderer just re-paints ----

  // The negatives funnel (manual "mark bounced" / verified). value defaults to the held email.
  ipcMain.handle('puller:mark-verification', (_e, { targetId, value, result } = {}) => {
    try {
      let v = value;
      if (!v) { const b = db.getBelief(targetId, 'email'); v = b && b.value; }
      const outcome = revise.applyVerification(targetId, { value: v, result });
      return { ok: true, outcome, dossier: buildDossier(targetId) };
    } catch (e) { console.error('[puller] mark-verification failed:', e.message); return { ok: false, error: e.message }; }
  });

  // Accept (apply the flip) or reject (keep the conflicted value) a proposed revision.
  ipcMain.handle('puller:decide-revision', (_e, { targetId, revisionId, decision } = {}) => {
    try {
      const outcome = revise.decideRevision(revisionId, decision);
      return { ok: true, outcome, dossier: buildDossier(targetId) };
    } catch (e) { console.error('[puller] decide-revision failed:', e.message); return { ok: false, error: e.message }; }
  });

  // Grade-A: record an official dedicated source (business card / directory) → qualification = 100%.
  ipcMain.handle('puller:mark-dedicated', (_e, { targetId, value, note } = {}) => {
    try {
      const outcome = revise.markDedicatedSource(targetId, { value, note });
      return { ok: true, outcome, dossier: buildDossier(targetId) };
    } catch (e) { console.error('[puller] mark-dedicated failed:', e.message); return { ok: false, error: e.message }; }
  });

  // Promote into the CRM at any qualification level. Writes locally + records crm_id; attempts the
  // Echo write only if the seam is wired (degrades cleanly to local + export otherwise).
  ipcMain.handle('puller:promote', async (_e, { targetId, crmId = null } = {}) => {
    try {
      let echo = { wrote: false, crmId };
      if (echoContactWrite) {
        try { const t = db.getTarget(targetId); const r = await echoContactWrite(t); echo = { wrote: true, crmId: (r && r.crmId) || crmId }; }
        catch (we) { echo = { wrote: false, error: we.message, crmId }; }
      }
      db.promoteTarget(targetId, echo.crmId || null);
      return { ok: true, echo, dossier: buildDossier(targetId) };
    } catch (e) { console.error('[puller] promote failed:', e.message); return { ok: false, error: e.message }; }
  });

  // Export promoted dossiers in Echo Contact shape (the chosen handoff path → pass76_bulk_prospects).
  // Send-safety gate: conflicted/bounced excluded by default; opts.minGrade floors weak rows.
  ipcMain.handle('puller:export', (_e, opts = {}) => {
    try {
      const status = opts.all ? null : 'promoted';
      const items = db.listTargets({ status, limit: 1e7 }).map(t => buildDossier(t.id)).filter(Boolean);
      const { rows, excluded } = exporter.toContactRows(items, opts);
      const dir = path.join(__dirname, '..', 'data', 'exports');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `puller_contacts_${Date.now()}.csv`);
      fs.writeFileSync(file, exporter.toCSV(rows), 'utf-8');
      return { ok: true, file, count: rows.length, excluded: excluded.length, considered: items.length };
    } catch (e) { console.error('[puller] export failed:', e.message); return { ok: false, error: e.message }; }
  });

  // Seed per-domain pattern priors (activates the gateway-block detector on known domains).
  ipcMain.handle('puller:seed-priors', () => {
    try { return { ok: true, ...priors.seedInto() }; }
    catch (e) { console.error('[puller] seed-priors failed:', e.message); return { ok: false, error: e.message }; }
  });

  // Re-derive queued retests for a domain after its belief shifted (§4.4 cascade).
  ipcMain.handle('puller:cascade', (_e, { domain } = {}) => {
    try { return { ok: true, updated: revise.cascadeForDomain(domain) }; }
    catch (e) { console.error('[puller] cascade failed:', e.message); return { ok: false, error: e.message }; }
  });

  // Ingest a vendor bounce file (pasted text): parse → resolve each email to a target → applyVerification.
  // The whole negatives-file path in one call. Unmatched emails are counted, not invented.
  ipcMain.handle('puller:ingest-negatives', (_e, { text } = {}) => {
    try {
      const { rows, dropped, vendor } = negatives.parseResults(text || '');
      const summary = { vendor, parsed: rows.length, dropped, matched: 0, unmatched: 0, applied: 0, flips: 0, infra: 0 };
      for (const row of rows) {
        const t = db.findTargetByEmail(row.email);
        if (!t) { summary.unmatched++; continue; }
        summary.matched++;
        const o = revise.applyVerification(t.id, { value: row.email, result: row.result });
        summary.applied++;
        if (o.revisionId) summary.flips++;
        if (o.infraSuspect) summary.infra++;
      }
      return { ok: true, summary };
    } catch (e) { console.error('[puller] ingest-negatives failed:', e.message); return { ok: false, error: e.message }; }
  });
}

module.exports = { init, register, buildDossier, domainPatternView, listTargets, setEchoContactWrite };
