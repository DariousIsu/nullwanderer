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

// --- pure: extract segment URLs from an HLS playlist (or just its TAIL). The live caption manifest is a
// full-DVR playlist (megabytes, thousands of segments, GROWING) — parsing it whole every poll is the cost
// that would re-freeze the app. The newest segments are at the END, and we dedup by URL (no sequence math
// needed), so the follower fetches only the manifest TAIL and passes it here. Returns URLs in order.
function parseSegmentUrls(m3u8OrTail) {
  const out = [];
  for (const raw of String(m3u8OrTail || '').split('\n')) {
    const l = raw.trim();
    if (!l || l.startsWith('#')) continue;
    if (/^https?:\/\//i.test(l)) out.push(l);
  }
  return out;
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
const _UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';
const _TAIL_BYTES = 65536;   // only the last 64KB of the (multi-MB, growing) caption manifest — newest segments

class CaptionFollower {
  constructor(feed, { ytdlp = 'yt-dlp', fetchImpl = null, log = () => {} } = {}) {
    this.feed = feed; this.ytdlp = ytdlp; this.log = log;
    this.fetch = fetchImpl || ((...a) => fetch(...a));
    this.manifestUrl = null; this.expiresAt = 0;
    this.segSeen = new Set();   // segment URLs already fetched (dedup — no sequence math)
    this.textSeen = new Set();  // caption LINES already surfaced (dedup rolling live overlap)
    this.resolving = false; this.fails = 0; this.lastResolveAt = 0;
  }
  async _resolve(now) {
    // Backoff so a persistently-failing feed can't spawn a yt-dlp resolve every tick (a CPU storm).
    if (this.resolving || (now - this.lastResolveAt) < 60000) return false;
    this.resolving = true; this.lastResolveAt = now;
    const r = await resolveCaptionManifest(this.feed.url, { ytdlp: this.ytdlp }).catch(() => ({ ok: false }));
    this.resolving = false;
    if (r.ok) { this.manifestUrl = r.url; this.expiresAt = r.expiresAt || (now + 5 * 3600e3); this.fails = 0; this.log(`[caption] resolved ${this.feed.title || this.feed.url}`); return true; }
    this.log(`[caption] resolve failed ${this.feed.title || this.feed.url}: ${r.reason}`); return false;
  }
  // one poll: (re)resolve if needed, fetch only the manifest TAIL, fetch NEW segments (by URL), return
  // fresh caption lines. O(newest-few) work regardless of manifest size — the whole point of the rewrite.
  async poll({ now = Date.now(), maxSegs = 6 } = {}) {
    if (!this.manifestUrl || now > this.expiresAt - 60000) { if (!await this._resolve(now)) return []; }
    let m3u8;
    try {
      const r = await this.fetch(this.manifestUrl, { headers: { 'User-Agent': _UA, Range: `bytes=-${_TAIL_BYTES}` } });
      if (!(r.ok || r.status === 206)) throw new Error('HTTP ' + r.status);
      const body = await r.text();
      m3u8 = r.status === 206 ? body : body.slice(-_TAIL_BYTES);   // if Range ignored (200), slice the tail ourselves
    } catch (e) { this.fails++; if (this.fails >= 2) { this.manifestUrl = null; } return []; }
    this.fails = 0;
    const urls = parseSegmentUrls(m3u8);
    const newUrls = urls.filter(u => !this.segSeen.has(u)).slice(-maxSegs);   // only unseen, bounded
    if (!newUrls.length) return [];
    const fresh = [];
    for (const u of newUrls) {
      this.segSeen.add(u);
      try { const r = await this.fetch(u, { headers: { 'User-Agent': _UA } }); if (!r.ok) continue; fresh.push(...freshLines(this.textSeen, parseVtt(await r.text()))); }
      catch { /* skip this segment */ }
    }
    if (this.segSeen.size > 300) this.segSeen = new Set([...this.segSeen].slice(-150));
    if (this.textSeen.size > 400) this.textSeen = new Set([...this.textSeen].slice(-200));
    return fresh;
  }
}

// --- the lane: run a follower per feed on a cadence, segment via the (tested) video_capture pipeline,
// and land items in news_store. Drop-in replacement for video_capture.CaptureLane — same {store, feeds}
// shape — but zero browser windows / zero video decode. Fail-soft per feed.
class CaptionStreamLane {
  constructor({ store, feeds = [], ytdlp = 'yt-dlp', intervalMs = 15000, sampleMs = 30000, log = () => {} } = {}) {
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

module.exports = { captionUrlFromInfo, parseSegmentUrls, parseVtt, freshLines, resolveCaptionManifest, CaptionFollower, CaptionStreamLane };
