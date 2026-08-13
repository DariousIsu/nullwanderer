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

const NOTES_DIR = path.join(__dirname, '..', 'data', 'zoe_workspace', 'notes');
const MAX_FRAGMENTS = 25;
const MAX_TOTAL_CHARS = 400_000;
// Extended 08-13 after the first live run: fragment headings are mostly ORG-PROFILE boilerplate
// ("Mission (from applieddigitalcares.com)", "Vision") — junk section names for a paper.
const BOILER_RE = /^(research plan|research deliverable|sources|objective|approach|targets|databases|gathered on each target|mission|vision|values|leadership|programs?|contact|about|overview|directed research)/i;
// The default PAPER shape — used whenever the fragments can't supply ≥3 genuinely paper-shaped
// headings (which, measured live, they usually can't: they're org profiles and dossier scaffolds).
const DEFAULT_SECTIONS = ['Executive Summary', 'Background', 'Projects and Facilities', 'Financing and Partnerships', 'Community and Regional Impact', 'Risks and Open Questions'];

function _norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim(); }

/** gatherFragments({tokens, exclude, dir}) → [{file, mtime, text}] — files whose NAME or HEAD
 *  carries every token. `exclude` tokens veto a file (the ENTITY-SCOPE filter, 08-13: the CRM's
 *  near-duplicate accounts — "Applied Digital Solutions, Inc.", the unrelated Florida VeriChip
 *  company — matched the topic tokens and contaminated the paper). */
function gatherFragments({ tokens, exclude = [], dir = NOTES_DIR } = {}) {
  const toks = (tokens || []).map(_norm).filter(Boolean);
  const ex = (exclude || []).map(_norm).filter(Boolean);
  if (!toks.length) return [];
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.md')); } catch { return []; }
  const out = [];
  for (const f of names) {
    let st; try { st = fs.statSync(path.join(dir, f)); } catch { continue; }
    let text; try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    const probe = _norm(f + ' ' + text.slice(0, 800));
    if (ex.some((t) => probe.includes(t))) continue;
    if (toks.every((t) => probe.includes(t))) out.push({ file: f, mtime: st.mtimeMs, text });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  const capped = out.slice(0, MAX_FRAGMENTS);
  let total = 0;
  return capped.filter((x) => { total += x.text.length; return total <= MAX_TOTAL_CHARS; });
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

function sectionPrompt({ goal, heading, material, sources }) {
  const srcList = sources.map((s) => `[${s.n}] ${s.title ? s.title + ' — ' : ''}${s.url}`).join('\n');
  return `You are writing ONE section of a finished research paper. Goal of the paper: ${goal}\n`
    + `SECTION: "${heading}"\n\n`
    + `THE NUMBERED SOURCE LIST (the ONLY citable sources):\n${srcList}\n\n`
    + `THE GATHERED MATERIAL (the ONLY facts you may use):\n${material.slice(0, 24000)}\n\n`
    + `Write the section now, 250-450 words, polished prose (no bullet dumps unless the content is a list by nature). `
    + `EVERY factual claim that traces to a source carries an inline citation like [3] using ONLY numbers from the list above. `
    + `A claim you cannot trace to the material is OMITTED — never invented, never uncited. `
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
async function finalize({ topic, title, goal, tokens, exclude, write, dir = NOTES_DIR, outDir = NOTES_DIR, land = true } = {}) {
  const toks = tokens && tokens.length ? tokens : _norm(topic).split(' ').filter(Boolean);
  const fragments = gatherFragments({ tokens: toks, exclude, dir });
  if (!fragments.length) return { ok: false, reason: `no fragments for "${topic}"` };
  const sources = harvestSources(fragments);
  const heads = outline(fragments);
  const material = fragments.map((f) => `--- from ${f.file} ---\n${f.text}`).join('\n\n');
  const sections = [];
  // CoT-REJECT (2026-08-13, first live run): a reasoning model that returns EMPTY content gets its
  // chain-of-thought salvaged by the ollama lib — "We need to write the section…" landed as body
  // text. Deliberation about the task is never the paper; reject it and let the section drop
  // (an honest thin paper beats a poisoned one; the caller sees the section count).
  const COT_RE = /^\s*(?:We (?:need|must|should|have to)|Let'?s|The (?:instruction|user|task) (?:says|asks|wants))\b|\bthe numbered source list\b/i;
  for (const heading of heads) {
    let body = '';
    try { body = String(await write(sectionPrompt({ goal: goal || topic, heading, material, sources })) || ''); } catch {}
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
  return { ok: true, path: outPath, sections: sections.length, sourceCount: sources.length, fragments: fragments.length };
}

module.exports = { gatherFragments, harvestSources, outline, sectionPrompt, assemble, finalize, NOTES_DIR, DEFAULT_SECTIONS };
