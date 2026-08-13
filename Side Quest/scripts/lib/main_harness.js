/**
 * main.js wiring harness — loads the REAL main.js under ELECTRON_RUN_AS_NODE with the
 * electron API stubbed, so smokes can finally assert on the WIRING (the review's core
 * finding: zero smokes loaded main.js, and every recent live incident was a main.js
 * seam bug — the operator gate, the reply contract, the split path, tier stamping).
 *
 * How it works: main.js has exactly ONE app.whenReady() chain (line ~613) holding every
 * boot loop; module scope only registers — ~114 ipcMain channels, app lifecycle events,
 * crash handlers. The stub returns a HELD whenReady promise, so load() gives the full
 * registration surface with zero loops running and no model/network traffic.
 *
 * The stub replicates electron's dup-registration throw on ipcMain.handle, so a duplicate
 * channel registration fails the load exactly like it would fail the live boot.
 *
 * Contract:
 *   const harness = require('./lib/main_harness');
 *   const h = harness.load();       // requires ../..main.js under the stub (throws on any load error)
 *   h.handlers                       // Map<channel, fn>  (ipcMain.handle)
 *   h.listeners                      // Map<channel, [fn]> (ipcMain.on)
 *   h.appEvents                      // Map<event, [fn]>   (app.on)
 *   h.whenReadyCalls                 // number of app.whenReady() invocations
 *   h.invoke(channel, ...args)       // await a handler with a stub IpcMainInvokeEvent
 *   h.ready()                        // OPT-IN: release whenReady (runs the real boot chain — heavy;
 *                                    //         db.init on the temp DB, self-watch, seeding, intervals)
 *
 * load() pins SQ_DB_PATH to a temp file (unless the caller already pinned one) and forces
 * ZOE_AUTONOMIC=0 + TTS kill-switch off, so nothing autonomous or audible can start even
 * if ready() is released.
 */
const path = require('path');
const os = require('os');
const Module = require('module');

function makeElectronStub(state) {
  const handlers = state.handlers, listeners = state.listeners, appEvents = state.appEvents;

  const ipcMain = {
    handle(channel, fn) {
      if (handlers.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`);
      handlers.set(channel, fn);
    },
    on(channel, fn) {
      if (!listeners.has(channel)) listeners.set(channel, []);
      listeners.get(channel).push(fn);
      return ipcMain;
    },
    removeHandler(channel) { handlers.delete(channel); },
    removeAllListeners(channel) { if (channel) listeners.delete(channel); else listeners.clear(); },
  };

  let readyResolve;
  const readyPromise = new Promise((r) => { readyResolve = r; });
  state.releaseReady = readyResolve;

  const app = {
    isPackaged: false,
    commandLine: { appendSwitch() {}, hasSwitch() { return false; } },
    on(evt, fn) { if (!appEvents.has(evt)) appEvents.set(evt, []); appEvents.get(evt).push(fn); return app; },
    once(evt, fn) { return app.on(evt, fn); },
    whenReady() { state.whenReadyCalls++; return readyPromise; },
    getPath(name) { return path.join(os.tmpdir(), `sq_harness_${name}`); },
    getName() { return 'sq-harness'; },
    setName() {}, setAppUserModelId() {}, quit() {}, exit() {}, relaunch() {},
    requestSingleInstanceLock() { return true; },
    getVersion() { return '0.0.0-harness'; },
  };

  class WebContentsStub {
    constructor() { this.session = makeSessionStub(); }
    send() {} on() { return this; } once() { return this; }
    isDestroyed() { return false; }
    setWindowOpenHandler() {} executeJavaScript() { return Promise.resolve(null); }
    openDevTools() {} close() {} loadURL() { return Promise.resolve(); }
  }

  function makeSessionStub() {
    const s = {
      setPermissionRequestHandler() {}, setPermissionCheckHandler() {},
      setDisplayMediaRequestHandler() {},
      webRequest: { onBeforeRequest() {}, onBeforeSendHeaders() {}, onHeadersReceived() {} },
      protocol: { registerFileProtocol() {}, handle() {} },
      clearCache() { return Promise.resolve(); },
    };
    return s;
  }

  class BrowserWindow {
    constructor(opts) { this._opts = opts || {}; this.webContents = new WebContentsStub(); BrowserWindow._all.push(this); }
    loadFile() { return Promise.resolve(); }
    loadURL() { return Promise.resolve(); }
    on() { return this; } once() { return this; }
    show() {} hide() {} close() {} destroy() {} focus() {} minimize() {}
    isDestroyed() { return false; } isVisible() { return false; } isMinimized() { return false; }
    setMenu() {} setBounds() {} getBounds() { return { x: 0, y: 0, width: 1280, height: 800 }; }
    setAlwaysOnTop() {} setIgnoreMouseEvents() {} setPosition() {} getPosition() { return [0, 0]; }
    setSize() {} getSize() { return [1280, 800]; }
  }
  BrowserWindow._all = [];
  BrowserWindow.getAllWindows = () => BrowserWindow._all.filter((w) => !w.isDestroyed());
  BrowserWindow.fromWebContents = () => null;

  const display = {
    id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    workAreaSize: { width: 1920, height: 1040 }, scaleFactor: 1,
  };

  const sessionRoot = makeSessionStub();
  sessionRoot.defaultSession = makeSessionStub();
  sessionRoot.fromPartition = () => makeSessionStub();

  return {
    app, BrowserWindow, ipcMain,
    session: sessionRoot,
    dialog: {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      showSaveDialog: async () => ({ canceled: true }),
      showMessageBox: async () => ({ response: 0 }),
    },
    shell: { openExternal: async () => {}, openPath: async () => '', showItemInFolder() {} },
    Menu: Object.assign(function Menu() {}, { buildFromTemplate: () => ({ popup() {}, items: [] }), setApplicationMenu() {} }),
    MenuItem: function MenuItem(o) { Object.assign(this, o); },
    screen: { getPrimaryDisplay: () => display, getAllDisplays: () => [display], getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
    webContents: { getAllWebContents: () => [] },
    net: { fetch: (...a) => globalThis.fetch(...a) },
    desktopCapturer: { getSources: async () => [] },
    nativeImage: { createFromPath: () => ({ isEmpty: () => true }), createEmpty: () => ({ isEmpty: () => true }) },
    nativeTheme: { shouldUseDarkColors: true, on() {} },
    globalShortcut: { register() { return false; }, unregisterAll() {} },
    powerSaveBlocker: { start: () => 0, stop() {} },
    clipboard: { readText: () => '', writeText() {} },
    protocol: { registerSchemesAsPrivileged() {}, handle() {} },
  };
}

let _loaded = null;

function load() {
  if (_loaded) return _loaded;

  // Isolation pins — BEFORE any lib in main.js's graph can read them.
  if (!process.env.SQ_DB_PATH) process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_mainwire_${Date.now()}.db`);
  process.env.ZOE_AUTONOMIC = '0';          // no autonomous focus even if ready() is released
  delete process.env.ZOE_TTS_ENABLED;       // TTS kill-switch stays off (no sidecar spawn)

  const state = { handlers: new Map(), listeners: new Map(), appEvents: new Map(), whenReadyCalls: 0, releaseReady: null };
  const electronStub = makeElectronStub(state);

  // Intercept every require('electron') in the whole graph (main.js AND libs).
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electronStub;
    return origLoad.apply(this, arguments);
  };

  try {
    require(path.join(__dirname, '..', '..', 'main.js'));
  } finally {
    // Leave the interceptor INSTALLED: main.js lazily requires('electron') inside handlers,
    // and those must keep hitting the stub for the lifetime of the smoke process.
  }

  _loaded = {
    handlers: state.handlers,
    listeners: state.listeners,
    appEvents: state.appEvents,
    get whenReadyCalls() { return state.whenReadyCalls; },
    electron: electronStub,
    invoke(channel, ...args) {
      const fn = state.handlers.get(channel);
      if (!fn) return Promise.reject(new Error(`no handler registered for '${channel}'`));
      const evt = { sender: { send() {}, isDestroyed: () => false }, frameId: 0 };
      return Promise.resolve().then(() => fn(evt, ...args));
    },
    ready() {
      state.releaseReady();
      return new Promise((r) => setTimeout(r, 50)); // let the .then chain's synchronous part run
    },
  };
  return _loaded;
}

module.exports = { load };
