/**
 * lib/cloud_curator.js — interval curation of the knowledge store (Slice 1).
 *
 * Slice 1a (this file, NO cloud): the deterministic LOCAL pre-clean the audit quantified —
 *   • QUARANTINE PRUNE — focus_tombstone rows past the spawn-gate's refractory window +
 *     reflection_speculation rows. Both are excluded from ALL recall (memory.QUARANTINE_SOURCES)
 *     yet scanned on every O(N) retrieve/dedup. Dead weight on the hot path (~26% of the store
 *     in the live audit). We keep tombstones NEWER than 2× the 24h focus refractory so the
 *     spawn-gate's "don't respawn a just-closed focus" dedup is never starved.
 *   • SELF-EVOLUTION MERGE (report-only in 1a) — cluster near-identical "my view evolved" rows
 *     (one trait re-evolved dozens of times) and collapse each cluster to its NEWEST row,
 *     preserving the RECORD that the view evolved while killing the duplication. APPLY is
 *     deferred to the cloud stage (1b): correct merging is semantic and this is her identity
 *     track, so a local cosine pass only *plans* it here.
 *
 * Safety: dry-run by default (apply=false writes nothing). DELETE is hard but scoped to rows
 * that are provably never recalled; raw provenance rows that ARE recallable are untouched.
 * The cloud stages (cluster/dedup/integrate/map) land in 1b as injected calls (offline-smoke
 * -testable like consolidate.js / graph_extract.js), so this module stays cloud-free + provable.
 */
const db = require('./db');
const memory = require('./memory');
const cloudLogic = require('./cloud_logic');

// Shared validators for the broker. relate → {same:boolean}; merge → non-empty note text.
function _validateSame(raw) {
  try {
    const m = String(raw || '').match(/\{[\s\S]*?\}/);
    if (!m) return { valid: false, error: 'no JSON object' };
    const o = JSON.parse(m[0]);
    if (typeof o.same !== 'boolean') return { valid: false, error: 'missing boolean "same"' };
    return { valid: true, value: { same: o.same } };
  } catch (e) { return { valid: false, error: e.message }; }
}
function _validateNote(raw) {
  const t = String(raw || '').trim().replace(/^["']|["']$/g, '');
  if (t.length < 3) return { valid: false, error: 'empty note' };
  return { valid: true, value: t };
}

// 2× the focus spawn-gate refractory (lib/focus.js REFRACTORY_MS = 24h). Tombstones older than
// this can no longer affect respawn decisions, so pruning them is safe.
const TOMBSTONE_SAFE_MS = 48 * 60 * 60 * 1000;
// R4: hard VOLUME cap on focus_tombstones — even within the 48h window they balloon (~1,400/day in
// the live audit). Keep only the newest this many; prune the oldest beyond it so quarantine can't
// grow unbounded and drag every O(N) retrieval. The interest model's own novelty/weighting (not the
// 24h respawn guard alone) handles re-selection, so a shorter effective window is an acceptable trade.
const TOMBSTONE_KEEP_MAX = 600;
// self_evolution rows at/above this cosine are treated as the SAME trait re-evolved (thrash).
const THRASH_SIM = 0.92;

// Job A — plan the quarantine prune. Pure read; returns the ids it would remove + a breakdown.
function planQuarantinePrune({ now = Date.now(), keepMax = TOMBSTONE_KEEP_MAX } = {}) {
  const d = db.getDb();
  const cutoff = now - TOMBSTONE_SAFE_MS;
  const staleTomb = d.prepare("SELECT id FROM knowledge WHERE source = 'focus_tombstone' AND created_ts < ?").all(cutoff);
  const spec = d.prepare("SELECT id FROM knowledge WHERE source = 'reflection_speculation'").all();
  // VOLUME CAP: of the in-window (newer than cutoff) tombstones, keep only the newest keepMax;
  // the oldest overflow is pruned regardless of age.
  const recent = d.prepare("SELECT id FROM knowledge WHERE source = 'focus_tombstone' AND created_ts >= ? ORDER BY created_ts ASC").all(cutoff);
  const overflow = recent.length > keepMax ? recent.slice(0, recent.length - keepMax) : [];
  return {
    job: 'quarantine_prune',
    pruneIds: [...staleTomb.map(r => r.id), ...spec.map(r => r.id), ...overflow.map(r => r.id)],
    detail: { stale_tombstones: staleTomb.length, speculation: spec.length, overflow_tombstones: overflow.length, kept_recent_tombstones: recent.length - overflow.length }
  };
}

// Job B — plan the self_evolution merge (report-only here). Greedy single-pass clustering by
// embedding cosine; each multi-row cluster collapses to its newest member.
function planSelfEvolutionMerge({ sim = THRASH_SIM } = {}) {
  const rows = db.getDb()
    .prepare("SELECT id, content, embedding, created_ts FROM knowledge WHERE source = 'self_evolution' AND embedding IS NOT NULL ORDER BY created_ts")
    .all();
  const vecs = rows.map(r => { try { return JSON.parse(r.embedding); } catch { return null; } });
  const used = new Array(rows.length).fill(false);
  const clusters = [];
  for (let i = 0; i < rows.length; i++) {
    if (used[i] || !vecs[i]) continue;
    const group = [i];
    used[i] = true;
    for (let j = i + 1; j < rows.length; j++) {
      if (used[j] || !vecs[j]) continue;
      if (memory.cosine(vecs[i], vecs[j]) >= sim) { group.push(j); used[j] = true; }
    }
    if (group.length > 1) {
      const members = group.map(k => rows[k]);
      const keep = members.reduce((a, b) => (b.created_ts > a.created_ts ? b : a));
      clusters.push({
        keepId: keep.id,
        dropIds: members.filter(m => m.id !== keep.id).map(m => m.id),
        size: group.length,
        sample: (keep.content || '').slice(0, 80)
      });
    }
  }
  const wouldCollapse = clusters.reduce((n, c) => n + c.dropIds.length, 0);
  return { job: 'self_evolution_merge', clusters, rows: rows.length, would_collapse: wouldCollapse };
}

// Hard-delete knowledge rows + their FTS shadows in one transaction. Returns count removed.
function _deleteKnowledge(ids) {
  if (!ids || !ids.length) return 0;
  const d = db.getDb();
  const delK = d.prepare('DELETE FROM knowledge WHERE id = ?');
  const delF = d.prepare('DELETE FROM knowledge_fts WHERE rowid = ?');
  const tx = d.transaction(() => { for (const id of ids) { delK.run(id); try { delF.run(id); } catch {} } });
  tx();
  return ids.length;
}

/**
 * The local pre-clean pass.
 *   apply=false → DRY RUN: returns the full plan, writes nothing.
 *   apply=true  → executes Job A (quarantine prune). Job B stays report-only (semantic merge → 1b).
 */
function preClean({ apply = false, now = Date.now() } = {}) {
  const quarantine = planQuarantinePrune({ now });
  const selfEvo = planSelfEvolutionMerge();
  const before = db.getDb().prepare('SELECT COUNT(*) n FROM knowledge').get().n;
  let removed = 0;
  if (apply) removed = _deleteKnowledge(quarantine.pruneIds);
  const after = apply ? db.getDb().prepare('SELECT COUNT(*) n FROM knowledge').get().n : before;
  return { apply, knowledge_before: before, knowledge_after: after, removed, quarantine, self_evolution: selfEvo };
}

// ---- Slice 1b: cloud-assisted stages --------------------------------------
// Reusable cloud-call primitive. Resolves the CLOUD tier (models.sources) + the chosen
// curator model and calls it via ollama.complete. FAIL-SAFE: returns null when the cloud
// tier or a curator model isn't configured, so every cloud stage degrades to a no-op
// (never a crash, never a wrong write) until the key + model.curator are set.
let _curatorModelCache = null;
// Resolve the curator's cloud model the same way the editor path does (lib then env), and if
// nothing's configured, auto-pick a reachable cloud model so it works out of the box. Cached.
async function _resolveCuratorModel(models, cloud) {
  if (_curatorModelCache) return _curatorModelCache;
  let m = models.getModelFor('curator', null) || models.getModelFor('editor', null)
    || (process.env.AGENT_MODEL_ON_DEMAND_BACKGROUND || '').trim() || null;
  if (!m && cloud) { try { const list = await models.listFromSource(cloud); if (list && list.length) m = list[0].name; } catch {} }
  if (m) _curatorModelCache = m;
  return m;
}

async function _cloudComplete(messages, { temperature = 0.2, num_predict = 220 } = {}) {
  let models, ollama;
  try { models = require('./models'); ollama = require('./ollama'); } catch { return null; }
  // Cloud creds are hydrated from Echo's keychain at app boot (main.js → keystore.hydrateFromEcho),
  // so in the running process this finds OLLAMA_API_KEY without any .env entry.
  const cloud = (models.sources() || []).find(s => s.tier === 'cloud' && s.token);
  if (!cloud) return null;
  const model = await _resolveCuratorModel(models, cloud);
  if (!model) return null;
  try {
    return await ollama.complete({
      model, messages, base: cloud.base,
      headers: cloud.token ? { Authorization: `Bearer ${cloud.token}` } : {},
      options: { temperature, top_p: 0.9, num_ctx: 8192, num_predict }
    });
  } catch (e) { console.error('[curator] cloud call failed:', e.message); return null; }
}

// Default cluster-relate: ask the cloud whether N self_evolution notes are all restatements
// of the SAME evolving view (guards against the local cosine lumping distinct traits).
// Returns { same: bool }. Fail-safe: null cloud response → { same: false } (don't merge).
async function _defaultRelate(texts) {
  const r = await cloudLogic.ask({
    task: 'relate_self_evolution', v: 1,
    input: { notes: texts },
    want: `These notes each record how an AI's self-view evolved. Are they ALL restatements of the SAME single evolving view (just reworded across time), or do they describe genuinely DIFFERENT traits? Reply with ONLY strict JSON: {"same": true} or {"same": false}.`,
    validate: _validateSame
  });
  return r || { same: false };   // fail-safe: cloud down / invalid → don't merge
}

// Default cluster-merge: consolidate N restatements into ONE current note that preserves the
// fact that the view evolved. Fail-safe: null → caller keeps the newest as-is.
async function _defaultMerge(texts) {
  return cloudLogic.ask({
    task: 'merge_self_evolution', v: 1,
    input: { notes: texts },
    want: `Combine these restatements of one evolving self-view into a SINGLE concise note (max ~45 words) that states the CURRENT view and notes it evolved. Output ONLY the note text, no preamble.`,
    validate: _validateNote
  });   // string or null (caller keeps the newest as-is on null)
}

/**
 * Collapse the self_evolution thrash. For each local cosine cluster, the cloud confirms it's
 * truly one evolving view (else skip), then consolidates it; APPLY keeps the newest row
 * (rewritten to the consolidated text + re-embedded) and deletes the redundant restatements.
 * Preserves "the view evolved" record while killing the duplication. relateFn/mergeFn/embedFn
 * injectable for offline tests. apply=false → plan only.
 */
async function selfEvolutionMerge({ apply = false, relateFn = _defaultRelate, mergeFn = _defaultMerge, embedFn = null, maxClusters = null } = {}) {
  let { clusters } = planSelfEvolutionMerge();
  if (maxClusters != null) clusters = clusters.slice(0, maxClusters);
  const embed = embedFn || ((t) => require('./memory').embed(t));
  const results = [];
  let collapsed = 0;
  for (const c of clusters) {
    const rows = db.getKnowledgeByIds([c.keepId, ...c.dropIds]);
    const keepRow = rows.find(r => r.id === c.keepId);
    const texts = rows.map(r => r.content);
    let rel; try { rel = await relateFn(texts); } catch { rel = { same: false }; }
    if (!rel || !rel.same) { results.push({ keepId: c.keepId, size: c.size, action: 'skip-distinct' }); continue; }
    let merged; try { merged = await mergeFn(texts); } catch { merged = null; }
    merged = (merged && String(merged).trim()) || (keepRow && keepRow.content) || texts[0];
    if (apply) {
      let emb = null; try { emb = JSON.stringify(await embed(merged)); } catch {}
      try { db.updateKnowledge(c.keepId, { content: merged, embedding: emb }); } catch {}
      _deleteKnowledge(c.dropIds);
      collapsed += c.dropIds.length;
    }
    results.push({ keepId: c.keepId, dropped: c.dropIds.length, action: apply ? 'merged' : 'would-merge', sample: String(merged).slice(0, 80) });
  }
  return { apply, clusters: clusters.length, collapsed, results };
}

// ---- Graph-proposal adjudication (deterministic, no cloud) ----------------
// The speculated-entity proposal queue piles up unadjudicated (80 in the live audit). A
// proposal is now resolvable two ways, deterministically:
//   • SUPERSEDED — a grounded canonical entity with the same normalized name now exists
//     (it got grounded by other means), so the speculation is redundant → reject.
//   • STALE — still no grounding after staleDays → reject as abandoned speculation.
// Everything else stays pending. apply=false → plan only.
const PROPOSAL_STALE_MS_DEFAULT = 7 * 24 * 60 * 60 * 1000;

function adjudicateGraphProposals({ apply = false, staleDays = 7, now = Date.now() } = {}) {
  const gm = require('./graph_memory');
  const cutoff = now - (staleDays * 24 * 60 * 60 * 1000);
  const pending = db.graphListPendingEntityProposals(1000);
  const superseded = [], stale = [];
  for (const p of pending) {
    const canonical = db.graphGetEntityByKey(gm.normalizeName(p.name));
    if (canonical) superseded.push(p.id);
    else if ((p.created_at || 0) < cutoff) stale.push(p.id);
  }
  if (apply) {
    for (const id of superseded) db.graphSetEntityProposalStatus(id, 'rejected');
    for (const id of stale) db.graphSetEntityProposalStatus(id, 'rejected');
  }
  return {
    apply, pending: pending.length,
    superseded: superseded.length, stale: stale.length,
    kept: pending.length - superseded.length - stale.length,
    rejected: apply ? superseded.length + stale.length : 0
  };
}

// ---- Near-duplicate KNOWLEDGE merge (cloud-assisted) ----------------------
// General notes (NOT the self_evolution identity chain, NOT quarantine, NOT topic rollups) that
// accreted past storeDeduped's 0.82 write-time prefilter. Cluster by embedding, the cloud confirms
// genuine near-duplication (not merely related), then APPLY keeps one (highest importance, then
// newest), rewrites it to the consolidated note, and deletes the rest. This is "delete the useless"
// for the capability track — where real duplicates live (unlike the identity chain, which is mostly
// distinct evolution steps and correctly skipped by selfEvolutionMerge).
const NEARDUP_SIM = 0.88;
// verified_fact(_superseded) are managed by reconcileVerifiedFacts (supersede-by-as_of), NOT by
// generic near-dup collapse — excluded here so the two stages never fight over the same rows.
const NEARDUP_EXCLUDE = ['self_evolution', 'focus_tombstone', 'reflection_speculation', 'verified_fact', 'verified_fact_superseded'];

async function _defaultFactRelate(texts) {
  const r = await cloudLogic.ask({
    task: 'relate_neardup_knowledge', v: 1,
    input: { notes: texts },
    want: `Do these notes state essentially the SAME fact/information — near-duplicates with no meaningful distinct content — or do they carry genuinely DIFFERENT information worth keeping separate? Reply with ONLY strict JSON: {"same": true} or {"same": false}.`,
    validate: _validateSame
  });
  return r || { same: false };
}
async function _defaultFactMerge(texts) {
  return cloudLogic.ask({
    task: 'merge_neardup_knowledge', v: 1,
    input: { notes: texts },
    want: `Combine these near-duplicate notes into ONE concise note (max ~50 words) that keeps every distinct fact and drops the redundancy. Output ONLY the note text, no preamble.`,
    validate: _validateNote
  });
}

async function mergeNearDupKnowledge({ apply = false, sim = NEARDUP_SIM, relateFn = _defaultFactRelate, mergeFn = _defaultFactMerge, embedFn = null, maxClusters = null, excludeSources = NEARDUP_EXCLUDE } = {}) {
  const rows = db.getDb()
    .prepare('SELECT id, content, embedding, importance, created_ts, source, level FROM knowledge WHERE embedding IS NOT NULL')
    .all()
    .filter(r => !excludeSources.includes(r.source) && r.level !== 'topic');
  const vecs = rows.map(r => { try { return JSON.parse(r.embedding); } catch { return null; } });
  const used = new Array(rows.length).fill(false);
  let clusters = [];
  for (let i = 0; i < rows.length; i++) {
    if (used[i] || !vecs[i]) continue;
    const group = [i]; used[i] = true;
    for (let j = i + 1; j < rows.length; j++) {
      if (used[j] || !vecs[j]) continue;
      if (memory.cosine(vecs[i], vecs[j]) >= sim) { group.push(j); used[j] = true; }
    }
    if (group.length > 1) {
      const members = group.map(k => rows[k]);
      const keep = members.reduce((a, b) =>
        ((b.importance || 0) > (a.importance || 0) || ((b.importance || 0) === (a.importance || 0) && b.created_ts > a.created_ts)) ? b : a);
      clusters.push({ keepId: keep.id, dropIds: members.filter(m => m.id !== keep.id).map(m => m.id), size: group.length, members });
    }
  }
  const totalClusters = clusters.length;
  if (maxClusters != null) clusters = clusters.slice(0, maxClusters);
  const embed = embedFn || ((t) => require('./memory').embed(t));
  const results = [];
  let collapsed = 0;
  for (const c of clusters) {
    const texts = c.members.map(m => m.content);
    let rel; try { rel = await relateFn(texts); } catch { rel = { same: false }; }
    if (!rel || !rel.same) { results.push({ keepId: c.keepId, size: c.size, action: 'skip-distinct' }); continue; }
    let merged; try { merged = await mergeFn(texts); } catch { merged = null; }
    const keepRow = c.members.find(m => m.id === c.keepId);
    merged = (merged && String(merged).trim()) || (keepRow && keepRow.content) || texts[0];
    if (apply) {
      let emb = null; try { emb = JSON.stringify(await embed(merged)); } catch {}
      try { db.updateKnowledge(c.keepId, { content: merged, embedding: emb }); } catch {}
      _deleteKnowledge(c.dropIds);
      collapsed += c.dropIds.length;
    }
    results.push({ keepId: c.keepId, dropped: c.dropIds.length, action: apply ? 'merged' : 'would-merge', sample: String(merged).slice(0, 80) });
  }
  return { apply, candidateRows: rows.length, totalClusters, clusters: clusters.length, collapsed, results };
}

// ---- Verified-fact reconcile (Consolidate / C) ----------------------------
// The daily pass that makes "as of" facts SELF-CORRECT. When a newer fact fills the same slot
// as an older one, the older is SUPERSEDED (Mem0 contradict→UPDATE) — flipped to
// 'verified_fact_superseded' so retrieval (which only surfaces source='verified_fact') drops it
// and its boost, while it stays addressable on disk (HippoRAG: don't delete sources). Two layers,
// both DETERMINISTIC + offline (no cloud): the facts already carry stored embeddings, so layer 2
// is nearly free. B captures; only C reconciles.
//   Layer 1 — exact subject_key slug groups → keep newest as_of, supersede the rest.
//   Layer 2 — over the layer-1 survivors, cluster by stored-embedding cosine (catches phrasing
//             drift the slug missed) → keep newest as_of, supersede the rest.
// Same-as_of genuine contradictions (two live sources disagree NOW) are LEFT live — not auto-
// resolved — and reported, so a human/cloud adjudication can decide later.
const VERIFIED_RECONCILE_SIM = 0.9;

function _provParse(row) { try { return row.provenance ? JSON.parse(row.provenance) : {}; } catch { return {}; } }

// "as of" → comparable ms. Accepts YYYY / YYYY-MM / YYYY-MM-DD; falls back to created_ts so a
// dateless fact still orders sensibly (by when she captured it).
function _asOfMs(prov, createdTs) {
  const a = prov && prov.as_of;
  if (a) {
    const norm = a.length === 4 ? a + '-01-01' : a.length === 7 ? a + '-01' : a;
    const d = Date.parse(norm);
    if (!isNaN(d)) return d;
  }
  return createdTs || 0;
}

// A fact's corroboration for the reconcile-aware tiebreak: the stored score (from lib/revise's
// provenance.corroboration), else computed from its citations, else null (legacy fact — no data).
function _corrob(row, R) {
  const prov = _provParse(row);
  if (prov.corroboration && typeof prov.corroboration === 'object') return prov.corroboration;
  const cites = Array.isArray(prov.citations) ? prov.citations : [];
  return cites.length ? R.score(cites) : null;
}

// Pick the winner of a group — RECONCILE-AWARE (Consolidate/C). Newest as_of by default (the legacy
// behavior), BUT when BOTH facts carry corroboration AND the claim is STABLE/PERMANENT, a strictly-more-
// corroborated fact beats a newer weakly-sourced one — reconcile's rule that a newer stable claim supersedes
// only if its corroboration >= the incumbent's, so a fresh single read can't overturn a well-corroborated
// durable fact. VOLATILE stays recency-led (a current office/role turns over — freshest wins) and LEGACY
// facts with no corroboration fall through to pure recency, so the existing consolidation is unchanged.
// Returns {keep, drop[]}.
function _pickWinner(group) {
  let R = null; try { R = require('./reconcile'); } catch {}
  const beats = (cand, keep) => {
    if (R) {
      const cc = _corrob(cand, R), kc = _corrob(keep, R);
      if (cc && kc && R.classifyTtl(String(keep.content || '')) !== 'volatile') {
        const candStronger = R._corrobAtLeast(cc, kc) && !R._corrobAtLeast(kc, cc);
        const keepStronger = R._corrobAtLeast(kc, cc) && !R._corrobAtLeast(cc, kc);
        if (candStronger) return true;
        if (keepStronger) return false;   // more-corroborated incumbent holds against a newer weak claim
      }
    }
    const cm = _asOfMs(_provParse(cand), cand.created_ts), km = _asOfMs(_provParse(keep), keep.created_ts);
    if (cm !== km) return cm > km;
    return (cand.created_ts || 0) > (keep.created_ts || 0);
  };
  const keep = group.reduce((a, b) => (beats(b, a) ? b : a));
  return { keep, drop: group.filter(r => r.id !== keep.id) };
}

async function reconcileVerifiedFacts({ apply = false, sim = VERIFIED_RECONCILE_SIM } = {}) {
  const rows = db.getDb()
    .prepare("SELECT id, content, embedding, provenance, created_ts FROM knowledge WHERE source = 'verified_fact'")
    .all();
  const live = rows.length;
  const supersededPlan = [];     // [{ dropId, winnerId }]
  const contradictions = [];     // same-slot, same as_of, both kept

  // Layer 1 — exact subject_key groups.
  const byKey = new Map();
  const survivors = [];
  for (const r of rows) {
    const key = _provParse(r).subject_key;
    if (!key) { survivors.push(r); continue; }
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(r);
  }
  for (const [, group] of byKey) {
    if (group.length === 1) { survivors.push(group[0]); continue; }
    const { keep, drop } = _pickWinner(group);
    survivors.push(keep);
    const keepMs = _asOfMs(_provParse(keep), keep.created_ts);
    for (const d of drop) {
      if (_asOfMs(_provParse(d), d.created_ts) === keepMs) { contradictions.push({ a: keep.id, b: d.id }); continue; }
      supersededPlan.push({ dropId: d.id, winnerId: keep.id });
    }
  }

  // Layer 2 — semantic backstop over the survivors (reuse stored embeddings; greedy single pass).
  const supersededIds = new Set(supersededPlan.map(p => p.dropId));
  const sv = survivors.filter(r => !supersededIds.has(r.id));
  const vecs = sv.map(r => { try { return JSON.parse(r.embedding); } catch { return null; } });
  const used = new Array(sv.length).fill(false);
  for (let i = 0; i < sv.length; i++) {
    if (used[i] || !vecs[i]) continue;
    const group = [sv[i]]; used[i] = true;
    for (let j = i + 1; j < sv.length; j++) {
      if (used[j] || !vecs[j]) continue;
      if (memory.cosine(vecs[i], vecs[j]) >= sim) { group.push(sv[j]); used[j] = true; }
    }
    if (group.length < 2) continue;
    const { keep, drop } = _pickWinner(group);
    const keepMs = _asOfMs(_provParse(keep), keep.created_ts);
    for (const d of drop) {
      if (_asOfMs(_provParse(d), d.created_ts) === keepMs) { contradictions.push({ a: keep.id, b: d.id }); continue; }
      supersededPlan.push({ dropId: d.id, winnerId: keep.id });
    }
  }

  let superseded = 0;
  if (apply) {
    const now = Date.now();
    for (const { dropId, winnerId } of supersededPlan) {
      const row = db.getKnowledgeByIds([dropId])[0];
      if (!row) continue;
      const np = Object.assign({}, _provParse(row), { superseded_by: winnerId, superseded_ts: now });
      try { db.setKnowledgeSource(dropId, 'verified_fact_superseded', np); superseded++; } catch {}
    }
  }

  return {
    apply, live,
    superseded, wouldSupersede: supersededPlan.length,
    contradictions: contradictions.length
  };
}

// ---- The daily orchestrator -----------------------------------------------
// Runs the proven stages in sequence: deterministic quarantine prune → cloud near-dup merge →
// cloud self-evolution merge (conservative) → deterministic graph adjudication. Each stage is
// isolated in try/catch so one failure can't abort the pass; cloud stages fail-safe to no-ops
// when the cloud tier is unreachable. relateFn/mergeFn/embedFn injectable for offline tests
// (omit in production → each stage uses its own cloud default). Returns a per-stage summary.
async function runDailyPass({ apply = false, relateFn = null, mergeFn = null, embedFn = null, onLog = () => {} } = {}) {
  const inj = {};
  if (relateFn) inj.relateFn = relateFn;
  if (mergeFn) inj.mergeFn = mergeFn;
  if (embedFn) inj.embedFn = embedFn;
  const out = { apply, stages: {} };

  try {
    const r = preClean({ apply });
    out.stages.quarantine = { removed: r.removed, planned: r.quarantine.pruneIds.length };
    onLog(`quarantine: ${apply ? r.removed + ' pruned' : r.quarantine.pruneIds.length + ' would prune'}`);
  } catch (e) { out.stages.quarantine = { error: e.message }; onLog(`quarantine FAILED: ${e.message}`); }

  try {
    const r = await reconcileVerifiedFacts({ apply });
    out.stages.verified = { superseded: r.superseded, wouldSupersede: r.wouldSupersede, live: r.live, contradictions: r.contradictions };
    onLog(`verified: ${apply ? r.superseded + ' superseded' : r.wouldSupersede + ' would supersede'} of ${r.live} facts${r.contradictions ? ` (${r.contradictions} live contradictions kept)` : ''}`);
  } catch (e) { out.stages.verified = { error: e.message }; onLog(`verified FAILED: ${e.message}`); }

  // AUTONOMY STAGES FIRST (budget priority): interests reweight + meta pass are cheap (~10 cloud
  // calls) and ARE the point of the nightly run, so they run BEFORE the cloud-heavy curation merges
  // (near-dup/self-evo can burn dozens of calls). If the daily cloud budget exhausts, curation just
  // does less that night — the agenda + depth work still happens.
  try {
    const interests = require('./interests');
    const r = await interests.reweight({ apply, embedFn: inj.embedFn });
    out.stages.interests = { reweighted: r.reweighted, emergent: (r.emergent || []).length };
    onLog(`interests: ${apply ? r.reweighted + ' reweighted' : r.interests + ' (plan)'}${r.emergent && r.emergent.length ? `, +${r.emergent.length} emergent` : ''}`);
  } catch (e) { out.stages.interests = { error: e.message }; onLog(`interests FAILED: ${e.message}`); }

  try {
    const meta = require('./meta');
    const r = await meta.runMetaPass({ apply, deps: { embedFn: inj.embedFn } });
    const created = (r.perInterest || []).reduce((n, p) => n + (p.created || 0), 0);
    const closed = (r.perInterest || []).reduce((n, p) => n + (p.closed || 0), 0);
    out.stages.meta = { interests: r.interests, gapsCreated: created, gapsClosed: closed };
    onLog(`meta: ${r.interests} interests, +${created} gap-questions, ${closed} closed`);
  } catch (e) { out.stages.meta = { error: e.message }; onLog(`meta FAILED: ${e.message}`); }

  const _wouldDrop = (results) => (results || []).filter(x => x.action === 'would-merge').reduce((n, x) => n + (x.dropped || 0), 0);
  try {
    const r = await mergeNearDupKnowledge({ apply, maxClusters: 12, ...inj });   // bound per-pass cloud spend
    const wouldCollapse = _wouldDrop(r.results);
    out.stages.nearDup = { collapsed: r.collapsed, wouldCollapse, clusters: r.totalClusters };
    onLog(`near-dup: ${apply ? r.collapsed + ' collapsed' : wouldCollapse + ' would collapse'} of ${r.totalClusters} clusters`);
  } catch (e) { out.stages.nearDup = { error: e.message }; onLog(`near-dup FAILED: ${e.message}`); }

  try {
    const r = await selfEvolutionMerge({ apply, maxClusters: 12, ...inj });   // bound per-pass cloud spend
    const wouldCollapse = _wouldDrop(r.results);
    out.stages.selfEvo = { collapsed: r.collapsed, wouldCollapse, clusters: r.clusters };
    onLog(`self-evo: ${apply ? r.collapsed + ' collapsed' : wouldCollapse + ' would collapse'} of ${r.clusters} clusters`);
  } catch (e) { out.stages.selfEvo = { error: e.message }; onLog(`self-evo FAILED: ${e.message}`); }

  try {
    const r = adjudicateGraphProposals({ apply });
    out.stages.graph = { rejected: r.rejected, pending: r.pending };
    onLog(`graph: ${apply ? r.rejected + ' rejected' : '0 actionable'} of ${r.pending} pending`);
  } catch (e) { out.stages.graph = { error: e.message }; onLog(`graph FAILED: ${e.message}`); }

  return out;
}

module.exports = {
  preClean, planQuarantinePrune, planSelfEvolutionMerge, selfEvolutionMerge,
  adjudicateGraphProposals, mergeNearDupKnowledge, reconcileVerifiedFacts, runDailyPass,
  _deleteKnowledge, _cloudComplete, TOMBSTONE_SAFE_MS, TOMBSTONE_KEEP_MAX, THRASH_SIM, PROPOSAL_STALE_MS_DEFAULT, NEARDUP_SIM, VERIFIED_RECONCILE_SIM
};
