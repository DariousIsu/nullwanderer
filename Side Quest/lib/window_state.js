/**
 * lib/window_state.js — remember each window's position + size across reboots (QoL).
 *
 * Per-window key → { x, y, width, height, maximized } persisted to data/window_state.json.
 * options(key, fallback) returns a bounds object to spread into the BrowserWindow ctor (validated
 * to be on a connected display, so a window saved on a now-disconnected monitor falls back to the
 * default size rather than opening off-screen). track(win, key) saves on move/resize/maximize/close.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const FILE = path.join(__dirname, '..', 'data', 'window_state.json');

function readAll() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch { return {}; } }
function writeAll(obj) { try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(obj, null, 2)); } catch {} }

function load(key) {
  const s = readAll()[key];
  if (!s || !Number.isFinite(s.width) || !Number.isFinite(s.height)) return null;
  return s;
}

// Is (x,y,w,h) at least partially on some connected display? Guards against off-screen restores.
function onScreen(s) {
  if (!Number.isFinite(s.x) || !Number.isFinite(s.y)) return false;
  try {
    const { screen } = require('electron');
    return screen.getAllDisplays().some(d => {
      const w = d.workArea;
      return s.x < w.x + w.width && s.x + s.width > w.x && s.y < w.y + w.height && s.y + s.height > w.y;
    });
  } catch { return true; }
}

// Fit saved bounds FULLY within the workArea of the display they're on. A window that straddles two
// monitors — or overflows one, or lands in a gap in a multi-monitor layout — is the state Windows
// oscillates ("violent shake"): it can't settle which monitor owns the window and nudges it forever.
// This is independent of DPI (it happens at uniform 100% scaling across a non-rectangular layout).
function clampToDisplay(s) {
  try {
    const { screen } = require('electron');
    const wa = screen.getDisplayMatching({ x: s.x, y: s.y, width: s.width, height: s.height }).workArea;
    const width = Math.max(320, Math.min(s.width, wa.width));
    const height = Math.max(240, Math.min(s.height, wa.height));
    const x = Math.max(wa.x, Math.min(s.x, wa.x + wa.width - width));
    const y = Math.max(wa.y, Math.min(s.y, wa.y + wa.height - height));
    return { x, y, width, height };
  } catch { return { x: s.x, y: s.y, width: s.width, height: s.height }; }
}

// Bounds to spread into `new BrowserWindow({ ...options(key, {width,height}) })`.
function options(key, fallback = {}) {
  const s = load(key);
  if (!s) return fallback;
  if (!onScreen(s)) return { width: s.width, height: s.height };   // saved monitor gone → default size, OS centers
  const c = clampToDisplay(s);
  return { x: c.x, y: c.y, width: c.width, height: c.height };
}

// Attach persistence to a created window: restore maximized state, then save on change (debounced).
function track(win, key) {
  if (!win) return;
  try { const s = load(key); if (s && s.maximized) win.maximize(); } catch {}
  let t = null;
  const save = () => {
    if (!win || win.isDestroyed()) return;
    try {
      const b = win.getNormalBounds ? win.getNormalBounds() : win.getBounds();   // excludes maximize/fullscreen
      const all = readAll();
      all[key] = { x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized() };
      writeAll(all);
    } catch {}
  };
  const debounced = () => { clearTimeout(t); t = setTimeout(save, 400); };
  win.on('resize', debounced);
  win.on('move', debounced);
  win.on('maximize', save);
  win.on('unmaximize', save);
  win.on('close', save);
}

module.exports = { load, options, track };
