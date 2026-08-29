/**
 * lib/document_road.js — THE DOCUMENT ROAD, S0 (docs/DOCUMENT_ROAD_DESIGN_2026-08-28.md).
 * Lucas's decisions (08-28): typed orders only · road-owned-only subtractions · the size table
 * below · direct orders ride the interactive lane.
 *
 * S0 is MEASUREMENT-ONLY: the road CLAIMS every typed deliverable order at the one door
 * (intake's detectDeliverableOrder → _bookUserOrderBackstop) and METERS every other organ that
 * books the same ask (promise backstop, say-promise cover, in-turn delivery, user-work redirect).
 * Nothing is subtracted yet — the meter's owner counts are the evidence S3's subtractions will
 * cite, and the double-booking count is the road's own regression meter from day one.
 *
 * The redirect fires BEFORE the claim in turn order (p179 live trace), so it notes itself into a
 * short pre-claim buffer the claim sweeps; organs that fire after the claim use meterIfRecent.
 */
'use strict';

const CLAIMS_KEY = 'road.claims';
const CLAIMS_CAP = 20;
const RECENT_MS = 90 * 1000;

function _db(deps) { return (deps && deps.db) || require('./db'); }

// The size table (design D3, his pick): what the ask CALLS the deliverable decides the budget
// class downstream (S1). Default = report.
function sizeClass(order) {
  const s = `${(order && order.deliverable) || ''} ${(order && order.topic) || ''}`.toLowerCase();
  if (/\b(dossier|comprehensive|deep.?dive|everything|full (?:write.?up|history|picture))\b/.test(s)) return 'dossier';
  if (/\b(summary|brief|memo|blurb|one.?pager|tl;?dr)\b/.test(s)) return 'brief';
  return 'report';
}

function _load(deps) { try { return JSON.parse(_db(deps).getMeta(CLAIMS_KEY) || '[]') || []; } catch { return []; } }
function _save(list, deps) { try { _db(deps).setMeta(CLAIMS_KEY, JSON.stringify(list.slice(-CLAIMS_CAP))); } catch {} }

let _lastClaim = null;
let _preNotes = [];

// An organ that runs BEFORE the claim in the turn (the user-work redirect) notes itself here;
// the next claim (within the window) sweeps it into its owner list.
function notePreClaim(organ, ref = null, { nowMs = Date.now() } = {}) {
  _preNotes.push({ ts: nowMs, organ: String(organ), ref });
  _preNotes = _preNotes.filter((n) => nowMs - n.ts <= RECENT_MS).slice(-8);
}

function claim({ order, userText, bind = null, deps = {}, nowMs = Date.now() } = {}) {
  if (!order || !order.deliverable) return null;
  // One turn can cross TWO doors (the paper-verb door pre-reply, the intake door post-reply) —
  // a same-slug claim inside the window FOLDS instead of double-entering the ledger.
  if (_lastClaim && nowMs - _lastClaim.ts <= RECENT_MS && _lastClaim.slug && bind && bind.slug === _lastClaim.slug) {
    console.log(`[road] claim folded — "${bind.slug}" already claimed this turn`);
    return _lastClaim;
  }
  const c = {
    ts: nowMs,
    slug: (bind && bind.slug) || null,
    minted: !!(bind && bind.created),
    size: sizeClass(order),
    deliverable: String(order.deliverable).slice(0, 60),
    ask: String(userText || '').slice(0, 200),
    owners: ['road'],
  };
  for (const n of _preNotes.filter((n) => nowMs - n.ts <= RECENT_MS)) {
    c.owners.push(n.ref != null ? `${n.organ}#${n.ref}` : n.organ);
  }
  _preNotes = [];
  const list = _load(deps); list.push(c); _save(list, deps);
  _lastClaim = c;
  console.log(`[road] S0 claim: "${c.slug || '(unbound)'}" (size=${c.size}) — the meter is armed${c.owners.length > 1 ? ` (pre-claim owners swept: ${c.owners.slice(1).join(' + ')})` : ''}`);
  return c;
}

// Record another organ booking the SAME ask (S0's whole point). ref = its row/thread id.
function meter(c, organ, ref = null, { deps = {} } = {}) {
  if (!c || !organ) return;
  c.owners.push(ref != null ? `${organ}#${ref}` : String(organ));
  const list = _load(deps);
  const at = list.findIndex((x) => x.ts === c.ts && x.slug === c.slug);
  if (at >= 0) { list[at] = c; _save(list, deps); }
  console.log(`[road] meter: +${organ} on "${c.slug || '(unbound)'}" — owners now: ${c.owners.join(' + ')}`);
}

// A tap for organs outside the intake function's scope that fire AFTER the claim (the absence
// organ joins here at S1): meters onto the just-made claim only — never onto stale history.
function meterIfRecent(organ, ref = null, { deps = {}, nowMs = Date.now() } = {}) {
  if (_lastClaim && nowMs - _lastClaim.ts <= RECENT_MS) meter(_lastClaim, organ, ref, { deps });
}

function claims({ deps = {} } = {}) { return _load(deps); }

// A door that can fire either side of the claim (the canvas-cmd classifier) taps here: a live
// claim gets metered, otherwise the note waits for the sweep.
function tap(organ, ref = null, { deps = {}, nowMs = Date.now() } = {}) {
  if (_lastClaim && nowMs - _lastClaim.ts <= RECENT_MS) meter(_lastClaim, organ, ref, { deps });
  else notePreClaim(organ, ref, { nowMs });
}

// ── S2: the resume loop (design D4) — a partial NEVER strands ───────────────────────────────────
// A road run that ends without a registered artifact records a pending resume; the paced resumer
// (main.js metabolism hook) re-runs the document until a delivery clears it. ONE pending resume
// at a time (the newest ask wins — re-orders update the same document anyway).
const RESUME_KEY = 'road.resume';
const RESUME_PACE_MS = 30 * 60 * 1000;
function noteResume({ slug, ask, note, size = 'report', deps = {}, nowMs = Date.now() } = {}) {
  try { _db(deps).setMeta(RESUME_KEY, JSON.stringify({ slug: slug || null, ask: String(ask || '').slice(0, 300), note: String(note || '').slice(0, 300), size, ts: nowMs, lastTryTs: 0 })); } catch {}
  console.log(`[road] S2 resume noted: "${slug || '(unbound)'}" — the document is owed until a delivery clears it`);
}
function pendingResume({ deps = {} } = {}) {
  try { return JSON.parse(_db(deps).getMeta(RESUME_KEY) || 'null'); } catch { return null; }
}
function markResumeTry({ deps = {}, nowMs = Date.now() } = {}) {
  const r = pendingResume({ deps });
  if (r) { r.lastTryTs = nowMs; try { _db(deps).setMeta(RESUME_KEY, JSON.stringify(r)); } catch {} }
}
function resumeDue({ deps = {}, nowMs = Date.now() } = {}) {
  const r = pendingResume({ deps });
  return !!(r && nowMs - (r.lastTryTs || 0) >= RESUME_PACE_MS);
}
function clearResume({ deps = {}, why = 'delivered' } = {}) {
  const r = pendingResume({ deps });
  if (r) { try { _db(deps).setMeta(RESUME_KEY, 'null'); } catch {} console.log(`[road] S2 resume cleared (${why}): "${r.slug || '(unbound)'}"`); }
}

// ── THE GATHER SWARM + THE WRITER'S TURN (Lucas's design, 08-29) ────────────────────────────────
// "Why aren't cheaper models gathering everything and depositing it where it can be written?"
// Phase A: the road ITSELF fans out engine-side agents by size class (deterministic — the model
// never has to choose to delegate). Phase D: ONE pure-writing frontier call whose entire output
// IS the document — the program had never once given the frontier model a writer-shaped turn
// (chat replies 30-83 tokens; the conductor capped at 900).
const WRITE_BUDGET = { brief: 1500, report: 6000, dossier: 12000 };
const WRITE_FLOOR = { brief: 800, report: 3000, dossier: 6000 };
const _SWARM_REPORT = [
  { agent: 'legislative_analyst', ask: 'Analyze the bill mechanics and key provisions: definitions, thresholds, requirements, enforcement, scope, and committee posture.' },
  { agent: 'fact_checker', ask: 'Verify the key factual claims: sponsors and co-sponsors, dates, statuses, referrals, and any numbers in circulation.' },
];
const SWARM = {
  brief: [],
  report: _SWARM_REPORT,
  dossier: [
    ..._SWARM_REPORT,
    { agent: 'historical_researcher', ask: 'Establish the background and precedents: prior related legislation, its fate, and the policy lineage.' },
    { agent: 'opposition_researcher', ask: 'Collect the counter-arguments, opposition, vetoes, and criticisms on record.' },
  ],
};
function swarmPlan(size, topic) {
  return (SWARM[size] || []).map((s) => ({ agent: s.agent, prompt: `${s.ask}\nTopic: ${String(topic || '').slice(0, 200)}` }));
}

// Phase B's operator mandate: GATHER AND DIGEST — the writer's turn owns all prose.
function gatherMandate({ order, road, userText, held = '' } = {}) {
  const heldBlock = held ? `\nYOU ALREADY HOLD this source material — read it with your tools:\n${held}\n` : '';
  return `GATHER for a document (the document road): ${String(userText || '').slice(0, 400)}\n${heldBlock}` +
    'Do NOT write the document — a dedicated writing pass follows this run. Your job is the DIGEST: ' +
    'read the held material and the stores, and return the raw substance the writer needs — the facts, ' +
    'numbers (with their sources), structure, key quotes, and per-section bullet points. Dense and complete ' +
    'beats polished. Your FINAL message IS the digest.';
}

// Phase D's writing prompt: material in-context, the document as the ENTIRE output.
function writerPrompt({ order, road, userText, digest = '', deposits = [], held = '' } = {}) {
  const size = (road && road.size) || 'report';
  const sizeLine = size === 'brief' ? 'a tight 1-2 page brief' : size === 'dossier' ? 'a full dossier — as long as the material warrants' : 'a thorough report (roughly 5-10 pages)';
  return `Write ${sizeLine} in Markdown, now, as your ENTIRE reply.\n\nTHE ORDER: ${String(userText || '').slice(0, 400)}\n\n` +
    (deposits.length ? `SECTION RESEARCH (from the agent team):\n${deposits.join('\n\n')}\n\n` : '') +
    (digest ? `THE GATHERED DIGEST:\n${digest}\n\n` : '') +
    (held ? `HELD SOURCE MATERIAL (already acquired):\n${held}\n\n` : '') +
    'Rules: every number and named fact comes from the material above — never authored from memory. ' +
    'The document must be COMMENSURATE with its sources. Start directly with the title heading — no preamble, ' +
    'no plan, no meta-commentary, and never end on what you will do next. The reply IS the document.';
}

// ── S3a: THE ARTIFACT-ABSENCE GATE (the 128KB false blank: "we don't have a compiled roster of
// sponsors" said over her own registered report that holds exactly that, organized as asked).
// A say that declares an artifact ABSENT gets verified against the registry + workspace; a hit
// posts the correction with the pointer. Detection is sentence-scoped: the absence phrase and an
// artifact noun must share a sentence.
const ABSENCE_CLAIM_RE = /\b(?:we|i)\s+(?:don'?t|do\s+not)\s+(?:have|hold)\b|\bthere(?:'s|\s+is)\s+no\b|\bno\s+(?:compiled|existing|such)\b|\bhaven'?t\s+(?:compiled|built|written|made)\b/i;
const ABSENCE_NOUN_RE = /\b(?:roster|report|list|compil\w*|document|sheet|summary|write-?up|dossier|table|breakdown)\b/i;
function artifactAbsenceClaim(say) {
  const s = String(say || '');
  if (!s || !ABSENCE_CLAIM_RE.test(s)) return null;
  return s.split(/(?<=[.!?])\s+/).find((x) => ABSENCE_CLAIM_RE.test(x) && ABSENCE_NOUN_RE.test(x)) || null;
}
function findHeldArtifact({ topic, deps = {} } = {}) {
  const toks = _topicTokens(topic);
  if (toks.length < 2) return null;   // one generic token must never "find" (the suiteFor lesson)
  const fs = deps.fs || require('fs');
  const path = require('path');
  const nd = deps.notesDir || path.join(__dirname, '..', 'data', 'zoe_workspace', 'notes');
  try {
    const rows = deps.projects || require('./deliverable_projects').list() || [];
    for (const p of rows) {
      const hay = _norm(`${p.title || ''} ${p.slug || ''}`);
      if (toks.filter((t) => hay.includes(_norm(t))).length >= 2) {
        let fp = path.join(nd, `${p.slug}.md`), kb = 0;
        try { kb = Math.round(fs.statSync(fp).size / 1024); } catch { fp = null; }
        return { title: p.title || p.slug, slug: p.slug, path: fp, kb };
      }
    }
  } catch {}
  try {
    const names = fs.readdirSync(nd).filter((n) => { const nn = _norm(n); return toks.filter((t) => nn.includes(_norm(t))).length >= 2; });
    if (names.length) {
      const fp = path.join(nd, names[0]);
      let kb = 0; try { kb = Math.round(fs.statSync(fp).size / 1024); } catch {}
      return { title: names[0], slug: null, path: fp, kb };
    }
  } catch {}
  return null;
}

// ── S1.7: the say-gate's SHAPE teeth (leg 3's specimen: "I have the core source material. Let me
// read the full research paper and the Statt article to write the complete report." — a PLAN
// posted as the final). A final is plan-shaped when it ends on forward intent and carries no
// pointer; a long inline document or anything pointing at a file/canvas is a deliverable.
const PLAN_TAIL_RE = /\b(?:let me|i'?ll(?:\s+now)?|i'?m (?:going to|about to|gonna)|next i(?:'ll)?|now i(?:'ll)?|give me a (?:sec|second|minute|moment)|one (?:sec|second|moment)|stand by|hang on|working on (?:it|that))\b[^.?!]{0,140}[.?!]?\s*$/i;
const POINTER_RE = /\b(?:notes|docs|data)\/[\w./-]+\.\w{2,4}\b|\bcanvas\b|\bsaved (?:at|to|it)\b|\blanded (?:at|in|on)\b/i;
function planShapedFinal(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (POINTER_RE.test(t)) return false;
  if (t.length > 2500) return false;
  return PLAN_TAIL_RE.test(t);
}

// ── S1.5 CURE 1: anaphoric completion orders (the p180 miss) ────────────────────────────────────
// "yea go ahead and get that completed and pulled up on the canvas" carries no deliverable NOUN,
// so detectDeliverableOrder (precision-over-recall) returns null and the road never saw the
// order. A completion VERB aimed at "that/it" resolves against the project spine instead — the
// newest ACTIVE project touched inside the window is what "that" means. Stale spine → null
// (never bind an anaphor to old work).
const ANAPHOR_RE = /\b(?:finish|complete|deliver|produce)\b[^.?!]{0,40}\b(?:that|it)\b|\b(?:wrap|knock)\s+(?:that|it)\s+(?:up|out)\b|\b(?:get|have)\s+(?:that|it)\s+(?:done|completed|finished|written|drafted|pulled\s+up|on\s+the\s+canvas)\b|\bpull\s+(?:that|it)\s+up\b|\b(?:pull|put)\s+(?:it|that|this|everything)\s+(?:all\s+)?together\b/i;
function anaphoricOrder(text) {
  const s = String(text || '');
  if (!s || s.length > 400) return false;
  return ANAPHOR_RE.test(s);
}
const ANAPHOR_WINDOW_MS = 24 * 3600 * 1000;
function resolveAnaphor({ projects = null, nowMs = Date.now() } = {}) {
  let rows = projects;
  if (!rows) { try { rows = require('./deliverable_projects').list(); } catch { rows = []; } }
  const live = (rows || [])
    .filter((p) => p && p.status === 'active' && nowMs - (p.updated_ts || 0) <= ANAPHOR_WINDOW_MS)
    .sort((a, b) => (b.updated_ts || 0) - (a.updated_ts || 0));
  return live[0] ? { slug: live[0].slug, title: live[0].title || live[0].slug } : null;
}

// ── S1.5 CURE 2: the held material rides the mandate (the 1,520-byte report against 520KB of
// held sources — the writer never saw what she holds). Deterministic, bounded, fail-soft:
// topic-tokened matches from the documents store + the downloads directory, names normalized
// space/hyphen-blind (the 35fe34d lesson).
function _norm(s) { return String(s || '').toLowerCase().replace(/[-_.\s]+/g, ''); }
// §59c PORTED (08-29 live: topic "just get the information" bound Texas "Information Disclosure"
// bills through the token "information" — a wrong-topic document rode the mandate): a GENERIC
// token never binds. Only specific tokens survive; a topic that is ALL generics yields nothing.
const _GENERIC_TOPIC_TOKENS = new Set(['that', 'this', 'with', 'from', 'about', 'analysis', 'summary', 'report', 'reports',
  'complete', 'completed', 'just', 'info', 'information', 'details', 'detail', 'data', 'document', 'documents', 'stuff',
  'things', 'thing', 'everything', 'update', 'updates', 'story', 'full', 'item', 'items', 'list', 'lists', 'note', 'notes',
  'file', 'files', 'together', 'need', 'needed', 'want', 'wanted', 'please', 'quick', 'real']);
function _topicTokens(topic) {
  return [...new Set(String(topic || '').toLowerCase().match(/[a-z0-9]{4,}/g) || [])]
    .filter((t) => !_GENERIC_TOPIC_TOKENS.has(t))
    .slice(0, 4);
}
// The door gate reads this: an order whose topic carries NO specific token is a bare reference —
// it never claims the road; it clarifies.
function hasSpecificTopic(topic) { return _topicTokens(topic).length > 0; }
function heldMaterial({ topic, deps = {} } = {}) {
  const toks = _topicTokens(topic);
  if (!toks.length) return '';
  const lines = [];
  try {
    const h = (deps.db || require('./db')).getDb();
    const like = toks.slice(0, 2).map(() => 'title LIKE ?');
    const rows = h.prepare(`SELECT id, title, created_ts FROM documents WHERE ${like.join(' AND ')} ORDER BY created_ts DESC LIMIT 4`)
      .all(...toks.slice(0, 2).map((t) => `%${t}%`));
    for (const r of rows) lines.push(`- held document #${r.id}: "${String(r.title).slice(0, 110)}"`);
  } catch {}
  try {
    const fs = deps.fs || require('fs');
    const path = require('path');
    const dl = deps.downloadsDir || path.join(__dirname, '..', 'data', 'downloads');
    const names = fs.readdirSync(dl).filter((n) => { const nn = _norm(n); return toks.some((t) => nn.includes(_norm(t))); }).slice(0, 6);
    for (const n of names) {
      let kb = 0; try { kb = Math.round(fs.statSync(path.join(dl, n)).size / 1024); } catch {}
      lines.push(`- data/downloads/${n}${kb ? ` (${kb}KB)` : ''}`);
    }
  } catch {}
  return lines.slice(0, 8).join('\n');
}

// ── S1: the in-turn document run (design D3) ────────────────────────────────────────────────────
// The budget table keys off the size class; the mandate is PURE so the say-gate's demands are
// pinnable. The run itself is fired by main.js on the interactive lane (autonomous:false — a
// direct order is never quota-starved; his decision, 08-28).
const BUDGET = { brief: 0.75, report: 1, dossier: 2 };
function mandate({ order, road, userText, held = '' } = {}) {
  const size = (road && road.size) || 'report';
  const slug = (road && road.slug) || null;
  const sizeLine = size === 'brief' ? 'brief (1-2 pages)' : size === 'dossier' ? 'full dossier (as long as the material warrants)' : 'report (up to ~10 pages)';
  // S1.5 cure 2: the writer is TOLD what she holds — and the commensurate rail kills the
  // 1,520-byte-report-from-520KB-of-sources class.
  const heldBlock = held
    ? `\n\nYOU ALREADY HOLD this source material — READ IT with your tools and write FROM it. The document must be COMMENSURATE with its sources: a multi-hundred-KB source never yields a one-page report.\n${held}\n`
    : '';
  // S1.5 cure 3: report-class+ work FANS OUT — the swarm exists to be used (zero delegate calls
  // in 7 days was the finding; "complete it this turn" means the INTEGRATED document lands, not
  // that every section is written alone).
  const swarmLine = size !== 'brief'
    ? ' For a document of this size, FAN OUT: delegate section research to the Echo agent team (<echo-delegate> / the delegate_to_* tools — the legislative analyst for bill mechanics, the fact checker for claims, the historical researcher for background) and INTEGRATE their returns; completing it this turn means the integrated document lands, not that you write every section alone.'
    : '';
  return `DELIVERABLE ORDER (the document road): ${String(userText || '').slice(0, 400)}\n\n` +
    `Write the ${sizeLine} NOW, in this run.` +
    (slug ? ` The registry project for this document is "${slug}" — update the canonical, never a parallel copy.` : '') +
    ` Save the document with the file tool (notes/${slug || 'report'}.md) or the canvas doc tool.` +
    ' Numbers come from held rows and tool results ONLY — never authored.' +
    swarmLine + heldBlock +
    '\nYour FINAL message is the pointer to the finished document plus a 3-6 line summary of it — or an HONEST PARTIAL naming exactly what is missing and what you ran.';
}

function _resetForTest() { _lastClaim = null; _preNotes = []; }

module.exports = { sizeClass, claim, meter, meterIfRecent, notePreClaim, tap, claims, mandate, BUDGET, anaphoricOrder, resolveAnaphor, heldMaterial, hasSpecificTopic, planShapedFinal, artifactAbsenceClaim, findHeldArtifact, noteResume, pendingResume, markResumeTry, resumeDue, clearResume, swarmPlan, gatherMandate, writerPrompt, WRITE_BUDGET, WRITE_FLOOR, SWARM, _resetForTest, CLAIMS_KEY, CLAIMS_CAP, ANAPHOR_WINDOW_MS, RESUME_KEY, RESUME_PACE_MS };
