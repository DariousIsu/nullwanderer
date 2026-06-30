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

// Bounds to spread into `new BrowserWindow({ ...options(key, {width,height}) })`.
function options(key, fallback = {}) {
  const s = load(key);
  if (!s) return fallback;
  const o = { width: s.width, height: s.height };
  if (onScreen(s)) { o.x = s.x; o.y = s.y; }
  return o;
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
