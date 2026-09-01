/**
 * studio/studio_supervisor.js — adopt-or-spawn the Clip/Image Studio HTTP server (:8790).
 *
 * The workspace sidebar's "Clip Studio" and "Image Studio" surfaces are <webview>s that load
 * http://127.0.0.1:8790 (and /image). For them to work when the app runs, that server must be up.
 * This mirrors the engine's adopt-or-spawn: if :8790 already answers, do nothing; otherwise spawn
 * studio/server.js as a child (using Electron-as-Node so no system `node` is required) and own it.
 *
 * Wire it from main.js with a single call inside createWorkspaceWindow(), e.g.:
 *     require('./studio/studio_supervisor').ensure();
 * It is fail-soft and idempotent — safe to call every time the workspace opens.
 */
'use strict';
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const PORT = parseInt(process.env.ZOE_STUDIO_PORT || '8790', 10);
const ROOT = path.resolve(__dirname, '..');
let _child = null;

function alive() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/jobs', timeout: 1500 }, (res) => {
      res.resume(); resolve(res.statusCode > 0);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function ensure() {
  try {
    if (await alive()) return { ok: true, adopted: true };
    if (_child && !_child.killed) return { ok: true, spawning: true };
    // Electron-as-Node: run server.js with the app's own binary so no external `node` is needed.
    _child = spawn(process.execPath, [path.join(ROOT, 'studio', 'server.js')], {
      cwd: ROOT,
      env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }),
      stdio: 'ignore',
      windowsHide: true,
      detached: false,
    });
    _child.on('exit', () => { _child = null; });
    _child.unref?.();
    return { ok: true, spawned: true };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}

function stop() { try { if (_child && !_child.killed) _child.kill(); } catch { /* */ } _child = null; }

module.exports = { ensure, stop, alive, PORT };
