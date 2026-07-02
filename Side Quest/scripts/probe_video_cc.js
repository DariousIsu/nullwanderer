/*
 * probe_video_cc.js — LIVE diagnostic for the Data-Stream Lane video-caption capture (design §7).
 *
 * Proves the capture MECHANISM for the Monitors video feeds: open each stream in a HIDDEN
 * BrowserWindow, force muted autoplay, turn CC on, and read the rendered caption container — exactly
 * how the lane will collect video captions into the reservoir. It also validates the OFFSCREEN
 * always-on path (knob §8.5): if a hidden window captures captions cleanly, always-on capture is
 * feasible without the Monitors pane being open.
 *
 * Why the watch page (not the embed): lib/media_cc reads captions from the TOP document
 * (youtube.com/watch), because an embedded iframe's caption DOM is cross-origin and unreadable. We
 * mirror that here. BrowserWindow autoplayPolicy:'no-user-gesture-required' gets it playing hidden.
 *
 * ISOLATED + SAFE: no lib/ imports (never opens sq.db), no engine, read-only on data/monitor_videos.json.
 * It only opens YouTube in throwaway hidden windows and prints a report.
 *
 * RUN (needs the Electron RUNTIME — NOT ELECTRON_RUN_AS_NODE):
 *   ./node_modules/.bin/electron scripts/probe_video_cc.js
 *   ./node_modules/.bin/electron scripts/probe_video_cc.js --show          # show windows (debug)
 *   ./node_modules/.bin/electron scripts/probe_video_cc.js <url_or_id> ... # probe specific streams
 */
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const REPORT_FILE = path.join(os.tmpdir(), 'probe_video_cc_report.json');
const REPORT_JSONL = path.join(os.tmpdir(), 'probe_video_cc_report.jsonl');   // append-mode (one line per stream) — survives per-process runs

const SHOW = process.argv.includes('--show');
const ARG_STREAMS = process.argv.slice(2).filter(a => a && !a.startsWith('--'));

const PER_VIDEO_MS = 32000;   // total budget per stream (load + settle + poll window)
const SETTLE_MS = 9000;       // wait after load before enabling CC / polling
const POLL_EVERY_MS = 2000;   // caption poll cadence
const POLL_COUNT = 10;        // ~20s of polling after settle

// --- pure helpers (inlined so the probe imports nothing from lib/) ---
function videoId(u) {
  const s = String(u || '');
  if (/^[\w-]{6,}$/.test(s) && !/[./]/.test(s)) return s;   // already a bare id
  const m = s.match(/[?&]v=([\w-]{6,})/) || s.match(/youtu\.be\/([\w-]{6,})/)
         || s.match(/youtube\.com\/(?:live|embed|shorts)\/([\w-]{6,})/);
  return m ? m[1] : null;
}
function parseCaptionLines(raw) {
  const out = [];
  for (const line of String(raw || '').split('\n')) {
    const t = line.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!t || t.length > 280) continue;
    out.push(t);
  }
  return out;
}
function loadStreams() {
  if (ARG_STREAMS.length) return ARG_STREAMS.map(s => ({ url: s, title: '' }));
  try {
    const p = path.join(__dirname, '..', 'data', 'monitor_videos.json');
    const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (Array.isArray(arr) && arr.length) return arr;
  } catch (e) { console.log('[probe] could not read data/monitor_videos.json:', e.message); }
  return [];
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// --- in-page scripts ---
const JS_ENABLE_CC = `(() => {
  let via = 'none';
  try {
    const v = document.querySelector('video');
    if (v) { v.muted = true; try { v.play && v.play().catch(()=>{}); } catch {} }
    const btn = document.querySelector('.ytp-subtitles-button');
    if (btn) {
      const pressed = btn.getAttribute('aria-pressed');
      if (pressed === 'true') via = 'already-on';
      else { btn.click(); via = 'button-click'; }
    }
  } catch (e) { via = 'err:' + e.message; }
  return via;
})()`;
const JS_STATE = `(() => {
  const v = document.querySelector('video');
  const consent = !!document.querySelector('[aria-label*="consent" i], form[action*="consent" i], ytd-consent-bump-v2-lightbox');
  return { hasVideo: !!v, paused: v ? v.paused : null, ended: v ? v.ended : null, t: v ? Math.round((v.currentTime||0)*10)/10 : null, consent };
})()`;
const JS_READ_CC = `(() => {
  const el = document.querySelector('.ytp-caption-window-container');
  if (!el) return '';
  const clone = el.cloneNode(true);
  try { clone.querySelectorAll('img,button').forEach(e => e.remove()); } catch {}
  return (clone.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 280);
})()`;

async function probeOne(stream) {
  const id = videoId(stream.url);
  const label = stream.title || (id || stream.url);
  const rep = { label, id, opened: false, playing: false, ccVia: 'none', consent: false, lines: [], note: '' };
  if (!id) { rep.note = 'not a YouTube URL/id'; return rep; }

  const win = new BrowserWindow({
    show: SHOW, width: 960, height: 600,
    webPreferences: { autoplayPolicy: 'no-user-gesture-required', partition: 'persist:probe-media', backgroundThrottling: false }
  });
  // Crash isolation: a renderer/GPU death on one stream must not kill the run — note it and move on.
  win.webContents.on('render-process-gone', (_e, d) => { rep.note = rep.note || ('renderer gone: ' + (d && d.reason)); });
  const exec = (js) => { if (win.isDestroyed() || !win.webContents || win.webContents.isDestroyed()) return Promise.resolve({ __err: 'window-gone' }); return win.webContents.executeJavaScript(js, true).catch(e => ({ __err: e.message })); };
  const loadOnce = () => win.loadURL(`https://www.youtube.com/watch?v=${id}`).then(() => true).catch(e => { rep.note = 'load failed: ' + e.message; return false; });

  try {
    const deadline = Date.now() + PER_VIDEO_MS;
    rep.opened = await loadOnce();
    if (!rep.opened) { await sleep(1500); rep.opened = await loadOnce(); }   // one retry (ERR_FAILED is often transient)
    if (!rep.opened) return rep;

    await sleep(SETTLE_MS);
    const st0 = await exec(JS_STATE);
    if (st0 && st0.consent) rep.consent = true;
    rep.ccVia = await exec(JS_ENABLE_CC);

    const seen = new Set();
    for (let i = 0; i < POLL_COUNT && Date.now() < deadline; i++) {
      const st = await exec(JS_STATE);
      if (st && st.hasVideo && st.paused === false) rep.playing = true;
      if (st && st.consent) rep.consent = true;
      const blob = await exec(JS_READ_CC);
      if (typeof blob === 'string') {
        for (const ln of parseCaptionLines(blob)) {
          if (!seen.has(ln)) { seen.add(ln); rep.lines.push(ln); }
        }
      }
      // re-assert CC if nothing yet (some players need a second toggle after the ad/preroll)
      if (!rep.lines.length && i === 3) await exec(JS_ENABLE_CC);
      await sleep(POLL_EVERY_MS);
    }
    if (!rep.lines.length && !rep.note) {
      rep.note = rep.consent ? 'blocked by consent/interstitial (needs an authed session)'
        : (rep.playing ? 'playing but no captions read (CC track absent/late, or selector drift)' : 'video never played (autoplay blocked?)');
    }
  } finally {
    try { win.destroy(); } catch {}
  }
  return rep;
}

async function main() {
  const streams = loadStreams();
  console.log(`\n=== video-caption probe — ${streams.length} stream(s)${SHOW ? ' (visible)' : ' (hidden)'} ===`);
  if (!streams.length) { console.log('No streams. Pass URLs/ids as args or seed data/monitor_videos.json.'); app.exit(1); return; }

  const reports = [];
  for (const s of streams) {
    console.log(`\n[probe] ${s.title || s.url} …`);
    let r;
    try { r = await probeOne(s); }
    catch (e) { r = { label: s.title || s.url, id: videoId(s.url), opened: false, playing: false, ccVia: 'none', consent: false, lines: [], note: 'probe threw: ' + e.message }; }
    reports.push(r);
    const verdict = r.lines.length ? `CAPTIONS OK (${r.lines.length} lines)` : 'NO CAPTIONS';
    console.log(`  → ${verdict} | opened=${r.opened} playing=${r.playing} cc=${r.ccVia}${r.consent ? ' consent!' : ''}${r.note ? ' | ' + r.note : ''}`);
    if (r.lines.length) console.log('    sample:', JSON.stringify(r.lines.slice(0, 3)));
    // append this stream's result immediately (one JSON line) — survives a crash on the NEXT stream
    // AND survives running one-stream-per-process (the crash-proof mode: the 2nd-window GPU death never happens)
    try { fs.appendFileSync(REPORT_JSONL, JSON.stringify({ ...r, ts: new Date().toISOString() }) + '\n'); } catch {}
    await sleep(2000);   // let the GPU/video process settle between streams
  }

  const okN = reports.filter(r => r.lines.length).length;
  try { fs.writeFileSync(REPORT_FILE, JSON.stringify({ ts: new Date().toISOString(), okN, total: reports.length, reports }, null, 2)); console.log(`[probe] report → ${REPORT_FILE}`); } catch (e) { console.log('[probe] report write failed:', e.message); }
  console.log(`\n=== SUMMARY: ${okN}/${reports.length} streams yielded captions ===`);
  for (const r of reports) console.log(`  ${r.lines.length ? '✓' : '✗'} ${r.label} — ${r.lines.length} lines${r.note ? ' (' + r.note + ')' : ''}`);
  console.log(okN === reports.length ? '\nPASS — capture mechanism works on every stream (offscreen always-on is feasible).'
    : okN > 0 ? '\nPARTIAL — mechanism works but some streams need attention (see notes).'
    : '\nFAIL — no captions captured; check notes (consent wall / autoplay / selector).');
  app.exit(okN === reports.length ? 0 : 1);
}

app.whenReady().then(main).catch(e => { console.error('[probe] fatal:', e); app.exit(2); });
