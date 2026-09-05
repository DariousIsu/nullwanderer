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

## 4. The consciousness subroutine (one organ)

**His words, 10:05:** "maybe constantly aware consciousness doesn't have to be LLM driven at all, but rather a new series of python scripts. We built a fairly solid personality subroutine set; I wonder if we could do a consciousness subroutine" and "we'll need to find a way to integrate reasoning calls into those subroutines though."

That is this section. Two loops, one organ:

- **The fast loop** is Python, resident, on a 5-second cadence, and never calls a model. It owns the drives and their dynamics, takes percepts, appraises the ones a rule can appraise, and picks the act. It runs as a sidecar the way the face sensor does (`sidecar/face_embed.py --serve`: NDJSON over stdio, idle-stop, fail-soft), fed by the app's bus and answering with acts the app executes. Python is the right home: numeric dynamics, pytest, and it sits beside the personality subroutines.
- **The slow loop** is where reasoning lives. When an act needs judgment, the fast loop posts a typed request and keeps running: `appraise` (a percept a rule cannot read: what does his face mean this time), `reflect` (the last hour into "what I saw and what it meant", the Generative Agents finding), `choose` (a browse topic from her gaps), `perform` (write this say from this manifest). Each carries a budget and a deadline. The answer comes back as a percept and moves state like any other. The fast loop never blocks on it, and a late answer is still a percept.

The model is never asked whether to act. It is asked to see, to think back, to choose among, or to say. That is the integration of reasoning calls: as acts with budgets, on the slow loop, whose results are state.

The rest of this section describes the fast loop's parts.

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

### 4.5b The first act: someone else at the desk (his words, 10:20)
"When she sees someone who's not me sit down at the computer, wouldn't the more natural response be to either (a) recognize them and engage in a familiar conversation, or (b) not recognize them and move to defend the information on her screens and ask who they are and how she can help them?" Yes. This is a percept becoming an act without a prompt, so it is the subroutine's first act and its proof.

- **The percept:** a fresh face that is not him, steady for 8 s (flicker never counts), while he is away or absent.
- **The shared first move: shield.** The sensitive surfaces (chat, parlor, canvas, the work board) go behind a cover; deliveries pause; one line goes to him by his presence rules (a stranger at the desk means he is not at it, so Discord).
- **Known face:** a register beyond his own — `face.people`: name, relation, embedding — enrolled one person at a time by his word (never by her inference; a child by his word only). She greets by name and speaks in that person's register (the person model, cut 3).
- **Unknown face:** she asks who they are and how she can help, listens (the mic → transcript), and stays shielded until he returns (camera: him) or he says otherwise. The encounter is logged as an event with what was said.
- **Unshield:** his face, or his word.

This act exercises every part of the loop: a sense (camera, mic), an appraisal (known / unknown), a state (shielded), acts (cover, say, listen, deliver), a slow-loop call (`perform`: the greeting or the question in her words), and a visible result. It ships first.

### 4.5c The stack as built, v0 (his question, 10:55: "what's in it, what does it do, how does it work, where did you find the code")

**What is in it (four files, all in the Side Quest tree):**

| File | Role |
|---|---|
| `sidecar/consciousness.py` (~230 lines) | The fast loop. State, drives, appraisal, act selection, the reasoning-request emitter, the state strip, the NDJSON wire (`--serve`) and a one-beat mode (`--once`). Standard library only. |
| `sidecar/tests/test_consciousness.py` (8 pins) | The stranger sequence (shield, ask once, unshield on his face), a known face greeted by name, a face beside him never shields, boredom rises with nothing new and produces look/listen with cooldowns, his turn sates the social need which rises faster while he is away, curiosity asks the slow loop and never blocks, the wire round-trips, the strip's shape. |
| `scripts/smoke_consciousness.js` | Its seat in the SQ gate: runs the pytest under the Echo venv by exit code and pins the wire from the app's side. |
| this document §4–§4.5b | The design it implements. |

**What is not in it yet:** the app-side bridge (`lib/consciousness.js`: spawn the sidecar, feed it percepts from the face sensor, presence, the chat door and the mic, execute its acts), the cover that "shield" draws over the windows, the `perform` call that turns a greet/ask request into her words, the person register's enrollment door, and the state strip in her window. That is the next build.

**What it does:** it keeps five numbers alive in real time and acts on them. Stimulation drains toward zero with nothing new (boredom is its deficit, about 15 minutes to empty). The social need rises with his silence, about 90 minutes to full while he is here and twice as fast while he is away (missing him is this number, never scripted words). Curiosity creeps up and is spent by asking. Energy follows a clock. Progress decays and is fed by landed work. Percepts move the numbers: his turn sates the social need; a new face, a new expression, a transcript, a finished run each add stimulation by their novelty. Acts are chosen by need with cooldowns: bored past 0.7, look; past 0.85, listen; curious past 0.75, ask the slow loop to choose something to read. And the first act: a face that is not him, steady for 8 seconds while he is away, shields the screens and either greets a known person by name or asks an unknown one who they are.

**How it works:** one beat every 5 seconds, a pure function `step(state, percepts, now) → (state, outputs)`. Advance the dynamics by the elapsed time; fold in the percepts; choose acts. Outputs are of two kinds only: an `act` the app executes (shield, unshield, deliver, look, listen, rest) and a `reason` request for the slow loop (`appraise`, `reflect`, `choose`, `perform`) carrying a budget in milliseconds and an id. The loop never waits for an answer; the answer comes back later as a percept of sense `answer`. The model is never asked whether to act. Every timestamp is a number and zero is a time, a lesson two red tests taught in the first hour.

**Where the code came from:** it was written here, this morning, from this design; no code was copied from any project. The structure is borrowed from two places in this repo and five sources outside it. From the repo: the face sensor's resident-sidecar idiom (`sidecar/face_embed.py --serve`, NDJSON over stdio, fail-soft) and the reach's shape (a need with a floor, a gap, and a licensed moment). From outside: needs-based action selection with decaying motives and cooldowns (The Sims, utility AI); boredom as the absence of expected information gain (active inference); drives as homeostatic variables whose regulation is the root of feeling (Man and Damasio); the observe-reflect-plan loop and the finding that reflection is what keeps behavior coherent over days (Generative Agents); the split of internal and external actions and a decision loop with the model as one component (CoALA). The citations are in §3.

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
