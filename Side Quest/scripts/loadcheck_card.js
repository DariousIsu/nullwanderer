// Cycle + integration check: build a chat prompt and confirm the recipe card is present.
const db = require('../lib/db');
db.init();
const ctx = require('../lib/context');
require('../lib/monologue');
require('../lib/heartbeat');
require('../lib/recipes');
const m = ctx.buildChatPrompt({
  userName: 'Lucas', recentReflections: [], recentTurns: [], recentMonologue: [],
  recentReadings: [], heldCommitments: [], openThreads: [], awareness: null, protocols: [],
  browserBlock: null, pendingInbounds: [], retrievedKnowledgeBlock: null,
  capabilityProposalBlock: null, newUserMessage: 'hi'
});
const sys = m[0].content;
console.log('chat prompt built OK; recipe card present:', sys.includes('emit the LITERAL tag'));
db.getDb().close();
