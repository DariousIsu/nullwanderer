/* studio/puller_ingest.js — Puller Slice 2: map handoff-sheet rows into the dossier store.
 *
 * Takes already-parsed rows (the xlsx reader is separate — openpyxl for the one-off stock, SheetJS
 * for the in-app drop later) and writes targets + observations + beliefs, and credits per-domain
 * email-pattern beliefs from the CONFIRMED rows. Deterministic: tier → kind/confidence is a fixed
 * table; the pattern credit reuses the pure detector in studio/puller_beliefs. No model.
 *
 * Confidence-tier semantics (from the sheet's own "How To Read This"):
 *   95% verified   — email found in a public source OR mail-server confirmed → pattern HIT
 *   80% pattern     — company email format confirmed + applied                → pattern HIT
 *   50% best-guess  — real person, format NOT confirmed, defaulted first.last  → NO credit (a candidate)
 *   30% generic     — shared mailbox (press@/info@), not a person              → NO credit
 *
 * NEGATIVES are intentionally NOT ingested here — they arrive downstream (a verify pass) and drive
 * the belief flips + revision proposals. This only stocks the positive baseline.
 */
'use strict';
const B = require('./puller_beliefs');

const clean = (s) => String(s == null ? '' : s).trim();
const key = (name, company) => `${clean(name).toLowerCase()}|${clean(company).toLowerCase()}`;

function parseConfidence(c) {
  const m = /(\d+(?:\.\d+)?)\s*%/.exec(String(c == null ? '' : c));
  if (m) return Math.max(0, Math.min(1, parseFloat(m[1]) / 100));
  const n = parseFloat(c);
  return Number.isFinite(n) ? (n > 1 ? n / 100 : n) : null;
}
function tierKind(conf) {
  if (conf == null) return 'guess';
  if (conf >= 0.95) return 'verified';
  if (conf >= 0.80) return 'pattern';
  if (conf >= 0.50) return 'guess';
  return 'generic';
}
function domainOf(email) {
  const e = clean(email).toLowerCase();
  const i = e.indexOf('@');
  return i > 0 ? e.slice(i + 1) : null;
}
// A confirmed tier credits its domain's detected pattern; a guess/generic does not.
function creditsPattern(kind) { return kind === 'verified' || kind === 'pattern'; }

// Ingest rows into the store. `db` = lib/puller_db (or a compatible instance). Idempotent at the
// (name, company) grain: a person already tracked is skipped (re-running the sheet is a no-op), so
// observations + pattern hits aren't double-counted. Per-domain pattern state is accumulated in
// memory across the batch and saved once per domain at the end.
function ingestRows(db, rows, opts = {}) {
  const source = opts.source || 'handoff sheet';
  const seen = new Map();
  for (const t of db.listTargets({ limit: 1e7 })) seen.set(key(t.name, t.company), t.id);
  const patternStates = new Map();   // domain -> pure belief state
  const stats = { rows: 0, targets: 0, skippedDup: 0, noName: 0, observations: 0, beliefs: 0,
                  patternHits: 0, generic: 0, domains: 0 };

  for (const r of (rows || [])) {
    stats.rows++;
    const name = clean(r.name), company = clean(r.company), title = clean(r.title);
    const email = clean(r.email).toLowerCase();
    const conf = parseConfidence(r.confidence);
    const kind = tierKind(conf);
    if (!name) { stats.noName++; continue; }
    const k = key(name, company);
    if (seen.has(k)) { stats.skippedDup++; continue; }

    const domain = domainOf(email);
    const t = db.createTarget({ kind: 'person', name, company: company || null, domain, notes: title || null });
    seen.set(k, t.id);
    stats.targets++;

    if (email) {
      db.addObservation(t.id, { attr: 'email', value: email, kind, source, confidence: conf }); stats.observations++;
      db.upsertBelief(t.id, 'email', { value: email, confidence: conf, derivation: `handoff:${kind}` }); stats.beliefs++;
    }
    if (title) {
      db.addObservation(t.id, { attr: 'role', value: title, kind: 'handoff', source }); stats.observations++;
      db.upsertBelief(t.id, 'role', { value: title, confidence: conf, derivation: 'handoff' }); stats.beliefs++;
    }
    const phone = clean(r.phone) || clean(r.phone2);
    if (phone) {
      db.addObservation(t.id, { attr: 'phone', value: phone, kind: 'handoff', source }); stats.observations++;
      db.upsertBelief(t.id, 'phone', { value: phone, confidence: conf, derivation: 'handoff' }); stats.beliefs++;
    }
    if (kind === 'generic') stats.generic++;

    if (domain && email && creditsPattern(kind)) {
      const pat = B.detectPatternUsed(email, name, domain);
      if (pat) {
        let st = patternStates.get(domain) || db.getPatternState(domain);
        st = B.updateBelief(st, pat, 'valid');
        patternStates.set(domain, st);
        stats.patternHits++;
      }
    }
  }
  for (const [domain, st] of patternStates) { db.savePatternState(domain, st); stats.domains++; }
  return stats;
}

module.exports = { ingestRows, parseConfidence, tierKind, domainOf, creditsPattern, clean, key };
