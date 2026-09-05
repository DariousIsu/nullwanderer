/**
 * lib/shield.js — THE COVER (the stranger act, design §4.5b; Lucas 09-05: "move to defend the information on
 * her screens"). When the consciousness subroutine says `shield`, every window gets an opaque cover injected
 * over its content (no renderer has to know: main injects a fixed overlay by executeJavaScript); `unshield`
 * removes it. Pure where it can be: the injected script is a function of {who}; the windows are a dep.
 */
const SHIELD_ID = 'zoe-shield';

function coverScript({ who = null } = {}) {
  const line = who ? `Hi ${String(who).replace(/[<>"'`\\]/g, '')}. Lucas is away, so his screens are covered while we talk.` : 'Lucas is away, so his screens are covered. Tell me who you are and how I can help.';
  return `(function(){try{var d=document;var o=d.getElementById('${SHIELD_ID}');if(!o){o=d.createElement('div');o.id='${SHIELD_ID}';o.setAttribute('role','dialog');o.style.cssText='position:fixed;inset:0;z-index:2147483647;background:#0b0f14;color:#e6edf3;display:flex;align-items:center;justify-content:center;flex-direction:column;font:16px/1.5 system-ui,sans-serif;text-align:center;padding:24px;user-select:none;cursor:default;';var h=d.createElement('div');h.style.cssText='font-size:28px;font-weight:600;letter-spacing:.02em;margin-bottom:12px;';h.textContent='Zoe';var p=d.createElement('div');p.id='${SHIELD_ID}-line';p.style.maxWidth='36em';o.appendChild(h);o.appendChild(p);(d.body||d.documentElement).appendChild(o);}var q=d.getElementById('${SHIELD_ID}-line');if(q)q.textContent=${JSON.stringify(line)};return true;}catch(e){return false;}})()`;
}
function uncoverScript() {
  return `(function(){try{var o=document.getElementById('${SHIELD_ID}');if(o&&o.parentNode)o.parentNode.removeChild(o);return true;}catch(e){return false;}})()`;
}

let _state = { on: false, since: null, who: null };
function state() { return { ..._state }; }

async function cover({ who = null, deps = {} } = {}) {
  const wins = deps.windows || (() => { try { return require('electron').BrowserWindow.getAllWindows(); } catch { return []; } })();
  let n = 0;
  for (const w of wins) {
    try { if (w.isDestroyed && w.isDestroyed()) continue; const wc = w.webContents; if (!wc || (wc.isDestroyed && wc.isDestroyed())) continue; await wc.executeJavaScript(coverScript({ who }), true); n++; } catch {}
  }
  _state = { on: true, since: deps.now || Date.now(), who: who || null };
  (deps.log || console.log)(`[shield] covered ${n} window(s)${who ? ` for ${who}` : ''}`);
  return { ok: true, windows: n };
}
async function uncover({ deps = {} } = {}) {
  const wins = deps.windows || (() => { try { return require('electron').BrowserWindow.getAllWindows(); } catch { return []; } })();
  let n = 0;
  for (const w of wins) {
    try { if (w.isDestroyed && w.isDestroyed()) continue; const wc = w.webContents; if (!wc || (wc.isDestroyed && wc.isDestroyed())) continue; await wc.executeJavaScript(uncoverScript(), true); n++; } catch {}
  }
  _state = { on: false, since: null, who: null };
  (deps.log || console.log)(`[shield] uncovered ${n} window(s)`);
  return { ok: true, windows: n };
}

module.exports = { cover, uncover, state, coverScript, uncoverScript, SHIELD_ID };
