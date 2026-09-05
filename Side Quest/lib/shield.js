/**
 * lib/shield.js — THE COVER (the stranger act, design §4.5b; Lucas 09-05: "move to defend the information on her
 * screens" · after boot_p309: "it should black out all screens and also speak to the person"). When the
 * consciousness subroutine says `shield`, EVERY DISPLAY gets an opaque always-on-top cover window (over
 * everything, his other apps included) and every one of her windows gets an in-page overlay as well (so a cover
 * window that cannot be created still leaves nothing of hers readable); `unshield` removes both. Pure where it
 * can be: the injected script and the cover page are functions of {who}; electron's screen/BrowserWindow are deps.
 */
const SHIELD_ID = 'zoe-shield';

function _line(who) {
  return who ? `Hi ${String(who).replace(/[<>"'`\\]/g, '')}. Lucas is away, so his screens are covered while we talk.` : 'Lucas is away, so his screens are covered. Tell me who you are and how I can help.';
}
function coverScript({ who = null } = {}) {
  const line = _line(who);
  return `(function(){try{var d=document;var o=d.getElementById('${SHIELD_ID}');if(!o){o=d.createElement('div');o.id='${SHIELD_ID}';o.setAttribute('role','dialog');o.style.cssText='position:fixed;inset:0;z-index:2147483647;background:#0b0f14;color:#e6edf3;display:flex;align-items:center;justify-content:center;flex-direction:column;font:16px/1.5 system-ui,sans-serif;text-align:center;padding:24px;user-select:none;cursor:default;';var h=d.createElement('div');h.style.cssText='font-size:28px;font-weight:600;letter-spacing:.02em;margin-bottom:12px;';h.textContent='Zoe';var p=d.createElement('div');p.id='${SHIELD_ID}-line';p.style.maxWidth='36em';o.appendChild(h);o.appendChild(p);(d.body||d.documentElement).appendChild(o);}var q=d.getElementById('${SHIELD_ID}-line');if(q)q.textContent=${JSON.stringify(line)};return true;}catch(e){return false;}})()`;
}
function uncoverScript() {
  return `(function(){try{var o=document.getElementById('${SHIELD_ID}');if(o&&o.parentNode)o.parentNode.removeChild(o);return true;}catch(e){return false;}})()`;
}
/** The cover page for a whole display — black, her name, the line; nothing else. */
function coverPage({ who = null } = {}) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!doctype html><meta charset="utf-8"><title>Zoe</title><style>html,body{margin:0;height:100%;background:#000;color:#e6edf3;font:18px/1.5 system-ui,sans-serif;overflow:hidden;cursor:none;user-select:none}main{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:32px}h1{font-size:34px;font-weight:600;letter-spacing:.02em;margin:0 0 14px}p{max-width:36em;margin:0;opacity:.9}</style><main><h1>Zoe</h1><p>${esc(_line(who))}</p></main>`;
}

let _state = { on: false, since: null, who: null };
let _covers = [];
function state() { return { ..._state, displays: _covers.length }; }

function _electron(deps) { if (deps.electron) return deps.electron; try { return require('electron'); } catch { return null; } }

/** One always-on-top cover per display. Returns how many were created. */
function _coverDisplays({ who, deps }) {
  const el = _electron(deps);
  if (!el || !el.screen || !el.BrowserWindow) return 0;
  const displays = (() => { try { return el.screen.getAllDisplays() || []; } catch { return []; } })();
  let n = 0;
  for (const d of displays) {
    try {
      const b = d.bounds || { x: 0, y: 0, width: 800, height: 600 };
      const w = new el.BrowserWindow({ x: b.x, y: b.y, width: b.width, height: b.height, frame: false, alwaysOnTop: true, skipTaskbar: true, focusable: false, resizable: false, movable: false, minimizable: false, show: false, backgroundColor: '#000000', webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
      try { w.setAlwaysOnTop(true, 'screen-saver'); } catch {}
      try { w.setVisibleOnAllWorkspaces && w.setVisibleOnAllWorkspaces(true); } catch {}
      try { w.setFullScreen && w.setFullScreen(true); } catch {}
      try { w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(coverPage({ who }))); } catch {}
      try { w.showInactive ? w.showInactive() : w.show(); } catch {}
      _covers.push(w); n++;
    } catch {}
  }
  return n;
}
function _uncoverDisplays() {
  let n = 0;
  for (const w of _covers) { try { if (!(w.isDestroyed && w.isDestroyed())) { w.close(); n++; } } catch {} }
  _covers = [];
  return n;
}

async function cover({ who = null, deps = {} } = {}) {
  const el = _electron(deps);
  const wins = deps.windows || (() => { try { return (el && el.BrowserWindow && el.BrowserWindow.getAllWindows()) || []; } catch { return []; } })();
  let n = 0;
  for (const w of wins) {
    try { if (w.isDestroyed && w.isDestroyed()) continue; const wc = w.webContents; if (!wc || (wc.isDestroyed && wc.isDestroyed())) continue; await wc.executeJavaScript(coverScript({ who }), true); n++; } catch {}
  }
  const displays = _state.on ? _covers.length : _coverDisplays({ who, deps });
  _state = { on: true, since: deps.now || Date.now(), who: who || null };
  (deps.log || console.log)(`[shield] covered ${displays} display(s) and ${n} window(s)${who ? ` for ${who}` : ''}`);
  return { ok: true, windows: n, displays };
}
async function uncover({ deps = {} } = {}) {
  const el = _electron(deps);
  const wins = deps.windows || (() => { try { return (el && el.BrowserWindow && el.BrowserWindow.getAllWindows()) || []; } catch { return []; } })();
  const displays = _uncoverDisplays();
  let n = 0;
  for (const w of wins) {
    try { if (w.isDestroyed && w.isDestroyed()) continue; const wc = w.webContents; if (!wc || (wc.isDestroyed && wc.isDestroyed())) continue; await wc.executeJavaScript(uncoverScript(), true); n++; } catch {}
  }
  _state = { on: false, since: null, who: null };
  (deps.log || console.log)(`[shield] uncovered ${displays} display(s) and ${n} window(s)`);
  return { ok: true, windows: n, displays };
}

module.exports = { cover, uncover, state, coverScript, uncoverScript, coverPage, SHIELD_ID };
