/**
 * Web-intent detection — does the user's message clearly ask to use the web /
 * open a browser? Returns { target } (a URL or search terms) for main.js's
 * web-intent interceptor, else null. Extracted from main.js so it's unit-testable.
 *
 * Conservative on bare conversation, but a pasted URL with a viewing verb ("take a
 * look at this <url>") is treated as "open it in her browser" — the clearest case.
 */
const SEARCH_HOME = 'https://duckduckgo.com';

function detectWebIntent(text) {
  if (!text) return null;
  const t = String(text).trim();

  const tag = t.match(/<web-open>\s*([\s\S]*?)\s*<\/web-open>/i);
  if (tag) return { target: (tag[1] || '').trim() || SEARCH_HOME };

  const url = t.match(/https?:\/\/\S+/i) || t.match(/\b[a-z0-9-]+\.[a-z]{2,}(?:\/\S*)?\b/i);
  const search = t.match(/\b(?:search(?:\s+for)?|look\s*up|google|find)\b\s+(?:the\s+|for\s+)?(.{2,90})/i);
  const verb = /(open|opening|launch|fire up|pull up|go to|browse|web-open|\buse\b)/i.test(t);
  const webCue = /\b(browser|web|online|internet|web-open)\b/i.test(t);
  // viewing/visiting verbs that, with a URL, mean "open this for me"
  const viewVerb = /\b(look|check|see|read|view|visit|peek|here'?s|this is)\b/i.test(t);

  // A pasted URL with any open/view/web cue is the clearest "open this".
  if (url && (viewVerb || verb || webCue)) return { target: url[0] };

  // Explicit "open/use ... browser/web" with optional search terms.
  if (verb && webCue) {
    if (search) return { target: search[1].trim().replace(/[.?!,\s]+$/, '') };
    return { target: SEARCH_HOME };
  }
  // A search COMMAND → web search. Fires when the message is an imperative search
  // ("search X", "can you look up X", "google X") OR references the web/browser
  // ("…from here", "in the browser", "online"). Stays quiet on conversational
  // "let's search for an approach" (doesn't start with the verb, no web ref).
  if (search) {
    const searchCmd = /^(?:can|could|would|will|please|hey)?[\s,]*(?:you[\s,]*)?(?:search|look\s*up|google|find)\b/i.test(t)
      || /\b(google|from here|in (?:the|your) browser|on the (?:web|internet)|online)\b/i.test(t);
    if (searchCmd) {
      const q = search[1].trim()
        .replace(/[.?!,\s]+$/, '')
        .replace(/\s+(?:from here|for me|online|on the web|on the internet|please)\s*$/i, '')
        .trim();
      return { target: q || SEARCH_HOME };
    }
  }
  return null;
}

module.exports = { detectWebIntent, SEARCH_HOME };
