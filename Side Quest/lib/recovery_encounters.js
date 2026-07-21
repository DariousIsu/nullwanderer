/* lib/recovery_encounters.js — an EXTERNAL RECOVERY is an encounter with the object.
 *
 * The fifth lane. news, document, meeting, canvas_drop and (as of today) conversation all decompose
 * their input into objects in the encounter log. The enrich ladder did not: when it recovered a fact
 * from Wikipedia or the web, `_kickWriteBack → learning.captureRecovered` banked a `verified_fact`
 * row in `knowledge`, keyed by subject slot, with the URL as a citation string. Useful, but flat —
 * no object minted, no edges, and nothing that a later graph walk or corroboration count can see.
 *
 * Lucas, 2026-07-20: *"we should be able to reuse the same structure as any other pathway, they all
 * mint and enrich objects."* So this is deliberately the same shape as convo_encounters: a pure
 * mapper to encounter rows plus a fire-and-forget recorder. No new concepts.
 *
 * ── WHY THIS MAKES THE WIKI GATE PAY ─────────────────────────────────────────────────────────────
 *
 * Lucas: *"The wiki search should only be for a newly minted object or an object that has no wiki
 * link."* The gate in cognition._enrichWiki skips the fetch once an object carries a wikidata_qid.
 * That only pays off if a fetch that DOES happen leaves the link behind — otherwise the same object
 * is unlinked forever and we re-fetch on every question. Recording the recovery as an encounter with
 * the source URL as its origin is that link, in the vocabulary the rest of the system already reads.
 *
 * ── AUTHORITY ────────────────────────────────────────────────────────────────────────────────────
 *
 * Not 'stated' (that is conversation, which grades nothing) and not 'operator' (that is Lucas handing
 * over an artifact). A recovered page is a real, citable source: 'official' for a government host,
 * 'ordinary' otherwise. Wikipedia is deliberately ORDINARY — it is a tertiary source and must not
 * substitute for an official record, which is what `official` means in lib/encounters §6.3.
 */
'use strict';

const MAX_PER_RECOVERY = 6;   // a recovered page names many things; keep the strongest few
const MIN_LEN = 3;

// A government or intergovernmental host is an official record. Everything else — including
// Wikipedia — is an ordinary source.
const OFFICIAL_HOST_RE = /(^|\.)(gov|mil)(\.[a-z]{2})?$|(^|\.)(europa\.eu|un\.org|who\.int)$/i;

function hostOf(url) {
  try { return new URL(String(url)).hostname.replace(/^www\./i, ''); } catch { return null; }
}

function authorityFor(url) {
  const h = hostOf(url);
  if (!h) return 'unknown';
  return OFFICIAL_HOST_RE.test(h) ? 'official' : 'ordinary';
}

/**
 * Pure: recovered entity spans + the source → encounter rows.
 *
 * `spans` are NER spans over the RECOVERED TEXT (same input shape convo_encounters uses), so the
 * objects recorded are the ones the source actually names — not the query we happened to ask.
 */
function toEncounters(spans, { url, source = 'recovery', now = Date.now() } = {}) {
  if (!url) return [];                      // no source ⇒ nothing to attach an object to
  const authority = authorityFor(url);
  const host = hostOf(url);
  const out = [];
  const seen = new Set();
  for (const s of (Array.isArray(spans) ? spans : [])) {
    const label = String((s && (s.text || s.mention)) || '').trim();
    // ONE TYPE VOCABULARY (T1) — see lib/decomp_encounters.js TYPE_MAP. NER's `organization` and the
    // log's `org` must not become two objects for one thing.
    const type = require('./decomp_encounters').objectTypeFor((s && (s.kgType || s.type)) || null);
    if (!label || label.length < MIN_LEN || !type) continue;
    let k = null;
    try { k = require('./encounters').objectKey(type, label); } catch { k = `${type}:${label.toLowerCase()}`; }
    if (!k || seen.has(k)) continue;        // one encounter per object per recovery
    seen.add(k);
    out.push({
      object_type: type,
      object_label: label,
      claim_class: 'existence',             // existence only — same honesty bound as the other lanes
      claim_value: label,
      source_kind: 'recovery',
      source_ref: url,
      origin: url,
      origin_host: host,                    // corroboration keys on ORIGIN, so two pages of one site count once
      authority,
      observed_at: now,
      capturedBy: source,                   // which tier found it: wiki | web | excavate
    });
    if (out.length >= MAX_PER_RECOVERY) break;
  }
  return out;
}

/** Record what an external recovery encountered. Fire-and-forget; never throws. */
async function fromRecovery({ text, url, source = 'recovery' } = {}, { detect = null, record = null, now = Date.now() } = {}) {
  try {
    if (!url || !String(text || '').trim()) return 0;
    const det = detect || ((t) => require('./ner').detect(t));
    const spans = (await det(String(text).slice(0, 4000))) || [];
    const rows = toEncounters(spans, { url, source, now });
    if (!rows.length) return 0;
    const rec = record || ((list) => require('./encounters').recordMany(list));
    const r = rec(rows);
    return (r && typeof r.added === 'number') ? r.added : rows.length;
  } catch (e) {
    console.error('[recovery_encounters] record failed:', e.message);
    return 0;                               // capture must never break a turn
  }
}

module.exports = { fromRecovery, toEncounters, authorityFor, hostOf, MAX_PER_RECOVERY, OFFICIAL_HOST_RE };
