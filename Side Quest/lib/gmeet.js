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
const LEAVE_SILENCE_MS = 90000;   // after a clear sign-off, if captions go quiet THIS long she hangs up herself (instead of sitting alone in an ended call / improvising a tab-close)

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
    MODEL: require('./config').model(),
    scrapeAttendees: liveScrapeAttendees,
    scrapeCaptions: liveScrapeCaptions,
    enableCaptions: liveEnableCaptions,
    inMeeting: liveInMeeting,
    leaveMeeting: liveLeaveMeeting,
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
async function modelFollowAlong(d, ctx, transcript) {
  const t = String(transcript || '').trim();
  if (!t) return '';
  let out = '';
  try {
    await d.streamChat({
      model: d.MODEL,
      messages: [{ role: 'user', content: `You're quietly observing a meeting on ${ctx.userName || 'Lucas'}'s behalf, following along via the live captions below.\n\n${t.slice(-2500)}\n\nIn ONE or TWO sentences, say what's being discussed right now and anything worth remembering for ${ctx.userName || 'Lucas'}. Just the substance — no preamble, no "the captions say".` }],
      options: { temperature: 0.4, top_p: 0.9, num_ctx: 8192, num_predict: 140 },
      onToken: (tok) => { out += tok; }
    });
  } catch { return ''; }
  return out.replace(/<[^>]+>/g, '').trim().slice(0, 400);
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
    let attendees = [];
    try { attendees = parseAttendees(await d.scrapeAttendees(d.web)); } catch {}
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
    // LEAVE DETECTION: if she's no longer in the meeting (navigated away / call ended),
    // end after 2 consecutive misses so observing can't monopolize the idle loop forever
    // (the freeze: a stale 'observing' from an ended meeting starved her of all cognition).
    if (!(await d.inMeeting(d.web))) {
      const n = parseInt(db.getMeta('gmeet_left_ticks') || '0', 10) + 1;
      db.setMeta('gmeet_left_ticks', String(n));
      if (n >= 2) {
        db.setMeta('gmeet_left_ticks', '0'); set('done');
        surface(`The meeting ended — I've left and I'm back to my own time.`, '(gmeet) meeting ended');
        return { stage, ok: true, note: 'meeting ended → done (left detection)' };
      }
      return { stage, ok: true, note: `not in meeting (${n}/2) — will end if it persists` };
    }
    db.setMeta('gmeet_left_ticks', '0');
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
      const block = fresh.map(c => `${c.speaker}: ${c.text}`).join('\n');
      surface(`Meeting captions:\n${block}`, `(gmeet) ${fresh.length} new caption(s)`);
      // Accumulate into the pending-synthesis buffer (capped) for the follow-along tick.
      const prev = db.getMeta('gmeet_pending') || '';
      db.setMeta('gmeet_pending', ((prev ? prev + '\n' : '') + block).slice(-4000));
      db.setMeta('gmeet_pending_lines', String(parseInt(db.getMeta('gmeet_pending_lines') || '0', 10) + fresh.length));
      if (!db.getMeta('gmeet_pending_since')) db.setMeta('gmeet_pending_since', String(d.now ? d.now() : Date.now()));
    }
    // END-OF-MEETING: note a sign-off cue when one lands; then, once the call goes quiet for
    // LEAVE_SILENCE_MS, she HANGS UP herself (Leave call in HER browser) and ends the stage —
    // instead of sitting forever in an ended call ('observing' never advancing) or improvising
    // a tab-close that lands on Lucas's shared browser. This is the deterministic "leave".
    const tNow = d.now ? d.now() : Date.now();
    if (fresh.length) {
      db.setMeta('gmeet_last_caption_at', String(tNow));
      if (fresh.some(c => looksLikeSignOff(c.text))) db.setMeta('gmeet_signoff_seen', '1');
    } else {
      const lastCap = parseInt(db.getMeta('gmeet_last_caption_at') || '0', 10);
      const signoff = db.getMeta('gmeet_signoff_seen') === '1'
        || looksLikeSignOff(db.getMeta('gmeet_understanding') || '');
      if (signoff && lastCap > 0 && (tNow - lastCap) >= LEAVE_SILENCE_MS) {
        const lv = await d.leaveMeeting(d.web).catch(() => ({ ok: false }));
        db.setMeta('gmeet_signoff_seen', ''); db.setMeta('gmeet_last_caption_at', ''); db.setMeta('gmeet_left_ticks', '0');
        set('done');
        surface(`The meeting wrapped up, so I left the call — I'm back to my own time.`, '(gmeet) left after sign-off');
        return { stage, ok: true, note: `sign-off + ${Math.round((tNow - lastCap) / 1000)}s quiet → left call → done${lv && lv.ok ? '' : ' (leave click unconfirmed)'}` };
      }
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
          const post = await d.postChat(d.web, reply);
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
      const understanding = await modelFollowAlong(d, ctx, transcript);
      if (understanding) {
        db.setMeta('gmeet_understanding', understanding);   // latest running understanding (for her context / recall)
        surface(`I'm following the meeting — ${understanding}`, '(gmeet) following along');
        return { stage, ok: true, note: `followed along (${pendLines} line${pendLines === 1 ? '' : 's'}${stale ? ', stale-flush' : ''} → understanding)` };
      }
    }
    return { stage, ok: true, note: fresh.length ? `observed ${fresh.length} new caption(s)` : 'observing (no new captions)' };
  }

  if (stage === 'done') { reset(); return { stage: 'done', ok: true, note: 'meeting ended' }; }
  return { stage: 'none', ok: false, note: 'no active meeting' };
}

module.exports = {
  STAGES, get, set, active, start, reset, url, runTick, defaultDeps,
  // pure helpers (tested)
  detectMeetUrl, meetLinkFromEvent, introPrompt, validateIntro, ensureIntro, parseCaptions, parseAttendees,
  addressesSelf, isSelfSpeaker, selfNames, looksLikeSignOff,
  MEET_URL_RE
};
