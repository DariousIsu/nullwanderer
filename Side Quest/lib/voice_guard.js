/**
 * lib/voice_guard.js — detection for the always-on-mic "pause during meetings/calls" guards.
 *
 * The always-on voice loop must NOT capture the room (and Zoe must NOT speak aloud) while Lucas is in a
 * meeting or on a call. Three sources feed one "paused" state in main.js: a MANUAL toggle/hotkey (the
 * reliable backstop — the only thing that covers a call on his physical phone), MEETING-APP detection
 * (this file), and CALENDAR-busy detection (this file). Manual overrides everything.
 *
 * Design bias: auto-detect is CONSERVATIVE. A false positive silently kills the voice (confusing), so we
 * only fire on high-confidence in-call signals; a miss is fine because the manual hotkey is always there.
 * Everything fail-soft → resolves to null/false, never throws.
 */
'use strict';
const { execFile } = require('child_process');

// Is the operator in a MEETING/CALL app right now? Resolves to a short reason string (e.g. 'Zoom') or null.
// Windows-only heuristic: the FOREGROUND window title, plus a few unambiguous in-call window titles that
// exist even when not foreground (e.g. Zoom's dedicated "Zoom Meeting" window). Fail-soft → null.
function detectMeetingApp() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(null);
    const ps = [
      '$fg = ""',
      'try {',
      '  Add-Type @"',
      'using System; using System.Runtime.InteropServices; using System.Text;',
      'public class FGW { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
      '[DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n); }',
      '"@ -ErrorAction SilentlyContinue',
      '  $h=[FGW]::GetForegroundWindow(); $sb=New-Object System.Text.StringBuilder 512; [void][FGW]::GetWindowText($h,$sb,512); $fg=$sb.ToString()',
      '} catch {}',
      '$t = (Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object -ExpandProperty MainWindowTitle) -join "`n"',
      'Write-Output ("FG::" + $fg); Write-Output $t',
    ].join('; ');
    try {
      execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 8000, windowsHide: true }, (err, stdout) => {
        if (err || !stdout) return resolve(null);
        const lines = stdout.split(/\r?\n/);
        const fg = (lines.find((l) => l.startsWith('FG::')) || '').slice(4);
        // Strong signal: the ACTIVE window is a meeting/call surface.
        const fgPatterns = [
          [/zoom meeting/i, 'Zoom'],
          [/(google meet|meet\s*[-–]\s|\bmeet\.google\b)/i, 'Google Meet'],
          [/microsoft teams|teams meeting|teams call/i, 'Teams'],
          [/webex/i, 'Webex'],
          [/\bhuddle\b/i, 'Slack huddle'],
          [/\bdiscord\b/i, 'Discord'],
          [/phone link|your phone|phonelink/i, 'Phone Link'],
        ];
        for (const [re, name] of fgPatterns) { if (re.test(fg)) return resolve(name); }
        // Weaker but unambiguous: Zoom's separate meeting window exists even when not foreground.
        if (/zoom meeting/i.test(stdout)) return resolve('Zoom');
        return resolve(null);
      });
    } catch { resolve(null); }
  });
}

// Is a (busy, non-declined, non-all-day) calendar event happening RIGHT NOW? Resolves to the event summary
// (string) if busy, false if free, or null if we can't tell (not connected / error). Fail-soft.
async function isCalendarBusy(gcal, opts) {
  try {
    if (!gcal || typeof gcal.isConnected !== 'function' || !gcal.isConnected(opts)) return null;
    const now = Date.now();
    const timeMin = new Date(now - 60000).toISOString();
    const timeMax = new Date(now + 60000).toISOString();
    const raw = await gcal.listEvents({ calendarId: 'primary', timeMin, timeMax, maxResults: 15, singleEvents: true, orderBy: 'startTime' }, opts);
    const items = Array.isArray(raw) ? raw : ((raw && raw.items) || []);
    for (const ev of items) {
      if (!ev || ev.status === 'cancelled') continue;
      if (ev.transparency === 'transparent') continue;              // "free"/available events don't count
      if (ev.start && ev.start.date && !ev.start.dateTime) continue; // all-day events don't count
      const startStr = ev.start && ev.start.dateTime;
      const endStr = ev.end && (ev.end.dateTime || ev.end.date);
      if (!startStr || !endStr) continue;
      const me = (ev.attendees || []).find((a) => a && a.self);
      if (me && me.responseStatus === 'declined') continue;         // he declined → not in it
      const s = new Date(startStr).getTime(), e = new Date(endStr).getTime();
      if (s <= now && now < e) return (ev.summary || 'meeting');
    }
    return false;
  } catch (e) { return null; }
}

// ── THE GUARD STATE (queue #6, 2026-08-14): one 'paused' seat over the always-on voice loop. ──────────
// Poll-driven: main calls evaluate() on a slow tick; the mic door (stt:transcribe) and the aloud door
// (_speech.enqueue) read state() synchronously. Manual overrides everything — 'pause'/'resume' hold until
// 'auto' hands control back to detection. Priority in auto: her OWN meeting (in-app state, cheapest and
// highest-confidence) > meeting-app window > calendar-busy. A detector that throws keeps the PRIOR state
// (fail-soft — never flaps the voice on a transient error). onChange fires on TRANSITIONS only, so a
// chatty room can't spam the log. All deps injectable for smokes.
function createGuard({ detectApp = detectMeetingApp, calendarBusy = null, selfMeeting = null, onChange = null } = {}) {
  const st = { mode: 'auto', paused: false, reason: null };
  const _set = (paused, reason) => {
    if (st.paused === paused && st.reason === reason) return;
    st.paused = paused; st.reason = reason;
    try { if (onChange) onChange({ ...st }); } catch {}
  };
  return {
    state: () => ({ ...st }),
    manual(mode) {
      if (mode === 'pause') { st.mode = 'manual'; _set(true, 'manual'); }
      else if (mode === 'resume') { st.mode = 'manual'; _set(false, null); }
      else st.mode = 'auto';   // detection decides again on the next evaluate()
      return { ...st };
    },
    async evaluate() {
      if (st.mode !== 'auto') return { ...st };
      try {
        const self = selfMeeting ? selfMeeting() : null;
        if (self) { _set(true, `her meeting (${self})`); return { ...st }; }
        const inApp = detectApp ? await detectApp() : null;
        if (inApp) { _set(true, `meeting app (${inApp})`); return { ...st }; }
        const cal = calendarBusy ? await calendarBusy() : null;
        if (cal) { _set(true, `calendar (${String(cal).slice(0, 60)})`); return { ...st }; }
        _set(false, null);
      } catch { /* fail-soft: keep the prior state */ }
      return { ...st };
    },
  };
}

module.exports = { detectMeetingApp, isCalendarBusy, createGuard };
