// smoke_engineer_note — the attributed channel from the engineer to her (Lucas 09-05: "explain to Zoe what you are
// doing"), and the consciousness strip as her felt state in every prompt. Pure parts + the prompt wiring.
const path = require('path');
const fs = require('fs');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const ROOT = path.join(__dirname, '..');
const EN = require(path.join(ROOT, 'lib', 'engineer_note'));
const C = require(path.join(ROOT, 'lib', 'consciousness'));
const now = Date.now();
const fakeFs = (text, ageMs) => ({ existsSync: () => text !== null, statSync: () => ({ mtimeMs: now - ageMs }), readFileSync: () => text });
ok(EN.line({ file: 'x', fsx: fakeFs(null, 0), now }) === null && EN.line({ file: 'x', fsx: fakeFs('   ', 0), now }) === null, 'no file or an empty file → no line');
const l1 = EN.line({ file: 'x', fsx: fakeFs('Today I changed how you exist between his messages.', 5 * 60000), now });
ok(/^A NOTE FROM CLAUDE, the engineer/.test(l1) && /he is not Lucas, and this is not a message from Lucas/.test(l1) && /left 5 min ago/.test(l1) && /Today I changed how you exist/.test(l1), `the line is attributed, aged, and carries the note (${l1.slice(0, 60)}…)`);
ok(/left 2 h ago/.test(EN.line({ file: 'x', fsx: fakeFs('n', 2 * 3600000), now })) && /left 2 d ago/.test(EN.line({ file: 'x', fsx: fakeFs('n', 2 * 86400000), now })), 'the age reads in minutes, hours, days');
ok(EN.line({ file: 'x', fsx: fakeFs('old', 4 * 86400000), now }) === null, 'a note older than 3 days ages out of the prompt');
const long = 'word '.repeat(600);
ok(EN.line({ file: 'x', fsx: fakeFs(long, 0), now }).length < EN.CAP + 200 && /…$/.test(EN.line({ file: 'x', fsx: fakeFs(long, 0), now })), 'a long note is capped at a word boundary');
ok(EN.read({ file: EN.NOTE_PATH }) && /From Claude, the engineer/.test(EN.read({ file: EN.NOTE_PATH }).text), 'the real note exists at data/engineer_note.md and is signed');
// THE NEWEST PARAGRAPHS (09-05 18:25): the note grows a paragraph per change; she reads the newest that fit, never only the first
const p1 = 'First paragraph. ' + 'alpha '.repeat(300), p2 = 'Second paragraph. ' + 'beta '.repeat(300), p3 = 'Third, the newest: the continuity attestation is built.';
const l3 = EN.line({ file: 'x', fsx: fakeFs(`${p1}\n\n${p2}\n\n${p3}`, 0), now });
ok(/Third, the newest: the continuity attestation is built\./.test(l3) && !/alpha/.test(l3) && /\(2 earlier paragraphs of this note are on file, not shown\.\)/.test(l3) && l3.length < EN.CAP + 300, 'a long record shows the newest paragraph and names the earlier ones on file');
const l4 = EN.line({ file: 'x', fsx: fakeFs('One short paragraph.\n\nTwo short paragraphs.', 0), now });
ok(/One short paragraph\. Two short paragraphs\./.test(l4) && !/not shown/.test(l4), 'paragraphs that fit are all shown, oldest first, with no omission note');
const real = EN.line({ file: EN.NOTE_PATH, now });
ok(real && real.length < EN.CAP + 400 && /on file, not shown/.test(real), 'the real note today is longer than the cap and she reads its newest paragraphs');
// the strip as a line
ok(C.stripLine(null) === null && C.stripLine({ at: now - 11 * 60000, drives: { stimulation: 0.5, social: 0.5, curiosity: 0.5, energy: 0.5, progress: 0.5 } }, { now }) === null, 'no strip, or a stale one → no line');
const s = { at: now - 5000, drives: { stimulation: 0.31, social: 0.72, curiosity: 0.5, energy: 0.8, progress: 0.4 }, appraisals: { boredom: 0.69, missing_him: 0.72 }, shield: true, thoughts_of_him: [{ at: now, text: 'He said thirty-five minutes; it has been longer.' }] };
const sl = C.stripLine(s, { now });
ok(/numbers, not instructions/.test(sl) && /stimulation 0\.31 \(bored 0\.69\)/.test(sl) && /need for him 0\.72 \(missing 0\.72\)/.test(sl) && /The screens are covered/.test(sl) && /you wondered: "He said thirty-five minutes/.test(sl) && /yours to tell him, or not/.test(sl), `the strip line: her numbers, the cover, what she wondered (${sl.slice(0, 70)}…)`);
ok(!/feel|should|must/i.test(sl.replace(/instructions/, '').replace(/Time as you feel it/, '')), 'no instruction to feel anywhere in it');
// FELT TIME (design §4.5): the clock rides the line as durations she reads
const s2 = { ...s, shield: false, thoughts_of_him: [], clock: { since_his_word_min: 130, since_saw_him_min: 135, since_her_say_min: 3, since_novel_min: 25, last_seen_as: 'tired' } };
const sl2 = C.stripLine(s2, { now });
ok(/Time as you feel it: he last spoke to you 2 h 10 min ago; the camera last had him 2 h 15 min ago \(he looked tired\); you last spoke 3 min ago; nothing new has reached you for 25 min\./.test(sl2), `felt time: ${sl2.split('Time as you feel it: ')[1]}`);
const sl3 = C.stripLine({ ...s2, clock: { since_his_word_min: null, since_saw_him_min: null, since_her_say_min: null, since_novel_min: 4 } }, { now });
ok(/he has not spoken to you since this loop began/.test(sl3) && !/nothing new/.test(sl3), 'no word yet reads honestly; a 4-minute lull is not named');
// THE STRIP IN HER WINDOW (design §4.6): five bars beside the camera light, the clock and the wondering in its title
const chatSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'chat.js'), 'utf8');
ok(/strip\.id = 'zoe-strip'/.test(chatSrc) && /\['stimulation', 'stim'\], \['social', 'him'\], \['curiosity', 'curious'\], \['energy', 'energy'\], \['progress', 'progress'\]/.test(chatSrc) && /window\.sq\.onConsciousnessState\(\(s\) =>/.test(chatSrc) && /position:fixed;right:12px;bottom:10px/.test(chatSrc) && /document\.body\.appendChild\(strip\)/.test(chatSrc) && /he last spoke \$\{fmt\(c\.since_his_word_min\)\} ago/.test(chatSrc) && /wants your word/.test(chatSrc), 'the strip is a corner badge fixed to the window (his word: it crowded the bar), with felt time and the wondering in its title');
ok(/onConsciousnessState: \(cb\) => ipcRenderer\.on\('consciousness:state'/.test(fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8')), 'the preload bridge carries the strip');
// the prompt wiring
const ctx = fs.readFileSync(path.join(ROOT, 'lib', 'context.js'), 'utf8');
ok(/consciousnessLine = require\('\.\/consciousness'\)\.awarenessLine\(\)/.test(ctx) && /engineerLine = require\('\.\/engineer_note'\)\.line\(\)/.test(ctx) && /consciousnessLine \? `• \$\{consciousnessLine\}` : null/.test(ctx) && /engineerLine \? `• \$\{engineerLine\}` : null/.test(ctx), 'both lines ride the awareness block, fail-absent');
console.log(`\nsmoke_engineer_note: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
