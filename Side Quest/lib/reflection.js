const db = require('./db');
const { streamChat } = require('./ollama');
const { buildReflectionPrompt } = require('./context');
const blackboard = require('./blackboard');
const memoryLib = require('./memory');
const selfModelLib = require('./self_model');
const graphMem = require('./graph_memory');
const selfRep = require('./self_repetition');   // guard: never re-distill a note we semantically already hold (the loop seed)

// Generative-Agents significance trigger: reflection fires when enough IMPORTANT
// thinking has accumulated (sum of thought/reading importance ≥ threshold), not
// just on a clock. Those reflections are stored as durable knowledge notes so
// they compound (the "understand topics deeper" mechanism) and become retrievable
// by the scored retriever. Park et al. use 150; we match it.
const SIGNIFICANCE_THRESHOLD = 150;
const MIN_ITEMS_FOR_SIGNIFICANCE = 4;

const IDLE_THRESHOLD_MS = 3 * 60 * 1000;     // 3 min of no user input
const MIN_GAP_MS = 10 * 60 * 1000;            // at most one reflection per 10 min
const MIN_TURNS_SINCE_LAST = 6;               // need at least 6 new turns
const TICK_INTERVAL_MS = 30 * 1000;           // check every 30s
const MODEL = require('./config').extractionModel();

// Nearest existing knowledge note (A-MEM-lite linking) so new facts connect to
// related ones instead of forming a flat bag. Returns an id or null.
async function nearestKnowledge(text, threshold = 0.6) {
  let qv; try { qv = await memoryLib.embed(text); } catch { return null; }
  if (!qv) return null;
  let bestId = null, bestSim = 0;
  for (const r of db.getAllKnowledgeEmbeddings()) {
    let v; try { v = JSON.parse(r.embedding); } catch { continue; }
    const sim = memoryLib.cosine(qv, v);
    if (sim > bestSim) { bestSim = sim; bestId = r.id; }
  }
  return (bestId && bestSim >= threshold) ? bestId : null;
}

// C3 (Spine 4) — is this reflection window GROUNDED in EXTERNAL material? A KNOWLEDGE/SKILL takeaway becomes a
// retrievable FACT only if anchored to something outside her own head: a reading she took in, a URL, or a
// landed DOCUMENT's origin (extraUrls). A purely own-thought window yields SPECULATION (gated to a proposal),
// never a fact — the anti-glob / drift firewall. Pure + exported so the contract is testable without a model.
function isGrounded(sourceRows = [], extraUrls = []) {
  if ((sourceRows || []).some((r) => r && r.type === 'reading')) return true;
  for (const r of (sourceRows || [])) { try { const u = r && r.urls ? JSON.parse(r.urls) : null; if (Array.isArray(u) && u.length) return true; } catch {} }
  return (extraUrls || []).some(Boolean);
}

// Parse the router's tagged output and ROUTE each takeaway to its store: [SELF] →
// self_model (identity), [KNOWLEDGE]/[SKILL] → knowledge (capability, linked to the
// nearest existing note). Untagged lines are dropped — the noise filter. Exported
// for the backtest. Returns { taggedCount, kept, nSelf, nKnow, nSkill }.
async function routeReflection(raw, sourceRows = [], { decideFn = null, extraUrls = [] } = {}) {
  const tagged = [];
  for (const line of String(raw || '').split('\n')) {
    const m = line.match(/^\s*[-*\d.)]*\s*\[(SELF|KNOWLEDGE|SKILL|INTEREST)\][\s:\-–—•*]*(.+)$/i);
    if (m && m[2].trim().length >= 12) tagged.push({ type: m[1].toUpperCase(), text: m[2].trim() });
  }
  // PROVENANCE marker — where the raw data this reflection distilled actually lives:
  // the monologue rows in the window (+ any reading URLs). Reference-not-copy.
  const refIds = sourceRows.map(r => r.id).filter(Boolean).slice(-8);
  const urls = [];
  for (const r of sourceRows) { try { const u = r.urls ? JSON.parse(r.urls) : null; if (Array.isArray(u)) urls.push(...u); } catch {} }
  // C3 (Spine 4) — DOCUMENTS ground reflection too: a landed document's origin is an EXTERNAL anchor, so a
  // takeaway drawn from recently-landed material is a real grounded fact, not own-thought speculation. The doc
  // origins arrive as `extraUrls` (NOT as sourceRows) so the monologue provenance — refIds + the
  // markReadingsConsolidated pass, both keyed to monologue ids — is never corrupted by document ids.
  for (const u of (extraUrls || [])) { if (u) urls.push(String(u)); }
  const prov = refIds.length || urls.length
    ? [{ type: 'reflection', refTable: 'monologue', refId: refIds[refIds.length - 1] || null, refIds, urls: urls.slice(0, 5), label: 'distilled from recent thoughts/readings' }]
    : null;

  // GROUNDEDNESS (anti-glob phase 2): is this reflection anchored in something EXTERNAL
  // (a reading she took in / a URL), or distilled purely from her own prior thoughts?
  // Knowledge from her own thoughts is SPECULATION and must not become a retrievable fact.
  const grounded = isGrounded(sourceRows, extraUrls);   // C3: readings, sourceRow urls, OR doc origins (extraUrls)
  const lastRefId = refIds.length ? refIds[refIds.length - 1] : null;

  const kept = [];
  let nSelf = 0, nKnow = 0, nSkill = 0, nSpec = 0;
  let lastKnowledgeId = null;   // the note the source readings get pointed at (Phase 2)
  for (const t of tagged.slice(0, 5)) {
    try {
      if (t.type === 'SELF') {
        const r = await selfModelLib.record(t.text, { category: 'insight', importance: 0.7 });
        if (r) { nSelf++; kept.push(`[self] ${t.text}`); }
      } else if (t.type === 'INTEREST') {
        // A research-derived "thing she's drawn to" is CURIOSITY, NOT IDENTITY. Routing it to self_model
        // flooded her identity with ~93 academic "preferences" — the personality-drift root (2026-06-29):
        // her self-model said she IS "interested in graviton mass limits / epistemic contextualism" instead
        // of WHO she is. Store it as a low-importance curiosity note (retained, recall-able) — never
        // identity. Genuine BROAD interests still emerge through the controlled interest system
        // (interests.reweight / _emergentFromUnmatched), not by dumping reflections into self_model.
        const r = await memoryLib.storeDeduped({ kind: 'note', content: t.text, source: 'reflection_interest', importance: 0.45, provenance: prov, decideFn });
        if (r && (r.action === 'add' || r.action === 'update')) { nKnow++; kept.push(`[curiosity] ${t.text}`); }
      } else if (!grounded) {
        // DE-LAUNDER (anti-glob phase 2): a KNOWLEDGE/SKILL takeaway distilled purely from
        // her OWN thoughts (no external reading/URL this window) is SPECULATION — it must NOT
        // become a retrievable 0.75 "fact" (that laundering is what grew the obsession). It
        // queues as a GATED graph proposal instead and only becomes canonical if a real
        // source later grounds it (graph_memory.promote*). See docs/MEMORY_GROUNDING.md.
        try {
          graphMem.recordEntity({
            name: t.text.slice(0, 120), type: 'claim', summary: t.text,
            epistemic: 'speculated', proposedBy: 'reflection',
            source: lastRefId ? { kind: 'own_thought', ref: `monologue:${lastRefId}` } : null
          });
        } catch (e) { console.error('[reflection] speculation→proposal failed:', e.message); }
        nSpec++; kept.push(`[speculation] ${t.text}`);
      } else {
        // GROUNDED → a real, externally-anchored fact. Write-time dedup/merge: a near-duplicate
        // fact/procedure UPDATEs in place or NOOPs instead of piling up (Mem0); a new one ADDs.
        const r = await memoryLib.storeDeduped({
          kind: t.type === 'SKILL' ? 'skill' : 'note',
          content: t.text,
          source: t.type === 'SKILL' ? 'reflection_skill' : 'reflection_knowledge',
          importance: 0.75,
          provenance: prov,
          decideFn
        });
        if (r && r.id) lastKnowledgeId = r.id;            // add | update | noop all yield the note id
        if (r && (r.action === 'add' || r.action === 'update')) {
          if (t.type === 'SKILL') { nSkill++; kept.push(`[skill] ${t.text}`); }
          else { nKnow++; kept.push(`[knowledge] ${t.text}`); }
        }
      }
    } catch (e) { console.error('[reflection] route store failed:', e.message); }
  }
  // ENDPOINT-NOT-PATH (Phase 2): once this window of readings has been distilled into a
  // durable knowledge note, mark those readings consolidated + point them at the note, so
  // recall loads the distilled fact + a pointer, never the raw trail again.
  if (lastKnowledgeId && (nKnow + nSkill) > 0) {
    try {
      const readingIds = sourceRows.filter(r => r && r.type === 'reading').map(r => r.id);
      const n = db.markReadingsConsolidated(readingIds, lastKnowledgeId);
      if (n) console.log(`[reflection] consolidated ${n} reading(s) → knowledge #${lastKnowledgeId} (demoted from recency)`);
    } catch (e) { console.error('[reflection] consolidate readings failed:', e.message); }
  }
  return { taggedCount: tagged.length, kept, nSelf, nKnow, nSkill, nSpec };
}

let timer = null;
let lastUserActivityTs = Date.now();
let opts = { getSessionId: () => null, getWindow: () => null };
let paused = false;
let inFlight = false;

function pause() { paused = true; }
function resume() { paused = false; }

function markUserActivity() {
  lastUserActivityTs = Date.now();
}

function startReflectionScheduler(options = {}) {
  opts = { ...opts, ...options };
  if (timer) return;
  lastUserActivityTs = Date.now();
  timer = setInterval(tick, TICK_INTERVAL_MS);
}

function stopReflectionScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

async function tick() {
  if (paused || inFlight) return;
  try {
    // Significance-triggered reflection takes precedence (it's the "enough has
    // happened" signal). Falls back to the time/turn-based reflection otherwise.
    const did = await maybeSignificanceReflect();
    if (!did) await reflectIfDue({ force: false });
  } catch (err) {
    console.error('[reflection] tick error:', err);
  }
}

// Fires when the importance accumulator (bumped by the monologue as it scores
// thoughts/readings) crosses the threshold. Synthesizes 1–3 higher-level insights
// from the recent significant stream and stores each as a durable knowledge note.
async function maybeSignificanceReflect() {
  if (inFlight || paused) return false;
  const accum = parseInt(db.getMeta('reflection_importance_accum') || '0', 10);
  if (accum < SIGNIFICANCE_THRESHOLD) return false;

  const lastId = parseInt(db.getMeta('last_significance_monologue_id') || '0', 10);
  const recent = db.getRecentMonologue(40).filter(m => m.id > lastId && (m.type === 'thought' || m.type === 'reading'));
  if (recent.length < MIN_ITEMS_FOR_SIGNIFICANCE) {
    // Threshold tripped but too little fresh material to synthesize — decay the
    // accumulator so it doesn't sit permanently tripped, and wait for more.
    db.setMeta('reflection_importance_accum', String(Math.floor(accum / 2)));
    return false;
  }

  inFlight = true;
  try {
    const userName = db.getMeta('user_name') || 'them';
    const lines = recent.slice(-20).map((m, i) => `${i + 1}. ${(m.content || '').replace(/\s+/g, ' ').slice(0, 200)}`).join('\n');
    // ROUTER prompt: instead of one bucket of vague "insights", classify each durable
    // takeaway into the IDENTITY track ([SELF]) vs the CAPABILITY track ([KNOWLEDGE]/
    // [SKILL]) so browsing builds BOTH who she is AND what she can do — and so the
    // capability track captures concrete facts/methods, not introspective summaries.
    const messages = [{
      role: 'user',
      content: `These are things ${userName}'s companion has recently thought and read on its own:\n\n${lines}\n\nExtract DURABLE takeaways worth keeping long-term. Tag each with EXACTLY one label:\n[SELF] — a trait, value, preference, or truth about WHO THE COMPANION IS (its identity/personality), e.g. "I go straight for the primary source instead of the summary". (A genuine trait stated plainly — NEVER an anxious flaw, a doubt about its own honesty, or self-criticism.)\n[KNOWLEDGE] — REAL, APPLICABLE knowledge it can USE later: a specific fact, a how-to step, a correct procedure, or a concrete rule of thumb. Capture the SUBSTANCE — the actual fact/method — NOT an abstract observation about it.\n   GOOD: "A cold pitch email should state the specific ask in the first sentence." / "DuckDuckGo's HTML results page lists each result title under a.result__a."\n   BAD (do NOT tag — drop): "exploring email guidelines reflects an interest in communication", "the tension between trust and autonomy is significant".\n[SKILL] — a procedure it refined through DOING — the correct way to do something, learned from what worked or failed, e.g. "To send email reliably, emit the staged draft→body→send tags in order; narrating the steps doesn't trigger it."\n[INTEREST] — a topic, subject, or thing it encountered (in what it read or did) that it's genuinely DRAWN TO and wants to keep exploring — a taste forming from experience, e.g. "I'm increasingly drawn to mid-century political journalism." (Only if it's a real pull, not a passing mention.)\n\nRules: a takeaway must be CONCRETE and APPLICABLE. Abstract or relational OBSERVATIONS (about trust, autonomy, communication, "deeper meaning") have no place in KNOWLEDGE/SKILL — leave them untagged (dropped) unless they name a real trait ([SELF]). Output ONLY genuinely durable, NEW, usable lines. Each line = the tag then ONE standalone sentence. If nothing qualifies, output nothing.`
    }];

    let raw = '';
    await streamChat({
      model: MODEL,
      messages,
      options: { temperature: 0.5, top_p: 0.9, num_ctx: 8192, num_predict: 260 },
      onToken: (t) => { raw += t; }
    });

    const routed = await routeReflection(raw, recent);
    if (routed.taggedCount === 0) {
      db.setMeta('reflection_importance_accum', '0');
      db.setMeta('last_significance_monologue_id', String(recent[recent.length - 1].id));
      return false;
    }
    const { kept, nSelf, nKnow, nSkill, taggedCount } = routed;

    const now = Date.now();
    const joined = kept.map(s => `• ${s}`).join('\n');
    // LOOP GUARD (semantic): if this note is meaning-equivalent to one we already hold, DROP it — a durable
    // self-note re-stating the same point (the silence-rule confirm loop, or any restated "learning") just
    // re-injects every heartbeat and compounds. Advance the cursors so we don't re-synthesize it.
    const priorRefl = db.getRecentReflections(8).map(r => r.content);
    let dupRefl = false; try { dupRefl = await selfRep.isSemanticRepeat(joined, priorRefl); } catch {}
    if (dupRefl) {
      db.setMeta('reflection_importance_accum', '0');
      db.setMeta('last_significance_monologue_id', String(recent[recent.length - 1].id));
      console.log('[reflection] dropped semantic-repeat note (already hold this learning)');
      return false;
    }
    const reflRow = db.insertReflection({ promptUsed: 'router-v1', content: joined, sourceTurnStart: null, sourceTurnEnd: null, model: MODEL });
    try { blackboard.append({ source: 'reflection', kind: 'insight', refTable: 'reflections', refId: reflRow && reflRow.id, content: joined }); } catch {}

    db.setMeta('reflection_importance_accum', '0');
    db.setMeta('last_significance_monologue_id', String(recent[recent.length - 1].id));
    db.setMeta('last_reflection_at', String(now));
    console.log(`[reflection] router — self:${nSelf} knowledge:${nKnow} skill:${nSkill} (from ${taggedCount} tagged)`);
    try { const win = opts.getWindow ? opts.getWindow() : null; if (win && !win.isDestroyed()) win.webContents.send('reflection:fired', { ts: now, significance: true }); } catch {}
    return true;
  } finally {
    inFlight = false;
  }
}

async function reflectIfDue({ force = false } = {}) {
  if (inFlight) return false;

  const now = Date.now();
  const idleMs = now - lastUserActivityTs;

  if (!force && idleMs < IDLE_THRESHOLD_MS) return false;

  const lastReflectionAtStr = db.getMeta('last_reflection_at');
  const lastReflectionAt = lastReflectionAtStr ? parseInt(lastReflectionAtStr, 10) : 0;
  if (!force && (now - lastReflectionAt) < MIN_GAP_MS) return false;

  const lastReflectedIdStr = db.getMeta('last_reflected_turn_id');
  const lastReflectedId = lastReflectedIdStr ? parseInt(lastReflectedIdStr, 10) : 0;

  const newTurns = db.getTurnsSinceId(lastReflectedId);
  if (newTurns.length < MIN_TURNS_SINCE_LAST) return false;

  inFlight = true;
  try {
    const userName = db.getMeta('user_name') || 'them';
    const messages = buildReflectionPrompt({
      userName,
      turnsSinceLastReflection: newTurns
    });

    let content = '';
    await streamChat({
      model: MODEL,
      messages,
      onToken: (t) => { content += t; }
    });

    const trimmed = content.trim();
    if (!trimmed) return false;

    const startId = newTurns[0].id;
    const endId = newTurns[newTurns.length - 1].id;

    // LOOP GUARD (semantic, see maybeSignificanceReflect): don't store a note we already hold in meaning.
    // Advance the cursor past this span so it isn't re-reflected, and stay silent.
    const priorRefl = db.getRecentReflections(8).map(r => r.content);
    let dupRefl = false; try { dupRefl = await selfRep.isSemanticRepeat(trimmed, priorRefl); } catch {}
    if (dupRefl) {
      db.setMeta('last_reflected_turn_id', String(endId));
      db.setMeta('last_reflection_at', String(now));
      console.log('[reflection] dropped semantic-repeat note (already hold this learning)');
      return false;
    }

    const reflRow = db.insertReflection({
      promptUsed: 'v0',
      content: trimmed,
      sourceTurnStart: startId,
      sourceTurnEnd: endId,
      model: MODEL
    });
    db.setMeta('last_reflected_turn_id', String(endId));
    db.setMeta('last_reflection_at', String(now));
    // write-bottom: a reflection is an 'insight' event on the shared timeline.
    try { blackboard.append({ source: 'reflection', kind: 'insight', refTable: 'reflections', refId: reflRow && reflRow.id, content: trimmed }); } catch (e) { console.error('[reflection] blackboard append failed:', e.message); }

    try {
      const win = opts.getWindow ? opts.getWindow() : null;
      if (win && !win.isDestroyed()) {
        win.webContents.send('reflection:fired', { ts: now });
      }
    } catch {}
    return true;
  } finally {
    inFlight = false;
  }
}

module.exports = {
  startReflectionScheduler,
  stopReflectionScheduler,
  pause,
  resume,
  markUserActivity,
  reflectIfDue,
  maybeSignificanceReflect,
  routeReflection,
  isGrounded,
  forceReflectionIfDue: () => reflectIfDue({ force: true }),
  SIGNIFICANCE_THRESHOLD,
  MIN_ITEMS_FOR_SIGNIFICANCE
};
