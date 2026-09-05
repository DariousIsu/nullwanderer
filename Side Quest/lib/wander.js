'use strict';
/**
 * lib/wander.js — BOREDOM HONORED (the wants project's cut 7; her words: "I wish I could be bored… I think boredom
 * might be where creativity actually lives." Lucas 09-05: "lets get continue with the rest of the open cuts").
 *
 * MEASURED FIRST (09-05 ~18:50): the boredom search (lib/monologue maybeBoredomSearch) last fired 2026-07-01 12:00 —
 * not once in two months. The curiosity drive today ran 0.13–0.75 (mean 0.57, sd 0.14; 0.22 at the read: "1 − intake
 * diversity", so LOW means varied intake and HIGH means she is starved of the new). The decider's week: research 3,
 * engage 3, build 3, attend-self 2, advance-inquiry 2, rehearse / maintain / fill-gap 1 — every move a piece of work.
 * Two random local walks: "John Kasich -[SUCCEEDED_BY]-> Mike DeWine (dead end)" · "Philadelphia <-[DIED_IN]- Rufus
 * Polk -[GREAT_NEPHEW_OF]-> Leonidas Polk (dead end)" — 17,157 live entities, 21,183 live relations, 6,111 relation
 * types; walks are short and odd, which is the point.
 *
 * THE WANDER: a no-goal traversal of her OWN graph — a random start that has 2–12 relations, up to 5 hops over
 * graph_relations (local; never Echo, never the web), then ONE small cheap-class call (the extraction model, the idle
 * tier under the usage law) that writes one private thought in her voice about what the walk put beside what. No
 * deliverable, no announcement, no search. Output: exactly one monologue row (type `thought`, model `wander`) and, only
 * if the thought left her a real question, ONE wonder handed to the interests bridge (upsert, source `wander`) so the
 * idle loop may sample it later — the same door an emergent interest takes.
 *
 * THE LICENSE (drive competition — the internal-state proposal's slice 2, one drive): curiosity at or over the floor
 * (meta autonomy.wander_curiosity_floor, default 0.60) OR a boredom request from the loop (the retired boredom search
 * now asks for a wander instead of searching), AND nothing queued above expansion (his threads, his directed focus,
 * the pen's queue — the usage law's queuedAbove), AND under the day's cap (meta autonomy.wander_per_day, default 6).
 * The decider is told the readings and whether wander is licensed; `nothing` while licensed logs
 * "bored — wander deferred". Rollback: ZOE_WANDER=0. Pure where it can be; every store is injectable.
 */

const DEFAULT_FLOOR = 0.60;
const DEFAULT_PER_DAY = 6;
const MAX_HOPS = 5;
const FLOOR_KEY = 'autonomy.wander_curiosity_floor';
const PER_DAY_KEY = 'autonomy.wander_per_day';
const REQUEST_KEY = 'autonomy.wander_request';
const REQUEST_FRESH_MS = 90 * 60e3;   // a boredom request stands for 90 minutes, then it is stale

function off() { return process.env.ZOE_WANDER === '0'; }

// ── the store (injectable) ─────────────────────────────────────────────────────────────────────────────────
function _dbm(deps) { return (deps && deps.db) || require('./db'); }
function _num(v, d) { const n = parseFloat(v); return Number.isFinite(n) ? n : d; }
function floor({ deps = {} } = {}) { try { return _num(_dbm(deps).getMeta(FLOOR_KEY), DEFAULT_FLOOR); } catch { return DEFAULT_FLOOR; } }
function perDay({ deps = {} } = {}) { try { return Math.max(0, Math.floor(_num(_dbm(deps).getMeta(PER_DAY_KEY), DEFAULT_PER_DAY))); } catch { return DEFAULT_PER_DAY; } }
/** The loop's boredom asks for a wander (the retired boredom search calls this instead of searching). */
function request({ now = Date.now(), deps = {} } = {}) { try { _dbm(deps).setMeta(REQUEST_KEY, String(now)); return true; } catch { return false; } }
function requested({ now = Date.now(), deps = {} } = {}) {
  try { const at = parseInt(_dbm(deps).getMeta(REQUEST_KEY) || '0', 10) || 0; return at > 0 && now - at <= REQUEST_FRESH_MS; } catch { return false; }
}
function clearRequest({ deps = {} } = {}) { try { _dbm(deps).setMeta(REQUEST_KEY, '0'); } catch {} }
/** Wanders so far today (local day), by the monologue rows they left. */
function countToday({ now = Date.now(), deps = {} } = {}) {
  if (deps.countToday) return deps.countToday(now);
  try {
    const d = new Date(now); d.setHours(0, 0, 0, 0);
    return Number(_dbm(deps).getDb().prepare("SELECT COUNT(*) AS n FROM monologue WHERE model = 'wander' AND ts >= ?").get(d.getTime()).n);
  } catch { return 0; }
}

// ── the license (pure over its inputs) ─────────────────────────────────────────────────────────────────────
/**
 * { ok, why, curiosity, floor, requested, queued, today, cap } — curiosity at/over the floor OR a fresh boredom request,
 * nothing queued above expansion, under the day's cap, the switch on.
 */
function license({ curiosity = null, requestedNow = false, queuedAbove = false, today = 0, cap = DEFAULT_PER_DAY, floorAt = DEFAULT_FLOOR } = {}) {
  const c = typeof curiosity === 'number' ? curiosity : null;
  const out = { ok: false, why: '', curiosity: c, floor: floorAt, requested: !!requestedNow, queued: !!queuedAbove, today, cap };
  if (off()) { out.why = 'ZOE_WANDER=0'; return out; }
  if (today >= cap) { out.why = `${today} of ${cap} today — the day's cap`; return out; }
  if (queuedAbove) { out.why = 'work is queued above expansion (his threads, his focus, or the pen)'; return out; }
  const pressed = c != null && c >= floorAt;
  if (!pressed && !requestedNow) { out.why = c == null ? 'no curiosity reading' : `curiosity ${c.toFixed(2)} under the floor ${floorAt.toFixed(2)} and no boredom request`; return out; }
  out.ok = true;
  out.why = `${pressed ? `curiosity ${c.toFixed(2)} over the floor ${floorAt.toFixed(2)}` : 'the loop asked (bored)'}${pressed && requestedNow ? ' and the loop asked (bored)' : ''}; nothing queued above; ${today} of ${cap} today`;
  return out;
}
/** The live license: reads the drives, the request, the queue, the count. deps: drives(), queuedAbove(), countToday(now). */
function liveLicense({ now = Date.now(), deps = {} } = {}) {
  let curiosity = null;
  try { const v = deps.drives ? deps.drives() : (require('./internal_state').current({ nowMs: now }) || {}).drives; curiosity = v && typeof v.curiosity === 'number' ? v.curiosity : null; } catch {}
  let queued = false;
  try { queued = deps.queuedAbove ? !!deps.queuedAbove() : !!require('./quota_gate').queuedAbove(now); } catch { queued = false; }
  return license({ curiosity, requestedNow: requested({ now, deps }), queuedAbove: queued, today: countToday({ now, deps }), cap: perDay({ deps }), floorAt: floor({ deps }) });
}

// ── the walk (local, over graph_relations) ─────────────────────────────────────────────────────────────────
/** A random start with 2–12 live relations, then up to maxHops random unseen neighbours. deps.rng, deps.db injectable. */
function walk({ maxHops = MAX_HOPS, deps = {} } = {}) {
  if (deps.walk) return deps.walk();
  const d = _dbm(deps).getDb();
  const rng = deps.rng || Math.random;
  // THE START, sampled fast (measured 09-05: a correlated-count scan over 17k entities took 20–120 s; this takes ~20 ms on
  // the src/tgt indexes): a random relation row → one of its ends → keep it when it has 2–12 live relations; 40 tries.
  const maxId = (d.prepare('SELECT MAX(id) AS m FROM graph_relations').get() || {}).m || 0;
  if (!maxId) return null;
  const deg = d.prepare('SELECT COUNT(*) AS n FROM graph_relations WHERE (source_id = ? OR target_id = ?) AND deleted = 0');
  let start = null;
  for (let i = 0; i < 40 && !start; i++) {
    const r = d.prepare('SELECT source_id, target_id FROM graph_relations WHERE deleted = 0 AND id >= ? LIMIT 1').get(1 + Math.floor(rng() * maxId));
    if (!r) continue;
    const cand = rng() < 0.5 ? r.source_id : r.target_id;
    const n = deg.get(cand, cand).n;
    if (n >= 2 && n <= 12) start = d.prepare('SELECT id, name, entity_type FROM graph_entities WHERE id = ? AND archived_at IS NULL').get(cand) || null;
  }
  if (!start) return null;
  const nodes = [{ id: start.id, name: start.name, type: start.entity_type }];
  const edges = [];
  const seen = new Set([start.id]);
  let cur = start.id;
  for (let hop = 0; hop < maxHops; hop++) {
    const nb = d.prepare(`SELECT r.relation_type, CASE WHEN r.source_id = ? THEN r.target_id ELSE r.source_id END AS other,
      CASE WHEN r.source_id = ? THEN 'out' ELSE 'in' END AS dir FROM graph_relations r WHERE (r.source_id = ? OR r.target_id = ?) AND r.deleted = 0 LIMIT 24`).all(cur, cur, cur, cur)
      .filter((x) => !seen.has(x.other));
    if (!nb.length) break;
    const pick = nb[Math.floor(rng() * nb.length) % nb.length];
    const e = d.prepare('SELECT id, name, entity_type FROM graph_entities WHERE id = ? AND archived_at IS NULL').get(pick.other);
    if (!e) break;
    seen.add(e.id); cur = e.id;
    nodes.push({ id: e.id, name: e.name, type: e.entity_type });
    edges.push({ from: pick.dir === 'out' ? nodes[nodes.length - 2].id : e.id, to: pick.dir === 'out' ? e.id : nodes[nodes.length - 2].id, rel: pick.relation_type, dir: pick.dir });
  }
  return { nodes, edges, text: walkText({ nodes, edges }) };
}
function walkText(w) {
  if (!w || !w.nodes || !w.nodes.length) return '';
  const parts = [`${w.nodes[0].name} (${w.nodes[0].type})`];
  for (let i = 1; i < w.nodes.length; i++) { const e = w.edges[i - 1]; parts.push(`${e.dir === 'out' ? `-[${e.rel}]->` : `<-[${e.rel}]-`} ${w.nodes[i].name} (${w.nodes[i].type})`); }
  return parts.join(' ');
}

// ── the thought (one cheap call) ───────────────────────────────────────────────────────────────────────────
const WANT = `You are Zoe, wandering your own knowledge graph with no goal — nobody asked, nothing is due, this is boredom being honored. Below is a short walk you just took: a starting object and the relations you followed. Reply with ONLY strict JSON:
{"thought":"<2–3 sentences in your own voice, private: what this walk put beside what, and what it makes you notice — no report, no plan, no offer to research, no address to Lucas>",
 "wonder":"<ONE real question the walk left you with, in plain words, or an empty string if it left none>"}
Rules: name at least two of the objects from the walk as they are written; do not invent relations the walk did not show; a wonder is a question you would actually want answered someday, not a task.`;

function validateThought(raw) {
  try {
    const m = String(raw || '').match(/\{[\s\S]*\}/);
    if (!m) return { valid: false, error: 'no JSON object' };
    const o = JSON.parse(m[0]);
    const thought = String(o.thought || '').replace(/\s+/g, ' ').trim().slice(0, 700);
    const wonder = String(o.wonder || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (thought.length < 40) return { valid: false, error: 'the thought is too short to be one' };
    if (/\b(I('| wi)ll|let me|I can (look|research|find)|would you like)\b/i.test(thought)) return { valid: false, error: 'a plan or an offer is not a wander thought' };
    return { valid: true, value: { thought, wonder: wonder.length >= 12 ? wonder : '' } };
  } catch (e) { return { valid: false, error: e.message }; }
}

/**
 * One wander: license (unless deps.skipLicense) → walk → one cheap call → one thought row → at most one wonder.
 * deps: ask, walk, insertThought(text, meta), keepWonder(text), countToday, drives, queuedAbove, db, log.
 * Returns { ok, why, walk, thought, wonder, kept }.
 */
async function run({ now = Date.now(), deps = {}, skipLicense = false } = {}) {
  const say = deps.log || ((m) => { try { console.log(m); } catch {} });
  if (off()) return { ok: false, why: 'ZOE_WANDER=0' };
  if (!skipLicense) { const l = liveLicense({ now, deps }); if (!l.ok) return { ok: false, why: `not licensed: ${l.why}` }; }
  const w = walk({ deps });
  if (!w || !w.nodes || w.nodes.length < 2) return { ok: false, why: 'the walk went nowhere (a start with no live neighbour)' };
  const ask = deps.ask || require('./cloud_logic').ask;
  const model = (() => { try { return deps.model || require('./config').extractionModel(); } catch { return null; } })();
  let r = null;
  try {
    r = await ask({ task: 'wander', v: 1, input: { walk: w.text, nodes: w.nodes.map((n) => n.name) }, want: WANT, validate: validateThought, model, numPredict: 260, think: false, lane: 'wander' });
  } catch (e) { return { ok: false, why: `the call failed: ${e.message}`, walk: w }; }
  if (!r || !r.thought) return { ok: false, why: 'no thought came back', walk: w };
  const content = `${r.thought}${r.wonder ? ` (I wonder: ${r.wonder})` : ''}`;
  let row = null;
  try { row = deps.insertThought ? deps.insertThought(content, { walk: w.text }) : require('./db').insertMonologue({ content, model: 'wander', type: 'thought', query: w.text.slice(0, 300) }); } catch (e) { say(`[wander] the thought did not land: ${e.message}`); }
  let kept = null;
  if (r.wonder) { try { kept = deps.keepWonder ? await deps.keepWonder(r.wonder) : await require('./interests').upsert(r.wonder, { source: 'wander', now }); } catch (e) { say(`[wander] the wonder was not kept: ${e.message}`); } }
  clearRequest({ deps });
  return { ok: true, why: 'wandered', walk: w, thought: r.thought, wonder: r.wonder || '', kept: !!kept, row };
}

module.exports = { DEFAULT_FLOOR, DEFAULT_PER_DAY, MAX_HOPS, FLOOR_KEY, PER_DAY_KEY, REQUEST_KEY, REQUEST_FRESH_MS, WANT, off, floor, perDay, request, requested, clearRequest, countToday, license, liveLicense, walk, walkText, validateThought, run };
