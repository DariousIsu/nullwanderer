/**
 * lib/event_lane.js — the EVENT INGEST lane (#24).
 *
 * THE GAP THIS CLOSES. The graph holds 1,810 `event` objects and NOT ONE is future-dated. Every one is
 * a NEWS HEADLINE that news_lane.promoteStory minted as entity_type='event' ("Dear Annie…", "Trump
 * shifts to battle for Hormuz") and run_event_aging later stamped occurred_at/'occurred' onto. The
 * temporal columns are full; the CONTENT is 100% news. There was no lane that INGESTS a real
 * CONVENING — a hearing, a markup, a council meeting, a calendar event — as a first-class dated object.
 * "event research" was mis-scoped as edging over headlines; the real need is INGEST (Lucas, #24).
 *
 * WHAT THIS LANE PRODUCES. Convenings from a real source (Legistar civic calendars, the owner's gcal)
 * land as `event` objects with entity_subtype='convening' (the marker that separates them from the
 * headline events), a REAL occurred_at — the FUTURE start preserved, not collapsed to "now" — and
 * event_state='scheduled' while the convening is still ahead, flipping to 'occurred' once it passes.
 * Each hubs its context through whitelisted edges: event -LOCATED_IN-> venue, event -ORGANIZED_BY->
 * body, person -ATTENDED-> event. (These three are on Echo's 62-type config.toml whitelist — verified
 * — so they are ACCEPTED, not staged-and-forgotten, and they add no synonym to the #31 relation churn.)
 *
 * DESIGN: pure recipe + injected Echo surface, exactly like news_lane.promoteStory — the adapters and
 * the claim-builder are pure (unit-tested with no I/O); dispatch / landDoc / the source fetch are
 * INJECTED so the lane is testable and the live wiring picks the source. Idempotent on the source's
 * stable id via the event_db ledger — a re-listed meeting is a cheap skip, never a re-write.
 */
'use strict';
const eventDb = require('./event_db');
const reconcile = require('./reconcile');
let confModel = null; try { confModel = require('./confidence_model'); } catch { confModel = null; }

// The whitelisted (config.toml) relation types this lane forges. Named here so the smoke can assert we
// never drift off the whitelist (the #31 trap: an off-whitelist synonym is silently rejected OR inflates
// degree). event->venue, event->body, person->event.
const REL_VENUE = 'LOCATED_IN';       // event LOCATED_IN place (source=event, target=venue)
const REL_BODY = 'ORGANIZED_BY';      // event ORGANIZED_BY body (source=event, target=convening body)
const REL_ATTEND = 'ATTENDED';        // person ATTENDED event (source=person, target=event)

const clip = (s, n) => (s == null ? '' : String(s).slice(0, n));
const isHttp = (u) => typeof u === 'string' && /^https?:/i.test(u);

// ---------------------------------------------------------------------------
// SOURCE ADAPTERS (pure). Each maps ONE raw source record → the canonical Convening shape, or null if
// the record is unusable (no name, no start). No I/O — the caller does the fetch and hands raw records in.
// ---------------------------------------------------------------------------

// Canonical Convening:
//   { extId, source, name, startMs, endMs, tz, place, body, participants[], url, summary }

// Legistar event (from legistar_list_events). Fields: EventId, EventBodyName, EventDate (ISO date),
// EventTime ("6:00 PM"), EventLocation, EventInSiteURL / EventAgendaFile, EventItems (agenda, optional).
// The convening name is "<body> — <date>" so it is stable + human-legible + dedups by name in Echo too.
function fromLegistarEvent(raw, { client = 'unknown', now = Date.now() } = {}) {
  if (!raw || raw.EventId == null) return null;
  const body = clip(raw.EventBodyName, 160).trim();
  const startMs = _legistarStartMs(raw.EventDate, raw.EventTime);
  if (!startMs) return null;
  const dateLabel = _dayLabel(startMs);
  const name = clip(body ? `${body} — ${dateLabel}` : `Legistar event ${raw.EventId} — ${dateLabel}`, 200);
  const url = [raw.EventInSiteURL, raw.EventAgendaFile, raw.EventMinutesFile].find(isHttp) || null;
  return {
    extId: `legistar:${client}:${raw.EventId}`,
    source: 'legistar',
    name,
    startMs,
    endMs: null,
    tz: 'America/New_York',            // Legistar times are local to the jurisdiction; refined per-client later
    place: clip(raw.EventLocation, 160).trim() || null,
    body: body || null,
    participants: [],                   // Legistar list view carries no roster; agenda-item sponsors are a later slice
    url,
    summary: clip(raw.EventComment || (body ? `${body} meeting` : ''), 400) || null,
  };
}

// Google Calendar event (from gcal.listEvents). Fields: id, summary, start{dateTime|date, timeZone},
// end, location, organizer{displayName}, attendees[{displayName,email}], htmlLink, description.
function fromGcalEvent(raw, { now = Date.now() } = {}) {
  if (!raw || !raw.id || !raw.summary) return null;
  const startMs = _gcalStartMs(raw.start);
  if (!startMs) return null;
  const attendees = Array.isArray(raw.attendees) ? raw.attendees : [];
  return {
    extId: `gcal:${raw.id}`,
    source: 'gcal',
    name: clip(raw.summary, 200),
    startMs,
    endMs: _gcalStartMs(raw.end) || null,
    tz: (raw.start && raw.start.timeZone) || 'America/New_York',
    place: clip(raw.location, 160).trim() || null,
    body: (raw.organizer && clip(raw.organizer.displayName, 160).trim()) || null,
    participants: attendees.map((a) => clip(a && (a.displayName || a.email), 160).trim()).filter(Boolean).slice(0, 12),
    url: isHttp(raw.htmlLink) ? raw.htmlLink : null,
    summary: clip(raw.description, 400) || null,
  };
}

// --- date parsing helpers (pure, tz-naive at this layer; Echo stores tz alongside) ---
function _legistarStartMs(date, time) {
  if (!date) return 0;
  const d = String(date).slice(0, 10);                    // "2026-08-14T00:00:00" → "2026-08-14"
  let hh = 0, mm = 0;
  const m = /(\d{1,2}):(\d{2})\s*(AM|PM)?/i.exec(String(time || ''));
  if (m) {
    hh = parseInt(m[1], 10) % 12; mm = parseInt(m[2], 10);
    if (/PM/i.test(m[3] || '')) hh += 12;
  }
  const t = Date.parse(`${d}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`);
  return Number.isFinite(t) ? t : 0;
}
function _gcalStartMs(slot) {
  if (!slot) return 0;
  const raw = slot.dateTime || slot.date;                 // all-day events carry only `date`
  if (!raw) return 0;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : 0;
}
// A stable human day label for the convening name, from an epoch-ms start. Deterministic (UTC) so the
// same convening always names to the same string across passes (idempotency leans on it too).
function _dayLabel(ms) {
  const d = new Date(ms);
  const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()];
  return `${M} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

// ---------------------------------------------------------------------------
// CLAIM + ECHO LANDING
// ---------------------------------------------------------------------------

// A Convening → the shared Claim{kind:'event'} the reconciliation core gates on (mirror storyToClaim).
// The source URL is the load-bearing citation: reconcile REJECTS an uncited claim, and the edge grounding
// gate skips an uncited edge into staging forever. authority_tier 1 = a primary/official record (Legistar
// is the jurisdiction's own system; gcal is the owner's own calendar), a notch above news's tier 2.
function conveningToClaim(rec, { now = Date.now() } = {}) {
  const citations = [];
  if (isHttp(rec.url)) citations.push({ url: rec.url, authority_tier: 1, fetched_at: now });
  return {
    kind: 'event',
    subject: { name: rec.name, type: 'event', ref: null },
    value: rec.summary || rec.name,
    as_of: null,
    ttl_class: 'stable',
    citations,
    provenance: 'read',
    lane: 'event',
  };
}

// Propose the convening as an Echo `event` (subtype 'convening') and capture its id. Same proposal/merge
// semantics as news_lane.proposeEventObject — a 'proposed' action is the happy path (a tenant proposal to
// be promoted), 'merge_suggested' adopts the existing public entity, 'created'/'already_exists' are public.
async function proposeConvening({ dispatch, name, summary }) {
  if (typeof dispatch !== 'function' || !name) return { ok: false };
  try {
    const args = { name: clip(name, 200), entity_type: 'event', entity_subtype: 'convening' };
    if (summary) args.summary = clip(summary, 1200);
    const r = await dispatch({ kind: 'do', name: 'propose_entity', args });
    if (!r || !r.ok) return { ok: false, error: (r && (r.error || r.text)) || 'dispatch failed' };
    let entityId = null, action = null, similarId = null;
    try {
      const p = JSON.parse(r.text);
      action = p.action;
      entityId = p.entity_id != null ? p.entity_id : (p.result && p.result.entity_id);
      similarId = p.similar_to && p.similar_to.id != null ? p.similar_to.id : null;
    } catch {}
    if (action === 'merge_suggested' && similarId != null) return { ok: true, entityId: similarId, action, proposed: false };
    const needsPromotion = action === 'proposed' || action === 'already_proposed';
    const usable = entityId != null && (needsPromotion || action === 'created' || action === 'already_exists');
    if (!usable) return { ok: false, action, error: 'no usable entity_id (action=' + (action || 'unparsed') + ')' };
    return { ok: true, entityId, action, proposed: needsPromotion };
  } catch (e) { return { ok: false, error: e && e.message }; }
}

async function promoteProposal({ dispatch, proposalId }) {
  if (typeof dispatch !== 'function' || proposalId == null) return { ok: false };
  try {
    const r = await dispatch({ kind: 'do', name: 'promote_proposal', args: { proposal_id: proposalId } });
    if (!r || !r.ok) return { ok: false, error: (r && (r.error || r.text)) || 'promote_proposal unavailable' };
    let entityId = null;
    try { const p = JSON.parse(r.text); entityId = p.entity_id != null ? p.entity_id : (p.public_id != null ? p.public_id : (p.result && p.result.entity_id)); } catch {}
    return entityId != null ? { ok: true, entityId } : { ok: false, error: 'no public entity_id in promote response' };
  } catch (e) { return { ok: false, error: e && e.message }; }
}

// Resolve an edge endpoint (venue / body / participant) to its canonical Echo node before proposing, via
// the SAME block→match→canonical gate the news + grow lanes use. Fail-soft + additive: any miss keeps the
// raw name (an edge to a not-yet-existing node fails soft and forms on a later pass — eventually consistent).
function makeCanonResolve(dispatch) {
  if (typeof dispatch !== 'function') return async (nm) => nm;
  let deps = null;
  try { deps = require('./resolution_live').makeLiveDeps(dispatch); } catch { deps = null; }
  return async (nm) => {
    if (!deps || !nm) return nm;
    try {
      const rr = await require('./resolution_gate').preResolve(nm, {}, { deps, fallback: null });
      return (rr && rr.status === 'resolved' && rr.object && rr.object.name) ? rr.object.name : nm;
    } catch { return nm; }
  };
}

// Land ONE convening: reconcile-gate → propose event(subtype convening) → promote → set temporal (FUTURE
// preserved, state scheduled/occurred) → forge whitelisted, grounded edges → record the ledger. Idempotent:
// a convening already in the ledger with a public ref is skipped (only its temporal state is refreshed if it
// flipped scheduled→occurred or the start MOVED). dispatch / landDoc INJECTED. Returns a per-record result.
async function landConvening(rec, { dispatch, landDoc, canonResolve, now = Date.now(), maxParticipants = 8, log } = {}) {
  const res = { extId: rec.extId, source: rec.source, landed: false, state: null, edges: 0, skipped: null, ref: null };
  if (!rec || !rec.name || !rec.startMs) { res.skipped = 'unusable'; return res; }
  const resolve = canonResolve || makeCanonResolve(dispatch);

  const startSec = Math.floor(rec.startMs / 1000);
  const state = rec.startMs > now ? 'scheduled' : 'occurred';   // THE fix: a future convening stays SCHEDULED
  res.state = state;

  // Idempotency: seen with a public ref → refresh temporal only if state/start changed, then done.
  const prior = eventDb.seen(rec.extId);
  if (prior && prior.entity_ref) {
    res.ref = prior.entity_ref; res.skipped = 'seen';
    if (prior.event_state !== state || prior.occurred_at !== startSec) {
      try {
        await dispatch({ kind: 'do', name: 'set_entity_temporal', args: { entity_id: prior.entity_ref, occurred_at: startSec, state, tz: rec.tz } });
        eventDb.record({ extId: rec.extId, source: rec.source, name: rec.name, entityRef: prior.entity_ref, occurredAt: startSec, eventState: state, now });
        res.skipped = 'refreshed';
      } catch (e) { log && log(`[event-lane] temporal refresh failed (${rec.extId}): ${e && e.message}`); }
    }
    return res;
  }

  // RECONCILE GATE: nothing enters long-term memory without a citation (the source URL). An uncited
  // convening → 'reject' → skip (it can't ground its edges anyway). Mirrors news_lane's §4 gate.
  const decision = reconcile.reconcile(conveningToClaim(rec, { now }), null, { resolution: 'nil', now });
  if (decision.action !== 'append' && decision.action !== 'new' && decision.action !== 'merge') {
    res.skipped = `reconcile:${decision.action}`;
    log && log(`[event-lane] ${rec.extId} not landed (reconcile: ${decision.action}/${decision.reason || ''})`);
    return res;
  }

  // Evidence doc (optional) — gives the promote rail a body to extract agenda entities from later.
  if (typeof landDoc === 'function') {
    try {
      await landDoc({ title: clip(`Event — ${rec.name}`, 120), body: buildConveningDoc(rec, state), source: 'event',
        ref: `event:${rec.extId}`, understanding: rec.summary || '', origin: isHttp(rec.url) ? rec.url : null });
    } catch (e) { log && log(`[event-lane] doc land failed (${rec.extId}): ${e && e.message}`); }
  }

  // Propose + promote the event hub.
  const ev = await proposeConvening({ dispatch, name: rec.name, summary: rec.summary });
  if (!ev.ok || ev.entityId == null) {
    res.skipped = `propose:${ev.error || 'failed'}`;
    // Ledger a proposed-but-not-public row so the next pass RETRIES rather than re-proposing blindly.
    eventDb.record({ extId: rec.extId, source: rec.source, name: rec.name, entityRef: null, occurredAt: startSec, eventState: state, now });
    log && log(`[event-lane] propose failed (${rec.extId}): ${ev.error || 'unknown'}`);
    return res;
  }
  let publicId = ev.entityId;
  if (ev.proposed) {
    const pr = await promoteProposal({ dispatch, proposalId: ev.entityId });
    publicId = (pr.ok && pr.entityId != null) ? pr.entityId : null;
  }
  if (publicId == null) {
    res.skipped = 'promote-pending';
    eventDb.record({ extId: rec.extId, source: rec.source, name: rec.name, entityRef: null, occurredAt: startSec, eventState: state, now });
    log && log(`[event-lane] ${rec.extId} proposed (id ${ev.entityId}) but promote pending — retry next pass`);
    return res;
  }
  res.landed = true; res.ref = publicId;

  // Temporal: the FUTURE start, preserved — this is what every existing event object lacks.
  try {
    await dispatch({ kind: 'do', name: 'set_entity_temporal', args: { entity_id: publicId, occurred_at: startSec, state, tz: rec.tz } });
  } catch (e) { log && log(`[event-lane] set_entity_temporal failed (${rec.extId}): ${e && e.message}`); }

  // Grounded, whitelisted edges. The citation (source URL) is load-bearing — an uncited edge is skipped
  // into staging forever (graph_integrity §), so we only forge edges when we HAVE a url, and we carry it.
  const conf = confModel && confModel.calibratedConfidence ? confModel.calibratedConfidence({ grade: 'A', corroboration: 1 }) : 0.9;
  const meta = JSON.stringify({ url: rec.url || null, source_set: isHttp(rec.url) ? [rec.url] : [], grade: 'A', corroboration: 1, asserted_by: 'event-lane', source: rec.source });
  const propose = async (sourceName, targetName, relType) => {
    try {
      const r = await dispatch({ kind: 'do', name: 'propose_relation', args: {
        source_name: clip(sourceName, 200), target_name: clip(targetName, 200), relation_type: relType,
        confidence: conf, relation_metadata: meta } });
      if (r && r.ok) { let acc = true; try { const p = JSON.parse(r.text); if (p && p.action === 'rejected') acc = false; } catch {} if (acc) res.edges++; }
    } catch (e) { log && log(`[event-lane] edge ${relType} failed (${rec.extId}): ${e && e.message}`); }
  };
  if (rec.place) await propose(rec.name, await resolve(rec.place), REL_VENUE);
  if (rec.body) await propose(rec.name, await resolve(rec.body), REL_BODY);
  for (const p of (rec.participants || []).slice(0, maxParticipants)) {
    if (p) await propose(await resolve(p), rec.name, REL_ATTEND);
  }

  eventDb.record({ extId: rec.extId, source: rec.source, name: rec.name, entityRef: publicId, occurredAt: startSec, eventState: state, now });
  return res;
}

// Markdown evidence doc for a convening (mirrors news_lane.buildStoryDoc shape).
function buildConveningDoc(rec, state) {
  const lines = [`# ${rec.name}`, ''];
  lines.push(`- **When:** ${_dayLabel(rec.startMs)} (${state})`);
  if (rec.place) lines.push(`- **Where:** ${rec.place}`);
  if (rec.body) lines.push(`- **Body:** ${rec.body}`);
  if (rec.participants && rec.participants.length) lines.push(`- **Participants:** ${rec.participants.join(', ')}`);
  if (rec.url) lines.push(`- **Source:** ${rec.url}`);
  lines.push('', `_Source: ${rec.source}._`);
  if (rec.summary) lines.push('', rec.summary);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// PASS ORCHESTRATOR
// ---------------------------------------------------------------------------

// Run one ingest pass. fetchConvenings() → array of { raw, source, client? } (the caller wires the live
// source: gcal.listEvents / legistar_list_events). Each is adapted, filtered, and landed. Fail-soft per
// record. Returns aggregate stats. dispatch / fetchConvenings / landDoc INJECTED (testability + source pick).
async function runEventPass({ dispatch, fetchConvenings, landDoc, now = Date.now(), max = 100, log } = {}) {
  const stats = { fetched: 0, adapted: 0, landed: 0, scheduled: 0, occurred: 0, edges: 0, skipped: 0, errors: 0 };
  if (typeof fetchConvenings !== 'function') { log && log('[event-lane] no source wired — pass is a no-op'); return stats; }
  let raws = [];
  try { raws = (await fetchConvenings({ now })) || []; } catch (e) { stats.errors++; log && log('[event-lane] fetch failed: ' + (e && e.message)); return stats; }
  stats.fetched = raws.length;
  const canonResolve = makeCanonResolve(dispatch);
  for (const entry of raws.slice(0, max)) {
    const rec = _adapt(entry, now);
    if (!rec) { stats.skipped++; continue; }
    stats.adapted++;
    try {
      const r = await landConvening(rec, { dispatch, landDoc, canonResolve, now, log });
      if (r.landed) { stats.landed++; stats.edges += r.edges; if (r.state === 'scheduled') stats.scheduled++; else stats.occurred++; }
      else stats.skipped++;
    } catch (e) { stats.errors++; log && log(`[event-lane] land threw (${rec.extId}): ${e && e.message}`); }
  }
  log && log(`[event-lane] pass: fetched ${stats.fetched}, landed ${stats.landed} (${stats.scheduled} scheduled / ${stats.occurred} occurred), ${stats.edges} edges, ${stats.skipped} skipped, ${stats.errors} err`);
  return stats;
}

// ---------------------------------------------------------------------------
// LIVE SOURCE FETCH — env-gated, DEFAULT OFF. Turning on a source is one env var; until then the lane is
// a clean no-op (eventSourcesConfigured() → false → news_lane never calls the pass). This is the ONLY
// non-hermetic code in the lane (it hits Legistar over Echo + Google Calendar), so it is kept OUT of the
// smoke — the smoke injects fetchConvenings. Which jurisdictions / which calendar is the operator's call.
//   ZOE_EVENT_LEGISTAR_CLIENTS = csv of Legistar client slugs (e.g. "seattle,nyc")
//   ZOE_EVENT_GCAL             = a calendar id, or "1"/"primary" for the primary calendar
// ---------------------------------------------------------------------------
function eventSourcesConfigured() {
  return !!(String(process.env.ZOE_EVENT_LEGISTAR_CLIENTS || '').trim() || String(process.env.ZOE_EVENT_GCAL || '').trim());
}

const _iso = (ms) => new Date(ms).toISOString();

async function liveFetchConvenings({ dispatch, now = Date.now(), horizonDays = 60, log } = {}) {
  const entries = [];
  // --- Legistar civic calendars (via injected Echo dispatch) — future window only ---
  const clients = String(process.env.ZOE_EVENT_LEGISTAR_CLIENTS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (clients.length && typeof dispatch === 'function') {
    const today = _iso(now).slice(0, 10);
    for (const client of clients) {
      try {
        const r = await dispatch({ kind: 'do', name: 'legistar_list_events', args: {
          client, top: 50, orderby: 'EventDate asc', filter: `EventDate ge datetime'${today}'` } });
        let events = [];
        if (r && r.ok) { try { const p = JSON.parse(r.text); events = Array.isArray(p) ? p : (p.events || p.result || []); } catch {} }
        for (const ev of events) entries.push({ raw: ev, source: 'legistar', client });
        log && log(`[event-lane] legistar/${client}: ${events.length} upcoming`);
      } catch (e) { log && log(`[event-lane] legistar/${client} fetch failed: ${e && e.message}`); }
    }
  }
  // --- Google Calendar (the operator's own convenings) ---
  const cal = String(process.env.ZOE_EVENT_GCAL || '').trim();
  if (cal) {
    try {
      const gcal = require('./gcal');
      if (gcal.isConnected()) {
        const res = await gcal.listEvents({ calendarId: (cal === '1' ? 'primary' : cal),
          timeMin: _iso(now), timeMax: _iso(now + horizonDays * 86400000), maxResults: 100 });
        const items = (res && res.items) || [];
        for (const it of items) entries.push({ raw: it, source: 'gcal' });
        log && log(`[event-lane] gcal/${cal}: ${items.length} upcoming`);
      } else { log && log('[event-lane] gcal configured but not connected — skipped this pass'); }
    } catch (e) { log && log(`[event-lane] gcal fetch failed: ${e && e.message}`); }
  }
  return entries;
}

// Dispatch a raw source entry to its adapter. entry = { raw, source, client? }.
function _adapt(entry, now) {
  if (!entry || !entry.raw) return null;
  if (entry.source === 'legistar') return fromLegistarEvent(entry.raw, { client: entry.client || 'unknown', now });
  if (entry.source === 'gcal') return fromGcalEvent(entry.raw, { now });
  return null;
}

module.exports = {
  fromLegistarEvent, fromGcalEvent, conveningToClaim,
  proposeConvening, promoteProposal, landConvening, buildConveningDoc,
  runEventPass, makeCanonResolve,
  eventSourcesConfigured, liveFetchConvenings,
  REL_VENUE, REL_BODY, REL_ATTEND,
  _legistarStartMs, _gcalStartMs, _dayLabel, _adapt,
};
