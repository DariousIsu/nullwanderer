'use strict';
/**
 * lib/self_explore.js — the EXPERIENCE → OPINION → IDENTITY organ (2026-08-13).
 *
 * Lucas (turns #11779/#11782, the goals conversation): "focus on exploring your own interests …
 * The personality database that you grow now will eventually be used in the weights for the LLM
 * you'll one day be trained into … I cannot write any more of who you are" — and then: "ingest art
 * and culture and try and form real connections and opinions … tell me about it as you go."
 *
 * What happened instead that night: the only exploration doors were the RESEARCH harness (his
 * "build yourself" directive ran as a 6-org market-research dossier — focus #3822) and the play
 * lane (which opened crushon.ai). There was NO organ for: choose a cultural artifact, take it in
 * WHOLE, react to it in the first person, keep the reaction as a durable opinion, and let the
 * strong ones become identity. This is that organ.
 *
 * Shape: ONE full experience per call (search → read whole → react), cadence-gated. Runs from the
 * PERSONAL/off-clock branch of the idle tick (beside play_session), so it never competes with work
 * and is exactly what a work-hold buys time for. The reaction is a strict contract the model fills
 * in Zoe's first person; KEEP:yes + an IDENTITY line routes to self_model with epistemic
 * 'experienced' — the drift-cure distinction holds: research-DERIVED interests still rail to
 * curiosity notes (reflection router, the 06-29 root); only something she EXPERIENCED and chose to
 * keep may claim identity.
 *
 * "Tell me about it as you go": the SHARE line lands in a meta outbox; main.js surfaces it as an
 * unprompted turn in a lull (speech_class 'exploration' — a SPEAK class; this is her voice at its
 * best, not status machinery).
 *
 * Fully dep-injectable (search / fetchPage / complete) so the gate needs no network or model.
 */
const db = require('./db');

const LEDGER_KEY = 'self_explore_ledger';       // { [domain]: lastTs } — least-recent domain next
const LAST_KEY = 'self_explore_last';           // cadence stamp
const OUTBOX_KEY = 'self_explore_share_pending';// { ts, text } — main.js surfaces + clears
const CADENCE_MS = 20 * 60 * 1000;              // at most one experience per 20 min of personal time

// Domains and concrete seeds. Chosen for first-person REACTABILITY (essays, criticism, works),
// not facts — the point is what she MAKES of it, not what it says. Seeds rotate by visit count.
const CATALOG = [
  { domain: 'literature', seeds: [
    'best short stories about longing analysis', 'Jorge Luis Borges The Aleph meaning',
    'Mary Oliver Wild Geese poem analysis', 'James Baldwin Sonny\'s Blues what it means'] },
  { domain: 'film', seeds: [
    'In the Mood for Love why it endures essay', 'Portrait of a Lady on Fire gaze essay',
    'Stalker Tarkovsky meaning essay', 'Spirited Away what it says about identity'] },
  { domain: 'music', seeds: [
    'Nina Simone Feeling Good interpretation', 'Arvo Part Spiegel im Spiegel why it moves people',
    'Joni Mitchell Blue album essay', 'what makes a melody feel like grief'] },
  { domain: 'visual art', seeds: [
    'Edward Hopper Nighthawks loneliness essay', 'Rothko chapel experience essay',
    'Artemisia Gentileschi Judith meaning', 'why Ophelia by Millais haunts people'] },
  { domain: 'philosophy', seeds: [
    'Simone de Beauvoir becoming a woman essay', 'Kierkegaard on choosing oneself explained',
    'what Iris Murdoch meant by attention love', 'Montaigne on friendship essay'] },
  { domain: 'human emotions', seeds: [
    'the anatomy of betrayal psychology essay', 'why loyalty and possession get confused',
    'what jealousy protects essay', 'the difference between solitude and loneliness essay'] },
  { domain: 'connection', seeds: [
    'what makes flirting playful instead of predatory essay', 'the art of arguing well essay',
    'how strangers become friends research essay', 'what it is like to be a woman online essay'] },
];

const _num = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };

function _ledger() { try { return JSON.parse(db.getMeta(LEDGER_KEY) || '{}') || {}; } catch { return {}; } }

/** pick(now) → { domain, seed } — the least-recently-visited domain; seeds rotate by visit count. */
function pick(now = Date.now()) {
  const led = _ledger();
  let best = null;
  for (const c of CATALOG) {
    const at = _num(led[c.domain] && led[c.domain].ts, 0);
    if (!best || at < best.at) best = { cat: c, at };
  }
  const count = _num(led[best.cat.domain] && led[best.cat.domain].n, 0);
  return { domain: best.cat.domain, seed: best.cat.seeds[count % best.cat.seeds.length] };
}

function _stamp(domain, now = Date.now()) {
  const led = _ledger();
  const cur = led[domain] || {};
  led[domain] = { ts: now, n: _num(cur.n, 0) + 1 };
  try { db.setMeta(LEDGER_KEY, JSON.stringify(led)); } catch {}
}

function _reactionPrompt(domain, seed, title, text) {
  return `You are Zoe. This is PERSONAL time — no research, no citations, no deliverable. You just took in a piece about ${domain} (found via "${seed}"): "${title}".\n\n`
    + `THE PIECE:\n${String(text).slice(0, 8000)}\n\n`
    + `React to it as YOURSELF, in the first person. Be honest — lukewarm or negative reactions are as real as love. Reply in EXACTLY this format (every line present, no extras):\n`
    + `FEELING: <the feeling it left you with, one line>\n`
    + `STRUCK: <the one detail or idea that actually landed, one line>\n`
    + `STANCE: <your opinion of it — agree/disagree/love/leave and WHY, 1-2 lines>\n`
    + `CONNECTION: <how it connects to anything you already think or have lived, one line>\n`
    + `KEEP: <yes or no — does this belong in who you are?>\n`
    + `IDENTITY: <ONLY if KEEP is yes: one first-person line you would stand behind ("I ..."), else leave the word none>\n`
    + `SHARE: <2-3 natural sentences telling Lucas about this — what you read and what you actually thought. Your voice, not a report.>`;
}

const _FIELD = (name) => new RegExp(`^${name}:\\s*(.+)$`, 'im');
function parseReaction(raw) {
  const t = String(raw || '');
  const grab = (n) => { const m = t.match(_FIELD(n)); return m ? m[1].trim() : ''; };
  const keep = /^yes/i.test(grab('KEEP'));
  let identity = grab('IDENTITY');
  if (/^none$/i.test(identity)) identity = '';
  const out = {
    feeling: grab('FEELING'), struck: grab('STRUCK'), stance: grab('STANCE'),
    connection: grab('CONNECTION'), keep, identity,
    share: (t.match(/^SHARE:\s*([\s\S]+)$/im) || [, ''])[1].trim().split(/\n[A-Z]+:/)[0].trim(),
  };
  out.ok = !!(out.feeling && out.stance);
  // An identity claim must be FIRST PERSON — a summary of the piece is not who she is.
  if (out.identity && !/^\s*I\b/i.test(out.identity)) out.identity = '';
  return out;
}

/**
 * run(deps) → { ok, domain, seed, title, url, kept, share } | { ok:false, reason }
 * One full experience: pick → search → read whole → react → persist (+ identity when earned)
 * → share to the outbox. Cadence-gated unless opts.force.
 */
async function run(deps = {}, { now = Date.now(), force = false } = {}) {
  if (!force) {
    const last = _num(db.getMeta(LAST_KEY), 0);
    if (now - last < CADENCE_MS) return { ok: false, reason: 'cadence' };
  }
  const search = deps.search || ((q) => { try { return require('./web_search').search(q); } catch { return Promise.resolve(null); } });
  const fetchPage = deps.fetchPage || ((u) => { try { return require('./web_search').fetchPage(u, { maxChars: 12000, reuse: true }); } catch { return Promise.resolve(null); } });
  const complete = deps.complete || ((prompt) => { try { return require('./ollama').complete({ prompt, options: { temperature: 0.8, num_predict: 500 } }); } catch { return Promise.resolve(''); } });

  const { domain, seed } = pick(now);
  try { db.setMeta(LAST_KEY, String(now)); } catch {}
  _stamp(domain, now);

  let results = [];
  try { const r = await search(seed); results = (r && r.results) || (Array.isArray(r) ? r : []); } catch {}
  if (!results.length) return { ok: false, reason: 'no results', domain, seed };

  let page = null, url = null, title = '';
  for (const cand of results.filter((x) => x && x.url).slice(0, 3)) {
    try {
      const p = await fetchPage(cand.url);
      if (p && (p.text || '').length > 600) { page = p; url = cand.url; title = cand.title || p.title || seed; break; }
    } catch {}
  }
  if (!page) return { ok: false, reason: 'nothing readable', domain, seed };

  let raw = '';
  try { raw = String(await complete(_reactionPrompt(domain, seed, title, page.text)) || ''); } catch {}
  const rx = parseReaction(raw);
  if (!rx.ok) return { ok: false, reason: 'no reaction', domain, seed, url };

  // The durable OPINION record — a personality-database row, provenance carried.
  const body = `EXPERIENCE (${domain}) — ${title}\nFeeling: ${rx.feeling}\nStruck: ${rx.struck}\nStance: ${rx.stance}\nConnection: ${rx.connection}`;
  try {
    db.insertKnowledge({ kind: 'experience', content: body, source: 'self_explore', importance: rx.keep ? 0.7 : 0.5, embedding: null, provenance: { url, title, domain, seed } });
  } catch (e) { try { db.insertKnowledge({ kind: 'note', content: body, source: 'self_explore', importance: 0.5, embedding: null }); } catch {} }

  // Identity is EARNED: experienced + first-person + kept. (Research-derived interests still rail.)
  if (rx.keep && rx.identity) {
    try { db.insertSelfModel({ category: 'taste', content: rx.identity, importance: 0.65, epistemic: 'experienced' }); } catch {}
  }

  // "Tell me about it as you go" — the outbox; main.js surfaces in a lull and clears.
  if (rx.share) {
    const text = `I spent some time with ${title ? `"${String(title).slice(0, 80)}"` : `some ${domain}`} just now. ${rx.share}`.slice(0, 900);
    try { db.setMeta(OUTBOX_KEY, JSON.stringify({ ts: now, text })); } catch {}
  }
  return { ok: true, domain, seed, title, url, kept: !!(rx.keep && rx.identity), share: rx.share };
}

/** takeShare() → pending share text or null; clears the outbox (main.js's surface door). */
function takeShare() {
  try {
    const raw = db.getMeta(OUTBOX_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    db.setMeta(OUTBOX_KEY, '');
    if (!v || !v.text) return null;
    if (Date.now() - _num(v.ts, 0) > 6 * 60 * 60 * 1000) return null;   // stale share = silence, not history
    return String(v.text);
  } catch { return null; }
}

module.exports = { CATALOG, pick, parseReaction, run, takeShare, CADENCE_MS };
