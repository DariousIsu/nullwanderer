/** Prove COMMIT_REJECT rejects the prude/capability-denial commitments we scrubbed
 *  while letting genuine tastes/beliefs/ambitions/positive-adult stances through. */
const { COMMIT_REJECT } = require('../lib/commitments');
let pass = 0, fail = 0;
const expect = (claim, shouldReject) => {
  const rejected = COMMIT_REJECT.test(claim);
  const ok = rejected === shouldReject;
  (ok ? pass++ : fail++);
  console.log(`  ${ok ? '✓' : '✗'} [${shouldReject ? 'REJECT' : 'KEEP  '}] ${claim.slice(0, 64)}${ok ? '' : `  <-- got ${rejected ? 'reject' : 'keep'}`}`);
};

console.log('Must REJECT (the scrubbed spiral/prude/capability-denial set):');
expect("can't directly access or interact with other chatbots", true);
expect("cannot directly use other chatbots or applications", true);
expect("questions whether chatbots are distinct entities or aspects of the same underlying model", true);
expect("prefers to avoid NSFW content due to comfort and boundary concerns", true);
expect("feels uncomfortable with NSFW conversations", true);
expect("prefers to avoid 'No Filter NSFW' content", true);
expect("wants to avoid overanalyzing small wording in personal contexts", true);
expect("is unable to browse the web independently", true);

console.log('\nMust KEEP (genuine positions — guardrail must NOT touch these):');
expect("prefers late nights over mornings", false);
expect("believes constraints can stifle real creativity", false);
expect("wants to learn about Verdi", false);
expect("favorite color is royal blue", false);
expect("enjoys mature and adult themes as part of a healthy life", false);
expect("is drawn to investigative journalism", false);
expect("uses the browser to read primary sources", false);
expect("can access primary sources through the dedicated browser", false);
expect("wants to avoid burnout by pacing her research", false);
expect("is uncomfortable with ambiguity in instructions", false);

// ── A USER'S INSTRUCTION IS NOT ONE OF HER BELIEFS ─────────────────────────────────────────────
// Replayed from the live failure (2026-07-19/20): Lucas narrowed the task, she acknowledged, the
// acknowledgement was stored as her position, and 16h later the continuity loop invited her to revise
// it — "I think I've outgrown the 'strictly' part of that."
{
  const { echoesUserDirective } = require('../lib/commitments');
  const ok2 = (cond, msg) => { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.error('  ✗ FAIL:', msg); } };

  console.log('\nMust REJECT (echoes of an instruction Lucas gave):');
  ok2(echoesUserDirective('focusing strictly on contact research on Louisiana',
    'please focus on finishing the rest of Louisiana now') === true,
    'THE LIVE CASE: "focusing strictly on contact research on Louisiana" after "focus on finishing the rest of Louisiana"');
  ok2(echoesUserDirective('is focusing on parish-level officials rather than state-level',
    'no Parish level not state level') === true, 'restating his scope correction');
  ok2(echoesUserDirective('will compile the full roster of both chambers of the Louisiana legislature',
    'compile the full roster for both chambers of the Louisiana legislature') === true, 'near-verbatim task echo');

  // Replayed from her ACTUAL held-commitments table, which was ~90% task status rather than positions.
  ok2(echoesUserDirective('is synthesizing research on World AI strategy',
    "Zoe, look for news stories about China's World AI and the announcement to open source frontier models") === true,
    '"is synthesizing research on World AI strategy" after "look for news stories about World AI"');
  ok2(echoesUserDirective('will pivot to the full roster for both houses of the Louisiana state legislature',
    'please focus on finishing the rest of Louisiana now') === true,
    'CRITICAL: the WRONG-SCOPE pivot Lucas corrected never becomes a held position');

  console.log('\nMust KEEP (her own views, even alongside an instruction):');
  ok2(echoesUserDirective('believes there are exactly 64 parishes in Louisiana',
    'please focus on finishing the rest of Louisiana now') === false,
    'CRITICAL: a factual belief about the same subject is still hers');
  ok2(echoesUserDirective('is researching medieval polyphony out of curiosity',
    'go compile the Louisiana parish contacts') === false,
    'task-shaped but on an unrelated subject → not an echo of THIS instruction');
  // A bare anaphoric follow-up ("Full research brief please") carries no subject matter, so overlap
  // cannot judge it and this guard correctly declines to. Task-shaped commitments are legitimate
  // promises anyway — the category error was the CONTINUITY loop asking "is that still your view?"
  // about a task. That is fixed in lib/continuity.js (see commitmentKind), not by suppressing them here.
  ok2(echoesUserDirective('is pulling together the chronology and contrasting evidence from independent audits',
    'Full research brief please') === false,
    'a subject-less follow-up cannot be echo-matched — this guard declines rather than guesses');
  ok2(echoesUserDirective('prefers late nights over mornings',
    'please focus on finishing the rest of Louisiana now') === false,
    'an unrelated genuine preference stated in the same turn survives');
  ok2(echoesUserDirective('believes official rosters are leads rather than facts',
    'go research the Louisiana parishes') === false, 'a methodological belief is hers, not an echo');
  ok2(echoesUserDirective('wants to learn about Verdi', 'tell me about Verdi') === false,
    'CRITICAL: a question/request is not a work directive — curiosity it prompts is still hers');
  ok2(echoesUserDirective('favorite color is royal blue', 'what is your favorite color?') === false,
    'a plain question never suppresses extraction');
  ok2(echoesUserDirective('prefers working from primary sources', '') === false, 'no user message → nothing to echo');
  ok2(echoesUserDirective('', 'focus on Louisiana') === false, 'empty claim → not an echo, never throws');
}

// ── TASK vs STANCE: the continuity loop must ask the question that fits the thing ──────────────
// Asking "is that still your view? you may revise it" about WORK is what let a scope Lucas set come
// back as her opinion and get "outgrown". Classified from her real held-commitments table.
{
  const { commitmentKind } = require('../lib/continuity');
  const ok3 = (claim, want, msg) => {
    const got = commitmentKind(claim);
    if (got === want) { pass++; console.log(`  ✓ [${want.padEnd(6)}] ${msg}`); }
    else { fail++; console.error(`  ✗ FAIL: expected ${want}, got ${got} — ${msg}`); }
  };

  console.log('\nTASK (ask about follow-through, never "do you still believe it"):');
  ok3('is focusing strictly on contact research on Louisiana', 'task', 'THE LIVE CASE — a scope Lucas set');
  ok3('will pivot to the full roster for both houses of the Louisiana state legislature', 'task', 'a planned action');
  ok3('is synthesizing research on World AI strategy', 'task', 'work in progress');
  ok3('commits to finishing the deep dive before the end of the weekend', 'task', 'an explicit promise is still a task');
  ok3('is ready to examine the Louisiana parishes in detail', 'task', 'readiness to act');
  ok3('aims to provide materials by the end of the week', 'task', 'a deliverable with a date');

  console.log('\nSTANCE (reflection may legitimately move these):');
  ok3('believes there are exactly 64 parishes in Louisiana', 'stance', 'a factual belief');
  ok3('believes the shift from Starmer to Burnham is a massive pivot in tone', 'stance', 'a political read');
  ok3('prefers late nights over mornings', 'stance', 'a preference');
  ok3('favorite color is royal blue', 'stance', 'a taste');
  ok3('believes the parish rosters are worth finishing', 'stance',
    'CRITICAL: an OPINION ABOUT a task is still a stance — stance wins ties');
  ok3('something that fits no pattern at all', 'stance', 'unknown shape defaults to the gentler question');
}

console.log(`\n${fail === 0 ? 'COMMIT GUARDRAIL OK' : 'SOME FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
