/* renderer/dossier.js — Puller surface (Slice 1, read-only). Lists targets and renders one dossier:
   identity, the email-pattern belief distribution, derived beliefs, pending revisions (the gate —
   display-only here; accept/reject lands in Slice 4), the evidence timeline, and the retest queue.
   All data comes from window.sq.puller (lib/puller_ipc); this file only draws. */
'use strict';

const listEl = document.getElementById('tlist');
const countEl = document.getElementById('tcount');
const dossierEl = document.getElementById('dossier');
const placeholderHTML = document.getElementById('placeholder').outerHTML;

let activeId = null;

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function pct(v) { return Math.round((Number(v) || 0) * 100); }
function fmtTime(ms) {
  if (!ms) return '';
  const d = new Date(Number(ms));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const LIST_CAP = 200;          // cap rendered rows for snappiness; surfaced (never silent) when hit
let allTargets = [];

async function loadTargets() {
  const r = await window.sq.puller.listTargets({});
  allTargets = (r && r.ok && r.targets) || [];
  renderList();
}

// Filter the in-memory target list by free text (name/company/domain) + status, render up to LIST_CAP.
function renderList() {
  const q = (document.getElementById('tsearch').value || '').trim().toLowerCase();
  const status = document.getElementById('tstatus').value || '';
  let rows = allTargets;
  if (status) rows = rows.filter(t => t.status === status);
  if (q) rows = rows.filter(t => `${t.name || ''} ${t.company || ''} ${t.domain || ''}`.toLowerCase().includes(q));
  countEl.textContent = (q || status) ? `${rows.length}/${allTargets.length}` : String(allTargets.length);
  if (!allTargets.length) {
    listEl.innerHTML = `<div class="empty" style="padding:14px">No targets yet — ingest a sheet to begin.</div>`;
    return;
  }
  if (!rows.length) { listEl.innerHTML = `<div class="empty" style="padding:14px">No matches.</div>`; return; }
  const shown = rows.slice(0, LIST_CAP);
  listEl.innerHTML = shown.map(t => `
    <div class="titem${t.id === activeId ? ' active' : ''}" data-id="${t.id}">
      <div class="nm">${esc(t.name)}</div>
      <div class="meta">${esc([t.company, t.domain].filter(Boolean).join(' · ') || '—')}</div>
      <div class="pill${t.status === 'promoted' ? ' promoted' : ''}">${esc(t.status)}${t.function ? ' · ' + esc(t.function) : ''}</div>
    </div>`).join('') + (rows.length > LIST_CAP
      ? `<div class="empty" style="padding:10px 14px">showing ${LIST_CAP} of ${rows.length} — refine search</div>` : '');
  listEl.querySelectorAll('.titem').forEach(el =>
    el.addEventListener('click', () => selectTarget(Number(el.dataset.id))));
}

async function selectTarget(id) {
  activeId = id;
  listEl.querySelectorAll('.titem').forEach(el => el.classList.toggle('active', Number(el.dataset.id) === id));
  const r = await window.sq.puller.getDossier(id);
  if (!r || !r.ok) { dossierEl.innerHTML = `<div class="placeholder"><div class="big">Couldn't load dossier</div><div class="small">${esc(r && r.error || 'unknown error')}</div></div>`; return; }
  renderDossier(r.dossier);
}

function sectionBeliefs(beliefs) {
  if (!beliefs.length) return `<div class="empty">No derived beliefs yet.</div>`;
  return beliefs.map(b => `
    <div class="belief">
      <div class="ty">${esc(b.type)}</div>
      <div class="val">${esc(b.value || '—')}</div>
      <div class="conf">
        <div class="bar"><i style="width:${pct(b.confidence)}%"></i></div>
        <div class="pct">${b.confidence == null ? '—' : pct(b.confidence) + '%'}</div>
      </div>
    </div>`).join('');
}

function sectionPattern(dp) {
  if (!dp) return `<div class="empty">No domain on this target — no email-pattern belief.</div>`;
  const rows = dp.patterns.map(p => `
    <div class="pat${p.best ? ' best' : ''}${p.dead ? ' dead' : ''}">
      <div class="name">${esc(p.pattern)}</div>
      <div class="bar"><i style="width:${pct(p.belief)}%"></i></div>
      <div class="pct">${pct(p.belief)}%</div>
      <div class="hm">${p.hits}✓ / ${p.misses}✗</div>
    </div>`).join('');
  const catchall = dp.isCatchAll ? `<div class="catchall">⚠ catch-all domain — verification can't be trusted; treat "valid" with suspicion.</div>` : '';
  const infra = dp.infraBlocked ? `<div class="catchall">⚠ gateway-block suspected — strong prior + only bounces ⇒ likely sender-reputation/infra, NOT a pattern miss. Pattern retests are paused for this domain.</div>` : '';
  return `<div class="patgrid">${rows}</div>${catchall}${infra}`;
}

function sectionRevisions(revisions) {
  if (!revisions.length) return `<div class="empty">No revisions awaiting your decision.</div>`;
  return revisions.map(r => `
    <div class="rev">
      <div class="hd">${esc(r.subject_kind)} · ${esc(r.attr || '')}</div>
      <div class="flip"><span class="from">${esc(r.from_value || '∅')}</span> &rarr; <span class="to">${esc(r.to_value || '∅')}</span></div>
      ${r.rationale ? `<div class="why">${esc(r.rationale)}</div>` : ''}
      <div class="revact">
        <button class="btn accent" data-action="accept-rev" data-rev="${r.id}">Accept flip</button>
        <button class="btn" data-action="reject-rev" data-rev="${r.id}">Reject</button>
      </div>
    </div>`).join('');
}

function sectionObservations(obs) {
  if (!obs.length) return `<div class="empty">No evidence captured yet.</div>`;
  return obs.slice().reverse().map(o => `
    <div class="obs">
      <div class="kind">${esc(o.kind || 'note')}</div>
      <div class="body">
        <div class="av"><span class="a">${esc(o.attr)}:</span> ${esc(o.value || '—')}</div>
        ${o.source || o.source_url ? `<div class="src">${esc(o.source_url || o.source)}</div>` : ''}
      </div>
      <div class="when">${fmtTime(o.captured_at)}</div>
    </div>`).join('');
}

function sectionRetests(retests) {
  if (!retests.length) return `<div class="empty">Retest queue empty.</div>`;
  return retests.map(r => `
    <div class="rt">
      <span class="who">${esc(r.person || r.domain || '—')}</span>
      <span>next: <span class="next">${esc(r.next_pattern || '—')}</span></span>
      <span class="st">${esc(r.status)}</span>
    </div>`).join('');
}

// axis-1 qualification badge: the send-confidence of the held email, by grade ladder (capped ratchet)
function sectionQual(d) {
  const q = d.qualification;
  const email = (d.beliefs.find(b => b.type === 'email') || {}).value || '';
  if (!q || !q.grade) {
    return `<div class="qual"><span class="qgrade">no grade</span><span class="qnote">${esc(q && q.note || 'no confirmed contact yet')}</span></div>`;
  }
  return `<div class="qual g${esc(q.grade)}${q.conflicted ? ' conflict' : ''}">
    <span class="qgrade">grade ${esc(q.grade)}</span>
    <span class="qpct">${pct(q.confidence)}%</span>
    <span class="qval">${esc(email)}</span>
    <span class="qnote">${esc(q.note || '')}</span>
  </div>`;
}

function actionsBar(t) {
  return `<div class="actions">
    <button class="btn" data-action="verified">Mark verified</button>
    <button class="btn" data-action="bounced">Mark bounced</button>
    <button class="btn" data-action="catchall">Mark catch-all</button>
    <button class="btn${t.status === 'promoted' ? '' : ' accent'}" data-action="promote">${t.status === 'promoted' ? 'Promoted ✓' : 'Promote'}</button>
    <span class="dedrow">
      <input id="dedval" placeholder="dedicated-source email" />
      <input id="dednote" placeholder="note (business card…)" />
      <button class="btn accent" data-action="dedicated">Set 100% (grade A)</button>
    </span>
  </div>`;
}

function renderDossier(d) {
  const t = d.target;
  dossierEl.innerHTML = `
    <div class="wrap">
      <div class="identity">
        <h1>${esc(t.name)}</h1>
        <span class="sub">${esc([t.company, t.function].filter(Boolean).join(' · '))}</span>
        <span class="status${t.status === 'promoted' ? ' promoted' : ''}">${esc(t.status)}</span>
      </div>
      <div class="idline">${esc(t.domain || 'no domain')}${t.crm_id ? ' · CRM ' + esc(t.crm_id) : ''} · ${esc(t.kind)}</div>
      ${sectionQual(d)}
      ${actionsBar(t)}

      <div class="sec">
        <div class="sec-h">Email-pattern belief <span class="n">${d.domainPattern ? esc(d.domainPattern.domain) : ''}</span></div>
        ${sectionPattern(d.domainPattern)}
      </div>

      <div class="sec">
        <div class="sec-h">Beliefs <span class="n">${d.beliefs.length}</span></div>
        ${sectionBeliefs(d.beliefs)}
      </div>

      <div class="sec">
        <div class="sec-h">Revisions awaiting approval <span class="n">${d.revisions.length}</span></div>
        ${sectionRevisions(d.revisions)}
      </div>

      <div class="sec">
        <div class="sec-h">Evidence <span class="n">${d.observations.length}</span></div>
        ${sectionObservations(d.observations)}
      </div>

      <div class="sec">
        <div class="sec-h">Retest queue <span class="n">${d.retests.length}</span></div>
        ${sectionRetests(d.retests)}
      </div>
    </div>`;
}

document.getElementById('refresh').addEventListener('click', async () => {
  await loadTargets();
  if (activeId != null) selectTarget(activeId);
});

document.getElementById('tsearch').addEventListener('input', renderList);
document.getElementById('tstatus').addEventListener('change', renderList);

document.getElementById('seed').addEventListener('click', async () => {
  const msg = document.getElementById('exportmsg');
  msg.textContent = 'seeding priors…';
  const r = await window.sq.puller.seedPriors();
  msg.textContent = (r && r.ok) ? `seeded ${r.patterns} priors across ${r.domains} domains` : `seed failed: ${r && r.error || '?'}`;
  if (activeId != null) selectTarget(activeId);   // re-render to reflect refreshed beliefs
});

document.getElementById('export').addEventListener('click', async () => {
  const msg = document.getElementById('exportmsg');
  msg.textContent = 'exporting…';
  const r = await window.sq.puller.exportContacts({});
  if (r && r.ok) {
    msg.textContent = `exported ${r.count} promoted contact(s)${r.excluded ? ` · ${r.excluded} gated` : ''} → ${r.file.split(/[\\/]/).pop()}`;
  } else {
    msg.textContent = `export failed: ${r && r.error || 'unknown'}`;
  }
});

// delegated write-actions — every handler returns the rebuilt dossier, so we just re-paint + refresh list
dossierEl.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('[data-action]');
  if (!btn || activeId == null) return;
  const act = btn.dataset.action;
  btn.disabled = true;
  let r;
  try {
    if (act === 'verified') r = await window.sq.puller.markVerification(activeId, 'valid');
    else if (act === 'bounced') r = await window.sq.puller.markVerification(activeId, 'invalid');
    else if (act === 'catchall') r = await window.sq.puller.markVerification(activeId, 'accept_all');
    else if (act === 'promote') r = await window.sq.puller.promote(activeId);
    else if (act === 'dedicated') {
      const v = (document.getElementById('dedval') || {}).value || '';
      const n = (document.getElementById('dednote') || {}).value || '';
      if (!v.trim()) { btn.disabled = false; return; }
      r = await window.sq.puller.markDedicated(activeId, v.trim(), n.trim());
    } else if (act === 'accept-rev') r = await window.sq.puller.decideRevision(activeId, Number(btn.dataset.rev), 'accepted');
    else if (act === 'reject-rev') r = await window.sq.puller.decideRevision(activeId, Number(btn.dataset.rev), 'rejected');
  } catch (e) { r = { ok: false, error: e.message }; }
  if (r && r.ok && r.dossier) { renderDossier(r.dossier); loadTargets(); }
  else { btn.disabled = false; console.error('[puller] action failed:', r && r.error); }
});

if (window.sq && window.sq.puller) {
  // deep-link: a "Full briefing →" click from the People rail loads dossier.html#target=<id> → auto-select it
  loadTargets().then(() => {
    const m = /(?:^|[#&])target=(\d+)/.exec(location.hash || '');
    if (m) { try { selectTarget(Number(m[1])); } catch (e) {} }
  });
} else {
  dossierEl.innerHTML = `<div class="placeholder"><div class="big">Bridge unavailable</div><div class="small">window.sq.puller is missing — preload didn't load. Restart the app.</div></div>`;
}
