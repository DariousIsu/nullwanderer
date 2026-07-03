/* Smoke: lib/email_intake — the EMAIL half of the Data-Stream Lane. Proves classification (newsletter
 * via List-Unsubscribe/List-Id/Precedence/substack; Gemini meeting-notes; other) and routing (newsletter
 * → news_store row shape; meeting-notes → doc_store.land shape) + the tick orchestration (cursor advance,
 * onRouted, fail-soft, cap). PURE — no IMAP, no engine, no db; deps are injected fakes. Run:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_email_intake.js
 */
'use strict';
const intake = require('../lib/email_intake');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// --- classify: newsletters ---
ok(intake.classify({ fromAddr: 'author@example.com', subject: 'Weekly', headersRaw: 'List-Unsubscribe: <mailto:u@x>\r\n' }) === 'newsletter', 'List-Unsubscribe → newsletter');
ok(intake.classify({ fromAddr: 'x@y.com', subject: 'z', headersRaw: 'List-Id: My List <l.y.com>\r\n' }) === 'newsletter', 'List-Id → newsletter');
ok(intake.classify({ fromAddr: 'x@y.com', subject: 'z', headersRaw: 'Precedence: bulk\r\n' }) === 'newsletter', 'Precedence: bulk → newsletter');
ok(intake.classify({ fromAddr: 'heathercoxrichardson@substack.com', subject: 'Letters', headersRaw: '' }) === 'newsletter', 'substack.com sender → newsletter (even absent list header)');
ok(intake.classify({ fromAddr: 'newsletter@thedispatch.com', subject: 'Today', headersRaw: '' }) === 'newsletter', 'newsletter@ local-part → newsletter');

// --- classify: meeting-notes ---
ok(intake.classify({ fromAddr: 'meetings-noreply@google.com', subject: 'Notes from your meeting', headersRaw: 'List-Unsubscribe: <x>\r\n' }) === 'meeting-notes', 'Gemini sender → meeting-notes (wins over a list header)');
ok(intake.classify({ fromAddr: 'noreply@google.com', subject: 'Your meeting notes are ready', headersRaw: '' }) === 'meeting-notes', 'google.com + "notes" subject → meeting-notes');
ok(intake.classify({ fromAddr: 'x@y.com', subject: 'Gemini notes: standup', headersRaw: '' }) === 'meeting-notes', 'Gemini + notes subject → meeting-notes');
ok(intake.classify({ fromAddr: 'x@y.com', subject: 'Meeting notes attached', headersRaw: '' }) === 'meeting-notes', '"meeting notes" subject → meeting-notes');

// --- classify: other ---
ok(intake.classify({ fromAddr: 'lucas@gmail.com', subject: 'hey did you see this', headersRaw: 'From: Lucas\r\n' }) === 'other', 'plain person-to-person → other');
ok(intake.classify(null) === 'other', 'null → other (fail-soft)');

// --- row shapes ---
const nr = intake.toNewsRow({ from: 'Robert Reich', fromAddr: 'robertreich@substack.com', subject: 'The oligarchy', messageId: '<abc@substack.com>', ts: 123, body: 'x'.repeat(5000) });
ok(nr.source === 'Robert Reich' && nr.sourceKind === 'newsletter' && nr.urlOrGuid === 'abc@substack.com' && nr.title === 'The oligarchy' && nr.ts === 123, 'toNewsRow maps sender/subject/message-id/ts');
ok(nr.summary.length === 2000, 'toNewsRow caps summary at 2000');
const nr2 = intake.toNewsRow({ from: 'X', fromAddr: 'x@y', subject: 'S', messageId: '', uid: 42, ts: 0 });
ok(nr2.urlOrGuid === 'email-uid|42', 'toNewsRow falls back to uid key when no Message-ID');
// toNewsRow strips a LEADING sponsor block from the stored summary (kept newsletter with an opening ad)
const edi = 'The committee released its long-awaited report today, detailing findings that lawmakers say will shape the coming session and the debates that follow it over the months ahead, with several recommendations already drawing sharp responses from members of both parties.';
const nr3 = intake.toNewsRow({ from: 'Author', fromAddr: 'a@substack.com', subject: 'Weekly', messageId: '<w@x>', ts: 1, body: `Together with Acme — 20% off this week.\n\n${edi}` });
ok(nr3.summary === edi, 'toNewsRow strips a leading sponsor block from the summary (keeps the editorial)');

const md = intake.toMeetingDoc({ subject: 'Standup notes', body: 'agenda...', messageId: '<m1@google.com>', uid: 7 });
ok(md.title === 'Standup notes' && md.source === 'email_meeting_notes' && md.ref === 'm1@google.com' && md.body === 'agenda...', 'toMeetingDoc maps subject/body/ref');

// --- runIntakeTick: routing + cursor + onRouted ---
const inserted = []; const landed = []; let savedCursor = null; let routedUids = null;
const fakePoll = async (sinceUid, cap) => ({ ok: true, remaining: 0, messages: [
  { uid: 10, from: 'Sub A', fromAddr: 'a@substack.com', subject: 'A', messageId: '<a>', ts: 1, headersRaw: '', body: 'aa' },
  { uid: 11, from: 'Google', fromAddr: 'meetings-noreply@google.com', subject: 'Notes', messageId: '<b>', ts: 2, headersRaw: '', body: 'bb' },
  { uid: 12, from: 'Lucas', fromAddr: 'lucas@gmail.com', subject: 'hi', messageId: '<c>', ts: 3, headersRaw: '', body: 'cc' },
  { uid: 13, from: 'LinkedIn', fromAddr: 'invitations@linkedin.com', subject: 'Zoe, add Linda C.', messageId: '<d>', ts: 4, headersRaw: 'List-Unsubscribe: <x>\r\n', body: 'People you may know' }, // promo newsletter → dropped
].filter(m => m.uid > sinceUid).slice(0, cap) });
const store = { insertItem: (r) => { inserted.push(r); return { inserted: true }; } };

(async () => {
  const r = await intake.runIntakeTick({
    poll: fakePoll, store, landDoc: (d) => landed.push(d),
    cursor: () => 0, saveCursor: (u) => { savedCursor = u; }, onRouted: (u) => { routedUids = u; }, cap: 12,
  });
  ok(r.ok && r.fetched === 4 && r.newsletters === 1 && r.meetings === 1 && r.other === 1 && r.promos === 1, 'tick tallies 1 newsletter / 1 meeting / 1 other / 1 promo-dropped');
  ok(inserted.length === 1 && inserted[0].urlOrGuid === 'a', 'newsletter routed to store.insertItem; the LinkedIn promo was NOT inserted');
  ok(landed.length === 1 && landed[0].ref === 'b', 'meeting-notes routed to landDoc');
  ok(savedCursor === 13, 'cursor advances to max uid seen (incl. the dropped promo)');
  ok(Array.isArray(routedUids) && routedUids.length === 3 && routedUids.includes(10) && routedUids.includes(11) && routedUids.includes(13) && !routedUids.includes(12), 'onRouted claims newsletter+meeting+promo UIDs (quiet), NOT the "other"');

  // cursor skips already-seen; empty batch advances nothing
  const r2 = await intake.runIntakeTick({ poll: fakePoll, store, landDoc: (d) => landed.push(d), cursor: () => 13, saveCursor: () => {}, cap: 12 });
  ok(r2.ok && r2.fetched === 0 && r2.newsletters === 0, 'cursor at 13 → nothing new fetched (dedup by UID)');

  // fail-soft: poll error never throws
  const r3 = await intake.runIntakeTick({ poll: async () => { throw new Error('imap down'); }, store, cursor: () => 0, saveCursor: () => {} });
  ok(r3.ok === false && /imap down/.test(r3.error), 'poll error is caught, returns ok:false (no throw)');

  // missing deps
  const r4 = await intake.runIntakeTick({});
  ok(r4.ok === false && r4.error === 'missing deps', 'missing deps → ok:false');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
