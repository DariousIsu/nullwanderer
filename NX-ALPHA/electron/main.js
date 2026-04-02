/**
 * AURA NX-Alpha — Electron Main Process
 *
 * Entry point for the Electron main process. Creates the main BrowserWindow
 * and manages IPC channels bridged from the renderer via preload.js.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WINDOW ARCHITECTURE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   mainWindow  — The primary Command Center UI.
 *                 frameless, custom TitleBar via renderer.
 *                 Dev: loads http://localhost:5173 (Vite dev server)
 *                 Prod: loads dist/renderer/index.html
 *
 *   popOutWindows — Map of panelId → BrowserWindow for panels popped out
 *                 into separate windows. Cleaned up on close.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IPC CHANNELS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   send  'window:minimize'          → minimize mainWindow
 *   send  'window:maximize-restore'  → toggle maximize/restore
 *   send  'window:close'             → close mainWindow
 *   invoke'window:is-maximized'      → boolean
 *
 *   on    'window:maximized'         → sent to renderer on maximize
 *   on    'window:unmaximized'       → sent to renderer on unmaximize
 *
 *   send  'panel:pop-out' (panelId)  → open panel in new BrowserWindow
 *
 *   invoke'config:stream-url'        → SSE endpoint URL string
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ENVIRONMENT
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   IS_DEV   — true when running via `npm run dev` (app not packaged)
 *   AURA_STREAM_URL — env var to override the default SSE endpoint
 *
 */

'use strict';

const { app, BrowserWindow, ipcMain, shell, nativeTheme, screen, globalShortcut, Menu, session } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const RENDERER_HTML   = path.join(__dirname, '../dist/renderer/index.html');
const RENDERER_URL    = 'http://localhost:5173';
const PRELOAD_PATH    = path.join(__dirname, 'preload.js');

// IS_DEV: true if running in dev mode (no dist files built yet)
// Check if dist/renderer exists; if not, we're in dev mode
const IS_DEV          = !app.isPackaged && !fs.existsSync(RENDERER_HTML);

/** Default SSE endpoint. Override via AURA_STREAM_URL env var. */
const DEFAULT_STREAM_URL = 'http://localhost:8000/stream';

// Suppress EPIPE errors on stdout/stderr — these fire as async stream errors
// when the parent terminal pipe closes (common in Electron dev mode).
process.stdout.on('error', (err) => { if (err.code !== 'EPIPE') throw err; });
process.stderr.on('error', (err) => { if (err.code !== 'EPIPE') throw err; });

// ─────────────────────────────────────────────────────────────────────────────
// WIDEVINE CDM — load from local Chrome install for DRM streaming services
// Must be called before app 'ready'. Silently skips if Chrome is not found.
// ─────────────────────────────────────────────────────────────────────────────

(function loadWidevine() {
  const chromeBase = 'C:\\Program Files\\Google\\Chrome\\Application';
  if (!fs.existsSync(chromeBase)) return;
  try {
    const versions = fs.readdirSync(chromeBase).filter(d => /^\d+\.\d+/.test(d));
    if (!versions.length) return;
    versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    const widevineDll = path.join(
      chromeBase, versions[0],
      'WidevineCdm', '_platform_specific', 'win_x64', 'widevinecdm.dll'
    );
    if (!fs.existsSync(widevineDll)) return;
    const manifestPath = path.join(chromeBase, versions[0], 'WidevineCdm', 'manifest.json');
    const cdmVersion = fs.existsSync(manifestPath)
      ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')).version
      : '4.10.2557.0';
    app.commandLine.appendSwitch('widevine-cdm-path', widevineDll);
    app.commandLine.appendSwitch('widevine-cdm-version', cdmVersion);
    console.log('[AURA] Widevine CDM loaded v' + cdmVersion);
  } catch (err) {
    console.warn('[AURA] Widevine CDM load failed:', err.message);
  }
})();

// ─────────────────────────────────────────────────────────────────────────────
// WINDOW REGISTRY
// ─────────────────────────────────────────────────────────────────────────────

/** @type {BrowserWindow|null} */
let mainWindow = null;

/** @type {Map<string, BrowserWindow>} panelId → window */
const popOutWindows = new Map();

/** @type {BrowserWindow|null} */
let theatreWindow = null;

// ─────────────────────────────────────────────────────────────────────────────
// BACKEND PROCESS
// ─────────────────────────────────────────────────────────────────────────────

/** @type {import('child_process').ChildProcess|null} */
let backendProcess = null;

// ─────────────────────────────────────────────────────────────────────────────
// CONTEXT MENU — shared by main window and all pop-outs
// ─────────────────────────────────────────────────────────────────────────────

function attachContextMenu(win) {
  win.webContents.on('context-menu', (_evt, params) => {
    const menuItems = [];

    // Spell-check suggestions
    if (params.misspelledWord) {
      if (params.dictionarySuggestions.length > 0) {
        params.dictionarySuggestions.slice(0, 6).forEach(suggestion => {
          menuItems.push({
            label: suggestion,
            click: () => win.webContents.replaceMisspelling(suggestion),
          });
        });
      } else {
        menuItems.push({ label: 'No suggestions', enabled: false });
      }
      menuItems.push({ type: 'separator' });
      menuItems.push({
        label: 'Add to dictionary',
        click: () => win.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
      });
      menuItems.push({ type: 'separator' });
    }

    // Standard edit actions — only show what's relevant
    if (params.selectionText) {
      menuItems.push({ role: 'copy' });
    }
    if (params.isEditable) {
      if (params.selectionText) {
        menuItems.push({ role: 'cut' });
      }
      menuItems.push({ role: 'paste' });
      menuItems.push({ role: 'selectAll' });
    }

    if (menuItems.length === 0) return;
    Menu.buildFromTemplate(menuItems).popup({ window: win });
  });
}

function spawnBackend() {
  // Use project-relative path when running from source, packaged path otherwise
  const backendDir = app.isPackaged
    ? path.join(process.resourcesPath, 'backend')
    : path.join(__dirname, '../backend');
  console.info('[main] Backend dir:', backendDir, '| exists:', fs.existsSync(backendDir));

  // Windows: add Python to PATH; Unix: use 'python3'
  let pythonCmd = 'python3';
  let env = { ...process.env };

  if (process.platform === 'win32') {
    pythonCmd = 'python';
    const pythonDir = 'C:/Users/azrae/AppData/Local/Programs/Python/Python313';
    // Prepend Python directory to PATH so 'python' is found
    env.PATH = `${pythonDir};${env.PATH || ''}`;
    console.info('[main] Added to PATH:', pythonDir);
  }

  console.info('[main] Using Python command:', pythonCmd);

  backendProcess = spawn(
    pythonCmd,
    ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', '8000'],
    {
      cwd:   backendDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env:   env,
    }
  );

  backendProcess.stdout?.on('data', (data) => {
    try { process.stdout.write('[backend] ' + data.toString()); } catch {}
  });

  backendProcess.stderr?.on('data', (data) => {
    try { process.stderr.write('[backend] ' + data.toString()); } catch {}
  });

  backendProcess.on('error', (err) => {
    console.error('[main] Failed to spawn backend:', err.code, '—', err.message);
    console.error('[main] Full error:', err);
    console.error('[main] Is Python + uvicorn installed? Run: pip install uvicorn fastapi');
    backendProcess = null;
  });

  backendProcess.on('close', (code) => {
    if (code !== 0 && code !== null) {
      console.warn(`[main] Backend exited with code ${code}`);
    }
    backendProcess = null;
  });

  console.info('[main] Backend spawned — waiting for uvicorn to start...');
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN WINDOW
// ─────────────────────────────────────────────────────────────────────────────

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width:          1440,
    height:         900,
    minWidth:       900,
    minHeight:      600,

    // Frameless — TitleBar.jsx handles the custom chrome
    frame:          false,
    titleBarStyle:  'hidden',  // macOS: hide traffic lights
    trafficLightPosition: { x: 12, y: 10 },  // macOS: reposition traffic lights

    // Prevents white flash before renderer paints
    backgroundColor: '#030810',

    show: false,  // Show in 'ready-to-show' to prevent flash
    movable:        true,  // Windows/Linux: explicitly enable dragging

    webPreferences: {
      preload:          PRELOAD_PATH,
      contextIsolation: true,   // Security: renderer cannot access Node.js APIs
      nodeIntegration:  false,  // Security: Node.js not available in renderer
      sandbox:          false,  // Allow preload script (relaxed sandbox)
      webSecurity:      true,
      webviewTag:       true,   // Allow <webview> for embedded dashboards (Phoenix)
      // Allow devTools in dev; can be disabled in prod if desired
      devTools:         true,
    },
  });

  // ── Load renderer ──
  if (IS_DEV) {
    mainWindow.loadURL(RENDERER_URL).catch(err => {
      console.error('[main] Failed to load Vite dev server. Is `npm run dev:renderer` running?', err.message);
    });
    // Open DevTools detached so they don't distort the UI
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(RENDERER_HTML);
    // Open DevTools for debugging (remove before shipping)
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  // ── Show once fully painted ──
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  // ── Forward maximize state to renderer (TitleBar icon sync) ──
  mainWindow.on('maximize',   () => mainWindow?.webContents.send('window:maximized'));
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('window:unmaximized'));

  // ── Cleanup ──
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // ── Prevent renderer from navigating away from the app ──
  mainWindow.webContents.on('will-navigate', (evt, url) => {
    if (IS_DEV && url.startsWith(RENDERER_URL)) return; // allow Vite HMR
    evt.preventDefault();
    if (url.startsWith('https://') || url.startsWith('http://')) {
      shell.openExternal(url);  // Open external links in system browser
    }
  });

  // Prevent new windows opened from the renderer (e.g. <a target="_blank">)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // ── Native context menu — spell-check suggestions + copy/paste ──
  attachContextMenu(mainWindow);
}

// ─────────────────────────────────────────────────────────────────────────────
// THEATRE WINDOW
// ─────────────────────────────────────────────────────────────────────────────

function createTheatreWindow() {
  if (theatreWindow && !theatreWindow.isDestroyed()) {
    theatreWindow.focus();
    return;
  }

  theatreWindow = new BrowserWindow({
    width:           1280,
    height:          800,
    minWidth:        800,
    minHeight:       500,
    frame:           false,
    backgroundColor: '#030810',
    show:            false,
    webPreferences: {
      preload:          PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          false,
      webSecurity:      true,
      webviewTag:       true,   // <webview> required for streaming services
    },
  });

  if (IS_DEV) {
    theatreWindow.loadURL(`${RENDERER_URL}?mode=theatre`);
  } else {
    theatreWindow.loadFile(RENDERER_HTML, { query: { mode: 'theatre' } });
  }

  // Allow DRM (Widevine) and media permissions for the theatre session
  const theatreSes = session.fromPartition('persist:theatre');
  theatreSes.setPermissionRequestHandler((_wc, _permission, callback) => callback(true));

  theatreWindow.once('ready-to-show', () => theatreWindow?.show());
  theatreWindow.on('closed', () => { theatreWindow = null; });

  // New windows from service webviews — open in the same webview (deny creates a new BrowserWindow)
  theatreWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  attachContextMenu(theatreWindow);
}

// ─────────────────────────────────────────────────────────────────────────────
// PANEL POP-OUT WINDOWS
// ─────────────────────────────────────────────────────────────────────────────

function createPopOutWindow(panelId) {
  if (popOutWindows.has(panelId)) {
    popOutWindows.get(panelId)?.focus();
    return;
  }

  const win = new BrowserWindow({
    width:           480,
    height:          640,
    minWidth:        320,
    minHeight:       400,
    frame:           false,
    backgroundColor: '#030810',
    webPreferences: {
      preload:          PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          false,
    },
  });

  if (IS_DEV) {
    win.loadURL(`${RENDERER_URL}?panel=${panelId}`);
  } else {
    win.loadFile(RENDERER_HTML, { query: { panel: panelId } });
  }

  attachContextMenu(win);
  popOutWindows.set(panelId, win);
  win.on('closed', () => {
    popOutWindows.delete(panelId);
    // Notify the main renderer so it can restore the sidebar (or whatever was hidden)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('panel:pop-out-closed', panelId);
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// IPC HANDLERS
// ─────────────────────────────────────────────────────────────────────────────

// ── Window controls ──
ipcMain.on('window:minimize', () => mainWindow?.minimize());

ipcMain.on('window:maximize-restore', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.restore();
  else mainWindow.maximize();
});

ipcMain.on('window:close', () => mainWindow?.close());

ipcMain.handle('window:is-maximized', () => mainWindow?.isMaximized() ?? false);

// ── Theatre window ──
ipcMain.on('theatre:open', () => createTheatreWindow());

// ── Theatre: launch service in Chrome app-mode (full DRM, no browser UI) ──
ipcMain.handle('theatre:open-service', async (_evt, url) => {
  const chromePaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
  ];
  const chromePath = chromePaths.find(p => fs.existsSync(p));
  if (chromePath) {
    spawn(chromePath, ['--app=' + url, '--new-window'], { detached: true, stdio: 'ignore' }).unref();
    return 'app';
  }
  shell.openExternal(url);
  return 'external';
});

// ── Panel pop-outs ──
ipcMain.on('panel:pop-out', (_evt, panelId) => {
  createPopOutWindow(panelId);
});

ipcMain.on('panel:close-pop-out', (evt) => {
  // Close the pop-out window that sent this message
  const win = BrowserWindow.fromWebContents(evt.sender);
  if (win) {
    win.close();
  }
});

// ── Pop-out window controls (portrait mode + always-on-top) ──
ipcMain.handle('window:set-portrait-mode', (event, enable) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  if (enable) {
    const display = screen.getDisplayNearestPoint(win.getBounds());
    const { height } = display.workAreaSize;
    const [x] = win.getPosition();
    win.setSize(480, height);
    win.setPosition(x, 0);
  } else {
    win.setSize(480, 640);
  }
});

ipcMain.handle('window:toggle-always-on-top', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return false;
  const next = !win.isAlwaysOnTop();
  win.setAlwaysOnTop(next);
  return next;
});

ipcMain.handle('window:is-always-on-top', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  return win?.isAlwaysOnTop() ?? false;
});

// ── Backend config ──
ipcMain.handle('config:stream-url', () => {
  return process.env.AURA_STREAM_URL ?? DEFAULT_STREAM_URL;
});

// ── Shell — open URL in default system browser ──
ipcMain.handle('shell:open-external', (_evt, url) => {
  // Validate URL is http(s) before opening
  if (typeof url === 'string' && /^https?:\/\//.test(url)) {
    shell.openExternal(url);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// APP LIFECYCLE
// ─────────────────────────────────────────────────────────────────────────────

// Force dark color scheme — prevents any light-mode flash from OS theme
nativeTheme.themeSource = 'dark';

app.whenReady().then(() => {
  spawnBackend();
  createMainWindow();

  // ── Push-to-talk global shortcut ─────────────────────────────────────────
  // Ctrl+Alt+Space toggles mic recording in the Chat panel.
  // Fires 'voice:ptt-toggle' to the renderer — Chat.jsx handles start/stop.
  globalShortcut.register('Ctrl+Alt+Space', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('voice:ptt-toggle');
    }
  });

  // macOS: re-create window when dock icon is clicked and no windows are open
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

// Gracefully shut down backend before quitting
app.on('before-quit', async (event) => {
  if (backendProcess) {
    event.preventDefault();
    console.info('[main] Requesting graceful backend shutdown...');
    try {
      await fetch('http://127.0.0.1:8000/shutdown', {
        method: 'POST',
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      // Backend already down or unreachable — proceed to force-kill
    }
    // Force-kill fallback after 3s, then re-trigger quit
    setTimeout(() => {
      if (backendProcess) {
        console.info('[main] Force-killing backend process...');
        backendProcess.kill();
        backendProcess = null;
      }
      app.quit();
    }, 3000);
  }
});

// Deregister global shortcuts before quitting
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

// Windows/Linux: quit when all windows are closed
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Security: allow webviews only from the theatre window; block all others.
// Also enforce safe attributes on theatre webviews (no nodeIntegration).
app.on('web-contents-created', (_evt, contents) => {
  contents.on('will-attach-webview', (evt, webPreferences) => {
    if (theatreWindow && !theatreWindow.isDestroyed() && contents === theatreWindow.webContents) {
      // Enforce safe defaults on the webview regardless of what the renderer requested
      webPreferences.nodeIntegration = false;
      webPreferences.contextIsolation = true;
      return; // allow
    }
    evt.preventDefault(); // block webviews from all other windows
  });
});
