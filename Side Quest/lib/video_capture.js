/**
 * lib/video_capture.js — the Data-Stream Lane VIDEO-CAPTION capture engine (Phase A completion).
 *
 * The 4 live Monitor video streams are broadcast news (TV-only stories the RSS wall never carries). This
 * lane reads their closed captions from hidden, always-on webContents (the PROVEN probe mechanism —
 * scripts/probe_video_cc.js, 4/4) and folds them into the SAME isolated reservoir as RSS, as
 * source_kind='video' SEGMENT items that cluster into stories like any other source.
 *
 * Segmentation via the caption stream itself: a bare non-speech cue on its own line ("[Music]") marks a
 * VISUAL-ONLY moment — a show start/stop sting, or a full-screen chart/graph (finance channels). At that
 * boundary we (1) grab a SCREENSHOT of the frame (webContents.capturePage) — the picture is the content
 * when there's no speech — and (2) FLUSH the buffered speech as one segment item. Talky stretches with no
 * cue flush on a size/time cap so nothing is lost.
 *
 * Split: the per-poll decision logic (processPoll) + all text shaping are PURE and unit-tested
 * (scripts/smoke_video_capture.js, isolated NEWS_DB_PATH). The Electron window lifecycle (CaptureLane)
 * is thin and dependency-injected so the loop is testable with a fake webContents.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const newsdb = require('./news_db');
// pure text cleaners (requiring news_lane does NOT open the DB — news_db.get() is lazy)
const { dedupeGrowingCaptions, stripAdLines } = require('./news_lane');
const { adHeuristic } = require('./news_ads');   // free hard-ad drop at capture; soft ads caught at compression

// --- pure text helpers -------------------------------------------------------
const clean = (s) => String(s == null ? '' : s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

// Normalize a caption blob → clean, bounded lines (mirrors media_cc.parseCaptionBlock / the probe).
function parseCaptionLines(raw) {
  const out = [];
  for (const line of String(raw || '').split('\n')) {
    const t = clean(line);
    if (!t || t.length > 280) continue;
    out.push(t);
  }
  return out;
}

// A caption that is ONLY a non-speech cue → the visual-only marker. Broadcast/YouTube render these as
// bracketed or parenthesized tokens ("[Music]", "(applause)") or a lone ♪ run. Returns the cue kind
// (lowercased word) or null. A cue mixed with real words is NOT a pure cue (there's speech to keep).
const CUE_WORDS = 'music|applause|cheering|cheers|laughter|laughs|silence|inaudible|crosstalk|ring|ringing|theme|fanfare|sting|chime|beeping|explosion|gunfire|sirens?';
const CUE_RE = new RegExp(`^[\\[(]\\s*(${CUE_WORDS})[\\])\\s]*$`, 'i');
function isNonSpeechCue(text) {
  const t = clean(text);
  if (!t) return null;
  if (/^[\s♪♫♩⤳~-]+$/.test(t) && /[♪♫♩]/.test(t)) return 'music';   // ♪ / ♫ only
  const m = t.match(CUE_RE);
  return m ? m[1].toLowerCase().replace(/s$/, '') : null;
}
// The caption read is a pure-cue MOMENT iff, after removing ALL non-speech cue tokens, nothing remains.
// This handles a single "[Music]" AND a repeated "[MUSIC] [MUSIC] [MUSIC]" run (persistent musical/visual
// segments render the cue every frame) — both fire a screenshot and neither pollutes the speech buffer.
const CUE_TOKEN_RE = new RegExp(`[\\[(]\\s*(?:${CUE_WORDS})[\\])\\s]*`, 'gi');
function stripCueTokens(text) {
  return String(text == null ? '' : text).replace(CUE_TOKEN_RE, ' ').replace(/[♪♫♩⤳~-]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function cueOf(lines) {
  const joined = (Array.isArray(lines) ? lines : [lines]).filter(Boolean).join(' ').trim();
  if (!joined) return null;
  if (stripCueTokens(joined)) return null;               // real speech remains → not a pure cue
  const m = joined.match(new RegExp(`[\\[(]\\s*(${CUE_WORDS})`, 'i'));
  return m ? m[1].toLowerCase().replace(/s$/, '') : 'music';   // pure cue (bracketed word run, or ♪-only)
}

// A segment headline from its caption text: first sentence (capped) else a leading slice. Broadcast
// captions carry proper nouns, so this gives the clusterer something with entities to work on.
function deriveTitle(text) {
  const t = clean(text);
  if (!t) return '(broadcast segment)';
  const sent = (t.match(/^.*?[.!?](?:\s|$)/) || [t])[0].trim();
  const base = (sent.length >= 20 && sent.length <= 140) ? sent : t.slice(0, 110);
  return base.replace(/[\s.,;:–-]+$/, '') || '(broadcast segment)';
}

const slug = (s) => String(s || 'feed').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'feed';
function feedKey(feed) { return slug((feed && (feed.title || feed.url)) || 'feed'); }
function captureFileName(feed, ts) { return `${feedKey(feed)}-${ts}.png`; }

// Build a reservoir insert shape (news_store.insertItem) from a buffered caption segment.
function buildSegmentItem(feed, lines, { firstTs, now }) {
  const settled = stripAdLines(dedupeGrowingCaptions(lines || []));   // collapse growing windows + drop CTA/ad lines
  const text = settled.join(' ').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  if (adHeuristic(text) === 'ad') return null;                       // drop OBVIOUS ads at capture (pharma/CTA/price) — free; soft ads go to the compression classifier
  return {
    source: (feed && feed.title) || (feed && feed.url) || 'broadcast',
    sourceKind: 'video',
    sourceUrl: (feed && feed.url) || null,
    title: deriveTitle(text),
    urlOrGuid: `video:${feedKey(feed)}:${firstTs || now}`,   // stable per-segment key (same-source dedup)
    ts: now,
    summary: text.slice(0, 2000),
  };
}

// --- the per-feed poll STATE MACHINE (pure, the tested heart) ----------------
// One read → decide: append fresh speech to the buffer, flush a segment (on cue-edge / size / time cap),
// and fire a screenshot on the cue EDGE (entering a visual-only moment — once per cue run, not every poll).
function newFeedState(feed) {
  return { feed, seen: new Set(), buffer: [], bufferChars: 0, firstTs: 0, inCue: false, lastShotTs: 0, lastContext: '' };
}
function resetBuffer(st) { st.buffer = []; st.bufferChars = 0; st.firstTs = 0; st.seen.clear(); }

// The vision-read prompt for a captured frame — tuned for the live-market case (Yahoo Finance charts +
// tickers during music stretches) but general enough for any on-screen text (news lower-thirds/chyrons).
const SCREEN_READ_PROMPT = 'This is a frame from a live TV/financial news stream. Read and report ONLY what is visibly on screen, concisely: index values and their change (e.g. S&P 500, Dow, Nasdaq), any ticker symbols with prices or percent changes, the state of any chart (up/down/flat, timeframe), and any headline or lower-third text. If nothing financial is shown, briefly say what is on screen. Do not guess at anything not clearly visible; if the frame is blank or an ad, say so.';

// A vision-read of a captured frame → a reservoir video item (so on-screen market data clusters + surfaces
// like any source). PURE.
function buildVisionItem(feed, visionText, now) {
  const text = clean(visionText);
  if (!text || text.length < 8) return null;
  return {
    source: (feed && feed.title) || (feed && feed.url) || 'broadcast',
    sourceKind: 'video',
    sourceUrl: (feed && feed.url) || null,
    title: deriveTitle(text),
    urlOrGuid: `video:screen:${feedKey(feed)}:${now}`,   // one per capture
    ts: now,
    summary: text.slice(0, 2000),
  };
}

// One caption read. In a cue/visual stretch (e.g. Yahoo Finance music+charts) fire a screenshot on ENTRY
// then every `sampleMs` while it persists (the chart changes) — closing on the next spoken word. In speech,
// buffer + flush on caps.
function processPoll(st, { captionText = '', now = Date.now() } = {}, { maxSegmentChars = 1200, maxSegmentMs = 180000, sampleMs = 30000 } = {}) {
  const actions = [];
  const lines = parseCaptionLines(captionText);
  const cue = cueOf(lines);
  if (cue) {
    const firstEntry = !st.inCue;
    st.inCue = true;
    if (firstEntry && st.buffer.length) {                  // the cue closes the running speech segment
      const item = buildSegmentItem(st.feed, st.buffer, { firstTs: st.firstTs, now });
      if (item) actions.push({ type: 'segment', item, reason: `cue:${cue}` });
      resetBuffer(st);
    }
    if (firstEntry || (now - (st.lastShotTs || 0) >= sampleMs)) {   // PERIODIC sampling of the visual/chart
      actions.push({ type: 'screenshot', cue, context: st.lastContext });
      st.lastShotTs = now;
    }
    return { actions, inCue: true, cue };
  }
  // speech (or empty) → "close on next spoken word": exit the visual stretch.
  st.inCue = false;
  st.lastShotTs = 0;
  const fresh = [];
  for (const t of lines) { if (t && !st.seen.has(t)) { st.seen.add(t); fresh.push(t); } }
  for (const f of fresh) { st.buffer.push(f); st.bufferChars += f.length + 1; if (!st.firstTs) st.firstTs = now; }
  if (fresh.length) st.lastContext = fresh.join(' ').slice(-200);
  const overSize = st.bufferChars >= maxSegmentChars;
  const overTime = st.firstTs && (now - st.firstTs) >= maxSegmentMs;
  if (st.buffer.length && (overSize || overTime)) {
    const item = buildSegmentItem(st.feed, st.buffer, { firstTs: st.firstTs, now });
    resetBuffer(st);
    if (item) actions.push({ type: 'segment', item, reason: overSize ? 'cap:size' : 'cap:time' });
  }
  return { actions, inCue: false, cue: null };
}

// --- screenshot store (news_captures, in the isolated bucket) ----------------
let _schemaReady = false;
function ensureSchema() {
  if (_schemaReady) return;
  newsdb.get().exec(`
    CREATE TABLE IF NOT EXISTS news_captures (
      id            INTEGER PRIMARY KEY,
      source        TEXT NOT NULL,
      source_url    TEXT,
      ts            INTEGER NOT NULL,
      cue           TEXT,                 -- the non-speech cue that triggered it ('music'…)
      image_path    TEXT NOT NULL,
      caption_context TEXT,               -- the last speech before the visual moment (what led in)
      description   TEXT,                 -- vision caption of the frame (filled later, optional)
      seen          INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_news_captures_ts ON news_captures(ts);
  `);
  _schemaReady = true;
}
function recordCapture({ source, sourceUrl = null, ts, cue = null, imagePath, context = null }) {
  ensureSchema();
  const info = newsdb.get().prepare(
    'INSERT INTO news_captures (source, source_url, ts, cue, image_path, caption_context, seen) VALUES (?, ?, ?, ?, ?, ?, 0)'
  ).run(String(source || 'broadcast'), sourceUrl, ts, cue, String(imagePath), context);
  return info.lastInsertRowid;
}
function setCaptureDescription(id, description) {
  ensureSchema();
  newsdb.get().prepare('UPDATE news_captures SET description = ? WHERE id = ?').run(String(description || ''), id);
}
function recentCaptures({ sinceMs = 0, limit = 100 } = {}) {
  ensureSchema();
  return newsdb.get().prepare('SELECT * FROM news_captures WHERE ts >= ? ORDER BY ts DESC LIMIT ?').all(sinceMs, limit);
}
// Retention: drop capture rows AND their PNG files older than cutoffMs. Screenshots are derived/regenerable
// and accumulate unbounded on disk, so this keeps the frames dir bounded. Deletes the file first (fail-soft
// per file) then the row. Returns { rows, files } removed.
function pruneCapturesOlderThan(cutoffMs) {
  ensureSchema();
  const rows = newsdb.get().prepare('SELECT image_path FROM news_captures WHERE ts < ?').all(cutoffMs);
  let files = 0;
  for (const r of rows) { try { if (r.image_path && fs.existsSync(r.image_path)) { fs.unlinkSync(r.image_path); files++; } } catch { /* file already gone */ } }
  const del = newsdb.get().prepare('DELETE FROM news_captures WHERE ts < ?').run(cutoffMs).changes;
  return { rows: del, files };
}

// --- in-page scripts (from the proven probe) ---------------------------------
const JS_ENABLE_CC = `(() => { try {
  const v = document.querySelector('video'); if (v) { v.muted = true; try { v.play && v.play().catch(()=>{}); } catch {} }
  const b = document.querySelector('.ytp-subtitles-button');
  if (b) { if (b.getAttribute('aria-pressed') === 'true') return 'already-on'; b.click(); return 'clicked'; }
  return 'no-button';
} catch (e) { return 'err:' + e.message; } })()`;
const JS_READ_CC = `(() => { const el = document.querySelector('.ytp-caption-window-container');
  if (!el) return ''; const c = el.cloneNode(true); try { c.querySelectorAll('img,button').forEach(e=>e.remove()); } catch {}
  return (c.textContent || '').replace(/\\s+/g,' ').trim().slice(0, 280); })()`;
const JS_IS_PLAYING = `(() => { const v = document.querySelector('video'); return !!v && !v.ended; })()`;

function videoId(u) {
  const s = String(u || '');
  if (/^[\w-]{6,}$/.test(s) && !/[./]/.test(s)) return s;
  const m = s.match(/[?&]v=([\w-]{6,})/) || s.match(/youtu\.be\/([\w-]{6,})/) || s.match(/youtube\.com\/(?:live|embed|shorts)\/([\w-]{6,})/);
  return m ? m[1] : null;
}

// --- the Electron capture lane (thin; not unit-tested — needs the runtime) ----
// One hidden always-on BrowserWindow per feed, muted autoplay + CC on, polled on a cadence. Screenshots
// on the cue edge; segments into the reservoir. Crash-isolated per stream (a dead renderer is reopened).
class CaptureLane {
  constructor({ store, feeds = [], capturesDir, intervalMs = 3000, settleMs = 9000, sampleMs = 30000, maxWindows = 4, log = () => {}, onScreenshot = null, visionRead = null, visionCapPerHour = 60 } = {}) {
    this.store = store; this.feeds = feeds.slice(0, maxWindows); this.log = log; this.onScreenshot = onScreenshot;
    this.capturesDir = capturesDir || path.join(os.tmpdir(), 'news_captures');
    this.intervalMs = intervalMs; this.settleMs = settleMs; this.sampleMs = sampleMs;
    this.visionRead = visionRead; this.visionCapPerHour = visionCapPerHour; this._visHr = -1; this._visN = 0;
    this.wins = new Map(); this.states = new Map(); this.timer = null; this.stopped = false;
  }
  _visionBudget(now) {   // bound vision calls per rolling clock-hour
    const hr = Math.floor(now / 3600000);
    if (this._visHr !== hr) { this._visHr = hr; this._visN = 0; }
    if (this._visN >= this.visionCapPerHour) return false;
    this._visN++; return true;
  }
  start() {
    ensureSchema();
    try { fs.mkdirSync(this.capturesDir, { recursive: true }); } catch {}
    for (const feed of this.feeds) this._open(feed);
    this.timer = setInterval(() => { this._tick().catch(() => {}); }, this.intervalMs);
    this.timer.unref && this.timer.unref();
    this.log(`[video-capture] lane started — ${this.feeds.length} stream(s) → captions+screenshots`);
  }
  _open(feed) {
    const { BrowserWindow } = require('electron');
    const id = videoId(feed.url);
    if (!id) { this.log(`[video-capture] skip (not a YouTube stream): ${feed.url}`); return; }
    const win = new BrowserWindow({ show: false, width: 960, height: 600,
      webPreferences: { autoplayPolicy: 'no-user-gesture-required', partition: 'persist:news-capture', backgroundThrottling: false, offscreen: false } });
    // AUDIO LEAK FIX: mute at the webContents level (authoritative + element-independent), applied at CREATION
    // so the window is never audible. The in-page `v.muted` alone leaked: it only caught the first <video>
    // after a 9s settle, missed YouTube's ad/quality element swaps, and stopped being reapplied once CC turned
    // on. This is the same guard the visible monitor tiles + Meet pane use (main.js setAudioMuted). Muting the
    // audio OUTPUT does not pause playback, so captions still advance. Reassert on media-started-playing so an
    // ad or a full in-page navigation can't reset it audible.
    try { win.webContents.setAudioMuted(true); } catch {}
    try { win.webContents.on('media-started-playing', () => { try { win.webContents.setAudioMuted(true); } catch {} }); } catch {}
    win.webContents.on('render-process-gone', () => { try { win.destroy(); } catch {} this.wins.delete(feed); if (!this.stopped) setTimeout(() => this._open(feed), 5000); });
    win.loadURL(`https://www.youtube.com/watch?v=${id}`).catch((e) => this.log(`[video-capture] load failed ${feed.title}: ${e.message}`));
    this.wins.set(feed, { win, ready: 0, ccOn: false });
    this.states.set(feed, newFeedState(feed));
  }
  async _tick() {
    const now = Date.now();
    for (const feed of this.feeds) {
      const w = this.wins.get(feed); if (!w || w.win.isDestroyed()) continue;
      const wc = w.win.webContents; if (!wc || wc.isDestroyed() || wc.isLoading()) continue;
      if (!w.ready) w.ready = now;
      if (now - w.ready < this.settleMs) continue;                 // let it load + start before reading
      const exec = (js) => wc.executeJavaScript(js, true).catch(() => null);
      if (!w.ccOn) { const via = await exec(JS_ENABLE_CC); w.ccOn = via && via !== 'no-button' && !String(via).startsWith('err'); }
      const raw = await exec(JS_READ_CC);
      const st = this.states.get(feed);
      const { actions } = processPoll(st, { captionText: typeof raw === 'string' ? raw : '', now }, { sampleMs: this.sampleMs });
      for (const a of actions) {
        if (a.type === 'segment') { try { this.store.insertItem(a.item, now); } catch (e) { this.log('[video-capture] insert failed: ' + e.message); } }
        else if (a.type === 'screenshot') { await this._shoot(feed, w.win, a, now); }
      }
    }
  }
  async _shoot(feed, win, action, now) {
    try {
      const img = await win.webContents.capturePage();
      if (!img || img.isEmpty()) return;
      const png = img.toPNG();
      const file = path.join(this.capturesDir, captureFileName(feed, now));
      fs.writeFileSync(file, png);
      const capId = recordCapture({ source: feed.title || feed.url, sourceUrl: feed.url, ts: now, cue: action.cue, imagePath: file, context: action.context });
      this.log(`[video-capture] 📸 ${feed.title || feed.url} — [${action.cue}] → ${path.basename(file)}`);
      // VISION-READ the frame → on-screen market data (tickers/indexes/charts) as text, folded into the
      // reservoir so it clusters + surfaces like any source. Cap-bounded; ad frames still filtered.
      if (typeof this.visionRead === 'function' && this._visionBudget(now)) {
        try {
          const r = await this.visionRead({ base64: png.toString('base64'), feed, cue: action.cue });
          const text = r && r.ok ? String(r.text || '').trim() : '';
          if (text) {
            setCaptureDescription(capId, text);
            const item = buildVisionItem(feed, text, now);
            if (item && adHeuristic(item.summary) !== 'ad') { try { this.store.insertItem(item, now); } catch {} this.log(`[video-capture] 👁 ${feed.title || feed.url}: ${text.slice(0, 80)}`); }
          }
        } catch (e) { this.log('[video-capture] vision-read failed: ' + e.message); }
      }
      if (typeof this.onScreenshot === 'function') { try { await this.onScreenshot({ id: capId, feed, file, cue: action.cue, context: action.context, ts: now }); } catch {} }
    } catch (e) { this.log('[video-capture] screenshot failed: ' + e.message); }
  }
  stop() {
    this.stopped = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    for (const [, w] of this.wins) { try { w.win.destroy(); } catch {} }
    this.wins.clear(); this.states.clear();
    this.log('[video-capture] lane stopped');
  }
}

module.exports = {
  // pure (tested)
  parseCaptionLines, isNonSpeechCue, cueOf, deriveTitle, buildSegmentItem, buildVisionItem, feedKey, captureFileName,
  newFeedState, resetBuffer, processPoll, videoId, SCREEN_READ_PROMPT,
  // store
  ensureSchema, recordCapture, setCaptureDescription, recentCaptures, pruneCapturesOlderThan,
  // engine
  CaptureLane,
};
