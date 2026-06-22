/** R3 — meeting end stores a FIRST-CLASS EPISODIC memory (attendance + when + who + recap),
 *  so general recall surfaces it for any past meeting, not just the recency awareness line. */
const os=require('os'),path=require('path');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_epi_${Date.now()}`,'sq.db');
const db=require('../lib/db'); db.init();
const gmeet=require('../lib/gmeet');
let pass=0,fail=0; const ok=(n,c)=>{c?(pass++,console.log('  ✓ '+n)):(fail++,console.log('  ✗ '+n));};

const stores=[];
const deps={
  MODEL:'test',
  streamChat: async ({onToken}) => onToken('The meeting covered the April budget; Tracy to send the venue quote; Lucas to confirm speakers.'),
  storeMeeting: async (content, opts={}) => { stores.push({content, ...opts}); return 1; },
};
const ctx={ userName:'Lucas' };

(async () => {
  gmeet.start('https://meet.google.com/vud-sptv-wbh');
  db.setMeta('gmeet_present', JSON.stringify(['Lucas Overby','Madeline Keeter','Tracy Bromley']));
  db.setMeta('gmeet_understanding_log', 'Long enough running understanding of the meeting about the April budget and venue costs and speaker selection so synthesize proceeds.');
  db.setMeta('gmeet_started_at', String(Date.now() - 60*60*1000));

  const recap = await gmeet.synthesizeMeeting(deps, ctx);
  ok('recap returned', !!recap && /budget/i.test(recap));
  const epi = stores.find(s => s.source === 'meeting_episode');
  ok('an episodic memory was stored (source=meeting_episode)', !!epi);
  ok('episodic kind tagged', epi && epi.kind === 'episodic');
  ok('high importance (ranks on meeting queries)', epi && epi.importance >= 0.8);
  ok('frames it as HER attendance', epi && /I attended a Google Meet/.test(epi.content));
  ok('not-just-a-calendar-entry framing', epi && /not just a calendar entry/i.test(epi.content));
  ok('names who was present', epi && /Madeline Keeter/.test(epi.content) && /Tracy Bromley/.test(epi.content));
  ok('carries the recap body', epi && /budget/i.test(epi.content));
  ok('recency arm still set (gmeet_last_recap meta)', /budget/i.test(db.getMeta('gmeet_last_recap')||''));

  console.log('\n'+(fail===0?'ALL PASS':'FAILURES')+` — ${pass} passed, ${fail} failed`);
  try{require('fs').rmSync(path.dirname(process.env.SQ_DB_PATH),{recursive:true,force:true});}catch{}
  process.exit(fail===0?0:1);
})();
