/**
 * Media closed-captions — Slice 1 of MEDIA_CC_ARCHITECTURE.md. Generalizes the Google
 * Meet caption-follow (lib/gmeet.js) to ANY video that carries captions: open it in HER
 * OWN browser (lib/web.js), turn captions on, and surface the live caption lines into her
 * perception exactly as she follows a meeting. YouTube is the first real-world target.
 *
 * Built like gmeet.js / play_session.js: the app holds a stage machine and advances ONE
 * stage per idle tick (monologue.js drives it); pure helpers are unit-tested offline
 * (scripts/smoke_media_cc.js) and the live DOM bits verify on a real video.
 *
 *   opening   → navigate her browser to the media URL.
 *   enabling  → turn captions on (YouTube: subtitles button / 'c'; generic: textTrack mode).
 *   watching  → read captions via the CASCADE, dedupe, surface new lines as readings; loops.
 *   done      → playback ended / navigated away → cleanup.
 *
 * The CAPTURE CASCADE (the design's core — not one scraper): each tick we try
 *   ① TextTrack  — read video.textTracks[].activeCues (cleanest; exact cues; CSS-churn-proof)
 *   ② DOM overlay — scrape the player's caption container (the gmeet clone+strip trick,
 *                   generalized via a tiny per-site config) for players that paint their
 *                   own captions and leave textTracks empty (YouTube, Netflix, …).
 * The first source that yields lines wins this tick; `via` records which. (③ network-track
 * + ④ ASR-loopback are later slices — see the design doc.)
 *
 * DRM boundary (mirrors gmeet's "never touch Lucas's shared browser" rule): we only ever
 * read captions the player ALREADY rendered. Nothing here decrypts protected video.
 */

const db = require('./db');
const ft = require('./fallthrough');   // A1: the shared fall-through floor (descend/withFallthrough)

const STAGES = ['none', 'opening', 'enabling', 'watching', 'done'];
const MAX_STAGE_STRIKES = 3;
const FOLLOW_EVERY_LINES = 4;     // synthesize a running understanding after this many new caption lines
const FOLLOW_MAX_WAIT_MS = 25000; // ...or after this long with ANY pending lines, so a sparse/slow video still gets understood
// A1 FALL-THROUGH FLOOR: after this many consecutive PLAYING ticks with NO fresh captions AND none ever
// seen (media_lines==0 — the true "captions never worked" case, distinct from a mid-video silence), descend
// to the transcribe floor and END honestly. Closes the census G3 leak (a caption-less video watched forever).
const CAPTION_DROUGHT_TICKS = 5;

// Captions she's already surfaced this session (exact normalized text), so the caption
// window re-rendering the same phrase isn't re-reported each watch tick. Reset on start().
// In-memory: captions are ephemeral.
let _seen = new Set();

// --- WATCHED REGISTRY (durable) — so she doesn't autonomously RE-WATCH the same video (the "5th time on
// the Condoleezza Rice interview" loop) and each watch leaves a real artifact. Keyed by video id/url. ---
const WATCHED_KEY = 'media.watched';
const WATCH_DEDUP_MS = 3 * 24 * 60 * 60 * 1000;   // don't autonomously re-watch within 3 days
function _watchedList() { try { const a = JSON.parse(db.getMeta(WATCHED_KEY) || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } }
function _saveWatched(list) { try { db.setMeta(WATCHED_KEY, JSON.stringify(list.slice(-40))); } catch {} }
function recordWatched(mediaUrl, topic = '', nowMs = Date.now()) {
  const u = String(mediaUrl || '').trim(); if (!u) return;
  const id = mediaId(u) || u;
  const list = _watchedList().filter(w => w.id !== id);
  list.push({ id, url: u, topic: String(topic || '').trim(), ts: nowMs, recap: '' });
  _saveWatched(list);
}
function markRecap(mediaUrl, recap) {
  const id = mediaId(String(mediaUrl || '')) || String(mediaUrl || '');
  const list = _watchedList(); const w = list.find(x => x.id === id);
  if (w) { w.recap = String(recap || '').slice(0, 600); _saveWatched(list); }
}
// Has she watched this (by url/id OR fuzzy topic) within `withinMs`? Gates the AUTONOMOUS re-watch — a
// user-initiated "watch this again" still goes straight through start().
function wasWatchedRecently(query, { withinMs = WATCH_DEDUP_MS, nowMs = Date.now() } = {}) {
  const q = String(query || '').trim().toLowerCase(); if (!q) return false;
  const id = mediaId(query) || null;
  for (const w of _watchedList()) {
    if ((nowMs - (w.ts || 0)) > withinMs) continue;
    if (id && w.id === id) return true;
    if (w.url && q.includes(String(w.url).toLowerCase())) return true;
    const wt = String(w.topic || '').toLowerCase();
    if (wt && (wt === q || wt.includes(q) || q.includes(wt))) return true;
  }
  return false;
}

// --- pure helpers (unit-tested) ---

// A YouTube watch/live URL (the slice-1 target). Scheme OPTIONAL (Lucas often pastes a bare
// "youtu.be/..."), normalized to absolute. youtu.be short links + youtube.com/watch?v= +
// youtube.com/live/ + m.youtube.com all match.
const YT_URL_RE = /(?:https?:\/\/)?(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?[^\s"'<>]*\bv=[\w-]{6,}|live\/[\w-]{6,}|embed\/[\w-]{6,})|youtu\.be\/[\w-]{6,})(?:[?&#][^\s"'<>]*)?/i;
// Any other http(s) URL (so "watch this <url>" works beyond YouTube too).
const ANY_URL_RE = /https?:\/\/[^\s"'<>]+/i;

function detectMediaUrl(text) {
  const t = String(text || '');
  let m = t.match(YT_URL_RE);
  if (m) { let u = m[0]; if (!/^https?:\/\//i.test(u)) u = 'https://' + u.replace(/^\/\//, ''); return u; }
  m = t.match(ANY_URL_RE);
  return m ? m[0] : null;
}

// The YouTube video / live id, used to group transcript rows for one viewing. null if absent.
function mediaId(url) {
  const u = String(url || '');
  let m = u.match(/[?&]v=([\w-]{6,})/i) || u.match(/youtu\.be\/([\w-]{6,})/i)
       || u.match(/youtube\.com\/(?:live|embed)\/([\w-]{6,})/i);
  return m ? m[1] : null;
}

function hostOf(url) { try { return new URL(url).hostname.replace(/^www\./, '').replace(/^m\./, ''); } catch { return ''; } }

// Per-site config for the DOM-overlay source (②). captionSelectors are tried in order; the
// first that exists is scraped. YouTube paints captions into .ytp-caption-window-container
// (segments inside). Generic players expose an aria captions region. Extend per site as we go.
const SITE_CONFIGS = {
  'youtube.com': {
    kind: 'youtube',
    captionSelectors: ['.ytp-caption-window-container', '.captions-text', '[class*="caption"]'],
  },
  'youtu.be': { kind: 'youtube', captionSelectors: ['.ytp-caption-window-container', '.captions-text'] },
};
const GENERIC_CONFIG = {
  kind: 'generic',
  captionSelectors: ['[role="region"][aria-label*="caption" i]', '[aria-label*="subtitle" i]', '.vjs-text-track-display', 'track'],
};
function siteConfig(url) {
  const cfg = SITE_CONFIGS[hostOf(url)] || GENERIC_CONFIG;
  return { ...cfg, host: hostOf(url) };
}

// Normalize one caption blob into clean, bounded lines: collapse whitespace, drop markup,
// split on newlines, drop empties and over-long junk. Used on both source outputs so dedupe
// compares apples to apples.
function parseCaptionBlock(raw) {
  const out = [];
  for (const line of String(raw || '').split('\n')) {
    const t = line.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!t || t.length > 280) continue;
    out.push(t);
  }
  return out;
}

// Dedupe parsed caption lines against a seen-set; returns only the genuinely-new ones and
// mutates the set. Exact-match (same robustness bet as gmeet: the seconds-apart watch tick
// catches a settled caption window, not every sub-second partial). Pure; tested.
function freshFrom(seenSet, lines) {
  const fresh = [];
  for (const t of lines) {
    if (!t || seenSet.has(t)) continue;
    seenSet.add(t);
    fresh.push(t);
  }
  return fresh;
}

// --- search-and-watch (no direct link): "pull up clips of X on youtube" -----------------------
// She can't browse-search on her own, so a "find clips of X and watch" request used to be either
// declined or (worse) confabulated. This searches the web for a YouTube watch URL and hands it to
// start(), so the natural request actually works.
const SW_ACTION_RE = /\b(watch|play|put\s*on|stream|pull\s*up|look\s*up|search(?:\s*for)?|find|show\s*me)\b/i;
const SW_MEDIA_RE = /\b(youtube|clip|clips|video|videos|episode|episodes|scene|scenes|trailer|footage)\b/i;

// Returns a cleaned search subject if the message is a search-and-watch ask (verb + media cue, and
// NO direct URL — a pasted link goes through the normal watch path). null otherwise.
function detectSearchWatch(text) {
  const t = String(text || '');
  if (detectMediaUrl(t)) return null;
  if (!SW_ACTION_RE.test(t) || !SW_MEDIA_RE.test(t)) return null;
  let q = t
    .replace(/\b(hey|ok|okay|so|well)\b[ ,]*/ig, '')
    .replace(/\b(you can|can you|could you|would you|will you|please|i want you to|i'?d like you to)\b/ig, ' ')
    .replace(SW_ACTION_RE, ' ')
    .replace(/\b(on|over on|from)?\s*youtube\b/ig, ' ')
    .replace(/\bif you (turn|enable|put)[^.?!]*/ig, ' ')
    .replace(/\b(turn|switch|put)\s*(the\s*)?cc\s*(on)?\b/ig, ' ')
    .replace(/\bwith (cc|captions|subtitles)\b/ig, ' ')
    .replace(/\bcaptions?\b/ig, ' ')
    .replace(/\bwhen you do (it|that)\b/ig, ' ')
    .replace(/\bfor me\b/ig, ' ')
    .replace(/[?.!]+\s*$/,'')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return q.length >= 2 ? q : null;
}

// Pure: first real YouTube watch/clip URL among search results ({url,...}[]). null if none.
function pickYouTubeUrl(results) {
  if (!Array.isArray(results)) return null;
  for (const r of results) {
    const u = (r && r.url) || '';
    if (YT_URL_RE.test(u) && /watch\?|youtu\.be\/|\/live\/|\/embed\//i.test(u)) return detectMediaUrl(u);
  }
  return null;
}

// Search for a YouTube clip matching `query` and start watching it. deps.search (web_search.search)
// + deps.start injectable for offline tests. Returns { ok, url, query } or { ok:false, reason }.
async function findAndStart({ query, deps = {} } = {}) {
  if (!query) return { ok: false, reason: 'no-query' };
  const search = deps.search;
  if (typeof search !== 'function') return { ok: false, reason: 'no-search' };
  // web_search.search returns { query, results:[...] }; tests may inject a bare array. Normalize both.
  const run = async (qq) => {
    try { const res = await search(qq); return Array.isArray(res) ? res : ((res && res.results) || []); }
    catch { return []; }
  };
  let url = pickYouTubeUrl(await run(query + ' site:youtube.com'));
  if (!url) url = pickYouTubeUrl(await run(query + ' youtube'));
  if (!url) return { ok: false, reason: 'no-result' };
  const ok = (deps.start || start)(url, { topic: query });
  return ok ? { ok: true, url, query } : { ok: false, reason: 'start-failed' };
}

// "what are you watching / what's on / what are you seeing" — a question about the VIDEO. Dans tends
// to read the leading "what are you…" as an identity prompt and recite her self-narrative instead.
// Used (when a watch is active) to inject a directive forcing the answer onto the actual captions.
function detectWatchingQuestion(msg) {
  const s = String(msg || '');
  return /what[^?]*\b(watching|seeing|viewing)\b/i.test(s) || /what'?s\s+(on|playing)\b/i.test(s);
}

// --- meta-backed stage state ---
function get() { return db.getMeta('media_stage') || 'none'; }
function set(s) { if (STAGES.includes(s)) db.setMeta('media_stage', s); }
function active() { const s = get(); return s !== 'none' && s !== 'done'; }
function url() { return db.getMeta('media_url') || ''; }

function start(mediaUrl, { topic = '' } = {}) {
  const u = detectMediaUrl(mediaUrl) || String(mediaUrl || '').trim();
  if (!u) return false;
  db.setMeta('media_url', u);
  db.setMeta('media_topic', String(topic || ''));
  try { recordWatched(u, topic); } catch {}   // remember she started this — dedups a re-pick even before the recap lands
  db.setMeta('media_strikes', '0');
  db.setMeta('media_left_ticks', '0');
  db.setMeta('media_dry_ticks', '0');   // A1: caption-drought counter (consecutive playing-but-no-fresh ticks)
  db.setMeta('media_started_at', String(Date.now()));
  db.setMeta('media_ended_at', '0');
  db.setMeta('media_via', '');
  db.setMeta('media_lines', '0');
  db.setMeta('media_recent', '');
  db.setMeta('media_pending', ''); db.setMeta('media_pending_lines', '0'); db.setMeta('media_pending_since', '');
  db.setMeta('media_understanding', ''); db.setMeta('media_understanding_log', ''); db.setMeta('media_last_recap', '');
  _seen = new Set();
  set('opening');
  return true;
}
function reset() { set('none'); db.setMeta('media_strikes', '0'); }

function _strike() {
  const n = parseInt(db.getMeta('media_strikes') || '0', 10) + 1;
  db.setMeta('media_strikes', String(n));
  if (n >= MAX_STAGE_STRIKES) { reset(); return true; }
  return false;
}
function _clear() { db.setMeta('media_strikes', '0'); }

// --- live DOM bits (verify on a real video) ---

// Open the media URL in her own browser. Reuses web.open (navigate + blocker detection).
async function liveOpenMedia(web, mediaUrl) {
  try { return await web.open(mediaUrl); } catch (e) { return { ok: false, reason: e.message }; }
}

// Turn captions on. YouTube: the subtitles button (aria-pressed) is the reliable toggle, with
// 'c' (player focused) as fallback. Generic: set every captions/subtitles textTrack to
// 'showing' so cues both paint AND populate activeCues for source ①. Best-effort like gmeet —
// the watch loop is the source of truth, so we proceed even if unconfirmed.
async function liveEnableCaptions(web, cfg) {
  try {
    const page = await web.ensure();
    if (cfg.kind === 'youtube') {
      const btn = page.locator('.ytp-subtitles-button').first();
      if (await btn.count().catch(() => 0)) {
        const pressed = await btn.getAttribute('aria-pressed').catch(() => null);
        if (pressed === 'true') return { ok: true, already: true };
        await btn.click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(400).catch(() => {});
        const now = await btn.getAttribute('aria-pressed').catch(() => null);
        if (now === 'true') return { ok: true, via: 'button' };
      }
      try { await page.locator('video').first().click({ timeout: 2000 }); } catch {}
      try { await page.keyboard.press('c'); } catch {}
      return { ok: true, via: 'shortcut-unverified' };
    }
    const n = await page.evaluate(() => {
      let c = 0;
      for (const v of document.querySelectorAll('video')) {
        for (const tt of (v.textTracks || [])) {
          if (tt.kind && !/captions|subtitles/i.test(tt.kind)) continue;
          try { tt.mode = 'showing'; c++; } catch {}
        }
      }
      return c;
    }).catch(() => 0);
    return { ok: n > 0, via: n > 0 ? 'texttrack' : 'none' };
  } catch (e) { return { ok: false, reason: e.message }; }
}

// THE CASCADE: ① textTracks.activeCues, then ② DOM overlay. Returns { text, via }. text is a
// normalized newline-joined blob (one caption per line); the orchestrator dedupes it.
async function liveReadCaptions(web, cfg) {
  try {
    const page = await web.ensure();
    // ① TextTrack — discrete cues, exact, CSS-churn-proof.
    const cues = await page.evaluate(() => {
      const out = [];
      for (const v of document.querySelectorAll('video')) {
        for (const track of (v.textTracks || [])) {
          if (track.kind && !/captions|subtitles/i.test(track.kind)) continue;
          for (const c of (track.activeCues || [])) {
            const t = (c.text || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
            if (t) out.push(t);
          }
        }
      }
      return out;
    }).catch(() => []);
    if (cues && cues.length) return { text: cues.join('\n'), via: 'texttrack' };
    // ② DOM overlay — the gmeet clone+strip trick, generalized: find the first configured
    // caption container, read its text (avatars/buttons stripped), normalized.
    const dom = await page.evaluate((selectors) => {
      let el = null;
      for (const s of selectors) { el = document.querySelector(s); if (el) break; }
      if (!el) return '';
      const clone = el.cloneNode(true);
      try { clone.querySelectorAll('img, button, [data-iml]').forEach(e => e.remove()); } catch {}
      return (clone.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 280);
    }, cfg.captionSelectors).catch(() => '');
    return { text: dom || '', via: dom ? 'dom' : 'none' };
  } catch { return { text: '', via: 'error' }; }
}

// Is a video still loaded and not ended? (Playback-ended / navigated-away detection — without
// it, watching never exits and monopolizes the idle loop, the freeze gmeet's leave-detection
// fixed.) False if no <video> on the page or it has ended.
async function liveIsPlaying(web) {
  try {
    const page = await web.ensure();
    return await page.evaluate(() => {
      const v = document.querySelector('video');
      return !!v && !v.ended;
    }).catch(() => false);
  } catch { return false; }
}

// A1 FALL-THROUGH FLOOR — the transcribe rung. When live captions never come through, secure the content
// out-of-band: fire the engine's background transcript job (av download + whisper + diarize) on the media
// URL, fire-and-forget. Mirrors main.js's speech path (enqueue_transcript). Returns { ok, session_id? };
// fail-soft (engine offline / error → { ok:false }). Dep-injected via defaultDeps so the offline gate needs
// no engine, and the watch loop treats it as a fallthrough reader through lib/fallthrough.
async function liveEnqueueTranscript(mediaUrl) {
  try {
    const u = String(mediaUrl || '').trim();
    if (!u) return { ok: false, reason: 'no-url' };
    const echoSuit = require('./echo_suit');
    if (!echoSuit || !echoSuit.connected) return { ok: false, reason: 'engine-offline' };
    const r = await echoSuit.dispatch({ kind: 'do', name: 'enqueue_transcript', args: { url: u, name: `Video — ${hostOf(u) || 'watched'}`.slice(0, 120) } });
    let rr = null; try { rr = JSON.parse(r && r.text); } catch { rr = r; }
    return (rr && rr.ok) ? { ok: true, session_id: rr.session_id } : { ok: false, reason: (rr && rr.error) || 'enqueue-failed' };
  } catch (e) { return { ok: false, reason: e.message }; }
}

function defaultDeps() {
  return {
    web: require('./web'),
    openMedia: liveOpenMedia,
    enableCaptions: liveEnableCaptions,
    readCaptions: liveReadCaptions,
    isPlaying: liveIsPlaying,
    transcribe: liveEnqueueTranscript,   // A1: the transcribe floor (enqueue_transcript), injectable for the gate
    streamChat: require('./ollama').streamChat,
    MODEL: require('./config').extractionModel(),
    // storeMeeting(content, opts) → persist the end-of-video recap as durable, retrievable
    // knowledge, so "what was that video about?" recalls it later instead of it ageing out.
    storeMeeting: async (content, opts = {}) => { try { return await require('./memory').store({ kind: opts.kind || 'episodic', content, source: opts.source || 'media_watch', importance: opts.importance == null ? 0.7 : opts.importance }); } catch { return null; } },
  };
}

// FOLLOW ALONG: turn the recent captions into a 1–2 sentence running understanding, so she
// actually REGISTERS what she's watching (forms comprehension) instead of just logging lines.
// ONE model tick, throttled by the caller. Returns '' on failure. (No ACTION machinery — unlike
// a meeting, watching is passive; she's the viewer following along, not a participant.)
async function modelWatchUnderstanding(d, ctx, transcript) {
  const t = String(transcript || '').trim();
  if (!t) return '';
  let out = '';
  try {
    await d.streamChat({
      model: d.MODEL,
      messages: [{ role: 'user', content: `You're watching a video and following its captions as it plays. Recent captions:\n${t.slice(-2500)}\n\nIn 1–2 sentences, say what's happening and what it's about so far — as the viewer following along, not a transcriber. No preamble.` }],
      options: { temperature: 0.5, top_p: 0.9, num_ctx: 8192, num_predict: 160 },
      onToken: (tok) => { out += tok; }
    });
  } catch { return ''; }
  return out.replace(/<[^>]+>/g, '').trim().slice(0, 500);
}

// END-OF-VIDEO recap: she followed the whole thing live, but the captions + running
// understandings are TRANSIENT and age out — so without this she "watched" something and kept
// nothing. Turn the accumulated understandings into ONE durable recap, stored as retrievable
// episodic memory. ONE model tick. Returns '' when nothing substantive was captured.
async function modelWatchRecap(d, ctx, notes) {
  let out = '';
  try {
    await d.streamChat({
      model: d.MODEL,
      messages: [{ role: 'user', content: `You just watched a video and followed it via captions. Here are your running notes, oldest first:\n\n${String(notes).slice(-5000)}\n\nWrite a tight 2–4 sentence recap of what the video was about and the key things in it, in your own voice — so you remember having watched it. Be specific. No preamble, no "the notes say".` }],
      options: { temperature: 0.4, top_p: 0.9, num_ctx: 8192, num_predict: 300 },
      onToken: (t) => { out += t; }
    });
  } catch { return ''; }
  return out.replace(/<[^>]+>/g, '').trim().slice(0, 1200);
}

// Build + store the durable end-of-video recap from the running-understanding log. Returns the
// recap text (or '' when nothing substantive was captured — e.g. captions never came through).
// Clears the log so a recap can't be double-stored.
async function synthesizeWatch(d, ctx) {
  const notes = (db.getMeta('media_understanding_log') || '').trim() || (db.getMeta('media_understanding') || '').trim();
  if (notes.length < 40) return '';
  const recap = await modelWatchRecap(d, ctx, notes);
  if (!recap) return '';
  // Self-contained episodic framing so the GENERAL recall pipeline surfaces it for "what was
  // that video about / the video you watched earlier" — she recognizes it as HER viewing.
  let episodic = recap;
  try {
    const startedAt = parseInt(db.getMeta('media_started_at') || '0', 10);
    const whenStr = startedAt ? new Date(startedAt).toLocaleString() : 'recently';
    const where = (db.getMeta('media_url') || '').trim();
    episodic = `I watched a video (${whenStr})${where ? ` — ${where}` : ''} and followed it live via captions. What it was about: ${recap}`;
  } catch {}
  try { if (d.storeMeeting) await d.storeMeeting(episodic, { kind: 'episodic', source: 'media_watch', importance: 0.7 }); } catch {}
  db.setMeta('media_last_recap', recap);
  db.setMeta('media_understanding_log', '');
  // ACCRETE — land a durable DOCUMENT (short-term store → nightly promotion to Echo) so the viewing leaves
  // a real artifact (not just an ephemeral episodic note) AND records the recap in the watched-registry so
  // it's never re-watched. Idempotent on the video id (ref).
  try {
    const u = (db.getMeta('media_url') || '').trim();
    const topic = (db.getMeta('media_topic') || '').trim();
    const id = mediaId(u) || u;
    markRecap(u, recap);
    const captionsTail = (db.getMeta('media_recent') || '').trim();
    require('./doc_store').land({
      title: `Video — ${topic || hostOf(u) || 'watched'}`.slice(0, 120),
      body: `# Watched: ${topic || u}\n\n**Source:** ${u}\n\n## Recap\n${recap}${captionsTail ? `\n\n## Captions (tail)\n${captionsTail}` : ''}`,
      source: 'media_watch', ref: `media:${id}`, understanding: recap, origin: u,
    });
  } catch (e) { console.error('[media_cc] doc land failed:', e.message); }
  return recap;
}

// --- orchestrator: advance ONE stage per tick ---
// ctx: { deps?, onReading(content,label), onSurface(text) }
async function runTick(ctx = {}) {
  const d = ctx.deps || defaultDeps();
  const surface = (content, label) => { try { ctx.onReading && ctx.onReading(content, label); } catch {} };
  const cfg = siteConfig(url());
  const stage = get();

  if (stage === 'opening') {
    const r = await d.openMedia(d.web, url());
    if (r && r.blocker && r.blocker.needsHuman && r.blocker.type === 'login') {
      try { ctx.onSurface && ctx.onSurface(`I want to watch that, but the site wants me signed in. Could you log me in once in my browser? It'll stick after that.`); } catch {}
      return { stage, ok: false, note: 'open blocked (login) — asked to sign in', blocker: 'login' };
    }
    if (r && r.ok) { _clear(); set('enabling'); surface(`I opened the video to watch along.`, '(media) opened'); return { stage, ok: true, note: 'opened → enabling' }; }
    const g = _strike();
    if (g) { try { ctx.onSurface && ctx.onSurface(`I couldn't open that video (${(r && r.reason) || 'navigation failed'}).`); } catch {} }
    return { stage, ok: false, note: `open failed: ${r && r.reason}${g ? ' (gave up)' : ''}` };
  }

  if (stage === 'enabling') {
    const cc = await d.enableCaptions(d.web, cfg);
    if (!(cc && cc.ok)) console.log('[media_cc] enable-captions unconfirmed:', cc && (cc.reason || cc.via));
    _clear();
    set('watching');
    db.setMeta('media_via', (cc && cc.via) || '');
    surface(`I turned captions on — following along now.`, '(media) captions on');
    return { stage, ok: true, note: `captions ${cc && cc.ok ? 'on' : 'unconfirmed'} → watching` };
  }

  if (stage === 'watching') {
    // PLAYBACK-ENDED / NAVIGATED-AWAY: end after 2 consecutive misses so watching can't
    // monopolize the idle loop forever (gmeet's leave-detection discipline).
    if (!(await d.isPlaying(d.web))) {
      const n = parseInt(db.getMeta('media_left_ticks') || '0', 10) + 1;
      db.setMeta('media_left_ticks', String(n));
      if (n >= 2) {
        db.setMeta('media_left_ticks', '0');
        const recap = await synthesizeWatch(d, ctx).catch(() => '');
        set('done');
        db.setMeta('media_ended_at', String(Date.now()));   // arms post-watch recall in context.js
        surface(`The video finished — I'm back to my own time.`, '(media) playback ended');
        if (recap) surface(`Here's what I took from the video — ${recap}`, '(media) video recap');
        return { stage, ok: true, note: `playback ended → done${recap ? ' + recap' : ''}` };
      }
      return { stage, ok: true, note: `no video (${n}/2) — will end if it persists` };
    }
    db.setMeta('media_left_ticks', '0');

    const { text, via } = await d.readCaptions(d.web, cfg);
    const fresh = freshFrom(_seen, parseCaptionBlock(text));
    if (_seen.size > 600) _seen = new Set(Array.from(_seen).slice(-300));
    if (fresh.length) {
      db.setMeta('media_dry_ticks', '0');   // A1: captions are flowing → reset the drought counter
      db.setMeta('media_via', via || db.getMeta('media_via') || '');
      const block = fresh.join('\n');
      surface(`Video captions:\n${block}`, `(media) ${fresh.length} new caption(s)`);
      // Keep a bounded rolling tail of what she's heard, so her awareness line (context.js)
      // can answer "what are you watching?" from the actual captions — the self-model that
      // makes this feel like SHE is watching, not a background log.
      try { db.setMeta('media_recent', ((db.getMeta('media_recent') || '') + ' ' + block).replace(/\s+/g, ' ').trim().slice(-500)); } catch {}
      // Persist each line to the durable, timestamped transcript (grouped by video id), so the
      // viewing leaves a queryable record — the Transcript-Studio wire (slice 5) rides this.
      try {
        const code = mediaId(url());
        const tNow = d.now ? d.now() : Date.now();
        for (const line of fresh) db.insertTranscriptLine({ meeting: code ? `media:${code}` : 'media', speaker: null, text: line, ts: tNow });
      } catch (e) { console.error('[media_cc] transcript persist failed:', e.message); }
      db.setMeta('media_lines', String(parseInt(db.getMeta('media_lines') || '0', 10) + fresh.length));
      // Accumulate into the pending-synthesis buffer (capped) for the follow-along tick below.
      const prevPend = db.getMeta('media_pending') || '';
      db.setMeta('media_pending', ((prevPend ? prevPend + '\n' : '') + block).slice(-4000));
      db.setMeta('media_pending_lines', String(parseInt(db.getMeta('media_pending_lines') || '0', 10) + fresh.length));
      if (!db.getMeta('media_pending_since')) db.setMeta('media_pending_since', String(d.now ? d.now() : Date.now()));
    } else {
      // A1 FALL-THROUGH FLOOR + G3 LEAK FIX: a PLAYING video whose captions NEVER come through (textTracks +
      // DOM overlay both empty) used to keep 'watching' FOREVER — isPlaying stays true, no fresh lines, no
      // understanding, and the lane never tried a transcript nor terminated (census G3). Count the drought;
      // once it persists AND no caption ever landed (media_lines==0 — so a mid-video silence never trips it),
      // DESCEND to the transcribe floor (the shared fallthrough organ) and END HONESTLY whether or not it
      // secures the content. Never watch nothing indefinitely; never invent a recap.
      const dry = parseInt(db.getMeta('media_dry_ticks') || '0', 10) + 1;
      db.setMeta('media_dry_ticks', String(dry));
      const everSaw = parseInt(db.getMeta('media_lines') || '0', 10) > 0;
      if (dry >= CAPTION_DROUGHT_TICKS && !everSaw) {
        db.setMeta('media_dry_ticks', '0');
        const floor = await ft.descend(
          [async () => { const t = d.transcribe ? await d.transcribe(url()) : null; return (t && t.ok) ? { enqueued: true, session_id: t.session_id } : null; }],
          { label: 'captions', ok: (r) => !!(r && r.enqueued), log: (msg) => console.log('[media_cc] ' + msg) }
        );
        const recap = await synthesizeWatch(d, ctx).catch(() => '');   // '' when nothing was captured — never invents
        set('done');
        db.setMeta('media_ended_at', String(Date.now()));
        if (floor.ok) {
          try { ctx.onSurface && ctx.onSurface(`I couldn't read captions on that video, so I've queued a full transcript in the background — I'll have it shortly.`); } catch {}
          if (recap) surface(`Here's what I took from the video — ${recap}`, '(media) video recap');
          return { stage, ok: true, note: 'caption drought → transcript floor enqueued → done' };
        }
        try { ctx.onSurface && ctx.onSurface(`I couldn't get captions or a transcript for that one, so I've stopped watching it.`); } catch {}
        return { stage, ok: true, note: 'caption drought → no transcript floor → honest end' };
      }
    }

    // FOLLOW ALONG: synthesize what she's watching in ONE model tick — so she REGISTERS the
    // video (forms comprehension) instead of just logging captions. Fires on EITHER enough new
    // lines (dense video) OR a max wait with any pending lines (sparse/slow video — otherwise a
    // trickle would never reach the count and understanding would never form). Runs each tick.
    const pendLines = parseInt(db.getMeta('media_pending_lines') || '0', 10);
    const pendSince = parseInt(db.getMeta('media_pending_since') || '0', 10);
    const nowMs = d.now ? d.now() : Date.now();
    const stale = pendLines >= 1 && pendSince > 0 && (nowMs - pendSince) >= FOLLOW_MAX_WAIT_MS;
    if (pendLines >= FOLLOW_EVERY_LINES || stale) {
      const transcript = db.getMeta('media_pending') || '';
      db.setMeta('media_pending', ''); db.setMeta('media_pending_lines', '0'); db.setMeta('media_pending_since', '');
      const understanding = await modelWatchUnderstanding(d, ctx, transcript);
      if (understanding) {
        db.setMeta('media_understanding', understanding);   // latest running understanding (for her awareness / recall)
        const log = db.getMeta('media_understanding_log') || '';
        db.setMeta('media_understanding_log', ((log ? log + '\n' : '') + understanding).slice(-6000));
        surface(`I'm following the video — ${understanding}`, '(media) following along');
        return { stage, ok: true, note: `understanding (${pendLines}ln${stale ? ',stale' : ''})` };
      }
    }
    return { stage, ok: true, note: fresh.length ? `${fresh.length} new caption(s) via ${via}` : `watching (no new captions${via && via !== 'none' ? `, ${via}` : ''})`, via };
  }

  if (stage === 'done') { reset(); return { stage: 'done', ok: true, note: 'viewing ended' }; }
  return { stage: 'none', ok: false, note: 'no active viewing' };
}

module.exports = {
  STAGES, CAPTION_DROUGHT_TICKS, get, set, active, start, reset, url, runTick, defaultDeps, synthesizeWatch, liveEnqueueTranscript,
  // watched registry (durable re-watch guard + artifact)
  recordWatched, markRecap, wasWatchedRecently,
  // pure helpers (tested)
  detectMediaUrl, mediaId, hostOf, siteConfig, parseCaptionBlock, freshFrom,
  detectSearchWatch, pickYouTubeUrl, findAndStart, detectWatchingQuestion,
  YT_URL_RE,
};
