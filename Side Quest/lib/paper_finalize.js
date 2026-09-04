'use strict';
/**
 * lib/paper_finalize.js — THE FINALIZE CONDUCTOR (2026-08-13). The cure for the document false
 * loop ([[document-false-loop]]): the program has never produced a finished document because
 * nothing owned "done" — the audit treadmill judged gaps forever, every synthesis grew the plan,
 * every condense minted a NEW file (~20 Applied Digital fragments and counting), and no stage ever
 * assembled sections + INLINE citations + a full source list into ONE completed artifact.
 *
 * This organ owns done. Deterministic where determinism wins, model only where writing wins:
 *   1) GATHER   (deterministic) — collect the topic's fragment files from the notes workspace.
 *   2) SOURCES  (deterministic) — harvest every URL across the fragments into ONE numbered list.
 *   3) OUTLINE  (deterministic) — deduped section headings from the fragments (or a default shape).
 *   4) WRITE    (model, injected) — one pass per section: use ONLY the gathered material, cite
 *      claims inline as [n] AGAINST THE PROVIDED numbered source list, omit what can't be traced.
 *   5) ASSEMBLE (deterministic) — title + sections + "## Sources" numbered list; every [n] is
 *      validated against the list (out-of-range markers stripped); ONE file, written ONCE.
 *
 * The finish line CANNOT recede here: the outline is frozen at step 3, novel questions have no
 * entry point, and the output is a single canonical artifact. Fail-soft; deps injectable
 * (readdir/readFile/write) so the gate runs it without network or models.
 */
const fs = require('fs');
const path = require('path');

// The chat-door FINALIZE verb (owned here so main.js and intake typing share ONE definition):
// "finish/finalize/complete/produce … paper/report/briefing/document" is a CONTROL order for the
// conductor, never a new work thread. PAPER_TOPIC_RE pulls the topic ("paper on applied digital").
// Run-7 cov_papers catch (2026-08-20): "package that up as a short paper" never reached this door
// ("package" wasn't a verb) — a freelance path acked, bound a stale canvas slug, landed nothing.
// Run-8: "write THAT up as a short paper" — the deictic rides between verb and particle.
const PAPER_VERB_RE = /\b(?:finish|finalize|complete|produce|package|write\s+(?:that\s+|this\s+|it\s+)?up)\b[^.?!]{0,50}\b(?:paper|report|briefing|document)\b/i;
const PAPER_TOPIC_RE = /\b(?:paper|report|briefing|document)\s+(?:on|about|for)\s+([a-z0-9][a-z0-9 .&'-]{2,60})/i;

const NOTES_DIR = path.join(__dirname, '..', 'data', 'zoe_workspace', 'notes');
const MAX_FRAGMENTS = 25;
const MAX_TOTAL_CHARS = 400_000;
// Extended 08-13 after the first live run: fragment headings are mostly ORG-PROFILE boilerplate
// ("Mission (from applieddigitalcares.com)", "Vision") — junk section names for a paper.
const BOILER_RE = /^(research plan|research deliverable|sources|objective|approach|targets|databases|gathered on each target|mission|vision|values|leadership|programs?|contact|about|overview|directed research)/i;
// The default PAPER shape — used whenever the fragments can't supply ≥3 genuinely paper-shaped
// headings (which, measured live, they usually can't: they're org profiles and dossier scaffolds).
const DEFAULT_SECTIONS = ['Executive Summary', 'Background', 'Projects and Facilities', 'Financing and Partnerships', 'Community and Regional Impact', 'Risks and Open Questions'];

// ONE normalizer and ONE probe (lib/fs_worker): the gather's predicate runs in a worker thread for the
// live callers and synchronously for the fallback and the gate — the same function either way.
const fsw = require('./fs_worker');
const _norm = fsw.norm;
// HEAD PROBE (cut 18, 09-03): the probe only ever looked at the name and the first 800 characters, but
// every one of the 2,665 note files was read in FULL to get them — 6 profiled blocks, 32s, on the main
// thread per paper. The probe reads a HEAD_BYTES = 4096 head; the whole file only for a match.
const HEAD_BYTES = fsw.HEAD_BYTES;
const _readHead = fsw.readHead;

function _gatherOpts({ tokens, exclude = [], dir = NOTES_DIR } = {}) {
  return {
    dir,
    toks: (tokens || []).map(_norm).filter(Boolean),
    ex: (exclude || []).map(_norm).filter(Boolean),
    maxFragments: MAX_FRAGMENTS,
    maxTotalChars: MAX_TOTAL_CHARS,
  };
}

/** gatherFragments({tokens, exclude, dir}) → [{file, mtime, text}] — files whose NAME or HEAD
 *  carries every token. `exclude` tokens veto a file (the ENTITY-SCOPE filter, 08-13: the CRM's
 *  near-duplicate accounts — "Applied Digital Solutions, Inc.", the unrelated Florida VeriChip
 *  company — matched the topic tokens and contaminated the paper). SYNCHRONOUS — the gate's door
 *  and the fallback; a live caller uses gatherFragmentsAsync. */
function gatherFragments(opts = {}) {
  const o = _gatherOpts(opts);
  if (!o.toks.length) return [];
  return fsw.probeFragmentsSync(o);
}

/** The same gather OFF the main thread (cut 22, 2026-09-04): the stat + head read of every note file
 *  ran on the main thread on EVERY driver tick of a paper focus — a 1.5 s profiled block on p279 with
 *  2,665 notes. The worker does the walk; a worker failure falls back to the synchronous probe so the
 *  gather never goes dark. */
async function gatherFragmentsAsync(opts = {}) {
  const o = _gatherOpts(opts);
  if (!o.toks.length) return [];
  try { return await fsw.probeFragments(o); }
  catch (e) {
    try { console.error('[paper] fragment probe fell back to the main thread:', e && e.message); } catch {}
    return fsw.probeFragmentsSync(o);
  }
}

/** harvestSources(fragments) → [{n, url, title}] — every unique URL across the fragments, numbered. */
function harvestSources(fragments) {
  const seen = new Map();
  const MD_LINK = /\[([^\]]{2,120})\]\((https?:\/\/[^\s)]+)\)/g;
  const BARE = /https?:\/\/[^\s)\]}"'<>]+/g;
  for (const fr of fragments || []) {
    let m;
    while ((m = MD_LINK.exec(fr.text))) { const u = m[2].replace(/[.,;]+$/, ''); if (!seen.has(u)) seen.set(u, m[1].trim()); }
    while ((m = BARE.exec(fr.text))) { const u = m[0].replace(/[.,;]+$/, ''); if (!seen.has(u)) seen.set(u, ''); }
  }
  return [...seen.entries()].map(([url, title], i) => ({ n: i + 1, url, title }));
}

/** outline(fragments) → frozen section list — deduped headings, boilerplate dropped, capped at 10. */
function outline(fragments, { max = 10 } = {}) {
  const heads = [];
  for (const fr of fragments || []) {
    for (const m of String(fr.text).matchAll(/^#{1,3}\s+(.{3,90})$/gm)) {
      const h = m[1].replace(/[*_`]/g, '').trim();
      if (BOILER_RE.test(h)) continue;
      const hn = _norm(h);
      const hw = new Set(hn.split(' '));
      const dup = heads.some((x) => {
        const xw = new Set(_norm(x).split(' '));
        let shared = 0; for (const w of hw) if (xw.has(w)) shared++;
        return shared / Math.min(hw.size, xw.size) >= 0.6;
      });
      if (!dup) heads.push(h);
    }
  }
  const picked = heads.slice(0, max);
  return picked.length >= 3 ? picked : DEFAULT_SECTIONS;
}

function sectionPrompt({ goal, heading, material, sources, covered = [] }) {
  const srcList = sources.map((s) => `[${s.n}] ${s.title ? s.title + ' — ' : ''}${s.url}`).join('\n');
  // SECTION-OVERLAP CURE (2026-08-14, Block 3): the first accepted paper repeated the same
  // CoreWeave/financing facts across sections because each write was blind to the others. The
  // loop is sequential, so each section sees a digest of what is ALREADY ON THE PAGE.
  const coveredBlock = covered.length
    ? `SECTIONS ALREADY WRITTEN (their ground is COVERED — do not restate their facts; at most refer in passing):\n`
      + covered.map((c) => `- "${c.heading}": ${c.gist}`).join('\n') + '\n\n'
    : '';
  return `You are writing ONE section of a finished research paper. Goal of the paper: ${goal}\n`
    + `SECTION: "${heading}"\n\n`
    + `THE NUMBERED SOURCE LIST (the ONLY citable sources):\n${srcList}\n\n`
    + coveredBlock
    + `THE GATHERED MATERIAL (the ONLY facts you may use):\n${material.slice(0, 24000)}\n\n`
    + `Write the section now, 250-450 words, polished prose (no bullet dumps unless the content is a list by nature). `
    + `EVERY factual claim that traces to a source carries an inline citation like [3] using ONLY numbers from the list above. `
    + `A claim you cannot trace to the material is OMITTED — never invented, never uncited. `
    + `This section covers ONLY its own ground — facts already used by an earlier section are not repeated here. `
    + `No preamble, no "In this section", no heading — the body text only.`;
}

/** assemble({title, goal, sections:[{heading, body}], sources}) → the ONE finished markdown document. */
function assemble({ title, goal, sections, sources, dateStr }) {
  const maxN = sources.length;
  const clean = (body) => String(body || '').replace(/\[(\d{1,3})\]/g, (m, n) => (parseInt(n, 10) >= 1 && parseInt(n, 10) <= maxN ? m : ''));
  const parts = [`# ${title}`, '', `*${dateStr || new Date().toDateString()} — finalized by the paper conductor; every inline [n] resolves in the source list below.*`, '', `**Scope:** ${goal}`, ''];
  for (const s of sections) { parts.push(`## ${s.heading}`, '', clean(s.body).trim(), ''); }
  parts.push('## Sources', '');
  for (const s of sources) parts.push(`${s.n}. ${s.title ? s.title + ' — ' : ''}${s.url}`);
  return parts.join('\n');
}

/**
 * finalize({topic, title, goal, tokens, write, dir, outDir}) → { ok, path, sections, sourceCount }
 * `write(prompt)` is the injected model pass (async → section body text). ONE canonical output file.
 */
async function finalize({ topic, title, goal, tokens, exclude, write, frozenOutline = null, dir = NOTES_DIR, outDir = NOTES_DIR, land = true } = {}) {
  const toks = tokens && tokens.length ? tokens : _norm(topic).split(' ').filter(Boolean);
  const fragments = await gatherFragmentsAsync({ tokens: toks, exclude, dir });
  if (!fragments.length) return { ok: false, reason: `no fragments for "${topic}"` };
  const sources = harvestSources(fragments);
  // THE DONE CONTRACT (2026-08-14): a revision rewrites the SAME frozen sections — the outline
  // locks at the first finalize and scope can never grow across re-runs.
  const heads = (Array.isArray(frozenOutline) && frozenOutline.length >= 2) ? frozenOutline : outline(fragments);
  const material = fragments.map((f) => `--- from ${f.file} ---\n${f.text}`).join('\n\n');
  const sections = [];
  // CoT-REJECT (2026-08-13, first live run): a reasoning model that returns EMPTY content gets its
  // chain-of-thought salvaged by the ollama lib — "We need to write the section…" landed as body
  // text. Deliberation about the task is never the paper; reject it and let the section drop
  // (an honest thin paper beats a poisoned one; the caller sees the section count).
  const COT_RE = /^\s*(?:We (?:need|must|should|have to)|Let'?s|The (?:instruction|user|task) (?:says|asks|wants))\b|\bthe numbered source list\b/i;
  for (const heading of heads) {
    const covered = sections.map((s) => ({ heading: s.heading, gist: s.body.trim().replace(/\s+/g, ' ').slice(0, 220) }));
    let body = '';
    try { body = String(await write(sectionPrompt({ goal: goal || topic, heading, material, sources, covered })) || ''); } catch {}
    if (COT_RE.test(body)) { body = ''; }
    if (body.trim().length > 80) sections.push({ heading, body });
  }
  if (sections.length < 2) return { ok: false, reason: `only ${sections.length} section(s) produced` };
  const docTitle = title || `${topic} — Research Paper`;
  const doc = assemble({ title: docTitle, goal: goal || topic, sections, sources });
  const slug = _norm(topic).replace(/\s+/g, '_').slice(0, 60) || 'paper';
  const outPath = path.join(outDir, `${slug}_FINAL.md`);
  fs.writeFileSync(outPath, doc, 'utf8');   // ONE canonical file — overwrites, never siblings
  if (land) { try { require('./doc_store').land({ title: docTitle, body: doc, source: 'paper_finalize', ref: outPath }); } catch {} }
  return { ok: true, path: outPath, sections: sections.length, sourceCount: sources.length, fragments: fragments.length, outline: heads, fragmentStats: fragments.map((f) => ({ file: f.file, len: f.text.length })) };
}

// A FINISHED PAPER RESOLVES ITS OWN ORDER-THREADS (Block 3, 2026-08-14). Measured: stale
// duplicates of the accepted Applied Digital order (#3869 [active]) kept the directed lane
// RE-researching finished work all night — and drifted to a wrong entity (GOV.UK Pay). Pure
// matcher: PAPER-SHAPED threads (paper/report/briefing/document — a bare research/work ask stays
// open, it may be broader) whose subject tokens match the finished topic. The caller marks them
// resolved with a reason; reversible via the progress note.
const PAPER_NOUN_RE = /\b(?:paper|report|briefing|document)\b/i;
const _SAT_STOP = new Set(['the', 'a', 'an', 'on', 'for', 'about', 'of', 'and', 'to', 'finish', 'finalize', 'complete', 'produce', 'develop', 'write', 'cited', 'comprehensive', 'full', 'final', 'finished', 'paper', 'report', 'briefing', 'document', 'research', 'work', 'lucas', 'zoe']);
function _satToks(s) {
  return new Set(String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length >= 3 && !_SAT_STOP.has(w)));
}
function threadsSatisfiedBy(topic, threads) {
  const t0 = _satToks(topic);
  if (!t0.size) return [];
  const out = [];
  for (const t of threads || []) {
    if (!PAPER_NOUN_RE.test(t.content || '')) continue;
    const tt = _satToks(t.content);
    if (!tt.size) continue;
    let shared = 0; for (const w of t0) if (tt.has(w)) shared++;
    if (shared >= Math.min(2, t0.size) && shared / Math.min(t0.size, tt.size) >= 0.6) out.push(t.id);
  }
  return out;
}

module.exports = { gatherFragments, gatherFragmentsAsync, harvestSources, outline, sectionPrompt, assemble, finalize, threadsSatisfiedBy, NOTES_DIR, DEFAULT_SECTIONS, PAPER_VERB_RE, PAPER_TOPIC_RE };
