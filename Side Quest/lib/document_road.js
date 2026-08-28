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

// ── S1.5 CURE 1: anaphoric completion orders (the p180 miss) ────────────────────────────────────
// "yea go ahead and get that completed and pulled up on the canvas" carries no deliverable NOUN,
// so detectDeliverableOrder (precision-over-recall) returns null and the road never saw the
// order. A completion VERB aimed at "that/it" resolves against the project spine instead — the
// newest ACTIVE project touched inside the window is what "that" means. Stale spine → null
// (never bind an anaphor to old work).
const ANAPHOR_RE = /\b(?:finish|complete|deliver|produce)\b[^.?!]{0,40}\b(?:that|it)\b|\b(?:wrap|knock)\s+(?:that|it)\s+(?:up|out)\b|\b(?:get|have)\s+(?:that|it)\s+(?:done|completed|finished|written|drafted|pulled\s+up|on\s+the\s+canvas)\b|\bpull\s+(?:that|it)\s+up\b/i;
function anaphoricOrder(text) {
  const s = String(text || '');
  if (!s || s.length > 400) return false;
  return ANAPHOR_RE.test(s);
}
const ANAPHOR_WINDOW_MS = 24 * 3600 * 1000;
function resolveAnaphor({ projects = null, nowMs = Date.now() } = {}) {
  let rows = projects;
  if (!rows) { try { rows = require('./deliverable_projects').list(); } catch { rows = []; } }
  const live = (rows || [])
    .filter((p) => p && p.status === 'active' && nowMs - (p.updated_ts || 0) <= ANAPHOR_WINDOW_MS)
    .sort((a, b) => (b.updated_ts || 0) - (a.updated_ts || 0));
  return live[0] ? { slug: live[0].slug, title: live[0].title || live[0].slug } : null;
}

// ── S1.5 CURE 2: the held material rides the mandate (the 1,520-byte report against 520KB of
// held sources — the writer never saw what she holds). Deterministic, bounded, fail-soft:
// topic-tokened matches from the documents store + the downloads directory, names normalized
// space/hyphen-blind (the 35fe34d lesson).
function _norm(s) { return String(s || '').toLowerCase().replace(/[-_.\s]+/g, ''); }
function _topicTokens(topic) {
  return [...new Set(String(topic || '').toLowerCase().match(/[a-z0-9]{4,}/g) || [])]
    .filter((t) => !['that', 'this', 'with', 'from', 'about', 'analysis', 'summary', 'report', 'complete', 'completed'].includes(t))
    .slice(0, 4);
}
function heldMaterial({ topic, deps = {} } = {}) {
  const toks = _topicTokens(topic);
  if (!toks.length) return '';
  const lines = [];
  try {
    const h = (deps.db || require('./db')).getDb();
    const like = toks.slice(0, 2).map(() => 'title LIKE ?');
    const rows = h.prepare(`SELECT id, title, created_ts FROM documents WHERE ${like.join(' AND ')} ORDER BY created_ts DESC LIMIT 4`)
      .all(...toks.slice(0, 2).map((t) => `%${t}%`));
    for (const r of rows) lines.push(`- held document #${r.id}: "${String(r.title).slice(0, 110)}"`);
  } catch {}
  try {
    const fs = deps.fs || require('fs');
    const path = require('path');
    const dl = deps.downloadsDir || path.join(__dirname, '..', 'data', 'downloads');
    const names = fs.readdirSync(dl).filter((n) => { const nn = _norm(n); return toks.some((t) => nn.includes(_norm(t))); }).slice(0, 6);
    for (const n of names) {
      let kb = 0; try { kb = Math.round(fs.statSync(path.join(dl, n)).size / 1024); } catch {}
      lines.push(`- data/downloads/${n}${kb ? ` (${kb}KB)` : ''}`);
    }
  } catch {}
  return lines.slice(0, 8).join('\n');
}

// ── S1: the in-turn document run (design D3) ────────────────────────────────────────────────────
// The budget table keys off the size class; the mandate is PURE so the say-gate's demands are
// pinnable. The run itself is fired by main.js on the interactive lane (autonomous:false — a
// direct order is never quota-starved; his decision, 08-28).
const BUDGET = { brief: 0.75, report: 1, dossier: 2 };
function mandate({ order, road, userText, held = '' } = {}) {
  const size = (road && road.size) || 'report';
  const slug = (road && road.slug) || null;
  const sizeLine = size === 'brief' ? 'brief (1-2 pages)' : size === 'dossier' ? 'full dossier (as long as the material warrants)' : 'report (up to ~10 pages)';
  // S1.5 cure 2: the writer is TOLD what she holds — and the commensurate rail kills the
  // 1,520-byte-report-from-520KB-of-sources class.
  const heldBlock = held
    ? `\n\nYOU ALREADY HOLD this source material — READ IT with your tools and write FROM it. The document must be COMMENSURATE with its sources: a multi-hundred-KB source never yields a one-page report.\n${held}\n`
    : '';
  // S1.5 cure 3: report-class+ work FANS OUT — the swarm exists to be used (zero delegate calls
  // in 7 days was the finding; "complete it this turn" means the INTEGRATED document lands, not
  // that every section is written alone).
  const swarmLine = size !== 'brief'
    ? ' For a document of this size, FAN OUT: delegate section research to the Echo agent team (<echo-delegate> / the delegate_to_* tools — the legislative analyst for bill mechanics, the fact checker for claims, the historical researcher for background) and INTEGRATE their returns; completing it this turn means the integrated document lands, not that you write every section alone.'
    : '';
  return `DELIVERABLE ORDER (the document road): ${String(userText || '').slice(0, 400)}\n\n` +
    `Write the ${sizeLine} NOW, in this run.` +
    (slug ? ` The registry project for this document is "${slug}" — update the canonical, never a parallel copy.` : '') +
    ` Save the document with the file tool (notes/${slug || 'report'}.md) or the canvas doc tool.` +
    ' Numbers come from held rows and tool results ONLY — never authored.' +
    swarmLine + heldBlock +
    '\nYour FINAL message is the pointer to the finished document plus a 3-6 line summary of it — or an HONEST PARTIAL naming exactly what is missing and what you ran.';
}

function _resetForTest() { _lastClaim = null; _preNotes = []; }

module.exports = { sizeClass, claim, meter, meterIfRecent, notePreClaim, claims, mandate, BUDGET, anaphoricOrder, resolveAnaphor, heldMaterial, _resetForTest, CLAIMS_KEY, CLAIMS_CAP, ANAPHOR_WINDOW_MS };
