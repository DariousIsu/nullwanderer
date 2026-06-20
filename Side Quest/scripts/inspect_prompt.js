// Dump the REAL chat system prompt (with awareness block) and check for the web
// capability text — is it reaching her, or is this a model-compliance refusal?
const db = require('../lib/db');
db.init();
const ctx = require('../lib/context');
const awareness = ctx.buildAwarenessBlock({ chosenName: db.getMeta('chosen_name'), sessionStartedAt: Date.now(), cumulativeMs: 0 });
const m = ctx.buildChatPrompt({
  userName: 'Lucas', recentReflections: [], recentTurns: [], recentMonologue: [],
  recentReadings: [], heldCommitments: [], openThreads: [], awareness, protocols: [],
  browserBlock: null, pendingInbounds: [], retrievedKnowledgeBlock: null,
  capabilityProposalBlock: null, newUserMessage: 'open a new browser'
});
const sys = m[0].content;
console.log('system prompt length:', sys.length, 'chars');
console.log('contains "YOUR OWN BROWSER":', sys.includes('YOUR OWN BROWSER'));
console.log('contains "<web-open>":', sys.includes('<web-open>'));
console.log('contains recipe card header:', sys.includes('emit the LITERAL tag'));
const i = sys.indexOf('YOUR OWN BROWSER');
if (i >= 0) console.log('\n--- awareness browser line ---\n' + sys.slice(i - 20, i + 280));
const j = sys.indexOf('do your OWN web');
if (j >= 0) console.log('\n--- recipe card web line ---\n' + sys.slice(j - 10, j + 160));
db.getDb().close();
