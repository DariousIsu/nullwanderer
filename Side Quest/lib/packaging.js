/**
 * lib/packaging.js — the "package that" command: finished markdown → ONE branded document.
 *
 * Lucas's contract (2026-07-21/22): she writes plain markdown and STOPS; packaging is HIS command.
 * The shapes live in studio/doc_shapes (four types, one hardcoded brand, pure renderer). This module
 * is the missing wiring: detect the command, resolve WHICH document he means, map its markdown into
 * the shape's sections (content preserved — packaging reorganizes, it never rewrites), check the
 * cited sources (his call 2026-07-22: verify cited docs only; op-eds/memos package immediately),
 * and render. The artifact lands as a file beside the certs + a pointer where the doc lives.
 *
 * Pure decision/formatting logic with injected IO → offline-smokeable (scripts/smoke_packaging.js).
 * The live executor (file write, canvas pointer, chat lines) is the main.js PACKAGE VERB block.
 */
'use strict';

const SHAPE_WORDS = [
  [/\bresearch\s+paper\b|\bpaper\b/i, 'research_paper'],
  [/\bpolicy\s+brief\b|\bbrief(?:ing)?\b/i, 'policy_brief'],
  [/\bop[\s-]?ed\b|\bopinion\s+piece\b/i, 'op_ed'],
  [/\breport\b|\bmemo(?:randum)?\b/i, 'report'],
];

// ---- the command detector -------------------------------------------------
// Imperative-only, by the detectors-vs-comprehension rule: "package that as a brief" fires;
// "how should we package this?" is a question about packaging and must NOT fire.
// VERB-OBJECT form only: "package that / package the dossier / brand it / package up the brief".
// A bare noun use ("the package arrived") must never fire — the noun is the false-positive class.
const VERB_OBJ_RE = /\b(?:package|brand)\s+(?:up\s+)?(?:that|this|it|the\b|my\b|our\b|your\b)/i;
const HOUSE_RE = /\bapply\s+(?:the\s+)?house\s+style\b/i;
const QUESTION_LEAD_RE = /^\s*(?:how|what|why|when|where|which|who)\b/i;
function detectCommand(text) {
  const s = String(text || '').trim();
  if (!s || s.length > 400) return null;                 // a command is short; a long message is content
  if (!VERB_OBJ_RE.test(s) && !HOUSE_RE.test(s) && !/^\s*package\s*$/i.test(s)) return null;
  if (QUESTION_LEAD_RE.test(s)) return null;             // "how do we package…" = a question, answer it normally
  if (/\bdon'?t\s+(?:package|brand)\b|\bnot\s+(?:package|brand)\b/i.test(s)) return null;
  let type = null;
  for (const [re, key] of SHAPE_WORDS) { if (re.test(s)) { type = key; break; } }
  return { type };
}

// ---- resolve WHICH document he means --------------------------------------
// Candidates: durable canvas DOC tabs (lib/canvas_docs.all()) + the last research dossier
// (meta research.last_dossier → file). Explicit title-word match beats recency; recency breaks ties.
function _blockMarkdown(b) {
  const d = (b && b.data) || {};
  return String(d.markdown || d.text || d.content || '').trim();
}
function _titleMatchScore(message, title) {
  const words = String(title || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3);
  if (!words.length) return 0;
  const m = String(message || '').toLowerCase();
  const hit = words.filter((w) => m.includes(w)).length;
  return hit / words.length;
}
function resolveTarget({ message = '', deps = {} } = {}) {
  const candidates = [];
  try {
    const all = (deps.canvasAll || (() => require('./canvas_docs').all()))() || [];
    for (const t of all) {
      if (String(t.mode || 'DOC').toUpperCase() !== 'DOC') continue;
      const md = (t.blocks || []).map(_blockMarkdown).filter(Boolean).join('\n\n');
      if (md.length < 200) continue;                     // an empty/near-empty tab is not packageable
      candidates.push({ source: 'canvas', tabKey: t.tabKey, title: t.title || t.tabKey, markdown: md, at: t.openedAt || 0 });
    }
  } catch (e) { console.error('[packaging] canvas candidates failed:', e.message); }
  try {
    const getMeta = deps.getMeta || ((k) => require('./db').getMeta(k));
    const last = JSON.parse(getMeta('research.last_dossier') || 'null');
    if (last && last.path) {
      const read = deps.readFile || ((p) => { const r = require('./files').fileReadFull(p); return (r && r.text) || ''; });
      const md = String(read(last.path) || '');
      if (md.trim().length >= 200) candidates.push({ source: 'dossier', path: last.path, title: last.goal || 'the research dossier', markdown: md, at: 0 });
    }
  } catch (e) { console.error('[packaging] dossier candidate failed:', e.message); }
  if (!candidates.length) return null;
  let best = null, bestScore = -1;
  for (const c of candidates) {
    const s = _titleMatchScore(message, c.title);
    if (s > bestScore + 1e-9 || (Math.abs(s - bestScore) < 1e-9 && (best === null || (c.at || 0) > (best.at || 0)))) { best = c; bestScore = s; }
  }
  return best;
}

// ---- shape inference (when the command didn't name one) -------------------
function inferType(markdown, commandType = null) {
  if (commandType) return commandType;
  const md = String(markdown || '');
  if (/^#{1,3}\s*(abstract|methodology)/im.test(md)) return 'research_paper';
  if (/^#{1,3}\s*(executive summary|policy options|recommendations?)/im.test(md)) return 'policy_brief';
  if (/^#{1,3}\s*(counterargument|call to action)/im.test(md)) return 'op_ed';
  return 'report';
}

// ---- citations ------------------------------------------------------------
function extractCitations(markdown) {
  const urls = new Set();
  const re = /https?:\/\/[^\s)\]>"']+/g;
  let m;
  while ((m = re.exec(String(markdown || ''))) !== null) urls.add(m[0].replace(/[.,;:]+$/, ''));
  return [...urls];
}

/** Verify cited docs only (Lucas 2026-07-22). Bounded plain fetches — reachability, not deep
 *  fact-checking (that is the editor's lane). Returns an honest note for the document footer. */
async function verifySources(urls, { fetchFn = null, limit = 8, timeoutMs = 8000, now = Date.now() } = {}) {
  const list = (urls || []).slice(0, limit);
  if (!list.length) return { checked: 0, ok: 0, note: '', results: [] };
  const f = fetchFn || ((u, opts) => fetch(u, opts));
  const results = [];
  for (const url of list) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await f(url, { method: 'GET', redirect: 'follow', signal: ctrl.signal });
      results.push({ url, ok: !!(res && res.status >= 200 && res.status < 400), status: res && res.status });
    } catch (e) { results.push({ url, ok: false, status: null, error: e && e.message }); }
    finally { clearTimeout(t); }
  }
  const ok = results.filter((r) => r.ok).length;
  const skipped = (urls || []).length - list.length;
  const when = (() => { try { return require('./tz').dateShort(now); } catch { return new Date(now).toISOString().slice(0, 10); } })();
  const note = `Source check (${when}): ${ok} of ${list.length} cited link${list.length === 1 ? '' : 's'} reachable at packaging time`
    + (skipped > 0 ? `; ${skipped} more not checked (per-run bound)` : '')
    + (ok < list.length ? ` — ${list.length - ok} did not respond and should be re-verified` : '') + '.';
  return { checked: list.length, ok, note, results };
}

// ---- sectionize: markdown → the shape's sections (content preserved) ------
function sectionizeWant(type) {
  const shapes = require('../studio/doc_shapes');
  const shape = shapes.shapeFor(type);
  const keys = shape.sections.map((s) => `"${s.key}" (${s.title}: ${s.note})`).join(', ');
  return `Reorganize the DOCUMENT below into the sections of a ${shape.label}. Reply with ONLY strict JSON — an object whose keys are among: ${keys}.
Rules: PRESERVE the document's own wording — move and group paragraphs, do not rewrite, summarize, or invent. Every substantive paragraph of the document must appear under exactly one key. If nothing in the document fits a section, omit that key (never write a placeholder). Values are markdown strings.`;
}
function validateSectionize(type, sourceMarkdown) {
  const shapes = require('../studio/doc_shapes');
  const shape = shapes.shapeFor(type);
  const valid = new Set(shape.sections.map((s) => s.key));
  const srcLen = String(sourceMarkdown || '').length;
  return (raw) => {
    try {
      const m = String(raw || '').match(/\{[\s\S]*\}/);
      if (!m) return { valid: false, error: 'no JSON object' };
      const o = JSON.parse(m[0]);
      const out = {};
      let total = 0;
      for (const [k, v] of Object.entries(o)) {
        if (!valid.has(k) || typeof v !== 'string' || !v.trim()) continue;
        out[k] = v.trim();
        total += out[k].length;
      }
      if (!Object.keys(out).length) return { valid: false, error: 'no recognizable sections' };
      // Anti-drop guard: a "reorganization" that lost most of the document is a rewrite, not a
      // packaging. (Markdown syntax/whitespace shrinks a little; half gone means content gone.)
      if (srcLen >= 400 && total < srcLen * 0.5) return { valid: false, error: `content dropped (${total}/${srcLen} chars kept)` };
      return { valid: true, value: out };
    } catch (e) { return { valid: false, error: e.message }; }
  };
}
// Deterministic fallback when the cloud can't sectionize: the WHOLE document rides in the shape's
// main long-form section, and the missing required sections render as the shape's honest
// placeholders. Ugly-but-honest beats reorganized-but-lossy.
const FALLBACK_MAIN = { research_paper: 'results', policy_brief: 'analysis', op_ed: 'body', report: 'body' };
function fallbackSections(type, markdown) {
  return { [FALLBACK_MAIN[type] || 'body']: String(markdown || '').trim() };
}

/** Map markdown into shape sections via the cloud broker; deterministic fallback on null. */
async function sectionize({ type, markdown, title = '', deps = {} } = {}) {
  const ask = deps.ask || require('./cloud_logic').ask;
  let out = null;
  try {
    out = await ask({
      task: 'package_sectionize', v: 1,
      input: { title, document: String(markdown || '').slice(0, 60000) },
      want: sectionizeWant(type),
      validate: validateSectionize(type, markdown),
      numPredict: 8000,        // the whole reorganized document comes back — never clip it
      think: false,
    });
  } catch (e) { console.error('[packaging] sectionize failed:', e.message); }
  return out || fallbackSections(type, markdown);
}

// ---- title + filename -----------------------------------------------------
function titleFrom(markdown, fallback = 'Untitled') {
  const m = String(markdown || '').match(/^#\s+(.+)$/m);
  return (m ? m[1] : fallback).replace(/[*_#`]/g, '').trim().slice(0, 140) || fallback;
}
function fileSlug(title, now = Date.now()) {
  const slug = String(title || 'document').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'document';
  return `${new Date(now).toISOString().slice(0, 10)}-${slug}`;
}

/** Render the branded HTML (pure), with the source-check note appended as a footer when present. */
function renderPackaged({ type, title, sections, verifyNote = '', now = Date.now() } = {}) {
  const shapes = require('../studio/doc_shapes');
  let html = shapes.renderDocument({ type, title, sections, date: now });
  if (verifyNote) {
    html = html.replace('</body>', `  <p class="small" style="color:var(--muted);margin-top:18pt;border-top:1pt solid var(--rule-soft);padding-top:6pt">${String(verifyNote).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</p>\n</body>`);
  }
  return html;
}

/** POST-RENDER SELF-CHECK (O5 — the harness rule: an artifact you didn't re-open is a guess).
 *  Deterministic re-open of what was JUST produced: the files exist and are non-trivial, the PDF
 *  actually has pages, every section the sectionizer produced appears in the rendered HTML by its
 *  title, and every cited link from the SOURCE survived into the render (a package that lost its
 *  citations is a rewrite). Pure verdict — the caller decides what the announce says; a failed
 *  check must report the MISS, never success. */
function selfCheck({ type, sections = {}, sourceMarkdown = '', htmlPath = null, pdfPath = null, subject = '', deps = {} } = {}) {
  const fs = deps.fs || require('fs');
  const checks = [];
  const add = (name, ok, note = '') => checks.push({ name, ok: !!ok, note: String(note).slice(0, 120) });
  let html = '';
  try {
    if (htmlPath) {
      const st = fs.statSync(htmlPath);
      html = String(fs.readFileSync(htmlPath, 'utf8'));
      add('html file', st.size > 500 && html.length > 500, `${st.size} bytes`);
    } else add('html file', false, 'no html path');
  } catch (e) { add('html file', false, e.message); }
  const H = html.replace(/&amp;/g, '&');
  if (pdfPath) {
    try {
      const st = fs.statSync(pdfPath);
      const pages = (fs.readFileSync(pdfPath).toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
      add('pdf', st.size > 1000 && pages > 0, `${st.size} bytes, ${pages} page(s)`);
    } catch (e) { add('pdf', false, e.message); }
  }
  try {
    const shape = require('../studio/doc_shapes').shapeFor(type);
    for (const s of shape.sections) {
      if (!sections[s.key] || !String(sections[s.key]).trim()) continue;   // absent input = missingSections' report, not a render failure
      add(`section "${s.title}"`, H.includes(s.title), H.includes(s.title) ? '' : 'title not in the render');
    }
  } catch (e) { add('sections', false, e.message); }
  const cites = extractCitations(sourceMarkdown).slice(0, 20);
  if (cites.length) {
    const lost = cites.filter((u) => !H.includes(u));
    add('citations survive', lost.length === 0, lost.length ? `${lost.length}/${cites.length} lost (first: ${lost[0].slice(0, 60)})` : `${cites.length}/${cites.length} present`);
  }
  // TIER GATE (S2) — the epistemic half of the self-check. Every other check above asks whether the
  // document RENDERED; this one asks whether it should go out at all. A figure with no source is
  // Tier 3 and must not print; a figure from an interested party that the prose does not attribute
  // is Tier 2 with its condition unmet. Reports only — it never edits the draft, and it never
  // touches the store (her memory keeps weak claims on purpose; this is about what gets PRINTED).
  try {
    const tg = require('./tier_gate');
    const t = tg.checkDraft({ markdown: sourceMarkdown, subject });
    if (t.counts.loadBearing > 0 || !t.ok) {
      add('every figure is sourced', t.counts.uncited === 0,
        t.counts.uncited ? `${t.counts.uncited} uncited of ${t.counts.loadBearing} — Tier 3, must not print` : `${t.counts.loadBearing} load-bearing, all cited`);
      if (subject) {
        add('interested figures are attributed', t.counts.unattributed === 0,
          t.counts.unattributed ? `${t.counts.unattributed} sourced to ${subject} without saying so` : 'attributed where interested');
      }
    }
  } catch (e) { add('tier gate', false, e.message); }
  const failed = checks.filter((c) => !c.ok);
  return {
    ok: failed.length === 0, checks, failed,
    summary: failed.length
      ? `${failed.map((c) => `${c.name}${c.note ? ` (${c.note})` : ''}`).join('; ')}`
      : `${checks.length} check(s) green (file, render, sections, citations)`,
  };
}

module.exports = {
  detectCommand, resolveTarget, inferType, extractCitations, verifySources,
  sectionize, sectionizeWant, validateSectionize, fallbackSections, FALLBACK_MAIN,
  titleFrom, fileSlug, renderPackaged, selfCheck, SHAPE_WORDS,
};
