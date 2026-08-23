/**
 * lib/contract_agent.js — THE WAVE LOOP (contract-agent slice 1, docs/CONTRACT_AGENT_SPEC_2026-08-22.md §5-§6).
 *
 * One wave = read inbox → replan → act → assess → COMMIT (wavelog) → surface. The driver model makes
 * every hop decision (the frontier-judgment principle); this module is the harness around it: the
 * bounded action vocabulary, the chain guard (an exact-repeat lookup is REFUSED, a failing wave gets
 * an analyze→replan note, never a hammer), the citation discipline (an uncited fill lands FLAGGED,
 * never silently filled), and the commit-before-surface ordering that makes reboot resume safe.
 *
 * Model routing (Lucas 08-22): driver = db-meta `model.contract_driver` → `model.replier` → kimi-k2.6.
 * Script write-and-run steps are NOT in this vocabulary — they go to a kimi-k2.7-code sub-agent when
 * that lane lands (slice 2+); the driver never executes scripts itself.
 *
 * Everything I/O-bearing rides `deps` (test seam): { store, complete, internalSearch, webSearch,
 * quotaCheck, now }. liveDeps() wires the real organs.
 */
'use strict';

const chainGuard = require('./chain_guard');

const MAX_ACTIONS_PER_WAVE = 5;
const DEFAULT_MAX_WAVES = 12;
const DEFAULT_QUESTION_WINDOW_MS = 30 * 60 * 1000;
const OBS_CAP = 700;              // chars per observation carried into the next wave's prompt
const READ_OBS_CAP = 2800;        // read_held gets a BIG window — the excerpt cap was the live limiter
const MAX_READS_PER_WAVE = 2;     // bounds prompt growth: ≤2 big reads per wave ride forward
const PROMPT_OBS_WAVES = 2;       // how many past waves' observations ride the prompt

function driverModel() {
  try {
    const db = require('./db');
    return db.getMeta('model.contract_driver') || db.getMeta('model.replier') || 'kimi-k2.6';
  } catch { return 'kimi-k2.6'; }
}

function liveDeps() {
  const store = require('./contract_store');
  const ollama = require('./ollama');
  return {
    store,
    complete: async (messages) => ollama.complete({
      model: driverModel(), messages, think: false,
      options: { num_predict: 1600, num_ctx: 16384 }, timeoutMs: 150000, lane: 'contract',
    }),
    internalSearch: async (q) => {
      try { return require('./collab').groundingBlock({ sessionId: 0, text: q, mode: 'recall' }); } catch { return null; }
    },
    webSearch: async (q) => {
      try {
        const sr = await Promise.race([
          require('./web_search').search(q),
          new Promise((resolve) => { const t = setTimeout(resolve, 25000); if (t.unref) t.unref(); }),
        ]);
        return (sr && Array.isArray(sr.results) ? sr.results : []).slice(0, 6)
          .map((r) => ({ title: r.title || '', url: r.url || '', snippet: r.snippet || '' }));
      } catch { return []; }
    },
    readHeld: async (ref) => {
      try {
        const r = String(ref || '').trim();
        if (/^doc#\d+$/i.test(r)) {
          const dbm = require('./db');
          const row = dbm.getDb().prepare('SELECT title, body FROM documents WHERE id = ?').get(parseInt(r.slice(4), 10));
          return row ? `${row.title}\n${String(row.body || '').slice(0, 6000)}` : null;
        }
        if (/^canvas:/i.test(r)) return require('./canvas_docs').docText(r.slice(7), 6000) || null;
        const m = r.match(/^(?:notes\/)?([A-Za-z0-9._ -]+\.md)$/);   // no path separators — notes/ top level only
        if (m) {
          const p = require('path'), fs = require('fs');
          const fp = p.join(require('./files').resolvePath('notes'), m[1]);
          return fs.existsSync(fp) ? String(fs.readFileSync(fp, 'utf8')).slice(0, 6000) : null;
        }
        return require('./canvas_docs').docText(r, 6000) || null;    // bare tab-key fallback
      } catch { return null; }
    },
    quotaCheck: () => ({ allow: true, reason: 'directed tier' }),   // floor wiring rides the live governor (F19)
    now: () => Date.now(),
  };
}

const _cap = (s, n = OBS_CAP) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };

// Tolerant JSON: the reasoning models preamble — take the first balanced {...} block.
function parseDriverReply(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = inStr; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

// ── the charter + the state prompt ──────────────────────────────────────────────────────────────
const CHARTER = `You are the contract agent: you work ONE deliverable to completion across waves. This is wave-based — you see the full contract state each wave, decide, and act.
HARD RULES:
- NEVER invent a figure, name, or fact. Every factual claim in a filled slot carries at least one citation: {"src":"<outlet/site or doc#/canvas tab/notes path>","date":"YYYY-MM-DD or 'held'"}. If you cannot cite it, flag the slot honestly instead of filling it.
- Prefer held material first (internal_search) — the operator's own store often already holds the answer. Cross to web_search only for what the store lacks.
- A question to the operator MUST carry "assumption": the default you will proceed on if unanswered. Questions never stop your work.
- Do not repeat a search you already ran — the harness refuses exact repeats. When lookups fail, change the approach, not the phrasing.
- Company projections and single-source claims get labeled in the slot flags, never presented as independent fact.
- Stay inside the contract's stated scope: material about the same company or subject in a DIFFERENT state, session, year, or campus does NOT fill a slot — flag the slot honestly instead.
Reply with ONLY a JSON object: {"plan_summary":"<one line>","actions":[...]} — at most ${MAX_ACTIONS_PER_WAVE} actions.
ACTIONS:
 {"action":"define_slots","slots":[{"slotId":"kebab-id","description":"..."}]}   (only while the slot set is empty or genuinely incomplete)
 {"action":"internal_search","query":"..."}
 {"action":"read_held","ref":"notes/<file>.md | canvas:<tab_key> | doc#<id>"}   (once a search NAMES a held deliverable, READ it — the search only shows a snippet window; the real figures live in the full text)
 {"action":"web_search","query":"..."}
 {"action":"fill_slot","slotId":"...","content":"...","citations":[{"src":"...","date":"..."}],"flags":[...optional...]}
 {"action":"flag_slot","slotId":"...","flag":{"kind":"...","text":"..."}}
 {"action":"open_question","slotId":"... or null","text":"...","assumption":"...","windowMs":1800000}
 {"action":"surface","kind":"finding|judgment_call|milestone|blocked","text":"...","slotId":"... or null"}
 {"action":"done"}   (only when EVERY slot is filled or flagged — this hands the contract to the close-out audit)`;

function buildPrompt(c, { store, replan = null }) {
  const slots = store.slots(c.contractId);
  const inbox = store.readInbox(c.contractId);
  const waves = store.waveLog(c.contractId);
  const openQs = store.openQuestions(c.contractId);
  const recent = waves.filter((w) => w.endedTs).slice(-PROMPT_OBS_WAVES);
  const lines = [];
  lines.push(`CONTRACT: ${c.title}`);
  lines.push(`ORIGINAL ASK (verbatim): ${c.askVerbatim}`);
  lines.push(`TOPIC TOKENS: ${(c.topicTokens || []).join(', ') || '(none)'}`);
  lines.push(`WAVE: ${((c.agent && c.agent.waveN) || 0) + 1} of ${(c.budget && c.budget.maxWaves) || DEFAULT_MAX_WAVES} max`);
  lines.push(`SLOTS${slots.length ? '' : ' (NONE YET — your first job is define_slots)'}:`);
  for (const s of slots) {
    const flags = s.flags.length ? ` flags=${JSON.stringify(s.flags)}` : '';
    const cites = s.citations.length ? ` citations=${s.citations.length}` : '';
    lines.push(`  - [${s.status}] ${s.slotId}: ${s.description}${cites}${flags}`);
  }
  if (openQs.length) lines.push(`OPEN QUESTIONS (proceed on the assumption if unanswered): ${openQs.map((q) => `"${q.text}" → assumption: ${q.assumption}`).join(' | ')}`);
  if (inbox.length) lines.push(`OPERATOR STEERING (unapplied — fold these into this wave's plan): ${inbox.map((m) => `#${m.id} [${m.kind}] ${m.text}`).join(' | ')}`);
  for (const w of recent) {
    lines.push(`WAVE ${w.waveN} (${w.outcome || 'no outcome'}) observations:`);
    for (const a of (w.actions || []).slice(0, MAX_ACTIONS_PER_WAVE + 1)) {
      const s2 = typeof a === 'string' ? a : JSON.stringify(a);
      // read_held observations keep their big window into the next prompt — truncating them to the
      // standard cap would recreate the snippet limiter the action exists to remove (boot_p115 wave 2/3)
      lines.push(`  · ${_cap(s2, /^read_held /.test(s2) ? READ_OBS_CAP : 300)}`);
    }
  }
  if (replan) lines.push(replan);
  return [{ role: 'system', content: CHARTER }, { role: 'user', content: lines.join('\n') }];
}

// THE OFF-INSTANCE FILL GUARD (boot_p118 wave 4, live catch): the driver planned to fill the
// LOUISIANA contract's regional slot from Applied Digital's NORTH DAKOTA record — same company,
// wrong campus, with a perfectly real citation (cite-or-flag can't see instance; the geographic
// twin of the bill-instance disease). If the contract anchors a state and the fill content names a
// DIFFERENT state while never naming the contract's, the fill lands FLAGGED, not filled. Fails
// open: no state anchor, no state in content, or a map error → no guard.
function _offInstanceCheck(c, content, stateCodes = null) {
  try {
    const SC = stateCodes || require('./legis_acquire').STATE_CODES;
    const hay = `${c.title} ${c.askVerbatim} ${(c.topicTokens || []).join(' ')}`.toLowerCase();
    const want = Object.keys(SC).filter((nm) => hay.includes(String(nm).toLowerCase()));
    if (!want.length) return null;
    const cl = String(content || '').toLowerCase();
    if (want.some((nm) => cl.includes(String(nm).toLowerCase()))) return null;
    const found = Object.keys(SC).filter((nm) => !want.includes(nm) && new RegExp(`\\b${nm}\\b`, 'i').test(String(content || ''))).slice(0, 2);
    return found.length ? { want: want.join('/'), found: found.join('/') } : null;
  } catch { return null; }
}

// ── chain-guard state rides the contract's agent JSON across waves ──────────────────────────────
function _loadChain(c) {
  const raw = (c.agent && c.agent.chain) || {};
  const st = chainGuard.newState();
  for (const s of raw.seen || []) st.seen.add(s);
  for (const t of raw.tried || []) st.tried.add(t);
  st.noProgress = raw.noProgress || 0;
  return st;
}
function _saveChain(store, contractId, st) {
  store.patchAgent(contractId, { chain: { seen: Array.from(st.seen).slice(-200), tried: Array.from(st.tried).slice(-40), noProgress: st.noProgress } });
}

/** Run ONE wave of one contract. Returns {ok, waveN?, outcome?, done?, reason?}. */
async function runWave(contractId, deps) {
  const { store, complete, internalSearch, webSearch, readHeld, quotaCheck, now } = deps;
  const c = store.getContract(contractId);
  if (!c) return { ok: false, reason: 'no such contract' };
  if (c.status !== 'open') return { ok: false, reason: `status is ${c.status}` };

  // Expiry first: an overdue question converts to its flagged assumption BEFORE planning.
  const expired = store.expireDueQuestions(now());
  const maxWaves = (c.budget && c.budget.maxWaves) || DEFAULT_MAX_WAVES;
  const doneWaves = store.counts(contractId).wavesDone;
  if (doneWaves >= maxWaves) {
    // Budget spent, contract still open: surface it ONCE and stand down — abandoning is the
    // operator's call (pursue-the-deliverable: a concrete state, never a silent stall).
    if (!(c.agent && c.agent.budgetBlockedPosted)) {
      store.postOutbox({ contractId, kind: 'blocked', text: `wave budget spent (${doneWaves}/${maxWaves}) with open slots remaining — say "keep going" to extend, or I can close it out flagged as-is` });
      store.patchAgent(contractId, { budgetBlockedPosted: true });
    }
    return { ok: false, reason: 'wave budget exhausted' };
  }
  const q = quotaCheck();
  if (!q.allow) return { ok: false, reason: `quota: ${q.reason}` };

  const chain = _loadChain(c);
  const replan = chain.noProgress > 0 ? chainGuard.replanNote(chain, { userName: 'the operator' }) : null;
  const messages = buildPrompt(c, { store, replan });
  const wave = store.beginWave(contractId, '');
  if (!wave) return { ok: false, reason: 'beginWave failed' };

  const inboxIds = store.readInbox(contractId).map((m) => m.id);
  const observations = [];
  let raw = '';
  try { raw = await complete(messages); } catch (e) { raw = ''; observations.push(`driver error: ${_cap(e.message, 200)}`); }
  const reply = parseDriverReply(raw);
  let done = false, tokens = Math.ceil((JSON.stringify(messages).length + String(raw || '').length) / 4);

  if (!reply || !Array.isArray(reply.actions)) {
    // A parse failure is a no-progress wave: commit it honestly and let the replan note push a
    // different shape next wave — never crash, never hammer.
    observations.push(`driver reply unparseable (${_cap(raw, 120)})`);
    chain.noProgress += 1;
  } else {
    const slotsNow = () => store.slots(contractId);
    let readsThisWave = 0;
    for (const a of reply.actions.slice(0, MAX_ACTIONS_PER_WAVE)) {
      const act = String((a && a.action) || '');
      try {
        if (act === 'define_slots') {
          const defs = Array.isArray(a.slots) ? a.slots.filter((s) => s && s.slotId && s.description) : [];
          const fresh = defs.filter((s) => !slotsNow().some((x) => x.slotId === String(s.slotId)));
          for (const s of fresh) store.upsertSlot({ contractId, slotId: String(s.slotId), description: String(s.description) });
          observations.push(`define_slots: ${fresh.length} defined [${fresh.map((s) => s.slotId).join(', ')}]`);
        } else if (act === 'internal_search' || act === 'web_search') {
          const query = String(a.query || '').trim();
          const sig = chainGuard.tagSignature({ kind: 'do', name: act, args: { query: query.toLowerCase() } });
          if (chain.seen.has(sig)) {
            chainGuard.evaluateHop(chain, { signature: sig, label: act, emptyThisHop: true, retrieval: true });
            observations.push(`${act} REFUSED (exact repeat): "${_cap(query, 80)}"`);
            continue;
          }
          const res = act === 'internal_search' ? await internalSearch(query) : await webSearch(query);
          const empty = !res || (Array.isArray(res) && !res.length);
          chainGuard.evaluateHop(chain, { signature: sig, label: act, emptyThisHop: empty, retrieval: true });
          observations.push(`${act} "${_cap(query, 80)}" → ${empty ? 'EMPTY' : _cap(typeof res === 'string' ? res : JSON.stringify(res), OBS_CAP)}`);
        } else if (act === 'read_held') {
          // THE SNIPPET LIMITER (boot_p115 waves 2-3, live): the driver kept re-phrasing searches to
          // "retrieve the notes" because search only returns an excerpt window — the figures it needed
          // sat in the full text of a file the search had already NAMED. This verb reads it.
          const ref = String(a.ref || '').trim();
          if (!ref) { observations.push('read_held REFUSED: no ref'); continue; }
          if (readsThisWave >= MAX_READS_PER_WAVE) { observations.push(`read_held ${_cap(ref, 60)} REFUSED: this wave's read budget is spent`); continue; }
          const sig = chainGuard.tagSignature({ kind: 'do', name: 'read_held', args: { ref: ref.toLowerCase() } });
          if (chain.seen.has(sig)) {
            chainGuard.evaluateHop(chain, { signature: sig, label: 'read_held', emptyThisHop: true, retrieval: true });
            observations.push(`read_held REFUSED (already read): ${_cap(ref, 80)}`);
            continue;
          }
          const txt = typeof readHeld === 'function' ? await readHeld(ref) : null;
          const empty = !txt;
          chainGuard.evaluateHop(chain, { signature: sig, label: 'read_held', emptyThisHop: empty, retrieval: true });
          readsThisWave++;
          observations.push(`read_held ${_cap(ref, 80)} → ${empty ? 'EMPTY (no such held item)' : _cap(txt, READ_OBS_CAP)}`);
        } else if (act === 'fill_slot') {
          const slotId = String(a.slotId || '');
          const s = slotsNow().find((x) => x.slotId === slotId);
          if (!s) { observations.push(`fill_slot REFUSED: unknown slot "${slotId}"`); continue; }
          const cites = Array.isArray(a.citations) ? a.citations.filter((x) => x && x.src) : [];
          const flags = Array.isArray(a.flags) ? a.flags : [];
          if (!cites.length) {
            store.upsertSlot({ contractId, slotId, description: s.description, status: 'flagged', contentRef: s.contentRef, citations: s.citations, flags: [...s.flags, { kind: 'uncited', text: _cap(String(a.content || ''), 200) }] });
            observations.push(`fill_slot ${slotId} REFUSED uncited → FLAGGED (cite it or leave it flagged)`);
          } else if (_offInstanceCheck(c, String(a.content || ''), deps.stateCodes)) {
            const off = _offInstanceCheck(c, String(a.content || ''), deps.stateCodes);
            store.upsertSlot({ contractId, slotId, description: s.description, status: 'flagged', contentRef: s.contentRef, citations: s.citations, flags: [...s.flags, { kind: 'off-instance', text: `content anchors ${off.found} but the contract anchors ${off.want}` }] });
            observations.push(`fill_slot ${slotId} REFUSED off-instance (${off.found} vs ${off.want}) → FLAGGED (wrong state/campus material never fills the slot)`);
          } else {
            store.upsertSlot({ contractId, slotId, description: s.description, status: 'filled', contentRef: `inline:${_cap(String(a.content || ''), 600)}`, citations: cites, flags: [...s.flags, ...flags] });
            observations.push(`fill_slot ${slotId} FILLED (${cites.length} citation(s))`);
          }
        } else if (act === 'flag_slot') {
          const okf = store.addSlotFlag(contractId, String(a.slotId || ''), a.flag || { kind: 'note', text: '' });
          observations.push(`flag_slot ${a.slotId} → ${okf ? 'flagged' : 'REFUSED (unknown slot)'}`);
        } else if (act === 'open_question') {
          const qq = store.openQuestion({ contractId, slotId: a.slotId || null, text: String(a.text || ''), assumption: String(a.assumption || ''), windowMs: a.windowMs > 0 ? a.windowMs : DEFAULT_QUESTION_WINDOW_MS });
          if (qq) { store.postOutbox({ contractId, kind: 'question', slotId: a.slotId || null, text: String(a.text || ''), questionId: qq.questionId }); observations.push(`open_question ${qq.questionId} (assumption: ${_cap(qq.assumption, 100)})`); }
          else observations.push('open_question REFUSED (text + assumption are both required)');
        } else if (act === 'surface') {
          const oid = store.postOutbox({ contractId, kind: String(a.kind || ''), slotId: a.slotId || null, text: String(a.text || '') });
          observations.push(oid ? `surfaced ${a.kind}` : `surface REFUSED (kind "${a.kind}")`);
        } else if (act === 'done') {
          const all = slotsNow();
          const open = all.filter((s) => s.status === 'open' || s.status === 'blocked_on_question');
          if (!all.length || open.length) { observations.push(`done REFUSED: ${all.length ? `open slots remain [${open.map((s) => s.slotId).join(', ')}]` : 'no slots defined'}`); continue; }
          const flagged = all.filter((s) => s.status === 'flagged');
          store.setStatus(contractId, 'closing');
          store.postOutbox({ contractId, kind: 'milestone', text: `all ${all.length} slots landed — ${all.length - flagged.length} filled, ${flagged.length} flagged${flagged.length ? ` (honest holes: ${flagged.map((s) => s.slotId).join(', ')})` : ''} — heading to close-out` });
          observations.push('done → closing');
          done = true;
        } else {
          observations.push(`unknown action "${_cap(act, 40)}"`);
        }
      } catch (e) { observations.push(`${act} errored: ${_cap(e.message, 150)}`); }
      if (done) break;
    }
  }

  store.markInboxConsumed(inboxIds, wave.waveN);
  if (expired.length) observations.push(`expired questions folded to assumptions: ${expired.map((x) => x.questionId).join(', ')}`);
  const planSummary = _cap((reply && reply.plan_summary) || '(unparsed wave)', 200);
  store.endWave(wave.waveId, { actions: observations, tokens, outcome: planSummary });
  _saveChain(store, contractId, chain);
  return { ok: true, waveN: wave.waveN, outcome: planSummary, done };
}

module.exports = { runWave, liveDeps, driverModel, parseDriverReply, buildPrompt, CHARTER, MAX_ACTIONS_PER_WAVE, DEFAULT_MAX_WAVES };
