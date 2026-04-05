/**
 * AURA NX-Alpha — Electron Preload
 *
 * Runs in a privileged context with access to Node.js APIs, but is
 * isolated from the renderer by contextIsolation: true. Exposes a
 * curated `window.electronAPI` surface via contextBridge.
 *
 * Renderer code should ONLY touch window.electronAPI — never require
 * or use Node.js/Electron APIs directly.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * API SURFACE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   window.electronAPI.platform               → 'win32' | 'darwin' | 'linux'
 *
 *   window.electronAPI.windowMinimize()       → minimize window
 *   window.electronAPI.windowMaximizeRestore()→ maximize or restore window
 *   window.electronAPI.windowClose()          → close window
 *   window.electronAPI.windowIsMaximized()    → Promise<boolean>
 *
 *   window.electronAPI.popOutPanel(panelId)   → open panel in BrowserWindow
 *
 *   window.electronAPI.getStreamUrl()         → Promise<string>
 *                                              SSE endpoint URL from main config
 *
 *   window.electronAPI.onWindowMaximize(fn)   → subscribe to maximize events
 *   window.electronAPI.onWindowUnmaximize(fn) → subscribe to unmaximize events
 *   window.electronAPI.removeListener(ch, fn) → unsubscribe
 */

const { contextBridge, ipcRenderer } = require('electron');

// ── Safe IPC wrapper — prevents prototype pollution attacks ──
function safeSend(channel, ...args) {
  const ALLOWED_SEND = new Set([
    'window:minimize',
    'window:maximize-restore',
    'window:close',
    'panel:pop-out',
    'panel:close-pop-out',
    'voice:ptt-toggle',
    'theatre:open',
    'theatre:minimize',
    'theatre:maximize-restore',
    'theatre:close',
  ]);
  if (!ALLOWED_SEND.has(channel)) {
    console.error('[preload] Blocked unauthorized IPC send:', channel);
    return;
  }
  ipcRenderer.send(channel, ...args);
}

function safeInvoke(channel, ...args) {
  const ALLOWED_INVOKE = new Set([
    'config:stream-url',
    'window:is-maximized',
    'shell:open-external',
    'window:set-portrait-mode',
    'window:toggle-always-on-top',
    'window:is-always-on-top',
    'dialog:open-folder',
    'computer-use:confirm',
  ]);
  if (!ALLOWED_INVOKE.has(channel)) {
    console.error('[preload] Blocked unauthorized IPC invoke:', channel);
    return Promise.reject(new Error(`Unauthorized channel: ${channel}`));
  }
  return ipcRenderer.invoke(channel, ...args);
}

// ── Event listener management ──
// Track all registered listeners so renderer can clean up correctly.
const listenerMap = new WeakMap();

contextBridge.exposeInMainWorld('electronAPI', {

  // ── Platform ──
  platform: process.platform,

  // ── Window chrome controls (used by TitleBar) ──
  windowMinimize:         () => safeSend('window:minimize'),
  windowMaximizeRestore:  () => safeSend('window:maximize-restore'),
  windowClose:            () => safeSend('window:close'),
  windowIsMaximized:      () => safeInvoke('window:is-maximized'),

  // ── Window state events (for TitleBar maximize button icon sync) ──
  onWindowMaximize: (fn) => {
    ipcRenderer.on('window:maximized', fn);
  },
  onWindowUnmaximize: (fn) => {
    ipcRenderer.on('window:unmaximized', fn);
  },
  removeWindowListener: (event, fn) => {
    ipcRenderer.removeListener(event, fn);
  },

  // ── Panel pop-out ──
  popOutPanel: (panelId) => safeSend('panel:pop-out', panelId),
  closePopOut: () => safeSend('panel:close-pop-out'),

  // ── Pop-out closed notification (sent from main process to main renderer) ──
  // Called when a pop-out BrowserWindow is closed; restores the hidden sidebar.
  onPopOutClosed: (fn) => {
    ipcRenderer.on('panel:pop-out-closed', fn);
  },

  // ── Backend config ──
  getStreamUrl: () => safeInvoke('config:stream-url'),

  // ── Open URL in system default browser ──
  openExternal: (url) => safeInvoke('shell:open-external', url),

  // ── Pop-out window: portrait mode + always-on-top ──
  setPortraitMode:    (enable) => safeInvoke('window:set-portrait-mode', enable),
  toggleAlwaysOnTop:  ()       => safeInvoke('window:toggle-always-on-top'),
  isAlwaysOnTop:      ()       => safeInvoke('window:is-always-on-top'),

  // ── Theatre window ──
  openTheatre:            () => safeSend('theatre:open'),
  theatreMinimize:        () => safeSend('theatre:minimize'),
  theatreMaximizeRestore: () => safeSend('theatre:maximize-restore'),
  theatreClose:           () => safeSend('theatre:close'),

  // ── Neural Interface — folder picker ──
  openFolder: () => safeInvoke('dialog:open-folder'),

  // ── Voice push-to-talk ──
  // Triggered by Ctrl+Alt+Space globalShortcut from main process.
  // Renderer (Chat.jsx) subscribes to toggle mic recording on/off.
  onVoicePttToggle: (fn) => {
    ipcRenderer.on('voice:ptt-toggle', fn);
  },
  removeVoicePttListener: (fn) => {
    ipcRenderer.removeListener('voice:ptt-toggle', fn);
  },

  // ── Computer Use ──
  // Renderer calls this to ask the user to confirm a risky AURA action.
  confirmComputerUseAction: (payload) => safeInvoke('computer-use:confirm', payload),

  // Notification when AURA performs autonomous computer use during idle.
  onComputerUseNotify: (fn) => {
    ipcRenderer.on('computer-use:notify', fn);
  },
  removeComputerUseNotifyListener: (fn) => {
    ipcRenderer.removeListener('computer-use:notify', fn);
  },

  // Self-status updates from the self-awareness service.
  onSelfStatusUpdate: (fn) => {
    ipcRenderer.on('self-status:update', fn);
  },
  removeSelfStatusListener: (fn) => {
    ipcRenderer.removeListener('self-status:update', fn);
  },

});
