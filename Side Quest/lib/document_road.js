/**
 * lib/document_road.js — THE DOCUMENT ROAD, S0 (docs/DOCUMENT_ROAD_DESIGN_2026-08-28.md).
 * Lucas's decisions (08-28): typed orders only · road-owned-only subtractions · the size table
 * below · direct orders ride the interactive lane.
 *
 * S0 is MEASUREMENT-ONLY: the road CLAIMS every typed deliverable order at the one door
 * (intake's detectDeliverableOrder → _bookUserOrderBackstop) and METERS every other organ that
 * books the same ask (promise backstop, say-promise cover, in-turn delivery, user-work redirect).
 * Nothing is subtracted yet — the meter's owner counts are the evidence S3's subtractions will
 * cite, and the double-booking count is the road's own regression meter from day one.
 *
 * The redirect fires BEFORE the claim in turn order (p179 live trace), so it notes itself into a
 * short pre-claim buffer the claim sweeps; organs that fire after the claim use meterIfRecent.
 */
'use strict';

const CLAIMS_KEY = 'road.claims';
const CLAIMS_CAP = 20;
const RECENT_MS = 90 * 1000;

function _db(deps) { return (deps && deps.db) || require('./db'); }

// The size table (design D3, his pick): what the ask CALLS the deliverable decides the budget
// class downstream (S1). Default = report.
function sizeClass(order) {
  const s = `${(order && order.deliverable) || ''} ${(order && order.topic) || ''}`.toLowerCase();
  if (/\b(dossier|comprehensive|deep.?dive|everything|full (?:write.?up|history|picture))\b/.test(s)) return 'dossier';
  if (/\b(summary|brief|memo|blurb|one.?pager|tl;?dr)\b/.test(s)) return 'brief';
  return 'report';
}

function _load(deps) { try { return JSON.parse(_db(deps).getMeta(CLAIMS_KEY) || '[]') || []; } catch { return []; } }
function _save(list, deps) { try { _db(deps).setMeta(CLAIMS_KEY, JSON.stringify(list.slice(-CLAIMS_CAP))); } catch {} }

let _lastClaim = null;
let _preNotes = [];

// An organ that runs BEFORE the claim in the turn (the user-work redirect) notes itself here;
// the next claim (within the window) sweeps it into its owner list.
function notePreClaim(organ, ref = null, { nowMs = Date.now() } = {}) {
  _preNotes.push({ ts: nowMs, organ: String(organ), ref });
  _preNotes = _preNotes.filter((n) => nowMs - n.ts <= RECENT_MS).slice(-8);
}

function claim({ order, userText, bind = null, deps = {}, nowMs = Date.now() } = {}) {
  if (!order || !order.deliverable) return null;
  const c = {
    ts: nowMs,
    slug: (bind && bind.slug) || null,
    minted: !!(bind && bind.created),
    size: sizeClass(order),
    deliverable: String(order.deliverable).slice(0, 60),
    ask: String(userText || '').slice(0, 200),
    owners: ['road'],
  };
  for (const n of _preNotes.filter((n) => nowMs - n.ts <= RECENT_MS)) {
    c.owners.push(n.ref != null ? `${n.organ}#${n.ref}` : n.organ);
  }
  _preNotes = [];
  const list = _load(deps); list.push(c); _save(list, deps);
  _lastClaim = c;
  console.log(`[road] S0 claim: "${c.slug || '(unbound)'}" (size=${c.size}) — the meter is armed${c.owners.length > 1 ? ` (pre-claim owners swept: ${c.owners.slice(1).join(' + ')})` : ''}`);
  return c;
}

// Record another organ booking the SAME ask (S0's whole point). ref = its row/thread id.
function meter(c, organ, ref = null, { deps = {} } = {}) {
  if (!c || !organ) return;
  c.owners.push(ref != null ? `${organ}#${ref}` : String(organ));
  const list = _load(deps);
  const at = list.findIndex((x) => x.ts === c.ts && x.slug === c.slug);
  if (at >= 0) { list[at] = c; _save(list, deps); }
  console.log(`[road] meter: +${organ} on "${c.slug || '(unbound)'}" — owners now: ${c.owners.join(' + ')}`);
}

// A tap for organs outside the intake function's scope that fire AFTER the claim (the absence
// organ joins here at S1): meters onto the just-made claim only — never onto stale history.
function meterIfRecent(organ, ref = null, { deps = {}, nowMs = Date.now() } = {}) {
  if (_lastClaim && nowMs - _lastClaim.ts <= RECENT_MS) meter(_lastClaim, organ, ref, { deps });
}

function claims({ deps = {} } = {}) { return _load(deps); }

// ── S1: the in-turn document run (design D3) ────────────────────────────────────────────────────
// The budget table keys off the size class; the mandate is PURE so the say-gate's demands are
// pinnable. The run itself is fired by main.js on the interactive lane (autonomous:false — a
// direct order is never quota-starved; his decision, 08-28).
const BUDGET = { brief: 0.75, report: 1, dossier: 2 };
function mandate({ order, road, userText } = {}) {
  const size = (road && road.size) || 'report';
  const slug = (road && road.slug) || null;
  const sizeLine = size === 'brief' ? 'brief (1-2 pages)' : size === 'dossier' ? 'full dossier (as long as the material warrants)' : 'report (up to ~10 pages)';
  return `DELIVERABLE ORDER (the document road): ${String(userText || '').slice(0, 400)}\n\n` +
    `Write the ${sizeLine} NOW, in this run.` +
    (slug ? ` The registry project for this document is "${slug}" — update the canonical, never a parallel copy.` : '') +
    ` Save the document with the file tool (notes/${slug || 'report'}.md) or the canvas doc tool.` +
    ' Numbers come from held rows and tool results ONLY — never authored.' +
    ' Your FINAL message is the pointer to the finished document plus a 3-6 line summary of it — or an HONEST PARTIAL naming exactly what is missing and what you ran.';
}

function _resetForTest() { _lastClaim = null; _preNotes = []; }

module.exports = { sizeClass, claim, meter, meterIfRecent, notePreClaim, claims, mandate, BUDGET, _resetForTest, CLAIMS_KEY, CLAIMS_CAP };
