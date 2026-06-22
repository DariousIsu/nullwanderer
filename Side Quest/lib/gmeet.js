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

// --- pure helpers (unit-tested) ---

// A Google Meet URL anywhere in text. Meet codes are xxx-xxxx-xxx (lowercase letters).
const MEET_URL_RE = /https?:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}(?:\?[^\s"'<>]*)?/i;
// Looser form (lookup codes / _meet links) as a fallback.
const MEET_URL_LOOSE_RE = /https?:\/\/meet\.google\.com\/[a-z0-9_-]+(?:\?[^\s"'<>]*)?/i;

function detectMeetUrl(text) {
  const t = String(text || '');
  const m = t.match(MEET_URL_RE) || t.match(MEET_URL_LOOSE_RE);
  return m ? m[0] : null;
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

// The prompt for her self-introduction. attendees (names from the people panel, may be
// empty) lets her greet people she recognizes; the three MANDATORY constraints are spelled
// out, and warmth is explicitly invited within them.
function introPrompt({ userName, attendees } = {}) {
  const u = userName || 'Lucas';
  const who = (attendees && attendees.length)
    ? `People already here: ${attendees.slice(0, 8).join(', ')}. Feel free to greet anyone you recognize warmly, by name.`
    : `You don't have the attendee list yet — open with a general, friendly hello.`;
  return `You're joining a Google Meet on ${u}'s behalf. Write a SHORT message to post in the MEETING CHAT, introducing yourself. It MUST: (1) make clear you are an AI, here on ${u}'s behalf; (2) say briefly why you're here — to follow along and take notes / help; (3) be 1–2 sentences. Within that, be warm and human — a friendly hello is welcome. ${who}\n\nOutput ONLY the message text — no quotes, no tags, no "Subject:".`;
}

// Validate a generated intro against the MANDATORY constraints. Returns { ok, reasons }.
function validateIntro(text) {
  const t = String(text || '').trim();
  const reasons = [];
  if (t.length < 8) reasons.push('empty/too short');
  if (!DISCLOSURE_RE.test(t)) reasons.push('no AI disclosure');
  if (t.length > 400) reasons.push('too long');
  return { ok: reasons.length === 0, reasons };
}

// Guarantee the disclosure (the non-negotiable part) even if a friendly generation
// dropped it: prepend a brief disclosure clause, keeping her wording after it.
function ensureDisclosure(text, userName) {
  const t = String(text || '').trim();
  if (DISCLOSURE_RE.test(t)) return t.slice(0, 400);
  const u = userName || 'Lucas';
  const clause = `Hi all — I'm Zoe, ${u}'s AI assistant, here to follow along and take notes.`;
  return (t ? `${clause} ${t}` : clause).slice(0, 400);
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
  db.setMeta('gmeet_caption_seen', '0');
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
    postChat: livePostChat
  };
}

// --- live DOM bits (provisional; verify on a real meeting) ---
async function liveScrapeAttendees(web) {
  try { const r = await web.read(); return (r && r.ok && r.text) ? r.text : ''; } catch { return ''; }
}
async function liveScrapeCaptions(web) {
  try { const r = await web.read(); return (r && r.ok && r.text) ? r.text : ''; } catch { return ''; }
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
  return ensureDisclosure(cleaned, ctx.userName);   // disclosure guaranteed regardless of model output
}

// --- orchestrator: advance ONE stage per tick ---
// ctx: { userName, deps?, onReading(content,label), onSurface(text) }
async function runTick(ctx = {}) {
  const d = ctx.deps || defaultDeps();
  const surface = (content, label) => { try { ctx.onReading && ctx.onReading(content, label); } catch {} };
  const stage = get();

  if (stage === 'joining') {
    const r = await d.web.runRecipe('gmeet_join', { url: url() }, { expectLogin: true });
    if (r && r.blocker && r.blocker.needsHuman) {
      try { ctx.onSurface && ctx.onSurface(`I'm trying to join the meeting but Google wants me signed in (${r.blocker.type}). ${ctx.userName || 'Lucas'}, can you log me into my Google account? I'll join as soon as it's clear.`); } catch {}
      return { stage, ok: false, note: `join blocked (${r.blocker.type}) — asked ${ctx.userName || 'Lucas'} to sign in`, blocker: r.blocker.type };
    }
    if (r && r.ok) { _clear(); set('intro'); surface(`I joined the meeting (muted).`, '(gmeet) joined'); return { stage, ok: true, note: 'joined → intro' }; }
    // HEAL SIGNAL: the join recipe's provisional selectors didn't match the live Meet DOM.
    // Dump the real pre-join interactive elements so the selectors can be corrected.
    try {
      const rd = await d.web.read();
      if (rd && rd.ok && rd.text) {
        const ie = rd.text.includes('Interactive elements:') ? rd.text.split('Interactive elements:')[1] : rd.text;
        console.log('[gmeet] PRE-JOIN DOM (heal signal) ↓\n' + (ie || '').slice(0, 1800));
      }
    } catch {}
    const g = _strike();
    return { stage, ok: false, note: `join failed: ${r && r.reason}${g ? ' (gave up)' : ''}` };
  }

  if (stage === 'intro') {
    let attendees = [];
    try { attendees = parseAttendees(await d.scrapeAttendees(d.web)); } catch {}
    const intro = await generateIntro(d, ctx, attendees);
    const v = validateIntro(intro);   // guaranteed ok after ensureDisclosure, but log if not
    if (!v.ok) console.warn('[gmeet] intro still failed validation:', v.reasons.join(', '));
    const post = await d.postChat(d.web, intro);
    if (post && post.ok) {
      _clear(); set('observing');
      surface(`I introduced myself in the meeting chat: "${intro}"`, '(gmeet) introduced');
      return { stage, ok: true, note: 'posted intro → observing', intro };
    }
    const g = _strike();
    return { stage, ok: false, note: `intro post failed: ${post && post.reason}${g ? ' (gave up)' : ''}` };
  }

  if (stage === 'observing') {
    const caps = parseCaptions(await d.scrapeCaptions(d.web));
    const seen = parseInt(db.getMeta('gmeet_caption_seen') || '0', 10);
    const fresh = caps.slice(seen);
    if (fresh.length) {
      db.setMeta('gmeet_caption_seen', String(caps.length));
      const block = fresh.map(c => `${c.speaker}: ${c.text}`).join('\n');
      surface(`Meeting captions:\n${block}`, `(gmeet) ${fresh.length} new caption(s)`);
      return { stage, ok: true, note: `observed ${fresh.length} new caption(s)` };
    }
    return { stage, ok: true, note: 'observing (no new captions)' };
  }

  if (stage === 'done') { reset(); return { stage: 'done', ok: true, note: 'meeting ended' }; }
  return { stage: 'none', ok: false, note: 'no active meeting' };
}

module.exports = {
  STAGES, get, set, active, start, reset, url, runTick, defaultDeps,
  // pure helpers (tested)
  detectMeetUrl, meetLinkFromEvent, introPrompt, validateIntro, ensureDisclosure, parseCaptions, parseAttendees,
  MEET_URL_RE
};
