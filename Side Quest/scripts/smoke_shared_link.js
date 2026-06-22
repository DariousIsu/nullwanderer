/** Smoke — a Drive link that can't be background-fetched still persists a user-shared reading
 *  note (with open-in-own-browser guidance), so its purpose enters her context instead of vanishing. */
const os=require('os'),path=require('path');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_link_${Date.now()}`,'sq.db');
const db=require('../lib/db'); db.init();
let pass=0,fail=0; const ok=(n,c)=>{c?(pass++,console.log('  ✓ '+n)):(fail++,console.log('  ✗ '+n));};

// replicate the main.js fallback branch for an unfetchable Drive link
const who='Lucas';
const url='https://docs.google.com/spreadsheets/d/15OvE3Ksaf/edit?usp=sharing';
const page={ok:false,error:'unsupported content-type: text/html'}; // typical drive/js-app result
const isDrive=/\b(docs|drive|sheets)\.google\.com/i.test(url);
const why=isDrive?'it is a Google Drive/Docs/Sheets page that needs MY OWN signed-in browser':(page&&page.error?`background fetch said: ${page.error}`:'background fetch returned nothing readable');
db.insertMonologue({content:`${who} shared this link: ${url}\n[I could not read it with a background fetch — ${why}. To actually SEE it I open it in my own browser: <web-open>${url}</web-open> then <web-read/>. I must NOT go silent or check email instead — if I still can't see it, I tell ${who} plainly.]`,model:'user-shared',type:'reading',query:url,urls:[url]});

const readings = db.getRecentMonologueByType('reading',2,{excludeConsolidated:true});
ok('failed-link note persisted as a reading', readings.length===1);
const c = readings[0].content;
ok('records that Lucas shared the link', /shared this link/.test(c));
ok('keeps the actual URL (so purpose is recoverable)', /15OvE3Ksaf/.test(c));
ok('identifies it as a Drive page needing her own browser', /signed-in browser/.test(c));
ok('routes her to <web-open> not silence/email', /<web-open>/.test(c) && /NOT go silent or check email/.test(c));

console.log('\n'+(fail===0?'ALL PASS':'FAILURES')+` — ${pass} passed, ${fail} failed`);
process.exit(fail===0?0:1);
