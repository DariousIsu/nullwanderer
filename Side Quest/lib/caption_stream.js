/**
 * lib/caption_stream.js — ZERO-DECODE live caption source for the Data-Stream video lane.
 *
 * Replaces the old CaptureLane approach (one hidden always-on YouTube BrowserWindow per feed, which
 * decoded live video + ran an ad-iframe swarm that pegged the main thread and froze the app — see
 * memory/video-capture-freeze). Here we never open a browser or decode a frame: yt-dlp resolves the
 * live auto-caption HLS manifest URL, then we poll that m3u8 for new .vtt segments and read the words.
 * ~4 tiny HTTP fetches every few seconds per feed → negligible CPU.
 *
 * Live delivery quirks handled:
 *  - Captions are an HLS media playlist of tiny WEBVTT segments keyed by #EXT-X-MEDIA-SEQUENCE; we only
 *    fetch segments NEWER than the last one we saw.
 *  - YouTube's rolling live captions OVERLAP heavily between segments (each repeats the tail of the
 *    prior one), so freshLines() dedups against a bounded seen-set.
 *  - The manifest URL is signed and EXPIRES (~6h) → re-resolve via yt-dlp on expiry/failure.
 *
 * Pure helpers (parseManifest / parseVtt / freshLines / captionUrlFromInfo) are unit-tested offline
 * (scripts/smoke_caption_stream.js); the resolver + follower need the network/yt-dlp at runtime.
 */
'use strict';
const { spawn } = require('child_process');

// --- pure: pick the en auto-caption manifest URL from a yt-dlp -J info object ---
function captionUrlFromInfo(info, { lang = 'en' } = {}) {
  const ac = (info && info.automatic_captions) || {};
  const list = ac[lang] || ac[`${lang}-US`] || ac[`${lang}-orig`] || [];
  // prefer vtt (what YouTube live serves); fall back to whatever's first
  const pick = list.find(f => f && f.ext === 'vtt') || list[0];
  return pick && pick.url ? pick.url : null;
}

// --- pure: parse an HLS media playlist → { mediaSequence, segments:[{seq,url}] } ---
// Segment URLs are the non-# lines; the Nth listed segment has sequence mediaSequence+N.
function parseManifest(m3u8) {
  const lines = String(m3u8 || '').split('\n').map(s => s.trim()).filter(Boolean);
  let mediaSequence = 0;
  for (const l of lines) { const m = l.match(/^#EXT-X-MEDIA-SEQUENCE:(\d+)/); if (m) { mediaSequence = parseInt(m[1], 10); break; } }
  const segs = [];
  let i = 0;
  for (const l of lines) {
    if (l.startsWith('#')) continue;
    if (/^https?:\/\//i.test(l)) { segs.push({ seq: mediaSequence + i, url: l }); i++; }
  }
  return { mediaSequence, segments: segs };
}

// --- pure: WEBVTT segment → clean caption lines (cues only, markup + timings stripped) ---
function parseVtt(text) {
  const out = [];
  for (let line of String(text || '').split('\n')) {
    line = line.trim();
    if (!line) continue;
    if (/^WEBVTT/i.test(line) || /^(Kind|Language|X-TIMESTAMP-MAP)/i.test(line)) continue;
    if (/-->/.test(line)) continue;                       // cue timing line
    if (/^\d+$/.test(line)) continue;                     // cue index
    const t = line.replace(/<[^>]+>/g, '').replace(/align:[^\s]+|position:[^\s]+/g, '').replace(/\s+/g, ' ').trim();
    if (t) out.push(t);
  }
  return out;
}

// --- pure: dedup rolling/overlapping caption lines against a bounded seen-set (mutates the set) ---
function freshLines(seen, lines) {
  const fresh = [];
  for (const t of lines) {
    if (!t || seen.has(t)) continue;
    seen.add(t); fresh.push(t);
  }
  return fresh;
}

// --- resolver: yt-dlp -J → the live auto-caption manifest URL (+ a soft expiry from the signed URL) ---
function _expiryFromUrl(u) { const m = String(u || '').match(/[?&/]expire[/=](\d+)/); return m ? parseInt(m[1], 10) * 1000 : 0; }

function resolveCaptionManifest(videoUrl, { ytdlp = 'yt-dlp', lang = 'en', timeoutMs = 45000 } = {}) {
  return new Promise((resolve) => {
    let out = '', done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let p;
    try { p = spawn(ytdlp, ['-J', '--skip-download', '--no-warnings', videoUrl], { windowsHide: true }); }
    catch (e) { return finish({ ok: false, reason: 'spawn:' + e.message }); }
    const to = setTimeout(() => { try { p.kill(); } catch {} finish({ ok: false, reason: 'timeout' }); }, timeoutMs);
    p.stdout.on('data', d => { out += d; });
    p.on('error', e => { clearTimeout(to); finish({ ok: false, reason: 'err:' + e.message }); });
    p.on('close', () => {
      clearTimeout(to);
      let info; try { info = JSON.parse(out); } catch { return finish({ ok: false, reason: 'parse' }); }
      const url = captionUrlFromInfo(info, { lang });
      if (!url) return finish({ ok: false, reason: 'no-captions', isLive: !!(info && info.is_live) });
      finish({ ok: true, url, expiresAt: _expiryFromUrl(url), isLive: !!(info && info.is_live) });
    });
  });
}

// --- follower: per feed, poll the manifest for new segments → fresh caption lines. Zero decode. ---
// deps.fetch injectable for tests. onLines(feed, freshLines[]) surfaces new caption text.
class CaptionFollower {
  constructor(feed, { ytdlp = 'yt-dlp', fetchImpl = null, log = () => {} } = {}) {
    this.feed = feed; this.ytdlp = ytdlp; this.log = log;
    this.fetch = fetchImpl || ((...a) => fetch(...a));
    this.manifestUrl = null; this.expiresAt = 0; this.lastSeq = -1;
    this.seen = new Set(); this.resolving = false; this.fails = 0;
  }
  async _resolve() {
    if (this.resolving) return false;
    this.resolving = true;
    const r = await resolveCaptionManifest(this.feed.url, { ytdlp: this.ytdlp }).catch(() => ({ ok: false }));
    this.resolving = false;
    if (r.ok) { this.manifestUrl = r.url; this.expiresAt = r.expiresAt || (Date.now() + 5 * 3600e3); this.fails = 0; this.log(`[caption] resolved ${this.feed.title || this.feed.url}`); return true; }
    this.log(`[caption] resolve failed ${this.feed.title || this.feed.url}: ${r.reason}`); return false;
  }
  // one poll: (re)resolve if needed, fetch manifest, fetch NEW segments, return fresh caption lines.
  async poll({ now = Date.now(), maxSegs = 6 } = {}) {
    if (!this.manifestUrl || now > this.expiresAt - 60000) { if (!await this._resolve()) return []; }
    let m3u8;
    try { const r = await this.fetch(this.manifestUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }); if (!r.ok) throw new Error('HTTP ' + r.status); m3u8 = await r.text(); }
    catch (e) { this.fails++; if (this.fails >= 2) { this.manifestUrl = null; } return []; }   // force re-resolve on repeated failure
    this.fails = 0;
    const { segments } = parseManifest(m3u8);
    const newSegs = segments.filter(s => s.seq > this.lastSeq).slice(-maxSegs);   // only newer, bounded
    if (!newSegs.length) return [];
    const fresh = [];
    for (const s of newSegs) {
      try { const r = await this.fetch(s.url, { headers: { 'User-Agent': 'Mozilla/5.0' } }); if (!r.ok) continue; const vtt = await r.text(); fresh.push(...freshLines(this.seen, parseVtt(vtt))); this.lastSeq = Math.max(this.lastSeq, s.seq); }
      catch { /* skip this segment */ }
    }
    if (this.seen.size > 400) this.seen = new Set([...this.seen].slice(-200));   // bound the dedup set
    return fresh;
  }
}

// --- the lane: run a follower per feed on a cadence, segment via the (tested) video_capture pipeline,
// and land items in news_store. Drop-in replacement for video_capture.CaptureLane — same {store, feeds}
// shape — but zero browser windows / zero video decode. Fail-soft per feed.
class CaptionStreamLane {
  constructor({ store, feeds = [], ytdlp = 'yt-dlp', intervalMs = 5000, sampleMs = 30000, log = () => {} } = {}) {
    const vc = require('./video_capture');
    this.store = store; this.log = log; this.intervalMs = intervalMs; this.sampleMs = sampleMs; this._vc = vc;
    this.followers = (feeds || []).map(f => new CaptionFollower(f, { ytdlp, log }));
    this.states = new Map((feeds || []).map(f => [f.url, vc.newFeedState(f)]));
    this.timer = null; this.stopped = false;
  }
  start() {
    try { this._vc.ensureSchema(); } catch {}
    this.timer = setInterval(() => { this._tick().catch(() => {}); }, this.intervalMs);
    this.timer.unref && this.timer.unref();
    this.log(`[caption-stream] lane started — ${this.followers.length} feed(s), zero-decode (no browser/decode)`);
  }
  async _tick() {
    if (this.stopped) return;
    const now = Date.now();
    await Promise.all(this.followers.map(async (fol) => {
      let fresh = [];
      try { fresh = await fol.poll({ now }); } catch {}
      if (!fresh.length) return;
      const st = this.states.get(fol.feed.url); if (!st) return;
      const { actions } = this._vc.processPoll(st, { captionText: fresh.join('\n'), now }, { sampleMs: this.sampleMs });
      for (const a of actions) if (a.type === 'segment') { try { this.store.insertItem(a.item, now); } catch (e) { this.log('[caption-stream] insert failed: ' + e.message); } }
    }));
  }
  stop() { this.stopped = true; if (this.timer) { clearInterval(this.timer); this.timer = null; } this.log('[caption-stream] lane stopped'); }
}

module.exports = { captionUrlFromInfo, parseManifest, parseVtt, freshLines, resolveCaptionManifest, CaptionFollower, CaptionStreamLane };
