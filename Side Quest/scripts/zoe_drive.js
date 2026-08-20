/*
 * zoe_drive.js — drive the REAL desktop chat over CDP :9222 (types into #input, presses Enter),
 * then watch sq.db for the reply and tail the boot log for route/tool/anti-fab lines.
 *
 * Usage: electron (as node) zoe_drive.js <message-file.txt> [--cap=300] [--settle=6]
 *   message-file.txt: UTF-8 file containing the message to send.
 * Env: ZOE_BOOT_LOG (default boot_p49.log), ZOE_SQ_DIR (default the Side Quest dir).
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SQ = process.env.ZOE_SQ_DIR || 'C:/Users/azrae/Desktop/Side Quest';
const BOOT_LOG = process.env.ZOE_BOOT_LOG || path.join(SQ, 'boot_p49.log');
const STATE = path.join(__dirname, 'zoe_drive_state.json');
const D = require(path.join(SQ, 'node_modules', 'better-sqlite3'));

const args = process.argv.slice(2);
const msgFile = args.find((a) => !a.startsWith('--'));
const capS = parseInt((args.find((a) => a.startsWith('--cap=')) || '--cap=300').split('=')[1], 10);
const settleS = parseInt((args.find((a) => a.startsWith('--settle=')) || '--settle=6').split('=')[1], 10);
if (!msgFile || !fs.existsSync(msgFile)) { console.error('need a message file'); process.exit(2); }
const MSG = fs.readFileSync(msgFile, 'utf8').trim();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const INTEREST = /\[turn-router\]|\[operator\]|\[artifact-router\]|\[canvas-cmd\]|\[one-voice\]|\[anti-?fab/i;
const INTEREST2 = /route=|drove turn|intent=|\[recall|\[chain-guard|\[delivery|\[report-cmd\]|\[pull-up\]|Correction —|\[action\]|\[research|\[intake/i;

function logOffset() { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')).off || 0; } catch { return 0; } }
function saveOffset(off) { try { fs.writeFileSync(STATE, JSON.stringify({ off })); } catch {} }
function readNewLog() {
  try {
    const size = fs.statSync(BOOT_LOG).size;
    let off = logOffset();
    if (off > size) off = 0; // rotated
    if (size <= off) return [];
    const fd = fs.openSync(BOOT_LOG, 'r');
    const buf = Buffer.alloc(size - off);
    fs.readSync(fd, buf, 0, buf.length, off);
    fs.closeSync(fd);
    saveOffset(size);
    return buf.toString('utf8').split(/\r?\n/).filter(Boolean);
  } catch { return []; }
}

async function cdpSend(text) {
  const res = await fetch('http://127.0.0.1:9222/json');
  const targets = await res.json();
  const tgt = targets.find((t) => (t.url || '').includes('index.html') && t.webSocketDebuggerUrl);
  if (!tgt) throw new Error('no Zoe Lane target on :9222');
  const ws = new WebSocket(tgt.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  const send = (method, params = {}) => new Promise((resolve, reject) => { const mid = ++id; pending.set(mid, { resolve, reject }); ws.send(JSON.stringify({ id: mid, method, params })); });
  ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } });
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', () => j(new Error('CDP ws error'))); });
  await send('Runtime.enable');
  const expr = `(() => {
    const i = document.getElementById('input');
    if (!i) return { error: 'no #input' };
    if (i.disabled) return { error: 'input disabled — a turn is already in flight' };
    i.value = ${JSON.stringify(text)};
    i.dispatchEvent(new Event('input', { bubbles: true }));
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return { sent: true, disabledNow: i.disabled };
  })()`;
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  ws.close();
  if (r.exceptionDetails) throw new Error('evaluate threw: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result && r.result.value;
}

(async () => {
  const db = new D(path.join(SQ, 'data', 'sq.db'), { readonly: true });
  const maxTurn = () => db.prepare('select max(id) m from turns').get().m || 0;
  const t0Id = maxTurn();
  readNewLog(); // flush offset to now

  const t0 = Date.now();
  const sent = await cdpSend(MSG);
  if (!sent || sent.error) { console.error('SEND FAILED:', (sent && sent.error) || 'unknown'); process.exit(3); }
  console.log(`>> sent (${MSG.length} chars): ${JSON.stringify(MSG.slice(0, 100))}`);

  // watch for the user turn + the ai_said reply, then hold for console-quiet settle
  let firstSayTs = null, lastLogTs = Date.now(), logLines = [];
  let says = [];
  for (;;) {
    const now = Date.now();
    if ((now - t0) / 1000 > capS) { console.log(`\n!! CAP ${capS}s reached (settled=false)`); break; }
    const fresh = readNewLog();
    if (fresh.length) lastLogTs = now;
    for (const l of fresh) if (INTEREST.test(l) || INTEREST2.test(l)) logLines.push(l.slice(0, 300));
    const rows = db.prepare('select id, session_id, speaker, ts, content from turns where id > ? order by id').all(t0Id);
    says = rows.filter((r) => r.speaker === 'ai_said');
    if (says.length && !firstSayTs) firstSayTs = says[0].ts;
    if (says.length && (now - lastLogTs) / 1000 >= settleS) break;
    await sleep(1000);
  }
  const rows = db.prepare('select id, session_id, speaker, ts, content from turns where id > ? order by id').all(t0Id);
  console.log(`\n== turns landed (${rows.length}) ==`);
  for (const r of rows) console.log(`  #${r.id} [s${r.session_id}] ${r.speaker} +${((r.ts - t0) / 1000).toFixed(1)}s :: ${JSON.stringify((r.content || '').slice(0, 2000))}`);
  console.log(`\n== latency: first say ${firstSayTs ? ((firstSayTs - t0) / 1000).toFixed(1) + 's' : 'NONE'} | total ${((Date.now() - t0) / 1000).toFixed(1)}s ==`);
  console.log(`\n== log lines of interest (${logLines.length}) ==`);
  for (const l of logLines.slice(0, 80)) console.log('  ' + l);
})().catch((e) => { console.error('DRIVER ERROR:', e.message); process.exit(1); });
