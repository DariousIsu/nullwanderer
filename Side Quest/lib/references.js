/* references.js — what the names in Lucas's message actually REFER TO.
 *
 * ── The problem, from a live turn (2026-07-21) ──────────────────────────────────────────────────
 *
 *   "I am drinking some coffee getting ready for all our meetings today. We have the Rainey weekly
 *    all hands at 1045 and that goes straight into the publications meeting … Then we have the
 *    Electrify America meeting that got rescheduled to 1630"
 *
 * Four references in one sentence, of three different kinds: a SHORT NAME for an org she should know
 * cold (Rainey → the Rainey Center), a NAMED ORG (Electrify America), and RECURRING MEETINGS she has
 * personally sat in — which means she already holds their rosters.
 *
 * She resolved none of them. Not because extraction failed: lib/intake.decompose already returns a
 * full plan — {objects[], relations[], constraints[]}, typed, with predicates like `attends` and
 * `scheduled_for`. The chat path then called mention._pickObject, which keeps ONE object and discards
 * the rest, and the prompt had nowhere to put more than one anyway.
 *
 * ── Why this cannot just "look it up" ───────────────────────────────────────────────────────────
 *
 * Measured before building. Neither of his two most-used names has a canonical object:
 *
 *   "Rainey"            → 10 hits. Best-ranked is an EVENT ("Rainey Centers Lamp National Summit").
 *                         His employer exists only as duplicated LDA artifacts:
 *                         "THE RAINEY CENTER FREEDOM PROJECT" + "RAINEY CENTER FREEDOM PROJECT, INC."
 *   "Electrify America" → 3 rows: lobby_client 211127, lobby_registrant 401104811, lobby_client 202775.
 *
 * Taking the top FTS hit would have answered him about a summit. That is the "which Zoe do you mean"
 * failure wearing a different hat, and it is why AMBIGUOUS is a first-class outcome here: a reference
 * we cannot pin is reported as unresolved, never guessed. The cloud can ask; it cannot un-assert.
 *
 * ── Owner vocabulary ────────────────────────────────────────────────────────────────────────────
 *
 * "Rainey" means the Rainey Center because it means that TO LUCAS. That is not a fact about the civic
 * graph and must not be fused into it — it is his working vocabulary, so it lives in meta JSON
 * (`owner_vocabulary`), owner-scoped, and is marked unverified unless it carries a source. Standing
 * rule: user input without documentation still creates the reference, as UNVERIFIED, and we go
 * looking for a real source. It is consulted BEFORE Echo precisely because the graph's answer for
 * these names is wrong.
 *
 * Deliberately no new table: another session is moving the database as this is written.
 *
 * ── Meetings ────────────────────────────────────────────────────────────────────────────────────
 *
 * meeting_transcript holds 4,398 lines over 19 distinct speakers, keyed by Google Meet CODE, not by
 * name. The recurrence is real and visible — "mav-myni-mkw" spans 2026-07-07 → 07-14 with 14
 * speakers — so a series and its roster are both derivable. What is NOT derivable is the LABEL: no
 * data links the phrase "Rainey weekly all hands" to a Meet code (that lives in the calendar, which
 * is planned and unbuilt).
 *
 * So we hand over what we actually have — the recurring series, when they meet, and who is in them —
 * and say plainly that the codes are unlabelled. The cloud has the conversation and can bind by day
 * and time if it fits. What it must not do is assert a binding we never established, so the block
 * says so in as many words.
 *
 * Pure-ish: every reader is injectable, nothing throws, and a total failure returns ''.
 */
'use strict';

const MAX_REFS = 6;              // a reference list is a lookup aid, not a dossier
const MAX_ROSTER = 12;
const MAX_SERIES = 3;
const RECURRING_MIN_DAYS = 2;    // met on 2+ distinct days ⇒ it recurs

/** Owner vocabulary: {surface → {name, type, note, verified}}. Keys matched case/space-insensitively. */
function _vocab(deps = {}) {
  try {
    const get = deps.getMeta || require('./db').getMeta;
    const raw = get('owner_vocabulary');
    const v = raw ? JSON.parse(raw) : null;
    return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  } catch { return {}; }
}

function _key(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

/** Look a surface form up in the owner vocabulary — exact key, then the longest contained key. */
function _fromVocab(mention, vocab) {
  const k = _key(mention);
  if (!k) return null;
  if (vocab[k]) return { ...vocab[k], via: 'vocabulary' };
  // "the Rainey weekly all hands" contains "rainey" — take the LONGEST match so a more specific
  // entry ("rainey all hands") always beats a broader one ("rainey").
  let best = null;
  for (const vk of Object.keys(vocab)) {
    if (!vk) continue;
    if ((` ${k} `).includes(` ${vk} `) || k.startsWith(vk + ' ') || k.endsWith(' ' + vk)) {
      if (!best || vk.length > best.length) best = vk;
    }
  }
  return best ? { ...vocab[best], via: 'vocabulary', matched: best } : null;
}

/**
 * RECURRING MEETING SERIES she has actually sat in, with rosters.
 *
 * A "session" is a distinct calendar day for a Meet code; 2+ sessions ⇒ recurring. The roster is the
 * distinct speakers — which is an ENCOUNTER-grade fact: she was there and heard them. Media captures
 * ("media:…") are excluded; they are video transcripts, not meetings, and carry no speakers.
 */
function meetingSeries(deps = {}) {
  try {
    const all = deps.meetingRows ? deps.meetingRows() : require('./db').getMeetingRosterRows();
    const by = new Map();
    for (const r of all || []) {
      const m = String(r.meeting || '').trim();
      if (!m) continue;
      if (!by.has(m)) by.set(m, { code: m, days: new Set(), speakers: new Map(), last: 0 });
      const s = by.get(m);
      // EASTERN day boundary, not UTC. `toISOString().slice(0,10)` rolls over at 8pm Eastern, so an
      // evening meeting was filed on the NEXT day — which both split one session into two and made a
      // weekly series look like it met on two different weekdays.
      if (Number.isFinite(r.ts)) { s.days.add(require('./tz').dayKey(r.ts)); s.last = Math.max(s.last, r.ts); }
      const sp = String(r.speaker || '').trim();
      if (sp) s.speakers.set(sp, (s.speakers.get(sp) || 0) + 1);
    }
    return [...by.values()]
      .filter((s) => s.days.size >= RECURRING_MIN_DAYS && s.speakers.size > 0)
      .map((s) => ({
        code: s.code,
        sessions: s.days.size,
        last: s.last,
        // weekday of the sessions — the only binding signal we have for "the weekly all hands".
        // Noon Eastern (not noon UTC) so the day never slips across the boundary either way.
        weekdays: [...new Set([...s.days].map((d) => require('./tz').weekday(Date.parse(`${d}T16:00:00Z`))))].filter((d) => d != null).sort(),
        // most-talkative first: the regulars, not everyone who ever said "morning"
        roster: [...s.speakers.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_ROSTER).map(([n]) => n),
      }))
      .sort((a, b) => b.last - a.last)
      .slice(0, MAX_SERIES);
  } catch { return []; }
}

// ── THE LABEL, from the calendar ────────────────────────────────────────────────────────────────
//
// The transcripts know WHO and WHEN; only the calendar knows WHAT IT IS CALLED. A Google Meet link
// on an event is the join key, and it closes the gap this module shipped with:
//
//   mav-myni-mkw → "Rainey Weekly Huddle"                (recurring, 28 invited)
//   vud-sptv-wbh → "Energize America|State Policy Labs"  (recurring, 11 invited)
//
// Two different rosters, and both are worth having: INVITED is who is supposed to be there (the
// calendar's answer), REGULARS is who actually speaks (ours, from having sat in the room). When they
// disagree that is a real signal, not an error, so neither is discarded.
//
// Cached for CACHE_MS: this costs a Google round-trip, and it only runs on a turn that mentions a
// meeting at all. Any failure returns an empty map — the series block then degrades to exactly the
// unlabelled behaviour it had before, which is honest rather than broken.
const CACHE_MS = 15 * 60 * 1000;
let _labels = { at: 0, map: new Map() };

/** Turn "bill.dunne@raineycenter.org" into "Bill Dunne"; leave a real display name alone. */
function _person(a) {
  const name = String((a && a.displayName) || '').trim();
  if (name) return name;
  const email = String((a && a.email) || '').trim();
  if (!email) return '';
  const local = email.split('@')[0];
  if (!/[._]/.test(local)) return local;
  return local.split(/[._]+/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/** code → { title, invited[], recurring } for every Meet-linked event in the recent window. */
async function meetingLabels(deps = {}, { now = Date.now() } = {}) {
  if (deps.labels) { try { return await deps.labels(); } catch { return new Map(); } }
  if (_labels.map.size && (now - _labels.at) < CACHE_MS) return _labels.map;
  // Resolve Echo's venv bridge the same way main.js does, rather than threading {python,cwd} down
  // through every caller. A caller that HAS it (the chat turn) still passes it and wins.
  const opts = deps.gcalOpts || (() => {
    try {
      const path = require('path');
      const cwd = process.env.ECHO_CWD || 'C:/Users/azrae/Desktop/NX ECHO/nx-echo';
      return { python: process.env.ECHO_PYTHON || path.join(cwd, '.venv', 'Scripts', 'python.exe'), cwd };
    } catch { return null; }
  })();
  if (!opts || !opts.python) return new Map();
  const map = new Map();
  try {
    const gcal = deps.gcal || require('./gcal');
    const cals = await gcal.listCalendars(opts);
    const timeMin = new Date(now - 28 * 86400000).toISOString();
    const timeMax = new Date(now + 7 * 86400000).toISOString();
    for (const c of ((cals && cals.items) || [])) {
      // Owner calendars only. A subscribed holiday/payroll feed carries no meetings of his and its
      // events would just cost a round-trip.
      if (c.accessRole !== 'owner' && c.accessRole !== 'writer') continue;
      let ev; try { ev = await gcal.listEvents({ calendarId: c.id, timeMin, timeMax }, opts); } catch { continue; }
      for (const e of ((ev && ev.items) || [])) {
        const m = String(e.hangoutLink || '').match(/meet\.google\.com\/([a-z-]+)/i);
        if (!m) continue;
        const code = m[1];
        const invited = (e.attendees || []).map(_person).filter(Boolean);
        const prev = map.get(code);
        // Keep the richest sighting of a recurring series rather than the last one seen.
        if (!prev || invited.length > prev.invited.length) {
          map.set(code, { title: String(e.summary || '').trim(), invited, recurring: !!e.recurringEventId });
        }
      }
    }
  } catch { return new Map(); }
  _labels = { at: now, map };
  return map;
}

const _DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** Does the message talk about a meeting at all? Only then is the series list worth its tokens. */
const MEETING_RE = /\b(meeting|meet|all[\s-]?hands|standup|stand[\s-]?up|sync|call|session|huddle|briefing|1:1|one[\s-]on[\s-]one|agenda|attendees?|calendar)\b|meet\.google\.com/i;
// A Meet code pasted straight into the message — "join the morning meeting meet.google.com/mav-myni-mkw".
// This IS a reference, and the most precisely resolvable kind we get: an exact key, no disambiguation.
const MEET_CODE_RE = /meet\.google\.com\/([a-z]{3,}-[a-z]{3,}-[a-z]{3,})/gi;

/**
 * Resolve every salient mention in the message.
 *
 * Order matters: OWNER VOCABULARY first (the graph is measurably wrong on his own shorthand), then
 * the Echo resolver. Anything the resolver reports as ambiguous or nil stays UNRESOLVED — we surface
 * the candidates and let the cloud ask.
 */
async function resolveAll(objects, deps = {}) {
  const vocab = _vocab(deps);
  const resolve = deps.resolve || ((mention, opts) => {
    try { return require('./echo_suit').resolveMention(mention, opts); } catch { return Promise.resolve({ status: 'error', mention }); }
  });
  // Observation-grounded footing for a resolved name (substantiation-gate §1.4): pinned ⇔ some
  // encounter identity-confirmed it; source-vouched ⇔ a source stands behind it; else unsubstantiated.
  // Fail-soft to null (no local record) → render falls back to the reference-store verified flag.
  const footingFor = deps.footing || ((name) => {
    try { return require('./substantiation_gate').stateFor(require('./db'), name); } catch { return null; }
  });
  const out = [];
  const seen = new Set();
  for (const o of (objects || [])) {
    const mention = String((o && o.mention) || '').trim();
    if (!mention) continue;
    const k = _key(mention);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    if (out.length >= MAX_REFS) break;

    const v = _fromVocab(mention, vocab);
    if (v && v.name) {
      out.push({ mention, status: 'resolved', name: v.name, type: v.type || o.type || null, note: v.note || null, verified: v.verified === true, via: 'vocabulary', footing: footingFor(v.name) });
      continue;
    }
    let r; try { r = await resolve(mention, { preferType: (o && o.type) || null }); } catch { r = null; }
    const st = (r && r.status) || 'error';
    if (st === 'resolved' && r.object) {
      out.push({ mention, status: 'resolved', name: r.object.name || mention, type: r.object.entity_type || (o && o.type) || null, note: null, verified: true, via: 'graph', footing: footingFor(r.object.name || mention) });
    } else if (st === 'ambiguous') {
      out.push({ mention, status: 'ambiguous', type: (o && o.type) || null, candidates: (Array.isArray(r.candidates) ? r.candidates : []).slice(0, 3), via: 'graph' });
    } else {
      out.push({ mention, status: 'unknown', type: (o && o.type) || null, via: st === 'error' ? 'error' : 'graph' });
    }
  }
  return out;
}

// The footing marker for a resolved reference (substantiation-gate §1.4). Precedence mirrors the gate's
// STRONGEST-ACROSS-ENCOUNTERS: identity-confirmed (pinned) is trustworthy → no mark; source-vouched says a
// source stands behind it but the identity is not confirmed; unsubstantiated is prove-or-fade, not a fact.
// When the observation/node stores have NO record of the name (footing null), fall back to the reference-
// store's own verified flag — behavior is unchanged for names the substantiation substrate never saw.
function _footingMark(r) {
  const f = r && r.footing;
  if (f && f.pinned) return '';                                                        // identity-confirmed
  const state = f && f.state ? String(f.state).trim().toLowerCase() : null;
  if (state === 'source-vouched') return ' [source-backed — identity not confirmed]';
  if (state === 'unsubstantiated') return ' [unsubstantiated — no confirmation yet; don’t assert as fact]';
  return (r && r.verified) ? '' : ' [unverified — his usage, no source yet]';
}

/**
 * Render the REFERENCES section.
 *
 * Counts and keys, same discipline as the manifest — never rows. An empty result renders '' so the
 * package spends nothing on a turn with no references in it.
 */
function render(refs = [], series = [], { includeSeries = false, now = Date.now() } = {}) {
  const lines = [];
  const known = (refs || []).filter((r) => r && r.status === 'resolved');
  const open = (refs || []).filter((r) => r && r.status !== 'resolved');

  if (known.length) {
    lines.push('REFERENCES — what these names mean in this conversation. Use them as the subject; do not re-derive them:');
    for (const r of known) {
      const bits = [r.type, r.note].filter(Boolean).join(' — ');
      const mark = _footingMark(r);
      lines.push(`• "${r.mention}" → ${r.name}${bits ? ` (${bits})` : ''}${mark}`);
    }
  }
  if (open.length) {
    lines.push((lines.length ? '\n' : '') + 'NOT PINNED DOWN — do not guess which one they mean. If it matters to the answer, ask:');
    for (const r of open) {
      const cands = (r.candidates || []).length ? ` — could be: ${r.candidates.join('; ')}` : '';
      lines.push(`• "${r.mention}"${r.type ? ` (${r.type})` : ''} — ${r.status === 'ambiguous' ? 'several records match' : 'no record'}${cands}`);
    }
  }
  if (includeSeries && series && series.length) {
    lines.push((lines.length ? '\n' : '') + 'RECURRING MEETINGS YOU HAVE SAT IN — you already know these and who is in them:');
    for (const s of series) {
      const when = s.weekdays && s.weekdays.length ? s.weekdays.map((d) => _DOW[d]).join('/') : 'no fixed day';
      const ago = s.last ? `${Math.max(0, Math.round((now - s.last) / 86400000))}d ago` : 'unknown';
      // The calendar's title is the NAME he actually speaks; the Meet code is our internal key and
      // is worth nothing to him, so it trails in parentheses.
      const head = s.title ? `${s.title} (${s.code})` : s.code;
      lines.push(`• ${head} — ${s.sessions} sessions, ${when}, last ${ago}`);
      lines.push(`    regulars (who actually speaks, from sitting in): ${s.roster.join(', ')}`);
      // INVITED and REGULARS answer different questions. Kept apart on purpose: "who is supposed to
      // be there" is the calendar's claim, "who talks" is ours, and a gap between them is real
      // information — not something to average away.
      if (s.invited && s.invited.length) {
        lines.push(`    invited (from the calendar, ${s.invited.length}): ${s.invited.slice(0, MAX_ROSTER).join(', ')}${s.invited.length > MAX_ROSTER ? ', …' : ''}`);
      }
    }
    const unlabelled = series.filter((s) => !s.title);
    if (unlabelled.length) {
      // The pre-calendar caveat, now scoped to the ones we genuinely cannot name.
      lines.push(`Nothing links ${unlabelled.map((s) => s.code).join(', ')} to a spoken name. If the day and time `
        + 'they mention match one, you may say so as a question; never state which meeting they mean as though '
        + 'we recorded it.');
    }
  }
  return lines.join('\n');
}

/**
 * THE MEETING'S OWN CONTEXT — who is in this room, what this meeting is, whose it is.
 *
 * Lucas, 2026-07-21: "she's not properly identifying people places and events by starting with the
 * context of the meeting and who is there before going broad."
 *
 * He is describing a missing input, not a bad model. `modelMeetingTurn` was handed recent captions,
 * a generic semantic recall over those captions, and a GLOBAL top-facts list — and nothing else. The
 * attendee list was scraped once at intro and thrown away. So when a caption said "Sarah", nothing in
 * the prompt connected it to Sarah Hunt sitting in the call; the model's only option was to reach
 * outward into a graph holding 1.7M entities and hope.
 *
 * A meeting is the strongest disambiguation context this system ever gets: a closed set of named
 * people, a titled recurring series, and one organisation. Everything here is already ours — the live
 * attendee panel, the calendar's invite list, the regulars from having sat in previous sessions, and
 * his own vocabulary. It just was never assembled and handed over.
 *
 * `present` is the live attendee panel (highest authority — she can see them).
 */
async function meetingContext({ code = null, present = [], deps = {}, now = Date.now() } = {}) {
  const lines = [];
  let labels = new Map();
  try { labels = await meetingLabels(deps, { now }); } catch { /* no calendar → the rest still stands */ }
  const label = code ? labels.get(String(code).toLowerCase()) : null;

  let series = null;
  try {
    const all = (deps.series ? deps.series() : meetingSeries(deps)) || [];
    series = all.find((s) => s.code === code) || null;
  } catch { /* no transcripts → no regulars */ }

  const title = (label && label.title) || null;
  lines.push(`THIS MEETING: ${title || (code ? `an unnamed call (${code})` : 'a call')}`
    + (series ? ` — you have sat in ${series.sessions} session(s) of it` : ''));

  // The owner's organisation, from his own vocabulary. It is why "Rainey" in a caption is his
  // employer and not a Milwaukee alderman.
  try {
    const v = _vocab(deps);
    const orgs = [...new Set(Object.values(v).map((e) => e && e.name).filter(Boolean))];
    if (orgs.length) lines.push(`WHOSE WORLD THIS IS: ${orgs.join(', ')} — names in this call almost always belong to that world before any other.`);
  } catch { /* vocabulary is optional */ }

  const seen = new Set();
  const add = (arr, how) => {
    const names = (arr || []).map((n) => String(n || '').trim()).filter(Boolean).filter((n) => {
      const k = _key(n); if (!k || seen.has(k)) return false; seen.add(k); return true;
    });
    if (names.length) lines.push(`  ${how}: ${names.slice(0, 24).join(', ')}`);
    return names.length;
  };
  lines.push('WHO IS IN THIS ROOM — resolve every name you hear against THESE PEOPLE FIRST:');
  // Order is authority order: seen > invited > previously heard.
  let n = 0;
  n += add(present, 'in the call right now (you can see them)');
  n += add(label && label.invited, 'invited on the calendar');
  n += add(series && series.roster, 'regulars from past sessions of this meeting');
  if (!n) lines.push('  (nobody identified yet — say so rather than guessing at who is speaking)');

  lines.push('HOW TO IDENTIFY WHAT YOU HEAR — narrowest first, and STOP as soon as it fits:');
  lines.push('  1. A first name, nickname or initials almost always means someone in this room. Bind it there.');
  lines.push('  2. Then this organisation\'s own work — its people, projects, bills and past meetings.');
  lines.push('  3. Only then the wider world. A national figure who happens to share a first name with '
    + 'someone in this call is the WRONG answer.');
  lines.push('  4. If a name, place or event does not fit any of these, say it is unfamiliar. An honest '
    + '"I don\'t know who that is" is worth more here than a confident stranger.');
  return lines.join('\n');
}

/**
 * THE ENTRY POINT — message in, REFERENCES section out.
 *
 * `objects` comes from the caller (lib/intake.decompose's plan), so this module stays offline-testable
 * and does not decide when to spend a cloud call on decomposition.
 */
async function build(userMessage, { objects = [], deps = {}, now = Date.now() } = {}) {
  const refs = await resolveAll(objects, deps);
  const wantsMeetings = MEETING_RE.test(String(userMessage || ''));
  // meetingSeries swallows its own failures, but an injected reader (or a DB mid-move) can still
  // throw — and a dead transcript table must cost us the meeting block, never the whole turn.
  let series = [];
  if (wantsMeetings) {
    try { series = (deps.series ? deps.series() : meetingSeries(deps)) || []; } catch { series = []; }
    // Label them from the calendar. A failure here costs the NAMES, never the block.
    let labels = new Map();
    try { labels = await meetingLabels(deps, { now }); } catch { /* unlabelled is the honest fallback */ }
    series = series.map((s) => {
      const l = labels.get(s.code);
      return l ? { ...s, title: l.title || null, invited: l.invited || [] } : s;
    });
    // A PASTED MEET LINK IS A REFERENCE. Live 2026-07-21: "join the morning meeting
    // meet.google.com/mav-myni-mkw" — she joined it correctly but called it "the morning meeting",
    // while the block below already knew that code is the Rainey Weekly Huddle. An exact key needs
    // no disambiguation, so it resolves outright; front of the list, since he just named it.
    const codes = [...String(userMessage || '').matchAll(MEET_CODE_RE)].map((m) => m[1].toLowerCase());
    for (const code of [...new Set(codes)].reverse()) {
      const l = labels.get(code);
      if (!l || !l.title) continue;
      if (refs.some((r) => _key(r.mention) === _key(code) || _key(r.name || '') === _key(l.title))) continue;
      refs.unshift({ mention: code, status: 'resolved', name: l.title, type: 'meeting', note: 'the meeting he just linked', verified: true, via: 'calendar' });
    }
  }
  const text = render(refs, series, { includeSeries: wantsMeetings, now });
  return { text, refs, series };
}

module.exports = { build, render, resolveAll, meetingSeries, meetingLabels, meetingContext, _person, _fromVocab, _vocab, _key, MEETING_RE, MAX_REFS };
