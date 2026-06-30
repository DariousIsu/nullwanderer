/*
 * Calendar surface — standardized VIEW model. Pure mappers from Google Calendar v3 JSON
 * (calendarList.list / events.list / colors) → fixed render shapes the surface draws. No model,
 * no I/O. The auth + REST calls live in lib/gcal.js (main process); this is the deterministic
 * normalization layer, unit-tested offline. Same idiom as studio/crm_view.js + studio/poll_view.js.
 *
 * Runs in Node (smoke) and the browser (surface): CommonJS + window fallback.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.CalendarView = api;
})(this, function () {
  'use strict';

  const pad2 = (n) => String(n).padStart(2, '0');
  // Local Y-M-D for a Date (placement key for the month/week grids).
  function ymd(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }

  // Google start/end node → normalized stamp. All-day uses {date:'YYYY-MM-DD'}; timed uses
  // {dateTime:RFC3339, timeZone}. We keep ms (for sort/range), a local date key, and a HH:MM label.
  function parseStamp(node) {
    if (!node) return null;
    if (node.date) {
      const d = new Date(node.date + 'T00:00:00');
      return { allDay: true, raw: node.date, ms: d.getTime(), date: node.date, time: '' };
    }
    if (node.dateTime) {
      const d = new Date(node.dateTime);
      const ms = d.getTime();
      const ok = !Number.isNaN(ms);
      return { allDay: false, raw: node.dateTime, ms: ok ? ms : 0, date: ok ? ymd(d) : '', time: ok ? `${pad2(d.getHours())}:${pad2(d.getMinutes())}` : '' };
    }
    return null;
  }

  // The video-conference link for an event: hangoutLink, else a conferenceData video entryPoint.
  function meetLinkOf(ev) {
    if (ev.hangoutLink) return ev.hangoutLink;
    const eps = ev.conferenceData && Array.isArray(ev.conferenceData.entryPoints) ? ev.conferenceData.entryPoints : [];
    const vid = eps.find(e => e && e.entryPointType === 'video' && e.uri);
    return vid ? vid.uri : '';
  }

  // calendarList item → toggleable calendar row. `selected` defaults true (Google omits it when on).
  function normalizeCalendar(c) {
    if (!c || !c.id) return null;
    const role = c.accessRole || '';
    return {
      id: c.id,
      summary: c.summaryOverride || c.summary || c.id,
      description: c.description || '',
      color: c.backgroundColor || '#6a86b6',
      fg: c.foregroundColor || '#e8e8eb',
      colorId: c.colorId || '',
      primary: c.primary === true,
      selected: c.selected !== false,
      accessRole: role,
      canWrite: role === 'owner' || role === 'writer',
      timeZone: c.timeZone || '',
    };
  }

  function normalizeCalendarList(payload) {
    const items = (payload && Array.isArray(payload.items)) ? payload.items : [];
    const mapped = items.map(normalizeCalendar).filter(Boolean);
    // primary first, then alphabetical by name.
    mapped.sort((a, b) => (b.primary - a.primary) || a.summary.localeCompare(b.summary));
    return mapped;
  }

  // One Calendar v3 event → view shape. `calendarId`/`calColor` are injected by the caller (events
  // come scoped to a calendar). Cancelled events are flagged (caller may drop them).
  function normalizeEvent(ev, ctx = {}) {
    if (!ev || !ev.id) return null;
    const start = parseStamp(ev.start);
    const end = parseStamp(ev.end);
    const allDay = !!(start && start.allDay);
    const attendees = Array.isArray(ev.attendees) ? ev.attendees : [];
    return {
      id: ev.id,
      calendarId: ctx.calendarId || '',
      summary: ev.summary || '(no title)',
      status: ev.status || 'confirmed',
      cancelled: ev.status === 'cancelled',
      start, end, allDay,
      startMs: start ? start.ms : 0,
      endMs: end ? end.ms : (start ? start.ms : 0),
      startDate: start ? start.date : '',
      // For all-day events Google's end.date is EXCLUSIVE (the morning after). Display end is the
      // last covered day; single all-day events then have startDate === endDate.
      endDate: end ? (allDay ? ymd(new Date(end.ms - 86400000)) : end.date) : (start ? start.date : ''),
      timeLabel: allDay ? 'All day' : (start ? start.time + (end && end.time ? `–${end.time}` : '') : ''),
      location: ev.location || '',
      description: ev.description || '',
      meetLink: meetLinkOf(ev),
      hasMeet: !!meetLinkOf(ev),
      colorId: ev.colorId || '',
      color: ctx.calColor || '',
      recurring: !!ev.recurringEventId,
      recurringEventId: ev.recurringEventId || '',
      htmlLink: ev.htmlLink || '',
      organizer: (ev.organizer && (ev.organizer.displayName || ev.organizer.email)) || '',
      attendeeCount: attendees.length,
      attendees: attendees.map(a => ({ email: a.email || '', name: a.displayName || '', status: a.responseStatus || '', self: a.self === true })),
    };
  }

  // events.list payload → normalized, sorted (start asc), cancelled dropped by default.
  function normalizeEventList(payload, ctx = {}) {
    const items = (payload && Array.isArray(payload.items)) ? payload.items : [];
    const out = items.map(ev => normalizeEvent(ev, ctx)).filter(Boolean).filter(e => !e.cancelled);
    out.sort((a, b) => a.startMs - b.startMs || a.summary.localeCompare(b.summary));
    return { events: out, nextPageToken: (payload && payload.nextPageToken) || null, timeZone: (payload && payload.timeZone) || '' };
  }

  // colors payload → { event:{id:{background,foreground}}, calendar:{...} } passthrough with safe shape.
  function colorMap(payload) {
    const p = payload || {};
    return { event: p.event || {}, calendar: p.calendar || {} };
  }

  // Resolve the effective swatch for an event: explicit event colorId wins, else the calendar color.
  function eventColor(ev, colors) {
    if (ev && ev.colorId && colors && colors.event && colors.event[ev.colorId]) return colors.event[ev.colorId].background;
    return (ev && ev.color) || '#6a86b6';
  }

  // ---- timeline layout (day / week views) ----

  // A timed event's vertical extent within one local day [00:00,24:00), in minutes-from-midnight,
  // clamped to the day. Returns null for all-day events or events that don't intersect the day.
  // continuesBefore/After mark spans that bleed past the day edges (multi-day or overnight).
  function minutesInDay(ev, dayKey) {
    if (!ev || ev.allDay || !ev.startMs) return null;
    const dayStart = new Date(dayKey + 'T00:00:00').getTime();
    const dayEnd = dayStart + 86400000;
    const s = ev.startMs, e = Math.max(ev.endMs || ev.startMs, ev.startMs + 60000); // ≥1 min tall
    if (e <= dayStart || s >= dayEnd) return null;
    const topMin = Math.max(0, Math.round((s - dayStart) / 60000));
    const botMin = Math.min(1440, Math.round((e - dayStart) / 60000));
    return { id: ev.id, topMin, botMin, durMin: Math.max(15, botMin - topMin), continuesBefore: s < dayStart, continuesAfter: e > dayEnd, ev };
  }

  // Greedy lane packing: assign each item a {col, cols} so overlapping events sit side-by-side.
  // Items are clustered by overlap; within a cluster, columns are reused once free. Pure.
  function packColumns(items) {
    const sorted = [...items].sort((a, b) => a.topMin - b.topMin || a.botMin - b.botMin);
    const clusters = []; let cur = [], curEnd = -1;
    for (const it of sorted) {
      if (cur.length && it.topMin >= curEnd) { clusters.push(cur); cur = []; curEnd = -1; }
      cur.push(it); curEnd = Math.max(curEnd, it.botMin);
    }
    if (cur.length) clusters.push(cur);
    const out = [];
    for (const cl of clusters) {
      const colEnd = [];
      for (const it of cl) {
        let placed = false;
        for (let c = 0; c < colEnd.length; c++) { if (it.topMin >= colEnd[c]) { it.col = c; colEnd[c] = it.botMin; placed = true; break; } }
        if (!placed) { it.col = colEnd.length; colEnd.push(it.botMin); }
      }
      for (const it of cl) { it.cols = colEnd.length; out.push(it); }
    }
    return out;
  }

  // All events touching a day, split into all-day (banners) + packed timed items.
  function layoutDay(events, dayKey) {
    const list = (events || []).filter(e => e && !e.cancelled);
    const allDay = list.filter(e => e.allDay && e.startDate <= dayKey && (e.endDate || e.startDate) >= dayKey);
    const timed = packColumns(list.map(e => minutesInDay(e, dayKey)).filter(Boolean));
    return { allDay, timed };
  }

  // 7 local day-keys for the week containing `date` (Sunday-first).
  function weekDays(date) {
    const base = new Date(date.getFullYear(), date.getMonth(), date.getDate() - date.getDay());
    return Array.from({ length: 7 }, (_, i) => ymd(new Date(base.getFullYear(), base.getMonth(), base.getDate() + i)));
  }

  // ---- analytics ----

  const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  // Aggregate stats over a set of normalized events (caller pre-filters to the desired range +
  // selected calendars). Hours are from TIMED events only. Pure + deterministic. nameById maps a
  // calendarId → display name for the per-calendar breakdown (optional).
  function analytics(events, nameById = {}) {
    const ev = (events || []).filter(e => e && !e.cancelled);
    const byWeekday = [0, 0, 0, 0, 0, 0, 0];
    const byHour = new Array(24).fill(0);
    const byCal = {};
    const byDay = {};
    let totalMins = 0, timed = 0, allDay = 0, withMeet = 0, recurring = 0, longest = null;
    for (const e of ev) {
      const mins = e.allDay ? 0 : Math.max(0, Math.round((e.endMs - e.startMs) / 60000));
      if (e.allDay) allDay++;
      else {
        timed++; totalMins += mins;
        if (!longest || mins > longest.mins) longest = { summary: e.summary, mins };
        const d = new Date(e.startMs);
        byWeekday[d.getDay()]++; byHour[d.getHours()]++;
      }
      if (e.hasMeet) withMeet++;
      if (e.recurring) recurring++;
      const c = (byCal[e.calendarId] = byCal[e.calendarId] || { id: e.calendarId, name: nameById[e.calendarId] || e.calendarId, count: 0, mins: 0, color: e.color || '#6a86b6' });
      c.count++; c.mins += mins;
      if (e.startDate) byDay[e.startDate] = (byDay[e.startDate] || 0) + 1;
    }
    let busiest = null;
    for (const k of Object.keys(byDay)) if (!busiest || byDay[k] > busiest.count) busiest = { date: k, count: byDay[k] };
    return {
      total: ev.length, timed, allDay, withMeet, recurring,
      totalHours: Math.round(totalMins / 6) / 10,
      avgMins: timed ? Math.round(totalMins / timed) : 0,
      byWeekday, byHour, weekdayLabels: WEEKDAY,
      byCalendar: Object.values(byCal).sort((a, b) => b.count - a.count).map(c => ({ ...c, hours: Math.round(c.mins / 6) / 10 })),
      busiestDay: busiest, longest,
    };
  }

  // ---- event editor (Slice 3) ----

  const pad2t = (n) => String(n).padStart(2, '0');

  // YYYY-MM-DD + N days (string in, string out). Used for Google's EXCLUSIVE all-day end.
  function addDaysKey(key, n) {
    const d = new Date(key + 'T00:00:00');
    const nd = new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
    return ymd(nd);
  }

  // A normalized event → flat editor-form shape (for the edit modal). Falls back sensibly for new.
  function eventToForm(e) {
    if (!e) return null;
    return {
      id: e.id, calendarId: e.calendarId,
      summary: e.summary === '(no title)' ? '' : e.summary,
      allDay: !!e.allDay,
      startDate: e.startDate || '', startTime: (e.start && !e.allDay) ? e.start.time : '09:00',
      endDate: e.endDate || e.startDate || '', endTime: (e.end && !e.allDay) ? e.end.time : '10:00',
      location: e.location || '', description: e.description || '',
      recurring: !!e.recurring,
    };
  }

  // Editor-form shape → Calendar v3 request body. Handles all-day (date, end EXCLUSIVE) vs timed
  // (dateTime + IANA timeZone). Pure + deterministic. Throws on missing/invalid required fields so
  // the caller can surface a clear message rather than POST a malformed event.
  function toGoogleEvent(form, opts = {}) {
    if (!form || !form.startDate) throw new Error('start date is required');
    const tz = opts.timeZone || form.timeZone || 'UTC';
    const body = {
      summary: (form.summary || '').trim() || '(no title)',
      location: form.location || undefined,
      description: form.description || undefined,
    };
    if (form.allDay) {
      const endBase = form.endDate || form.startDate;
      // Google all-day end.date is exclusive; our form endDate is the LAST covered day → +1.
      body.start = { date: form.startDate };
      body.end = { date: addDaysKey(endBase < form.startDate ? form.startDate : endBase, 1) };
    } else {
      const st = (form.startTime || '00:00'), en = (form.endTime || st);
      const endDate = form.endDate || form.startDate;
      body.start = { dateTime: `${form.startDate}T${st}:00`, timeZone: tz };
      body.end = { dateTime: `${endDate}T${en}:00`, timeZone: tz };
    }
    return body;
  }

  return {
    ymd, parseStamp, meetLinkOf,
    normalizeCalendar, normalizeCalendarList,
    normalizeEvent, normalizeEventList,
    colorMap, eventColor,
    minutesInDay, packColumns, layoutDay, weekDays, analytics, WEEKDAY,
    eventToForm, toGoogleEvent, addDaysKey,
  };
});
