/* smoke_meet_reroute.js — F31: meeting URLs never open in her dedicated browser (built 2026-08-20).
 *
 * The proven gap (Lucas, live): URL-less joins ("join my next meeting") resolved a calendar link and
 * opened it through web.open → her browser — bypassing the canvas funnel the link-in-chat road uses.
 * The guard lives at the ONE browser-open chokepoint: lib/web.open reroutes any meet/teams meeting
 * URL to the registered canvas funnel. The reroute path returns BEFORE any browser machinery, so
 * this smoke never launches chrome; the fall-through path (reroute refused → plain open) needs a
 * live browser and is covered by the wiring's fail-open design + the live KIND retest.
 */
'use strict';
const web = require('../lib/web');

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`); } };

// ── the meeting-URL net (pure) ──────────────────────────────────────────────────────────────────
ok(web.meetingUrlKind('https://meet.google.com/abc-defg-hij') === 'meet', 'a standard meet code → meet');
ok(web.meetingUrlKind('https://meet.google.com/abc-defg-hij?authuser=0') === 'meet', 'query params do not hide the code');
ok(web.meetingUrlKind('https://meet.google.com/lookup/team-standup') === 'meet', 'the /lookup/ form → meet');
ok(web.meetingUrlKind('https://www.meet.google.com/abc-defg-hij') === 'meet', 'www prefix normalized');
ok(web.meetingUrlKind('https://meet.google.com/') === null, 'the Meet LANDING page is ordinary browsing (never rerouted)');
ok(web.meetingUrlKind('https://meet.google.com/about') === null, 'a non-code Meet path stays ordinary');
ok(web.meetingUrlKind('https://teams.microsoft.com/l/meetup-join/19%3ameeting_xyz/0') === 'teams', 'a Teams meetup-join → teams');
ok(web.meetingUrlKind('https://teams.live.com/meet/9531778870') === 'teams', 'teams.live.com/meet → teams');
ok(web.meetingUrlKind('https://teams.microsoft.com/l/channel/19%3aabc/General') === null, 'a Teams CHANNEL link is not a meeting');
ok(web.meetingUrlKind('https://www.google.com/search?q=meet.google.com/abc-defg-hij') === null, 'a meeting code in a SEARCH query never reroutes');
ok(web.meetingUrlKind('not a url') === null && web.meetingUrlKind('') === null, 'garbage → null, never a throw');

// ── the reroute short-circuit in open() ─────────────────────────────────────────────────────────
(async () => {
  const calls = [];
  web.setMeetingReroute(async (url, kind) => { calls.push({ url, kind }); return { ok: true }; });
  const r1 = await web.open('https://meet.google.com/abc-defg-hij');
  ok(r1.ok === true && r1.rerouted === 'canvas-meeting', 'open(meet URL) reroutes to the canvas funnel (no browser)');
  ok(calls.length === 1 && calls[0].kind === 'meet' && /abc-defg-hij/.test(calls[0].url), 'the handler received the url and kind');
  ok(/being joined in my dedicated canvas meeting pane/.test(r1.reading),
    'the rerouted result STATES the join truth (the misfire cure — an empty result once read as a failed open)');
  const r2 = await web.open('meet.google.com/zzz-aaaa-bbb');
  ok(r2.rerouted === 'canvas-meeting' && calls.length === 2, 'a bare scheme-less meet link (toUrl-normalized) also reroutes');
  web.setMeetingReroute(async () => ({ ok: true, already: true }));
  const r3 = await web.open('https://teams.live.com/meet/12345');
  ok(r3.ok === true && r3.rerouted === 'canvas-meeting', 'an already-live meeting answers ok without double-starting');
  ok(/ALREADY live in my dedicated canvas meeting pane/.test(r3.reading),
    'the already-live variant says so (no retry, no failure claim to voice)');
  web.setMeetingReroute(null);

  // ── wiring greps ──────────────────────────────────────────────────────────────────────────────
  const fs = require('fs'), path = require('path');
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  ok(/setMeetingReroute\(async \(url, kind\)/.test(mainSrc), 'wiring: main.js registers the reroute at boot');
  ok(/startCanvasMeeting\(url, kind === 'teams'/.test(mainSrc), 'wiring: the reroute calls the ONE canvas funnel');
  ok(/F31 reroute registered/.test(mainSrc), 'wiring: registration logs (observable, never silent)');
  const webSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'web.js'), 'utf8');
  ok(/if \(!url\) return \{ ok: false, reason: 'empty target' \};\s*\n\s*const _mk = meetingUrlKind\(url\);/.test(webSrc), 'wiring: the guard is open()\'s FIRST act after url validation (before the re-spin brake and every browser touch)');
  ok(/t\.tag === 'web-open' && r\.rerouted === 'canvas-meeting'/.test(mainSrc),
    'wiring: the ack-then-async guard — a rerouted open NEVER deep-reads her browser (the misfire attributed an unrelated page to the meet link)');
  ok(/Do NOT open the link again and do NOT say the link failed/.test(mainSrc),
    'wiring: the followup is TOLD the truth to repeat — a false "link didn\'t work" can\'t be voiced mid-join');

  // ── the T-5 auto-join organ (Lucas 2026-08-20: she presses her own join button) ───────────────
  ok(web.meetingUrlFromEvent({ hangoutLink: 'https://meet.google.com/abc-defg-hij' }) === 'https://meet.google.com/abc-defg-hij', 'event extraction: hangoutLink wins');
  ok(web.meetingUrlFromEvent({ conferenceData: { entryPoints: [{ entryPointType: 'phone', uri: 'tel:+1' }, { entryPointType: 'video', uri: 'https://meet.google.com/zzz-aaaa-bbb' }] } }) === 'https://meet.google.com/zzz-aaaa-bbb', 'event extraction: the conferenceData VIDEO entry point');
  ok(web.meetingUrlFromEvent({ description: 'Join here: https://teams.live.com/meet/9531778870, dial-in below' }) === 'https://teams.live.com/meet/9531778870', 'event extraction: a bare URL in the description (trailing punctuation stripped)');
  ok(web.meetingUrlFromEvent({ summary: 'Lunch', location: 'Coffee shop' }) === null && web.meetingUrlFromEvent(null) === null, 'a meeting-less event → null, never a throw');
  ok(/T-5 auto-join → /.test(mainSrc), 'wiring: the auto-join tick logs (observable, never silent)');
  ok(/meet\.autojoined\.' \+ String\(ev\.id \|\| url\)/.test(mainSrc), 'wiring: one attempt per event id (the ledger stamps BEFORE the join — no retry storm)');
  ok(/now < s - 5 \* 60e3 \|\| now > s \+ 10 \* 60e3/.test(mainSrc), 'wiring: the [T-5, T+10] window (a stale entry never joins hours late)');
  ok(/_CAL_STALE_MS\)\) return;\s*\n\s*const now = Date\.now\(\)/.test(mainSrc), 'wiring: the staleness rule guards the tick (a dead refresh never fakes a schedule)');

  console.log(`\nsmoke_meet_reroute: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
