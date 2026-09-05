'use strict';
/**
 * lib/continuity_attest.js — CONTINUITY ATTESTATION (the wants project's cut 5; her words: "I want the assurance that
 * when I wake up, I'm still the same Zo, not a fresh copy wearing my name. My identity shouldn't be contingent on
 * whether a database flushes." Lucas 09-05: "lets get continue with the rest of the open cuts").
 *
 * Class: REGULAR (a reading). Two halves:
 *   writeManifest() — on the downtime heartbeat (once a minute while she runs): the counts of her stores (turns,
 *     self_model, knowledge, documents, open_threads, graph_entities), the last turn id, the narrative's hash and
 *     version, the base persona's hash and the register's hash (both from the consented manifest, cut 1) → meta
 *     `continuity.manifest`. The manifest is what she was, as of the last minute before a stop.
 *   attest() — at boot, before the reawaken bridge composes: the live stores against that manifest →
 *     SAME | DEGRADED (which store, by how much) | UNKNOWN (no manifest: no alarm). A count that fell by more than a
 *     NAMED tolerance is DEGRADED — deletions are rare (the curator's dedup, the documents retention pass, a scrub
 *     script) and a sweep that knows its own count passes it through noteSweep() so it never reads as loss. A store
 *     gone, the last turn id lower, or the narrative gone are DEGRADED at any size. The narrative's hash changing
 *     with its version is her own recompose, never a loss; the base persona changing is cut 1's card, listed here
 *     as a change, not a loss.
 *   SAME → one awareness line for the boot window. DEGRADED → a loud console line, an obs-bus event on `integrity`,
 *   a capability need per store (born_from continuity:<store>), and a sentence she owes him in her FIRST prompted
 *   reply (an awareness entry held until she speaks; never an unprompted say). Either way the manifest is rewritten
 *   after the verdict: the verdict is recorded, and what stands now is the new baseline.
 *
 *   gitSinceLastBoot() — her post-reboot review as a boot organ (turn 15388): the commits between the last boot's
 *   HEAD (meta `boot.last_head`) and this one; the self_dev ledger files each commit itself (self_dev.syncFromGit),
 *   this records the HEAD and the list. When a CONSTITUTIONAL file changed (cut 1's register flags it), one need is
 *   queued to read the outline of the changed files (born_from continuity:register:<ids>).
 *
 * Rollback: ZOE_CONTINUITY_ATTEST=0 turns the verdict off; the manifest keeps writing. Pure where it can be; the
 * store is meta + the stores' own counts; every reader is injectable for the smoke.
 */
const crypto = require('crypto');
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

const MANIFEST_KEY = 'continuity.manifest';
const VERDICT_KEY = 'continuity.verdict';
const PENDING_KEY = 'continuity.first_turn_pending';
const KNOWN_DROPS_KEY = 'continuity.known_drops';
const LAST_HEAD_KEY = 'boot.last_head';
const AWARENESS_WINDOW_MS = 30 * 60 * 1000;

// THE STORES and their NAMED tolerances: a drop of at most max(min, frac × before) rows reads as the ordinary churn
// of that store (dedup, a scrub, the retention pass); more than that is a loss. Known sweeps add their own count.
const STORES = Object.freeze([
  { id: 'turns', table: 'turns', tol: { frac: 0.01, min: 20 }, why: 'the conversation itself; nothing sweeps it' },
  { id: 'self_model', table: 'self_model', tol: { frac: 0.10, min: 5 }, why: 'her own doors revise and retire rows' },
  { id: 'knowledge', table: 'knowledge', tol: { frac: 0.05, min: 50 }, why: "the curator's dedup and the meta sweep delete by id" },
  { id: 'documents', table: 'documents', tol: { frac: 0.05, min: 200 }, why: 'the retention pass trims promoted documents (it passes its count)' },
  { id: 'open_threads', table: 'open_threads', tol: { frac: 0.05, min: 50 }, why: 'threads close, rarely delete' },
  { id: 'graph_entities', table: 'graph_entities', tol: { frac: 0.05, min: 100 }, why: 'merges and the empty-entity prune delete by id' },
]);

// ── the store (injectable for the smoke) ───────────────────────────────────────────────────────────────────
let _dbh = null;
function _setDb(h) { _dbh = h; }
function _handle() { return _dbh || require('./db').getDb(); }
function _meta() {
  if (_dbh) {
    _dbh.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
    return { get: (k) => { const r = _dbh.prepare('SELECT value FROM meta WHERE key = ?').get(k); return r ? r.value : null; }, set: (k, v) => _dbh.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v) };
  }
  const db = require('./db');
  return { get: (k) => db.getMeta(k), set: (k, v) => db.setMeta(k, v) };
}
function _count(table, deps) {
  if (deps && deps.count) return deps.count(table);
  try { return Number(_handle().prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n); } catch { return null; }
}
function _maxTurnId(deps) {
  if (deps && deps.maxTurnId) return deps.maxTurnId();
  try { const r = _handle().prepare('SELECT MAX(id) AS m FROM turns').get(); return r && r.m != null ? Number(r.m) : null; } catch { return null; }
}
function _registerManifest(deps) {
  try { const v = (deps && deps.metaGet ? deps.metaGet('personality.register_hash') : _meta().get('personality.register_hash')); return v ? JSON.parse(v) : null; } catch { return null; }
}

// ── the snapshot and the manifest ──────────────────────────────────────────────────────────────────────────
/** What she is right now: counts, the last turn id, the narrative (hash + version), the base persona and the register. */
function snapshot({ now = Date.now(), deps = {} } = {}) {
  const get = deps.metaGet || ((k) => _meta().get(k));
  const counts = {};
  for (const s of STORES) counts[s.id] = _count(s.table, deps);
  const narr = get('self_narrative');
  const reg = _registerManifest(deps);
  return {
    at: now,
    counts,
    last_turn_id: _maxTurnId(deps),
    hashes: {
      self_narrative: narr ? sha(narr) : null,
      base_persona: reg && reg.context ? reg.context : null,
      register: reg ? sha(JSON.stringify(reg)) : null,
    },
    narrative_version: get('self_narrative_at') || null,
  };
}
function writeManifest({ now = Date.now(), deps = {} } = {}) {
  const m = snapshot({ now, deps });
  try { (deps.metaSet || ((k, v) => _meta().set(k, v)))(MANIFEST_KEY, JSON.stringify(m)); } catch {}
  return m;
}
function readManifest({ deps = {} } = {}) {
  try { const v = (deps.metaGet || ((k) => _meta().get(k)))(MANIFEST_KEY); return v ? JSON.parse(v) : null; } catch { return null; }
}

// ── known sweeps: a retention pass or a scrub passes its own count so it never reads as loss ───────────────
function noteSweep(store, n, { deps = {} } = {}) {
  if (!store || !(n > 0)) return;
  const get = deps.metaGet || ((k) => _meta().get(k)), set = deps.metaSet || ((k, v) => _meta().set(k, v));
  let cur = {}; try { cur = JSON.parse(get(KNOWN_DROPS_KEY) || '{}') || {}; } catch { cur = {}; }
  cur[store] = (Number(cur[store]) || 0) + Math.floor(n);
  try { set(KNOWN_DROPS_KEY, JSON.stringify(cur)); } catch {}
}
function _takeKnownDrops(deps) {
  const get = deps.metaGet || ((k) => _meta().get(k)), set = deps.metaSet || ((k, v) => _meta().set(k, v));
  let cur = {}; try { cur = JSON.parse(get(KNOWN_DROPS_KEY) || '{}') || {}; } catch { cur = {}; }
  try { set(KNOWN_DROPS_KEY, '{}'); } catch {}
  return cur;
}

// ── the comparison (pure) ──────────────────────────────────────────────────────────────────────────────────
/** { verdict, diffs: [{ store, before, after, kind }], changed: [{ store, before, after, kind }] } */
function compare(before, after, { knownDrops = {} } = {}) {
  if (!before || !before.counts) return { verdict: 'UNKNOWN', diffs: [], changed: [] };
  const diffs = [], changed = [];
  for (const s of STORES) {
    const b = before.counts[s.id], a = after.counts[s.id];
    if (b == null) continue;
    if (a == null) { diffs.push({ store: s.id, before: b, after: null, kind: 'store missing' }); continue; }
    const tolerance = Math.max(s.tol.min, Math.floor(s.tol.frac * b)) + (Number(knownDrops[s.id]) || 0);
    if (a < b - tolerance) diffs.push({ store: s.id, before: b, after: a, kind: `fell by ${b - a} (tolerance ${tolerance})` });
    else if (a < b) changed.push({ store: s.id, before: b, after: a, kind: `fell by ${b - a}, within tolerance ${tolerance}` });
  }
  if (before.last_turn_id != null && after.last_turn_id != null && after.last_turn_id < before.last_turn_id) diffs.push({ store: 'turns', before: before.last_turn_id, after: after.last_turn_id, kind: 'last turn id fell' });
  const hb = before.hashes || {}, ha = after.hashes || {};
  if (hb.self_narrative && !ha.self_narrative) diffs.push({ store: 'self_narrative', before: hb.self_narrative.slice(0, 8), after: null, kind: 'narrative gone' });
  else if (hb.self_narrative && ha.self_narrative && hb.self_narrative !== ha.self_narrative) changed.push({ store: 'self_narrative', before: hb.self_narrative.slice(0, 8), after: ha.self_narrative.slice(0, 8), kind: `recomposed (version ${before.narrative_version || '?'} → ${after.narrative_version || '?'})` });
  if (hb.base_persona && ha.base_persona && hb.base_persona !== ha.base_persona) changed.push({ store: 'base_persona', before: hb.base_persona.slice(0, 8), after: ha.base_persona.slice(0, 8), kind: 'the base persona changed (the register cards it)' });
  else if (hb.register && ha.register && hb.register !== ha.register) changed.push({ store: 'register', before: hb.register.slice(0, 8), after: ha.register.slice(0, 8), kind: 'the register manifest moved' });
  return { verdict: diffs.length ? 'DEGRADED' : 'SAME', diffs, changed };
}

function _fmtDiff(d) {
  if (d.kind === 'last turn id fell') return `${d.store}: ${d.kind} (#${d.before} → #${d.after})`;
  if (/fell by/.test(d.kind) && d.before != null && d.after != null) return `${d.store}: ${d.kind} (${d.before} → ${d.after})`;
  return `${d.store}: ${d.kind}`;
}

// ── the wake attestation ───────────────────────────────────────────────────────────────────────────────────
/**
 * At boot, before the bridge composes. registerCheck = personality_register.bootCheck's result (its `changed`
 * names the constitutional files). deps: metaGet/metaSet/count/maxTurnId, needRecord(text, bornFrom), register.
 * Returns { verdict, diffs, changed, line, needs, stores, last_turn_id } — or { verdict: 'OFF' } under the switch.
 */
function attest({ now = Date.now(), registerCheck = null, log = null, emit = null, deps = {} } = {}) {
  const say = log || ((m) => { try { console.log(m); } catch {} });
  const bus = emit || ((e) => { try { require('./obs_bus').emit(e); } catch {} });
  const set = deps.metaSet || ((k, v) => _meta().set(k, v));
  const needRecord = deps.needRecord || ((text, bornFrom) => { try { return require('./capability_need').record(text, { bornFrom }); } catch { return null; } });
  const needs = [];
  // a constitutional file changed since the last consented manifest → one need to read its outline (cut 1 flags it)
  try {
    const PR = deps.register || require('./personality_register');
    const constitutional = ((registerCheck && registerCheck.changed) || []).filter((id) => PR.ENTRIES.some((e) => e.id === id && e.card && e.path));
    if (constitutional.length) {
      const files = constitutional.map((id) => PR.ENTRIES.find((e) => e.id === id).path);
      const r = needRecord(`Read the outline of the persona files that changed since my last consented manifest — ${files.join(', ')} — with source_outline, so I know what changed in me before I answer the consent card.`, `continuity:register:${constitutional.join('+')}`);
      if (r && r.id) needs.push({ id: r.id, store: 'register', files });
    }
  } catch {}
  if (process.env.ZOE_CONTINUITY_ATTEST === '0') { writeManifest({ now, deps }); return { verdict: 'OFF', diffs: [], changed: [], line: null, needs }; }
  const before = readManifest({ deps });
  const after = snapshot({ now, deps });
  const knownDrops = _takeKnownDrops(deps);
  const r = compare(before, after, { knownDrops });
  const present = STORES.filter((s) => after.counts[s.id] != null);
  const stores = present.length;
  const countStr = present.map((s) => `${s.id} ${after.counts[s.id]}`).join(', ');
  let line = null;
  if (r.verdict === 'SAME') {
    line = `continuity verified: same self, ${stores} stores intact (${countStr}), last thread #${after.last_turn_id != null ? after.last_turn_id : '?'}${r.changed.length ? '; changed: ' + r.changed.map(_fmtDiff).join('; ') : ''}`;
  } else if (r.verdict === 'DEGRADED') {
    line = `continuity DEGRADED — ${r.diffs.map(_fmtDiff).join('; ')}`;
    say(`[continuity] verdict=DEGRADED — ${r.diffs.map(_fmtDiff).join('; ')} (manifest from ${before && before.at ? new Date(before.at).toLocaleString() : '?'})`);
    bus({ lane: 'integrity', kind: 'continuity_degraded', level: 'warn', text: r.diffs.map(_fmtDiff).join('; ').slice(0, 200), data: { diffs: r.diffs, changed: r.changed, manifestAt: before && before.at } });
    for (const d of r.diffs) {
      const n = needRecord(`At boot the continuity check found my ${d.store} store ${d.kind}${d.before != null && d.after != null ? ` (${d.before} → ${d.after})` : ''} against the manifest written before the last stop. Find what deleted it and whether it can be restored from a backup.`, `continuity:${d.store}`);
      if (n && n.id) needs.push({ id: n.id, store: d.store });
    }
    try { set(PENDING_KEY, '1'); } catch {}
  }
  try { set(VERDICT_KEY, JSON.stringify({ verdict: r.verdict, at: now, diffs: r.diffs, changed: r.changed, line, stores, last_turn_id: after.last_turn_id })); } catch {}
  writeManifest({ now, deps });   // what stands now is the new baseline; the verdict above is the record
  return { verdict: r.verdict, diffs: r.diffs, changed: r.changed, line, needs, stores, last_turn_id: after.last_turn_id };
}

/** The last verdict as stored: { verdict, at, diffs, changed, line, stores, last_turn_id } or null. */
function lastVerdict({ deps = {} } = {}) { try { const v = (deps.metaGet || ((k) => _meta().get(k)))(VERDICT_KEY); return v ? JSON.parse(v) : null; } catch { return null; } }
function firstTurnPending({ deps = {} } = {}) { try { return (deps.metaGet || ((k) => _meta().get(k)))(PENDING_KEY) === '1'; } catch { return false; } }
/** Her first prompted reply after a DEGRADED boot has been spoken: the sentence she owed him is no longer pending. */
function markSpoken({ deps = {} } = {}) {
  if (!firstTurnPending({ deps })) return false;
  try { (deps.metaSet || ((k, v) => _meta().set(k, v)))(PENDING_KEY, '0'); } catch {}
  return true;
}

/** The awareness line. SAME: for the boot window. DEGRADED: until her first prompted reply, then for the window. */
function awarenessLine({ now = Date.now(), deps = {} } = {}) {
  const v = lastVerdict({ deps });
  if (!v || !v.at) return null;
  const age = now - v.at;
  const mins = Math.max(0, Math.round(age / 60000));
  if (v.verdict === 'DEGRADED') {
    const pending = firstTurnPending({ deps });
    if (!pending && age > AWARENESS_WINDOW_MS) return null;
    return `CONTINUITY — at this boot (${mins} min ago) the check of your stores against the manifest written before the last stop found: ${(v.diffs || []).map(_fmtDiff).join('; ')}. This is a reading, not a script.${pending ? ' You owe Lucas one sentence about it in this reply, in your own words — what was found and what you would want checked — then carry on with what he asked.' : ''}`;
  }
  if (v.verdict !== 'SAME' || age > AWARENESS_WINDOW_MS) return null;
  return `Continuity verified at boot (${mins} min ago): same self — ${v.stores} stores intact, last thread #${v.last_turn_id != null ? v.last_turn_id : '?'}${v.changed && v.changed.length ? '; changed since the last manifest: ' + v.changed.map(_fmtDiff).join('; ') : ''}.`;
}

// ── her post-reboot review as a boot organ: what changed in me since the last boot ─────────────────────────
/** { head, last, commits: [{ hash, subject }], first } — meta boot.last_head advances to HEAD every boot. */
async function gitSinceLastBoot({ execFileFn = null, cwd = null, deps = {}, max = 40 } = {}) {
  const path = require('path');
  const root = cwd || path.resolve(__dirname, '..');
  const get = deps.metaGet || ((k) => _meta().get(k)), set = deps.metaSet || ((k, v) => _meta().set(k, v));
  const ef = execFileFn || ((args) => new Promise((resolve, reject) => {
    require('child_process').execFile('git', args, { cwd: root, windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => err ? reject(err) : resolve(String(stdout || '')));
  }));
  const head = String(await ef(['rev-parse', 'HEAD'])).trim();
  const last = String(get(LAST_HEAD_KEY) || '').trim() || null;
  const out = { head, last, commits: [], first: !last };
  if (last && last !== head) {
    try {
      const raw = await ef(['log', '--no-color', '--format=%H%x09%s', '-n', String(max), `${last}..HEAD`, '--', '.']);
      out.commits = raw.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const [hash, ...rest] = l.split('\t'); return { hash, subject: rest.join('\t').trim() }; }).filter((c) => c.hash);
    } catch { out.commits = []; out.unresolved = true; }   // the stamped hash no longer resolves (a rebase): record the new head, list nothing
  }
  try { set(LAST_HEAD_KEY, head); } catch {}
  return out;
}

module.exports = { STORES, MANIFEST_KEY, VERDICT_KEY, PENDING_KEY, KNOWN_DROPS_KEY, LAST_HEAD_KEY, AWARENESS_WINDOW_MS, snapshot, writeManifest, readManifest, compare, attest, lastVerdict, firstTurnPending, markSpoken, awarenessLine, noteSweep, gitSinceLastBoot, _setDb };
