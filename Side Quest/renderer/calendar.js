/* Calendar surface — near-1:1 Google Calendar: Day / Week / Month / Year views + Analytics.
   Calls window.sq.calendar.* over IPC (main bridges Echo's Google OAuth + Calendar v3 read;
   studio/calendar_view.js does the pure mapping + layout math + analytics). Read-only (Slice 2). */
'use strict';
const CV = window.CalendarView;   // pure mappers/layout/analytics (loaded via <script> on the page)
const $ = (id) => document.getElementById(id);
const viewport = $('viewport'), calsEl = $('cals'), periodLabel = $('periodlabel');
const statusPill = $('status'), statusText = $('statustext'), acctEl = $('acct');
const modalBg = $('modalbg'), modalEl = $('modal'), segEl = $('seg');

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const MON_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const DOW_FULL = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const PX_PER_MIN = 0.8;            // 48px per hour
const MAX_CHIPS = 3;

const pad2 = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Google event descriptions are often HTML (links, <br>, lists) — sometimes plain text with newlines.
// Render a SANITIZED subset: drop script/style, strip on*/javascript:, keep a safe tag whitelist,
// force links to open externally. Plain-text descriptions get newlines → <br>. Source is the
// operator's own calendar, so risk is low; this just prevents raw tags showing + neutralizes scripts.
function sanitizeDesc(html) {
  if (!html) return '';
  let s = String(html)
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\/\s*\1\s*>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href\s*=\s*)("|')\s*javascript:[^"']*\2/gi, '$1$2#$2');
  const allowed = /^(a|b|i|u|em|strong|br|p|ul|ol|li|span|div|h[1-6]|blockquote|hr)$/i;
  s = s.replace(/<(\/?)([a-z0-9]+)([^>]*)>/gi, (m, slash, tag, attrs) => {
    if (!allowed.test(tag)) return '';
    if (/^a$/i.test(tag) && !slash) { const href = (attrs.match(/href\s*=\s*("[^"]*"|'[^']*')/i) || [])[0] || ''; return `<a ${href} target="_blank" rel="noreferrer">`; }
    return `<${slash}${tag.toLowerCase()}>`;
  });
  if (!/<(br|p|div|li|h[1-6])/i.test(s)) s = s.replace(/\r?\n/g, '<br>');
  return s;
}
// Plain-text snippet from a (possibly HTML) description, for the meetings list.
function descSnippet(html, max = 120) {
  const t = String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
}
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const addMonths = (d, n) => new Date(d.getFullYear(), d.getMonth() + n, 1);
const addYears = (d, n) => new Date(d.getFullYear() + n, d.getMonth(), d.getDate());
const startOfWeek = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay());

const now = new Date();
const todayYmd = ymd(now);
let viewMode = 'month';
let anchor = new Date(now.getFullYear(), now.getMonth(), now.getDate());
let anRangeDays = 30;
let calendars = [], colors = { event: {}, calendar: {} };
const selected = new Set();
let events = [];

function colorOf(e) {
  if (e.colorId && colors.event && colors.event[e.colorId]) return colors.event[e.colorId].background;
  return e.color || '#6a86b6';
}
function nameById() { const m = {}; calendars.forEach(c => { m[c.id] = c.summary; }); return m; }
function calById(id) { return calendars.find(c => c.id === id) || null; }
function calWritable(id) { const c = calById(id); return !!(c && c.canWrite); }
function calTz(id) { const c = calById(id); return (c && c.timeZone) || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
function writableCals() { return calendars.filter(c => c.canWrite); }
function defaultCalId() { const w = writableCals(); const prim = w.find(c => c.primary); return (prim || w[0] || calendars[0] || {}).id || ''; }
const minToHHMM = (m) => `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;

// ============================ range + fetch ============================
function gridCells(year, month) {
  const first = new Date(year, month, 1);
  const start = new Date(year, month, 1 - first.getDay());
  return Array.from({ length: 42 }, (_, i) => {
    const d = addDays(start, i);
    return { date: d, key: ymd(d), inMonth: d.getMonth() === month, isToday: ymd(d) === todayYmd };
  });
}
function activeRange() {
  if (viewMode === 'day') return { min: anchor, max: addDays(anchor, 1) };
  if (viewMode === 'week') { const s = startOfWeek(anchor); return { min: s, max: addDays(s, 7) }; }
  if (viewMode === 'month') { const c = gridCells(anchor.getFullYear(), anchor.getMonth()); return { min: c[0].date, max: addDays(c[41].date, 1) }; }
  if (viewMode === 'year') return { min: new Date(anchor.getFullYear(), 0, 1), max: new Date(anchor.getFullYear() + 1, 0, 1) };
  // analytics: forward window from today
  return { min: new Date(now.getFullYear(), now.getMonth(), now.getDate()), max: addDays(now, anRangeDays) };
}
async function load() {
  const sel = calendars.filter(c => selected.has(c.id)).map(c => ({ id: c.id, color: c.color }));
  if (!sel.length) { events = []; return; }
  const { min, max } = activeRange();
  const res = await window.sq.calendar.events(sel, min.toISOString(), max.toISOString());
  events = (res && res.ok) ? (res.events || []) : [];
  if (res && res.errors && res.errors.length) console.warn('[calendar] per-calendar errors', res.errors);
}
const shown = () => events.filter(e => selected.has(e.calendarId));

// ============================ period label ============================
function setLabel() {
  if (viewMode === 'day') periodLabel.textContent = `${DOW_FULL[anchor.getDay()]}, ${MONTHS[anchor.getMonth()]} ${anchor.getDate()}, ${anchor.getFullYear()}`;
  else if (viewMode === 'week') { const s = startOfWeek(anchor), e = addDays(s, 6); periodLabel.textContent = `${MON_ABBR[s.getMonth()]} ${s.getDate()} – ${s.getMonth() === e.getMonth() ? '' : MON_ABBR[e.getMonth()] + ' '}${e.getDate()}, ${e.getFullYear()}`; }
  else if (viewMode === 'month') periodLabel.textContent = `${MONTHS[anchor.getMonth()]} ${anchor.getFullYear()}`;
  else if (viewMode === 'year') periodLabel.textContent = `${anchor.getFullYear()}`;
  else periodLabel.textContent = `Next ${anRangeDays} days`;
}

// ============================ MONTH ============================
function chipHtml(e) {
  const col = colorOf(e);
  if (e.allDay) return `<div class="ev" data-ev="${esc(e.id)}" style="border-left-color:${esc(col)}">${esc(e.summary)}</div>`;
  return `<div class="ev timed" data-ev="${esc(e.id)}"><span class="tdot" style="background:${esc(col)}"></span><span class="tm">${esc(e.start ? e.start.time : '')}</span>${e.hasMeet ? '<span class="meet">●</span>' : ''} ${esc(e.summary)}</div>`;
}
function renderMonth() {
  const cells = gridCells(anchor.getFullYear(), anchor.getMonth());
  const keys = cells.map(c => c.key), keySet = new Set(keys);
  const byDay = {};
  for (const e of shown()) {
    let cur = new Date(e.startDate + 'T00:00:00'); const end = new Date((e.endDate || e.startDate) + 'T00:00:00'); let g = 0;
    while (cur <= end && g++ < 90) { const k = ymd(cur); if (keySet.has(k)) (byDay[k] = byDay[k] || []).push(e); cur = addDays(cur, 1); }
  }
  for (const k in byDay) byDay[k].sort((a, b) => (b.allDay - a.allDay) || (a.startMs - b.startMs));
  viewport.innerHTML = `<div class="dow">${DOW.map(d => `<div>${d}</div>`).join('')}</div>
    <div class="mgrid">${cells.map(c => {
      const evs = byDay[c.key] || [];
      const chips = evs.slice(0, MAX_CHIPS).map(chipHtml).join('');
      const more = evs.length > MAX_CHIPS ? `<div class="more" data-day="${c.key}">+${evs.length - MAX_CHIPS} more</div>` : '';
      return `<div class="cell${c.inMonth ? '' : ' othermonth'}${c.isToday ? ' istoday' : ''}" data-key="${c.key}"><div class="dn">${c.date.getDate()}</div><div class="evs">${chips}${more}</div></div>`;
    }).join('')}</div>`;
  viewport.querySelectorAll('.ev').forEach(el => el.addEventListener('click', (ev) => { ev.stopPropagation(); openEvent(el.dataset.ev); }));
  viewport.querySelectorAll('.more').forEach(el => el.addEventListener('click', (ev) => { ev.stopPropagation(); anchor = new Date(el.dataset.day + 'T00:00:00'); setMode('day'); }));
  viewport.querySelectorAll('.cell').forEach(el => el.addEventListener('click', () => newEventAt(el.dataset.key, 540)));   // empty cell → new 9am event
}

// ============================ DAY / WEEK timeline ============================
function renderTimeline(dayKeys) {
  const cols = `54px repeat(${dayKeys.length},1fr)`;
  const head = dayKeys.map(k => { const d = new Date(k + 'T00:00:00'); const t = k === todayYmd;
    return `<div class="tl-colhead${t ? ' istoday' : ''}"><div>${DOW[d.getDay()]}</div><div class="dnum">${d.getDate()}</div></div>`; }).join('');
  const layouts = dayKeys.map(k => CV.layoutDay(shown(), k));
  const anyAllDay = layouts.some(l => l.allDay.length);
  const alldayCells = layouts.map(l => `<div class="allday-cell">${l.allDay.map(e => `<div class="ev" data-ev="${esc(e.id)}" style="border-left-color:${esc(colorOf(e))}">${esc(e.summary)}</div>`).join('')}</div>`).join('');
  const hours = Array.from({ length: 24 }, (_, h) => `<div class="hourcell"><span>${h === 0 ? '' : (h % 12 === 0 ? 12 : h % 12) + (h < 12 ? ' AM' : ' PM')}</span></div>`).join('');
  const daycols = dayKeys.map((k, i) => {
    const t = k === todayYmd;
    const lines = Array.from({ length: 24 }, () => '<div class="hourline"></div>').join('');
    const tevs = layouts[i].timed.map(it => {
      const top = it.topMin * PX_PER_MIN, h = Math.max(14, it.durMin * PX_PER_MIN);
      const w = 100 / it.cols, left = it.col * w;
      const e = it.ev, col = colorOf(e);
      return `<div class="tev" data-ev="${esc(e.id)}" style="top:${top}px;height:${h}px;left:calc(${left}% + 1px);width:calc(${w}% - 2px);background:${esc(col)}">
        <div class="ttl">${esc(e.summary)}</div><div class="tsub">${esc(e.start ? e.start.time : '')}${e.hasMeet ? ' · Meet' : ''}</div></div>`;
    }).join('');
    const nowl = (t) ? `<div class="nowline" id="nowline" style="top:${(now.getHours() * 60 + now.getMinutes()) * PX_PER_MIN}px"></div>` : '';
    return `<div class="daycol${t ? ' istoday' : ''}" data-key="${k}">${lines}${tevs}${nowl}</div>`;
  }).join('');
  viewport.innerHTML = `
    <div class="tl-head" style="grid-template-columns:${cols}"><div class="gutter"></div>${head}</div>
    ${anyAllDay ? `<div class="allday-row" style="grid-template-columns:${cols}"><div class="gutter">all-day</div>${alldayCells}</div>` : ''}
    <div class="tl-scroll scroll"><div class="tl-body" style="grid-template-columns:${cols}">
      <div class="tl-gutter">${hours}</div>${daycols}</div></div>`;
  viewport.querySelectorAll('.tev,.ev').forEach(el => el.addEventListener('click', (ev) => { ev.stopPropagation(); openEvent(el.dataset.ev); }));
  // click empty timeline space → new event at that time (snapped to 30 min)
  viewport.querySelectorAll('.daycol').forEach(el => el.addEventListener('click', (ev) => {
    const min = Math.max(0, Math.min(1410, Math.round((ev.offsetY / PX_PER_MIN) / 30) * 30));
    newEventAt(el.dataset.key, min);
  }));
  // scroll to ~7am or the now-line
  const sc = viewport.querySelector('.tl-scroll'); if (sc) sc.scrollTop = (now.getHours() >= 7 ? (now.getHours() - 1) * 60 : 7 * 60) * PX_PER_MIN;
}

// ============================ YEAR ============================
function renderYear() {
  const yr = anchor.getFullYear();
  const byDay = {};
  for (const e of shown()) { let cur = new Date(e.startDate + 'T00:00:00'); const end = new Date((e.endDate || e.startDate) + 'T00:00:00'); let g = 0;
    while (cur <= end && g++ < 400) { byDay[ymd(cur)] = (byDay[ymd(cur)] || 0) + 1; cur = addDays(cur, 1); } }
  const dot = (n) => { if (!n) return ''; const op = n >= 5 ? 1 : n >= 3 ? 0.7 : 0.4; return `<span class="hd" style="background:var(--accent);opacity:${op}"></span>`; };
  let html = '';
  for (let m = 0; m < 12; m++) {
    const cells = gridCells(yr, m);
    const grid = cells.map(c => `<div class="mc${c.inMonth ? '' : ' out'}${c.isToday ? ' istoday' : ''}" data-day="${c.key}">${c.date.getDate()}${c.inMonth ? dot(byDay[c.key] || 0) : ''}</div>`).join('');
    html += `<div class="mini"><div class="mh" data-month="${m}">${MONTHS[m]}</div>
      <div class="mini-dow">${DOW.map(d => `<div>${d[0]}</div>`).join('')}</div>
      <div class="mini-grid">${grid}</div></div>`;
  }
  viewport.innerHTML = `<div class="year scroll">${html}</div>`;
  viewport.querySelectorAll('.mh').forEach(el => el.addEventListener('click', () => { anchor = new Date(yr, Number(el.dataset.month), 1); setMode('month'); }));
  viewport.querySelectorAll('.mc:not(.out)').forEach(el => el.addEventListener('click', () => { anchor = new Date(el.dataset.day + 'T00:00:00'); setMode('day'); }));
}

// ============================ ANALYTICS ============================
function bar(k, val, max, color) {
  const pct = max ? Math.round((val / max) * 100) : 0;
  return `<div class="barrow"><span class="k">${esc(k)}</span><div class="track"><div class="fill" style="width:${pct}%${color ? `;background:${esc(color)}` : ''}"></div></div><span class="v">${esc(val)}</span></div>`;
}
function renderAnalytics() {
  const s = CV.analytics(shown(), nameById());
  const hMax = Math.max(1, ...s.byHour);
  const wMax = Math.max(1, ...s.byWeekday);
  const cMax = Math.max(1, ...s.byCalendar.map(c => c.count));
  const hrsLabel = (m) => m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
  viewport.innerHTML = `<div class="an scroll">
    <div class="an-range"><span class="lbl">Window</span>
      ${[30, 90, 365].map(d => `<button class="navbtn anr${d === anRangeDays ? ' active' : ''}" data-d="${d}" style="${d === anRangeDays ? 'border-color:var(--accent);color:var(--tx)' : ''}">${d === 365 ? '1 year' : d + ' days'}</button>`).join('')}</div>
    <div class="cards">
      <div class="card"><div class="big">${s.total}</div><div class="lab">Events</div><div class="sub">${s.timed} timed · ${s.allDay} all-day</div></div>
      <div class="card"><div class="big">${s.totalHours}</div><div class="lab">Hours booked</div><div class="sub">avg ${hrsLabel(s.avgMins)}/event</div></div>
      <div class="card"><div class="big">${s.withMeet}</div><div class="lab">With Meet</div><div class="sub">${s.recurring} recurring</div></div>
      <div class="card"><div class="big">${s.busiestDay ? s.busiestDay.count : 0}</div><div class="lab">Busiest day</div><div class="sub">${s.busiestDay ? esc(s.busiestDay.date) : '—'}</div></div>
    </div>
    <div class="an-sec"><div class="h">By calendar</div>${s.byCalendar.length ? s.byCalendar.map(c => bar(c.name, c.count, cMax, c.color)).join('') : '<div class="sub" style="color:var(--tx-fainter)">No events in window.</div>'}
      <div class="callegend">${s.byCalendar.map(c => `<span class="a"><span class="sw" style="background:${esc(c.color)}"></span>${esc(c.name)} · ${c.hours}h</span>`).join('')}</div></div>
    <div class="an-sec"><div class="h">By weekday</div>${s.byWeekday.map((v, i) => bar(s.weekdayLabels[i], v, wMax)).join('')}</div>
    <div class="an-sec"><div class="h">By time of day</div>
      <div class="hourbars">${s.byHour.map(v => `<div class="hb" style="height:${Math.round((v / hMax) * 100)}%" title="${v}"></div>`).join('')}</div>
      <div class="hourlabels">${s.byHour.map((_, h) => `<span>${h % 6 === 0 ? h : ''}</span>`).join('')}</div></div>
    ${s.longest ? `<div class="an-sec"><div class="h">Longest event</div><div style="font-size:12.5px;color:var(--tx-soft)">${esc(s.longest.summary)} · ${hrsLabel(s.longest.mins)}</div></div>` : ''}
  </div>`;
  viewport.querySelectorAll('.anr').forEach(el => el.addEventListener('click', async () => { anRangeDays = Number(el.dataset.d); setLabel(); await load(); renderAnalytics(); }));
}

// ============================ dispatch ============================
function renderActive() {
  setLabel();
  if (viewMode === 'day') renderTimeline([ymd(anchor)]);
  else if (viewMode === 'week') renderTimeline(CV.weekDays(anchor));
  else if (viewMode === 'month') renderMonth();
  else if (viewMode === 'year') renderYear();
  else renderAnalytics();
  renderMeets();
}
async function refresh() { setLabel(); await load(); renderActive(); }

function setMode(mode) {
  viewMode = mode;
  segEl.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  refresh();
}
segEl.querySelectorAll('button').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));

// nav
function nav(delta) {
  if (viewMode === 'day') anchor = addDays(anchor, delta);
  else if (viewMode === 'week') anchor = addDays(anchor, delta * 7);
  else if (viewMode === 'month') anchor = addMonths(anchor, delta);
  else if (viewMode === 'year') anchor = addYears(anchor, delta);
  else return;   // analytics uses the window buttons
  refresh();
}
$('prev').addEventListener('click', () => nav(-1));
$('next').addEventListener('click', () => nav(1));
$('today').addEventListener('click', () => { anchor = new Date(now.getFullYear(), now.getMonth(), now.getDate()); refresh(); });
$('newbtn').addEventListener('click', () => { const m = Math.round((now.getHours() * 60 + now.getMinutes()) / 30) * 30; newEventAt(ymd(now), Math.min(1410, m)); });

// ============================ calendars sidebar ============================
function renderCalList() {
  calsEl.innerHTML = calendars.map(c => `
    <div class="cal${selected.has(c.id) ? '' : ' muted'}" data-cal="${esc(c.id)}">
      <span class="sw" style="background:${selected.has(c.id) ? esc(c.color) : 'transparent'};border-color:${esc(c.color)}"></span>
      <span class="nm">${esc(c.summary)}</span>${c.canWrite ? '' : '<span class="ro">read</span>'}</div>`).join('');
  calsEl.querySelectorAll('.cal').forEach(el => el.addEventListener('click', () => toggleCal(el.dataset.cal)));
}
async function toggleCal(id) {
  if (selected.has(id)) selected.delete(id); else selected.add(id);
  renderCalList();
  await load(); renderActive();
}

// Video-meetings panel — every event in the loaded window with a Meet/video link, soonest first,
// each with full name, description, and a Join button (Zoe joins as herself). Reflects the current
// view's date range. (Slice 6 will repoint Join to the in-canvas Meet pane.)
function renderMeets() {
  const meetsEl = $('meets'); if (!meetsEl) return;
  const nowMs = Date.now();
  const seen = new Set();
  // only meetings that haven't ended yet (upcoming or in progress); soonest first
  const list = shown().filter(e => e.hasMeet && e.endMs >= nowMs && !seen.has(e.id) && (seen.add(e.id), true)).sort((a, b) => a.startMs - b.startMs);
  if (!list.length) { meetsEl.innerHTML = `<div class="mt-empty">No upcoming video meetings in this range.</div>`; return; }
  meetsEl.innerHTML = list.map(e => {
    const when = `${e.startDate} · ${e.allDay ? 'All day' : e.timeLabel}`;
    const ds = descSnippet(e.description);
    return `<div class="meet" data-ev="${esc(e.id)}">
      <div class="nm">${esc(e.summary)}</div>
      <div class="tm">${esc(when)}</div>
      ${ds ? `<div class="ds">${esc(ds)}</div>` : ''}
      <a class="joinbtn" href="${esc(e.meetLink)}" target="_blank" rel="noreferrer" data-join="1">Zoe: Join &rarr;</a>
    </div>`;
  }).join('');
  meetsEl.querySelectorAll('.meet').forEach(el => el.addEventListener('click', (ev) => { if (ev.target.closest('[data-join]')) return; openEvent(el.dataset.ev); }));
}

// ============================ event / day modal ============================
function whenLabel(e) {
  if (e.allDay) return e.startDate === e.endDate ? `All day · ${e.startDate}` : `All day · ${e.startDate} → ${e.endDate}`;
  return `${e.startDate ? e.startDate + ' · ' : ''}${e.timeLabel}`;
}
function openEvent(id) {
  const e = events.find(x => x.id === id); if (!e) return;
  const writable = calWritable(e.calendarId);
  const calName = (calById(e.calendarId) || {}).summary || '';
  const att = e.attendees && e.attendees.length
    ? `<div class="mrow"><span class="k">Guests</span><span class="v"><div class="att">${e.attendees.slice(0, 30).map(a => `<span class="a">${esc(a.name || a.email)}${a.status === 'accepted' ? ' ✓' : a.status === 'declined' ? ' ✕' : a.status === 'tentative' ? ' ~' : ''}</span>`).join('')}</div></span></div>` : '';
  modalEl.innerHTML = `
    <button class="mclose" id="mclose">×</button>
    <div class="mt"><span class="csw" style="background:${esc(colorOf(e))}"></span><span>${esc(e.summary)}</span></div>
    <div class="when">${esc(whenLabel(e))}${e.recurring ? ' · recurring' : ''}</div>
    ${calName ? `<div class="mrow"><span class="k">Calendar</span><span class="v">${esc(calName)}${writable ? '' : ' (read-only)'}</span></div>` : ''}
    ${e.location ? `<div class="mrow"><span class="k">Where</span><span class="v">${esc(e.location)}</span></div>` : ''}
    ${e.organizer ? `<div class="mrow"><span class="k">Organizer</span><span class="v">${esc(e.organizer)}</span></div>` : ''}
    ${att}
    ${e.hasMeet ? `<a class="join" href="${esc(e.meetLink)}" target="_blank" rel="noreferrer">Join Google Meet</a>` : ''}
    ${e.description ? `<div class="desc">${sanitizeDesc(e.description)}</div>` : ''}
    <div class="mactions">
      ${writable ? `<button class="btn primary" id="editBtn">Edit</button><button class="btn danger" id="delBtn">Delete</button>` : `<span class="note">This calendar is read-only — events can't be edited here.</span>`}
    </div>`;
  $('mclose').addEventListener('click', closeModal);
  if (writable) {
    $('editBtn').addEventListener('click', () => openEditor(CV.eventToForm(e), { isNew: false, eventId: e.id, recurring: e.recurring }));
    $('delBtn').addEventListener('click', () => confirmDelete(e));
  }
  modalBg.classList.add('show');
}

// ---- event editor (create / edit) ----
function openEditor(form, { isNew, eventId, recurring } = {}) {
  const cid = (form && form.calendarId && calWritable(form.calendarId)) ? form.calendarId : defaultCalId();
  const f = Object.assign({ summary: '', allDay: false, startDate: ymd(anchor), startTime: '09:00', endDate: ymd(anchor), endTime: '10:00', location: '', description: '' }, form || {}, { calendarId: cid });
  const calOpts = writableCals().map(c => `<option value="${esc(c.id)}"${c.id === cid ? ' selected' : ''}>${esc(c.summary)}</option>`).join('');
  modalEl.innerHTML = `
    <button class="mclose" id="mclose">×</button>
    <div class="mt"><span>${isNew ? 'New event' : 'Edit event'}</span></div>
    ${recurring ? `<div class="note" style="margin-top:6px">Recurring event — changes apply to this occurrence only.</div>` : ''}
    <div class="form">
      <div class="field"><label>Title</label><input type="text" id="f-summary" value="${esc(f.summary)}" placeholder="(no title)" autocomplete="off"></div>
      <div class="field"><label>Calendar</label><select id="f-cal">${calOpts}</select></div>
      <div class="field chk"><input type="checkbox" id="f-allday"${f.allDay ? ' checked' : ''}><label for="f-allday">All day</label></div>
      <div class="row2">
        <div class="field"><label>Start date</label><input type="date" id="f-sdate" value="${esc(f.startDate)}"></div>
        <div class="field" id="w-stime"><label>Start time</label><input type="time" id="f-stime" value="${esc(f.startTime)}"></div>
      </div>
      <div class="row2">
        <div class="field"><label>End date</label><input type="date" id="f-edate" value="${esc(f.endDate)}"></div>
        <div class="field" id="w-etime"><label>End time</label><input type="time" id="f-etime" value="${esc(f.endTime)}"></div>
      </div>
      <div class="field"><label>Location</label><input type="text" id="f-loc" value="${esc(f.location)}" autocomplete="off"></div>
      <div class="field"><label>Description</label><textarea id="f-desc">${esc(f.description)}</textarea></div>
      <div class="ferr" id="f-err" hidden></div>
      <div class="mactions">
        <button class="btn primary" id="saveBtn">${isNew ? 'Create' : 'Save'}</button>
        <button class="btn" id="cancelBtn">Cancel</button>
        ${isNew ? '' : `<button class="btn danger" id="delBtn2">Delete</button>`}
      </div>
    </div>`;
  const toggleTimes = () => { const on = $('f-allday').checked; $('w-stime').style.display = on ? 'none' : ''; $('w-etime').style.display = on ? 'none' : ''; };
  toggleTimes();
  $('f-allday').addEventListener('change', toggleTimes);
  $('mclose').addEventListener('click', closeModal);
  $('cancelBtn').addEventListener('click', closeModal);
  if (!isNew && $('delBtn2')) $('delBtn2').addEventListener('click', () => { const e = events.find(x => x.id === eventId); if (e) confirmDelete(e); });
  $('saveBtn').addEventListener('click', () => saveEditor({ isNew, eventId }));
  modalBg.classList.add('show');   // editor can be opened directly (header/empty-slot), not only from the detail modal
}

function gatherForm() {
  const calId = $('f-cal').value;
  return {
    calendarId: calId, timeZone: calTz(calId),
    summary: $('f-summary').value, allDay: $('f-allday').checked,
    startDate: $('f-sdate').value, startTime: $('f-stime').value,
    endDate: $('f-edate').value || $('f-sdate').value, endTime: $('f-etime').value,
    location: $('f-loc').value, description: $('f-desc').value,
  };
}
function fErr(msg) { const el = $('f-err'); if (el) { el.textContent = msg; el.hidden = !msg; } }
async function saveEditor({ isNew, eventId }) {
  const form = gatherForm();
  if (!form.startDate) return fErr('Start date is required.');
  if (!form.allDay && form.endDate === form.startDate && form.endTime && form.startTime && form.endTime < form.startTime) return fErr('End time is before start time.');
  const btn = $('saveBtn'); if (btn) { btn.disabled = true; btn.textContent = '…'; }
  try {
    const res = isNew
      ? await window.sq.calendar.createEvent(form.calendarId, form)
      : await window.sq.calendar.updateEvent(form.calendarId, eventId, form);
    if (!res || !res.ok) { fErr((res && res.error) || 'save failed'); if (btn) { btn.disabled = false; btn.textContent = isNew ? 'Create' : 'Save'; } return; }
    closeModal();
    if (!selected.has(form.calendarId)) selected.add(form.calendarId);
    await load(); renderActive();
  } catch (e) { fErr(e.message); if (btn) { btn.disabled = false; btn.textContent = isNew ? 'Create' : 'Save'; } }
}
async function confirmDelete(e) {
  if (!window.confirm(`Delete "${e.summary}"?${e.recurring ? ' (this occurrence)' : ''}`)) return;
  try {
    const res = await window.sq.calendar.deleteEvent(e.calendarId, e.id);
    if (!res || !res.ok) { alert((res && res.error) || 'delete failed'); return; }
    closeModal(); await load(); renderActive();
  } catch (err) { alert(err.message); }
}
// New event prefilled to a day/time. allDay when no time given.
function newEventAt(dateKey, startMin) {
  const allDay = startMin == null;
  const s = allDay ? '09:00' : minToHHMM(Math.max(0, Math.min(1410, startMin)));
  const e = allDay ? '10:00' : minToHHMM(Math.max(30, Math.min(1440, startMin + 60)));
  openEditor({ calendarId: defaultCalId(), allDay, startDate: dateKey, endDate: dateKey, startTime: s, endTime: e }, { isNew: true });
}

function closeModal() { modalBg.classList.remove('show'); }
modalBg.addEventListener('click', (e) => { if (e.target === modalBg) closeModal(); });

// ============================ connect + init ============================
async function doConnect() {
  setStatus('connecting');
  try { const res = await window.sq.calendar.connect(); if (res && res.ok) { await init(); return; } showDisconnected((res && res.error) || 'connect failed'); }
  catch (e) { showDisconnected(e.message); }
}
function setStatus(state, email) {
  statusPill.className = 'pill' + (state === 'on' ? ' on' : state === 'off' ? ' off' : '');
  statusText.textContent = state === 'on' ? (email || 'Connected') : state === 'connecting' ? 'Connecting… approve in browser' : 'Connect Google';
  statusPill.onclick = state === 'off' ? doConnect : null;
}
function showDisconnected(err) {
  setStatus('off');
  viewport.innerHTML = `<div class="status"><div class="big">Google Calendar isn't connected</div>
    <div>Connect the operator's Google account to view the calendar. A browser window opens for a one-time approval.</div>
    ${err ? `<div class="err" style="margin-top:8px">${esc(err)}</div>` : ''}
    <button class="connectbtn" id="cbtn">Connect Google</button></div>`;
  $('cbtn').addEventListener('click', doConnect);
}
async function init() {
  if (!CV || typeof CV.layoutDay !== 'function') {
    viewport.innerHTML = `<div class="status err"><div class="big">Calendar view module failed to load</div><div>studio/calendar_view.js did not load in the surface (window.CalendarView missing).</div></div>`;
    return;
  }
  const st = await window.sq.calendar.authStatus();
  if (!st || !st.connected) { showDisconnected(st && st.error); return; }
  setStatus('on', st.email);
  if (st.email) acctEl.textContent = st.email;
  const res = await window.sq.calendar.listCalendars();
  if (!res || !res.ok) { showDisconnected(res && res.error); return; }
  calendars = res.calendars || [];
  colors = res.colors || { event: {}, calendar: {} };
  selected.clear();
  calendars.forEach(c => { if (c.selected) selected.add(c.id); });
  if (!selected.size && calendars[0]) selected.add(calendars[0].id);
  renderCalList();
  await refresh();
}
init();
