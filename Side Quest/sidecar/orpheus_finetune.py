"""
orpheus_finetune.py — HER VOICE ON ORPHEUS, by fine-tune, ON THIS BOX (Lucas, 2026-09-05: "I want to clone the
proper voice and get the more natural feel from orpheus" · "what's wrong with our gpu? there's almost nothing
loaded on it right now"). Plain PEFT + TRL/transformers — no Unsloth (CUDA-only), no bitsandbytes — so it runs on
PyTorch-ROCm (AMD's Windows wheels; the 7900 XT appears as torch.cuda under ROCm) and on CUDA alike.

What it does, in order:
  1. loads the dataset (zoe_dataset/metadata.csv: file|text; 24 kHz mono wavs rendered from her Kokoro voice)
  2. encodes every clip with SNAC 24 kHz into the model's audio tokens (7 per frame: id = 128266 + code + pos*4096)
  3. builds Orpheus training sequences:
       [start_of_human] "zoe: {text}" [eot] [end_of_human] [start_of_ai] [start_of_speech] {audio} [end_of_speech] [end_of_ai]
  4. LoRA-trains canopylabs/orpheus-3b-0.1-ft (the emotive model, so her voice keeps <laugh> <sigh> <chuckle>),
     r=64 on every projection, 3 epochs by default, bf16 base + fp32 adapter
  5. merges the adapter and saves an fp16 safetensors folder → `ollama create orpheus-zoe -f Modelfile.zoe-hf`
     (Ollama converts a Llama-architecture safetensors folder itself; `-q q4_K_M` quantizes)

Usage:
  python orpheus_finetune.py --data ./zoe_dataset --out ./out [--epochs 3] [--base canopylabs/orpheus-3b-0.1-ft]
  python orpheus_finetune.py --data ./zoe_dataset --encode-only      # just the SNAC pass (checks the GPU + the data)
"""
import argparse
import csv
import json
import os
import time

# THE CARD, before torch loads (13:58: the first run trained on the Ryzen's integrated graphics — HIP device 0 —
# and its first kernel segfaulted; the gfx110X wheels carry no code for that chip). On this box the 7900 XT is
# HIP device 1; ORPHEUS_HIP_DEVICE overrides; main() refuses any device whose name lacks --require-device.
os.environ.setdefault("HIP_VISIBLE_DEVICES", os.environ.get("ORPHEUS_HIP_DEVICE", "1"))

TOKENISER_LENGTH = 128256
END_OF_TEXT = 128009
START_OF_SPEECH, END_OF_SPEECH = TOKENISER_LENGTH + 1, TOKENISER_LENGTH + 2
START_OF_HUMAN, END_OF_HUMAN = TOKENISER_LENGTH + 3, TOKENISER_LENGTH + 4
START_OF_AI, END_OF_AI = TOKENISER_LENGTH + 5, TOKENISER_LENGTH + 6
AUDIO_BASE = TOKENISER_LENGTH + 10


def load_meta(data_dir):
    rows = []
    with open(os.path.join(data_dir, "metadata.csv"), encoding="utf-8") as f:
        r = csv.reader(f, delimiter="|")
        header = next(r)
        assert header[:2] == ["file", "text"], header
        for row in r:
            if len(row) >= 2 and row[0].strip():
                rows.append((os.path.join(data_dir, row[0].strip()), row[1].strip()))
    return rows


TAIL_SILENCE_S = 0.4   # run 2 (15:30): clips ended on the last phoneme, so the model never saw "silence, then the end"
                       # and ran on into an eleven-second second take; a silent tail before the end marker is the cue


def read_wav_24k(path, tail_silence_s=TAIL_SILENCE_S):
    """16-bit mono 24 kHz wav → float32 tensor [1, T] (no torchaudio: the dataset is ours and uniform), with a
    silent tail so the end of speech is a thing the model can hear coming."""
    import numpy as np
    import torch
    with open(path, "rb") as f:
        b = f.read()
    sr = int.from_bytes(b[24:28], "little"); ch = int.from_bytes(b[22:24], "little")
    if sr != 24000 or ch != 1:
        raise RuntimeError(f"{path}: expected 24 kHz mono, got {sr} Hz {ch} ch")
    pcm = np.frombuffer(b[44:], dtype="<i2").astype(np.float32) / 32768.0
    if tail_silence_s > 0:
        pcm = np.concatenate([pcm, np.zeros(int(sr * tail_silence_s), dtype=np.float32)])
    return torch.from_numpy(pcm).unsqueeze(0)


def snac_tokens(snac, wav_path, device):
    import torch
    wav = read_wav_24k(wav_path)
    with torch.inference_mode():
        codes = snac.encode(wav.unsqueeze(0).to(device))
    l0, l1, l2 = [c.squeeze(0).squeeze(0).tolist() for c in codes]
    frames = min(len(l0), len(l1) // 2, len(l2) // 4)
    ids = []
    for i in range(frames):
        seq = [l0[i], l1[2 * i], l2[4 * i], l2[4 * i + 1], l1[2 * i + 1], l2[4 * i + 2], l2[4 * i + 3]]
        ids += [AUDIO_BASE + int(c) + pos * 4096 for pos, c in enumerate(seq)]
    return ids


def build_examples(rows, tok, snac, device, voice, max_len, log=print):
    examples, total_frames, skipped = [], 0, 0
    for i, (wav, text) in enumerate(rows):
        try:
            audio_ids = snac_tokens(snac, wav, device)
        except Exception as e:  # noqa: BLE001
            log(f"  skip {os.path.basename(wav)}: {e}"); skipped += 1; continue
        text_ids = tok.encode(f"{voice}: {text}", add_special_tokens=True)
        ids = [START_OF_HUMAN] + text_ids + [END_OF_TEXT, END_OF_HUMAN, START_OF_AI, START_OF_SPEECH] + audio_ids + [END_OF_SPEECH, END_OF_AI]
        if len(ids) > max_len:
            skipped += 1; continue
        examples.append({"input_ids": ids, "labels": list(ids), "attention_mask": [1] * len(ids)})
        total_frames += len(audio_ids) // 7
        if (i + 1) % 50 == 0:
            log(f"  encoded {i + 1}/{len(rows)}")
    return examples, total_frames, skipped


class PadCollator:
    def __init__(self, pad_id):
        self.pad_id = pad_id

    def __call__(self, batch):
        import torch
        n = max(len(b["input_ids"]) for b in batch)
        ids = torch.full((len(batch), n), self.pad_id, dtype=torch.long)
        lab = torch.full((len(batch), n), -100, dtype=torch.long)
        att = torch.zeros((len(batch), n), dtype=torch.long)
        for i, b in enumerate(batch):
            L = len(b["input_ids"])
            ids[i, :L] = torch.tensor(b["input_ids"]); lab[i, :L] = torch.tensor(b["labels"]); att[i, :L] = 1
        return {"input_ids": ids, "labels": lab, "attention_mask": att}


END_WEIGHT = 5.0   # run 2: the end marker appears once per sequence against ~57 audio frames × 7 tokens and was
                   # learned weakly; its loss is weighted so the end of a line is learned as firmly as its sounds


def weighted_lm_loss(model, inputs, return_outputs=False, num_items_in_batch=None, end_weight=END_WEIGHT):
    """Token-level cross-entropy with the end-of-speech and end-of-ai targets weighted END_WEIGHT×."""
    import torch
    import torch.nn.functional as F
    labels = inputs["labels"]
    out = model(input_ids=inputs["input_ids"], attention_mask=inputs["attention_mask"])
    logits = out.logits[:, :-1, :].float()
    tgt = labels[:, 1:]
    loss_tok = F.cross_entropy(logits.reshape(-1, logits.size(-1)), tgt.reshape(-1), ignore_index=-100, reduction="none").view(tgt.shape)
    w = torch.ones_like(tgt, dtype=loss_tok.dtype)
    w = torch.where((tgt == END_OF_SPEECH) | (tgt == END_OF_AI), torch.full_like(w, end_weight), w)
    w = torch.where(tgt == -100, torch.zeros_like(w), w)
    loss = (loss_tok * w).sum() / w.sum().clamp(min=1.0)
    return (loss, out) if return_outputs else loss


class WeightedTrainer:
    """Built lazily so the module imports without transformers."""

    @staticmethod
    def make(Trainer):
        class _T(Trainer):
            def compute_loss(self, model, inputs, return_outputs=False, num_items_in_batch=None):
                return weighted_lm_loss(model, inputs, return_outputs=return_outputs, num_items_in_batch=num_items_in_batch)
        return _T


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", default="./out")
    # canopylabs/orpheus-3b-0.1-ft is gated on the Hub (a login + a gate = his account); Unsloth's mirror of the same
    # weights is open and lives in the store once downloaded (Desktop\Core\hf\orpheus-3b-0.1-ft).
    ap.add_argument("--base", default=os.environ.get("ORPHEUS_BASE") or (r"C:\Users\azrae\Desktop\Core\hf\orpheus-3b-0.1-ft" if os.path.exists(r"C:\Users\azrae\Desktop\Core\hf\orpheus-3b-0.1-ft\config.json") else "unsloth/orpheus-3b-0.1-ft"))
    ap.add_argument("--voice", default="zoe")
    ap.add_argument("--epochs", type=float, default=3.0)
    ap.add_argument("--lr", type=float, default=2e-4)
    ap.add_argument("--max-len", type=int, default=2048)
    ap.add_argument("--batch", type=int, default=1)
    ap.add_argument("--accum", type=int, default=8)
    ap.add_argument("--rank", type=int, default=64)
    ap.add_argument("--encode-only", action="store_true")
    ap.add_argument("--require-device", default="7900", help="refuse to run unless the selected GPU's name contains this")
    ap.add_argument("--snac-device", default="cpu", help="where SNAC encodes (cpu: the ROCm nightly's conv kernels return garbage)")
    a = ap.parse_args()

    import torch
    print(f"torch {torch.__version__} | hip {getattr(torch.version, 'hip', None)} | cuda-api available {torch.cuda.is_available()} | HIP_VISIBLE_DEVICES={os.environ.get('HIP_VISIBLE_DEVICES')}")
    device = "cuda" if torch.cuda.is_available() else "cpu"
    if device == "cuda":
        name = torch.cuda.get_device_name(0)
        print(f"device: {name} | {torch.cuda.get_device_properties(0).total_memory / 1e9:.1f} GB")
        if a.require_device and a.require_device not in name:
            raise SystemExit(f"refusing to run on '{name}': --require-device '{a.require_device}' (set HIP_VISIBLE_DEVICES to the discrete card)")
    else:
        raise SystemExit("no GPU visible to torch — not training on the CPU")
    from snac import SNAC
    from transformers import AutoTokenizer
    rows = load_meta(a.data)
    print(f"dataset: {len(rows)} clips")
    tok = AutoTokenizer.from_pretrained(a.base)
    t0 = time.time()
    # THE ENCODER RUNS ON THE CPU (14:30): on the nightly ROCm kernels SNAC's encode returned garbage — huge random
    # ints and zeros, 0 % agreement with the CPU — which fed out-of-range ids to the model and a loss of exactly 0
    # for a whole run. The encoder is small; the CPU is right and fast enough. The card is for the model.
    snac_device = a.snac_device
    snac = SNAC.from_pretrained("hubertsiuzdak/snac_24khz").eval().to(snac_device)
    examples, total_frames, skipped = build_examples(rows, tok, snac, snac_device, a.voice, a.max_len)
    bad = [e for e in examples if max(e["input_ids"]) >= len(tok) or min(e["input_ids"]) < 0]
    if bad:
        raise SystemExit(f"{len(bad)} examples carry ids outside the vocabulary ({len(tok)}) — the encoder is wrong; refusing to train")
    print(f"ids in range for all {len(examples)} examples (vocab {len(tok)})")
    print(f"examples: {len(examples)} | skipped {skipped} | audio frames {total_frames} (~{total_frames / 12 / 60:.1f} min) | {time.time() - t0:.0f}s")
    del snac
    if a.encode_only:
        os.makedirs(a.out, exist_ok=True)
        with open(os.path.join(a.out, "examples_head.json"), "w") as f:
            json.dump({"count": len(examples), "first_len": len(examples[0]["input_ids"]) if examples else 0, "head": examples[0]["input_ids"][:24] if examples else []}, f)
        print("encode-only: done"); return

    from datasets import Dataset
    from peft import LoraConfig, get_peft_model
    from transformers import AutoModelForCausalLM, Trainer, TrainingArguments
    bf16 = device == "cuda" and torch.cuda.is_bf16_supported()
    model = AutoModelForCausalLM.from_pretrained(a.base, torch_dtype=torch.bfloat16 if bf16 else torch.float16, low_cpu_mem_usage=True).to(device)
    model.gradient_checkpointing_enable()
    model.enable_input_require_grads()
    lcfg = LoraConfig(r=a.rank, lora_alpha=a.rank, lora_dropout=0.0, bias="none", task_type="CAUSAL_LM",
                      target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"])
    model = get_peft_model(model, lcfg)
    model.print_trainable_parameters()
    ds = Dataset.from_list(examples)
    args = TrainingArguments(output_dir=os.path.join(a.out, "ckpt"), per_device_train_batch_size=a.batch, gradient_accumulation_steps=a.accum,
                             num_train_epochs=a.epochs, learning_rate=a.lr, warmup_steps=10, logging_steps=10, save_steps=200, save_total_limit=2,
                             bf16=bf16, fp16=(device == "cuda" and not bf16), optim="adamw_torch", weight_decay=0.01, lr_scheduler_type="linear",
                             report_to="none", remove_unused_columns=False, dataloader_pin_memory=False)
    trainer = WeightedTrainer.make(Trainer)(model=model, args=args, train_dataset=ds, data_collator=PadCollator(tok.pad_token_id if tok.pad_token_id is not None else END_OF_TEXT))
    print(f"end-of-speech weight {END_WEIGHT}x · tail silence {TAIL_SILENCE_S}s · epochs {a.epochs}")
    t1 = time.time()
    trainer.train()
    print(f"trained in {(time.time() - t1) / 60:.1f} min")
    merged_dir = os.path.join(a.out, "merged")
    merged = model.merge_and_unload()
    merged.save_pretrained(merged_dir, safe_serialization=True)
    tok.save_pretrained(merged_dir)
    print(f"merged fp16 safetensors -> {merged_dir}")
    print("next: ollama create orpheus-zoe -q q4_K_M -f Modelfile.zoe-hf   (FROM <merged_dir>)")


if __name__ == "__main__":
    main()
