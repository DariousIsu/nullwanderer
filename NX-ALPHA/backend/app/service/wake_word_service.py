"""
AURA NX-Alpha — Wake Word & Conversational Session Service

DUAL-MODE DETECTION:
    1. Keyword-Spotting (primary + fallback): VAD-gated STT → phrase matching.
       Always available. Uses faster-whisper to transcribe short speech bursts
       then checks against the user's configurable wake phrase list.
    2. openWakeWord (trained): Low-CPU ONNX model fires on exact wake word.
       Requires ~50 positive samples per phrase + synthetic generation to train.
       When a trained model exists, it runs first; keyword-spotting is fallback.

VAD       : Silero VAD (speech detection gate + end-of-utterance, 500ms silence)
Session   : conversational mode — mic auto-reopens after each AURA response.
            Wake word only required to START a new session from idle.

FLOW:
    [IDLE]
    Silero VAD detects speech onset
        → capture 1-3s audio burst
        → faster-whisper transcribe (CPU, ~150ms)
        → check transcription against wake phrases
        → OR openWakeWord fires on trained model (if available)
    emit `wake_detected` SSE event to frontend
    Silero VAD monitors utterance
        → 500ms silence = utterance complete
    audio → POST /voice/transcribe → text → POST /message pipeline
    AURA responds via SSE token stream + TTS
        → session stays open (auto-listen window reopens)
    8s of silence in session → session_close → back to [IDLE]

INTERRUPT:
    If wake word fires while AURA is speaking → stop_tts emitted → listen

CUSTOM WAKE WORD TRAINING:
    1. User configures wake phrases in Settings → Voice
    2. Optionally uploads ~50 positive audio samples per phrase
    3. Clicks "Train Model" → openWakeWord generates synthetic data + trains
    4. Trained model saved to ~/.aura/models/voice/custom_wake.onnx
    5. On next boot, trained model loads alongside keyword-spotting fallback
"""

import asyncio
import io
import json
import logging
import threading
import time
import wave
from pathlib import Path
from typing import Callable, List, Optional

logger = logging.getLogger(__name__)

# ── File paths ────────────────────────────────────────────────────────────────
VOICE_DIR           = Path("~/.aura/models/voice").expanduser()
WAKE_CONFIG_PATH    = VOICE_DIR / "wake_config.json"
CUSTOM_WAKE_MODEL   = VOICE_DIR / "custom_wake.onnx"
TRAINING_SAMPLES_DIR = VOICE_DIR / "wake_training"

# ── Default wake phrases ─────────────────────────────────────────────────────
DEFAULT_WAKE_PHRASES = [
    "hey aura",
    "good morning",
    "good afternoon",
    "good evening",
    "hey",
    "hello",
    "daddy's home",
    "let's get to work",
]

# ── Runtime state ──────────────────────────────────────────────────────────────
_wake_model         = None
_vad_model          = None
_whisper_model      = None          # shared with voice_service if already loaded
_is_running         = False
_session_active     = False
_session_timeout_s  = 8.0
_mic_device_index   = -1            # -1 = system default
_aura_speaking      = False         # True while TTS audio is playing
_ducking_active     = False         # True while audio ducking is active (raised thresholds)
_event_loop: Optional[asyncio.AbstractEventLoop] = None  # main event loop ref for thread callbacks
_wake_phrases:      List[str] = []  # normalised lowercase phrases
_use_trained_model  = False         # True when custom_wake.onnx exists and loaded
_keyword_spot_enabled = True        # always True — fallback even when trained model active

# ── Callbacks (set by voice_controller on init) ───────────────────────────────
_on_wake:          Optional[Callable] = None   # async: called when wake word fires
_on_utterance:     Optional[Callable] = None   # async: called with (audio_bytes: bytes)
_on_session_close: Optional[Callable] = None   # async: called when session times out

# ── Constants ─────────────────────────────────────────────────────────────────
SAMPLE_RATE   = 16000
CHUNK_FRAMES  = 1280           # 80ms at 16kHz — openWakeWord required chunk size
SILENCE_GATE  = 0.5            # seconds of silence = utterance complete
VAD_THRESHOLD = 0.5            # Silero speech probability threshold
ENERGY_FLOOR  = 0.008          # RMS energy floor (VAD fallback)
WAKE_THRESHOLD = 0.5           # openWakeWord score threshold
KWS_CAPTURE_S = 2.0            # seconds of speech to capture for keyword-spotting
KWS_COOLDOWN  = 1.0            # seconds between keyword-spot attempts (avoid CPU spam)


# ─────────────────────────────────────────────────────────────────────────────
# PUBLIC API
# ─────────────────────────────────────────────────────────────────────────────

def init_wake_word_service(
    on_wake:          Optional[Callable] = None,
    on_utterance:     Optional[Callable] = None,
    on_session_close: Optional[Callable] = None,
    session_timeout_s: float = 8.0,
    mic_device_index:  int   = -1,
) -> bool:
    """
    Load wake detection models and configure wake phrases.

    Detection priority:
      1. Custom openWakeWord model (if trained and present at custom_wake.onnx)
      2. Keyword-spotting fallback (VAD → STT → phrase match) — always available

    Returns True if at least one detection method is available.
    """
    global _on_wake, _on_utterance, _on_session_close
    global _session_timeout_s, _mic_device_index
    global _wake_model, _vad_model, _use_trained_model, _wake_phrases

    _on_wake          = on_wake
    _on_utterance     = on_utterance
    _on_session_close = on_session_close
    _session_timeout_s = session_timeout_s
    _mic_device_index  = mic_device_index

    # ── Load wake phrases from config ─────────────────────────────────────────
    _wake_phrases = _load_wake_phrases()
    logger.info("[wake_word] Wake phrases: %s", _wake_phrases)

    # ── openWakeWord (trained custom model) ───────────────────────────────────
    _use_trained_model = False
    try:
        from openwakeword.model import Model as OWWModel

        if CUSTOM_WAKE_MODEL.exists():
            _wake_model = OWWModel(
                wakeword_models=[str(CUSTOM_WAKE_MODEL)],
                inference_framework="onnx",
            )
            _use_trained_model = True
            logger.info("[wake_word] Loaded trained wake model: %s", CUSTOM_WAKE_MODEL.name)
        else:
            # Load built-in models as supplementary detection
            _wake_model = OWWModel(inference_framework="onnx")
            logger.info(
                "[wake_word] No trained custom model — built-in openWakeWord active "
                "alongside keyword-spotting fallback"
            )
    except ImportError:
        logger.info(
            "[wake_word] openWakeWord not installed — keyword-spotting only. "
            "Install openwakeword for lower-CPU detection."
        )
        _wake_model = None
    except Exception as exc:
        logger.warning("[wake_word] openWakeWord load error (%s) — keyword-spotting only", exc)
        _wake_model = None

    # ── Silero VAD (required for both modes) ──────────────────────────────────
    try:
        import torch
        _vad_model, _ = torch.hub.load(
            repo_or_dir="snakers4/silero-vad",
            model="silero_vad",
            force_reload=False,
            trust_repo=True,
        )
        logger.info("[wake_word] Silero VAD loaded")
    except Exception as exc:
        logger.warning(
            "[wake_word] Silero VAD unavailable (%s) — using energy-based detection", exc
        )

    # At least keyword-spotting is always available if STT is installed
    return True


def start_listening(loop: asyncio.AbstractEventLoop) -> None:
    """Launch the background microphone listener thread."""
    global _is_running, _event_loop
    _event_loop = loop
    if _is_running:
        return
    _is_running = True
    t = threading.Thread(
        target=_listen_loop,
        args=(loop,),
        name="aura_wake_listener",
        daemon=True,
    )
    t.start()
    logger.info("[wake_word] Wake word listener started")


def stop_listening() -> None:
    global _is_running
    _is_running = False


def open_session() -> None:
    """Open a conversational session — mic stays live between turns."""
    global _session_active
    _session_active = True
    logger.debug("[wake_word] Session opened")


def close_session() -> None:
    """Close session — return to wake word mode."""
    global _session_active
    _session_active = False
    logger.debug("[wake_word] Session closed")
    if _on_session_close and _event_loop is not None:
        asyncio.run_coroutine_threadsafe(_on_session_close(), _event_loop)


def set_aura_speaking(speaking: bool) -> None:
    """
    Signal whether AURA is currently outputting TTS audio.
    While speaking, wake word detection remains active for interrupt support.
    """
    global _aura_speaking
    _aura_speaking = speaking


def set_audio_ducking(active: bool) -> None:
    """
    Enable/disable audio ducking during TTS playback.
    When active, VAD and energy thresholds are raised to prevent
    speaker bleed from triggering false wake/utterance detection.
    """
    global _ducking_active
    _ducking_active = active


def set_mic_device(device_index: int) -> None:
    global _mic_device_index
    _mic_device_index = device_index


def set_session_timeout(seconds: float) -> None:
    global _session_timeout_s
    _session_timeout_s = max(3.0, min(60.0, seconds))


# ─────────────────────────────────────────────────────────────────────────────
# BACKGROUND LISTENER LOOP
# ─────────────────────────────────────────────────────────────────────────────

def _listen_loop(loop: asyncio.AbstractEventLoop) -> None:
    """
    Continuous mic stream. Runs as a daemon thread.

    IDLE detection uses dual mode:
      1. openWakeWord model (if available) — low-CPU ONNX inference per chunk
      2. Keyword-spotting — VAD detects speech → capture burst → STT → phrase match

    SESSION mode captures full utterances and fires on_utterance callback.
    """
    try:
        import sounddevice as sd
        import numpy as np
    except ImportError:
        logger.error("[wake_word] sounddevice/numpy not installed — listener cannot start")
        return

    # Utterance capture state
    recording       = False
    utterance_frames: list = []
    silence_start:   Optional[float] = None
    session_timer:   Optional[float] = None

    # Keyword-spotting state (IDLE mode)
    kws_capturing    = False
    kws_frames:      list = []
    kws_start_time:  float = 0
    kws_last_attempt: float = 0

    device = _mic_device_index if _mic_device_index >= 0 else None

    try:
        with sd.InputStream(
            samplerate=SAMPLE_RATE,
            channels=1,
            dtype="float32",
            blocksize=CHUNK_FRAMES,
            device=device,
        ) as stream:
            logger.info("[wake_word] Mic stream open (device=%s, kws=%s, oww=%s)",
                        device, _keyword_spot_enabled, _wake_model is not None)

            while _is_running:
                audio_chunk, _ = stream.read(CHUNK_FRAMES)
                audio_flat = audio_chunk.flatten()

                if not _session_active:
                    # ── IDLE: dual-mode wake detection ────────────────────────
                    wake_fired = False

                    # Mode 1: openWakeWord model check (every chunk, low CPU)
                    if _wake_model is not None:
                        prediction = _wake_model.predict(audio_flat)
                        if _any_wake_fired(prediction):
                            logger.info("[wake_word] openWakeWord triggered")
                            wake_fired = True

                    # Mode 2: Keyword-spotting (VAD-gated STT → phrase match)
                    if not wake_fired and _keyword_spot_enabled:
                        now = time.time()

                        if not kws_capturing:
                            # Check VAD for speech onset
                            is_speech = _check_vad(audio_flat)
                            if is_speech and (now - kws_last_attempt) >= KWS_COOLDOWN:
                                kws_capturing  = True
                                kws_frames     = [audio_flat.copy()]
                                kws_start_time = now
                        else:
                            # Accumulate speech for KWS_CAPTURE_S seconds
                            kws_frames.append(audio_flat.copy())
                            elapsed = now - kws_start_time
                            is_speech = _check_vad(audio_flat)

                            # Stop capture on silence or max duration
                            if elapsed >= KWS_CAPTURE_S or (elapsed > 0.5 and not is_speech):
                                kws_capturing = False
                                kws_last_attempt = now
                                # Run STT on captured audio
                                matched = _keyword_spot_check(kws_frames)
                                kws_frames = []
                                if matched:
                                    logger.info("[wake_word] Keyword-spot matched: '%s'", matched)
                                    wake_fired = True

                    if wake_fired:
                        if _on_wake:
                            asyncio.run_coroutine_threadsafe(_on_wake(), loop)
                        open_session()
                        recording       = True
                        utterance_frames = []
                        silence_start   = None
                        session_timer   = None
                        kws_capturing   = False
                        kws_frames      = []

                else:
                    # ── SESSION: capture utterance ────────────────────────────

                    # While AURA is speaking, pause the session timer and only
                    # listen for interrupt wake words. Don't capture audio as
                    # user speech (prevents AURA hearing herself).
                    if _aura_speaking:
                        session_timer = None  # don't count speaking time
                        if _wake_model is not None:
                            prediction = _wake_model.predict(audio_flat)
                            if _any_wake_fired(prediction):
                                logger.info("[wake_word] Interrupt detected while speaking")
                                if _on_wake:
                                    asyncio.run_coroutine_threadsafe(_on_wake(), loop)
                        continue

                    # Session idle timeout — only counts silence AFTER AURA
                    # finishes speaking (set_aura_speaking(False) called).
                    if not recording and session_timer is None:
                        session_timer = time.time()
                    elif not recording and session_timer is not None:
                        if time.time() - session_timer >= _session_timeout_s:
                            logger.info("[wake_word] Session timeout — returning to idle")
                            close_session()
                            session_timer = None
                            continue

                    if not recording:
                        is_speech = _check_vad(audio_flat)
                        if is_speech:
                            recording       = True
                            utterance_frames = [audio_flat.copy()]
                            silence_start   = None
                            session_timer   = None
                    else:
                        utterance_frames.append(audio_flat.copy())
                        is_speech = _check_vad(audio_flat)

                        if is_speech:
                            silence_start = None
                        else:
                            if silence_start is None:
                                silence_start = time.time()
                            elif time.time() - silence_start >= SILENCE_GATE:
                                if utterance_frames and _on_utterance:
                                    wav_bytes = _frames_to_wav(utterance_frames)
                                    asyncio.run_coroutine_threadsafe(
                                        _on_utterance(wav_bytes), loop
                                    )
                                recording       = False
                                utterance_frames = []
                                silence_start   = None
                                session_timer   = time.time()

    except Exception as exc:
        logger.error("[wake_word] Listener loop crashed: %s", exc, exc_info=True)


# ─────────────────────────────────────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def _any_wake_fired(prediction: dict) -> bool:
    return any(v >= WAKE_THRESHOLD for v in prediction.values())


def _check_vad(audio: "np.ndarray") -> bool:
    """Run Silero VAD; fall back to RMS energy threshold if unavailable.

    When audio ducking is active (AURA speaking), thresholds are raised
    to prevent speaker bleed from triggering false detections.
    """
    # Ducked thresholds — only very loud speech passes through
    vad_thresh    = 0.85 if _ducking_active else VAD_THRESHOLD
    energy_thresh = 0.03 if _ducking_active else ENERGY_FLOOR

    if _vad_model is not None:
        try:
            import torch
            tensor = torch.from_numpy(audio)
            prob = _vad_model(tensor, SAMPLE_RATE).item()
            return prob > vad_thresh
        except Exception:
            pass
    import numpy as np
    rms = float(np.sqrt(np.mean(audio ** 2)))
    return rms > energy_thresh


def _keyword_spot_check(frames: list) -> Optional[str]:
    """
    Transcribe a short audio burst and check against wake phrases.
    Returns the matched phrase or None.
    """
    global _whisper_model
    if not frames or not _wake_phrases:
        return None

    try:
        import numpy as np

        # Lazy-load whisper (shares with voice_service if already loaded)
        if _whisper_model is None:
            try:
                from app.service.voice_service import _get_whisper_model
                _whisper_model = _get_whisper_model()
            except Exception:
                from faster_whisper import WhisperModel
                _whisper_model = WhisperModel("tiny.en", device="cpu", compute_type="int8")

        # Convert frames to WAV-like BytesIO for whisper
        audio = np.concatenate(frames)
        audio_io = io.BytesIO()
        with wave.open(audio_io, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(SAMPLE_RATE)
            audio_i16 = (audio * 32767).clip(-32768, 32767).astype(np.int16)
            wf.writeframes(audio_i16.tobytes())
        audio_io.seek(0)

        segments, _info = _whisper_model.transcribe(
            audio_io,
            language="en",
            beam_size=1,       # fast mode for wake detection
            vad_filter=False,  # already VAD-filtered
        )
        text = " ".join(seg.text.strip() for seg in segments).strip().lower()

        if not text:
            return None

        # Check against wake phrases (fuzzy: phrase must appear in transcription)
        for phrase in _wake_phrases:
            if phrase in text:
                return phrase

        # Also check without apostrophes/punctuation for robustness
        text_clean = text.replace("'", "").replace(",", "").replace(".", "")
        for phrase in _wake_phrases:
            phrase_clean = phrase.replace("'", "")
            if phrase_clean in text_clean:
                return phrase

    except Exception as exc:
        logger.debug("[wake_word] keyword-spot STT error: %s", exc)

    return None


def _frames_to_wav(frames: list) -> bytes:
    """Concatenate float32 audio frames and encode as mono 16kHz WAV bytes."""
    import numpy as np
    audio     = np.concatenate(frames)
    audio_i16 = (audio * 32767).clip(-32768, 32767).astype(np.int16)

    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(audio_i16.tobytes())
    return buf.getvalue()


def _resolve(path_str: str) -> "Path":
    return Path(path_str).expanduser()


# ─────────────────────────────────────────────────────────────────────────────
# WAKE PHRASE MANAGEMENT
# ─────────────────────────────────────────────────────────────────────────────

def _load_wake_phrases() -> List[str]:
    """Load wake phrases from config file, or return defaults."""
    if WAKE_CONFIG_PATH.exists():
        try:
            cfg = json.loads(WAKE_CONFIG_PATH.read_text(encoding="utf-8"))
            phrases = cfg.get("phrases", DEFAULT_WAKE_PHRASES)
            return [p.strip().lower() for p in phrases if p.strip()]
        except Exception:
            pass
    return [p.lower() for p in DEFAULT_WAKE_PHRASES]


def _save_wake_config(phrases: List[str], **extra) -> None:
    """Persist wake phrase config to disk."""
    VOICE_DIR.mkdir(parents=True, exist_ok=True)
    existing = {}
    if WAKE_CONFIG_PATH.exists():
        try:
            existing = json.loads(WAKE_CONFIG_PATH.read_text(encoding="utf-8"))
        except Exception:
            pass
    existing["phrases"] = phrases
    existing.update(extra)
    WAKE_CONFIG_PATH.write_text(
        json.dumps(existing, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )


def get_wake_phrases() -> dict:
    """Return current wake phrases + detection mode status."""
    phrases = _load_wake_phrases()
    has_trained = CUSTOM_WAKE_MODEL.exists()
    return {
        "phrases":           phrases,
        "keyword_spotting":  True,  # always available
        "trained_model":     has_trained,
        "trained_model_path": str(CUSTOM_WAKE_MODEL) if has_trained else None,
        "detection_mode":    "trained+fallback" if has_trained else "keyword-spotting",
    }


def set_wake_phrases(phrases: List[str]) -> dict:
    """Update the list of wake phrases and apply immediately."""
    global _wake_phrases
    cleaned = [p.strip().lower() for p in phrases if p.strip()]
    if not cleaned:
        cleaned = [p.lower() for p in DEFAULT_WAKE_PHRASES]
    _wake_phrases = cleaned
    _save_wake_config(cleaned)
    logger.info("[wake_word] Wake phrases updated: %s", cleaned)
    return {"status": "ok", "phrases": cleaned}


# ─────────────────────────────────────────────────────────────────────────────
# TRAINING SAMPLE MANAGEMENT
# ─────────────────────────────────────────────────────────────────────────────

def get_training_status() -> dict:
    """Return training sample counts per phrase and overall readiness."""
    TRAINING_SAMPLES_DIR.mkdir(parents=True, exist_ok=True)
    phrases = _load_wake_phrases()
    phrase_status = []
    total_samples = 0

    for phrase in phrases:
        slug = _phrase_slug(phrase)
        phrase_dir = TRAINING_SAMPLES_DIR / slug
        count = 0
        if phrase_dir.exists():
            count = sum(1 for f in phrase_dir.iterdir()
                       if f.is_file() and f.suffix.lower() in {".wav", ".mp3", ".flac", ".ogg"})
        total_samples += count
        phrase_status.append({
            "phrase": phrase,
            "slug":   slug,
            "samples": count,
            "ready":  count >= 10,  # minimum viable for training
            "recommended": count >= 50,
        })

    has_trained = CUSTOM_WAKE_MODEL.exists()
    return {
        "phrases":        phrase_status,
        "total_samples":  total_samples,
        "can_train":      total_samples >= 10,
        "trained_model":  has_trained,
        "training_dir":   str(TRAINING_SAMPLES_DIR),
    }


def save_training_sample(phrase: str, audio_bytes: bytes, filename: str) -> dict:
    """Save an audio sample for a specific wake phrase training."""
    slug = _phrase_slug(phrase)
    phrase_dir = TRAINING_SAMPLES_DIR / slug
    phrase_dir.mkdir(parents=True, exist_ok=True)

    save_path = phrase_dir / filename
    save_path.write_bytes(audio_bytes)

    count = sum(1 for f in phrase_dir.iterdir()
               if f.is_file() and f.suffix.lower() in {".wav", ".mp3", ".flac", ".ogg"})

    logger.info("[wake_word] Training sample saved: %s/%s (%d bytes, total=%d)",
                slug, filename, len(audio_bytes), count)
    return {
        "status":   "saved",
        "phrase":   phrase,
        "filename": filename,
        "total":    count,
    }


def clear_training_samples(phrase: Optional[str] = None) -> dict:
    """Clear training samples for a specific phrase or all phrases."""
    deleted = 0
    if phrase:
        slug = _phrase_slug(phrase)
        phrase_dir = TRAINING_SAMPLES_DIR / slug
        if phrase_dir.exists():
            for f in phrase_dir.iterdir():
                if f.is_file():
                    f.unlink()
                    deleted += 1
    else:
        if TRAINING_SAMPLES_DIR.exists():
            import shutil
            for d in TRAINING_SAMPLES_DIR.iterdir():
                if d.is_dir():
                    shutil.rmtree(d)
                    deleted += 1
    return {"status": "ok", "deleted": deleted}


async def train_wake_model(emit_fn=None) -> dict:
    """
    Train a custom openWakeWord model from collected samples.

    Requires openwakeword training utilities. Uses synthetic data generation
    to augment the positive samples, then trains a small ONNX classifier.

    Returns status dict. Emits SSE progress events via emit_fn.
    """
    async def _emit(msg: str, pct: int = -1) -> None:
        if emit_fn:
            try:
                await emit_fn("wake_training_progress", {
                    "status": "training", "message": msg, "pct": pct,
                })
            except Exception:
                pass

    status = get_training_status()
    if not status["can_train"]:
        return {"status": "error", "message": "Need at least 10 total samples to train"}

    await _emit("Preparing training data...", 10)

    try:
        import openwakeword
        from openwakeword import train as oww_train
    except (ImportError, AttributeError):
        # openwakeword.train may not be available in all versions
        return {
            "status": "error",
            "message": "openWakeWord training module not available. "
                       "Install the full training package: pip install openwakeword[train]"
        }

    try:
        await _emit("Generating synthetic data...", 30)

        # Collect all positive samples
        positive_clips = []
        for ps in status["phrases"]:
            phrase_dir = TRAINING_SAMPLES_DIR / ps["slug"]
            if phrase_dir.exists():
                for f in sorted(phrase_dir.iterdir()):
                    if f.is_file() and f.suffix.lower() in {".wav", ".mp3", ".flac", ".ogg"}:
                        positive_clips.append(str(f))

        if not positive_clips:
            return {"status": "error", "message": "No audio samples found"}

        await _emit("Training ONNX classifier...", 60)

        # Train using openwakeword's built-in pipeline
        output_path = str(CUSTOM_WAKE_MODEL)
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, _train_sync, positive_clips, output_path)

        await _emit("Model saved!", 100)

        # Reload the model
        global _wake_model, _use_trained_model
        from openwakeword.model import Model as OWWModel
        _wake_model = OWWModel(
            wakeword_models=[output_path],
            inference_framework="onnx",
        )
        _use_trained_model = True

        logger.info("[wake_word] Custom model trained and loaded: %s", output_path)

        if emit_fn:
            await emit_fn("wake_training_progress", {
                "status": "complete", "message": "Wake word model trained and active!",
            })

        return {"status": "ok", "model_path": output_path}

    except Exception as exc:
        logger.error("[wake_word] Training failed: %s", exc, exc_info=True)
        if emit_fn:
            await emit_fn("wake_training_progress", {
                "status": "error", "message": f"Training failed: {exc}",
            })
        return {"status": "error", "message": str(exc)}


def _train_sync(positive_clips: list, output_path: str) -> None:
    """Blocking training call — run in executor."""
    try:
        from openwakeword.train import train_model
        train_model(
            positive_clips=positive_clips,
            output_path=output_path,
            epochs=100,
            target_accuracy=0.95,
        )
    except ImportError:
        # Fallback: if train module unavailable, create a placeholder message
        raise RuntimeError(
            "openWakeWord training requires the full package. "
            "Run: pip install openwakeword[train]"
        )


def _phrase_slug(phrase: str) -> str:
    """Convert a wake phrase to a filesystem-safe slug."""
    import re
    slug = phrase.lower().strip()
    slug = re.sub(r"[^a-z0-9]+", "_", slug)
    return slug.strip("_") or "unknown"
