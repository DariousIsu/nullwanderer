/* smoke_meet_canvas_chat.js — the canvas driver's chat post (p177 catch: "intro post failed:
 * chat input not found"). The old probe knew only <textarea>; current Meet renders the chat input
 * as a rich contenteditable TEXTBOX, so the intro died on a healthy panel. Pins: both input shapes,
 * the slow-panel second window, the toggle-safety rule (a LANDED chat click is never re-clicked —
 * re-clicking toggles the panel CLOSED), the precise failure reason, and the Enter dispatch.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_meet_canvas_chat.js
 */
'use strict';
const { createMeetDriver } = require('../lib/meet_canvas');

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name); } };

// A scripted webContents: routes each executeJavaScript by its JS body, per-scenario.
function fakeWC(script) {
  const log = { clicks: [], sets: 0, events: [] };
  return {
    log,
    async executeJavaScript(js) {
      if (/role="button"/.test(js)) {                       // clickByLabelJS
        const labels = /chat with everyone/.test(js) ? 'chat-button' : 'send-button';
        log.clicks.push(labels);
        return script.click(labels, log.clicks.filter((c) => c === labels).length);
      }
      if (/HTMLTextAreaElement/.test(js)) { log.sets++; return script.set(log.sets); }   // _chatSetJS
      if (/trim\(\)\.length/.test(js)) return script.residue || false;                   // residue probe
      return null;
    },
    sendInputEvent(ev) { log.events.push(ev); },
    loadURL: async () => {},
  };
}

(async () => {
  // 1. the textarea shape still works, first try
  const wc1 = fakeWC({ click: () => 'chat', set: () => 'textarea' });
  const d1 = createMeetDriver(() => wc1);
  const r1 = await d1.postChat('hello from Zoe');
  ok(r1.ok === true && r1.via === 'textarea', 'textarea shape posts on the first window');
  ok(wc1.log.events.some((e) => e.type === 'keyDown' && e.keyCode === 'Return'), 'Enter is dispatched after the set');

  // 2. the RICH TEXTBOX shape (the p177 miss) lands on the second window — and the landed
  //    chat click is NOT repeated (the toggle hazard)
  const wc2 = fakeWC({ click: () => 'chat', set: (n) => (n === 1 ? '' : 'textbox'), residue: true });
  const d2 = createMeetDriver(() => wc2);
  const r2 = await d2.postChat('hello again');
  ok(r2.ok === true && r2.via === 'textbox', 'contenteditable textbox shape posts on the second window (the p177 catch, cured)');
  ok(wc2.log.clicks.filter((c) => c === 'chat-button').length === 1, 'a LANDED chat click is never re-clicked (re-clicking would toggle the panel closed)');
  ok(wc2.log.clicks.includes('send-button'), 'residual text after Enter falls back to the Send button');

  // 3. the chat button itself missing → one retry of the click, then a reason that names it
  const wc3 = fakeWC({ click: () => '', set: () => '' });
  const d3 = createMeetDriver(() => wc3);
  const r3 = await d3.postChat('nobody home');
  ok(r3.ok === false && /NOT found/.test(r3.reason), 'both probes missing → ok:false with a reason naming the un-found chat button');
  ok(wc3.log.clicks.filter((c) => c === 'chat-button').length === 2, 'an un-landed chat click IS retried once (labels can render late)');

  // 4. click landed but Meet's DOM shifted past both probes → the reason says the click landed
  const wc4 = fakeWC({ click: () => 'chat', set: () => '' });
  const d4 = createMeetDriver(() => wc4);
  const r4 = await d4.postChat('shifted DOM');
  ok(r4.ok === false && /clicked: "chat"/.test(r4.reason), 'probes missing on an OPEN panel → the reason says the click landed (DOM shifted, not panel closed)');

  console.log(`\nsmoke_meet_canvas_chat: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
