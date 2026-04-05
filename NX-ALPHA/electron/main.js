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

const { app, BrowserWindow, ipcMain, shell, nativeTheme, screen, globalShortcut, Menu, session, components } = require('electron');
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

// Force ANGLE to D3D11 — prevents AMD driver timeouts (TDR) with OpenGL
app.commandLine.appendSwitch('use-angle', 'd3d11');

// Suppress EPIPE errors on stdout/stderr — these fire as async stream errors
// when the parent terminal pipe closes (common in Electron dev mode).
process.stdout.on('error', (err) => { if (err.code !== 'EPIPE') throw err; });
process.stderr.on('error', (err) => { if (err.code !== 'EPIPE') throw err; });

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

  // Configure the theatre session: spoof Chrome UA + client hints so streaming
  // services (Netflix, Paramount+, etc.) don't detect Electron and block DRM.
  const theatreSes = session.fromPartition('persist:theatre');
  const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';
  theatreSes.setUserAgent(CHROME_UA);

  // Override Sec-CH-UA client hints — these expose "Electron" as a brand
  // even when the UA string is spoofed. Netflix checks these headers.
  if (theatreSes.setUserAgentMetadata) {
    theatreSes.setUserAgentMetadata({
      brands: [
        { brand: 'Chromium',      version: '134' },
        { brand: 'Google Chrome', version: '134' },
        { brand: 'Not-A.Brand',   version: '99'  },
      ],
      fullVersionList: [
        { brand: 'Chromium',      version: '134.0.6998.89' },
        { brand: 'Google Chrome', version: '134.0.6998.89' },
        { brand: 'Not-A.Brand',   version: '99.0.0.0'      },
      ],
      platform:        'Windows',
      platformVersion: '10.0.0',
      architecture:    'x86',
      model:           '',
      mobile:          false,
    });
  }

  theatreSes.setPermissionRequestHandler((_wc, _permission, callback) => callback(true));
  theatreSes.setPermissionCheckHandler(() => true);

  theatreWindow.on('maximize',   () => theatreWindow?.webContents.send('window:maximized'));
  theatreWindow.on('unmaximize', () => theatreWindow?.webContents.send('window:unmaximized'));
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

ipcMain.handle('window:is-maximized', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  return win?.isMaximized() ?? false;
});

// ── Theatre window ──
ipcMain.on('theatre:open',             () => createTheatreWindow());
ipcMain.on('theatre:minimize',         () => theatreWindow?.minimize());
ipcMain.on('theatre:maximize-restore', () => {
  if (!theatreWindow) return;
  theatreWindow.isMaximized() ? theatreWindow.restore() : theatreWindow.maximize();
});
ipcMain.on('theatre:close',            () => theatreWindow?.close());


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

// ── Neural Interface — folder picker for desktop ingestion ──
const { dialog } = require('electron');
ipcMain.handle('dialog:open-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'multiSelections'],
    title: 'Select folder(s) for ingestion',
  });
  return result.canceled ? [] : result.filePaths;
});

// ── Computer Use — confirmation dialog for risky actions ──
// Called by the backend when AURA wants to perform a destructive or
// interactive computer use action that requires user approval.
ipcMain.handle('computer-use:confirm', async (_evt, payload) => {
  const { action = 'perform an action', description = '', risk_level = 'normal' } = payload || {};
  const icon = risk_level === 'high' ? 'warning' : 'question';
  const result = await dialog.showMessageBox(mainWindow, {
    type: icon,
    title: 'AURA Computer Use',
    message: `AURA wants to: ${action}`,
    detail: description || 'Allow this action?',
    buttons: ['Allow', 'Deny'],
    defaultId: 1,   // Deny is the safer default
    cancelId: 1,
  });
  return { allowed: result.response === 0 };
});

// ─────────────────────────────────────────────────────────────────────────────
// APP LIFECYCLE
// ─────────────────────────────────────────────────────────────────────────────

// Force dark color scheme — prevents any light-mode flash from OS theme
nativeTheme.themeSource = 'dark';

app.whenReady().then(async () => {
  // Wait for castlabs Widevine CDM to be ready before creating windows
  await components.whenReady();
  spawnBackend();

  // Configure persist:station session — Chrome UA so sites don't block Electron
  const stationSes = session.fromPartition('persist:station');
  stationSes.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36');
  stationSes.setPermissionRequestHandler((_wc, _permission, callback) => callback(true));

  // Configure persist:haystack session — for Haystack.tv news feed webviews
  const haystackSes = session.fromPartition('persist:haystack');
  haystackSes.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36');
  haystackSes.setPermissionRequestHandler((_wc, _permission, callback) => callback(true));
  haystackSes.setPermissionCheckHandler(() => true);

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

// Security: allow webviews only from known windows (theatre + main).
// Enforce safe defaults — no nodeIntegration, contextIsolation on.
app.on('web-contents-created', (_evt, contents) => {
  contents.on('will-attach-webview', (evt, webPreferences) => {
    const isTheatre = theatreWindow && !theatreWindow.isDestroyed() && contents === theatreWindow.webContents;
    const isMain    = mainWindow    && !mainWindow.isDestroyed()    && contents === mainWindow.webContents;
    if (isTheatre || isMain) {
      webPreferences.nodeIntegration = false;
      webPreferences.contextIsolation = true;
      return; // allow
    }
    evt.preventDefault(); // block webviews from any other window
  });
});
