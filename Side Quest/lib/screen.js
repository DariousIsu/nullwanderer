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

// Window titles flow from the OS straight into her model context. A window or tab
// titled with tag-like text (e.g. "<email ...>" or "[thread-done:1]") would otherwise
// read as an instruction/control tag — prompt injection. Neutralize the structural
// characters before interpolating any title/foreground string into the output.
function sanitizeTitle(s) {
  return String(s == null ? '' : s)
    .replace(/</g, '‹').replace(/>/g, '›')
    .replace(/\[/g, '(').replace(/\]/g, ')');
}

// Format an observation result into prose for her context / a reading row.
function formatObservation(result) {
  if (!result || !result.ok) return `(could not read the screen: ${result?.reason || 'unknown'})`;
  const lines = [];
  lines.push(`What's open on Lucas's screen right now (you can see windows, not their contents):`);
  if (result.foreground) lines.push(`  FOCUSED: ${sanitizeTitle(result.foreground)}`);
  lines.push(`  Open windows:`);
  for (const w of result.windows.slice(0, 25)) {
    lines.push(`    · ${w.app} — ${sanitizeTitle(w.title)}`);
  }
  return lines.join('\n');
}

// --- Tag parsing (mirrors browser.js / files.js) ---

const SCREEN_TAG_RE = /<(observe-screen|screen-see)\s*\/?>/gi;

function parseTags(text) {
  if (!text) return [];
  const tags = [];
  let m; SCREEN_TAG_RE.lastIndex = 0;
  while ((m = SCREEN_TAG_RE.exec(text)) !== null) tags.push({ tag: m[1].toLowerCase() });
  return tags;
}

function stripTags(text) {
  return (text || '').replace(SCREEN_TAG_RE, '').replace(/[ \t]+/g, ' ').trim();
}

async function dispatch() {
  const r = await observeWindows();
  return { ...r, text: formatObservation(r) };
}

// Did Lucas ask her to LOOK AT his screen / an on-screen image? High-precision, so the chat turn
// can auto-capture + describe when she'd otherwise just CLAIM she sees it (the confabulation seen
// in the logs: "I can see the image on your screen" with no actual screenshot).
function detectScreenSightRequest(text) {
  const s = String(text || '');
  if (/\bon (?:my|the|your) screen\b/i.test(s)) return true;
  if (/\b(see|look at|view|describe|read|what'?s on|check)\b[^.?!]*\b(screen|monitor|display)\b/i.test(s)) return true;
  if (/\bpulled up\b/i.test(s) && /\b(see|look|picture|image|photo|it|this)\b/i.test(s)) return true;
  return false;
}

// Visually SEE the screen — a real screenshot (Electron desktopCapturer) as base64 PNG, so a
// vision model can describe what's actually on Lucas's display. Model-free; main runs it through
// lib/vision. Distinct from <observe-screen/> (which only lists window titles).
async function capture() {
  try {
    const { desktopCapturer } = require('electron');
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1280, height: 720 } });
    if (!sources || !sources.length) return { ok: false, reason: 'no screen source available' };
    const b64 = sources[0].thumbnail.toPNG().toString('base64');
    if (!b64) return { ok: false, reason: 'empty screenshot' };
    return { ok: true, base64: b64, label: sources[0].name || 'the screen' };
  } catch (e) { return { ok: false, reason: e.message }; }
}

function buildPromptBlock() {
  return `SCREEN — you can see Lucas's screen two ways. <observe-screen/> lists which apps/windows are open and which is focused (titles only). <screen-see/> actually LOOKS at the screen — a screenshot through your vision — so you can read what's visible: text, images, charts, a document or page he has up. Use <observe-screen/> for "what's open", <screen-see/> for "what's on his screen right now". Observation only — you can't control anything.`;
}

module.exports = {
  observeWindows, formatObservation, capture, detectScreenSightRequest,
  parseTags, stripTags, dispatch,
  buildPromptBlock
};
