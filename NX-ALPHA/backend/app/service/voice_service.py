"""
AURA NX-Alpha — Voice Service
STT : faster-whisper (CPU, tiny.en) → GPU when VRAM headroom exists
TTS : piper-tts (CPU, Phase 1) → MOSS-TTS-Realtime (GPU, Phase 2+)

AUDIO DEVICES:
    Enumerated via sounddevice. User selects input/output device by index.
    Device index -1 = system default.

VOICE PROFILE:
    Stored at ~/.aura/models/voice/aura-voice-profile.json
    Created via POST /voice/profile (text description).
    Reference audio samples stored at ~/.aura/models/voice/samples/
    Both consumed by MOSS-TTS-Realtime when it activates in Phase 2.

PHASE GATE:
    Phase 1  — faster-whisper CPU  +  piper-tts CPU
    Phase 2+ — faster-whisper CPU  +  MOSS-TTS-Realtime GPU (same profile, no frontend changes)
"""

import asyncio
import io
import json
import logging
import threading
import wave
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

# ── Voice file paths ───────────────────────────────────────────────────────────
VOICE_DIR          = Path("~/.aura/models/voice").expanduser()
VOICE_PROFILE_PATH = VOICE_DIR / "aura-voice-profile.json"
PIPER_MODEL_DIR    = VOICE_DIR / "piper"
SAMPLES_DIR        = VOICE_DIR / "samples"

# ── Lazy-loaded model handles ─────────────────────────────────────────────────
_whisper_model     = None
_whisper_lock      = threading.Lock()
_piper_voice       = None
_piper_lock        = threading.Lock()
_chatterbox_model  = None
_chatterbox_lock   = threading.Lock()


# ─────────────────────────────────────────────────────────────────────────────
# AUDIO DEVICE ENUMERATION
# ─────────────────────────────────────────────────────────────────────────────

def list_audio_devices() -> dict:
    """
    Enumerate available audio input/output devices via sounddevice.
    Device index -1 represents "System Default" for both directions.
    Returns lists suitable for the frontend device selector dropdowns.
    """
    try:
        import sounddevice as sd
        devices = sd.query_devices()

        inputs  = [{"index": -1, "name": "System Default", "channels": 1}]
        outputs = [{"index": -1, "name": "System Default", "channels": 2}]

        for i, dev in enumerate(devices):
            if dev["max_input_channels"] > 0:
                inputs.append({
                    "index":    i,
                    "name":     dev["name"],
                    "channels": dev["max_input_channels"],
                })
            if dev["max_output_channels"] > 0:
                outputs.append({
                    "index":    i,
                    "name":     dev["name"],
                    "channels": dev["max_output_channels"],
                })

        return {"inputs": inputs, "outputs": outputs}

    except ImportError:
        logger.warning("[voice_service] sounddevice not installed — returning system default only")
    except Exception as exc:
        logger.error("[voice_service] list_audio_devices error: %s", exc)

    return {
        "inputs":  [{"index": -1, "name": "System Default", "channels": 1}],
        "outputs": [{"index": -1, "name": "System Default", "channels": 2}],
    }


# ─────────────────────────────────────────────────────────────────────────────
# STT — faster-whisper (CPU)
# ─────────────────────────────────────────────────────────────────────────────

def _get_whisper_model():
    """
    Lazy-load faster-whisper. GPU-first: tries CUDA (covers NVIDIA and ROCm)
    with base.en + float16. Falls back to CPU tiny.en + int8 on any error.
    Thread-safe — model is loaded once and reused by both voice and watch services.
    """
    global _whisper_model
    if _whisper_model is not None:
        return _whisper_model

    with _whisper_lock:
        if _whisper_model is not None:
            return _whisper_model
        try:
            from faster_whisper import WhisperModel
            try:
                logger.info("[voice_service] Loading faster-whisper base.en (GPU/CUDA)...")
                _whisper_model = WhisperModel(
                    "base.en",
                    device="cuda",
                    compute_type="float16",
                )
                logger.info("[voice_service] faster-whisper ready — base.en on GPU")
            except Exception as gpu_exc:
                logger.warning(
                    "[voice_service] GPU unavailable (%s) — falling back to CPU tiny.en",
                    gpu_exc,
                )
                _whisper_model = WhisperModel(
                    "tiny.en",
                    device="cpu",
                    compute_type="int8",
                )
                logger.info("[voice_service] faster-whisper ready — tiny.en on CPU")
        except ImportError:
            logger.error("[voice_service] faster-whisper not installed — run: pip install faster-whisper")
            raise

    return _whisper_model


def transcribe_audio(audio_bytes: bytes, content_type: str = "audio/wav") -> str:
    """
    Transcribe raw audio bytes → English text via faster-whisper.
    Accepts WAV, WebM, OGG — whatever MediaRecorder sends.
    VAD filter strips silence to improve accuracy and speed.
    Raises RuntimeError on failure so the controller can return a proper HTTP error.
    """
    try:
        model = _get_whisper_model()
    except ImportError:
        raise RuntimeError(
            "faster-whisper is not installed. Run: pip install faster-whisper"
        )
    except Exception as exc:
        raise RuntimeError(f"STT model failed to load: {exc}") from exc

    audio_io = io.BytesIO(audio_bytes)

    try:
        segments, info = model.transcribe(
            audio_io,
            language="en",
            beam_size=5,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 400},
        )
        text = " ".join(seg.text.strip() for seg in segments).strip()
        logger.debug("[voice_service] Transcribed (%.2fs audio): %.80s", info.duration, text)
        return text
    except RuntimeError:
        raise
    except Exception as exc:
        logger.error("[voice_service] transcribe_audio decode/transcribe error: %s", exc)
        raise RuntimeError(
            f"Transcription failed — ensure ffmpeg is installed and accessible in PATH. Detail: {exc}"
        ) from exc


# ─────────────────────────────────────────────────────────────────────────────
# TTS — piper-tts (CPU, Phase 1)
# Phase 2+: swap _synthesize_sync to call MOSS-TTS-Realtime llama.cpp server.
# Same interface — no frontend changes needed at upgrade.
# ─────────────────────────────────────────────────────────────────────────────

def _get_piper_voice(model_path: Optional[str] = None):
    """
    Lazy-load a piper voice model.
    Looks for any .onnx file in ~/.aura/models/voice/piper/.
    Download voices from: https://huggingface.co/rhasspy/piper-voices
    Recommended: en_US-lessac-medium.onnx (~60MB, natural female voice)
    """
    global _piper_voice
    if _piper_voice is not None:
        return _piper_voice

    with _piper_lock:
        if _piper_voice is not None:
            return _piper_voice
        try:
            from piper.voice import PiperVoice

            resolved = model_path or _find_piper_model()
            if not resolved:
                logger.warning(
                    "[voice_service] No piper voice model found at %s — "
                    "download en_US-lessac-medium.onnx from huggingface.co/rhasspy/piper-voices",
                    PIPER_MODEL_DIR,
                )
                return None

            logger.info("[voice_service] Loading piper voice: %s", resolved)
            _piper_voice = PiperVoice.load(resolved)
            logger.info("[voice_service] piper-tts ready")

        except ImportError:
            logger.error("[voice_service] piper-tts not installed — run: pip install piper-tts")
            raise

    return _piper_voice


def _find_piper_model() -> Optional[str]:
    """Return the first .onnx piper model found in PIPER_MODEL_DIR."""
    if PIPER_MODEL_DIR.exists():
        models = list(PIPER_MODEL_DIR.glob("*.onnx"))
        if models:
            return str(models[0])
    return None


async def synthesize_text_async(text: str, speed: float = 1.0) -> bytes:
    """
    Convert text → WAV bytes. Routes to Chatterbox (voice clone) or piper-tts
    based on the saved voice profile's tts_engine field.
    speed: 0.5 (slow) – 2.0 (fast). Default 1.0.
    Returns raw WAV bytes ready to stream to the frontend.
    """
    engine = _get_profile_tts_engine()
    loop   = asyncio.get_running_loop()
    if engine == "chatterbox":
        return await loop.run_in_executor(None, _synthesize_chatterbox_sync, text)
    return await loop.run_in_executor(None, _synthesize_sync, text, speed)


def _get_profile_tts_engine() -> str:
    """Read tts_engine from saved voice profile. Defaults to 'piper'."""
    if VOICE_PROFILE_PATH.exists():
        try:
            profile = json.loads(VOICE_PROFILE_PATH.read_text(encoding="utf-8"))
            return profile.get("tts_engine", "piper")
        except Exception:
            pass
    return "piper"


# ─────────────────────────────────────────────────────────────────────────────
# TTS — Chatterbox (voice clone, Phase 2)
# Resemble AI open-source model (2025). Loads from HuggingFace on first use (~1.5GB).
# Uses reference audio samples from SAMPLES_DIR for zero-shot voice cloning.
# ─────────────────────────────────────────────────────────────────────────────

def _get_chatterbox_model():
    """
    Lazy-load Chatterbox TTS on CPU.
    Model downloads automatically from HuggingFace on first call (~1.5GB).
    Thread-safe — loaded once and reused.
    """
    global _chatterbox_model
    if _chatterbox_model is not None:
        return _chatterbox_model

    with _chatterbox_lock:
        if _chatterbox_model is not None:
            return _chatterbox_model
        try:
            from chatterbox.tts import ChatterboxTTS
            # GPU-first: try CUDA (covers NVIDIA and ROCm), fall back to CPU
            try:
                import torch
                _cb_device = "cuda" if torch.cuda.is_available() else "cpu"
            except Exception:
                _cb_device = "cpu"
            logger.info(
                "[voice_service] Loading Chatterbox TTS (%s) — first load downloads ~1.5GB...",
                _cb_device.upper(),
            )
            _chatterbox_model = ChatterboxTTS.from_pretrained(device=_cb_device)
            logger.info("[voice_service] Chatterbox TTS ready")
        except ImportError:
            logger.error("[voice_service] chatterbox-tts not installed — run: pip install chatterbox-tts")
            raise

    return _chatterbox_model


def _get_chatterbox_prompt() -> Optional[str]:
    """
    Return path to the first available voice reference sample, or None.
    Chatterbox uses this for zero-shot voice cloning.
    """
    if SAMPLES_DIR.exists():
        for f in sorted(SAMPLES_DIR.iterdir()):
            if f.is_file() and f.suffix.lower() in {".wav", ".mp3", ".flac", ".ogg"}:
                return str(f)
    return None


def _synthesize_chatterbox_sync(text: str) -> bytes:
    """
    Blocking Chatterbox TTS synthesis — called from run_in_executor.
    Uses first available reference sample for voice cloning.
    Returns WAV bytes.
    """
    model = _get_chatterbox_model()
    audio_prompt = _get_chatterbox_prompt()

    try:
        import io
        import torchaudio

        wav = model.generate(
            text,
            audio_prompt_path=audio_prompt,   # None = use default voice
            exaggeration=0.4,                  # Natural expressiveness (0=flat, 1=theatrical)
            cfg_weight=0.5,                    # Prompt adherence
        )

        buf = io.BytesIO()
        torchaudio.save(buf, wav, model.sr, format="wav")
        return buf.getvalue()
    except Exception as exc:
        logger.error("[voice_service] _synthesize_chatterbox_sync error: %s", exc)
        # Fall back to piper on error
        logger.info("[voice_service] Falling back to piper-tts")
        return _synthesize_sync(text, speed=1.0)


def _synthesize_sync(text: str, speed: float = 1.0) -> bytes:
    """Blocking piper synthesis — called from run_in_executor."""
    voice = _get_piper_voice()
    if voice is None:
        return b""

    buf = io.BytesIO()
    try:
        from piper.config import SynthesisConfig

        # length_scale > 1 = slower, < 1 = faster
        length_scale = 1.0 / max(speed, 0.1)
        syn_config = SynthesisConfig(length_scale=length_scale)

        sample_rate = getattr(voice.config, "sample_rate", 22050)

        with wave.open(buf, "wb") as wav_out:
            wav_out.setnchannels(1)
            wav_out.setsampwidth(2)  # int16
            wav_out.setframerate(sample_rate)
            for chunk in voice.synthesize(text, syn_config=syn_config):
                wav_out.writeframes(chunk.audio_int16_bytes)
        return buf.getvalue()
    except Exception as exc:
        logger.error("[voice_service] _synthesize_sync error: %s", exc)
        return b""


# ─────────────────────────────────────────────────────────────────────────────
# VOICE PROFILE
# ─────────────────────────────────────────────────────────────────────────────

def get_voice_profile_status() -> dict:
    """Return profile metadata if one exists, otherwise has_profile=False."""
    if VOICE_PROFILE_PATH.exists():
        try:
            profile = json.loads(VOICE_PROFILE_PATH.read_text(encoding="utf-8"))
            samples = _count_voice_samples()
            return {
                "has_profile":   True,
                "name":          profile.get("name", ""),
                "created_at":    profile.get("created_at", "unknown"),
                "description":   profile.get("description", ""),
                "tts_engine":    profile.get("tts_engine", "piper"),
                "sample_count":  samples,
            }
        except Exception:
            pass

    return {"has_profile": False, "sample_count": _count_voice_samples()}


def save_voice_profile(description: str, tts_engine: str = "piper", name: str = "") -> dict:
    """
    Persist a voice description profile with optional name.
    Phase 1: stores text description (feeds MOSS-VoiceGenerator in Phase 2).
    Phase 2: feeds MOSS-VoiceGenerator to generate acoustic embedding.
    """
    import datetime
    VOICE_DIR.mkdir(parents=True, exist_ok=True)

    profile = {
        "name":        name,
        "description": description,
        "tts_engine":  tts_engine,
        "created_at":  datetime.datetime.utcnow().isoformat() + "Z",
        "version":     "1.0",
    }
    VOICE_PROFILE_PATH.write_text(
        json.dumps(profile, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    logger.info("[voice_service] Voice profile saved: name=%s desc=%.60s", name, description)
    return {"status": "saved", "profile": profile}


def _count_voice_samples() -> int:
    """Count uploaded reference audio files in SAMPLES_DIR."""
    if not SAMPLES_DIR.exists():
        return 0
    return sum(1 for f in SAMPLES_DIR.iterdir()
               if f.is_file() and f.suffix.lower() in {".wav", ".mp3", ".flac", ".ogg"})


def list_voice_samples() -> list:
    """Return metadata for all uploaded voice samples."""
    if not SAMPLES_DIR.exists():
        return []
    samples = []
    for f in sorted(SAMPLES_DIR.iterdir()):
        if f.is_file() and f.suffix.lower() in {".wav", ".mp3", ".flac", ".ogg"}:
            stat = f.stat()
            samples.append({
                "filename":   f.name,
                "size_bytes": stat.st_size,
                "duration_s": None,  # populated by Phase 2 when model can decode
            })
    return samples


# ─────────────────────────────────────────────────────────────────────────────
# AUTO SETUP — first-launch voice model download
# ─────────────────────────────────────────────────────────────────────────────

# Default piper voice — en_US-lessac-medium (~60MB, natural female, Apache 2.0)
_PIPER_BASE_URL = (
    "https://huggingface.co/rhasspy/piper-voices/resolve/main"
    "/en/en_US/lessac/medium"
)
_PIPER_DEFAULT_MODEL = "en_US-lessac-medium.onnx"
_PIPER_DEFAULT_CONFIG = "en_US-lessac-medium.onnx.json"


async def auto_setup_voice(emit_fn=None) -> None:
    """
    Called once from main.py lifespan as a background asyncio task.
    Downloads the default piper voice model and openWakeWord base models
    if they are not already present. Safe to call on every launch —
    skips all steps if files already exist.

    emit_fn: optional async callable(event_type, data) — sends SSE events
             to the frontend during download. If None, logs only.
    """
    async def _emit(event: str, data: dict) -> None:
        if emit_fn:
            try:
                await emit_fn(event, data)
            except Exception:
                pass

    # ── 1. Piper voice model ─────────────────────────────────────────────────
    PIPER_MODEL_DIR.mkdir(parents=True, exist_ok=True)
    model_path  = PIPER_MODEL_DIR / _PIPER_DEFAULT_MODEL
    config_path = PIPER_MODEL_DIR / _PIPER_DEFAULT_CONFIG

    if model_path.exists() and config_path.exists():
        logger.info("[voice_setup] Piper model already present — skipping download")
    else:
        logger.info("[voice_setup] First launch — downloading default piper voice (~60MB)")
        await _emit("voice_setup_progress", {
            "step":    "piper_download",
            "status":  "started",
            "message": "Downloading Aura voice model (first launch, ~60MB)...",
        })
        try:
            await _download_file(
                f"{_PIPER_BASE_URL}/{_PIPER_DEFAULT_MODEL}",
                model_path,
                label="piper voice model",
                emit_fn=emit_fn,
            )
            await _download_file(
                f"{_PIPER_BASE_URL}/{_PIPER_DEFAULT_CONFIG}",
                config_path,
                label="piper voice config",
                emit_fn=None,  # small file — no progress needed
            )
            logger.info("[voice_setup] Piper voice model ready: %s", model_path)
            await _emit("voice_setup_progress", {
                "step":    "piper_download",
                "status":  "complete",
                "message": "Voice model ready.",
            })
        except Exception as exc:
            logger.error("[voice_setup] Piper download failed: %s", exc)
            await _emit("voice_setup_progress", {
                "step":    "piper_download",
                "status":  "error",
                "message": f"Voice model download failed: {exc}",
            })
            return

    # ── 2. faster-whisper model cache ────────────────────────────────────────
    # faster-whisper caches the model in ~/.cache/huggingface/hub automatically.
    # Trigger the download now (background) so first transcribe is instant.
    try:
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, _ensure_whisper_cached)
    except Exception as exc:
        logger.warning("[voice_setup] Whisper pre-cache failed: %s", exc)

    # ── 3. openWakeWord base models ──────────────────────────────────────────
    # OWWModel() auto-downloads on first instantiation — we trigger it here
    # in the background so the listener starts ready.
    try:
        import openwakeword
        openwakeword.utils.download_models()
        logger.info("[voice_setup] openWakeWord base models ready")
    except ImportError:
        logger.debug("[voice_setup] openWakeWord not installed — skipping")
    except Exception as exc:
        logger.warning("[voice_setup] openWakeWord model download failed: %s", exc)

    await _emit("voice_setup_progress", {
        "step":    "complete",
        "status":  "complete",
        "message": "Voice system ready.",
    })
    logger.info("[voice_setup] Voice auto-setup complete")


def _ensure_whisper_cached() -> None:
    """
    Pre-warm the faster-whisper model. Triggers HuggingFace download if needed.
    Mirrors _get_whisper_model(): tries base.en on GPU first, tiny.en CPU fallback.
    """
    try:
        from faster_whisper import WhisperModel
        try:
            WhisperModel("base.en", device="cuda", compute_type="float16")
            logger.info("[voice_setup] faster-whisper base.en (GPU) cached")
        except Exception:
            WhisperModel("tiny.en", device="cpu", compute_type="int8")
            logger.info("[voice_setup] faster-whisper tiny.en (CPU) cached")
    except ImportError:
        logger.debug("[voice_setup] faster-whisper not installed — skipping cache")
    except Exception as exc:
        logger.warning("[voice_setup] Whisper cache error: %s", exc)


async def _download_file(
    url: str,
    dest: Path,
    label: str,
    emit_fn=None,
) -> None:
    """
    Stream-download a file with progress logging.
    Uses httpx (already in requirements). Writes to a .tmp file
    and renames on completion so partial downloads are never left behind.
    """
    import httpx

    tmp = dest.with_suffix(dest.suffix + ".tmp")
    downloaded = 0

    async with httpx.AsyncClient(follow_redirects=True, timeout=300) as client:
        async with client.stream("GET", url) as response:
            response.raise_for_status()
            total = int(response.headers.get("content-length", 0))

            with open(tmp, "wb") as f:
                async for chunk in response.aiter_bytes(chunk_size=65536):
                    f.write(chunk)
                    downloaded += len(chunk)
                    if total and emit_fn:
                        pct = int(downloaded / total * 100)
                        if pct % 10 == 0:   # emit every 10%
                            try:
                                await emit_fn("voice_setup_progress", {
                                    "step":    "piper_download",
                                    "status":  "downloading",
                                    "pct":     pct,
                                    "message": f"Downloading {label}... {pct}%",
                                })
                            except Exception:
                                pass

    tmp.rename(dest)
    logger.info("[voice_setup] Downloaded %s → %s (%d bytes)", label, dest.name, downloaded)


# ─────────────────────────────────────────────────────────────────────────────
# MODEL MANAGEMENT
# ─────────────────────────────────────────────────────────────────────────────

# Available voice models — id → metadata.
# "installed" is determined at runtime by checking the filesystem.
_AVAILABLE_MODELS = {
    "stt:faster-whisper:tiny.en": {
        "type":        "stt",
        "engine":      "faster-whisper",
        "variant":     "tiny.en",
        "size_mb":     39,
        "description": "English-only STT, 39MB, ~300ms latency on CPU",
        "auto_cached": True,  # cached by HuggingFace Hub, not a local file we manage
    },
    "tts:piper:en_US-lessac-medium": {
        "type":        "tts",
        "engine":      "piper",
        "variant":     "en_US-lessac-medium",
        "size_mb":     60,
        "description": "Natural female US English voice, 60MB, ~80ms latency on CPU",
        "auto_cached": False,
        "files":       [_PIPER_DEFAULT_MODEL, _PIPER_DEFAULT_CONFIG],
    },
}


def list_voice_models() -> list:
    """
    Return all known voice models with their installed/loaded status.
    Used by GET /voice/models.
    """
    result = []
    for model_id, meta in _AVAILABLE_MODELS.items():
        installed = _is_model_installed(model_id, meta)
        loaded = False
        if model_id.startswith("stt:") and _whisper_model is not None:
            loaded = True
        elif model_id.startswith("tts:") and _piper_voice is not None:
            loaded = True

        result.append({
            "id":          model_id,
            "type":        meta["type"],
            "engine":      meta["engine"],
            "variant":     meta["variant"],
            "size_mb":     meta["size_mb"],
            "description": meta["description"],
            "installed":   installed,
            "loaded":      loaded,
        })
    return result


def _is_model_installed(model_id: str, meta: dict) -> bool:
    """Check if a model's files are present on disk."""
    if meta.get("auto_cached"):
        # faster-whisper caches in ~/.cache/huggingface/hub — check lazily
        try:
            from huggingface_hub import try_to_load_from_cache
            result = try_to_load_from_cache("Systran/faster-whisper-tiny.en", "model.bin")
            return result is not None
        except Exception:
            return False
    if "files" in meta:
        return all((PIPER_MODEL_DIR / f).exists() for f in meta["files"])
    return False


async def download_voice_model(model_id: str, emit_fn=None) -> dict:
    """
    Download a specific voice model by its ID.
    Returns {"status": "ok"|"error", "message": "..."}.
    """
    meta = _AVAILABLE_MODELS.get(model_id)
    if meta is None:
        return {"status": "error", "message": f"Unknown model: {model_id}"}

    if _is_model_installed(model_id, meta):
        return {"status": "ok", "message": f"{model_id} is already installed"}

    if meta.get("auto_cached"):
        # Trigger HuggingFace cache download
        try:
            loop = asyncio.get_running_loop()
            await loop.run_in_executor(None, _ensure_whisper_cached)
            return {"status": "ok", "message": "faster-whisper tiny.en cached"}
        except Exception as exc:
            return {"status": "error", "message": str(exc)}

    if meta["engine"] == "piper":
        PIPER_MODEL_DIR.mkdir(parents=True, exist_ok=True)
        try:
            for fname in meta.get("files", []):
                dest = PIPER_MODEL_DIR / fname
                if not dest.exists():
                    await _download_file(
                        f"{_PIPER_BASE_URL}/{fname}",
                        dest,
                        label=fname,
                        emit_fn=emit_fn,
                    )
            return {"status": "ok", "message": f"{model_id} downloaded"}
        except Exception as exc:
            return {"status": "error", "message": str(exc)}

    return {"status": "error", "message": f"Download not supported for {model_id}"}


# ─────────────────────────────────────────────────────────────────────────────
# CLEANUP — release resources on shutdown
# ─────────────────────────────────────────────────────────────────────────────

def cleanup_voice_resources() -> None:
    """
    Release loaded models and free memory.
    Called from main.py lifespan shutdown.
    """
    global _whisper_model, _piper_voice, _chatterbox_model
    if _whisper_model is not None:
        logger.info("[voice_service] Releasing faster-whisper model")
        _whisper_model = None
    if _piper_voice is not None:
        logger.info("[voice_service] Releasing piper voice")
        _piper_voice = None
    if _chatterbox_model is not None:
        logger.info("[voice_service] Releasing Chatterbox model")
        _chatterbox_model = None
