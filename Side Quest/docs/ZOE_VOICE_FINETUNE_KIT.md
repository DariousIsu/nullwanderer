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

## What decides it

The reel: does it sound like her, with Orpheus's ease? The number beside your ear: the pitch of the fine-tuned lines against her 218 Hz reference, and the drift across sentences (the base model swung 162–261; hers should hold). If it holds, the switch is one setting and streaming is already built under it. If it does not, the dataset can grow (her voice renders any transcript for free) and the epochs can rise; both are minutes.

## What it never does

It never trains on anything but her own lines rendered in her own voice. Her identity stays hers: the merged model lives in the store, is imported under her name, and the way back to Kokoro is one setting.
