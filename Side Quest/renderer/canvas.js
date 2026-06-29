/* Canvas surface — read-only renderer over Echo's saga canvas. Calls window.sq.canvas.* over IPC
   (main reads tenant_rainey.canvas_tabs/blocks via db_query and maps via studio/canvas_view.js).
   Left: tab list. Right: the tab's vertical block stream, drawn per block type. No model, no writes
   (Slice 1). Stage-4 block types (heading/paragraph/table/chart) render fully; the rest show a
   labelled fallback card so the surface never breaks on a type a later slice will own. */
'use strict';
const $ = (id) => document.getElementById(id);
const rowsEl = $('rows'), detailEl = $('detail'), headEl = $('listhead');
let activeKey = null;

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// Tiny, deliberately-narrow markdown: escape FIRST, then re-introduce a safe inline/heading subset.
// (Slice 1 is read-only render fidelity, not a full md engine — Echo owns the canonical content.)
function md(src) {
  const lines = String(src == null ? '' : src).split(/\r?\n/);
  const out = [];
  let para = [];
  const flush = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    const li = /^\s*[-*]\s+(.*)$/.exec(line);
    if (line === '') { flush(); continue; }
    if (h) { flush(); out.push(`<h${h[1].length} class="b-heading">${inline(h[2])}</h${h[1].length}>`); continue; }
    if (li) { flush(); out.push(`<ul style="margin:4px 0 4px 18px"><li>${inline(li[1])}</li></ul>`); continue; }
    para.push(line);
  }
  flush();
  return out.join('');
}
function inline(s) {
  let t = esc(s);
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, txt, url) => `<a href="${esc(url)}" target="_blank" rel="noreferrer">${esc(txt)}</a>`);
  return t;
}

function when(ts) {
  if (!ts) return '';
  try { return new Date(ts * 1000).toLocaleString(); } catch { return ''; }
}

/* ---- tab list ---- */
function tabRow(t) {
  const cls = t.open ? 'open' : 'closed';
  return `<div class="titem${t.key === activeKey ? ' active' : ''}" data-key="${esc(t.key)}">
    <div class="nm">${esc(t.title)}</div>
    <div class="sub"><span class="mode ${esc(t.mode)}">${esc(t.mode)}</span><span class="dot ${cls}" title="${cls}"></span>${t.open ? 'open' : 'closed'}</div>
  </div>`;
}

async function loadTabs() {
  headEl.textContent = 'Loading…';
  try {
    const res = await window.sq.canvas.listTabs();
    if (!res || !res.ok) { rowsEl.innerHTML = `<div class="err">⚠ ${esc((res && res.error) || 'failed')}</div>`; headEl.textContent = ''; return; }
    const tabs = res.tabs || [];
    headEl.textContent = `${tabs.length} tab${tabs.length === 1 ? '' : 's'}`;
    rowsEl.innerHTML = tabs.map(tabRow).join('') || '<div class="status">No canvas tabs yet.</div>';
    rowsEl.querySelectorAll('.titem').forEach(el => el.addEventListener('click', () => openTab(el.dataset.key)));
  } catch (e) { rowsEl.innerHTML = `<div class="err">⚠ ${esc(e.message || String(e))}</div>`; headEl.textContent = ''; }
}

/* ---- block renderers (one per normalized view shape) ---- */
function renderBlock(b) {
  const label = `<div class="blabel">${esc(b.type)}</div>`;
  if (b.type === 'heading') {
    const lvl = b.view.level || 2;
    return `<div class="block"><h${lvl} class="b-heading">${esc(b.view.text)}</h${lvl}></div>`;
  }
  if (b.type === 'paragraph') {
    return `<div class="block">${label}<div class="b-paragraph">${md(b.view.markdown)}</div></div>`;
  }
  if (b.type === 'table') {
    const head = b.view.headers.length ? `<thead><tr>${b.view.headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead>` : '';
    const body = `<tbody>${b.view.rows.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody>`;
    const cap = b.view.caption ? `<div class="tcaption">${esc(b.view.caption)}</div>` : '';
    return `<div class="block">${label}<table class="b-table">${head}${body}</table>${cap}</div>`;
  }
  if (b.type === 'chart') {
    const v = b.view;
    const meta = `<div class="chart-meta">${esc(v.title || 'Chart')} · ${esc(v.kind)}${v.yKeys.length ? ' · ' + esc(v.yKeys.join(', ')) : ''} · ${v.points.length} point${v.points.length === 1 ? '' : 's'}</div>`;
    // Slice 1 has no charting lib — render the series as a data table so the data is honest + visible.
    const head = `<thead><tr><th>${esc(v.xKey || 'x')}</th>${v.yKeys.map(k => `<th>${esc(k)}</th>`).join('')}</tr></thead>`;
    const body = `<tbody>${v.points.map(p => `<tr><td>${esc(p.x)}</td>${v.yKeys.map(k => `<td>${esc(p[k])}</td>`).join('')}</tr>`).join('')}</tbody>`;
    return `<div class="block">${label}<div class="card">${meta}<table class="b-table">${head}${body}</table></div></div>`;
  }
  // fallback — known-but-not-yet-supported, or unknown type
  const note = b.known ? 'Renderer arrives in a later slice.' : 'Unknown block type.';
  return `<div class="block">${label}<div class="card fallback"><div class="ctype">${esc(b.type)}</div><div class="cnote">${esc(note)}</div><pre>${esc(b.view.preview)}</pre></div></div>`;
}

async function openTab(key) {
  activeKey = key;
  rowsEl.querySelectorAll('.titem').forEach(el => el.classList.toggle('active', el.dataset.key === key));
  detailEl.innerHTML = `<div class="status">Loading canvas…</div>`;
  try {
    const res = await window.sq.canvas.getTab(key);
    if (!res || !res.ok) { detailEl.innerHTML = `<div class="err">⚠ ${esc((res && res.error) || 'failed to load tab')}</div>`; return; }
    const { tab, stream } = res;
    const s = stream.summary;
    const meta = [
      `<span class="mode ${esc(tab.mode)}">${esc(tab.mode)}</span>`,
      `<span>${s.total} block${s.total === 1 ? '' : 's'}${s.supported < s.total ? ` · ${s.supported} rendered` : ''}</span>`,
      tab.open ? `<span style="color:var(--ok-fg)">open</span>` : `<span>closed</span>`,
      tab.openedAt ? `<span>opened ${esc(when(tab.openedAt))}</span>` : '',
    ].filter(Boolean).join('');
    const body = stream.blocks.map(renderBlock).join('') || '<div class="status">This tab has no blocks yet.</div>';
    detailEl.innerHTML = `<div class="canvas-head"><div class="canvas-title">${esc(tab.title)}</div><div class="canvas-meta">${meta}</div></div>${body}`;
  } catch (e) { detailEl.innerHTML = `<div class="err">⚠ ${esc(e.message || String(e))}</div>`; }
}

$('refreshBtn').addEventListener('click', () => { loadTabs(); if (activeKey) openTab(activeKey); });
loadTabs();
