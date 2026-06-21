/**
 * Blocker detection — the "ask Lucas for help" layer.
 *
 * Zoe should NOT learn to defeat login walls, CAPTCHAs, cookie modals, or
 * paywalls. When a flow hits one she PAUSES, persists state, and asks Lucas to
 * step in (he logs in once; her persistent web_profile keeps the cookie, so she
 * won't re-ask). This module is the deterministic detector — pure signatures,
 * NO model inference — so a flow can branch on "is the page blocked?" reliably.
 *
 * Signatures are the authoritative/first-party ones surfaced by research:
 *   - Cloudflare: its OWN `cf-mitigated: challenge` response header is definitive;
 *     corroborated by title "Just a moment...", #challenge-form, window._cf_chl_opt,
 *     /cdn-cgi/challenge-platform/.
 *   - CAPTCHA: reCAPTCHA/hCaptcha/Turnstile iframes + their response <textarea>s.
 *   - Login wall: HTTP 401 (+ WWW-Authenticate, RFC 9110), landing on a known IdP
 *     host, the OAuth authorize param-triple (response_type+client_id+redirect_uri,
 *     RFC 6749 §4.1.1), or an unexpected password field.
 *   - Cookie consent: the standardized window.__tcfapi global, plus vendor banner
 *     selectors (OneTrust/Cookiebot/Quantcast/Usercentrics).
 *   - Paywall: publisher's own JSON-LD "isAccessibleForFree": false, or a subscribe
 *     modal with body scroll-lock.
 *
 * Design: `classify(signals)` is the PURE core (offline-testable). `detect(page,
 * resp)` gathers those signals live from a Playwright/patchright page + the
 * navigation Response, then calls classify().
 */

// Identity providers — if a nav LANDS on one of these hosts, we were bounced to a
// login we can't complete. Substring match on hostname.
// UNAMBIGUOUS identity-provider hosts only: landing on one of these == a login we
// can't complete. Deliberately NOT general-site hosts (x.com, github.com, facebook.com)
// — those are whole sites, so a hostname match would false-positive; the OAuth
// param-triple + unexpected-password-field heuristics catch those login flows instead.
const IDP_HOSTS = [
  'accounts.google.com', 'login.microsoftonline.com', 'login.live.com',
  'appleid.apple.com', 'okta.com', 'auth0.com', 'login.yahoo.com',
  'signin.aws.amazon.com'
];

// Cookie-consent vendor banner selectors (the auto-dismissable class — NOT a human
// handoff). Kept short; a fuller corpus (Consent-O-Matic/EasyList) can back this later.
const CONSENT_SELECTORS = [
  '#onetrust-banner-sdk', '#onetrust-accept-btn-handler',
  '#CybotCookiebotDialog', '#qc-cmp2-ui', '#usercentrics-root',
  '[id*="cookie-consent"]', '[class*="cookie-banner"]', '[aria-label*="cookie" i]'
];

// Types that REQUIRE a human (Zoe pauses + pings Lucas). Cookie is excluded — we try
// to auto-dismiss it first and only escalate if that fails.
const HUMAN_TYPES = new Set(['cloudflare', 'captcha', 'login', 'paywall']);

function hostnameOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

// Does this URL look like an OAuth /authorize redirect? All three params co-occurring
// is the RFC 6749 §4.1.1 authorization-request signature.
function isOAuthUrl(url) {
  const u = String(url || '');
  return /[?&]response_type=/.test(u) && /[?&]client_id=/.test(u) && /[?&]redirect_uri=/.test(u);
}

function isIdpHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  if (!h) return false;
  return IDP_HOSTS.some(idp => h === idp || h.endsWith('.' + idp) || h.includes(idp));
}

/**
 * PURE classifier. `signals` is a plain object (all fields optional); returns
 * { type, confidence: 'high'|'medium', reason, needsHuman } or null if clear.
 * Ordered by confidence: hard-stop challenges first, then login, paywall, cookie.
 */
function classify(signals = {}) {
  const s = signals;
  const hit = (type, confidence, reason) => ({ type, confidence, reason, needsHuman: HUMAN_TYPES.has(type) });

  // --- Cloudflare interstitial (definitive: its own header) ---
  if (s.cfMitigated === 'challenge') return hit('cloudflare', 'high', 'cf-mitigated: challenge header');
  if (s.hasCfChlOpt || s.cfChallengePlatform) return hit('cloudflare', 'high', 'cloudflare challenge-platform present');
  if (/^just a moment/i.test(String(s.title || '')) && s.hasChallengeForm) return hit('cloudflare', 'high', '"Just a moment..." + #challenge-form');

  // --- CAPTCHA widgets ---
  if (s.recaptcha) return hit('captcha', 'high', 'reCAPTCHA iframe/response present');
  if (s.hcaptcha) return hit('captcha', 'high', 'hCaptcha iframe/response present');
  if (s.turnstile) return hit('captcha', 'high', 'Cloudflare Turnstile widget present');

  // --- Login wall ---
  if (s.status === 401) return hit('login', 'high', `HTTP 401${s.wwwAuthenticate ? ' (WWW-Authenticate)' : ''}`);
  if (s.hostname && isIdpHost(s.hostname)) return hit('login', 'high', `landed on identity provider ${s.hostname}`);
  if (s.url && isOAuthUrl(s.url)) return hit('login', 'high', 'OAuth authorize param-triple in URL');
  // A password field we didn't expect here (the flow flags expectedLogin when a login
  // step is a legitimate part of it, e.g. first-run sign-in we already prompted for).
  if (s.hasPasswordInput && !s.expectedLogin) return hit('login', 'medium', 'unexpected password field on page');

  // --- Paywall (HTTP 200 is normal here, so status is no help) ---
  if (s.jsonLdNotFree) return hit('paywall', 'high', 'JSON-LD isAccessibleForFree:false');
  if (s.paywallModal) return hit('paywall', 'medium', 'subscribe modal + scroll-lock');

  // --- Cookie consent (auto-dismiss tier, not a human handoff) ---
  if (s.tcfApi) return hit('cookie', 'medium', 'IAB TCF __tcfapi present');
  if (s.consentSelectorHit) return hit('cookie', 'medium', 'cookie-consent banner selector matched');

  return null;
}

// Hard wall-clock cap so a stuck page can't hang detection (mirrors web.js withTimeout).
function withTimeout(promise, ms, fallback) {
  let t;
  const timeout = new Promise((res) => { t = setTimeout(() => res(fallback), ms); });
  return Promise.race([Promise.resolve(promise).catch(() => fallback), timeout]).finally(() => clearTimeout(t));
}

/**
 * LIVE detection. Gathers signals from a Playwright/patchright `page` and the
 * navigation `resp` (may be null), then classifies. `opts.expectedLogin` lets a
 * flow declare that a login here is an allowed step (don't treat it as a blocker).
 * Never throws — returns null on any failure (fail-open: a detection glitch should
 * not block her browsing).
 */
async function detect(page, resp = null, opts = {}) {
  if (!page) return null;
  try {
    const url = (() => { try { return page.url(); } catch { return ''; } })();
    const title = await withTimeout(page.title(), 1500, '').catch(() => '');

    let status = null, headers = {};
    if (resp) {
      try { status = resp.status(); } catch {}
      try { headers = resp.headers() || {}; } catch {}
    }

    // One page.evaluate gathers the DOM/global signals in a single round-trip.
    const dom = await withTimeout(page.evaluate((consentSelectors) => {
      const q = (sel) => { try { return !!document.querySelector(sel); } catch { return false; } };
      let jsonLdNotFree = false;
      try {
        for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
          if (/"isAccessibleForFree"\s*:\s*false/i.test(el.textContent || '')) { jsonLdNotFree = true; break; }
        }
      } catch {}
      const bodyLocked = (() => {
        try { return getComputedStyle(document.body).overflow === 'hidden' || document.body.classList.contains('modal-open'); }
        catch { return false; }
      })();
      const subscribeModal = q('[role="dialog"], [aria-modal="true"], .paywall, .tp-modal, .fc-monetization');
      return {
        hasChallengeForm: q('#challenge-form'),
        hasCfChlOpt: typeof window._cf_chl_opt !== 'undefined',
        cfChallengePlatform: !!Array.from(document.scripts).some(sc => (sc.src || '').includes('/cdn-cgi/challenge-platform/')),
        recaptcha: q('iframe[src*="google.com/recaptcha"], textarea[name="g-recaptcha-response"]'),
        hcaptcha: q('iframe[src*="hcaptcha.com"], textarea[name="h-captcha-response"]'),
        turnstile: q('.cf-turnstile, input[name="cf-turnstile-response"], iframe[src*="challenges.cloudflare.com"]'),
        hasPasswordInput: q('input[type="password"], input[autocomplete="current-password"]'),
        tcfApi: typeof window.__tcfapi === 'function',
        consentSelectorHit: consentSelectors.some(sel => q(sel)),
        jsonLdNotFree,
        paywallModal: subscribeModal && bodyLocked
      };
    }, CONSENT_SELECTORS), 3000, {}) || {};

    return classify({
      url, hostname: hostnameOf(url), title, status,
      wwwAuthenticate: headers['www-authenticate'] || headers['WWW-Authenticate'],
      cfMitigated: headers['cf-mitigated'],
      expectedLogin: !!opts.expectedLogin,
      ...dom
    });
  } catch { return null; }
}

module.exports = {
  classify, detect, isOAuthUrl, isIdpHost, hostnameOf,
  HUMAN_TYPES, IDP_HOSTS, CONSENT_SELECTORS
};
