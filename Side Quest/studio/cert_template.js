/*
 * Editor Studio — STANDARDIZED certification template (B5).
 *
 * The determinism law applied to the cert: ONE input shape (the findings contract output
 * {findings, suggestions, summary} + doc metadata + cert number) → ONE output (a self-contained
 * Rainey-branded HTML cert), rendered by PURE CODE. No LLM, no prose generation — every sentence
 * is templated from the structured verdict counts. Mirrors the proven 17-cert floor
 * (raineycenter palette, masthead, ruling card, KPIs, per-claim table, recommended corrections,
 * seal w/ CFC id) but populated only from data the harness actually produces.
 *
 * Verdict → pill: ok→pass · warn→warn · bad→fail · info→info (matches the reference cert classes).
 *
 * Runs in Node (offline smoke) and the browser: CommonJS + window fallback.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.CertTemplate = api;
})(this, function () {
  'use strict';

  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const PILL = { ok: 'pass', warn: 'warn', bad: 'fail', info: 'info' };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  function fmtDate(ms) { const d = new Date(ms); return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`; }

  // Deterministic ruling from the verdict tally — the cert's verdict is a pure function of counts.
  function gradeFor(summary) {
    const v = (summary && summary.byVerdict) || {};
    const bad = v.bad || 0, warn = v.warn || 0;
    if (bad > 0) return { key: 'hold', cls: 'fail', stamp: 'Hold — corrections required', label: 'Hold',
      ruling: `Not cleared — ${bad} material issue${bad > 1 ? 's' : ''} must be corrected before publication` };
    if (warn > 0) return { key: 'conditional', cls: 'warn', stamp: 'Cleared — w/ corrections', label: 'Cleared w/ corrections',
      ruling: `Cleared for publication — ${warn} revision${warn > 1 ? 's' : ''} recommended` };
    return { key: 'clear', cls: 'pass', stamp: 'Cleared for publication', label: 'Cleared',
      ruling: 'Cleared for publication — no outstanding issues' };
  }

  function scorelineOf(summary) {
    const v = (summary && summary.byVerdict) || {};
    return `${v.ok || 0} verified · ${v.warn || 0} caveat · ${v.bad || 0} issue${(v.bad || 0) === 1 ? '' : 's'} · ${v.info || 0} info`;
  }

  const STYLE = `
  :root{--purple:#662d91;--purple-dark:#2a0c6a;--purple-darker:#1a0540;--purple-tint:#eee2fe;--gold:#f2c91e;
    --ink:#1a1d22;--body:#2c2f36;--muted:#61666a;--rule:#d6d3df;--rule-soft:#ece9f2;
    --pass:#15803d;--pass-tint:#e8f4ec;--warn:#a16207;--warn-tint:#fdf6e3;--fail:#b91c1c;--fail-tint:#fcefef;--info:#0050b6;--info-tint:#e7eefb;}
  *{box-sizing:border-box;} html,body{margin:0;padding:0;}
  body{font-family:"Hanken Grotesk","Helvetica Neue",Helvetica,Arial,sans-serif;color:var(--body);line-height:1.5;font-size:10.5pt;background:#fff;padding:28px 32px;}
  .mast{display:flex;align-items:center;justify-content:space-between;padding-bottom:12pt;border-bottom:1.25pt solid var(--purple);margin-bottom:14pt;}
  .org .name{font-weight:800;text-transform:uppercase;letter-spacing:0.12em;font-size:9pt;color:var(--purple);}
  .org .tag{color:var(--muted);font-size:8.5pt;margin-top:1pt;}
  .mast-right{text-align:right;font-size:8.5pt;color:var(--muted);line-height:1.5;}
  .mast-right .label{display:inline-block;padding:2pt 7pt;background:var(--purple);color:#fff;border-radius:2pt;font-weight:700;letter-spacing:0.1em;font-size:7.5pt;text-transform:uppercase;}
  .mast-right b{color:var(--purple-dark);}
  h1{font-size:21pt;line-height:1.1;color:var(--purple-darker);margin:4pt 0 4pt 0;font-weight:800;}
  .subtitle{color:var(--muted);font-size:10.5pt;margin:0 0 12pt 0;} .doc-name{color:var(--ink);font-weight:600;}
  h2{font-size:11pt;font-weight:800;color:var(--purple);text-transform:uppercase;letter-spacing:0.1em;margin:16pt 0 6pt 0;padding-bottom:4pt;border-bottom:0.75pt solid var(--rule);}
  h2 .num{display:inline-block;min-width:18pt;color:var(--gold);font-weight:800;}
  .meta{display:grid;grid-template-columns:96pt minmax(0,1fr) 96pt minmax(0,1fr);gap:4pt 14pt;background:var(--purple-tint);border-left:3pt solid var(--purple);padding:9pt 12pt;margin:0 0 10pt 0;font-size:9pt;}
  .meta dt{color:var(--purple-dark);font-weight:700;text-transform:uppercase;letter-spacing:0.04em;font-size:8pt;align-self:center;}
  .meta dd{margin:0;color:var(--ink);align-self:center;}
  .ruling-card{display:grid;grid-template-columns:84pt 1fr;margin:4pt 0 14pt 0;border:1.25pt solid var(--purple);border-radius:2pt;overflow:hidden;}
  .ruling-stamp{background:var(--purple);color:#fff;padding:14pt 10pt;text-align:center;display:flex;flex-direction:column;justify-content:center;align-items:center;}
  .ruling-stamp .check{width:26pt;height:26pt;border-radius:50%;background:var(--gold);color:var(--purple-darker);display:flex;align-items:center;justify-content:center;font-size:16pt;font-weight:900;margin-bottom:5pt;}
  .ruling-stamp .grade{font-size:8.5pt;font-weight:700;letter-spacing:0.04em;}
  .ruling-body{padding:12pt 14pt;} .ruling-body .ruling{font-size:13pt;font-weight:800;color:var(--purple-darker);margin:0 0 6pt 0;}
  .ruling-body .scoreline{font-size:9.5pt;color:var(--muted);} .ruling-body .scoreline b{color:var(--purple-dark);}
  .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:8pt;margin:4pt 0 12pt 0;}
  .kpi{border:0.75pt solid var(--rule);border-top:2.5pt solid var(--purple);padding:8pt 10pt;}
  .kpi .n{font-size:18pt;font-weight:800;color:var(--purple-darker);line-height:1;} .kpi .lbl{font-size:8pt;color:var(--muted);text-transform:uppercase;letter-spacing:0.06em;margin-top:4pt;}
  .kpi.gold{border-top-color:var(--gold);} .kpi.warn{border-top-color:var(--warn);} .kpi.fail{border-top-color:var(--fail);}
  table{width:100%;border-collapse:collapse;font-size:9pt;table-layout:fixed;}
  th,td{border-bottom:0.5pt solid var(--rule);padding:5pt 6pt;vertical-align:top;text-align:left;word-wrap:break-word;overflow-wrap:break-word;}
  thead th{background:var(--purple-darker);color:#fff;font-size:8.5pt;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;border-bottom:none;}
  tbody tr:nth-child(even) td{background:var(--rule-soft);}
  td.num,th.num{text-align:center;font-weight:800;color:var(--purple);}
  col.c-num{width:5%;} col.c-claim{width:34%;} col.c-status{width:16%;} col.c-finding{width:45%;}
  .pill{display:inline-block;padding:2pt 7pt;border-radius:8pt;font-size:7.5pt;font-weight:800;text-transform:uppercase;letter-spacing:0.04em;border:0.75pt solid;line-height:1.25;text-align:center;}
  .pill.pass{color:var(--pass);border-color:var(--pass);background:var(--pass-tint);}
  .pill.warn{color:var(--warn);border-color:var(--warn);background:var(--warn-tint);}
  .pill.fail{color:var(--fail);border-color:var(--fail);background:var(--fail-tint);}
  .pill.info{color:var(--info);border-color:var(--info);background:var(--info-tint);}
  .small{font-size:8.5pt;color:var(--muted);} .src{font-family:"Courier New",monospace;font-size:8pt;color:var(--muted);word-break:break-all;}
  ol.fixes{margin:4pt 0 8pt 18pt;padding:0;} ol.fixes li{margin-bottom:5pt;} .diff-b{color:var(--fail);} .diff-a{color:var(--pass);}
  .signoff{margin-top:16pt;padding-top:10pt;border-top:0.75pt solid var(--rule);display:grid;grid-template-columns:1.4fr 1fr;gap:16pt;font-size:9pt;}
  .auditor-note strong{color:var(--purple-dark);}
  .seal{border:1.25pt solid var(--purple-dark);background:linear-gradient(135deg,#fff 60%,var(--purple-tint) 100%);padding:12pt;text-align:center;}
  .seal .lbl{font-size:8pt;letter-spacing:0.12em;text-transform:uppercase;color:var(--muted);}
  .seal .stamp{font-size:13pt;font-weight:800;color:var(--purple-darker);margin:6pt 0 4pt 0;}
  .seal .meta-line{font-size:8.5pt;color:var(--muted);margin:1pt 0;} .seal .id-line{font-family:"Courier New",monospace;font-size:8pt;color:var(--purple);margin-top:6pt;}
  `;

  function claimRows(findings) {
    if (!findings || !findings.length) return `<tr><td class="num">—</td><td colspan="3" class="small">No verification units were extracted from this document.</td></tr>`;
    return findings.map((f, i) => {
      const cav = f.caveat && !String(f.ev || '').includes(f.caveat) ? ` <em>${esc(f.caveat)}</em>` : '';
      return `
      <tr><td class="num">${i + 1}</td>
        <td>${esc(f.label)}</td>
        <td><span class="pill ${PILL[f.verdict] || 'info'}">${esc(f.vlabel || f.status)}</span></td>
        <td>${esc(f.ev || '')}${cav}${f.locator ? ` <span class="src">${esc(f.locator)}</span>` : ''}</td></tr>`;
    }).join('');
  }

  // Deduped "Sources consulted" list across all findings (the deep verifier records what it actually read).
  function sourcesConsultedSection(findings, num) {
    const seen = new Set(), list = [];
    for (const f of (findings || [])) for (const s of (f.sources_consulted || [])) {
      if (!s || !s.url) continue;
      const k = String(s.url).replace(/#.*$/, '').replace(/\/+$/, '').toLowerCase();
      if (seen.has(k)) continue; seen.add(k); list.push(s);
    }
    if (!list.length) return '';
    const rows = list.map(s => `<li>${esc(s.title || s.url)} — <span class="src">${esc(s.url)}</span></li>`).join('');
    return `<h2><span class="num">${num}</span>Sources consulted</h2><ol class="fixes">${rows}</ol>`;
  }

  // FACT CHECK — the second lane, and the last section of the report. Everything above answers one
  // question: is the claim correctly sourced to the source the document CITED? This answers a
  // different one: what does the rest of the record say? It is ADVISORY — it never rules on the
  // author's sourcing and never moves the grade — so it is rendered plainly, after the verdicts,
  // and labelled as material to weigh rather than defects to fix.
  const STANCE_PILL = { corroborated: 'ok', contested: 'warn', mixed: 'warn', 'no-independent-source': 'info' };
  const STANCE_LABEL = { corroborated: 'Corroborated', contested: 'Countered', mixed: 'Mixed record', 'no-independent-source': 'No independent source' };

  function factCheckSection(factcheck, num) {
    const fc = factcheck || {};
    const items = Array.isArray(fc.items) ? fc.items : [];
    if (!fc.summary || !fc.summary.ran) return '';
    const head = `<h2><span class="num">${num}</span>Fact check — independent sources</h2>
      <p class="small">Separate from the citation audit above. These are OTHER sources on the same claims, gathered independently of what the document cites: corroboration where the record agrees, counter-evidence to weigh where it does not. <strong>Nothing here is a defect in the document's sourcing</strong>, and none of it affects the ruling above.</p>`;
    if (!items.length) return `${head}<p class="small">No claims were fact-checked in this pass.</p>`;

    // Lead with the claims where the record is split or against — that is what an author needs first.
    const order = { contested: 0, mixed: 1, corroborated: 2, 'no-independent-source': 3 };
    const sorted = items.slice().sort((a, b) => (order[a.stance] ?? 9) - (order[b.stance] ?? 9));
    const srcList = (list, kind) => (list || []).map(s =>
      `<li><span class="pill ${kind === 'counters' ? 'warn' : 'ok'}">${kind === 'counters' ? 'Counters' : 'Supports'}</span> ${esc(s.title || s.url)}${s.quote ? ` — <em>${esc(s.quote)}</em>` : ''} <span class="src">${esc(s.url)}</span></li>`).join('');

    const rows = sorted.map((f, i) => {
      const sources = srcList(f.countering, 'counters') + srcList(f.supporting, 'supports');
      return `<tr><td class="num">${i + 1}</td>
        <td>${esc(f.claim)}${f.uid ? ` <span class="src">${esc(f.uid)}</span>` : ''}</td>
        <td><span class="pill ${STANCE_PILL[f.stance] || 'info'}">${esc(STANCE_LABEL[f.stance] || f.stance)}</span></td>
        <td>${sources ? `<ol class="fixes">${sources}</ol>` : `<span class="small">${esc(f.note || '')}</span>`}</td></tr>`;
    }).join('');

    const s = fc.summary;
    const tally = `<p class="small">${s.checked} claim${s.checked === 1 ? '' : 's'} checked · ${s.corroborated} corroborated · ${s.contested} countered · ${s.mixed} mixed · ${s.none} with no independent source found.</p>`;
    return `${head}${tally}
      <table class="cite-table"><colgroup><col class="c-num"><col class="c-claim"><col class="c-status"><col class="c-finding"></colgroup>
        <thead><tr><th class="num">#</th><th>Claim</th><th>Independent record</th><th>Sources for consideration</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  function fixItems(suggestions) {
    if (!suggestions || !suggestions.length) return '<p class="small">No suggested replacements were generated for this audit.</p>';
    return `<ol class="fixes">${suggestions.map(s => `
      <li>${s.loc ? `<strong>${esc(s.loc)}</strong> — ` : ''}<span class="diff-b">${esc((s.beforeX || s.before || '').trim())}</span> → <span class="diff-a">${esc((s.afterO || s.after || '').trim())}</span>${s.src ? ` <span class="src">${esc(s.src)}</span>` : ''}</li>`).join('')}</ol>`;
  }

  /**
   * Render the standardized certification HTML.
   * @param {object} a  { doc:{title,author,current_version}, findings, suggestions, summary,
   *                      certNumber, issuedAt(ms), method?, auditor?, reaudit? }
   * @returns {string} a complete, self-contained HTML document
   */
  function renderCertificate(a) {
    const doc = a.doc || {};
    const findings = a.findings || [];
    const summary = a.summary || { byVerdict: {} };
    const v = summary.byVerdict || {};
    const g = gradeFor(summary);
    const issued = a.issuedAt != null ? a.issuedAt : Date.now();
    const method = a.method || 'Deterministic verification harness — source resolution, lexical + local-embedding match, caged model classification';
    const auditor = a.auditor || 'Zoe — Editor Studio (processed with AI assistance)';
    const title = doc.title || 'Untitled document';
    const ver = doc.current_version != null ? doc.current_version : 1;
    const total = summary.total != null ? summary.total : findings.length;

    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Citation &amp; Fact-Check Certification — ${esc(title)} (v${esc(ver)})</title>
<style>${STYLE}</style></head>
<body>
  <div class="mast">
    <div class="org"><div class="name">Joseph Rainey Center for Public Policy</div>
      <div class="tag">Citation &amp; Fact-Check Certification · Pre-publication review</div></div>
    <div class="mast-right"><div class="label">${esc(g.label)}</div>
      <div style="margin-top:4pt"><b>Cert ID</b> ${esc(a.certNumber || '—')}</div>
      <div><b>Issued</b> ${esc(fmtDate(issued))}</div></div>
  </div>

  <h1>Citation &amp; Fact-Check Certification</h1>
  <p class="subtitle">For: <span class="doc-name">${esc(title)}</span> · v${esc(ver)}<br>
    By ${esc(doc.author || 'Unknown author')} &nbsp;·&nbsp; ${a.reaudit ? 'Re-audit' : 'Initial audit'}</p>

  <dl class="meta">
    <dt>Document</dt><dd>${esc(title)} (v${esc(ver)})</dd>
    <dt>Author</dt><dd>${esc(doc.author || '—')}</dd>
    <dt>Claims audited</dt><dd>${esc(total)}</dd>
    <dt>Cert ID</dt><dd>${esc(a.certNumber || '—')}</dd>
    <dt>Method</dt><dd>${esc(method)}</dd>
    <dt>Auditor</dt><dd>${esc(auditor)}</dd>
  </dl>

  <div class="ruling-card">
    <div class="ruling-stamp"><div class="check">${g.key === 'hold' ? '!' : '&#10003;'}</div><div class="grade">${esc(g.label)}</div></div>
    <div class="ruling-body"><div class="ruling">${esc(g.ruling)}</div>
      <div class="scoreline"><b>${v.ok || 0}</b> verified &nbsp; <b>${v.warn || 0}</b> caveat &nbsp; <b>${v.bad || 0}</b> issue${(v.bad || 0) === 1 ? '' : 's'} &nbsp; <b>${v.info || 0}</b> info${summary.invalid ? ` &nbsp; <b>${summary.invalid}</b> schema-flagged` : ''}</div></div>
  </div>

  <div class="kpis">
    <div class="kpi"><div class="n">${esc(total)}</div><div class="lbl">Claims audited</div></div>
    <div class="kpi gold"><div class="n">${v.ok || 0}</div><div class="lbl">Verified</div></div>
    <div class="kpi warn"><div class="n">${v.warn || 0}</div><div class="lbl">Caveat / revise</div></div>
    <div class="kpi fail"><div class="n">${v.bad || 0}</div><div class="lbl">Issues</div></div>
  </div>

  <h2><span class="num">1</span>Per-claim findings</h2>
  <p class="small">Claims listed in document order. "Locator" is the working-copy anchor the finding attaches to.</p>
  <table class="cite-table"><colgroup><col class="c-num"><col class="c-claim"><col class="c-status"><col class="c-finding"></colgroup>
    <thead><tr><th class="num">#</th><th>Claim</th><th>Status</th><th>Finding &amp; locator</th></tr></thead>
    <tbody>${claimRows(findings)}</tbody>
  </table>

  <h2><span class="num">2</span>Recommended corrections</h2>
  ${fixItems(a.suggestions)}

  ${sourcesConsultedSection(findings, 3)}

  ${factCheckSection(a.factcheck, sourcesConsultedSection(findings, 3) ? 4 : 3)}

  <div class="signoff">
    <div class="auditor-note"><p><strong>Auditor's note.</strong> This certification was produced by the Editor Studio's deterministic verification harness: each claim's source was resolved and matched (lexical + local embeddings) with model judgment applied only to the residual gray-band claims. Verdicts and counts above are derived programmatically from that pass. This certification does not replace legal review or libel-risk assessment.</p></div>
    <div class="seal"><div class="lbl">Certification Seal</div>
      <div class="stamp">${esc(g.stamp)}</div>
      <div class="meta-line">${esc(scorelineOf(summary))}</div>
      <div class="meta-line">Issued · ${esc(fmtDate(issued))} · ${a.reaudit ? 'Re-audit' : 'Initial audit'}</div>
      <div class="id-line">${esc(a.certNumber || '—')}</div></div>
  </div>
</body></html>`;
  }

  /**
   * Render a plain FINDINGS REPORT — the same per-claim findings + corrections as the cert, but WITHOUT
   * the certification apparatus (no CFC id, no seal, no "cleared for publication" ruling). This is the
   * artifact handed back to the AUTHOR for revision; certification is a separate, later step.
   * @param {object} a  { doc, findings, suggestions, summary, generatedAt(ms), method? }
   * @returns {string} a complete, self-contained HTML document
   */
  function renderReport(a) {
    const doc = a.doc || {};
    const findings = a.findings || [];
    const summary = a.summary || { byVerdict: {} };
    const v = summary.byVerdict || {};
    const gen = a.generatedAt != null ? a.generatedAt : Date.now();
    const method = a.method || 'Deterministic verification harness — source resolution, lexical + local-embedding match, caged model classification';
    const title = doc.title || 'Untitled document';
    const ver = doc.current_version != null ? doc.current_version : 1;
    const total = summary.total != null ? summary.total : findings.length;

    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Verification Findings — ${esc(title)} (v${esc(ver)})</title>
<style>${STYLE}</style></head>
<body>
  <div class="mast">
    <div class="org"><div class="name">Joseph Rainey Center for Public Policy</div>
      <div class="tag">Verification Findings · Pre-publication review</div></div>
    <div class="mast-right"><div class="label">Findings report</div>
      <div style="margin-top:4pt"><b>Generated</b> ${esc(fmtDate(gen))}</div></div>
  </div>

  <h1>Verification Findings</h1>
  <p class="subtitle">For: <span class="doc-name">${esc(title)}</span> · v${esc(ver)}<br>
    By ${esc(doc.author || 'Unknown author')} &nbsp;·&nbsp; Author review copy</p>

  <dl class="meta">
    <dt>Document</dt><dd>${esc(title)} (v${esc(ver)})</dd>
    <dt>Author</dt><dd>${esc(doc.author || '—')}</dd>
    <dt>Claims reviewed</dt><dd>${esc(total)}</dd>
    <dt>Generated</dt><dd>${esc(fmtDate(gen))}</dd>
    <dt>Method</dt><dd>${esc(method)}</dd>
    <dt>Summary</dt><dd>${esc(scorelineOf(summary))}</dd>
  </dl>

  <div class="kpis">
    <div class="kpi"><div class="n">${esc(total)}</div><div class="lbl">Claims reviewed</div></div>
    <div class="kpi gold"><div class="n">${v.ok || 0}</div><div class="lbl">Verified</div></div>
    <div class="kpi warn"><div class="n">${v.warn || 0}</div><div class="lbl">Caveat / revise</div></div>
    <div class="kpi fail"><div class="n">${v.bad || 0}</div><div class="lbl">Issues</div></div>
  </div>

  <h2><span class="num">1</span>Per-claim findings</h2>
  <p class="small">Claims listed in document order. "Locator" is the working-copy anchor the finding attaches to.</p>
  <table class="cite-table"><colgroup><col class="c-num"><col class="c-claim"><col class="c-status"><col class="c-finding"></colgroup>
    <thead><tr><th class="num">#</th><th>Claim</th><th>Status</th><th>Finding &amp; locator</th></tr></thead>
    <tbody>${claimRows(findings)}</tbody>
  </table>

  <h2><span class="num">2</span>Recommended corrections</h2>
  ${fixItems(a.suggestions)}

  ${sourcesConsultedSection(findings, 3)}

  ${factCheckSection(a.factcheck, sourcesConsultedSection(findings, 3) ? 4 : 3)}

  <div class="signoff">
    <div class="auditor-note"><p><strong>About this report.</strong> These are the findings from the Editor Studio's verification pass, provided to the author for revision. Each claim's source was resolved and matched (lexical + local embeddings) with model judgment applied only to residual gray-band claims. <strong>This is a findings report, not a certification</strong> — a formal certificate is issued separately once outstanding issues are resolved.</p></div>
  </div>
</body></html>`;
  }

  // STYLE is exported so the document packager (studio/doc_shapes) uses the SAME hardcoded brand
  // rather than a copy of the palette. Lucas, 2026-07-21: "make the branding hardcoded universal…
  // I dont want the hard code base to be wrong." Two copies of a brand is exactly that kind of
  // wrong: they drift, and nothing tells you which one is the house style.
  return { renderCertificate, renderReport, gradeFor, scorelineOf, fmtDate, esc, PILL, STYLE, ORG_NAME: 'Joseph Rainey Center for Public Policy' };
});
