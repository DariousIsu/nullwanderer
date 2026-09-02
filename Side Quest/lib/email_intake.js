/**
 * lib/email_intake.js — the EMAIL half of the Data-Stream Lane.
 *
 * Zoe's own inbox (zoelanai@gmail.com) is a subscription surface: she signs up for newsletters and
 * receives Gemini "Take notes for me" meeting recaps there. This module is the READ-ONLY ingestion
 * layer over lib/inbox.pollForIntake (which opens the mailbox with EXAMINE — provably no mark-read /
 * delete). It CLASSIFIES each new message and ROUTES it:
 *
 *   • newsletter   → the news reservoir (news_store.insertItem, source_kind='newsletter') — it then
 *                     rides the exact same hourly compression / briefing rail as an RSS Substack item.
 *   • meeting-notes → memory (doc_store.land) — a durable document, promoted nightly like any doc.
 *   • other         → left alone (a real person-to-person mail is the existing inbox poller's job).
 *
 * Everything is PURE + DEPS-INJECTED so the classify/route logic is offline-testable with no IMAP,
 * no engine, no db: scripts/smoke_email_intake.js. Fail-soft: a bad message never throws out of a tick.
 *
 * Design: docs/DATA_STREAM_LANE_DESIGN.md (email surface). Dedup is the UID cursor (read-only friendly),
 * belt-and-suspenders'd by news_store's UNIQUE(source,url_or_guid) via the Message-ID.
 */
'use strict';

const ads = require('./news_ads');   // pure — the newsletter promo/ad filter (shared with the video lane)

const clean = (s) => (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim();

// Does the raw header block carry a bulk/list signal? List-Unsubscribe and List-Id are the RFC-2369/
// RFC-2919 markers every legitimate newsletter sets; Precedence: bulk|list is the older convention.
function hasBulkHeader(headersRaw) {
  const h = String(headersRaw || '');
  return /^list-unsubscribe:/im.test(h)
    || /^list-id:/im.test(h)
    || /^precedence:\s*(bulk|list|junk)/im.test(h);
}

// Gemini / Google "Take notes for me" recaps come from meetings-noreply@google.com; be tolerant of the
// exact subject wording ("Notes from your meeting…", "Your meeting notes are ready", "Gemini notes…").
function isMeetingNotes(msg) {
  const from = clean(msg && msg.fromAddr).toLowerCase();
  const subj = clean(msg && msg.subject).toLowerCase();
  if (from === 'meetings-noreply@google.com') return true;
  // EVERY other branch requires a GOOGLE-AUTHENTICATED sender (audit S5): a meeting-notes message
  // becomes a durable FIRST-PARTY document (read by doc-QA, promoted nightly into Echo long-term),
  // so a subject-only match from any sender let external mail inject trusted content — and Zoe's
  // address is a public subscription surface. Gemini/Workspace recaps all originate at google.com.
  if (!/@google\.com$/.test(from)) return false;
  if (/\bnotes\b/.test(subj)) return true;
  if (/\bmeeting notes\b/.test(subj)) return true;
  if (/\bnotes (?:from|for) (?:your |the )?meeting\b/.test(subj)) return true;
  return false;
}

function looksLikeNewsletter(msg) {
  const from = clean(msg && msg.fromAddr).toLowerCase();
  if (hasBulkHeader(msg && msg.headersRaw)) return true;
  if (/@(?:.*\.)?substack\.com$/.test(from)) return true;
  if (/\b(newsletter|digest|bulletin)\b/.test(from)) return true;
  if (/^(?:newsletter|news|updates?|hello|team|digest)@/.test(from)) return true;
  return false;
}

// PURE: one message → 'meeting-notes' | 'newsletter' | 'other'. Meeting-notes is checked first (more
// specific: a Gemini recap could theoretically carry a list header from Workspace).
function classify(msg) {
  if (!msg) return 'other';
  if (isMeetingNotes(msg)) return 'meeting-notes';
  if (looksLikeNewsletter(msg)) return 'newsletter';
  return 'other';
}

// A stable dedup id for the reservoir: prefer the RFC Message-ID, fall back to a synthetic uid key.
function newsIdOf(msg) {
  const mid = clean(msg && msg.messageId).replace(/^<|>$/g, '');
  return mid || `email-uid|${msg && msg.uid}`;
}

// PURE: newsletter message → a news_store.insertItem() row. Sender display name is the "outlet" so the
// briefing attributes it; source_kind='newsletter' marks provenance (and keeps it clear of the video
// ad-filter, which only touches source_kind='video').
function toNewsRow(msg) {
  // OUTLET = the sending DOMAIN, never the free-text From DISPLAY name (audit S14): the display
  // name is attacker-controlled, so a forged "Reuters" could ride the corroboration rail. The
  // domain is what the sender actually controls, and it dedups honestly across a newsletter's runs.
  const fromAddr = clean(msg.fromAddr).toLowerCase();
  const domain = (fromAddr.split('@')[1] || '').trim();
  return {
    source: domain || fromAddr || 'newsletter',
    sourceKind: 'newsletter',
    sourceUrl: clean(msg.fromAddr) || null,
    title: clean(msg.subject) || '(newsletter)',
    urlOrGuid: newsIdOf(msg),
    ts: Number(msg.ts) || 0,          // 0 → news_store stamps collection time
    // strip a LEADING sponsor block (a kept newsletter may open with "Together with …") before storing —
    // conservative + safety-gated, so a false strip can't eat editorial (news_ads.stripLeadingSponsor).
    summary: msg.body != null ? ads.stripLeadingSponsor(String(msg.body)).slice(0, 2000) : null,
  };
}

// PURE: meeting-notes message → a doc_store.land() row.
function toMeetingDoc(msg) {
  return {
    title: clean(msg.subject) || 'Meeting notes',
    body: msg.body != null ? String(msg.body).slice(0, 20000) : '',
    source: 'email_meeting_notes',
    ref: newsIdOf(msg),
  };
}

// Run ONE intake tick. Injected deps keep it offline-testable:
//   poll(sinceUid, cap)  → { ok, messages:[{uid,from,fromAddr,subject,messageId,ts,headersRaw,body}], remaining }
//   store                → news_store (insertItem)
//   landDoc(doc)         → doc_store.land
//   cursor()             → last processed UID (number)
//   saveCursor(uid)      → persist new cursor
//   onRouted(uids)       → optional: notify glue which UIDs were lane-claimed (so the chat-surfacing
//                           inbox poller can skip them — keeps newsletters QUIET, not chat nudges)
// Returns { ok, fetched, newsletters, meetings, other, cursor, remaining, error? }. Never throws.
async function runIntakeTick({ poll, store, landDoc, cursor, saveCursor, onRouted, cap = 12, log } = {}) {
  if (typeof poll !== 'function' || !store) return { ok: false, error: 'missing deps', fetched: 0, newsletters: 0, meetings: 0, other: 0 };
  const sinceUid = (typeof cursor === 'function' ? Number(cursor()) : Number(cursor)) || 0;
  let res;
  try { res = await poll(sinceUid, cap); }
  catch (e) { log && log('[email-intake] poll failed: ' + e.message); return { ok: false, error: e.message, fetched: 0, newsletters: 0, meetings: 0, other: 0 }; }
  if (!res || !res.ok) return { ok: false, error: (res && res.reason) || 'poll not ok', fetched: 0, newsletters: 0, meetings: 0, other: 0 };
  const msgs = Array.isArray(res.messages) ? res.messages : [];
  let newsletters = 0, meetings = 0, other = 0, promos = 0, maxUid = sinceUid;
  const routed = [];   // UIDs this lane CLAIMED (inserted, landed, OR dropped-as-promo) → suppressed from chat surfacing
  for (const m of msgs) {
    try {
      const kind = classify(m);
      if (kind === 'newsletter') {
        // Tier-1 promo hard-drop (free heuristic): a pure-promo email (LinkedIn/Yelp/deals/stock-pump)
        // never enters the bucket. A newsletter that merely CONTAINS an ad is NOT dropped here (→ 'unsure'
        // /'keep'); the soft cases ride the tier-2 model pass at hourly compression. Still claimed (quiet).
        if (ads.emailPromoHeuristic(m) === 'promo') { promos++; routed.push(m.uid); }
        else { store.insertItem(toNewsRow(m)); newsletters++; routed.push(m.uid); }
      } else if (kind === 'meeting-notes') {
        if (typeof landDoc === 'function') landDoc(toMeetingDoc(m));
        meetings++; routed.push(m.uid);
      } else {
        other++;   // leave for the existing person-to-person inbox poller
      }
    } catch (e) { log && log('[email-intake] route failed uid=' + (m && m.uid) + ': ' + e.message); }
    if (m && Number(m.uid) > maxUid) maxUid = Number(m.uid);
  }
  if (maxUid > sinceUid && typeof saveCursor === 'function') { try { saveCursor(maxUid); } catch {} }
  if (routed.length && typeof onRouted === 'function') { try { onRouted(routed); } catch {} }
  if (log && msgs.length) log(`[email-intake] ${msgs.length} new: ${newsletters} newsletter, ${promos} promo-dropped, ${meetings} meeting-notes, ${other} other → cursor ${maxUid}${res.remaining ? ` (+${res.remaining} queued)` : ''}`);
  return { ok: true, fetched: msgs.length, newsletters, promos, meetings, other, cursor: maxUid, remaining: res.remaining || 0 };
}

module.exports = { classify, hasBulkHeader, isMeetingNotes, looksLikeNewsletter, toNewsRow, toMeetingDoc, newsIdOf, runIntakeTick };
