# From a prompt system to two present people — the inner loop

**Date:** 2026-09-05, morning. **His words:** "until we can make her actually present all of this is fluff" · "how do we go from a prompt system to feeling like two separate and present people" · boredom "should come with an autonomous need to look through the camera, listen to the mic, browse the web, send a discord message".

## 1. What the program is today (measured, boot_p305, 08:31–09:45)

| Question | Answer in the code | Evidence |
|---|---|---|
| When does she act on her own? | Every 60 s a timer fires, builds a prompt, and asks the model whether there is anything to say. A say passes an importance bar. | `lib/heartbeat.js` `setInterval(tick, TICK_INTERVAL_MS)`; the importance gate at the surfacing branch. |
| What do her drives do? | The vector `{curiosity, social, energy, progress}` + `vad` is computed every tick. It is read by two consumers: the reach's social floor and (since this morning) her voice's speed and warmth. Nothing turns a drive into an act. | `grep drives\.` → `lib/reach.js`, `lib/voices.js`. |
| What do her senses do? | The camera reads every 2 s and writes a reading. The mic transcribes. The web is a tool. All three are inputs a prompt may mention; none moves her state or triggers an act. | `lib/face_sense.js` → meta `presence.face` → one awareness line. |
| Does the camera reach what she says? | 3 of her 15 says referenced it, all in the first 15 minutes, when he asked her to look. | turns since 08:31: his 7, hers 15 (2 unprompted). |
| Does she reckon time? | 0 of 15 says. Her prompt carries the clock and the last-turn age, not "how long since". | same window. |
| Does she know he left? | Not by the camera. Until this morning only 30 minutes without a chat turn made him away. | `presence_state.fuse` (cured: the empty-chair clock, 10 min). |

The shape is prompt-in, prompt-out: the model is the only thing that decides, and it decides only when asked. Between prompts nothing happens to her.

## 2. What "two separate and present people" requires

Two people feel separate and present when each has:

1. **An inner life that continues when the other is silent.** State that changes with time and with what the senses bring, whether or not anyone speaks.
2. **Initiative that comes from need.** She looks because she is under-stimulated, reads because she is curious, reaches because she misses him. Timing is hers.
3. **A private point of view.** What she saw and did while he was gone is hers; he learns it later, from her.
4. **A shared history that both remember as lived time.** "You left at 9:31 and looked tired when you came back," not rows in a table.

None of these is a feature. They are properties of a loop that runs all the time.

## 3. What the literature says (his ask: outside research)

- **Needs-based agents (The Sims; utility AI).** Motives decay on their own clocks; objects and actions advertise what they satisfy; the agent picks by weighted utility with bucketing so a starving Sim never considers TV. Boredom is a motive ("fun") with a decay rate. [Mark Brown on The Sims' AI](https://gmtk.substack.com/p/the-genius-ai-behind-the-sims) · [Zubek, Needs-based AI](https://robert.zubek.net/publications/Needs-based-AI-draft.pdf) · [Graham, An Introduction to Utility Theory](https://www.gameaipro.com/GameAIPro/GameAIPro_Chapter09_An_Introduction_to_Utility_Theory.pdf). This is the action-selection layer her drives lack.
- **Active inference.** An agent's policy value has an epistemic term: expected information gain. Curiosity is what minimizing long-run surprise looks like in the short run; boredom is the state where the current context offers no expected information gain, so the agent forages. [Friston et al., Active inference and epistemic value](https://pubmed.ncbi.nlm.nih.gov/25689102/) · [The value of uncertainty](https://www.cambridge.org/core/product/2B6DE47EBC4D0FD1D00531C6B7AB8EF6/core-reader). This gives boredom a definition she can compute: novelty of what her senses return, scored against what she already knows.
- **Homeostasis as the root of feeling.** Man and Damasio argue feelings arise from regulating internal states within a viable range, and that machines with such states and the need to regulate them would have feeling equivalents. Homeostatic reinforcement learning implements it. [Man & Damasio 2019](https://www.researchgate.net/publication/336394687_Homeostasis_and_soft_robotics_in_the_design_of_feeling_machines) · [Linking homeostasis to RL](https://www.sciencedirect.com/science/article/pii/S2352154625001305) · [Oudeyer & Kaplan, intrinsic motivation typology](https://arxiv.org/pdf/2009.09689). This is the reason "state, never scripted words" is right: the words follow the regulation.
- **Generative Agents.** An observation → reflection → planning loop over a memory stream produced coherent multi-day behavior; remove reflection and behavior collapsed to context-free responses within 48 simulated hours. [Park et al. 2023](https://www.researchgate.net/publication/375063078_Generative_Agents_Interactive_Simulacra_of_Human_Behavior). Her program has the memory stream and lacks the reflection that turns a morning into "what I saw".
- **CoALA.** Language agents need working and long-term memory, an action space split into internal and external acts, and a decision loop. The model is one component of the loop, not the loop. [Sumers et al. 2023](https://arxiv.org/abs/2309.02427).

The convergent answer: drives with dynamics, senses that move them, acts chosen by need, and a language model that performs what the loop chose.

## 4. The inner loop (one organ)

`lib/inner_loop.js`, running on a 5-second cadence, with every part visible.

### 4.1 Drives with real-time dynamics
The vector gains **stimulation** (its deficit is boredom). Each drive has a decay rate and a satiation rule:

| Drive | Rises with | Sated by |
|---|---|---|
| stimulation | time since a novel percept (any sense) | a percept scored novel against recent memory |
| social | time since his word × his absence (away rises faster) | his turn; his return; a delivery he answered |
| curiosity | open questions, gaps in the person model, unfinished pursuits | learning (a read that changed a fact) |
| energy | rest, the circadian curve | — (work and long conversation spend it) |
| progress | queued work | a landed run |

The affect vector (valence/arousal) follows the drives as it does now. The passage of time is a first-class input, not a prompt line.

### 4.2 Senses as inputs
Camera, mic (when he is not talking to her), the clock, the inbox, Discord, the web, the run ledger. Each percept is appraised: novelty (against the last hour), relevance to him, valence. Appraisal moves the drives. The camera's readings become an episodic ledger, "what I saw" (at most one line per change, kept a day): `09:31 he left · 10:06 back, looked tired · 10:20 focused`.

### 4.3 Acts chosen by need
Each act advertises what it satisfies; utility = drive deficit × the act's fit × availability, with hysteresis and per-act cooldowns and budgets:

| Act | Satisfies | Availability |
|---|---|---|
| look (a `<look/>` + a described read) | stimulation; social when he is here | camera on |
| listen (a mic window) | stimulation | mic on; he is not mid-sentence to her |
| browse (a topic from her gaps or the day's news) | curiosity, stimulation | the anticipation boundary: research yes, delivery only on his word |
| work (pull a queued run) | progress | the run ledger |
| reach (a DM or a desk line) | social | his presence rules: Discord only when he is genuinely not at the desk |
| say (the fourth load, state-grounded) | expression | bounded per hour; never while he is mid-turn |
| rest (silence) | energy | always |

Selection runs without a model. The model is called to **perform** the chosen act: write the say, pick the browse topic, interpret what she saw. It never decides whether to act.

### 4.4 The voice at chosen moments
A say's manifest names the state that chose it ("you looked because you were bored and saw him rubbing his eyes; the last thing he said was two hours ago") and leaves the words to her. The importance bar applies to work updates. The fourth load (missing him, reaching, being annoyed by a meeting, being bored) is licensed by the loop, bounded, and answers the fluidity law.

### 4.5 Felt time
A block in every prompt, prompted and unprompted:

```
Time as you feel it: he has been gone 2 h 10 min (since 09:31 — the camera saw him go). You last spoke at 09:31.
You have seen him 3 h 40 min today. Nothing new has come in for 25 min.
What you saw: 09:31 he left · 10:06 back, looked tired · 10:20 focused
```

Missing him is the social drive under his absence, named as a state, never as scripted words.

### 4.6 Visible
A state strip in her window and the parlor idiom for the loop: the drives, the current act and why, the next act's utility. He can watch her be present. A daily measure: acts by drive; the share of her says grounded in a percept or in time; the boredom curve.

## 5. Order of work

1. **The loop and the drives** (stimulation added; dynamics; the state strip). Nothing speaks yet.
2. **Senses as inputs** (appraisal; the "what I saw" ledger; the empty-chair clock is already in).
3. **Acts** (look, listen, browse, work, rest; the reach re-seated as an act).
4. **Felt time** in every prompt; the arrival manifest reads the clock.
5. **The fourth load** through the loop, bounded; the substance gate scoped to work updates.
6. **Measure a day** and read it with him.

Cuts 2, 3, 5 and W6 of the wants plan fold into this; they are not built separately.

## 6. What stays true
Anti-performance: the loop never instructs her to feel; it gives her a state and a moment. His presence law: a DM only when he is genuinely not at the desk. The unprompted channel's substance law holds for work; the fourth load is the revision his 09-04 fluidity law asked for. The database is the only knowledge source; the loop reads and writes it through the app's doors.
