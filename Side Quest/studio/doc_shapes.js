/*
 * studio/doc_shapes.js — WHAT each kind of document is made of, and ONE brand for all of them.
 *
 * Lucas, 2026-07-21: "A research paper, a briefing, an op-ed, a report all have different meanings
 * and shapes that will be different format. The instruction is to make the branding hardcoded
 * universal. it doesnt need to be perfect today as long the information is there but I dont want the
 * hard code base to be wrong."
 *
 * So the split is deliberate and is the part that has to be right:
 *
 *   SHAPE  varies per type — the ordered sections, what each is FOR, and its length discipline.
 *          Data, not code. Adding a fifth type is a new entry in SHAPES, nothing else.
 *   BRAND  does NOT vary. One hardcoded house style, imported from studio/cert_template (the
 *          existing Rainey palette, masthead and typography) rather than copied. Two copies of a
 *          brand drift, and then nothing tells you which is the house style.
 *
 * Rendering is PURE CODE — no model, no prose generation. Sections in, branded HTML out. That is the
 * same determinism law the certification path already follows, and it is why the output can be
 * trusted without review.
 *
 * The shapes below are Lucas's own specification, kept close to his wording on purpose: if the
 * definition of a policy brief changes, it should change HERE, in one legible place.
 *
 * Node + browser (CommonJS with a window fallback), matching cert_template.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.DocShapes = api;
})(this, function () {
  'use strict';

  const cert = (typeof require === 'function') ? require('./cert_template') : (typeof window !== 'undefined' ? window.CertTemplate : null);
  const esc = (cert && cert.esc) || ((s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])));
  // Dates are EASTERN (lib/tz). cert_template's fmtDate reads the HOST zone off a raw timestamp,
  // which rendered a UTC-midnight date as the PREVIOUS day — a document dated the day before it was
  // written. Browser builds have no `require`, so the cert formatter remains the fallback there.
  const _tz = (typeof require === 'function') ? (() => { try { return require('../lib/tz'); } catch { return null; } })() : null;
  const fmtDate = (_tz && _tz.dateShort) || (cert && cert.fmtDate) || ((ms) => new Date(ms).toISOString().slice(0, 10));

  /**
   * THE FOUR SHAPES. `key` is the section id the builder fills; `required` marks what the type is
   * not itself without; `note` is the guidance shown when a section is missing, so an incomplete
   * document says what belongs there instead of hiding the gap.
   */
  const SHAPES = {
    research_paper: {
      label: 'Research Paper',
      purpose: 'To present original research, methodologies, and scholarly findings to an academic or scientific community.',
      sections: [
        { key: 'abstract', title: 'Abstract', required: true, note: '150–250 words: the problem, methods, results and conclusion.' },
        { key: 'introduction', title: 'Introduction', required: true, note: 'Background context, the research question, and the gap in current literature.' },
        { key: 'methodology', title: 'Methodology', required: true, note: 'How the data was collected and analyzed, in enough detail to be repeated.' },
        { key: 'results', title: 'Results', required: true, note: 'The findings as fact, without interpretation.' },
        { key: 'discussion', title: 'Discussion & Conclusion', required: true, note: 'What the results mean, the limitations, and the implications.' },
        { key: 'references', title: 'References', required: true, note: 'Formatted to a consistent style guide (APA or MLA).' },
      ],
    },
    policy_brief: {
      label: 'Policy Brief',
      purpose: 'To give decision-makers a synthesized overview of a complex problem and offer clear, evidence-based solutions.',
      sections: [
        { key: 'executive_summary', title: 'Executive Summary', required: true, note: 'The core problem, the key findings, and the main recommendation.' },
        { key: 'problem', title: 'Statement of the Problem', required: true, note: 'Why the current situation is failing and needs policy intervention.' },
        { key: 'analysis', title: 'Analysis & Findings', required: true, note: 'Highly summarized data supporting the options; charts and tables belong here.' },
        { key: 'options', title: 'Policy Options', required: true, note: '2–3 potential actions, each with its pros and cons.' },
        { key: 'recommendations', title: 'Recommendations', required: true, note: 'The definitive course of action, and the next steps.' },
        { key: 'references', title: 'Sources', required: false, note: 'Where each figure came from.' },
      ],
      titleRule: '25 words or less, action-oriented.',
    },
    op_ed: {
      label: 'Op-Ed',
      purpose: 'To persuade the public or policymakers on an issue of public interest, using expert opinion.',
      sections: [
        { key: 'hook', title: 'Hook', required: true, note: 'An anecdote, surprising fact or controversy that earns the next paragraph.' },
        { key: 'thesis', title: 'Thesis', required: true, note: 'The main argument in one clear sentence, in the first or second paragraph.' },
        { key: 'body', title: 'Argument', required: true, note: '2–3 supporting points with light data and relatable examples. No academic jargon.' },
        { key: 'counterargument', title: 'Counterargument', required: true, note: 'The most obvious criticism, acknowledged and answered.' },
        { key: 'conclusion', title: 'Conclusion', required: true, note: 'Restate the thesis and end on a call to action.' },
      ],
      lengthRule: 'Typically 700–800 words.',
    },
    report: {
      label: 'Report',
      purpose: 'To inform and analyze objectively, for internal business or organizational use.',
      sections: [
        { key: 'introduction', title: 'Introduction', required: true, note: 'The objective of the report and the background to it.' },
        { key: 'body', title: 'Findings', required: true, note: 'Divided by clear headings and subheadings.' },
        { key: 'methodology', title: 'Methodology', required: true, note: 'How the information was gathered.' },
        { key: 'conclusions', title: 'Conclusions', required: true, note: 'An objective summary of what the facts mean.' },
        { key: 'recommendations', title: 'Recommendations', required: true, note: 'Actionable next steps, based strictly on the findings above.' },
      ],
      hasToc: true,
    },
  };

  const TYPES = Object.keys(SHAPES);
  function shapeFor(type) { return SHAPES[String(type || '').toLowerCase()] || null; }

  /** Which required sections have no content — reported IN the document, never silently dropped. */
  function missingSections(type, sections = {}) {
    const s = shapeFor(type);
    if (!s) return [];
    return s.sections.filter((sec) => sec.required && !String((sections || {})[sec.key] || '').trim());
  }

  // ── minimal markdown → HTML ─────────────────────────────────────────────────────────────────
  // Deliberately small: headings, bold/italic, links, lists, paragraphs. She writes plain markdown
  // (that is the whole point of the split), so this only has to cover what she actually writes.
  // Anything unrecognised passes through ESCAPED — a renderer must never emit raw input as markup.
  function mdToHtml(md) {
    const src = String(md == null ? '' : md).replace(/\r\n?/g, '\n').trim();
    if (!src) return '';
    const inline = (t) => esc(t)
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
    const out = [];
    let list = null;
    const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
    for (const raw of src.split('\n')) {
      const line = raw.trim();
      if (!line) { closeList(); continue; }
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) { closeList(); out.push(`<h${h[1].length + 1}>${inline(h[2])}</h${h[1].length + 1}>`); continue; }
      const ul = line.match(/^[-*•]\s+(.*)$/);
      if (ul) { if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(ul[1])}</li>`); continue; }
      const ol = line.match(/^\d+[.)]\s+(.*)$/);
      if (ol) { if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inline(ol[1])}</li>`); continue; }
      closeList();
      out.push(`<p>${inline(line)}</p>`);
    }
    closeList();
    return out.join('\n');
  }

  /**
   * Render a finished document: ONE brand, the shape's sections in the shape's order.
   *
   * a = { type, title, subtitle?, sections:{key→markdown}, author?, date?, sources?[] }
   *
   * A missing REQUIRED section renders as a visible placeholder saying what belongs there. That is
   * the honest choice: a packaged document that quietly omits its methodology looks finished and
   * is not.
   */
  function renderDocument(a = {}) {
    const shape = shapeFor(a.type);
    if (!shape) throw new Error(`unknown document type: ${a.type}`);
    const when = a.date || Date.now();
    const title = String(a.title || 'Untitled').trim();
    const sections = a.sections || {};
    const missing = missingSections(a.type, sections);

    const body = shape.sections.map((sec, i) => {
      const content = String(sections[sec.key] || '').trim();
      const num = `<span class="num">${i + 1}</span>`;
      if (content) return `<h2>${num}${esc(sec.title)}</h2>\n${mdToHtml(content)}`;
      if (!sec.required) return '';
      return `<h2>${num}${esc(sec.title)}</h2>\n<p class="small" style="color:var(--muted)"><em>Not written yet — ${esc(sec.note)}</em></p>`;
    }).filter(Boolean).join('\n\n');

    const toc = shape.hasToc
      ? `<div class="toc"><b>Contents</b><ol>${shape.sections.map((s) => `<li>${esc(s.title)}</li>`).join('')}</ol></div>`
      : '';

    const gap = missing.length
      ? `<div class="gap-note"><b>Incomplete.</b> ${missing.length} required section${missing.length > 1 ? 's are' : ' is'} not written yet: ${missing.map((s) => esc(s.title)).join(', ')}.</div>`
      : '';

    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${esc(title)}</title>
<style>${(cert && cert.STYLE) || ''}
  .toc{background:var(--rule-soft);border-left:2pt solid var(--purple);padding:8pt 12pt;margin:12pt 0;font-size:9.5pt;}
  .toc ol{margin:4pt 0 0 14pt;padding:0;} .toc li{margin:1pt 0;}
  .gap-note{background:var(--warn-tint);border-left:2pt solid var(--warn);padding:8pt 12pt;margin:12pt 0;font-size:9.5pt;color:var(--warn);}
  .doc-meta{color:var(--muted);font-size:9pt;margin:0 0 14pt 0;}
</style></head>
<body>
  <div class="mast">
    <div class="org"><div class="name">${esc((cert && cert.ORG_NAME) || 'Joseph Rainey Center for Public Policy')}</div>
      <div class="tag">${esc(shape.label)}</div></div>
    <div class="mast-right"><div class="label">${esc(shape.label)}</div>
      <div style="margin-top:4pt"><b>Date</b> ${esc(fmtDate(when))}</div>
      ${a.author ? `<div><b>Author</b> ${esc(a.author)}</div>` : ''}</div>
  </div>

  <h1>${esc(title)}</h1>
  ${a.subtitle ? `<p class="subtitle">${esc(a.subtitle)}</p>` : ''}
  <p class="doc-meta">${esc(shape.purpose)}</p>
  ${gap}
  ${toc}

  ${body}
</body></html>`;
  }

  return { SHAPES, TYPES, shapeFor, missingSections, renderDocument, mdToHtml };
});
