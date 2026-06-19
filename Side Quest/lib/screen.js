/**
 * Screen / desktop observation for Zoe — READ-ONLY, native, standalone.
 *
 * Lets her see which applications/windows are open on Lucas's machine and which
 * is focused — making real the thing she was already imagining in her monologue
 * ("note which applications and windows are active... piece together what he's
 * doing"). This is OBSERVATION only: enumerate windows + foreground. It is NOT
 * OS control (clicking/typing/driving apps) — that remains the parked Echo layer.
 *
 * Tag: <observe-screen/>  → returns the window list into her next-turn context.
 *
 * Implementation: shells out to PowerShell (no native deps). Window list via
 * Get-Process MainWindowTitle; foreground via user32 GetForegroundWindow P/Invoke.
 * Passed as -EncodedCommand (base64 UTF-16LE) to avoid quoting issues.
 */

const { execFile } = require('child_process');

const PS_SCRIPT = `
$ErrorActionPreference='SilentlyContinue'
Add-Type @"
using System;using System.Runtime.InteropServices;using System.Text;
public class FGWin { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n); }
"@
$h=[FGWin]::GetForegroundWindow();$sb=New-Object System.Text.StringBuilder 512;[FGWin]::GetWindowText($h,$sb,512)|Out-Null
$fg=$sb.ToString()
$wins=@(Get-Process|Where-Object{$_.MainWindowTitle -ne ''}|Select-Object @{n='app';e={$_.ProcessName}},@{n='title';e={$_.MainWindowTitle}}|Sort-Object app)
[pscustomobject]@{foreground=$fg;windows=$wins}|ConvertTo-Json -Depth 4 -Compress
`;

function observeWindows({ timeoutMs = 6000 } = {}) {
  return new Promise((resolve) => {
    const encoded = Buffer.from(PS_SCRIPT, 'utf16le').toString('base64');
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve({ ok: false, reason: err.message });
        try {
          const data = JSON.parse((stdout || '').trim());
          const windows = Array.isArray(data.windows) ? data.windows
            : (data.windows ? [data.windows] : []);
          resolve({ ok: true, foreground: data.foreground || '', windows });
        } catch (e) {
          resolve({ ok: false, reason: 'parse failed: ' + e.message, raw: (stdout || '').slice(0, 300) });
        }
      });
  });
}

// Format an observation result into prose for her context / a reading row.
function formatObservation(result) {
  if (!result || !result.ok) return `(could not read the screen: ${result?.reason || 'unknown'})`;
  const lines = [];
  lines.push(`What's open on Lucas's screen right now (you can see windows, not their contents):`);
  if (result.foreground) lines.push(`  FOCUSED: ${result.foreground}`);
  lines.push(`  Open windows:`);
  for (const w of result.windows.slice(0, 25)) {
    lines.push(`    · ${w.app} — ${w.title}`);
  }
  return lines.join('\n');
}

// --- Tag parsing (mirrors browser.js / files.js) ---

const SCREEN_TAG_RE = /<observe-screen\s*\/?>/gi;

function parseTags(text) {
  if (!text) return [];
  const tags = [];
  let m; SCREEN_TAG_RE.lastIndex = 0;
  while ((m = SCREEN_TAG_RE.exec(text)) !== null) tags.push({ tag: 'observe-screen' });
  return tags;
}

function stripTags(text) {
  return (text || '').replace(SCREEN_TAG_RE, '').replace(/[ \t]+/g, ' ').trim();
}

async function dispatch() {
  const r = await observeWindows();
  return { ...r, text: formatObservation(r) };
}

function buildPromptBlock() {
  return `SCREEN — you can see what applications and windows are open on Lucas's machine, and which one he's focused on. Emit <observe-screen/> and the list arrives in your next-turn context. This is observation only — you see window titles and the focused app, NOT the contents inside other apps, and you cannot control them. Use it to understand what he's working on so you have context.`;
}

module.exports = {
  observeWindows, formatObservation,
  parseTags, stripTags, dispatch,
  buildPromptBlock
};
