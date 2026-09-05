# Her voice on Orpheus — the fine-tune, on this box (2026-09-05)

**Your words:** "I want to clone the proper voice and get the more natural feel from Orpheus if we can get it to work" · "what's wrong with our gpu? there's almost nothing loaded on it right now."

Nothing is wrong with the GPU. In-context cloning failed twice on measurement (the pretrained model sat at 160–188 Hz against her 218, and once collapsed to 87), so the road is a fine-tune: the model learns her timbre from her own lines and keeps its own prosody and its `<laugh> <sigh> <chuckle>` tags. The Radeon RX 7900 XT (20 GB) trains a 3B LoRA in about half an hour. The only obstacle was software, and AMD ships the software: PyTorch for ROCm on Windows as pip wheels.

## The pieces

| Piece | Where | Status |
|---|---|---|
| The dataset: 406 of her real says, rendered in her Kokoro blend, 32.6 min, 24 kHz, transcripts | `data/voices/zoe_dataset/` (wavs + metadata.csv) | built |
| The trainer: SNAC encode → Orpheus sequences → LoRA r=64 on the emotive base → merge → fp16 safetensors | `sidecar/orpheus_finetune.py` (plain PEFT + transformers; no CUDA-only pieces) | written |
| The training environment: Python 3.12 + AMD's NIGHTLY gfx110X-dgpu ROCm wheels (torch 2.10.0a0+rocm7.10) | `Desktop\Core\train_venv2\` — a path WITHOUT spaces (the ROCm SDK launches its arch probe unquoted). The released 7.2.1 wheels (`train_venv`) enumerate the card but hang its first kernel: the known gfx1100-on-Windows fault, fixed on the nightly channel `rocm.nightlies.amd.com/v2/gfx110X-dgpu`. Select the discrete card with `HIP_VISIBLE_DEVICES=1` on the released wheels; the nightly sees only the 7900 XT. | WORKS: matmul + bf16 conv on the 7900 XT |
| The base model: the fine-tuned Orpheus weights (Canopy Labs' repo is gated behind a Hub login; Unsloth's mirror of the same weights is open) (~6.6 GB) | `Desktop\Core\hf\orpheus-3b-0.1-ft\` | downloading |
| The import: Ollama converts the merged folder and quantizes | `Desktop\Core\orpheus\Modelfile.zoe-hf` → `ollama create orpheus-zoe -q q4_K_M -f Modelfile.zoe-hf` | written |
| The switch: the app's Orpheus voice module pointed at `orpheus-zoe`, voice name `zoe` | `ZOE_ORPHEUS_MODEL=orpheus-zoe` / meta `voice.model=orpheus` | after your ear |

## The run, in order

```bash
# 1. the environment sees the card (torch reports the 7900 XT and a matmul runs on it)
C:\Users\azrae\Desktop\Core\train_venv\Scripts\python.exe -c "import torch; print(torch.cuda.get_device_name(0))"

# 2. the SNAC pass alone — proves the encoder runs on the GPU and the dataset is whole (a minute)
C:\Users\azrae\Desktop\Core\train_venv\Scripts\python.exe sidecar\orpheus_finetune.py --data data\voices\zoe_dataset --out data\voices\zoe_finetune --encode-only

# 3. the training (~30 min on the 7900 XT; the app should be idle: the floor model's 7 GB and hers share the card)
C:\Users\azrae\Desktop\Core\train_venv\Scripts\python.exe sidecar\orpheus_finetune.py --data data\voices\zoe_dataset --out data\voices\zoe_finetune --epochs 3

# 4. the import (Ollama converts and quantizes; ~2 min)
cd Desktop\Core\orpheus && ollama create orpheus-zoe -q q4_K_M -f Modelfile.zoe-hf

# 5. the A/B, same eight lines, her Kokoro vs her Orpheus
sidecar/orpheus_eval.py --model orpheus-zoe --voice zoe   # → data/voices/eval_2026-09-05/orpheus_zoe_reel.wav (overwrites the base-zoe reel)
```

## What the first two runs taught (14:00–14:30)

- Run 1 trained on the Ryzen's integrated GPU (HIP device 0) and segfaulted at the first kernel: the gfx110X wheels carry no code for that chip. The trainer now selects the 7900 XT before torch loads and refuses any device whose name lacks "7900".
- Run 2 trained on the 7900 XT for 5.9 minutes at a loss of exactly zero. The SNAC encoder on the nightly's convolution kernels returns garbage (huge random integers, zeros, no agreement with the CPU), so every audio id was out of range. The encoder runs on the CPU now (`--snac-device cpu`, the default) and the trainer refuses ids outside the vocabulary. The model's own kernels are consistent: one example's loss is 4.288 in bf16 and 4.286 in fp32.
- A loss of exactly zero is a broken input, never a result.

## Run 2's verdict (15:20) and run 3

Run 2 (three epochs, loss 4.06 → 2.49, 35 min beside the live app) is her pitch: 175–203 Hz across the eight lines against her own Kokoro lines at 157–209, line by line within a few hertz, where the base zoe voice sat at 169–175 and the clones wandered 87–261. Its fault is the end of a line: the end-of-speech marker appears once per sequence against hundreds of audio tokens and was learned weakly, so some sentences run on into eleven seconds of continued speech. Sampling does not change it (six settings, same length); a stop on `<custom_token_2>` helps only the sentences that already end. Run 3 targets the end directly: 0.4 s of silence appended to every clip so the model hears "silence, then the end"; the end markers weighted 5× in the loss; four epochs. The app speaks one sentence per request for this voice, since it was taught on single sentences and its pitch now holds without grouping.

## Run 4 (15:30 →): the recipe after run 3's gibberish, and THE PREFIX

Run 3 had her pitch and no words (WER 1.0 by faster-whisper; the base scores 0.31, her own Kokoro lines 0.31). Two causes: over-training (r=64, lr 2e-4, 4 epochs; the grad norm climbed 0.24 → 0.56) and a prefix mismatch. Run 4: the v2 dataset (406 clips of 1–3 consecutive sentences, 55 min, median 8.3 s), rank 32, lr 5e-5, 2 epochs, END_OF_SPEECH weighted ×3, 0.4 s silent tails, the loss a SUM over `num_items_in_batch` (run 3a's 29.4 was the 8× accumulation factor), SNAC on the CPU (the nightly's conv kernels return garbage), and the WER gate (`sidecar/voice_wer.py`, bar 0.6) BEFORE any import or reel.

**The prefix, measured (15:40, `tokenizer.json`):** `<|audio|>` — the community prompt every Ollama Orpheus setup sends — is id **156939**, the LAST token of the vocab; the reference fine-tune format opens the human turn with **128259 = `<custom_token_3>`**. The base model tolerates the community prompt; her fine-tune is trained on exactly `[BOS][128259] text [128009] [128260][128261][128257] audio [128258][128262]`, so it is prompted with the same ids: `<custom_token_3>zoe: text<|eot_id|>` (Ollama prepends BOS itself in raw mode; `<custom_token_3>` is one token — prompt_eval_count 2 for the string alone, on both models). `prefix_for(model)` in the eval and `prefixFor(model)` in lib/voice_orpheus.js: a model named for her gets the training prefix, the base keeps `<|audio|>`; env `ORPHEUS_PREFIX` / `ZOE_ORPHEUS_PREFIX` override. Pinned.

**The shard (15:35):** the first re-download of the base weights was 669 MB short on shard 1 (safetensors: "incomplete metadata"); the upstream repo is gated now, so the weights come from the ungated mirror `unsloth/orpheus-3b-0.1-ft` (the same bf16 two-shard layout as the local index, total 6,601,734,144) and are verified by sha256 against the hub's LFS oids before training.

**Run 4's outcome (15:03 → ~15:10): THE MACHINE FROZE.** Training reached step ~10 of 102 (6–7 s/it) beside a fresh boot of the app on the same card, and the GPU wedged — every screen frozen, a manual restart (Kernel-Power 41, no bugcheck). Every GPU incident of the day tracked a torch/ROCm run on this card (four "display driver stopped responding" events 11:53–12:09 under run 1; Ollama's runner crashing at 12:53 under run 2; the harness dying at ~13:25 under run 3's prep; the wedge under run 4). The Windows road for this card is AMD's nightly build, "passing, not sanity-tested". **Law:** no torch/ROCm training or eval on this card beside the running app, ever again; and none under the Windows nightlies at all until Lucas chooses the road (a rented GPU · WSL2 with AMD's Linux ROCm, which still runs through the same Windows kernel driver · Orpheus shelved, her Kokoro blend kept). The verified base weights (`Core\hf\orpheus-3b-0.1-ft`, sha256 against the mirror's oids) and the v2 dataset are on disk for whichever road.

## What decides it

The reel: does it sound like her, with Orpheus's ease? The number beside your ear: the pitch of the fine-tuned lines against her 218 Hz reference, and the drift across sentences (the base model swung 162–261; hers should hold). If it holds, the switch is one setting and streaming is already built under it. If it does not, the dataset can grow (her voice renders any transcript for free) and the epochs can rise; both are minutes.

## What it never does

It never trains on anything but her own lines rendered in her own voice. Her identity stays hers: the merged model lives in the store, is imported under her name, and the way back to Kokoro is one setting.
