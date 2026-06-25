/* Super Search surface — operator-only. Calls window.sq.search.run(query, {ingestMode}) over IPC
   (the whole deterministic pathway runs in main), then renders the standardized run object: a cited
   overview on top, two honest lanes (owned corpus ∣ web), and an ingest/stat footer. No Zoe here. */
'use strict';
const $ = (id) => document.getElementById(id);
const qEl = $('q'), goEl = $('go'), bodyEl = $('body'), engineStat = $('enginestat');
let ingestMode = 'cited';
let busy = false;

// ingest-mode segmented control
document.querySelectorAll('#ingseg button').forEach(b => b.addEventListener('click', () => {
  ingestMode = b.dataset.mode;
  document.querySelectorAll('#ingseg button').forEach(x => x.classList.toggle('on', x === b));
}));

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// enrich object → a few compact tag chips (party/state, year, cited_by, corpus, host, votes…)
function enrichTags(c) {
  const e = c.enrich || {}, out = [];
  const push = (v) => { if (v != null && v !== '') out.push(`<span class="tag">${esc(v)}</span>`); };
  if (e.party || e.state) push([e.party, e.state].filter(Boolean).join('·'));
  if (e.entity_type) push(e.entity_type);
  if (e.bill_type || e.session) push([e.bill_type, e.session].filter(Boolean).join(' '));
  if (e.votes) push(`▲${e.votes.yea || 0}/▼${e.votes.nay || 0}`);
  if (e.year) push(e.year);
  if (e.cited_by != null) push(`${e.cited_by} cites`);
  if (e.corpus) push(e.corpus);
  if (e.host) push(e.host);
  if (e.fetched) out.push(`<span class="tag ing">fetched</span>`);
  return out.join('');
}

function cardHtml(c, ingestedUrls) {
  const isExt = c.plane === 'external';
  const ing = ingestedUrls.has(c.url) ? `<span class="tag ing">↳ ingested</span>` : '';
  return `<div class="card">
    <div class="ti">${esc(c.title)}</div>
    ${c.snippet ? `<div class="sn">${esc(c.snippet)}</div>` : ''}
    <div class="meta"><span class="src${isExt ? ' ext' : ''}">${esc(c.source)}</span>${enrichTags(c)}${ing}</div>
    ${c.url ? `<div class="url">${esc(c.url)}</div>` : ''}
  </div>`;
}

function laneHtml(name, cards, ingestedUrls) {
  const rows = cards.length ? cards.map(c => cardHtml(c, ingestedUrls)).join('') : `<div class="status">No results in this lane.</div>`;
  return `<div class="lane"><div class="lane-head"><span class="nm">${name}</span><span class="ct">${cards.length}</span></div>${rows}</div>`;
}

function overviewHtml(ov) {
  if (!ov || !ov.rendered) return '';
  const cites = (ov.citations || []).map(c => `<span class="cite"><b>[${c.n}]</b> ${esc(c.cite || c.id)}</span>`).join('');
  return `<div class="overview"><div class="ohead">&#9788; Overview · cloud · cited</div><div class="ans">${esc(ov.answer)}</div>${cites ? `<div class="cites">${cites}</div>` : ''}</div>`;
}

function render(run) {
  const ingestedUrls = new Set((run.ingested || []).map(e => e.url));
  const s = run.stats || {};
  const errs = (s.errors || []).length ? `<div class="err">⚠ ${s.errors.map(e => `${esc(e.source)}: ${esc(e.error)}`).join(' · ')}</div>` : '';
  const overviewNote = (!run.overview || !run.overview.rendered) ? `<div class="status">No cited overview — the sources didn't support a grounded answer (cite_floor).</div>` : '';
  bodyEl.innerHTML = `
    ${overviewHtml(run.overview)}
    ${overviewNote}
    ${errs}
    <div class="lanes">
      ${laneHtml('Owned corpus', run.internal || [], ingestedUrls)}
      ${laneHtml('Web', run.external || [], ingestedUrls)}
    </div>
    <div class="foot">
      <span><b>plan</b> ${esc(s.intent || (run.plan && run.plan.intent) || 'lookup')}</span>
      <span><b>internal</b> ${s.internalCount || 0}</span>
      <span><b>external</b> ${s.externalCount || 0}</span>
      <span><b>rerank</b> ${s.reranked ? 'on' : 'off'}</span>
      <span><b>ingest</b> ${esc(s.ingestMode || ingestMode)} · ${s.ingestedCount || 0} kept</span>
    </div>`;
}

async function runSearch() {
  const query = qEl.value.trim();
  if (!query || busy) return;
  busy = true; goEl.disabled = true; goEl.textContent = 'Searching…';
  bodyEl.innerHTML = `<div class="status">Planning → retrieving both lanes → re-ranking → synthesizing the cited overview…</div>`;
  try {
    const res = await window.sq.search.run(query, { ingestMode });
    if (!res || !res.ok) { bodyEl.innerHTML = `<div class="err">⚠ ${esc((res && res.error) || 'search failed')}</div>`; return; }
    render(res.run);
  } catch (e) {
    bodyEl.innerHTML = `<div class="err">⚠ ${esc(e.message || String(e))}</div>`;
  } finally {
    busy = false; goEl.disabled = false; goEl.textContent = 'Search';
  }
}

goEl.addEventListener('click', runSearch);
qEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });
qEl.focus();

// best-effort engine status line
(async () => { try { const st = await window.sq.search.status(); engineStat.textContent = st && st.ok ? `engine ${st.engine || 'ok'} · cloud ${st.cloud ? 'inherited' : 'local'}` : 'engine offline'; } catch (e) { engineStat.textContent = ''; } })();
