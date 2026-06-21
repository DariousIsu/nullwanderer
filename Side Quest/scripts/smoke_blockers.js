/**
 * Backtest — blocker detection, PURE classifier layer (offline, no browser).
 * Exercises classify() against crafted signal objects + the url/host helpers.
 * Live detection (page.evaluate gathering) is covered by the web_live harness.
 */
const b = require('../lib/blockers');
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } };

console.log('Backtest — blockers.js classifier\n');

console.log('clear pages → null:');
ok('no signals → null', b.classify({}) === null);
ok('plain article → null', b.classify({ url: 'https://example.com/post', title: 'Some Post', status: 200 }) === null);

console.log('\nCloudflare:');
ok('cf-mitigated header → cloudflare/high', (() => { const r = b.classify({ cfMitigated: 'challenge' }); return r && r.type === 'cloudflare' && r.confidence === 'high' && r.needsHuman; })());
ok('challenge-platform script → cloudflare', b.classify({ cfChallengePlatform: true })?.type === 'cloudflare');
ok('"Just a moment" + form → cloudflare', b.classify({ title: 'Just a moment...', hasChallengeForm: true })?.type === 'cloudflare');
ok('"Just a moment" alone → NOT enough', b.classify({ title: 'Just a moment...' }) === null);

console.log('\nCAPTCHA:');
ok('reCAPTCHA → captcha/human', (() => { const r = b.classify({ recaptcha: true }); return r.type === 'captcha' && r.needsHuman; })());
ok('Turnstile → captcha', b.classify({ turnstile: true })?.type === 'captcha');

console.log('\nLogin wall:');
ok('HTTP 401 → login', b.classify({ status: 401 })?.type === 'login');
ok('IdP host → login', b.classify({ hostname: 'accounts.google.com' })?.type === 'login');
ok('OAuth param-triple → login', b.classify({ url: 'https://x/auth?response_type=code&client_id=abc&redirect_uri=https://y' })?.type === 'login');
ok('unexpected password field → login', b.classify({ hasPasswordInput: true })?.type === 'login');
ok('EXPECTED login → suppressed', b.classify({ hasPasswordInput: true, expectedLogin: true }) === null);

console.log('\nPaywall:');
ok('JSON-LD not-free → paywall', b.classify({ jsonLdNotFree: true })?.type === 'paywall');
ok('subscribe modal → paywall', b.classify({ paywallModal: true })?.type === 'paywall');

console.log('\nCookie consent (auto-dismiss, NOT human):');
ok('__tcfapi → cookie/not-human', (() => { const r = b.classify({ tcfApi: true }); return r.type === 'cookie' && !r.needsHuman; })());
ok('vendor selector → cookie', b.classify({ consentSelectorHit: true })?.type === 'cookie');

console.log('\nprecedence (hard-stop beats softer signals):');
ok('cloudflare beats cookie', b.classify({ cfMitigated: 'challenge', tcfApi: true })?.type === 'cloudflare');
ok('login beats paywall', b.classify({ status: 401, jsonLdNotFree: true })?.type === 'login');

console.log('\nhelpers:');
ok('isOAuthUrl true', b.isOAuthUrl('https://a/o?response_type=code&client_id=1&redirect_uri=z') === true);
ok('isOAuthUrl false (partial)', b.isOAuthUrl('https://a/o?client_id=1') === false);
ok('isIdpHost google', b.isIdpHost('accounts.google.com') === true);
ok('isIdpHost normal site false', b.isIdpHost('www.nytimes.com') === false);
ok('hostnameOf parses', b.hostnameOf('https://Sub.Example.com/x') === 'sub.example.com');

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
