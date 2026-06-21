/**
 * Record a capability change so the next reboot tells Zoe what changed in what she can
 * do (Lucas's reboot-log rule). Run BEFORE the reboot that deploys the change:
 *
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron.cmd scripts/log_capability_change.js "Added the byline pipeline + recipe engine"
 *
 * The entry surfaces once, in the back-online marker on the next boot.
 */
const db = require('../lib/db');
db.init();
const changelog = require('../lib/changelog');

const summary = process.argv.slice(2).join(' ').trim();
if (!summary) { console.error('usage: log_capability_change.js "<what changed>"'); process.exit(1); }

const ok = changelog.add(summary);
console.log(ok ? `logged capability change: ${summary}\n(${changelog.LOG_PATH})` : 'failed to log (empty?)');
process.exit(ok ? 0 : 1);
