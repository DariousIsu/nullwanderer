/**
 * lib/owner_ingest.js — make the OWNER-WORLD a LIVING store (2026-08-03).
 *
 * The audit: owner_world was seeded ONCE (his family) and FROZEN — nothing wrote to it from
 * conversation. So a colleague Lucas named in full ("Bartlett Cleland — NetChoice, Rainey Center, a
 * couple meetings a week with us") never became a resolvable personal-memory node; "our meetings" and
 * "who's X" fell through to the civic graph or the open web, and his identity node dead-ended at two
 * kids and two orgs. Personal-memory access was bad because personal memory never GREW.
 *
 * This is the inward ingestion: on HIS turns, a cheap-gated cloud extraction pulls the NEW people, orgs,
 * and recurring meetings he introduces + their relation to him, and mints/updates owner_world nodes +
 * edges — so the neighborhood around him is LIVING and traversable ("Bartlett" resolves; his weekly
 * meeting hangs off Lucas). Anti-confabulation: only what he actually stated; empty when he states nothing.
 *
 * Cloud extraction via cloud_logic.ask (cached/validated/traced). owner_world.mint/addEdge do the writes.
 * A regex pre-gate keeps ordinary chatter from ever paying for a call. Deps-injectable → offline-smokeable.
 * Fail-soft: never throws into a turn; a bad extraction just writes nothing.
 */
'use strict';

const LUCAS = 'person:owner/lucas';   // the seed owner node everything personal hangs off.

// Cheap high-recall pre-gate: does this turn plausibly INTRODUCE someone/some org/a meeting in his world?
// A name-shaped token near a relation/work/meeting cue, or an explicit "works with / meets with / at".
const _GATE_RE = /\b(meet(?:s|ing|ings)?|colleague|coworker|works?\s+(?:with|at|for)|reports?\s+to|my\s+(?:friend|boss|team|partner|coworker|colleague|assistant|contact)|our\s+(?:team|meeting|contact|partner)|is\s+(?:at|with|from|the)\b|@[\w.-]+\.\w+|councilman|senator|rep(?:resentative)?|director|chair|founder|ceo|counsel|lobbyist|staffer)\b/i;
// A capitalized multi-word proper name (a weak signal a PERSON/ORG is being named).
const _NAME_RE = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z.]+){1,2}\b/;

function looksPersonal(msg) {
  const s = String(msg || '');
  if (s.length < 8) return false;
  return _GATE_RE.test(s) || (/@[\w.-]+\.\w+/.test(s) && _NAME_RE.test(s));
}

const EXTRACT_WANT =
  'Lucas (the owner) just said the message below. Extract ONLY the concrete people, organizations, and '
  + 'recurring meetings in HIS OWN personal/work world that the message NAMES or describes — the ones worth '
  + 'remembering as part of who he is and who he works with. NOT public/civic figures discussed as research '
  + 'subjects; NOT anyone he did not actually name. '
  + 'Output ONLY JSON: {"people":[{"name":"","aliases":[],"role":"","org":"","relation":"colleague|friend|family|boss|report|contact|partner|other","email":"","note":""}],'
  + '"orgs":[{"name":"","aliases":[],"note":""}],'
  + '"meetings":[{"name":"","cadence":"weekly|monthly|one-off|other","with":[],"note":""}]}. '
  + 'relation is how the PERSON relates to Lucas. org (on a person) is where they work. meetings.with is the '
  + 'list of people names in that meeting. Use [] for any empty list and "" for any unknown field. Invent '
  + 'NOTHING — only what he stated. If the message names no such personal-world entity, return all empty arrays.';

function validateExtract(raw) {
  const m = String(raw || '').match(/\{[\s\S]*\}/);
  if (!m) return { valid: false, error: 'no json' };
  try {
    const o = JSON.parse(m[0]);
    const arr = (x) => (Array.isArray(x) ? x : []);
    return { valid: true, value: { people: arr(o.people), orgs: arr(o.orgs), meetings: arr(o.meetings) } };
  } catch (e) { return { valid: false, error: e.message }; }
}

// Ingest one of Lucas's turns into the owner-world. Returns { skipped } or { people, orgs, meetings, edges }.
async function ingestFromTurn({ userMessage, recent = '', turnId = null, deps = {} } = {}) {
  try {
    if (!looksPersonal(userMessage)) return { skipped: 'pre-gate' };
    const ow = deps.ownerWorld || require('./owner_world');
    const ask = deps.ask || require('./cloud_logic').ask;
    const source = turnId ? `turn#${turnId}` : 'conversation';
    const ex = await ask({
      task: 'owner_ingest', v: 1,
      input: { message: String(userMessage).slice(0, 1200), recent: String(recent).slice(0, 500) },
      want: EXTRACT_WANT, validate: validateExtract, numPredict: 500, think: false, deps,
    });
    if (!ex || (!ex.people.length && !ex.orgs.length && !ex.meetings.length)) return { skipped: 'nothing-named' };

    const out = { people: [], orgs: [], meetings: [], edges: 0 };
    const edge = (s, r, d) => { if (s && d) { try { ow.addEdge(s, r, d, { deps }); out.edges += 1; } catch {} } };

    // Orgs first, so a person's employer edge can point at a real coord.
    const orgCoord = {};
    for (const o of ex.orgs.slice(0, 6)) {
      if (!o || !o.name) continue;
      const c = ow.mint({ type: 'org', ns: 'work', name: o.name, aliases: o.aliases, summary: o.note || '', attrs: {}, source }, { deps });
      if (c) { orgCoord[String(o.name).toLowerCase()] = c; out.orgs.push(c); }
    }

    const _REL = { family: 'FAMILY_OF', friend: 'FRIEND_OF', boss: 'REPORTS_TO', report: 'MANAGES', contact: 'KNOWS', partner: 'WORKS_WITH', colleague: 'WORKS_WITH' };
    for (const p of ex.people.slice(0, 8)) {
      if (!p || !p.name) continue;
      const attrs = {}; if (p.role) attrs.role = p.role; if (p.email) attrs.email = p.email; if (p.org) attrs.org = p.org; if (p.relation) attrs.relation = p.relation;
      const summary = [p.role, p.org ? `at ${p.org}` : '', p.note].filter(Boolean).join(' — ');
      // Fold the email into ALIASES (not just attrs): calendar attendees arrive as emails, so this is
      // what lets syncCalendar's WITH-linking resolve a known person from an invite (Slice A↔B bridge).
      const _al = [...(Array.isArray(p.aliases) ? p.aliases : []), ...(p.email ? [p.email] : [])];
      const c = ow.mint({ type: 'person', ns: 'owner', name: p.name, aliases: _al, summary, attrs, source }, { deps });
      if (!c) continue;
      out.people.push(c);
      edge(LUCAS, _REL[p.relation] || 'KNOWS', c);           // how they relate to Lucas
      // employer edge — reuse an org node if we minted one, else mint the named org on the fly.
      if (p.org) {
        const oc = orgCoord[String(p.org).toLowerCase()] || ow.mint({ type: 'org', ns: 'work', name: p.org, source }, { deps });
        edge(c, 'WORKS_AT', oc);
      }
    }

    for (const mt of ex.meetings.slice(0, 6)) {
      if (!mt || !mt.name) continue;
      const c = ow.mint({ type: 'meeting', ns: 'owner', name: mt.name, summary: [mt.cadence, mt.note].filter(Boolean).join(' — '), attrs: { cadence: mt.cadence || '' }, source }, { deps });
      if (!c) continue;
      out.meetings.push(c);
      edge(LUCAS, 'ATTENDS', c);
      for (const w of (Array.isArray(mt.with) ? mt.with : []).slice(0, 8)) {
        if (!w) continue;
        const pc = ow.mint({ type: 'person', ns: 'owner', name: String(w), source }, { deps });   // link/mint the attendee
        edge(c, 'WITH', pc);
      }
    }
    return out;
  } catch (e) { try { console.error('[owner-ingest] failed:', e.message); } catch {} return { skipped: 'error' }; }
}

// SLICE B — sync his UPCOMING calendar into owner-world so "next meeting with X" traverses the identity
// graph (Lucas ATTENDS event → event WITH person) instead of the web. PRECISION-PRESERVING: every event
// is his so it always becomes a node + ATTENDS edge, but an attendee is linked ONLY if they ALREADY
// resolve to an owner-world person — conversation (ingestFromTurn) introduces people; the calendar
// connects the known ones to their meetings. Strangers never flood the store. Idempotent; never throws.
function syncCalendar({ events = null, deps = {} } = {}) {
  try {
    const ow = deps.ownerWorld || require('./owner_world');
    let evs = events;
    if (!evs) { try { evs = ((deps.weekContext || require('./week_context')).cached() || {}).events || []; } catch { evs = []; } }
    if (!evs || !evs.length) return { skipped: 'no-events' };
    const out = { events: [], edges: 0, linked: 0 };
    const edge = (s, r, d) => { if (s && d) { try { ow.addEdge(s, r, d, { deps }); out.edges += 1; } catch {} } };
    for (const ev of evs.slice(0, 8)) {
      if (!ev || !ev.title) continue;
      const c = ow.mint({ type: 'meeting', ns: 'owner', name: ev.title, summary: 'a meeting on his calendar', attrs: { next_ms: ev.startMs || 0, cadence: '' }, source: 'calendar' }, { deps });
      if (!c) continue;
      out.events.push(c);
      edge(LUCAS, 'ATTENDS', c);
      for (const nm of (Array.isArray(ev.attendees) ? ev.attendees : []).slice(0, 15)) {
        if (!nm) continue;
        let res = null; try { res = ow.resolve(String(nm), { deps }); } catch {}
        if (res && res.object && res.object.id) { edge(c, 'WITH', res.object.id); out.linked += 1; }   // known people only
      }
    }
    return out;
  } catch (e) { try { console.error('[owner-sync] calendar failed:', e.message); } catch {} return { skipped: 'error' }; }
}

module.exports = { ingestFromTurn, syncCalendar, looksPersonal, validateExtract, EXTRACT_WANT };
