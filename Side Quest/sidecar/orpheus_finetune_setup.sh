#!/usr/bin/env bash
# One-time setup on the RENTED CUDA box (Ubuntu + PyTorch image). ~5 minutes. Then: python orpheus_finetune.py …
set -euo pipefail
pip install -q "unsloth[cu121-torch240] @ git+https://github.com/unslothai/unsloth.git" 2>/dev/null || pip install -q unsloth
pip install -q snac datasets trl transformers accelerate bitsandbytes torchaudio
if [ ! -d llama.cpp ]; then
  git clone --depth 1 https://github.com/ggml-org/llama.cpp
  (cd llama.cpp && pip install -q -r requirements/requirements-convert_hf_to_gguf.txt && cmake -B build -DGGML_CUDA=OFF >/dev/null && cmake --build build --config Release -j --target llama-quantize >/dev/null)
fi
unzip -oq zoe_dataset.zip
echo "setup done: $(ls zoe_dataset/wavs | wc -l) clips"
