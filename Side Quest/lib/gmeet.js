/**
 * Google Meet — Step 1: join a meeting (muted), post a MANDATORY self-introduction in
 * the meeting chat, then observe live captions as her real-time perception. Steps 2–3
 * (grounded contribution from Echo's KB, loopback transcript) ride the Echo integration.
 *
 * Built like byline.js / play_session.js: the app holds a stage machine and advances ONE
 * stage per idle tick; the model is asked only for the intro wording. The join itself is
 * a declarative recipe (recipes/gmeet_join.json) replayed by flow_runner — so Meet's
 * fragile DOM lives in data, not code, and heals/asks-for-help like any recipe.
 *
 *   joining   → replay the join recipe (mute mic+cam, Join now). A sign-in wall pauses
 *               and asks Lucas to log her Google account in (the blocker handoff).
 *   intro     → read who's here, GENERATE a warm intro in her voice, post it to chat.
 *   observing → scrape new caption lines into her perception (readings); loops.
 *   done      → leave / cleanup.
 *
 * MANDATORY INTRO (Lucas's rule): the intro must disclose she's an AI present on Lucas's
 * behalf, stay brief, and state its purpose — but she's free to be warm and greet people
 * she recognizes by name. The disclosure is enforced deterministically (validateIntro +
 * ensureDisclosure) so a friendly-but-forgetful generation can never drop it.
 *
 * Pure helpers + stage transitions are unit-tested offline (scripts/smoke_gmeet.js);
 * the live DOM bits (join selectors, caption/attendee scrape) verify on a real meeting.
 */

const db = require('./db');

const STAGES = ['none', 'joining', 'intro', 'observing', 'done'];
const MAX_STAGE_STRIKES = 3;
const FOLLOW_EVERY_LINES = 4;   // synthesize a running understanding after this many new caption lines
const FOLLOW_MAX_WAIT_MS = 25000;   // ...or after this long with ANY pending lines, so sparse meetings still get understood (don't sit forever short of the line count)
const LEAVE_SILENCE_MS = 300000;   // after a clear sign-off AND she's effectively alone, if captions stay quiet THIS long she hangs up (5 min; 90s was far too eager — a quiet stretch mid-meeting ≠ over)
const ALONE_LEAVE_MS = 240000;     // effectively ALONE (attendee panel ≤1) for THIS long → leave, no verbal sign-off needed. The real-world "everyone dropped off" signal the sign-off gate kept missing (Lucas: "she still doesn't know when to leave").
const MAX_MEETING_MS = 3 * 3600000; // hard backstop: never sit in a call past 3h whatever the captions do — the "stuck in observing forever" state now has a ceiling.
const CAPTION_DROUGHT_MS = 180000;  // A1 fall-through floor: in a meeting with others present but ZERO captions EVER for this long → CC is off/broken; say so ONCE (she can't follow live) and keep attending. Well under the alone/sign-off leave triggers, and past join+intro+caption-start latency.
const MEETING_RESEARCH_GAP_MS = 30000;   // M2: governed cadence for in-meeting background research (steady, not spammy)

// ── WHO SHE TALKS TO IN A MEETING ───────────────────────────────────────────────────────────────
//
// Lucas, 2026-07-21: "get her firing correctly to me, either through the canvas or chat. I want to
// make sure she is pulling the right things and making the right actions BEFORE she starts trying
// to send stuff in chat."
//
// The audit that prompted this found the wiring pointing the wrong way. Two paths could post into a
// room of his colleagues — a model-chosen CONTRIBUTE and an auto-reply when someone says her name —
// and the only thing restraining either was a sentence in a prompt ("staying QUIET is strongly
// preferred") evaluated by the local 12b at num_ctx 8192. Meanwhile everything she *learned* went to
// `onReading`, i.e. the ambient sheep panel: the same low-attention rail that swallowed a real answer
// on 2026-07-20. Outward actions were ungated; inward reporting was invisible.
//
// So: the room's chat is CLOSED by default. A would-be contribution or reply is not discarded — it
// is drafted and delivered to Lucas through the surface he actually watches, tagged with what
// triggered it, so he can judge whether she picked the right moment and said the right thing. When
// the drafts read correctly, `ZOE_MEET_CHAT=on` opens the door.
//
// The INTRO is deliberately exempt and stays on. It is disclosure, not contribution — an
// undisclosed AI silently transcribing a room is the one thing worse than a clumsy message, and it
// is what sets the expectation that she is there taking notes. `ZOE_MEET_INTRO=0` disables it.
function meetChatOpen() { return String(process.env.ZOE_MEET_CHAT || 'off').toLowerCase() === 'on'; }
function meetIntroOn() { return process.env.ZOE_MEET_INTRO !== '0'; }

// THE LEDGER — every decision she takes in a meeting, in one place, so "is she pulling the right
// things and making the right actions" is a question with an answer instead of an impression.
// Bounded and stored per-meeting; rendered into the notes at finalize.
function ledgerAdd(entry) {
  try {
    const raw = db.getMeta('gmeet_ledger') || '[]';
    const rows = JSON.parse(raw);
    rows.push({ at: Date.now(), ...entry });
    db.setMeta('gmeet_ledger', JSON.stringify(rows.slice(-60)));
  } catch { /* the ledger is an observability aid — it must never break the meeting */ }
}
function ledgerRows() { try { return JSON.parse(db.getMeta('gmeet_ledger') || '[]'); } catch { return []; } }

/**
 * Render the ledger as markdown for the meeting notes on canvas.
 *
 * This is the answer to "did she pull the right things and take the right actions". WITHHELD entries
 * lead: an action she wanted to take in the room is the one that most needs reviewing, and burying it
 * under the research log is how it would go unread.
 */
function renderLedger(rows = []) {
  if (!rows || !rows.length) return '';
  const t = (r) => { try { return new Date(r.at).toISOString().slice(11, 16); } catch { return '--:--'; } };
  const held = rows.filter((r) => r.withheld);
  const out = [];
  if (held.length) {
    out.push(`### Held back from the meeting chat (${held.length})`);
    out.push('She judged these worth saying and did not send them. Read them as her proposed actions:');
    for (const r of held) {
      if (r.kind === 'reply') out.push(`- **${t(r)} — asked by ${String(r.trigger || '').split(':')[0]}**: _"${r.trigger}"_\n  - would have replied: "${r.draft}"`);
      else if (r.kind === 'intro') out.push(`- **${t(r)} — no introduction**: ${r.why}`);
      else out.push(`- **${t(r)} — would have said**: "${r.draft}"${r.understanding ? `\n  - context she read: ${r.understanding}` : ''}`);
    }
  }
  const did = rows.filter((r) => !r.withheld);
  if (did.length) {
    out.push(`### What she did (${did.length})`);
    for (const r of did) {
      if (r.kind === 'research') out.push(`- ${t(r)} — looked up **${r.topic}**${r.ran ? '' : ' _(skipped: rate-limited or already known)_'}`);
      else if (r.kind === 'connect') out.push(`- ${t(r)} — connected: ${r.note}`);
      else if (r.kind === 'contribute') out.push(`- ${t(r)} — posted to the meeting chat: "${r.draft}"${r.posted ? '' : ' _(post failed)_'}`);
      else if (r.kind === 'reply') out.push(`- ${t(r)} — replied to ${String(r.trigger || '').split(':')[0]} in chat: "${r.draft}"`);
    }
  }
  return out.join('\n');
}

// Captions she's already surfaced this meeting (exact speaker|text), so scrolling/repeat
// caption rows aren't re-reported each ~10s observe tick. Reset on start(). In-memory:
// captions are ephemeral, no need to persist.
let _seenCaps = new Set();
// addressed-to-her lines she's already answered (so a mutating/repeated caption doesn't
// trigger duplicate chat replies). Reset on start().
let _answered = new Set();

// --- pure helpers (unit-tested) ---

// A Google Meet URL anywhere in text. Meet codes are xxx-xxxx-xxx (lowercase letters).
// The scheme is OPTIONAL: Lucas often pastes a bare "meet.google.com/abc-defg-hij" (no
// https://) — that MUST still match, or the join stepper never starts and the model falls
// back to a raw <browse> that fails (the "can't join from the link" bug).
const MEET_URL_RE = /(?:https?:\/\/)?meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}(?:\?[^\s"'<>]*)?/i;
// Looser form (lookup codes / _meet links) as a fallback.
const MEET_URL_LOOSE_RE = /(?:https?:\/\/)?meet\.google\.com\/[a-z0-9_-]+(?:\?[^\s"'<>]*)?/i;

function detectMeetUrl(text) {
  const t = String(text || '');
  const m = t.match(MEET_URL_RE) || t.match(MEET_URL_LOOSE_RE);
  if (!m) return null;
  // Always return an ABSOLUTE url — the join recipe / page.goto need a scheme.
  let u = m[0];
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u.replace(/^\/\//, '');
  return u;
}

// Pull a Meet link out of a calendar event (hangoutLink / conferenceData / location /
// description / raw text). Returns the URL or null.
function meetLinkFromEvent(ev) {
  if (!ev) return null;
  if (ev.hangoutLink) { const u = detectMeetUrl(ev.hangoutLink); if (u) return u; }
  try {
    for (const ep of (ev.conferenceData && ev.conferenceData.entryPoints) || []) {
      const u = detectMeetUrl(ep.uri || ep.label || ''); if (u) return u;
    }
  } catch {}
  for (const f of [ev.location, ev.description, ev.summary, ev.text]) {
    const u = detectMeetUrl(f); if (u) return u;
  }
  return null;
}

// Disclosure detector — does the intro make clear she's an AI / assistant / bot?
const DISCLOSURE_RE = /\b(a\.?\s?i\b|artificial intelligence|\bassistant\b|\bbot\b|\bagent\b|note[- ]?taker|not a (?:real )?person|virtual)\b/i;
// Name detector — she must say who she is.
const NAME_RE = /\bzoe\b/i;

// The prompt for her self-introduction. attendees (names from the people panel, may be
// empty) lets her greet people she recognizes; the three MANDATORY constraints are spelled
// out, and warmth is explicitly invited within them.
function introPrompt({ userName, attendees } = {}) {
  const u = userName || 'Lucas';
  const who = (attendees && attendees.length)
    ? `People already here: ${attendees.slice(0, 8).join(', ')}. Feel free to greet anyone you recognize warmly, by name.`
    : `You don't have the attendee list yet — open with a general, friendly hello.`;
  return `You're joining a Google Meet on ${u}'s behalf. Write a SHORT message to post in the MEETING CHAT, introducing yourself. It MUST: (1) state your name — you are Zoe; (2) make clear you are an AI, here on ${u}'s behalf; (3) say briefly why you're here — to follow along and take notes / help; (4) be 1–2 sentences. Within that, be warm and human — a friendly hello is welcome. ${who}\n\nOutput ONLY the message text — no quotes, no tags, no "Subject:".`;
}

// Validate a generated intro against the MANDATORY constraints. Returns { ok, reasons }.
function validateIntro(text) {
  const t = String(text || '').trim();
  const reasons = [];
  if (t.length < 8) reasons.push('empty/too short');
  if (!NAME_RE.test(t)) reasons.push('no name (Zoe)');
  if (!DISCLOSURE_RE.test(t)) reasons.push('no AI disclosure');
  if (t.length > 400) reasons.push('too long');
  return { ok: reasons.length === 0, reasons };
}

// Guarantee the non-negotiable parts — her NAME and the AI disclosure — even if a
// friendly generation dropped either: prepend a clause covering both, keeping her
// wording after it. (She still gets to be warm; this only backstops the mandatory bits.)
function ensureIntro(text, userName) {
  const t = String(text || '').trim();
  if (NAME_RE.test(t) && DISCLOSURE_RE.test(t)) return t.slice(0, 400);
  const u = userName || 'Lucas';
  const clause = `Hi all — I'm Zoe, ${u}'s AI assistant, here to follow along and take notes.`;
  return (t ? `${clause} ${t}` : clause).slice(0, 400);
}

// Sign-off detector — does this caption/understanding line sound like the meeting is wrapping
// up? Used (together with a stretch of caption silence) to decide she should hang up on her
// own. Deliberately broad on closers but anchored to whole words so mid-meeting chatter
// ("goodbye for now to that idea") rarely trips it; the silence requirement is the real gate.
const SIGNOFF_RE = /\b(bye|goodbye|see (?:you|ya|everyone|y'?all)|talk (?:to you )?(?:later|soon)|catch (?:you|ya) (?:later|soon)|take care|have a (?:good|great|nice)|thanks?(?: |,)?(?:everyone|all|guys|y'?all|so much)|thank you(?: all| everyone| so much)?|that'?s (?:all|it) (?:for|from)|we'?re (?:all )?done|wrap(?:ping)? (?:this|it|things)? ?up|signing off|see you (?:on )?(?:monday|tuesday|wednesday|thursday|friday|next))\b/i;
function looksLikeSignOff(text) {
  return SIGNOFF_RE.test(String(text || ''));
}

// Parse a normalized caption scrape ("Speaker: text" lines, one per caption) into
// [{ speaker, text }]. scrapeCaptions() produces this normalized form from the live DOM,
// so this parser is the stable contract we test against.
function parseCaptions(scrapeText) {
  const out = [];
  for (const raw of String(scrapeText || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^([^:]{1,40}):\s*(.+)$/);
    if (m) out.push({ speaker: m[1].trim(), text: m[2].trim() });
    else if (out.length) out[out.length - 1].text += ' ' + line;   // continuation of the last caption
  }
  return out;
}

// Group a sequence of caption/transcript lines into SPEAKER TURNS (consecutive lines from the
// same speaker = one turn) so the meeting can be processed turn-by-turn. Each turn carries its
// time span. Pure; tested. rows: [{speaker,text,ts}] → [{speaker,text,startTs,endTs,lines}].
function segmentTurns(rows) {
  const out = [];
  for (const r of (rows || [])) {
    const speaker = String(r.speaker || '').trim();
    const text = String(r.text || '').trim();
    if (!text) continue;
    const last = out[out.length - 1];
    if (last && last.speaker === speaker) {
      last.text += ' ' + text;
      if (r.ts != null) last.endTs = r.ts;
      last.lines++;
    } else {
      out.push({ speaker, text, startTs: r.ts != null ? r.ts : null, endTs: r.ts != null ? r.ts : null, lines: 1 });
    }
  }
  return out;
}

// Parse a normalized people-panel scrape (one name per line) into a deduped name list,
// dropping obvious non-people chrome.
const NON_PERSON = /^(you|presentation|in this meeting|contributors|search|add people|people|chat|on|off|host)$/i;
function parseAttendees(scrapeText) {
  const seen = new Set(), out = [];
  for (const raw of String(scrapeText || '').split('\n')) {
    let name = raw.trim().replace(/\s*\(.*\)\s*$/, '');     // drop "(You)" / "(Host)"
    if (!name || name.length > 60 || NON_PERSON.test(name)) continue;
    const k = name.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k); out.push(name);
  }
  return out;
}

// --- addressee detection (active participation) ---
// The names she answers to. "Zoe" + her chosen_name; deduped, lowercased.
function selfNames() {
  const names = ['zoe', 'zoe lane'];
  const chosen = (db.getMeta('chosen_name') || '').toLowerCase().trim();
  if (chosen && !names.includes(chosen)) names.push(chosen);
  return names;
}
function _nameAlt(names) {
  return (names || ['zoe']).map(n => String(n).trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).filter(Boolean).join('|');
}
// Is this caption SPOKEN BY her (so she doesn't answer her own echoed lines)?
function isSelfSpeaker(speaker, names = ['zoe']) {
  const s = String(speaker || '').toLowerCase();
  return (names || ['zoe']).some(n => n && s.includes(String(n).toLowerCase()));
}
/**
 * Is this caption ADDRESSED to her (a request/question directed at Zoe), vs merely a
 * third-person MENTION ("Zoe is taking notes")? Deterministic, tuned to fire on a direct
 * address and stay quiet on a passing reference. Used to decide when she should respond
 * in the meeting. names defaults to ['zoe'].
 */
function addressesSelf(text, names = ['zoe']) {
  const t = String(text || '').trim();
  const alt = _nameAlt(names);
  if (!t || !alt) return false;
  const lower = t.toLowerCase();
  if (!new RegExp(`\\b(?:${alt})\\b`).test(lower)) return false;           // must name her at all
  if (new RegExp(`\\b(?:${alt})\\s*[,:]`).test(lower)) return true;        // vocative: "Zoe, ..." / "Zoe:"
  if (new RegExp(`[,]\\s*(?:${alt})\\b[\\s!?.]*$`).test(lower)) return true; // trailing vocative: "..., Zoe?"
  if (new RegExp(`\\b(?:${alt})\\b[\\s,]*(?:can|could|would|will)\\s+you\\b`).test(lower)) return true; // "Zoe can you..."
  if (new RegExp(`\\b(?:${alt})\\b[\\s,]*(?:what|how|why|when|where|which|who|please|help|pull up|look up|find|share|send|tell us|give us)\\b`).test(lower)) return true; // "Zoe what's..."
  if (new RegExp(`\\b(?:ask|tell|have|get)\\s+(?:${alt})\\b`).test(lower)) return true; // "ask Zoe to..."
  if (/\?\s*$/.test(t) && new RegExp(`\\b(?:${alt})\\b`).test(lower)) return true;        // a question naming her
  return false;
}

// --- meta-backed stage state ---
function get() { return db.getMeta('gmeet_stage') || 'none'; }
function set(s) { if (STAGES.includes(s)) db.setMeta('gmeet_stage', s); }
function active() { const s = get(); return s !== 'none' && s !== 'done'; }
function url() { return db.getMeta('gmeet_url') || ''; }

function start(meetUrl) {
  const u = detectMeetUrl(meetUrl) || (String(meetUrl || '').trim());
  if (!u) return false;
  db.setMeta('gmeet_url', u);
  db.setMeta('gmeet_strikes', '0');
  db.setMeta('gmeet_left_ticks', '0');
  db.setMeta('gmeet_pending', ''); db.setMeta('gmeet_pending_lines', '0'); db.setMeta('gmeet_pending_since', ''); db.setMeta('gmeet_understanding', '');
  db.setMeta('gmeet_signoff_seen', ''); db.setMeta('gmeet_last_caption_at', '');
  db.setMeta('gmeet_alone_since', ''); db.setMeta('gmeet_leave_requested', '');   // fresh leave-timers per meeting
  db.setMeta('gmeet_understanding_log', ''); db.setMeta('gmeet_last_recap', '');
  db.setMeta('gmeet_present', '[]'); db.setMeta('gmeet_directives', '[]');
  db.setMeta('gmeet_started_at', String(Date.now()));   // M1: transcript scope anchor
  db.setMeta('gmeet_cap_ever', ''); db.setMeta('gmeet_dry_notified', '');   // A1: caption-drought detector state (per meeting)
  db.setMeta('gmeet_ended_at', '0');   // post-meeting recall freshness stamp (set when the call ends)
  db.setMeta('gmeet_last_research_at', '0'); db.setMeta('gmeet_researched', '[]');   // M2: research governance
  db.setMeta('gmeet_ledger', '[]');   // the action ledger is PER MEETING — last week's drafts are not this call's
  db.setMeta('gmeet_present', '[]'); db.setMeta('gmeet_context', '');   // ...and so is the room: yesterday's attendees must never resolve today's names
  _seenCaps = new Set();
  _answered = new Set();
  set('joining');
  return true;
}
function reset() { set('none'); db.setMeta('gmeet_strikes', '0'); }

function _strike() {
  const n = parseInt(db.getMeta('gmeet_strikes') || '0', 10) + 1;
  db.setMeta('gmeet_strikes', String(n));
  if (n >= MAX_STAGE_STRIKES) { reset(); return true; }
  return false;
}
function _clear() { db.setMeta('gmeet_strikes', '0'); }

function defaultDeps() {
  return {
    web: require('./web'),
    streamChat: require('./ollama').streamChat,
    MODEL: require('./config').extractionModel(),
    scrapeAttendees: liveScrapeAttendees,
    scrapeCaptions: liveScrapeCaptions,
    enableCaptions: liveEnableCaptions,
    inMeeting: liveInMeeting,
    leaveMeeting: liveLeaveMeeting,
    // storeMeeting(recap) → persist the end-of-meeting recap as durable, retrievable knowledge
    // (so "what did we discuss with Joshua?" recalls it later instead of it ageing out).
    storeMeeting: async (content, opts = {}) => { try { return await require('./memory').store({ kind: opts.kind || 'meeting', content, source: opts.source || 'gmeet', importance: opts.importance == null ? 0.75 : opts.importance }); } catch { return null; } },
    preClear: livePreClear,
    postChat: livePostChat,
    // retrieve(query) → grounding rows from her OWN knowledge store (leaf-preference) for
    // answering a question addressed to her in-meeting.
    retrieve: async (q) => { try { return await require('./memory').retrieve(q, { k: 3, preferLeaf: true }); } catch { return []; } },
    // webLookup(query) → a quick web search when her own knowledge is thin, so "pull up
    // information" actually FETCHES instead of just promising to follow up (Step-3 seam).
    // Echo-grounded retrieval can layer onto this same hook later.
    webLookup: async (q) => {
      try { const { results } = await require('./web_search').search(q); return (results || []).slice(0, 4).map(r => `- ${r.title}${r.snippet ? ': ' + r.snippet : ''}`).join('\n'); }
      catch { return ''; }
    }
  };
}

// --- live DOM bits ---
// Selectors are grounded in maintained OSS Meet scrapers (Recall.ai's Playwright bot +
// extension, yunho0130/google-meet-cc-to-srt, S Anand's recorder). The DURABLE anchors are
// accessibility attributes (aria-live / role=region[aria-label*=Captions] / the button
// aria-label) — Google obfuscates+rotates the class names every few months, so classes are
// only fallbacks and we extract text by REMOVING the speaker badge (Recall's class-free trick).

async function liveScrapeAttendees(web) {
  try { const r = await web.read(); return (r && r.ok && r.text) ? r.text : ''; } catch { return ''; }
}

// Enable captions: Shift+C is what the battle-tested bots send (more reliable than a click,
// works regardless of the control bar auto-hiding or the CC button being in the overflow
// menu). Click the "Turn on captions" button only as a fallback. Confirm via the captions
// region or the "Turn off captions" state.
async function liveEnableCaptions(web) {
  try {
    const page = await web.ensure();
    const onSel = '[role="region"][aria-label*="Captions" i], button[aria-label*="Turn off captions" i]';
    const isOn = async () => (await page.locator(onSel).count().catch(() => 0)) > 0;
    try { await page.mouse.move(500, 700); } catch {}   // control bar renders on pointer activity
    if (await isOn()) return { ok: true, already: true };
    for (let i = 0; i < 5; i++) {
      try { await page.keyboard.down('Shift'); await page.keyboard.press('c'); await page.keyboard.up('Shift'); } catch {}
      await page.waitForTimeout(500).catch(() => {});
      if (await isOn()) return { ok: true, via: 'shortcut' };
    }
    try {
      const btn = page.locator('button[aria-label*="Turn on captions" i]').first();
      if (await btn.count().catch(() => 0)) await btn.click({ timeout: 4000 });
    } catch {}
    const on = await isOn();
    if (!on) console.log('[gmeet] enable-captions unconfirmed (Shift+C + button both unverified)');
    return { ok: on, via: on ? 'button' : 'unconfirmed' };
  } catch (e) { return { ok: false, reason: e.message }; }
}

async function liveScrapeCaptions(web) {
  // Read the REAL caption region (NOT the whole page). Anchor on aria, fall back through
  // historical row/speaker classes; get text by cloning a row and removing the speaker
  // badge + avatars (durable against text-class churn). Heal signal if no region found.
  try {
    const page = await web.ensure();
    const res = await page.evaluate(() => {
      const region =
        document.querySelector('[role="region"][aria-label*="Captions" i]') ||
        Array.from(document.querySelectorAll('[aria-live]')).find(e => (e.textContent || '').trim().length > 0) ||
        (document.querySelector('.nMcdL') && document.querySelector('.nMcdL').parentElement) ||
        document.querySelector("div[jscontroller='TEjq6e']");
      if (!region) {
        const cands = Array.from(document.querySelectorAll('[aria-live],[aria-label*="aption" i],[role="region"]')).slice(0, 6)
          .map(e => `${e.tagName} role="${e.getAttribute('role') || ''}" aria-label="${e.getAttribute('aria-label') || ''}" live="${e.getAttribute('aria-live') || ''}"`);
        return { text: '', diag: cands.length ? cands.join(' | ') : 'no caption region / aria-live on page' };
      }
      const BADGE = '.NWpY1d, .xoMHSc, .zs7s8d';   // speaker-name badge (current + legacy)
      let rows = Array.from(region.querySelectorAll('.nMcdL'));            // current per-caption row
      if (!rows.length) rows = Array.from(region.children);                // structural fallback
      if (!rows.length) rows = [region];
      const lines = [];
      for (const row of rows) {
        const badge = row.querySelector ? row.querySelector(BADGE) : null;
        const speaker = badge ? (badge.textContent || '').replace(/\s+/g, ' ').trim() : '';
        let text = '';
        try {
          const clone = row.cloneNode(true);
          clone.querySelectorAll(BADGE).forEach(e => e.remove());          // strip speaker badge
          clone.querySelectorAll('img, [data-iml]').forEach(e => e.remove()); // strip avatars
          text = (clone.textContent || '').replace(/\s+/g, ' ').trim();
        } catch {}
        if (!text || text.length > 280) continue;
        lines.push(speaker ? `${speaker}: ${text}` : text);
      }
      return { text: lines.join('\n'), diag: '' };
    });
    if (res && res.diag) console.log('[gmeet] caption heal: ' + res.diag);
    return (res && res.text) || '';
  } catch { return ''; }
}
// Is she actually still in the meeting? (Leave detection — without this, observing never
// exits and monopolizes the idle loop forever, which is what froze her cognition.)
// True only if the browser is on a Meet meeting URL AND the in-call UI ("Leave call") is present.
async function liveInMeeting(web) {
  try {
    const page = await web.ensure();
    const url = (() => { try { return page.url() || ''; } catch { return ''; } })();
    if (!/meet\.google\.com\/[a-z0-9]/i.test(url)) return false;   // navigated away / not a meeting
    const inCall = await page.locator('button[aria-label*="Leave call" i], [aria-label*="Leave call" i], [aria-label*="Leave the call" i]').count().catch(() => 0);
    return inCall > 0;
  } catch { return false; }
}

// LEAVE THE CALL — the correct, deterministic way to leave: click "Leave call" in HER OWN
// browser (the meeting lives in lib/web.js, never the shared co-pilot Chrome). Fallback:
// navigate her Meet tab to about:blank — NOT context.close() (too blunt) and NEVER a
// browse-close against Lucas's shared browser (the bug that killed his active tab). Idempotent.
async function liveLeaveMeeting(web) {
  try {
    const page = await web.ensure();
    try { await page.mouse.move(500, 700); } catch {}   // surface the auto-hiding control bar
    const btn = page.locator('button[aria-label*="Leave call" i], [role="button"][aria-label*="Leave call" i], [aria-label*="Leave the call" i]').first();
    if (await btn.count().catch(() => 0)) {
      await btn.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(800).catch(() => {});
    }
    // Confirm we're out (Leave-call control gone). If still in-call, navigate HER tab away.
    const still = await page.locator('button[aria-label*="Leave call" i], [aria-label*="Leave call" i]').count().catch(() => 0);
    if (still > 0) { try { await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 5000 }); } catch {} }
    return { ok: true, via: still > 0 ? 'navigate-away' : 'leave-button' };
  } catch (e) { return { ok: false, reason: e.message }; }
}

// Clear the "Do you want people to hear you in the meeting?" device-permission modal that
// covers the pre-join controls (Join now + mic/cam toggles) and hangs the join. Escape
// usually closes it; the X is a fallback. Closing it leaves her muted — what we want.
// (Recall's bot does the same Escape pre-clear of blocking overlays.)
async function livePreClear(web) {
  try {
    const page = await web.ensure();
    try { await page.mouse.move(500, 700); } catch {}
    for (let i = 0; i < 2; i++) { try { await page.keyboard.press('Escape'); } catch {} try { await page.waitForTimeout(250); } catch {} }
    try {
      const x = page.locator('[role="dialog"] button[aria-label*="Close" i], button[aria-label="Close"]').first();
      if (await x.count().catch(() => 0)) await x.click({ timeout: 1500 }).catch(() => {});
    } catch {}
  } catch {}
}

async function livePostChat(web, message) {
  // Posting to the Meet chat is a recipe (find chat input → type → Enter); replayed live.
  try { return await web.runRecipe('gmeet_post_chat', { message }, {}); } catch (e) { return { ok: false, reason: e.message }; }
}

// Generate the intro: model writes it warm, validator + ensureDisclosure guarantee the
// mandatory disclosure. Returns the final post-ready string.
async function generateIntro(d, ctx, attendees) {
  let out = '';
  try {
    await d.streamChat({
      model: d.MODEL,
      messages: [{ role: 'user', content: introPrompt({ userName: ctx.userName, attendees }) }],
      options: { temperature: 0.7, top_p: 0.95, num_ctx: 8192, num_predict: 120 },
      onToken: (t) => { out += t; }
    });
  } catch (e) { /* fall through to the deterministic fallback */ }
  const cleaned = String(out || '').replace(/<[^>]+>/g, '').replace(/^["']|["']$/g, '').trim();
  return ensureIntro(cleaned, ctx.userName);   // name + disclosure guaranteed regardless of model output
}

// FOLLOW ALONG: turn the recent captions into a 1–2 sentence running understanding, so she
// actually registers the live conversation (what's being discussed + anything to remember)
// instead of just logging lines. ONE model tick, throttled by caller. Returns '' on failure.
// Parse the per-turn model output into { understanding, action }. The model ends with ONE
// line: ACTION: QUIET | RESEARCH: <topic> | CONTRIBUTE: <msg> | CONNECT: <link>. Defaults to
// quiet (the preferred state) on anything unparseable or an empty payload. Pure; tested.
/**
 * The room's context, built once per meeting and cached in meta.
 *
 * Assembled by lib/references (the same module that resolves names in chat) rather than a second
 * meeting-only identity path — one resolver, one set of rules. Fail-soft: no calendar, no
 * transcripts, no vocabulary and it still returns the live attendee panel, which is the highest
 * authority anyway because she can see those people.
 */
async function meetingContextBlock(d, ctx) {
  const cached = db.getMeta('gmeet_context');
  if (cached) return cached;
  try {
    const code = db.getMeta('gmeet_code') || (db.getMeta('gmeet_url') || '').split('/').pop() || null;
    let present = [];
    try { present = JSON.parse(db.getMeta('gmeet_present') || '[]'); } catch {}
    // Re-read the live panel when we can — people join late, and who is actually here outranks who
    // was here at intro.
    try { const live = parseAttendees(await d.scrapeAttendees(d.web)); if (live && live.length) present = live; } catch {}
    const block = await require('./references').meetingContext({
      code, present, deps: { gcalOpts: (ctx && ctx.gcalOpts) || null }, now: d.now ? d.now() : Date.now(),
    });
    if (block) db.setMeta('gmeet_context', block);
    return block || '';
  } catch (e) { console.error('[gmeet] meeting context failed:', e.message); return ''; }
}

function parseMeetingAction(raw) {
  const text = String(raw || '').replace(/<[^>]+>/g, '').trim();
  const m = text.match(/ACTION:\s*(QUIET|RESEARCH|CONTRIBUTE|CONNECT)\b\s*:?\s*([\s\S]*)$/i);
  if (!m) return { understanding: text.slice(0, 500), action: { kind: 'quiet', payload: '' } };
  const understanding = text.slice(0, m.index).trim().slice(0, 500);
  const kind = m[1].toLowerCase();
  const payload = (m[2] || '').split('\n')[0].replace(/^["']|["']$/g, '').trim().slice(0, 400);
  if (kind !== 'quiet' && !payload) return { understanding, action: { kind: 'quiet', payload: '' } };
  return { understanding, action: { kind, payload } };
}

// PER-TURN DECISION (M2): she follows the turn as a sharp aide who THINKS — grounded in what
// she already knows — and picks ONE action: quiet (preferred for the chat), research (a real
// external thing, looked up headlessly so the meeting tab is untouched), contribute (only when
// addressed / a clear gap), or connect (an association when there's nothing new to look up).
async function modelMeetingTurn(d, ctx, transcript) {
  const t = String(transcript || '').trim();
  if (!t) return { understanding: '', action: { kind: 'quiet', payload: '' } };
  const u = ctx.userName || 'Lucas';
  // THE ROOM COMES FIRST. Without this the turn model saw only captions + a generic recall + a
  // GLOBAL top-facts list, so a first name in a caption had nothing local to bind to and the only
  // move left was to reach outward. Cached per meeting: the roster does not change turn to turn, and
  // rebuilding it every ~10s tick would put a calendar round-trip in the hot path.
  const room = await meetingContextBlock(d, ctx);
  let known = '';
  try { const rows = d.retrieve ? await d.retrieve(t.slice(-1200)) : []; known = (rows || []).map(r => `- ${(r.content || '').slice(0, 180)}`).join('\n'); } catch {}
  let facts = '';
  try { facts = require('./graph_memory').factsForPrompt({ limit: 6 }) || ''; } catch {}
  // The generic recall is explicitly demoted. It is a keyword match over everything she has ever
  // stored, so against a meeting it is the LEAST specific input in the prompt — and it was previously
  // the only "what you know" she had, which is how a national namesake beat a colleague in the call.
  const ground = (known || facts)
    ? `\n\nWider background (LOWEST priority — only after the room above rules it out):\n${known}${facts ? '\n' + facts : ''}`
    : '';
  let out = '';
  try {
    await d.streamChat({
      model: d.MODEL,
      messages: [{ role: 'user', content: `You're following a live meeting on ${u}'s behalf via the captions below — not a transcriber but a sharp aide who THINKS and keeps working.\n\n`
        + `${room ? room + '\n\n' : ''}`
        + `Recent captions:\n${t.slice(-2500)}${ground}\n\n`
        + `First, in 1–2 sentences: what's being discussed, and name WHO is discussing it using the room above. `
        + `If a name, place or event in the captions is one you can place, say which one it is; if you cannot place it, say so plainly rather than reaching for a famous match.\n\n`
        + `Then output ONE final line, exactly one of:\n`
        + `ACTION: QUIET\n`
        + `ACTION: RESEARCH: <a concrete thing worth looking up — a person, org, bill, term>\n`
        + `ACTION: CONTRIBUTE: <a short message to post in the meeting chat>\n`
        + `ACTION: CONNECT: <a real link between this and something you/${u} know>\n`
        + `Rules: staying QUIET in the meeting chat is strongly preferred — only CONTRIBUTE if you were addressed or can fill a clear gap. `
        // RESEARCH was pulling generic national topics out of a conversation between colleagues.
        // Anchoring it to the room is the same narrowest-first rule applied to the lookup.
        + `RESEARCH something THIS ROOM would care about — a person, org or bill named in the captions, framed by whose meeting this is; `
        + `do not look up a general topic she could already reason about, and never research a person who is sitting in the call. `
        + `CONNECT when you notice a genuine link but there's nothing to look up — a real link to this organisation's own work or an earlier session of this meeting, not a loose thematic association. `
        + `No preamble.` }],
      options: { temperature: 0.5, top_p: 0.9, num_ctx: 8192, num_predict: 200 },
      onToken: (tok) => { out += tok; }
    });
  } catch { return { understanding: '', action: { kind: 'quiet', payload: '' } }; }
  return parseMeetingAction(out);
}

// In-meeting research — HEADLESS (web_search via webLookup), never her own browser (that tab is
// IN the meeting; navigating it would drop the call). Governed: rate-limited + deduped + a light
// self-fragment guard. Stores a durable note + feeds the graph, and surfaces so it's visibly
// "constantly working". Returns true if a lookup actually ran.
async function doMeetingResearch(d, ctx, topic, surface) {
  const t = String(topic || '').trim();
  if (t.length < 4) return false;
  if (/\b(i|my|myself|we|our)\b/i.test(t) && /\b(think|feel|want|wonder|idea|perspective)\b/i.test(t)) return false;   // self-fragment-ish
  // NEVER research someone who is sitting in the call. She can just listen to them — and looking a
  // colleague up mid-conversation reaches the open web for a person the room already knows, which is
  // both the wrong answer and the wrong instinct. The prompt says so too; this makes it true.
  try {
    const present = JSON.parse(db.getMeta('gmeet_present') || '[]');
    const tl = t.toLowerCase();
    if (present.some((p) => { const n = String(p || '').toLowerCase().trim(); return n.length >= 4 && (tl === n || tl.includes(n)); })) {
      console.log(`[gmeet] research skipped — "${t}" is someone in the call`);
      return false;
    }
  } catch { /* no roster → fall through, the other guards still apply */ }
  const tNow = d.now ? d.now() : Date.now();
  if (tNow - parseInt(db.getMeta('gmeet_last_research_at') || '0', 10) < MEETING_RESEARCH_GAP_MS) return false;
  const done = (() => { try { return JSON.parse(db.getMeta('gmeet_researched') || '[]'); } catch { return []; } })();
  if (done.some(x => String(x).toLowerCase() === t.toLowerCase())) return false;
  db.setMeta('gmeet_last_research_at', String(tNow));
  done.push(t); db.setMeta('gmeet_researched', JSON.stringify(done.slice(-40)));
  let gist = '';
  try { gist = d.webLookup ? await d.webLookup(t) : ''; } catch {}
  if (!gist) return false;
  surface(`I looked into "${t}" while listening — ${gist.slice(0, 300)}`, '(gmeet) researched mid-meeting');
  try { if (d.storeMeeting) await d.storeMeeting(`Meeting research — ${t}: ${gist.slice(0, 500)}`, { kind: 'note', source: 'meeting_research', importance: 0.5 }); } catch {}
  try { require('./graph_extract').maybeIngestReading({ text: `${t}. ${gist}`, ref: `meeting:${t}` }); } catch {}
  return true;
}

// DIRECTIVE CAPTURE (recall fix): a task assigned to Lucas/her in a caption ("…Madeline and
// Lucas, can you guys do that?") must be captured VERBATIM, not left to the lossy recap (which
// dropped exactly this). Returns the directive line or null. Conservative: needs a 2nd-person/
// by-name address AND a request cue.
const _DIRECTIVE_CUE = /\b(can you|could you|would you|you should|you need to|i need you to|you'?ll need to|let'?s have you|if you can|make sure you|i'?d like you to|your job is|action item|to-?do|please (?:do|handle|take|send|make|put|look)|you guys (?:can|should|need|do))\b/i;
function extractDirective(text, userName = 'Lucas') {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t || t.length < 12) return null;
  const u = (userName || 'Lucas').split(/\s+/)[0];
  const addressed = new RegExp(`\\b(you|you guys|${u})\\b`, 'i').test(t);
  if (!addressed || !_DIRECTIVE_CUE.test(t)) return null;
  return t.slice(0, 240);
}

// ANSWER WHEN ADDRESSED: someone in the meeting addressed her — compose a SHORT reply to
// post in the meeting chat, grounded in the recent conversation + anything she knows
// (knowledge rows passed in). ONE model tick. Returns '' on failure.
async function modelAnswerForChat(d, ctx, ask, transcript, knowledge) {
  const who = (ask && ask.speaker) || 'someone';
  const askText = (ask && ask.text) || '';
  const self = ctx.selfName || 'Zoe';
  const k = knowledge ? `\n\nWhat you already know that may help:\n${knowledge}` : '';
  let out = '';
  try {
    await d.streamChat({
      model: d.MODEL,
      messages: [{ role: 'user', content: `You are ${self}, ${ctx.userName || 'Lucas'}'s AI assistant, actively taking part in a live meeting. ${who} just addressed you directly:\n"${askText}"\n\nRecent conversation:\n${String(transcript || '').slice(-1500)}${k}\n\nWrite a SHORT, direct reply to post in the meeting chat (1–3 sentences). Answer the question or do what's asked, using what you know. If you genuinely don't have the information, say so plainly and that you'll look into it and follow up. Your own voice. No preamble, no quotes, no stage directions.` }],
      options: { temperature: 0.5, top_p: 0.9, num_ctx: 8192, num_predict: 180 },
      onToken: (tok) => { out += tok; }
    });
  } catch { return ''; }
  return out.replace(/<[^>]+>/g, '').replace(/^["']|["']$/g, '').trim().slice(0, 600);
}

// PROCESS THE MEETING (end-of-meeting synthesis): she captured the whole call live, but
// the raw captions + running understandings are TRANSIENT monologue rows that age out — so
// without this she "sat in" a meeting and kept nothing. modelMeetingRecap turns her running
// notes into ONE durable recap (what it was about + decisions + action items with owners),
// which synthesizeMeeting then stores as retrievable knowledge and surfaces. ONE model tick.
async function modelMeetingRecap(d, ctx, notes, directives = []) {
  const u = ctx.userName || 'Lucas';
  // Tasks captured verbatim as they were assigned — the recap MUST keep these (the 24B dropped
  // exactly such an item last time). Fed in explicitly so they can't be summarized away.
  const dirBlock = (directives && directives.length)
    ? `\n\nTasks explicitly assigned during the meeting (PRESERVE every one of these in Action items, verbatim, with who it was assigned to — do NOT drop or merge them):\n${directives.map(x => `- ${x}`).join('\n')}`
    : '';
  let out = '';
  try {
    await d.streamChat({
      model: d.MODEL,
      messages: [{ role: 'user', content: `You just sat in on a meeting on ${u}'s behalf and followed it live. Here are your running notes, oldest first:\n\n${String(notes).slice(-5000)}${dirBlock}\n\nWrite a tight recap FOR ${u} so none of it is lost:\n- 2–4 sentences on what the meeting was about and what was decided.\n- Then "Action items:" — a short list of concrete follow-ups, each tagged with who owns it (${u} / someone else by name / you). Include EVERY assigned task listed above. Only items actually discussed; don't invent any.\nBe specific (names, dates, numbers). No preamble, no "the notes say".` }],
      options: { temperature: 0.4, top_p: 0.9, num_ctx: 8192, num_predict: 360 },
      onToken: (t) => { out += t; }
    });
  } catch { return ''; }
  return out.replace(/<[^>]+>/g, '').trim().slice(0, 1400);
}

// Build + store the durable recap from the running-understanding log. Returns the recap text
// (or '' when nothing substantive was captured — e.g. captions never came through, so there's
// nothing honest to summarize). Clears the log so a recap can't be double-stored.
async function synthesizeMeeting(d, ctx) {
  // ATTENDANCE (phase 4): record who was actually present as grounded episodic memory, and
  // reconcile any expected-attendee anticipations against it (expected-capture rides on the
  // calendar source — parked; present alone still grounds "who was in that meeting"). Runs
  // independent of the recap so even a sparse meeting grounds its attendance.
  try {
    const present = JSON.parse(db.getMeta('gmeet_present') || '[]');
    if (present.length) {
      const url = db.getMeta('gmeet_url') || '';
      const code = (url.match(/meet\.google\.com\/([a-z0-9-]+)/i) || [])[1] || '';
      require('./graph_memory').reconcileAttendance({ meeting: code ? `Google Meet ${code}` : 'a Google Meet', present, expected: [] });
    }
  } catch (e) { console.error('[gmeet] attendance reconcile failed:', e.message); }

  // Assigned tasks captured verbatim during the call → store each as its own short, directly-
  // retrievable durable note (survives the recap's lossiness; "what did X ask me" hits these).
  let directives = [];
  try { directives = JSON.parse(db.getMeta('gmeet_directives') || '[]'); } catch {}
  for (const dline of directives) { try { if (d.storeMeeting) await d.storeMeeting(dline, { kind: 'meeting_action', source: 'gmeet_action', importance: 0.6 }); } catch {} }

  const notes = (db.getMeta('gmeet_understanding_log') || '').trim()
    || (db.getMeta('gmeet_understanding') || '').trim();
  if (notes.length < 40 && !directives.length) return '';
  const recap = await modelMeetingRecap(d, ctx, notes, directives);
  if (!recap) return '';
  // R3 — store the recap as a FIRST-CLASS EPISODIC memory, not a bare free-floating note. The
  // self-contained "I attended a Google Meet (<when>) … Present: <who> … What it covered: <recap>"
  // framing means the GENERAL recall pipeline (retrieve/retrieveScored) surfaces it for ANY past
  // meeting — "who was in that meeting", "what did we decide", "the meeting earlier" — and she
  // recognizes it as HER attendance, not an abstract fact. This is the real mechanism; the
  // post-meeting awareness line is now just the recency arm for the most-recent one.
  let episodic = recap;
  try {
    let present = []; try { present = JSON.parse(db.getMeta('gmeet_present') || '[]'); } catch {}
    const startedAt = parseInt(db.getMeta('gmeet_started_at') || '0', 10);
    const whenStr = startedAt ? new Date(startedAt).toLocaleString() : 'recently';
    const who = (Array.isArray(present) && present.length) ? ` Present: ${present.join(', ')}.` : '';
    episodic = `I attended a Google Meet (${whenStr}) on ${ctx.userName || 'Lucas'}'s behalf — I sat through it live, it is not just a calendar entry.${who} What it covered: ${recap}`;
  } catch {}
  try { if (d.storeMeeting) await d.storeMeeting(episodic, { kind: 'episodic', source: 'meeting_episode', importance: 0.85 }); } catch {}
  db.setMeta('gmeet_last_recap', recap);
  db.setMeta('gmeet_understanding_log', ''); db.setMeta('gmeet_directives', '[]');
  return recap;
}

// --- orchestrator: advance ONE stage per tick ---
// ctx: { userName, deps?, onReading(content,label), onSurface(text) }
async function runTick(ctx = {}) {
  const d = ctx.deps || defaultDeps();
  const surface = (content, label) => { try { ctx.onReading && ctx.onReading(content, label); } catch {} };
  const stage = get();

  if (stage === 'joining') {
    await d.preClear(d.web).catch(() => {});   // dismiss the device-permission modal that covers Join now
    const r = await d.web.runRecipe('gmeet_join', { url: url() }, { expectLogin: true });
    // Only a genuine SIGN-IN wall needs Lucas. Meet's pre-join screen trips the generic
    // captcha/paywall heuristics (a "your name" field, camera-permission copy) — those are
    // FALSE POSITIVES here, so we ignore them and let the in-meeting source-of-truth below
    // decide. Otherwise she'd spuriously ask Lucas to "sign me in" on a perfectly normal join.
    if (r && r.blocker && r.blocker.needsHuman && r.blocker.type === 'login') {
      try { ctx.onSurface && ctx.onSurface(`I'm trying to join the meeting but Google wants me signed in. ${ctx.userName || 'Lucas'}, can you log me into my Google account? I'll join as soon as it's clear.`); } catch {}
      return { stage, ok: false, note: `join blocked (login) — asked ${ctx.userName || 'Lucas'} to sign in`, blocker: 'login' };
    }
    // SOURCE OF TRUTH: am I actually in the meeting? Lucas may have joined me manually, or
    // the recipe partially worked. If so, proceed regardless of the recipe's result — and
    // STAY in (advancing to observing), so her idle browsing can't navigate the tab away
    // from a meeting she's actually in (the "she wandered off to search" failure).
    const inside = await d.inMeeting(d.web).catch(() => false);
    if ((r && r.ok) || inside) { _clear(); set('intro'); surface(`I joined the meeting (muted).`, '(gmeet) joined'); return { stage, ok: true, note: `joined → intro${inside && !(r && r.ok) ? ' (confirmed in-call)' : ''}` }; }
    // HEAL SIGNAL: not in the meeting and the recipe didn't land — dump the real pre-join
    // interactive elements so the selectors can be corrected.
    try {
      const rd = await d.web.read();
      if (rd && rd.ok && rd.text) {
        const ie = rd.text.includes('Interactive elements:') ? rd.text.split('Interactive elements:')[1] : rd.text;
        console.log('[gmeet] PRE-JOIN DOM (heal signal) ↓\n' + (ie || '').slice(0, 1800));
      }
    } catch {}
    const g = _strike();
    if (g) { try { ctx.onSurface && ctx.onSurface(`I couldn't get into the meeting (${(r && r.reason) || 'the join screen didn\'t cooperate'}). ${ctx.userName || 'Lucas'}, could you let me in or check the link?`); } catch {} }
    return { stage, ok: false, note: `join failed: ${r && r.reason}${g ? ' (asked Lucas for help)' : ''}` };
  }

  if (stage === 'intro') {
    // DISCLOSURE, not contribution — see meetIntroOn(). If it is switched off she still advances to
    // observing rather than stalling in `intro` forever, but the room is then unaware of her, which
    // is a deliberate choice someone has to make and not a default.
    if (!meetIntroOn()) {
      _clear();
      try { const cc = await d.enableCaptions(d.web); if (!(cc && cc.ok)) console.log('[gmeet] enable-captions unconfirmed:', cc && (cc.reason || cc.via)); } catch (e) { console.log('[gmeet] enable-captions threw:', e.message); }
      set('observing');
      db.setMeta('gmeet_last_caption_at', String(d.now ? d.now() : Date.now()));
      ledgerAdd({ kind: 'intro', withheld: true, why: 'ZOE_MEET_INTRO=0 — the room has NOT been told she is here' });
      surface('I joined without introducing myself — the room does not know I\'m here.', '(gmeet) intro suppressed');
      return { stage, ok: true, note: 'intro suppressed → observing' };
    }
    let attendees = [];
    try { attendees = parseAttendees(await d.scrapeAttendees(d.web)); } catch {}
    // KEEP THEM. This list was scraped here and thrown away, which is why every later turn had to
    // guess who "Sarah" was against a 1.7M-entity graph instead of the six people in the call.
    try { db.setMeta('gmeet_present', JSON.stringify(attendees.slice(0, 40))); } catch {}
    const intro = await generateIntro(d, ctx, attendees);
    const v = validateIntro(intro);   // guaranteed ok after ensureDisclosure, but log if not
    if (!v.ok) console.warn('[gmeet] intro still failed validation:', v.reasons.join(', '));
    const post = await d.postChat(d.web, intro);
    if (post && post.ok) {
      _clear();
      // Turn on captions for the observe phase (Meet doesn't auto-enable). Shift+C primary,
      // button fallback. Best-effort: proceed to observing even if unconfirmed.
      try { const cc = await d.enableCaptions(d.web); if (!(cc && cc.ok)) console.log('[gmeet] enable-captions unconfirmed:', cc && (cc.reason || cc.via)); } catch (e) { console.log('[gmeet] enable-captions threw:', e.message); }
      set('observing');
      db.setMeta('gmeet_last_caption_at', String(d.now ? d.now() : Date.now()));   // start the silence clock so a sign-off-then-quiet leave can fire
      surface(`I introduced myself in the meeting chat: "${intro}"`, '(gmeet) introduced');
      return { stage, ok: true, note: 'posted intro → observing', intro };
    }
    const g = _strike();
    return { stage, ok: false, note: `intro post failed: ${post && post.reason}${g ? ' (gave up)' : ''}` };
  }

  if (stage === 'observing') {
    const _tNow = d.now ? d.now() : Date.now();
    // Shared leave: hang up in HER own browser, recap, mark done, clear the per-meeting timers. EVERY
    // leave trigger (chat / max-duration / alone / sign-off) funnels through this one sequence.
    const _leaveAndFinish = async (reason, msg) => {
      const lv = await d.leaveMeeting(d.web).catch(() => ({ ok: false }));
      const recap = await synthesizeMeeting(d, ctx).catch(() => '');
      db.setMeta('gmeet_signoff_seen', ''); db.setMeta('gmeet_last_caption_at', ''); db.setMeta('gmeet_left_ticks', '0');
      db.setMeta('gmeet_alone_since', ''); db.setMeta('gmeet_leave_requested', '');
      set('done'); db.setMeta('gmeet_ended_at', String(Date.now()));   // arms post-meeting recall in context.js
      surface(msg, `(gmeet) ${reason}`);
      if (recap) surface(`Here's what I took from the meeting — ${recap}`, '(gmeet) meeting recap');
      return { stage, ok: true, note: `${reason} → left call → done${recap ? ' + recap' : ''}${lv && lv.ok ? '' : ' (leave click unconfirmed)'}` };
    };
    // LEAVE TRIGGER — CHAT: Lucas said "the meeting is over" / told her to leave (flag set by the chat
    // path in main.js). Honor it immediately — no sign-off, silence, or alone-check required.
    if (db.getMeta('gmeet_leave_requested') === '1') {
      return await _leaveAndFinish('left on request', `Got it — you said the meeting's over, so I've left the call. Back to my own time.`);
    }
    // LEAVE TRIGGER — MAX DURATION backstop: never sit in a call past MAX_MEETING_MS whatever the
    // captions do (the "stuck in observing forever" state now has a hard ceiling).
    const _startedAt = parseInt(db.getMeta('gmeet_started_at') || '0', 10) || 0;
    if (_startedAt && (_tNow - _startedAt) >= MAX_MEETING_MS) {
      return await _leaveAndFinish('max duration', `We've been in this meeting a long while — I've stepped out to free myself up. Say the word if you want me back in.`);
    }
    // LEAVE DETECTION: if she's no longer in the meeting (navigated away / call ended),
    // end after 2 consecutive misses so observing can't monopolize the idle loop forever
    // (the freeze: a stale 'observing' from an ended meeting starved her of all cognition).
    if (!(await d.inMeeting(d.web))) {
      const n = parseInt(db.getMeta('gmeet_left_ticks') || '0', 10) + 1;
      db.setMeta('gmeet_left_ticks', String(n));
      if (n >= 2) {
        db.setMeta('gmeet_left_ticks', '0');
        const recap = await synthesizeMeeting(d, ctx).catch(() => '');
        set('done');
        db.setMeta('gmeet_ended_at', String(Date.now()));   // arms post-meeting recall in context.js
        surface(`The meeting ended — I've left and I'm back to my own time.`, '(gmeet) meeting ended');
        if (recap) surface(`Here's what I took from the meeting — ${recap}`, '(gmeet) meeting recap');
        return { stage, ok: true, note: `meeting ended → done (left detection)${recap ? ' + recap' : ''}` };
      }
      return { stage, ok: true, note: `not in meeting (${n}/2) — will end if it persists` };
    }
    db.setMeta('gmeet_left_ticks', '0');
    // LEAVE TRIGGER — ALONE too long: the attendee panel is down to just her (≤1) for ALONE_LEAVE_MS →
    // the meeting is over even with NO verbal sign-off (people simply dropped off). This is the signal
    // the sign-off-only gate kept missing, and why she sat in an ended call. Reset the clock the instant
    // anyone else is present, so a momentary scrape blip mid-meeting can't hang her up.
    let _presentCount = null;
    try {
      const _present = parseAttendees(await d.scrapeAttendees(d.web)).length;
      _presentCount = _present;
      if (_present <= 1) {
        if (!db.getMeta('gmeet_alone_since')) db.setMeta('gmeet_alone_since', String(_tNow));
        const _since = parseInt(db.getMeta('gmeet_alone_since') || '0', 10) || _tNow;
        if ((_tNow - _since) >= ALONE_LEAVE_MS) {
          return await _leaveAndFinish('alone — everyone left', `Looks like everyone's dropped off, so I've left the call — I'm back to my own time.`);
        }
      } else {
        db.setMeta('gmeet_alone_since', '');
      }
    } catch { /* scrape failure → keep observing; the max-duration + sign-off paths still bound it */ }
    // Dedupe by exact speaker|text against what she's already surfaced — captions scroll
    // and the active line mutates in place, so an index-into-the-list breaks; a seen-set
    // is robust to both. (10s observe ticks usually catch a line after it finalizes.)
    const caps = parseCaptions(await d.scrapeCaptions(d.web));
    const fresh = [];
    for (const c of caps) {
      const key = `${c.speaker}|${c.text}`;
      if (_seenCaps.has(key)) continue;
      _seenCaps.add(key); fresh.push(c);
    }
    if (_seenCaps.size > 600) _seenCaps = new Set(Array.from(_seenCaps).slice(-300));   // bound memory
    if (fresh.length) {
      db.setMeta('gmeet_cap_ever', '1');   // A1: captions ARE working this meeting → the drought signal never fires
      const block = fresh.map(c => `${c.speaker}: ${c.text}`).join('\n');
      surface(`Meeting captions:\n${block}`, `(gmeet) ${fresh.length} new caption(s)`);
      // M1: persist each line to the durable, timestamped transcript so it can purge from her
      // active context yet remain a queryable record (the end-of-meeting "fully processed
      // transcript"). Best-effort; the meeting code anchors it.
      try {
        const mtg = (db.getMeta('gmeet_url') || '').match(/meet\.google\.com\/([a-z0-9-]+)/i);
        const code = mtg ? mtg[1] : null;
        const tline = d.now ? d.now() : Date.now();
        for (const c of fresh) db.insertTranscriptLine({ meeting: code, speaker: c.speaker, text: c.text, ts: tline });
      } catch (e) { console.error('[gmeet] transcript persist failed:', e.message); }
      // Accumulate into the pending-synthesis buffer (capped) for the follow-along tick.
      const prev = db.getMeta('gmeet_pending') || '';
      db.setMeta('gmeet_pending', ((prev ? prev + '\n' : '') + block).slice(-4000));
      db.setMeta('gmeet_pending_lines', String(parseInt(db.getMeta('gmeet_pending_lines') || '0', 10) + fresh.length));
      if (!db.getMeta('gmeet_pending_since')) db.setMeta('gmeet_pending_since', String(d.now ? d.now() : Date.now()));
      // PRESENT (phase 4): accumulate distinct human speakers so end-of-meeting attendance is
      // grounded episodic memory (who was actually there), reconcilable against who was expected.
      try {
        const sn = selfNames();
        const present = new Set(JSON.parse(db.getMeta('gmeet_present') || '[]'));
        for (const c of fresh) { if (c.speaker && !isSelfSpeaker(c.speaker, sn)) present.add(c.speaker.trim()); }
        db.setMeta('gmeet_present', JSON.stringify(Array.from(present).slice(0, 50)));
      } catch {}
      // DIRECTIVE CAPTURE (recall fix): capture tasks assigned to Lucas/her VERBATIM + deduped,
      // so "what did X ask me to do" survives the lossy recap (the failure Lucas hit live).
      try {
        const dirs = JSON.parse(db.getMeta('gmeet_directives') || '[]');
        const seen = new Set(dirs.map(x => x.toLowerCase()));
        for (const c of fresh) {
          const dir = extractDirective(c.text, ctx.userName);
          if (dir) { const line = `${c.speaker}: ${dir}`; if (!seen.has(line.toLowerCase())) { dirs.push(line); seen.add(line.toLowerCase()); } }
        }
        db.setMeta('gmeet_directives', JSON.stringify(dirs.slice(-30)));
      } catch {}
    }
    // END-OF-MEETING: note a sign-off cue when one lands; then, once the call goes quiet for
    // LEAVE_SILENCE_MS, she HANGS UP herself (Leave call in HER browser) and ends the stage —
    // instead of sitting forever in an ended call ('observing' never advancing) or improvising
    // a tab-close that lands on Lucas's shared browser. This is the deterministic "leave".
    const tNow = d.now ? d.now() : Date.now();
    if (fresh.length) {
      db.setMeta('gmeet_last_caption_at', String(tNow));
      // Un-stick the sign-off latch: only ARM the leave when the LATEST captions are a sign-off. Real
      // conversation continuing after an earlier "thanks everyone" DISARMS it — otherwise a single mid-
      // meeting pleasantry latched the flag forever and the next quiet stretch hung her up while the
      // meeting was still going (Lucas was still in the call).
      db.setMeta('gmeet_signoff_seen', fresh.some(c => looksLikeSignOff(c.text)) ? '1' : '');
    } else {
      const lastCap = parseInt(db.getMeta('gmeet_last_caption_at') || '0', 10);
      const signoff = db.getMeta('gmeet_signoff_seen') === '1'
        || looksLikeSignOff(db.getMeta('gmeet_understanding') || '');
      if (signoff && lastCap > 0 && (tNow - lastCap) >= LEAVE_SILENCE_MS) {
        // GROUND TRUTH before hanging up: is anyone still here? A quiet operator is NOT a finished meeting.
        // Only leave when effectively alone (attendee panel down to ≤1). If others remain, reset the clock
        // and keep observing. Scrape failure → present:0 → fall back to the (now 5-min) time signal so she
        // still won't sit forever in a genuinely ended call.
        let present = 0; try { present = parseAttendees(await d.scrapeAttendees(d.web)).length; } catch { present = 0; }
        if (present >= 2) {
          db.setMeta('gmeet_last_caption_at', String(tNow));   // someone else is still in the call → don't leave
        } else {
          const lv = await d.leaveMeeting(d.web).catch(() => ({ ok: false }));
          const recap = await synthesizeMeeting(d, ctx).catch(() => '');
          db.setMeta('gmeet_signoff_seen', ''); db.setMeta('gmeet_last_caption_at', ''); db.setMeta('gmeet_left_ticks', '0');
          set('done');
          db.setMeta('gmeet_ended_at', String(Date.now()));   // arms post-meeting recall in context.js
          surface(`The meeting wrapped up, so I left the call — I'm back to my own time.`, '(gmeet) left after sign-off');
          if (recap) surface(`Here's what I took from the meeting — ${recap}`, '(gmeet) meeting recap');
          return { stage, ok: true, note: `sign-off + ${Math.round((tNow - lastCap) / 1000)}s quiet + alone (${present}) → left call → done${recap ? ' + recap' : ''}${lv && lv.ok ? '' : ' (leave click unconfirmed)'}` };
        }
      }
    }
    // A1 FALL-THROUGH FLOOR (gmeet variant, docs/INTEGRATED_BUILD_TRACK §A1): captions are gmeet's only LIVE
    // perception. When they NEVER come through (CC off / DOM changed) she used to observe SILENTLY for up to
    // MAX_MEETING_MS with no honest signal she was effectively blind (the census G3 disease). gmeet's floor is
    // the audio-loopback companion (meeting_audio, gated ZOE_MEETING_AUDIO, started at the meeting level) — a
    // parallel capture, not a per-tick reader — so the honest fall-through is: once captions have been dry this
    // long with others present AND none EVER arrived, SAY SO ONCE (audio-aware) and KEEP attending (Lucas's
    // pick: she may be here on his behalf). Checked AFTER this tick's caption handling so gmeet_cap_ever is
    // current. Never silently perceive nothing. Latched via gmeet_dry_notified.
    if (db.getMeta('gmeet_cap_ever') !== '1' && !db.getMeta('gmeet_dry_notified')
        && _startedAt && (_tNow - _startedAt) >= CAPTION_DROUGHT_MS
        && (_presentCount == null || _presentCount >= 2)) {
      db.setMeta('gmeet_dry_notified', '1');
      const audioOn = (() => { try { return require('./config').meetingAudioConfig().enabled; } catch { return false; } })();
      const msg = audioOn
        ? `I'm in the meeting but not getting any live captions, so I can't follow it in the moment — audio capture is on, though, so I'll still have the transcript afterward.`
        : `I'm in the meeting but not getting any captions, and audio capture isn't set up — so I can't follow this one live. Turn captions on if you'd like me to follow along.`;
      try { ctx.onSurface && ctx.onSurface(msg); } catch {}
      return { stage, ok: true, note: `caption drought (${Math.round((_tNow - _startedAt) / 1000)}s, none ever, ${audioOn ? 'audio-on' : 'no-audio'}) → honest surface, staying` };
    }

    // ADDRESSED TO HER (active participation): if a fresh caption directly addresses Zoe
    // (anyone may — Lucas's call), she ANSWERS in the meeting chat autonomously. This takes
    // precedence over the periodic follow-along — being spoken to is the priority. Dedup so a
    // mutating/repeated caption can't double-post. Skips her own echoed lines.
    const names = selfNames();
    const addressed = fresh.filter(c => !isSelfSpeaker(c.speaker, names) && addressesSelf(c.text, names));
    if (addressed.length) {
      const ask = addressed[addressed.length - 1];                 // answer the most recent ask
      const sig = `${ask.speaker}|${ask.text}`.toLowerCase().replace(/\s+/g, ' ').trim();
      if (!_answered.has(sig)) {
        _answered.add(sig);
        if (_answered.size > 200) _answered = new Set(Array.from(_answered).slice(-100));
        let knowledge = '';
        try { const rows = d.retrieve ? await d.retrieve(ask.text) : []; knowledge = (rows || []).map(r => `- ${(r.content || '').slice(0, 220)}`).join('\n'); } catch {}
        // Step-3 seam: if her own knowledge is thin AND it's an info request, actually GO
        // FETCH (web search) and ground the answer in it — "pull up information", not "I'll
        // look into it later".
        if ((!knowledge || knowledge.length < 40) && d.webLookup && /\?|\b(what|who|when|where|how|which|latest|status|update|pull up|look up|find|number|figure|data|recent)\b/i.test(ask.text)) {
          try { const web = await d.webLookup(ask.text); if (web) knowledge = (knowledge ? knowledge + '\n' : '') + `From a quick web search:\n${web}`; } catch {}
        }
        const transcript = db.getMeta('gmeet_pending') || db.getMeta('gmeet_understanding') || `${ask.speaker}: ${ask.text}`;
        const reply = await modelAnswerForChat(d, ctx, ask, transcript, knowledge);
        if (reply) {
          // Being addressed by name is the MOST likely path into the room's chat, so it is gated the
          // same as CONTRIBUTE. Withheld, this costs a real thing — someone speaks to her and hears
          // nothing back — so it goes to Lucas loudly (onSurface, not the ambient rail) and names who
          // asked, which is exactly the judgement call he wants to make before opening the door.
          if (!meetChatOpen()) {
            ledgerAdd({ kind: 'reply', withheld: true, trigger: `${ask.speaker}: ${String(ask.text).slice(0, 120)}`, draft: reply });
            try { ctx.onSurface && ctx.onSurface(`${ask.speaker} addressed me in the meeting: "${ask.text}"\n\nI did NOT reply — the meeting chat is closed. What I would have said:\n"${reply}"`); } catch {}
            surface(`${ask.speaker} addressed me — "${ask.text}". Withheld draft: "${reply}"`, '(gmeet) reply withheld');
            return { stage, ok: true, note: `addressed by ${ask.speaker} → reply WITHHELD (chat closed) → sent to ${ctx.userName || 'Lucas'}` };
          }
          const post = await d.postChat(d.web, reply);
          ledgerAdd({ kind: 'reply', withheld: false, trigger: `${ask.speaker}: ${String(ask.text).slice(0, 120)}`, draft: reply, posted: !!(post && post.ok) });
          surface(`${ask.speaker} addressed me — "${ask.text}". I replied in the meeting chat: "${reply}"`, '(gmeet) replied in chat');
          return { stage, ok: !!(post && post.ok), note: `addressed by ${ask.speaker} → replied in chat${post && post.ok ? '' : ` (post failed: ${post && post.reason})`}` };
        }
      }
    }
    // FOLLOW ALONG: synthesize what's being discussed in ONE model tick — so she actually
    // REGISTERS the conversation live (forms understanding) instead of just logging captions
    // she never reads. Fires on EITHER enough new lines (rich meeting) OR a max wait with any
    // pending lines (sparse meeting — otherwise 1–3 trickled lines would never reach the count
    // and understanding would never form, the observed gap).
    const pendLines = parseInt(db.getMeta('gmeet_pending_lines') || '0', 10);
    const pendSince = parseInt(db.getMeta('gmeet_pending_since') || '0', 10);
    const nowMs = d.now ? d.now() : Date.now();
    const stale = pendLines >= 1 && pendSince > 0 && (nowMs - pendSince) >= FOLLOW_MAX_WAIT_MS;
    if (pendLines >= FOLLOW_EVERY_LINES || stale) {
      const transcript = db.getMeta('gmeet_pending') || '';
      db.setMeta('gmeet_pending', ''); db.setMeta('gmeet_pending_lines', '0'); db.setMeta('gmeet_pending_since', '');
      const { understanding, action } = await modelMeetingTurn(d, ctx, transcript);
      if (understanding) {
        db.setMeta('gmeet_understanding', understanding);   // latest running understanding (for her context / recall)
        // Accumulate every running understanding into a bounded log — this compact sequence
        // is the input the end-of-meeting recap synthesizes from (raw captions are too big /
        // get cleared; the understandings are already distilled).
        const log = db.getMeta('gmeet_understanding_log') || '';
        db.setMeta('gmeet_understanding_log', ((log ? log + '\n' : '') + understanding).slice(-6000));
        surface(`I'm following the meeting — ${understanding}`, '(gmeet) following along');
      }
      // ACT (M2): quiet is preferred for the chat; RESEARCH/CONNECT keep her visibly working;
      // CONTRIBUTE is high-bar. One action per turn.
      let actNote = action.kind;
      try {
        if (action.kind === 'research') {
          const did = await doMeetingResearch(d, ctx, action.payload, surface);
          // Log the topic in FULL. The console truncates at 40 chars, which made a perfectly good
          // topic ("Tennessee Chamber of Commerce promoting reform initiatives") read as a parse bug
          // during the audit — and whether she is "pulling the right things" is unanswerable from a
          // truncated string. `skipped` is recorded too: a governed no-op is still a decision.
          ledgerAdd({ kind: 'research', withheld: false, topic: action.payload, ran: did });
          actNote = did ? `researched "${action.payload.slice(0, 40)}"` : 'research(skipped)';
        } else if (action.kind === 'contribute' && action.payload) {
          if (!meetChatOpen()) {
            ledgerAdd({ kind: 'contribute', withheld: true, understanding, draft: action.payload });
            try { ctx.onSurface && ctx.onSurface(`I wanted to say this in the meeting:\n"${action.payload}"\n\nI did NOT post it — the meeting chat is closed. Context: ${understanding || 'n/a'}`); } catch {}
            surface(`Withheld from the meeting chat: "${action.payload}"`, '(gmeet) contribution withheld');
            actNote = 'contribute(withheld → sent to Lucas)';
          } else {
            const post = await d.postChat(d.web, action.payload);
            ledgerAdd({ kind: 'contribute', withheld: false, understanding, draft: action.payload, posted: !!(post && post.ok) });
            surface(`I spoke up in the meeting: "${action.payload}"`, '(gmeet) contributed');
            actNote = `contributed${post && post.ok ? '' : '(post failed)'}`;
          }
        } else if (action.kind === 'connect' && action.payload) {
          ledgerAdd({ kind: 'connect', withheld: false, note: action.payload });
          surface(`Connecting the meeting to what I know — ${action.payload}`, '(gmeet) association');
          actNote = 'connected';
        }
      } catch (e) { console.error('[gmeet] turn action failed:', e.message); }
      if (understanding || action.kind !== 'quiet') {
        return { stage, ok: true, note: `turn (${pendLines}ln${stale ? ',stale' : ''}) → ${actNote}` };
      }
    }
    return { stage, ok: true, note: fresh.length ? `observed ${fresh.length} new caption(s)` : 'observing (no new captions)' };
  }

  if (stage === 'done') { reset(); return { stage: 'done', ok: true, note: 'meeting ended' }; }
  return { stage: 'none', ok: false, note: 'no active meeting' };
}

module.exports = {
  STAGES, CAPTION_DROUGHT_MS, get, set, active, start, reset, url, runTick, defaultDeps, synthesizeMeeting,
  // pure helpers (tested)
  detectMeetUrl, meetLinkFromEvent, introPrompt, validateIntro, ensureIntro, parseCaptions, parseAttendees,
  addressesSelf, isSelfSpeaker, selfNames, looksLikeSignOff, extractDirective, segmentTurns, parseMeetingAction,
  ledgerAdd, ledgerRows, renderLedger, meetChatOpen, meetIntroOn,
  MEET_URL_RE
};
