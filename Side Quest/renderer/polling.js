/* Polling surface — operator data browser. Calls window.sq.poll.* over IPC (main maps the engine
   payloads to the standardized view shapes via studio/poll_view.js), then renders: fielding list
   (left), methodology card + topline bars (right), and an issues triage view. Read-only, no model. */
'use strict';
const $ = (id) => document.getElementById(id);
const rowsEl = $('rows'), detailEl = $('detail'), qEl = $('q'), issuesBtn = $('issuesBtn');
let all = [];          // full list of fielding items (cached)
let source = '';       // active source filter
let activeId = null;

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function renderList() {
  const term = qEl.value.trim().toLowerCase();
  const items = all
    .filter(f => !source || f.source === source)
    .filter(f => !term || f.title.toLowerCase().includes(term) || (f.id || '').toLowerCase().includes(term));
  if (!items.length) { rowsEl.innerHTML = `<div class="status">No fieldings.</div>`; return; }
  rowsEl.innerHTML = items.map(f => `
    <div class="fitem${f.id === activeId ? ' active' : ''}" data-id="${esc(f.id)}">
      <div class="t">${esc(f.title)}</div>
      <div class="m">
        <span class="src ${esc(f.source)}">${esc(f.sourceLabel)}</span>
        ${f.date ? `<span>${esc(f.date)}</span>` : ''}
        ${f.sampleSize ? `<span>n=${f.sampleSize}</span>` : ''}
        ${f.questionCount ? `<span>${f.questionCount} q</span>` : ''}
        ${f.hasIssues ? `<span class="dot" title="open issues"></span>` : ''}
      </div>
    </div>`).join('');
  rowsEl.querySelectorAll('.fitem').forEach(el => el.addEventListener('click', () => openFielding(el.dataset.id)));
}

function barsHtml(q) {
  const opts = q.options.map(o => `
    <div class="opt${o.isMax ? ' max' : ''}${o.isNet ? ' net' : ''}">
      <div class="lbl" title="${esc(o.label)}">${esc(o.label)}</div>
      <div class="track"><div class="fill" style="width:${o.isNet ? 0 : o.width}%"></div></div>
      <div class="pct">${esc(o.pctText)}</div>
    </div>`).join('');
  return `<div class="q"><div class="w"><span class="n">${esc(q.number)}</span>${esc(q.wording)}</div>${opts}</div>`;
}

function renderCard(view) {
  const c = view.card;
  const meta = [
    c.pollster && `<span><b>${esc(c.pollster)}</b></span>`,
    c.dateRange && `<span>${esc(c.dateRange)}</span>`,
    c.sampleSize && `<span>n=<b>${c.sampleSize}</b></span>`,
    (c.moe != null) && `<span>±${esc(c.moe)}%</span>`,
    c.frameLabel && `<span>${esc(c.frameLabel)}</span>`,
    c.mode && `<span>${esc(c.mode)}</span>`,
  ].filter(Boolean).join('');
  const chips = [
    ...c.files.map(f => `<span class="chip file">${esc(f.role)} · ${f.pages ? f.pages + 'p' : esc(f.name)}</span>`),
    c.openIssues ? `<span class="chip" style="color:var(--warn-fg)">${c.openIssues} open issue${c.openIssues > 1 ? 's' : ''}</span>` : '',
    c.themes ? `<span class="chip">${esc(c.themes)}</span>` : '',
  ].filter(Boolean).join('');
  detailEl.innerHTML = `
    <div class="card-h">${esc(c.title)} <span class="src ${esc(c.source)}">${esc(c.sourceLabel)}</span></div>
    <div class="card-meta">${meta}</div>
    ${c.weighting ? `<div class="card-meta"><span>Weighting: ${esc(c.weighting)}</span></div>` : ''}
    ${chips ? `<div class="chips">${chips}</div>` : ''}
    ${c.notes ? `<div class="note">${esc(c.notes)}</div>` : ''}
    <div class="qcount">${view.questions.length} question${view.questions.length === 1 ? '' : 's'}</div>
    ${view.questions.map(barsHtml).join('') || '<div class="status">No topline questions on this fielding.</div>'}`;
}

async function openFielding(id) {
  activeId = id;
  renderList();
  detailEl.innerHTML = `<div class="status">Loading ${esc(id)}…</div>`;
  try {
    const res = await window.sq.poll.get(id);
    if (!res || !res.ok) { detailEl.innerHTML = `<div class="err">⚠ ${esc((res && res.error) || 'failed to load fielding')}</div>`; return; }
    renderCard(res.view);
  } catch (e) { detailEl.innerHTML = `<div class="err">⚠ ${esc(e.message || String(e))}</div>`; }
}

async function showIssues() {
  activeId = null; renderList();
  issuesBtn.classList.add('on');
  detailEl.innerHTML = `<div class="status">Loading triage feed…</div>`;
  try {
    const res = await window.sq.poll.issues();
    if (!res || !res.ok) { detailEl.innerHTML = `<div class="err">⚠ ${esc((res && res.error) || 'failed to load issues')}</div>`; return; }
    const rows = res.rows || [];
    detailEl.innerHTML = `<div class="issues">${rows.length ? rows.map(i => `
      <div class="irow">
        <span class="pill ${esc(i.verdict)}">${esc(i.severity)}</span>
        <div class="ibody"><div class="ik">${esc(i.kind)} <span style="color:var(--tx-fainter)">· ${esc(i.fielding)}</span></div>
        <div class="id">${esc(i.detail)}</div>${i.file ? `<div class="if">${esc(i.file)}</div>` : ''}</div>
      </div>`).join('') : '<div class="status">No open issues — extraction is clean.</div>'}</div>`;
  } catch (e) { detailEl.innerHTML = `<div class="err">⚠ ${esc(e.message || String(e))}</div>`; }
}

// source filter
document.querySelectorAll('#srcseg button').forEach(b => b.addEventListener('click', () => {
  source = b.dataset.src;
  document.querySelectorAll('#srcseg button').forEach(x => x.classList.toggle('on', x === b));
  issuesBtn.classList.remove('on');
  renderList();
}));
qEl.addEventListener('input', () => { issuesBtn.classList.remove('on'); renderList(); });
issuesBtn.addEventListener('click', showIssues);

(async () => {
  try {
    const res = await window.sq.poll.list();
    if (!res || !res.ok) { rowsEl.innerHTML = `<div class="err">⚠ ${esc((res && res.error) || 'failed to load')}</div>`; return; }
    all = res.items || [];
    renderList();
  } catch (e) { rowsEl.innerHTML = `<div class="err">⚠ ${esc(e.message || String(e))}</div>`; }
})();
