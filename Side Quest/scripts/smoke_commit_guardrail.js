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

console.log(`\n${fail === 0 ? 'COMMIT GUARDRAIL OK' : 'SOME FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
