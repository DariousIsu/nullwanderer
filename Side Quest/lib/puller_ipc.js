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
const normalizer = require('../lib/bounce_normalizer');
const prefilter = require('../lib/email_prefilter');
const corrections = require('../lib/puller_corrections');

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

  // ---- F4 correction loop: contextual identity-dedup sweep + operator merge/reassign/split ----------

  // Run the retrospective identity-dedup sweep over live targets. Default = DRY (surface proposals + flags
  // only). apply:true auto-folds the confident low-degree role matches (logged, reversible).
  ipcMain.handle('puller:dedup-sweep', (_e, { apply = false } = {}) => {
    try { return { ok: true, ...corrections.runSweep({ apply: !!apply }) }; }
    catch (e) { console.error('[puller] dedup-sweep failed:', e.message); return { ok: false, error: e.message }; }
  });
  // Operator applies a proposed merge (or confirms a flagged one). Reversible via puller:unmerge.
  ipcMain.handle('puller:apply-merge', (_e, { fromId, intoId, reason = null } = {}) => {
    try { return { ok: true, ...db.mergeTarget(fromId, intoId, { actor: 'operator', reason }) }; }
    catch (e) { console.error('[puller] apply-merge failed:', e.message); return { ok: false, error: e.message }; }
  });
  ipcMain.handle('puller:unmerge', (_e, { correctionId } = {}) => {
    try { const r = db.unmergeTarget(correctionId); return r ? { ok: true, ...r } : { ok: false, error: 'correction not found or already reverted' }; }
    catch (e) { console.error('[puller] unmerge failed:', e.message); return { ok: false, error: e.message }; }
  });
  ipcMain.handle('puller:reassign-observation', (_e, { obsId, toTargetId, reason = null } = {}) => {
    try { return { ok: true, ...db.reassignObservation(obsId, toTargetId, { actor: 'operator', reason }) }; }
    catch (e) { console.error('[puller] reassign failed:', e.message); return { ok: false, error: e.message }; }
  });
  ipcMain.handle('puller:split-target', (_e, { fromId, obsIds, name, company, domain, reason = null } = {}) => {
    try { return { ok: true, ...db.splitTarget(fromId, { obsIds, name, company, domain, actor: 'operator', reason }) }; }
    catch (e) { console.error('[puller] split failed:', e.message); return { ok: false, error: e.message }; }
  });
  ipcMain.handle('puller:list-corrections', (_e, opts = {}) => {
    try { return { ok: true, corrections: db.listCorrections(opts || {}) }; }
    catch (e) { console.error('[puller] list-corrections failed:', e.message); return { ok: false, error: e.message }; }
  });

  // Ingest a bounce report of ANY format (DSN / ARF / ESP JSON / CSV / free text) — the drop-zone door.
  // Sniff → canonical rows → resolve each email to a target → drive the negative-signal loop. A COMPLAINT
  // (suppression:true) is recorded as a do-not-send marker WITHOUT poisoning the address's validity belief
  // (research: suppression ≠ invalidity). Unmatched emails are counted, never invented. opts.testList
  // marks the batch as a controlled test-send (weighted above opportunistic; recorded on the observation).
  ipcMain.handle('puller:ingest-bounces', (_e, { text, format = null, testList = false } = {}) => {
    try { return { ok: true, summary: applyBounceRows(text || '', { format, testList }) }; }
    catch (e) { console.error('[puller] ingest-bounces failed:', e.message); return { ok: false, error: e.message }; }
  });
  // Back-compat alias for the existing renderer (CSV/vendor path) — now routed through the agnostic sniffer.
  ipcMain.handle('puller:ingest-negatives', (_e, { text } = {}) => {
    try { return { ok: true, summary: applyBounceRows(text || '', {}) }; }
    catch (e) { console.error('[puller] ingest-negatives failed:', e.message); return { ok: false, error: e.message }; }
  });

  // Reconcile a SENT test list against the bounces it produced: classify EVERY sent address (bounced →
  // invalid, delivered → valid, SILENT → unknown/unconfirmed) and drive the loop with weight:test.
  // `sent` = [email | {email}]; `resultsText` = the bounce report (any format). Pre-filter culls the
  // obviously-unsendable BEFORE we count a silence against a target (a no-MX address never had a chance).
  ipcMain.handle('puller:reconcile-testlist', async (_e, { sent = [], resultsText = '' } = {}) => {
    try {
      const { rows } = normalizer.parse(resultsText || '', { testList: true });
      const reconciled = normalizer.reconcileTestList(sent, rows);   // already deduped: best result per email
      const summary = { sent: reconciled.length, bounced: 0, delivered: 0, silent: 0, matched: 0, unmatched: 0, applied: 0, flips: 0, culled: 0, prefilterSkipped: 0 };
      // Pre-filter the SILENT addresses in BOUNDED PARALLEL (each is a real DNS MX lookup — a sequential
      // loop over a large list would block the main process). Culling silences is cosmetic (silence never
      // drives a belief change), so beyond the cap we simply don't cull. Fail-open on any DNS hiccup.
      const MAX_PREFILTER = 200;
      const silentEmails = reconciled.filter(r => r.silent).map(r => r.email);
      summary.prefilterSkipped = Math.max(0, silentEmails.length - MAX_PREFILTER);
      const rejected = new Set();
      await Promise.all(silentEmails.slice(0, MAX_PREFILTER).map(async (email) => {
        try { const pf = await prefilter.prefilter(email); if (pf.verdict === 'reject') rejected.add(email); } catch { /* fail-open */ }
      }));
      for (const r of reconciled) {
        if (r.result === 'invalid') summary.bounced++;
        else if (r.result === 'valid') summary.delivered++;
        else summary.silent++;
        // a silent address that fails the safe pre-filter (no MX / disposable) never had a chance — skip it.
        if (r.silent && rejected.has(r.email)) { summary.culled++; continue; }
        const t = db.findTargetByEmail(r.email);
        if (!t) { summary.unmatched++; continue; }
        summary.matched++;
        if (r.result === 'unknown') continue;           // silence/soft → no belief change, just surfaced
        const o = revise.applyVerification(t.id, { value: r.email, result: r.result });
        summary.applied++;
        if (o.revisionId) summary.flips++;
      }
      return { ok: true, summary };
    } catch (e) { console.error('[puller] reconcile-testlist failed:', e.message); return { ok: false, error: e.message }; }
  });
}

// Shared bounce-application path (used by ingest-bounces + the back-compat alias + the drop-zone tick).
// Parses ANY format, resolves each email to a target, and applies the canonical result — with complaints
// recorded as suppression markers (do-not-send) that never flip a validity belief.
function applyBounceRows(text, { format = null, testList = false } = {}) {
  const { rows, dropped, meta, format: fmt } = normalizer.parse(text, { format, testList });
  // COLLAPSE duplicate events per mailbox FIRST — a report with N events for one address is ONE signal,
  // not N (else: inflated Beta misses, duplicate flip revisions, false gateway-block from a single box).
  const collapsed = normalizer.collapseByEmail(rows);
  const summary = { format: fmt, vendor: meta && meta.vendor, parsed: rows.length, unique: collapsed.length,
                    dropped, matched: 0, unmatched: 0, applied: 0, flips: 0, infra: 0, suppressed: 0, deferred: 0 };
  for (const row of collapsed) {
    const t = db.findTargetByEmail(row.email);
    if (!t) { summary.unmatched++; continue; }
    summary.matched++;
    if (row.suppression) {
      // do-not-send marker — record it as an ungradeable observation so qualify() ignores it, and it's
      // visible on the dossier timeline. NOT a validity negative (the mailbox demonstrably received mail).
      db.addObservation(t.id, { attr: 'email', value: row.email, kind: 'suppressed', source: 'bounce-report',
                                meta: { raw: row.raw, weight: row.weight, suppression: true } });
      summary.suppressed++;
    }
    // a mailbox can both complain (suppression) AND hard-bounce — still apply the deliverability result.
    if (row.result === 'invalid' || row.result === 'valid') {
      const o = revise.applyVerification(t.id, { value: row.email, result: row.result });
      summary.applied++;
      if (o.revisionId) summary.flips++;
      if (o.infraSuspect) summary.infra++;
    } else if (!row.suppression) {
      summary.deferred++;   // soft/transient with no suppression → defer, no flip
    }
  }
  return summary;
}

module.exports = { init, register, buildDossier, domainPatternView, listTargets, setEchoContactWrite, applyBounceRows };
