/* Smoke: EVENT INGEST lane (#24) — the lane that lands REAL convenings as future-dated `event` objects.
 *
 * Guards the behavior that the 1,810 news-headline events all LACK: a convening keeps its FUTURE start
 * (occurred_at ahead of now, event_state='scheduled'), is marked entity_subtype='convening' (distinct
 * from headline events), hubs its context through ONLY whitelisted edges (LOCATED_IN / ORGANIZED_BY /
 * ATTENDED — never an off-whitelist synonym, the #31 trap), and is idempotent on the source id.
 * Pure adapters + a mocked Echo dispatch — hermetic, no I/O beyond a temp ledger db.
 * Run: node scripts/smoke_event_lane.js
 */
'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');

// Isolated ledger — set BEFORE requiring the lane (event_db reads the path at require time).
const TMP = path.join(os.tmpdir(), `smoke_event_ledger_${process.pid}.db`);
for (const p of [TMP, TMP + '-wal', TMP + '-shm']) { try { fs.unlinkSync(p); } catch {} }
process.env.EVENT_DB_PATH = TMP;

const el = require('../lib/event_lane');
const eventDb = require('../lib/event_db');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

const NOW = 1785168268000;                 // ~2026-07-27 (ms)
const DAY = 86400000;

// ── Mock Echo dispatch: records every call, returns the happy-path shapes. propose_entity → 'created'
// (already public, no promote step). Everything else ok. ─────────────────────────────────────────────
function makeDispatch() {
  const calls = [];
  let nextId = 6000;
  const dispatch = async ({ name, args }) => {
    calls.push({ name, args });
    if (name === 'propose_entity') return { ok: true, text: JSON.stringify({ action: 'created', entity_id: nextId++ }) };
    if (name === 'propose_relation') return { ok: true, text: JSON.stringify({ action: 'created' }) };
    return { ok: true, text: '{}' };
  };
  return { dispatch, calls };
}
const ID = async (n) => n;                  // identity canonResolve — keep the smoke hermetic

// ── 1. Pure adapters map source fields → canonical convening ─────────────────────────────────────────
const gcalRaw = {
  id: 'abc123', summary: 'Rainey Center strategy sync',
  start: { dateTime: '2026-08-20T14:00:00-04:00', timeZone: 'America/New_York' },
  end: { dateTime: '2026-08-20T15:00:00-04:00' },
  location: 'Rainey Center DC', organizer: { displayName: 'Rainey Center' },
  attendees: [{ displayName: 'Lucas Overby' }, { email: 'sarah@example.org' }],
  htmlLink: 'https://calendar.google.com/event?eid=abc123', description: 'Quarterly planning.',
};
const gRec = el.fromGcalEvent(gcalRaw, { now: NOW });
ok(gRec && gRec.extId === 'gcal:abc123', 'gcal adapter: stable ext id');
ok(gRec && gRec.startMs === Date.parse('2026-08-20T14:00:00-04:00'), 'gcal adapter: start parsed');
ok(gRec && gRec.place === 'Rainey Center DC' && gRec.body === 'Rainey Center', 'gcal adapter: venue + body');
ok(gRec && gRec.participants.length === 2, 'gcal adapter: attendees → participants (name or email)');
ok(gRec && el.fromGcalEvent({ id: 'x' }, { now: NOW }) === null, 'gcal adapter: no summary/start → null (fail-soft)');

const legiRaw = {
  EventId: 4242, EventBodyName: 'City Council', EventDate: '2026-09-01T00:00:00', EventTime: '6:00 PM',
  EventLocation: 'Council Chambers', EventInSiteURL: 'https://legistar.example.gov/e/4242',
};
const lRec = el.fromLegistarEvent(legiRaw, { client: 'seattle', now: NOW });
ok(lRec && lRec.extId === 'legistar:seattle:4242', 'legistar adapter: client-scoped ext id');
ok(lRec && /City Council — Sep 1, 2026/.test(lRec.name), 'legistar adapter: name = "<body> — <date>"');
ok(lRec && lRec.body === 'City Council' && lRec.place === 'Council Chambers', 'legistar adapter: body + venue');
ok(lRec && el.fromLegistarEvent({}, { now: NOW }) === null, 'legistar adapter: no EventId → null');

// ── 2. Landing a FUTURE convening — the core fix ─────────────────────────────────────────────────────
(async () => {
  const { dispatch, calls } = makeDispatch();
  const docs = [];
  const landDoc = async (d) => { docs.push(d); };
  const futureRec = el.fromGcalEvent(gcalRaw, { now: NOW });   // Aug 20 > NOW (Jul 27) → scheduled
  const r = await el.landConvening(futureRec, { dispatch, landDoc, canonResolve: ID, now: NOW });

  ok(r.landed === true, 'future convening lands');
  ok(r.state === 'scheduled', 'future convening → event_state SCHEDULED (not collapsed to occurred)');

  const propEnt = calls.find((c) => c.name === 'propose_entity');
  ok(propEnt && propEnt.args.entity_type === 'event', 'proposed as entity_type=event');
  ok(propEnt && propEnt.args.entity_subtype === 'convening', 'marked entity_subtype=convening (distinct from headline events)');

  const temporal = calls.find((c) => c.name === 'set_entity_temporal');
  ok(temporal && temporal.args.state === 'scheduled', 'set_entity_temporal state=scheduled');
  ok(temporal && temporal.args.occurred_at > Math.floor(NOW / 1000), 'occurred_at is in the FUTURE (> now)');
  ok(temporal && temporal.args.tz === 'America/New_York', 'tz carried onto the object');

  // Edges: only whitelisted types, correct direction.
  const rels = calls.filter((c) => c.name === 'propose_relation').map((c) => c.args);
  const types = new Set(rels.map((a) => a.relation_type));
  ok([...types].every((t) => t === el.REL_VENUE || t === el.REL_BODY || t === el.REL_ATTEND),
    'every edge uses a whitelisted type (LOCATED_IN / ORGANIZED_BY / ATTENDED)');
  ok(rels.some((a) => a.relation_type === 'LOCATED_IN' && a.source_name === futureRec.name && a.target_name === 'Rainey Center DC'),
    'event -LOCATED_IN-> venue');
  ok(rels.some((a) => a.relation_type === 'ORGANIZED_BY' && a.target_name === 'Rainey Center'), 'event -ORGANIZED_BY-> body');
  ok(rels.some((a) => a.relation_type === 'ATTENDED' && a.target_name === futureRec.name), 'person -ATTENDED-> event');
  ok(rels.every((a) => { try { return JSON.parse(a.relation_metadata).source_set.length > 0; } catch { return false; } }),
    'every edge carries a citation (source_set) — grounded, not staged-forever');
  ok(docs.length === 1 && docs[0].ref === `event:${futureRec.extId}`, 'evidence doc landed with event ref');

  // ── 3. Idempotency — a re-listed convening is a cheap skip, no second propose ───────────────────────
  const { dispatch: d2, calls: c2 } = makeDispatch();
  const r2 = await el.landConvening(futureRec, { dispatch: d2, landDoc, canonResolve: ID, now: NOW });
  ok(r2.skipped === 'seen', 'second land of same convening → skipped (seen in ledger)');
  ok(!c2.some((c) => c.name === 'propose_entity'), 'idempotent: no re-propose on the second pass');

  // ── 4. A PAST convening → occurred ──────────────────────────────────────────────────────────────────
  const { dispatch: d3, calls: c3 } = makeDispatch();
  const pastRec = el.fromLegistarEvent(
    { ...legiRaw, EventId: 4243, EventDate: '2026-06-01T00:00:00' }, { client: 'seattle', now: NOW });
  const r3 = await el.landConvening(pastRec, { dispatch: d3, landDoc, canonResolve: ID, now: NOW });
  ok(r3.landed && r3.state === 'occurred', 'past convening → event_state OCCURRED');
  const t3 = c3.find((c) => c.name === 'set_entity_temporal');
  ok(t3 && t3.args.occurred_at < Math.floor(NOW / 1000), 'past convening occurred_at < now');

  // ── 5. Uncited convening is refused by the reconcile gate (nothing enters long-term without a cite) ──
  const { dispatch: d4, calls: c4 } = makeDispatch();
  const uncited = { ...el.fromGcalEvent({ ...gcalRaw, id: 'nocite', htmlLink: null }, { now: NOW }) };
  const r4 = await el.landConvening(uncited, { dispatch: d4, landDoc, canonResolve: ID, now: NOW });
  ok(r4.skipped && /reconcile/.test(r4.skipped), 'uncited convening rejected by reconcile gate');
  ok(!c4.some((c) => c.name === 'propose_entity'), 'uncited convening never proposed');

  // ── 6. runEventPass end-to-end over a mixed batch ───────────────────────────────────────────────────
  const { dispatch: d5 } = makeDispatch();
  const batch = [
    { raw: { ...gcalRaw, id: 'p1' }, source: 'gcal' },
    { raw: { ...legiRaw, EventId: 9001 }, source: 'legistar', client: 'seattle' },
    { raw: { junk: true }, source: 'gcal' },                    // unusable → skipped
  ];
  const stats = await el.runEventPass({ dispatch: d5, fetchConvenings: async () => batch, landDoc, now: NOW });
  ok(stats.fetched === 3 && stats.landed === 2 && stats.scheduled === 2, 'runEventPass: 3 fetched, 2 landed, both scheduled');
  ok(stats.skipped >= 1, 'runEventPass: unusable record skipped, not landed');

  try { eventDb.close(); } catch {}
  for (const p of [TMP, TMP + '-wal', TMP + '-shm']) { try { fs.unlinkSync(p); } catch {} }
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
