"""
AURA NX-Alpha — Voice Controller
All voice-related REST endpoints.

ROUTES:
    GET  /voice/devices          — list audio input/output devices
    GET  /voice/status           — STT/TTS/wake word availability + settings
    POST /voice/transcribe       — audio upload → transcribed text (faster-whisper)
    POST /voice/synthesize       — text → WAV bytes (piper-tts)
    GET  /voice/profile          — current voice profile status
    POST /voice/profile          — save voice description + tts_engine choice
    POST /voice/profile/sample   — upload reference audio sample
    DELETE /voice/profile/samples — clear all reference samples
    PUT  /voice/settings         — update device, speed, timeout, always_on, etc.

WAKE WORD / SESSION:
    Wake word fires via the background wake_word_service thread.
    The service calls _on_wake / _on_utterance / _on_session_close callbacks
    which emit SSE events to the frontend via chat_controller._emit.

SSE EVENTS EMITTED BY THIS CONTROLLER:
    wake_detected       — wake word fired, frontend enters listening state
    session_close       — session timed out, frontend returns to idle
    stop_tts            — interrupt detected while AURA speaking
    (audio_chunk / audio_end are emitted by synthesize_and_stream)
"""

import asyncio
import logging
from typing import Optional

from fastapi import APIRouter, File, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/voice", tags=["voice"])

# ── Runtime voice settings (persisted to ~/.aura/settings.json on change) ─────
_voice_settings: dict = {
    "enabled":          True,
    "always_on":        False,
    "input_device":     -1,    # -1 = system default
    "output_device":    -1,    # -1 = system default
    "speed":            1.0,
    "volume":           0.8,
    "voice":            "en_US-lessac-medium",
    "session_timeout_s": 8.0,
}


# ─────────────────────────────────────────────────────────────────────────────
# INTERNAL HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def _check_import(module_name: str) -> bool:
    try:
        __import__(module_name)
        return True
    except ImportError:
        return False


async def _emit_voice(event_type: str, data: dict) -> None:
    """Emit a voice SSE event through the shared chat_controller event queue."""
    from app.controller.chat_controller import _emit
    await _emit(event_type, data)


# ─────────────────────────────────────────────────────────────────────────────
# WAKE WORD CALLBACKS  (registered by init_voice_controller)
# ─────────────────────────────────────────────────────────────────────────────

async def _on_wake() -> None:
    """
    Fired by wake_word_service when wake word detected.
    Emits SSE `wake_detected` — frontend shows listening indicator.
    If AURA was speaking, also emits `stop_tts` for interrupt handling.
    """
    from app.service.wake_word_service import _aura_speaking
    if _aura_speaking:
        await _emit_voice("stop_tts", {"reason": "interrupt"})
    await _emit_voice("wake_detected", {"source": "wake_word"})


async def _on_utterance(audio_bytes: bytes) -> None:
    """
    Fired by wake_word_service when a complete utterance is captured.
    Transcribes → sends to message pipeline → session stays open.
    """
    if not audio_bytes:
        return

    try:
        loop = asyncio.get_running_loop()
        from app.service.voice_service import transcribe_audio
        text = await loop.run_in_executor(None, transcribe_audio, audio_bytes, "audio/wav")
    except Exception as exc:
        logger.error("[voice_controller] on_utterance transcribe error: %s", exc)
        return

    if not text.strip():
        logger.debug("[voice_controller] Empty transcription — skipping")
        return

    logger.info("[voice_controller] Wake utterance: %.80s", text)

    # Surface transcription to frontend (populates chat input visually)
    await _emit_voice("voice_transcribed", {"text": text})

    # Route through the normal message pipeline
    from app.controller.chat_controller import receive_message, MessageRequest
    from fastapi import BackgroundTasks
    bg = BackgroundTasks()
    await receive_message(MessageRequest(text=text, voice_enabled=True), bg)
    # Execute background tasks immediately (we're already async)
    for task in bg.tasks:
        try:
            if asyncio.iscoroutinefunction(task.func):
                await task.func(*task.args, **task.kwargs)
            else:
                await asyncio.get_running_loop().run_in_executor(
                    None, task.func, *task.args
                )
        except Exception as exc:
            logger.error("[voice_controller] pipeline task error: %s", exc)


async def _on_session_close() -> None:
    """Fired by wake_word_service when session idle timeout elapses."""
    await _emit_voice("session_close", {"reason": "timeout"})


# ─────────────────────────────────────────────────────────────────────────────
# INIT (called from main.py lifespan)
# ─────────────────────────────────────────────────────────────────────────────

def init_voice_controller(loop: asyncio.AbstractEventLoop) -> None:
    """
    Wire callbacks and start the wake word listener thread.
    Called from main.py lifespan after other services are up.
    """
    # Wake word disabled — continuous mic capture + Silero VAD + faster-whisper
    # adds ~200MB RAM + constant CPU load. Re-enable when hardware supports it.
    logger.info("[voice_controller] Wake word listener disabled (resource conservation)")


# ─────────────────────────────────────────────────────────────────────────────
# ROUTES — DEVICES
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/devices")
async def get_devices() -> dict:
    """List available audio input and output devices. Index -1 = system default."""
    from app.service.voice_service import list_audio_devices
    return list_audio_devices()


# ─────────────────────────────────────────────────────────────────────────────
# ROUTES — STATUS
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/status")
async def voice_status() -> dict:
    """Return voice service availability, installed packages, and current settings."""
    from app.service.voice_service import get_voice_profile_status, _get_profile_tts_engine
    active_engine = _get_profile_tts_engine()
    return {
        "stt_available":           _check_import("faster_whisper"),
        "tts_available":           _check_import("piper") or _check_import("chatterbox"),
        "tts_piper_available":     _check_import("piper"),
        "tts_chatterbox_available": _check_import("chatterbox"),
        "tts_active_engine":       active_engine,
        "wake_word_available":     _check_import("openwakeword"),
        "vad_available":           _check_import("torch"),
        "profile":                 get_voice_profile_status(),
        "settings":                _voice_settings,
    }


# ─────────────────────────────────────────────────────────────────────────────
# ROUTES — TRANSCRIBE (manual mic button path)
# ─────────────────────────────────────────────────────────────────────────────

@router.post("/transcribe")
async def transcribe(audio: UploadFile = File(...)) -> dict:
    """
    Receive audio blob from the frontend mic button → return transcribed text.
    MediaRecorder sends WebM by default; faster-whisper handles it via ffmpeg.
    The text is NOT automatically sent to the pipeline — frontend decides.
    """
    try:
        audio_bytes = await audio.read()
        loop = asyncio.get_running_loop()
        from app.service.voice_service import transcribe_audio
        text = await loop.run_in_executor(
            None,
            transcribe_audio,
            audio_bytes,
            audio.content_type or "audio/wav",
        )
        logger.debug("[voice_controller] Manual transcribe: %.80s", text)
        return {"text": text, "status": "ok"}
    except RuntimeError as exc:
        # Known failure (model not loaded, ffmpeg missing, etc.) — surface to frontend
        logger.error("[voice_controller] /voice/transcribe failed: %s", exc)
        from fastapi import HTTPException
        raise HTTPException(status_code=503, detail=str(exc))
    except Exception as exc:
        logger.error("[voice_controller] /voice/transcribe unexpected error: %s", exc)
        from fastapi import HTTPException
        raise HTTPException(status_code=500, detail=f"Transcription error: {exc}")


# ─────────────────────────────────────────────────────────────────────────────
# ROUTES — SYNTHESIZE (manual TTS path)
# ─────────────────────────────────────────────────────────────────────────────

class SynthesizeRequest(BaseModel):
    text:  str
    speed: float = 1.0


@router.post("/synthesize")
async def synthesize(body: SynthesizeRequest) -> Response:
    """
    Convert text → WAV bytes using piper-tts (CPU).
    Returns raw WAV binary. Frontend plays via Web Audio API.
    Speed: 0.5 (slow) – 2.0 (fast).
    """
    text  = body.text.strip()
    speed = max(0.5, min(2.0, body.speed))

    if not text:
        return Response(content=b"", media_type="audio/wav")

    try:
        from app.service.voice_service import synthesize_text_async
        wav_bytes = await synthesize_text_async(text, speed=speed)
        return Response(content=wav_bytes, media_type="audio/wav")
    except Exception as exc:
        logger.error("[voice_controller] /voice/synthesize error: %s", exc)
        return Response(content=b"", media_type="audio/wav", status_code=500)


# ─────────────────────────────────────────────────────────────────────────────
# ROUTES — VOICE PROFILE
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/profile")
async def get_profile() -> dict:
    """Return current voice profile status and sample count."""
    from app.service.voice_service import get_voice_profile_status, list_voice_samples
    return {
        **get_voice_profile_status(),
        "samples": list_voice_samples(),
    }


class VoiceProfileRequest(BaseModel):
    name:        str = ""
    description: str
    tts_engine:  str = "piper"


@router.post("/profile")
async def save_profile(body: VoiceProfileRequest) -> dict:
    """Save voice profile (name + description). Phase 2: feeds MOSS-VoiceGenerator."""
    if not body.description.strip():
        return {"status": "error", "message": "Description cannot be empty"}
    from app.service.voice_service import save_voice_profile
    return save_voice_profile(body.description, body.tts_engine, name=body.name.strip())


class VoiceProfileUpdateRequest(BaseModel):
    speed:  Optional[float] = None
    volume: Optional[float] = None
    voice:  Optional[str]   = None   # piper voice variant name


@router.put("/profile")
async def update_profile(body: VoiceProfileUpdateRequest) -> dict:
    """Update voice playback settings (rate, volume, voice selection)."""
    if body.speed is not None:
        _voice_settings["speed"] = max(0.5, min(2.0, body.speed))
    if body.volume is not None:
        _voice_settings["volume"] = max(0.0, min(1.0, body.volume))
    if body.voice is not None:
        _voice_settings["voice"] = body.voice
    _persist_voice_settings()
    logger.info("[voice_controller] Profile updated: %s", _voice_settings)
    return {"status": "ok", "settings": _voice_settings}


@router.post("/profile/sample")
async def upload_voice_sample(sample: UploadFile = File(...)) -> dict:
    """
    Upload a reference audio sample (WAV/MP3/FLAC, 3-30 seconds recommended).
    Stored at ~/.aura/models/voice/samples/.
    Phase 2: fed to MOSS-TTS-Realtime for zero-shot voice cloning.
    Multiple samples are averaged for a more accurate voice embedding.
    """
    from pathlib import Path
    SAMPLES_DIR = Path("~/.aura/models/voice/samples").expanduser()

    allowed = {".wav", ".mp3", ".flac", ".ogg", ".m4a"}
    suffix  = Path(sample.filename or "sample.wav").suffix.lower()
    if suffix not in allowed:
        return {"status": "error", "message": f"File type {suffix} not supported. Use WAV, MP3, FLAC, or OGG."}

    try:
        SAMPLES_DIR.mkdir(parents=True, exist_ok=True)
        content  = await sample.read()
        filename = sample.filename or f"sample_{int(asyncio.get_event_loop().time())}{suffix}"
        save_path = SAMPLES_DIR / filename
        save_path.write_bytes(content)

        sample_count = sum(1 for f in SAMPLES_DIR.iterdir()
                           if f.is_file() and f.suffix.lower() in allowed)

        logger.info("[voice_controller] Sample saved: %s (%d bytes)", filename, len(content))
        return {
            "status":        "saved",
            "filename":      filename,
            "size_bytes":    len(content),
            "total_samples": sample_count,
        }
    except Exception as exc:
        logger.error("[voice_controller] upload_voice_sample error: %s", exc)
        return {"status": "error", "message": str(exc)}


@router.delete("/profile/samples")
async def clear_voice_samples() -> dict:
    """Delete all uploaded voice reference samples."""
    from pathlib import Path
    SAMPLES_DIR = Path("~/.aura/models/voice/samples").expanduser()
    deleted = 0
    if SAMPLES_DIR.exists():
        for f in SAMPLES_DIR.iterdir():
            if f.is_file():
                f.unlink()
                deleted += 1
    logger.info("[voice_controller] Cleared %d voice samples", deleted)
    return {"status": "ok", "deleted": deleted}


# ─────────────────────────────────────────────────────────────────────────────
# ROUTES — SETTINGS
# ─────────────────────────────────────────────────────────────────────────────

class VoiceSettingsRequest(BaseModel):
    enabled:           Optional[bool]  = None
    always_on:         Optional[bool]  = None
    input_device:      Optional[int]   = None
    output_device:     Optional[int]   = None
    speed:             Optional[float] = None
    session_timeout_s: Optional[float] = None


@router.put("/settings")
async def update_voice_settings(body: VoiceSettingsRequest) -> dict:
    """
    Update voice settings. Only provided fields are changed.
    Device changes propagate immediately to wake word service.
    """
    if body.enabled is not None:
        _voice_settings["enabled"] = body.enabled

    if body.always_on is not None:
        _voice_settings["always_on"] = body.always_on

    if body.input_device is not None:
        _voice_settings["input_device"] = body.input_device
        try:
            from app.service.wake_word_service import set_mic_device
            set_mic_device(body.input_device)
        except Exception:
            pass

    if body.output_device is not None:
        _voice_settings["output_device"] = body.output_device

    if body.speed is not None:
        _voice_settings["speed"] = max(0.5, min(2.0, body.speed))

    if body.session_timeout_s is not None:
        timeout = max(3.0, min(60.0, body.session_timeout_s))
        _voice_settings["session_timeout_s"] = timeout
        try:
            from app.service.wake_word_service import set_session_timeout
            set_session_timeout(timeout)
        except Exception:
            pass

    logger.info("[voice_controller] Settings updated: %s", _voice_settings)
    _persist_voice_settings()
    return {"status": "ok", "settings": _voice_settings}


def _persist_voice_settings() -> None:
    """Deep-merge voice settings into ~/.aura/settings.json."""
    from app.controller.chat_controller import _persist_settings_json
    _persist_settings_json({"voice": _voice_settings})


# ─────────────────────────────────────────────────────────────────────────────
# ROUTES — TOGGLE (quick enable/disable)
# ─────────────────────────────────────────────────────────────────────────────

class VoiceToggleRequest(BaseModel):
    enabled: bool


@router.post("/toggle")
async def toggle_voice(body: VoiceToggleRequest) -> dict:
    """Enable or disable the voice layer. Persists to settings.json."""
    _voice_settings["enabled"] = body.enabled
    _persist_voice_settings()
    logger.info("[voice_controller] Voice toggled: enabled=%s", body.enabled)
    return {"status": "ok", "enabled": body.enabled}


# ─────────────────────────────────────────────────────────────────────────────
# ROUTES — MODELS
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/models")
async def get_models() -> dict:
    """List all available/downloaded voice models (STT + TTS)."""
    from app.service.voice_service import list_voice_models
    return {"models": list_voice_models()}


class ModelDownloadRequest(BaseModel):
    model_id: str


@router.post("/models/download")
async def download_model(body: ModelDownloadRequest) -> dict:
    """Trigger download of a specific voice model by ID."""
    from app.service.voice_service import download_voice_model
    return await download_voice_model(body.model_id)


# ─────────────────────────────────────────────────────────────────────────────
# ROUTES — WAKE PHRASES & KEYWORD-SPOTTING
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/wake-phrases")
async def get_wake_phrases_route() -> dict:
    """Return current wake phrases and detection mode status."""
    from app.service.wake_word_service import get_wake_phrases
    return get_wake_phrases()


class WakePhrasesRequest(BaseModel):
    phrases: list[str]


@router.put("/wake-phrases")
async def set_wake_phrases_route(body: WakePhrasesRequest) -> dict:
    """Update the list of wake phrases. Applied immediately to keyword-spotting."""
    from app.service.wake_word_service import set_wake_phrases
    return set_wake_phrases(body.phrases)


# ─────────────────────────────────────────────────────────────────────────────
# ROUTES — WAKE WORD TRAINING
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/wake-training/status")
async def wake_training_status() -> dict:
    """Return training sample counts, readiness, and trained model status."""
    from app.service.wake_word_service import get_training_status
    return get_training_status()


@router.post("/wake-training/upload")
async def upload_training_sample(
    phrase: str,
    sample: UploadFile = File(...),
) -> dict:
    """
    Upload a positive audio sample for a specific wake phrase.
    Minimum 10 samples per phrase to train; 50+ recommended.
    """
    from pathlib import Path as _Path
    allowed = {".wav", ".mp3", ".flac", ".ogg", ".m4a"}
    suffix = _Path(sample.filename or "sample.wav").suffix.lower()
    if suffix not in allowed:
        return {"status": "error", "message": f"File type {suffix} not supported"}

    content = await sample.read()
    filename = sample.filename or f"sample_{int(asyncio.get_event_loop().time())}{suffix}"

    from app.service.wake_word_service import save_training_sample
    return save_training_sample(phrase.strip(), content, filename)


class ClearTrainingRequest(BaseModel):
    phrase: Optional[str] = None


@router.delete("/wake-training/samples")
async def clear_training_samples_route(body: ClearTrainingRequest = ClearTrainingRequest()) -> dict:
    """Clear training samples for a phrase (or all if phrase is null)."""
    from app.service.wake_word_service import clear_training_samples
    return clear_training_samples(body.phrase)


@router.post("/wake-training/train")
async def train_wake_model_route() -> dict:
    """
    Start training a custom openWakeWord model from collected samples.
    Emits SSE wake_training_progress events during training.
    """
    from app.service.wake_word_service import train_wake_model
    return await train_wake_model(emit_fn=_emit_voice)
