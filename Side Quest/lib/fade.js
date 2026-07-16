'use strict';
/**
 * lib/fade.js — Slice 6: the "fade" arm of prove-or-fade (docs/SUBSTANTIATION_IMPL_PLAN.md; decision #6).
 *
 * An UNSUBSTANTIATED node that the prove lane (Slice 4) never substantiates does not linger forever: past a
 * TTL it is ARCHIVED (status='archived') — RETAINED + restorable (never hard-deleted), but dropped from the
 * prove queue and from active recall. This is the contamination valve the vision calls for — the short-term
 * buffer + fade, NOT rejection at the door ([[let-it-in-mark-and-churn]]).
 *
 * PURE decision core (age is passed in — no clock here, so it's offline-smoke-testable + Workflow-safe),
 * mirroring lib/retention.js: the db lists candidates, plan() decides, main.js applies the archive.
 */

const DAY = 86400000;
const DEFAULT_TTL_MS = 14 * DAY;   // give the async prove lane many passes before an unproven node fades

// plan(rows, { ttlMs, now }) → { archive: [id...], kept }. A candidate is archived when it has aged past the
// TTL since it was captured. `rows` = [{ id, captured_at }] (already filtered to unsubstantiated + non-archived
// upstream). Pure; a row with no id / no numeric captured_at is KEPT (never archived on bad data).
function plan(rows, { ttlMs = DEFAULT_TTL_MS, now } = {}) {
  const t = Number(now);
  const ttl = Number(ttlMs) > 0 ? Number(ttlMs) : DEFAULT_TTL_MS;
  const archive = [];
  let kept = 0;
  for (const r of (Array.isArray(rows) ? rows : [])) {
    const cap = Number(r && r.captured_at);
    const id = r && r.id;
    if (id == null || !Number.isFinite(cap)) { kept++; continue; }
    if (Number.isFinite(t) && (t - cap) > ttl) archive.push(id);
    else kept++;
  }
  return { archive, kept };
}

module.exports = { DAY, DEFAULT_TTL_MS, plan };
