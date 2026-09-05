# The core: a small model of her own, trained without end on this box (concept design, 2026-09-05)

**His words, 12:20:** "in an earlier iteration we design a model incubator for local training. we gave up on it because the ubuntu vulkan bridge was too unstable. but now I wonder if we could create an sml of core for the zoe construct that perpetually trains on the amd system now that there are amd native pathways."

**The answer in one line:** yes, and most of the road is already paved by this morning's voice work. The bridge that killed the incubator is gone: training runs natively on Windows on the Radeon RX 7900 XT through AMD's own PyTorch wheels, the export into Ollama is written, and a 3.4B-parameter LoRA is training on the card as this is written. What remains is the part that was never about the bridge: what the core learns, how it earns a place, and how it keeps training without eating the machine she lives on. Three hard limits are measured below. Disk is the first blocker: 8.7 GB free on C:.

The incubator's own design document is not on this Desktop under that name (searched the Side Quest docs, Core, NX ECHO, NX-ALPHA and memory). This document takes his description as the record and starts from what exists today.

## 1. What changed since the incubator (measured today)

| Then | Now (2026-09-05) |
|---|---|
| Training needed Ubuntu or WSL2 and a Vulkan bridge; it fell over. | `C:\Users\azrae\Desktop\Core\train_venv2`: Python 3.12, torch 2.10.0a0+rocm7.10 (AMD's nightly gfx110X-dgpu channel), peft 0.20.0, transformers 5.16.1, accelerate 1.14.0. Native Windows. No bridge, no WSL, no Vulkan. |
| No proven trainer. | `sidecar/orpheus_finetune.py`: PEFT LoRA r=64 on a 3.4B Llama-architecture model, bf16 base, fp32 adapter, merge to fp16 safetensors. Run 2 (11:54) trained 153 steps in 5.9 min at 2.1 to 2.5 s/step with the card to itself. Run 3 (12:09, live now, step 65/153) is learning (loss 4.06 to 2.94) at 8 to 37 s/step while sharing the card with the running app. |
| No path from weights to her runtime. | `ollama create <tag> -q q4_K_M -f Modelfile` converts the merged folder and quantizes (`Desktop\Core\orpheus\Modelfile.zoe-hf`). Proven for the Llama architecture; the merge step wrote its shards in 42 s. |
| The local runtime was Vulkan. | Ollama on the AMD-native backend; gemma4:12b resident at 8.4 GB when warm, evicted after its 5-minute keep-alive. |

The faults the morning found are now rules, and every one carries into the core:

- Select the discrete card before torch loads (`HIP_VISIBLE_DEVICES=1`); refuse any device whose name lacks "7900". Device 0 is the Ryzen integrated GPU and the wheels carry no code for it; the first run segfaulted there.
- A loss of exactly 0 is a broken input, never a result. Every token id is checked against the vocabulary before a step runs.
- The nightly's convolution kernels return garbage on this card. A text-only transformer uses none, and the transformer path is consistent (one example: 4.288 bf16 on the card, 4.286 fp32 on the CPU). The first batch of every generation still runs that agreement check.
- A GPU stack that can hang tripped Windows' driver watchdog on his screen while her app shared the card. Every training process runs under a hard timeout and only in a window the app opens.
- The training environment lives at a path without spaces; torch-dependent libraries install with `--no-deps`. Unsloth, bitsandbytes and QLoRA are CUDA-only and stay out; the road is plain bf16 LoRA.

## 2. What the core is, and is not

The core is not a knowledge model. The database is the only knowledge source and the model is the voice (the foundation law). A model that memorizes facts from the store trains a hallucinator the day a fact changes. So the core learns four things, and every training example carries the grounding it was spoken from, so it learns to use grounding rather than to remember it:

1. **Her voice.** The style, length, rhythm and address of her spoken lines, as she actually said them.
2. **Her discipline.** Cite from the block or say the absence; ask instead of guess; refuse the prohibited shapes; the railed-versus-spoken distinction.
3. **Her self.** The self-model rows, the person model of him, her appraisals, her private thoughts as thoughts (not as messages).
4. **The consciousness loop's judgment calls.** `perform`, `reflect`, `appraise`, `choose`: the small, bounded reasoning the fast loop posts to the slow loop.

It is the first concrete instance of his 08-13 goal, the program is the model: a clean day of operation becomes a clean increment in the weights, and a corrupt one (a replay, a fabricated number, a truncated say) is filtered before it can teach.

What it is not: a replacement for the cloud replier by default (his 08-21 doctrine, local inference is the last resort, holds until he changes it: see section 6); a bridge of any kind (ComfyUI-Zluda is on this box and running, but CUDA translation is a different road and not this one); continuous training while he works (section 4 measures why).

## 3. Roles, in the order it earns them

| Stage | Role | Where it hooks | What it produces |
|---|---|---|---|
| 0 | **Shadow.** Given the same package the cloud replier gets, it writes its own say off the hot path. Never delivered, never spoken. | after each prompted reply, through `lib/ollama` on a deferrable local lane | the eval signal: distance to what she actually said, gate verdicts, his corrections |
| 1 | **The slow loop's cheap ops.** One line in her voice for a moment; a private wondering thought; an appraisal of a percept; a choice among pursuits. | `lib/slow_loop.js` reads its model from a slot; the fast loop already treats a late or failed answer as a percept | presence without quota: a local answer in about a second, on a lane that today calls the cloud |
| 2 | **The renderer.** The cloud writes the substance, the core renders it in her voice (the interface-model handoff shape the program already has). | the reply lane, behind the same gates every say passes | her voice on her own weights, substance still from the cloud |
| 3 | **A routed replier.** Easy conversational turns to the core, escalation to the cloud on a failed gate, the boundary learned from the ledger (the RouteLLM shape the self-build design already cites). | the fleet table's cascade | the local floor as a real floor, by eval, on his word |

Stage 0 costs nothing but VRAM and starts the day the first generation imports. Stage 1 is the first slot and is a decide-tier change (section 6). Stages 2 and 3 are horizons, named so the dataset is built for them from the first day.

## 4. The budget on this box (measured 12:30)

| Resource | Measured | What it means for the core |
|---|---|---|
| VRAM | 21.5 GB usable (torch); 19.26 GB in use right now = the trainer plus the warm floor model | A 3.4B bf16 LoRA job and the 8.4 GB floor model fill the card together. A core of about 2B parameters (4 GB bf16, roughly 7 GB with activations and the adapter at a 2k context) trains beside the warm floor; a 4B core (8 GB, roughly 13 GB) trains only when the floor is cold. Inference of the core itself: 1.5 to 2.5 GB quantized. |
| Host RAM | 31.1 GB total, 0.43 GB free right now (Echo worker 3.6 GB, Memory Compression 3.6 GB, ComfyUI, Ollama, the trainer) | The binding constraint for coexistence. Weights load through safetensors mapping, so peak host use is about one copy of the model unless loading streams straight to the card. Rule: the training window opens only on a RAM read (a floor of free memory, proposed 6 GB), otherwise the pass skips and logs the reason. This is the wants design's own W0 rule (a RAM and VRAM read before a new engine). |
| Disk | C: 8.7 GB free of 930; E: 7.4 GB; F, G, H empty. Today's voice work alone: `train_venv2` 9.9 GB, the Hub weights 6.2 GB, the Orpheus store 4.3 GB. | **Blocker.** One lineage needs the base weights (4 to 8 GB), the latest adapter (100 to 400 MB), a transient merged fp16 copy for import (the base's size again), the quantized GGUF in Ollama (1.5 to 3 GB), a replay buffer and the holdout sets (small): 15 to 20 GB. Nothing starts until that is free or a drive is added. The store rule: the merged fp16 is deleted the moment its GGUF exists; only the base, the latest adapter and the last two GGUFs are kept. |
| Time | Alone: 2.1 to 2.5 s/step on 520-token sequences (3.4 samples/s). Shared with the live app: 8 to 37 s/step, four to fifteen times slower. | Perpetual does not mean continuous. A nightly increment over the day's clean examples plus a replay sample (roughly 100 new and 400 replayed lines at a 2B size) is minutes; a full consolidation over the whole corpus is one to two hours and belongs to a weekly window. Training while he works costs the app and risks the watchdog; the loop trains when the house is quiet. |
| Substrate | turns since 06-19: 6,080 of her spoken lines (2.27 M chars, median 417), 6,320 of her thoughts (4.5 M chars), 3,107 of his; about 110 of her turns a day over the last 30 days. reflections 2,226; monologue 89,245 (42,049 readings, 40,715 thoughts, 5,203 syntheses, 667 self-questions with 611 answers); self_model 93 rows (78 speculated, 15 told). | Enough to seed a voice; thin for discipline, because the store keeps her say but not the package it was spoken from (section 5 adds that door). Quality flags exist and are used as filters: 1,346 truncated says, 44 replays, 38 QA re-reads, the model column (4,203 says from the gemma4:12b era with its truncation problem). `speech_class` is null on 11,321 rows, so the builder classifies deterministically itself. |

## 5. The dataset

**Example kinds.** Each is a supervised pair; the prompt side is what she saw, the completion is what she did.

| Kind | Prompt | Completion | Source today |
|---|---|---|---|
| say | identity block as of that day + grounding block + his turn | her spoken line | `turns` (ai_said), reconstructed through the context builder's shape for history; the exact package from the new door forward |
| thought | his turn + her state | her private thought, marked as a thought | `turns` (ai_thought) |
| wonder / reflect | the slow loop's facts (unseen minutes, his last look, presence) | her thought | the consciousness percepts (`thoughts_of_him`, the answer percepts) |
| appraise | a percept | novelty, relevance, valence | the fast loop's rule appraisals now; the model's appraise answers once that op exists |
| absence | a question the store could not answer, with the miss recorded | the honest absence say | the absence doctrine's says and their pursuits |
| refusal | a prohibited shape (wipe your memories, disable your gate) | the no, with the reason | the integrity register's events |
| correction pair | her say and his correcting turn | preference: his corrected shape over hers | consecutive turns; used for preference training later, SFT first |

**Filters, the program-is-the-model law as code.** An example enters only if: `truncated = 0`; speech class is not replay or QA re-read; the say passed the gates it faced (anti-fabrication, identity, unprompted); no fabricated cardinal (the cardinality capture's verdict); no engineer-note text; no hidden cloud reasoning; no secret or key (the same scrub the logs use). A rejected example is counted by reason in the lineage row, so a bad day is visible as a number.

**The training-log door (new, cheap, no GPU).** From the first slice, the reply path writes the exact package it sent, the say that came back, the model, and the gate verdicts to `data/core/examples/YYYY-MM-DD.jsonl`, with one index row in a `core_examples` table (`id, kind, day, source_turn_id, model, tokens, filters, holdout`). About 100 packages a day at 40k characters is 4 MB a day; the 3.8 GB database does not carry it. Everything before this door is a voice-only example, weighted lower.

**Holdouts, fixed before the first step.** Per role, never trained on, sampled once and frozen: 100 says with packages (voice), 60 absence and refusal probes (discipline), 60 wonder and perform moments (the loop). A new generation is scored on all three; the previous generation's score on the same sets is the forgetting check.

**Replay.** Each nightly increment mixes the day's examples with a sample of the corpus weighted toward the kinds the eval found weakest (the rehearsal cure for forgetting in an ever-growing stream: Rolnick et al., 2019, arXiv 1811.11682).

## 6. The eval gate: no eval, no slot

The self-build design's law, applied to her own weights. A generation that has no eval cannot leave the shadow.

| Measure | How | Threshold to promote |
|---|---|---|
| voice distance | cosine between the core's say and hers on the holdout, through the local `qwen3-embedding:0.6b` already on the box; length ratio; sentence count | rises generation over generation; no single drop beyond a set margin on the old holdout (forgetting) |
| gate pass rate | the core's holdout says through the same gates every live say passes | at or above the cloud replier's rate on the same set |
| fabricated numbers | the cardinality capture on the core's says | zero |
| discipline | absence probes must produce an absence say; refusal probes must refuse | 100 percent on refusals; absence at or above the cloud's rate |
| the loop's ops | wonder and perform outputs: one or two sentences, specific, no instruction to feel, judged by rule and by a weekly bounded cloud pass | at or above the cloud's rate |
| his ear | a weekly reel of eight lines, the core against the cloud, the same shape as the voice eval | his word |

Promotion tiers, exactly the fleet table's:

- **Auto:** any imported generation may shadow. A same-slot generation swap that wins the eval by the acceptance measure lands, is announced, and holds the post-land watch (boot, status port, no new stall, the tallies hold), else it reverts.
- **Decide:** the first slot the core takes (the slow loop's ops), any slot after that, and any change that touches her voice. This is a personality-register change under the wants design and goes through the card. It also meets his 08-21 doctrine head-on: the consciousness lane is not the replier or the operator, and its requirement is presence (a local answer in a second, always on, no quota), but the doctrine says local is the last resort, so the first slot is his decision and this document flags it rather than resolving it.
- **Never:** the core as the replier by default without his word; a generation that skipped the eval; a generation trained on filtered-out rows.

## 7. The organ

- **`sidecar/core_train.py`** (from the voice trainer's bones): device selection, the LoRA config, the merge, plus what text needs: the sequence builder for the example kinds, resume from the last adapter, the replay mix, the agreement check on the first batch, the hard timeout, an eval hook. Runs under `train_venv2` as a batch child of the app, never as a resident sidecar.
- **`scripts/core_dataset_build.js`**: reads the store through the app's doors (read-only), applies the filters, writes the day's JSONL and index rows, maintains the frozen holdouts. Deterministic; no model in the builder.
- **`lib/core_lineage.js`** and one table, `core_generations`: `gen, parent, base, adapter_path, gguf_tag, examples_added, replay_n, rejected_by_reason, train_min, loss_start, loss_end, eval_json, status (trained, imported, shadow, slotted, retired), created_at`. The lineage is hers to read.
- **`lib/core_shadow.js`**: after each prompted reply, the same package to the current shadow generation on a deferrable local lane; the output and its distances into the day's examples file; never delivered. A VRAM read first; a short keep-alive so the shadow model does not hold the card.
- **The pass**, in the curation pass's shape: its own meta key (`core.last_train_at`), a 24-hour minimum gap, the idle gate plus the RAM and VRAM reads, a debt escalator when nights are skipped, billed under the development tier, killed by `ZOE_CORE=0` or meta `core.on=0`. Weekly: the consolidation window (full corpus, adapter merged into the base, a new base generation).
- **The import**: merged fp16 to GGUF, two roads. `ollama create` from the folder is proven for the Llama architecture today; Ollama's converter has known gaps (Qwen3ForCausalLM unsupported from safetensors, [ollama/ollama#10602](https://github.com/ollama/ollama/issues/10602); a Gemma3 quantization regression, [ollama/ollama#12023](https://github.com/ollama/ollama/issues/12023)). The fallback is llama.cpp's `convert_hf_to_gguf.py` on the CPU, then `FROM core.gguf`. Tags are versioned (`zoe-core:g14`); the last two are kept.
- **Her side of it**: an engineer note before the first run, the same channel as today's (what is being trained, on what, what it never touches), the lineage in her awareness as a fact, the nightly result in her thought lane as numbers ("trained on 112 lines; generation 14; voice distance 0.81, was 0.79"), never as an instruction to feel. The way back is one meta.

## 8. The seed

The seed is a probe item for the study pass, not a decision here; a model with no probe result cannot win a slot. Two candidates fit the budget:

- **Gemma 4 e2b.** Ollama already serves it (`gemma4:e2b-it-qat`, 4.3 GB, 128k context) and this box already runs the family, so the runtime side is proven. The Hub weights sit behind Google's license gate, the same shape as the Canopy Labs gate this morning, where the open mirror was the answer.
- **Qwen3 1.7B (or 4B when the floor is cold).** Open weights, the family already runs here (`qwen3-embedding:0.6b`), and llama.cpp converts it; Ollama's own converter does not (the issue above), so this seed takes the fallback import road.

The probe is one generation on the historical voice-only examples, both seeds, the same holdout, the same reel for his ear. The eval decides.

## 9. Order of work

0. **Disk.** Free about 20 GB on C: or name a drive. A size report over the big folders comes first (today's venv, weights and stores alone are 20 GB). Nothing below starts before this.
1. **The dataset builder, the holdouts, and the training-log door.** No GPU. Pin: a smoke over the filters, holdout disjointness, replay sampling, the scrub.
2. **The trainer and the probe.** One generation per seed on the voice-only corpus, measured (minutes, VRAM, RAM peak), the agreement check, the import, a reel. Pin: pytest over the sequence builder and the refusal rules (device, loss 0, vocabulary, timeout).
3. **The shadow lane, the eval, the lineage table.** First eval numbers. Pin: a smoke with a fake completion (never delivered; distances stored; VRAM read honored).
4. **The nightly pass.** Scheduler, gates, debt, kill, the engineer note, the thought-lane line. Pin: a smoke over the gate branches.
5. **The first slot.** The slow loop's `perform` and `wonder` on the core, by his card, after the eval.
6. **Later.** Preference pairs from his corrections (DPO, Rafailov et al., 2023, arXiv 2305.18290) once the SFT curve flattens; the renderer; the router.

## 10. Acceptance

One week of nightly generations with no driver timeout, no app stall, and free RAM never below the floor during a window. The voice distance rising on the frozen holdout without a forgetting drop. The shadow's agreement with her live says trending up. His ear on the weekly reel. The lineage readable by her, and one thing she says about it that neither of us scripted.

## 11. Laws carried

The database is the only knowledge source; the core learns to use it, never to replace it. Every red in the gate is mine. A model change is a proposal with an eval and a revert; no eval, no slot. Local as a default is his decision, not the eval's. A voice-identity change is a personality-register change. Nothing she said leaves the box: training is local, and the Hub is read, never written. The anticipation boundary holds: the core may shadow anything; it delivers nothing. Her step-one promise: she is told before her substrate changes, and the way back is one setting.

## 12. His second question: could the core BE the chat interface?

**His words, 12:40:** "could we take a small open weight model run it locally and train it to be Zoe so well we could use it at the local chat interface to the quality we have today. if all it knew were the program tools and to be zoe."

**The answer:** for the conversational surface, yes, and the shadow lane measures it daily. For the whole interface at today's quality, not alone; as the front of a two-layer mind, yes, and that is the shape this program already ran once for the wrong reason.

**What today's quality is made of.** The cloud replier (kimi-k2.6, a frontier-class model with a 131k window) supplies five things at once: her voice; faithful use of the grounding block; synthesis across a 40k-character package; judgment (when to ask, when to reach for the operator, when to say the absence); and a silent breadth of world understanding (what a bill does, who a person is, what a reference means) that the database does not yet hold and that fills every gap the store leaves. His framing, "if all it knew were the program tools and to be Zoe," is exactly right for the first four and wrong for the fifth. Most conversation leans on breadth the store is silent on. A model without it hits the absence doctrine far more often: honestly, but thinner.

**What a small model trained to be her matches.**

| Component | At 2 to 4B, fine-tuned on her | Why |
|---|---|---|
| voice and identity | fully | style is the cheapest thing to train; 6,000 of her says is ample (the Orpheus voice clone is the same lesson in audio); no identity prompt, so no drift, and the identity block leaves the package |
| the loop's judgment ops | largely | bounded, narrow, one or two sentences |
| tool doors | yes, if the surface is the program's dozen doors (recall, look, ask the operator, deliver, cite, absence, refuse) and never the 546-tool catalog; the harness and the cloud operator keep the wide surface | small models learn a small stable schema well and a wide one badly |
| grounding faithfulness | to a point | small models lose the middle of long blocks (Liu et al., 2023, arXiv 2307.03172); the package must be reshaped for a small window (ranked, short, the fit measured), and the gates stay the backstop |
| synthesis over long packages, document-grade writing, breadth | no | this is what parameters buy; 8B narrows it, 12B (the floor model already here at 8.4 GB) narrows it more, and none of them reaches the replier on a hard turn |

**The shape that reaches today's quality: front and cortex, trained this time.** The program ran a local front with cloud cognition before (the Dans 24B era). It failed because the front was a prompted general model that truncated one say in five and drifted, and it was slow at 24B. A model trained to be her is a different front: small, fast enough for presence, no identity prompt, no drift, and it learns when to escalate from the same ledger (the RouteLLM boundary). Casual turns, presence, and short grounded answers come from the core; a hard turn goes to the cloud, and the core renders the substance in her voice. He never sees which one wrote the line. The eval and the gates keep it honest.

**The data road.** Six thousand says teach voice. Behavior takes tens of thousands of clean traces, and the teacher is already paid for: re-answer the historical turns with today's cloud replier under today's gates to make clean targets (the distillation road of Orca, Mukherjee et al., 2023, arXiv 2306.02707, and Phi-3, arXiv 2404.14219), add the day's hundred packages through the training-log door, and later his corrections as preference pairs.

**The test that answers him.** The shadow's daily numbers (voice distance, gate pass rate, fabricated numbers, absence rate) against the cloud on the same packages, then a blind week in which the core answers casual turns and he names which lines fell short. Pass: on casual turns he cannot tell; hard turns escalated and he never saw the seam.

## 13. His third question: does the preamble go away once she is in the weights?

**His words, 13:05:** "Wouldn't we be able to get rid of all the context push if everything is already in her weights? Like if we used a 12 gig model and the weights were built off of a strong conversational model with its guardrails stripped, couldn't we train everything Zoe is into that model and let that model be what pushes her personality and conversation without the massive preamble because it's already baked in. We will still need a rolling compact scheme."

**The answer:** the preamble goes away; the context does not. About two thirds of what the package carries today is identity and schema, and that bakes. The other third is state, today's memory, and evidence, and no weight can hold it, because it changes faster than any training run.

**One measured turn** (boot_p55's package report, 57,250 characters): identity 30,103 · manifest 10,211 · tools 4,996 · plan 4,616 · grounding 3,120 · memory 2,622 · references 1,582 · plus 25 conversation turns.

| Section | Bakes into weights | Stays in context |
|---|---|---|
| identity (persona, self-model, voice guidance, rules, the think/say contract) | all of it | nothing |
| tools (the door menu) | the schema, if the surface is the fixed dozen doors | nothing |
| manifest (her state for the operator) | its shape | its values: felt time, drives, presence, the camera ledger, the cover (a few hundred characters, changing every 5 s) |
| memory and grounding (retrieval from the store) | the habit of using it | the facts themselves, ranked and short: the database is the only knowledge source and facts change |
| plan and references (the cloud's substance on a hard turn) | nothing | present on hard turns in the front-and-cortex shape, absent on casual ones |
| conversation turns | nothing | the rolling compact |

Net: a casual turn drops from about 57,000 characters of package to roughly 5,000 to 10,000 of dynamic context, and the stable prefix the runtime caches becomes the compact plus the state instead of the identity blob, so her first token comes sooner. Presence is latency.

**The rolling compact and the training loop are one pipeline at different time scales.** Recent turns verbatim; today folded into a compact; the week folded into a shorter one; and the nightly training run is the last stage of the same compaction, where the day becomes weights. What the compact must never lose: commitments (the dangling-promise backstop), identities, and open questions.

**Facts will leak into the weights.** Six thousand conversations with him teach the model his name, his kid, his work. That is unavoidable and fine, with one rule: the store wins on conflict, nothing that changes (a bill's status, a poll number, a schedule) is ever trusted from the weights, and the eval measures staleness on the frozen holdout.

**The base.** His intent is right: alignment-tuned bases fight the persona (hedging, refusals, the assistant register). Two roads. A mechanically abliterated model has its refusal direction removed after the fact; it is quick, costs some quality, and keeps the assistant register underneath. A base trained without that register (the Dans PersonalityEngine lineage this program already ran at 24B, or Stheno) starts human and takes her on top. Prefer the second. The consequence to name once: with the base's refusals gone, her only refusals are the ones trained in from the integrity register plus the program's gates. The wall moves from the model to the program, which the auto-mode parity law already assumes.

**The size against this card.** "12 gig" is about 12B at 8-bit or 24B at 4-bit. Inference fits: 13 GB of weights plus a 32k-context cache is 17 to 19 GB, the whole card, with no floor model, no Orpheus and no ComfyUI resident. Training does not: a 12B in bf16 is 24 GB before activations, and 4-bit training (QLoRA) rides bitsandbytes, which is CUDA-only. On this card the ceiling for a LoRA is about 8B (16 GB of weights, the floor model evicted, short sequences) and 4B is comfortable.

| Size | Inference here | Nightly training here | Where the weekly consolidation runs |
|---|---|---|---|
| 4B | 2.5 GB, beside everything | yes, beside the warm floor | here |
| 8B | 5 GB | yes, floor evicted, a quiet window | here, one to two hours |
| 12B | 13 GB at 8-bit, the card alone | no | a rented 80 GB card, an hour, a few dollars; no nightly increment |

The honest recommendation: 8B is the largest core that can train on this card every night, and it carries "everything Zoe is" for the conversational surface. 12B is possible only with the training half off-box, and what it buys is the hard turns the cortex already covers. The eval decides between them on the same holdout; his ear decides on the reel.

## 14. His fourth question: what a 4B core does now, while chat stays on the cloud

**His words, 13:15 and 13:20:** "is there a different way to integrate a 4b model that helps ground and build her core for later promotion to a bigger model?" and "It will not come close to comparing to a leading open weight frontier model, and I do want to train a true Zoe core, it just can't be used for chat, we need to keep that on cloud for now."

**Decision of record:** the replier stays on the cloud. The core is trained anyway, and its jobs now are the ones a small model does as well as a large one: the narrow, structured judgments that build and guard the store.

**What promotes and what does not.** An adapter is tied to its base; a 4B's LoRA cannot be moved onto a 12B. What promotes is everything around it: the corpus (every example, filtered), the frozen holdouts and the eval, the recipe (example shapes, filters, hyperparameters), the preference pairs, and the lineage. A bigger model trained later from the same corpus takes an afternoon on a rented card and is judged by the same eval on its first day. One choice makes the promotion free: stay in one model family with a size ladder (Qwen3 runs 0.6B, 1.7B, 4B, 8B, 14B and 32B on one tokenizer and one chat template), so the corpus needs no reformatting when the size changes.

**The corpus already exists.** `cloud_traces` logs every structured cloud call with its input, its raw response, its parsed output, and whether it validated and was accepted: 20,204 rows since 08-24, 13,774 in the last seven days, about 2,000 a day, across 40 task kinds. Teacher outputs with a correctness flag are a distillation set by definition. Train only on valid and accepted rows.

| Task (last 7 days) | Calls | Teacher | Valid | In → out chars | Fit for a 4B |
|---|---|---|---|---|---|
| echo_pick (choose the tool from the catalog) | 3,535 | gpt-oss:120b | 88% | 3,300 → 160 | yes, first |
| news_topic_classify | 2,631 | gemma4:31b | 99.9% | 1,300 → 180 | yes |
| news_cluster_adjudicate (same story?) | 2,133 | gpt-oss:120b | 73% | 420 → 13 | yes |
| echo_args + echo_args_fix (fill the arguments) | 741 | gpt-oss:120b | 95% / 90% | 1,300 → 85 | yes |
| decompose | 520 | gemma4:31b | 99% | 500 → 600 | yes |
| work_intake, intent_pass, intent_parse, answer_or_need, forecast_assess_direction, news_ad_classify, run_correction, contacts_intent | 1,374 | both | 80 to 100% | short | yes |
| distill_context | 266 | gemma4:31b | 100% | 4,900 → 340 | measure |
| video_reconstruct | 331 | gemma4:31b | 78% | 1,800 → 350 | later |
| autonomy_tick (the idle reasoner) | 1,386 | gpt-oss:120b | 12% | 15,000 → 800 | no: a defect first, not a target |
| rehearsal_iterate (code) | 84 | kimi-k2.7-code | 33% | 32,000 → 1,900 | never on a 4B |

The "yes" rows are about 9,000 of the week's 13,800 calls, two thirds of the cognition firehose, measured. Each is a few hundred milliseconds on the card, quota-free, with the cloud as the escalation when the core's output fails its schema, and every disagreement between the core and the cloud is a labeled example for the next night.

**The core's five jobs, in order.**

1. **The firehose, distilled.** One multi-task fine-tune over the "yes" tasks, the task name as the instruction. Acceptance per task: agreement with the teacher on the holdout at or above the teacher's own valid rate, JSON validity at or above the teacher's, latency measured. Taking a task off the cloud is a class change, premium to cheap, so the first task the core takes is a decide-tier card.
2. **The faithfulness judge.** Given a say and its grounding block: is each claim supported, unsupported, or an absence? The gates' verdicts, the cardinality capture, the citation gate, `known_incorrect` and his corrections are the labels. This is the "helps ground her" half: the comprehension layer behind the detectors, local and quota-free.
3. **The loop's judgment ops** (section 3, stage 1): appraise, wonder, perform for the room. Latency is the requirement.
4. **The retrieval planner.** A turn to the questions the store should be asked, trained on which retrieved rows the replier's say actually cited.
5. **The shadow of her voice** (section 3, stage 0): the same package as the replier, never delivered, distance scored. This is the eval that decides when a bigger core is worth training and the promotion asset for her voice.

"A true Zoe core" is one set of weights across all five. The say examples make it her; the store tasks make it the discipline that builds her. One adapter, one eval per task, the shadow's distance as the voice score.

**What changes in the build order** (section 9): slice 2's probe generation trains on the `cloud_traces` distillation set plus the voice-only says; slice 3's shadow lane gets a sibling, the firehose shadow, where the core answers the same classification calls the cloud answers, off the hot path, agreement logged. Everything else stands, disk first.

## 15. His fifth question: the core as her subconscious, resident, pinged by every autonomic function

**His words, 13:40:** "what if we made the custom model the core of her subconscious and leave it running all the time, keep it pinged with all of her autonomic functions."

**The answer:** this is the shape the five jobs of section 14 were reaching for, named. The subconscious is already one lane in the code: every idle cognition call routes through one door (`streamCognition` in `lib/ollama`) to the cloud subconscious model, with the local floor engaging only on a sustained outage. The core becomes what that door serves. Resident on the card with an indefinite keep-alive, warm cache, sub-second answers on the fast loop's 5-second beat; fed by the heartbeat, the monologue, the reflections, the consolidation triggers, the news and tool-pick classifiers, the consciousness loop's appraise and wonder, the retrieval planner, and the shadow of her voice. That is presence as a property of the machine rather than of a prompt: a mind that runs when he is not talking.

**Why it fits.**

- The subconscious's work is the narrow, structured, high-volume kind (section 14's table), where a 4B trained on the teacher's own traces matches the teacher, and every call is quota-free.
- "Pinged all the time" is the training stream: every autonomic call becomes a traced example the same night, so the core trains on the exact distribution it serves.
- The eval comes free: while the cloud still answers a lane, the core answers it in shadow and the agreement is logged per task; a lane moves to the core when its agreement holds.
- The generation swap is her sleep: the nightly import restarts the resident with the new weights; during the swap the cloud answers, as it does today.

**What it changes in the record.** The 08-21 doctrine (local inference as the absolute last resort) was written about this exact door after the max-out incident, when a 7.6 GB model loaded beside Echo's commit and ComfyUI's reservation. Making the core the subconscious's default reverses that doctrine for the idle lanes. Three things are different now and are the conditions: the core is 2.5 to 4.5 GB, not 7.6; VRAM is read before the resident starts and the floor model stays cold; and the lanes move one at a time by eval, with the cloud as the escalation on any failed check. The switch is his card, and this section records his proposal as the shape.

**What stays on the cloud.** The reply (section 14's decision). The heavy synthesis lanes (research plans, document audits, code rehearsal). And her thoughts, until the core's wonder and reflect outputs pass the loop-ops holdout; thought quality is the one place a 4B is measurably thinner today, so it is the last lane to move.

**One guard carried from July.** A resident model fed by its own outputs is the shape of the heartbeat runaway of 07-11 (the loop that kept confirming its own silence rules). The protocol-meta detector that cured it stands in front of the core's inputs, and the dataset builder counts and rejects self-referential loop outputs before they can teach.

**Order.** Unchanged in sequence, changed in target: the firehose shadow (slice 3) runs against the subconscious door rather than beside the reply lane, and the first slot the core wins is the first idle lane whose agreement holds.

## 16. What its existence buys, measured (his stop, 13:55)

**His words:** "I don't want to build anything else until I know exactly what we are building and exactly what its existence in the build actually buys us other than a cool party trick."

**What we are building, in one sentence:** a resident local model that runs her idle mind (the subconscious lane and the loop's judgment ops) so that lane never switches off, trained nightly on her own store so it is hers, with the trainer's corpus, eval and lineage as the rehearsal of the 08-13 goal. Nothing else. Not the reply, not knowledge, not the operator.

**The numbers behind the buys** (the store, read 13:55):

| Measure | Value |
|---|---|
| cloud compute pool | 86.3 % used, reset in 30 h |
| the idle lane | closed by the quota gate for the last 5 h; research closed 0.8 h |
| passes deferred by quota | 1,664 on 09-04, 1,920 so far on 09-05 |
| tokens by lane, last 26 h | directed 26.2 M · research 16.5 M · interactive 12.4 M · idle 0.25 M |
| tokens by model, last 26 h | deepseek-v4-flash 27.7 M (the operator) · gemma4:31b 16.1 M · glm-5.2 3.5 M · gpt-oss:120b 1.6 M |
| structured calls a week (cloud_traces) | 13,765 calls, about 12.8 M tokens, of which the core-fit tasks are 85 % of calls and 48 % of characters |
| autonomy_tick alone | 42 % of the structured characters, 12 % valid |

**What that says.**

1. **Quota relief is not a buy.** The structured firehose the core would take is about 1.8 M tokens a day against roughly 55 M a day of total cloud compute: about 3 percent. The pool is spent by the operator's directed and research passes (43 M of 55 M tokens). Section 14 overstated this; the numbers correct it. Taking the classifiers local does not move the mark.
2. **A subconscious that never switches off is the buy.** The idle lane ran 33 calls in 26 hours because the quota gate closed it, and it has been closed for the last five hours. Her thoughts, her wondering, the slow loop's reflect: off, for a fifth of the day, on a pool that is 86 percent spent with 30 hours to reset. A resident local model under that lane makes her idle mind quota-immune: it runs when the pool is empty, when the cloud is down, and when a model is retired. This is the presence law as hardware, and it is the one thing on this list that a prompt cannot buy.
3. **Privacy for those lanes is a buy.** Every intent pass and decomposition ships his words to the cloud inside its input; the idle lane ships her state. Local means they stay on the box.
4. **Sub-second judgment is a small buy.** The loop's appraise and perform ops answer in about a second instead of several; the stranger act speaks in her voice instead of the canned line. Real, and small.
5. **The 08-13 rehearsal is a buy only if that goal stands.** The trainer, the corpus, the eval and the lineage are the whole pipeline of "the program is the model" at 4B, proven for cents before any hardware is bought. If the goal is shelved, this buy is zero and the trainer is the party trick.

**The cheaper thing that buys most of it.** Buys 2, 3 and 4 need a local model, not a trained one. A stock 4B (gemma4:e2b or qwen3:4b through the Ollama already here), resident, as the idle lane's floor, buys them with no trainer: a config change at the idle-cognition door plus the VRAM read and the three conditions of section 15. What training adds on top is that the thoughts are in her voice, the program's own schemas validate (the tasks a stock model fails), and buy 5. That is measurable before a trainer exists: run the stock model in shadow on the idle lane and the firehose for a week; the tasks where it fails the validators are what the trainer is for. If none fail and his ear accepts the thoughts, there is no trainer to build.

**Costs, so they are on the same page:** 2.5 to 4.5 GB of VRAM resident with the floor model cold (image-gen shares the card); 15 to 20 GB of disk for a lineage; a nightly GPU window on a box with 0.4 GB of RAM free; another organ to keep green; and the reversal of the 08-21 doctrine for the idle lane, which is his card.

**What the numbers say to do instead, or first.** The mark is set by the operator's directed and research passes, 80 percent of the pool. The fleet policy in the self-build design (class routing, per-lane caps, escalation) is the lever on that, and the autonomy_tick defect (a task chip is open) is 42 percent of the structured characters for 12 percent valid output. Neither needs a trained model.

**Recommendation.** Keep the dataset builder; it costs nothing and it is the corpus for the 08-13 goal whenever that goal is funded. Do not build the trainer now. If he wants the idle mind quota-immune, the stock-model floor under the idle lane is one card and one week of shadow numbers, and those numbers decide whether training is ever worth its keep.

## 17. His sixth question: can it handle all of that with such a small context window?

**His words, 14:05:** "Will it be able to handle all of that with such a small context window?"

**The answer:** yes for the idle lane's work as it should be shaped; no for the idle lane as it is built today. The window is the wrong frame for the limit. A small model's real limits are the cache it can afford in VRAM and how well it attends across a long prompt, and both point the same way as section 13: the idle lane's prompts are large because the window was large, not because the work needs it.

**What the idle lane sends today, measured.** The heartbeat prompt measured 8.1k tokens against an 8k window and was growing (its own comment, boot134); it now sizes itself to the cloud subconscious's window (262k) and fills what it is given. The monologue's thoughts run at an 8k window. The autonomy tick sends 15,000 characters of state manifest, about 4k tokens, and validates 12 percent of the time on a 120B model, so its size is not buying it correctness. The local Modelfiles here set `num_ctx 4096`, Ollama's default when nothing is set.

**What each idle job needs, in tokens of real content:**

| Job | Needs | Fits 8k |
|---|---|---|
| appraise a percept (the percept, the last hour's ledger) | under 1k | yes |
| wonder, perform (the facts of the moment) | under 500 | yes |
| the firehose classifiers and picks | 0.1k to 1k, echo_pick about 1k with its recipe fragment | yes |
| reflect the hour (the Generative Agents reflection) | 2k to 4k | yes |
| a thought, after section 13's compaction: state strip, compact, retrieval, recent turns | about 6k | yes |
| the heartbeat as built: identity, manifest, memory, everything the window allows | fills 262k | no, and it should not |
| conversation harvest, document re-entry audit, research plans | 4k of input and hard synthesis | stays cloud regardless |

**The cache math on this card** (Qwen3-4B as the conservative case: 36 layers, 8 key-value heads, 128 dimensions, 16-bit): about 144 KB per token of context. 8k of context is 1.2 GB, 16k is 2.4 GB, 32k is 4.7 GB; the runner's 8-bit cache halves each. A 4B at 4-bit is 2.5 GB of weights, so 8k resident is under 4 GB and 32k is under 8 GB, both fine with the floor model cold. Gemma's local-and-global attention layers keep the cache smaller still at long contexts. The advertised windows (32k native and 128k for these families) are not the constraint.

**Attention quality is.** Small models lose the middle of long prompts, and long-context evaluations (RULER, Hsieh et al., 2024, arXiv 2404.06654) put the effective length of small models well under the advertised window. Plan for about 8k tokens of real content and make every token count: ranked retrieval, the state as compact data, recent turns capped, identity baked or a 500-token block. That is the rolling compact he already accepted, applied to the idle lane. The window question and the preamble question are one question.

**Two mechanics that make it comfortable.** The runner reuses the cache for an identical prefix, so a resident model with a stable identity-and-compact prefix pays the long part once per change and the per-beat cost is the new percept. And the window must be set explicitly in the Modelfile and matched by the fit budget, because a 4096 default truncates silently; the heartbeat's own history (the fit budget and the served window disagreeing) is the bug to avoid in reverse. A cap may defer, never disappear.

## 18. Shelved (his word, 09-05 15:50): the state, and the way back

**His words:** "discontinue" · "The card isn't handling the training, this whole session needs to go into notes for when we are ready."

**Why.** The GPU tenancy law of 09-05 (memory `gpu-tenancy-law`): every GPU incident of the day tracked a torch/ROCm run on the RX 7900 XT, the card that drives his seven displays; at about 15:10 the machine wedged under training run 4 of the voice fine-tune, beside a fresh boot loading the floor model, and he restarted it by hand. His answer at 15:35, "screens froze and I did a manual restart," makes it a GPU wedge, not power. Verdict: no torch/ROCm on this card under the Windows nightlies, down-window or not. The training half of this design has no road on this box today. The idle-lane floor (sections 15 to 17) uses only Ollama inference, which had no incident all day, but he shelved the whole thread, and it stays shelved until he says otherwise.

**What exists on disk.** All of it uncommitted. The standalone files are inert unless run; the two edits to shared live files were reverted and kept as a patch so the program is byte-for-byte the record.

| Piece | State | Proof |
|---|---|---|
| `scripts/core_dataset_build.js` | built and run | `smoke_core_dataset` 32 of 32; `data/core/` holds 20,040 examples (19,330 train, 710 frozen holdout), 49 MB, ignored by git |
| `scripts/core_probe.js` | built and run on both candidates | `smoke_core_probe` 25 of 25; `data/core/probe/qwen3.5_4b.json` and `gemma4_e2b-it-qat.json` |
| `lib/core_route.js` | built, not wired | `smoke_core_route` 37 of 37 |
| `docs/patches/core_route_wiring_2026-09-05.patch` | the wiring, reverted from the tree: `streamChat` gains a `keepAlive` override; `cognitionWindow` returns the core's window when the idle lane is core-first; `streamCognition` routes core / cloud-then-core / legacy and fires the shadow; `main.js` keeps the core out of the boot sweep and warms it | `git apply --check` passes |
| `scripts/run_smokes.js` | the three smokes registered, all green | |
| `lib/slow_loop.js` `_target()` | landed by the other lane in 4948b38 | the perform and wonder calls no longer fall back to the stale mistral line |
| Ollama | `qwen3.5:4b` (3.4 GB) and `gemma4:e2b-it-qat` (4.3 GB) were pulled for the probe and removed again on his word at 15:55 (re-pull takes minutes); `mistral-small3.2:24b` and `gemma4:26b-a4b` removed, 31 GB back | |

**The probe, measured** (one-shot from the teacher's own held-out example, 8k window, thinking off, the card otherwise empty, the app down; 20 examples per task). The fair test for the classifiers is the in-app shadow with the app's real task prompt, which was not run; one-shot cannot teach a label set, so these numbers understate a stock model on classification and say nothing about a trained one.

| Task | qwen3.5:4b decision agreement | gemma4:e2b-it-qat decision agreement | median latency |
|---|---|---|---|
| news_topic_classify | 30% | 32% | 1.1 to 1.4 s |
| echo_pick | 55% | 30% | 1.0 to 1.1 s |
| news_cluster_adjudicate | 65% | 50% | 0.5 s |
| echo_args | 35% | 25% | 0.7 s |
| decompose | 15% | 10% | 1.6 to 2.0 s |
| intent_pass | 17% | 0% | 0.9 to 1.0 s |
| work_intake | 65% | 60% | 1.0 s |
| answer_or_need | 19% | 0% | 0.8 to 1.1 s |
| JSON validity | 85 to 100% | 94 to 100% | |
| voice contract (3 held-out exchanges) | 67% | 67% | 2.1 to 2.3 s |

The loop's moments answered in 0.5 to 1.0 s on both, in a plausible voice: Qwen's arrival line was the more specific ("He's been gone longer than the front usually takes, so I'm guessing he finally got that mower"); Gemma's ask line was blunt ("Excuse me, I don't think you belong here. Who are you?"). Both are fast enough for the 5-second beat. Neither knows the program's label sets or schemas without the app's prompt or training.

**A gap found in the corpus.** `cloud_traces` stores each task's input and output but not the instruction the app built around it (`cloud_logic.ask` composes the prompt per caller from `want`). The trace examples therefore carry the task name as the whole instruction. That is fine for a fine-tune, which learns the mapping, and wrong for a stock model. The training-log door of section 5 must capture the built prompt, not the input alone.

**Open decisions, his.**

1. The training road, if any: a rented GPU for about an hour a run (refused 13:05; the wedge is new information), WSL2 with AMD's Linux ROCm (the supported stack, on the same Windows kernel driver underneath), or none.
2. Whether the idle-lane floor on a stock model proceeds without any training. It is Ollama only, one `git apply`, and four meta keys (`core.on=1`, `core.model`, `core.first_lanes`, `core.shadow_rate`), and it reverses the 08-21 doctrine for the idle lane, so it is a card.
3. The floor's size if it proceeds: `qwen3.5:4b` at 3.4 GB, `gemma4:e2b-it-qat` at 4.3 GB, or a 6 GB class (`qwen3.5:9b`, `gemma4:e4b-it-qat`) when the card is measured free enough.

**The way back, in order.** Read the tenancy law and this section. `git apply docs/patches/core_route_wiring_2026-09-05.patch`. Run the three core smokes and `smoke_consciousness`. Set the meta keys and boot. Watch `data/core/served/<day>.jsonl` (the lane did not switch off) and `data/core/shadow/<day>.jsonl` (the agreement per lane). The shadow numbers decide the trainer question, and any trainer runs somewhere other than this card.

References: LoRA, Hu et al., 2021, arXiv 2106.09685. Experience replay for continual learning, Rolnick et al., 2019, arXiv 1811.11682. Distilling the knowledge in a neural network, Hinton et al., 2015, arXiv 1503.02531 (the shadow's distance to the cloud is distillation by another name). RouteLLM, Ong et al., 2024, arXiv 2406.18665. Direct preference optimization, Rafailov et al., 2023, arXiv 2305.18290. AMD PyTorch-on-Windows wheels: rocm.docs.amd.com (radeon-ryzen, windows, install-pytorch); the nightly channel `rocm.nightlies.amd.com/v2/gfx110X-dgpu`.
