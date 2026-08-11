'use strict';
/* local_roster.js — Spine 3 leaf-fill (docs/DELIVERY_BINDING_SPINE.md).
 *
 * The frame (lib/local_frame) enumerates a state's localities top-down; this turns each one into a bounded
 * research task on the metabolism worklist. It does NOT run a new research engine — it PRODUCES recheck-queue
 * items (kind 'local-roster'), and the proven consumer (main.js metabolism → runCloudOperator → recheck_queue
 * buildPrompt/applyOutcome → civic_store) drains them: research the governing body top-down, scoped by R3
 * (the right body, not a row office), record the roster under a LOCALITY-scoped body title.
 *
 * The frame's `count` is the independent denominator; coverage() measures filled/count honestly against it.
 * Pure/injectable — the recheck queue + frame are injected so this is offline-testable without a live drain.
 * Run: node scripts/smoke_local_roster.js */

const localFrame = require('./local_frame');

// The locality-scoped body title — the parish/county name is IN the title, so civic_store's body_key is
// distinct per locality (avoids the "every Police Jury collapses to one key" trap). The research may correct
// the body name; this is the hypothesis title the task carries.
function bodyTitle(locality) {
  const name = String((locality && locality.name) || '').trim();
  const body = String((locality && locality.body) || '').trim();
  if (!name) return body || '';
  // if the hypothesis body already names the locality (e.g. "New Orleans City Council"), keep it; else qualify
  if (body && new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+Parish$|\s+County$/i, ''), 'i').test(body)) return body;
  return body ? `${name} ${body}` : `${name} governing body`;
}

// Enqueue a state's localities as local-roster research tasks. Deduped by the locality-scoped subject, so a
// re-run coalesces (never floods). Returns { state, denominator, enqueued, existing, subjects }.
function enqueueState(stateCode, { limit = null, priority = 5, frame = null, rq = null, now = Date.now() } = {}) {
  const _rq = rq || require('./recheck_queue');
  const f = frame || localFrame.buildFrame(stateCode);
  const localities = limit ? f.localities.slice(0, limit) : f.localities;
  let enqueued = 0, existing = 0;
  const subjects = [];
  for (const loc of localities) {
    const subject = bodyTitle(loc);
    if (!subject) continue;
    const r = _rq.enqueue({
      kind: 'local-roster',
      subject,
      detail: {
        body: loc.body, govSource: loc.govSource, bodyKinds: loc.bodyKinds, exclude: loc.exclude,
        state: loc.state, place: loc.name, fips: loc.fips,
        predicate: `${loc.body || 'governing body'} roster`,   // roster-shaped, for any generic consumer paths
      },
      priority, bornFrom: 'local-roster-fill', now,
    });
    if (r && r.ok) { subjects.push(subject); if (r.existing) existing++; else enqueued++; }
  }
  return { state: f.state, denominator: f.count, enqueued, existing, subjects };
}

// Honest coverage against the INDEPENDENT denominator (the frame count), not against whatever was found.
// filled = localities whose governing body has ≥1 recorded member in the civic store. Injectable memberOf().
function coverage(stateCode, { frame = null, memberOf = null } = {}) {
  const f = frame || localFrame.buildFrame(stateCode);
  const has = memberOf || ((title) => {
    try { const civ = require('./civic_store'); const b = civ.getBody(title); if (!b) return false;
      const d = require('./db').getDb(); return d.prepare(`SELECT 1 FROM civic_memberships WHERE body_key = ? AND superseded_by IS NULL LIMIT 1`).get(b.body_key) != null;
    } catch { return false; }
  });
  let filled = 0;
  for (const loc of f.localities) { if (has(bodyTitle(loc))) filled++; }
  return { state: f.state, denominator: f.count, filled, remaining: f.count - filled, pct: f.count ? Math.round((filled / f.count) * 100) : 0 };
}

// Assemble the CURRENT roster deliverable rows from the frame + whatever the civic store already holds —
// coverage-HONEST: a verified locality shows its real body/officer/contacts; an unfilled one shows
// "(researching)"/queued, NEVER a blank faked as complete. Injectable (civ/db) for offline testing.
// → { state, denominator, filled, rows:[{Parish, 'Governing Body', 'Presiding Officer', Members, Email, Phone, Status}] }
function assembleDeliverable(stateCode, { frame = null, deps = {} } = {}) {
  const f = frame || localFrame.buildFrame(stateCode);
  const civ = deps.civ || require('./civic_store');
  const getMembers = deps.getMembers || ((bodyKey) => {
    try { return require('./db').getDb().prepare(`SELECT person_name, role, email, phone FROM civic_memberships WHERE body_key = ? AND superseded_by IS NULL`).all(bodyKey); } catch { return []; }
  });
  const rows = f.localities.map((loc) => {
    const title = bodyTitle(loc);
    let members = [];
    try { const b = civ.getBody(title); if (b) members = getMembers(b.body_key) || []; } catch {}
    const presiding = members.find((m) => /presid|president|chair|mayor/i.test(str(m.role))) || members[0] || null;
    const verified = members.length > 0;
    return {
      Parish: loc.name,
      'Governing Body': loc.body || '(governing body)',
      'Presiding Officer': presiding ? presiding.person_name : '(researching)',
      Members: verified ? members.length : '',
      Email: (presiding && presiding.email) || '',
      Phone: (presiding && presiding.phone) || '',
      Status: verified ? 'verified' : 'queued',
    };
  });
  return { state: f.state, denominator: f.count, filled: rows.filter((r) => r.Status === 'verified').length, rows };
}
const str = (v) => (v == null ? '' : String(v));

// R4 — the OPEN local-roster tasks for ONE state (the door already enqueued them via enqueueState). Filters
// the recheck queue's open local-roster items by their detail.state, so a swarm drains EXACTLY one state's
// leaf-fill. Injectable rq for offline testing. Returns the recheck items (detail already hydrated).
function openTasks(stateCode, { rq = null, limit = 1000 } = {}) {
  const _rq = rq || require('./recheck_queue');
  const code = String(stateCode || '').toUpperCase();
  const all = _rq.openByKind({ kind: 'local-roster', limit }) || [];
  if (!code) return all;
  return all.filter((it) => String((it && it.detail && it.detail.state) || '').toUpperCase() === code);
}

// R4 — the SWARM DRAIN: run runTask(item) over `tasks` with at most `workers` in flight (a bounded pool), so a
// directed completion converges ~workers× faster than the serial metabolism (cap 12/h) WITHOUT firing all N
// model calls at once. Pure control flow — runTask is INJECTED (real = buildPrompt→runCloudOperator→
// applyOutcome; test = a mock), so this is offline-testable. Fail-SOFT per task: one task throwing never sinks
// the pool. onResult(r, i) fires as each task lands (for live coverage re-assembly). Returns
// [{item, ok, result|error}] in task order. This is the parallel analog of the metabolism's serial drain — the
// SAME per-task contract (buildPrompt is R3-scoped; applyOutcome writes civic_store), just fanned out.
async function drainSwarm({ tasks = [], workers = 2, runTask, onResult = null } = {}) {
  const list = Array.isArray(tasks) ? tasks.slice() : [];
  if (typeof runTask !== 'function' || !list.length) return [];
  const K = Math.max(1, Math.min(Math.floor(workers) || 1, list.length));
  const results = new Array(list.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= list.length) return;
      let r;
      try { r = { item: list[i], ok: true, result: await runTask(list[i], i) }; }
      catch (e) { r = { item: list[i], ok: false, error: (e && e.message) || String(e) }; }
      results[i] = r;
      if (typeof onResult === 'function') { try { onResult(r, i); } catch { /* a callback throw must not sink the pool */ } }
    }
  };
  await Promise.all(Array.from({ length: K }, () => worker()));
  return results;
}

// R2 — the serve-vs-rebuild TRUST GATE (pure). A roster BUILD request when a held product already exists:
// SERVE the held sheet if it's still current, REBUILD if it's stale, gone, or coverage has GROWN since it was
// built (the swarm/metabolism filled more localities → the held sheet is now behind). The denominator is
// ALWAYS the independent frame count — never the found count — so `held.filled`/`currentFilled` are both
// measured against the same frame. held = { ts, filled } | null; currentFilled = the civic store's verified
// count NOW. Returns { action:'serve'|'rebuild', reason }. Runtime glue (meta read/write, fs.existsSync) lives
// in main.js's buildLocalRosterDeliverable; this is the offline-testable decision core.
function decideServeOrRebuild({ held = null, currentFilled = 0, now = Date.now(), ttlMs = 6 * 3600 * 1000 } = {}) {
  if (!held || held.ts == null) return { action: 'rebuild', reason: 'none-held' };
  if ((currentFilled | 0) > (held.filled | 0)) return { action: 'rebuild', reason: 'coverage-improved' };
  if ((now - held.ts) >= ttlMs) return { action: 'rebuild', reason: 'stale' };
  return { action: 'serve', reason: 'fresh' };
}

module.exports = { enqueueState, coverage, assembleDeliverable, bodyTitle, openTasks, drainSwarm, decideServeOrRebuild };
