/**
 * AURA NX-Alpha — Voice Settings Section
 *
 * Controls:
 *   Voice output toggle (per-session or persistent)
 *   Always-on wake word toggle (ambient listen mode)
 *   Audio input device selector
 *   Audio output device selector
 *   Speaking speed slider
 *   Session timeout slider
 *
 * Voice Design:
 *   Text description → saved as voice profile
 *   Reference audio upload (drag/drop or file picker)
 *   Sample list with count
 *   Generate / Preview / Reset actions
 *
 * Phase gate display — shows which TTS engine is active:
 *   Phase 1: piper-tts (CPU) — generic female voice (testing)
 *   Phase 2: MOSS-TTS-Realtime (GPU) — designed personality voice
 *
 * Data flows via GET /voice/status, PUT /voice/settings, POST /voice/profile,
 * POST /voice/profile/sample, GET /voice/devices.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import styles from './SectionVoice.module.css';

const BASE = 'http://localhost:8000';

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function apiFetch(path, opts = {}) {
  try {
    const res = await fetch(`${BASE}${path}`, opts);
    return await res.json();
  } catch {
    return null;
  }
}

function StatusDot({ ok }) {
  return (
    <span
      className={ok ? styles.dotOnline : styles.dotOffline}
      title={ok ? 'Available' : 'Not installed'}
    />
  );
}

function Toggle({ checked, onChange, disabled, label, meta }) {
  return (
    <div className={styles.toggleRow}>
      <div className={styles.toggleInfo}>
        <span className={styles.toggleLabel}>{label}</span>
        {meta && <span className={styles.toggleMeta}>{meta}</span>}
      </div>
      <button
        className={[styles.toggleBtn, checked && styles.toggleBtnOn].filter(Boolean).join(' ')}
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
      >
        <span className={styles.toggleThumb} />
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION: VOICE
// ─────────────────────────────────────────────────────────────────────────────

const SectionVoice = () => {
  // ── Remote state ───────────────────────────────────────────────────────────
  const [status,   setStatus]   = useState(null);
  const [devices,  setDevices]  = useState({ inputs: [], outputs: [] });
  const [loading,  setLoading]  = useState(true);

  // ── Local controls ─────────────────────────────────────────────────────────
  const [enabled,        setEnabled]        = useState(true);
  const [alwaysOn,       setAlwaysOn]       = useState(false);
  const [inputDevice,    setInputDevice]    = useState(-1);
  const [outputDevice,   setOutputDevice]   = useState(-1);
  const [speed,          setSpeed]          = useState(1.0);
  const [sessionTimeout, setSessionTimeout] = useState(8);

  // ── Voice design ───────────────────────────────────────────────────────────
  const [voiceName,     setVoiceName]     = useState('');
  const [description,   setDescription]   = useState('');
  const [ttsEngine,     setTtsEngine]     = useState('piper');
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileSaved,  setProfileSaved]  = useState(false);
  const [samples,       setSamples]       = useState([]);
  const [uploadingFile, setUploadingFile] = useState(false);
  const [dragOver,      setDragOver]      = useState(false);
  const fileInputRef = useRef(null);

  // ── First-launch download progress ───────────────────────────────────────
  const [setupProgress, setSetupProgress] = useState(null);

  useEffect(() => {
    const es = new EventSource(`${BASE}/stream`);
    es.addEventListener('voice_setup_progress', (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.status === 'complete' && data.step === 'complete') {
          setSetupProgress(null);
          apiFetch('/voice/status').then(s => s && setStatus(s));
        } else {
          setSetupProgress(data);
        }
      } catch { /* ignore */ }
    });
    return () => es.close();
  }, []);

  // ── Fetch status + devices on mount ───────────────────────────────────────
  useEffect(() => {
    let mounted = true;

    async function fetchAll() {
      const [s, d] = await Promise.all([
        apiFetch('/voice/status'),
        apiFetch('/voice/devices'),
      ]);
      if (!mounted) return;

      if (s) {
        setStatus(s);
        const cfg = s.settings || {};
        setEnabled(cfg.enabled        ?? true);
        setAlwaysOn(cfg.always_on     ?? false);
        setInputDevice(cfg.input_device   ?? -1);
        setOutputDevice(cfg.output_device ?? -1);
        setSpeed(cfg.speed            ?? 1.0);
        setSessionTimeout(cfg.session_timeout_s ?? 8);
        if (s.profile?.name) setVoiceName(s.profile.name);
        if (s.profile?.description) setDescription(s.profile.description);
        if (s.profile?.tts_engine) setTtsEngine(s.profile.tts_engine);
      }

      if (d) {
        setDevices(d);
      }

      // Fetch samples
      const profile = await apiFetch('/voice/profile');
      if (mounted && profile?.samples) {
        setSamples(profile.samples);
      }

      setLoading(false);
    }

    fetchAll();
    return () => { mounted = false; };
  }, []);

  // ── Persist settings after slider release ────────────────────────────────
  const pushSettings = useCallback(async (patch) => {
    await apiFetch('/voice/settings', {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(patch),
    });
  }, []);

  // ── Save voice profile description ────────────────────────────────────────
  const handleSaveProfile = useCallback(async () => {
    if (!description.trim()) return;
    setSavingProfile(true);
    setProfileSaved(false);
    const result = await apiFetch('/voice/profile', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name: voiceName.trim(), description: description.trim(), tts_engine: ttsEngine }),
    });
    setSavingProfile(false);
    if (result?.status === 'saved') {
      setProfileSaved(true);
      setTimeout(() => setProfileSaved(false), 3000);
    }
  }, [description, voiceName, ttsEngine]);

  // ── Upload reference audio sample ─────────────────────────────────────────
  const handleFileUpload = useCallback(async (file) => {
    if (!file) return;
    setUploadingFile(true);
    const form = new FormData();
    form.append('sample', file);
    const result = await apiFetch('/voice/profile/sample', {
      method: 'POST',
      body:   form,
    });
    setUploadingFile(false);
    if (result?.status === 'saved') {
      setSamples(prev => [
        ...prev,
        { filename: result.filename, size_bytes: result.size_bytes },
      ]);
    }
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFileUpload(file);
  }, [handleFileUpload]);

  const handleClearSamples = useCallback(async () => {
    await apiFetch('/voice/profile/samples', { method: 'DELETE' });
    setSamples([]);
  }, []);

  if (loading) {
    return (
      <div className={styles.section}>
        <div className={styles.loadingMsg}>Loading voice settings...</div>
      </div>
    );
  }

  const stt = status?.stt_available;
  const tts = status?.tts_available;
  const wakeOk = status?.wake_word_available;
  const hasProfile = status?.profile?.has_profile;
  const phaseLabel = tts ? 'piper-tts (CPU) — Phase 1' : 'Not installed';

  return (
    <div className={styles.section}>

      {/* ── AVAILABILITY BAR ── */}
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>Voice</h2>
        <p className={styles.sectionSub}>
          Two-way spoken communication. All models run locally — no cloud services.
        </p>
      </div>

      <div className={styles.availRow}>
        <div className={styles.availItem}>
          <StatusDot ok={stt} />
          <span className={styles.availLabel}>STT</span>
          <span className={styles.availEngine}>{stt ? 'faster-whisper' : 'pip install faster-whisper'}</span>
        </div>
        <div className={styles.availItem}>
          <StatusDot ok={tts} />
          <span className={styles.availLabel}>TTS</span>
          <span className={styles.availEngine}>{phaseLabel}</span>
        </div>
        <div className={styles.availItem}>
          <StatusDot ok={wakeOk} />
          <span className={styles.availLabel}>Wake</span>
          <span className={styles.availEngine}>{wakeOk ? 'openWakeWord' : 'pip install openwakeword'}</span>
        </div>
      </div>

      {/* ── FIRST-LAUNCH SETUP BANNER ── */}
      {setupProgress && (
        <div className={styles.setupBanner}>
          <div className={styles.setupBannerLabel}>
            {setupProgress.message || 'Setting up voice system...'}
          </div>
          {typeof setupProgress.pct === 'number' && (
            <div className={styles.setupProgressBar}>
              <div
                className={styles.setupProgressFill}
                style={{ width: `${setupProgress.pct}%` }}
              />
            </div>
          )}
        </div>
      )}

      {/* ── VOICE TOGGLES ── */}
      <div className={styles.group}>
        <Toggle
          label="Voice Output"
          meta={enabled ? 'Aura speaks responses aloud' : 'Text only — no audio output'}
          checked={enabled}
          onChange={v => { setEnabled(v); pushSettings({ enabled: v }); }}
        />
        <Toggle
          label="Always-On (Wake Word)"
          meta={
            alwaysOn
              ? `Listening for "Hey AURA" — ${wakeOk ? 'active' : 'requires openwakeword'}`
              : 'Push mic button to speak — wake word inactive'
          }
          checked={alwaysOn}
          disabled={!wakeOk}
          onChange={v => { setAlwaysOn(v); pushSettings({ always_on: v }); }}
        />
      </div>

      {/* ── AUDIO DEVICES ── */}
      <div className={styles.group}>
        <div className={styles.groupTitle}>Audio Devices</div>

        <div className={styles.fieldRow}>
          <label className={styles.fieldLabel} htmlFor="voice-input-device">
            Microphone (Input)
          </label>
          <select
            id="voice-input-device"
            className={styles.select}
            value={inputDevice}
            onChange={e => {
              const v = Number(e.target.value);
              setInputDevice(v);
              pushSettings({ input_device: v });
            }}
          >
            {devices.inputs.map(d => (
              <option key={d.index} value={d.index}>{d.name}</option>
            ))}
          </select>
        </div>

        <div className={styles.fieldRow}>
          <label className={styles.fieldLabel} htmlFor="voice-output-device">
            Speaker (Output)
          </label>
          <select
            id="voice-output-device"
            className={styles.select}
            value={outputDevice}
            onChange={e => {
              const v = Number(e.target.value);
              setOutputDevice(v);
              pushSettings({ output_device: v });
            }}
          >
            {devices.outputs.map(d => (
              <option key={d.index} value={d.index}>{d.name}</option>
            ))}
          </select>
        </div>
      </div>

      {/* ── SPEAKING CONTROLS ── */}
      <div className={styles.group}>
        <div className={styles.groupTitle}>Speaking Controls</div>

        <div className={styles.sliderRow}>
          <label className={styles.fieldLabel}>
            Speaking Speed
            <span className={styles.sliderVal}>{speed.toFixed(1)}×</span>
          </label>
          <input
            type="range"
            className={styles.slider}
            min={0.5} max={2.0} step={0.1}
            value={speed}
            onChange={e => setSpeed(Number(e.target.value))}
            onMouseUp={e  => pushSettings({ speed: Number(e.target.value) })}
            onTouchEnd={e => pushSettings({ speed: Number(e.target.value) })}
          />
          <div className={styles.sliderBounds}>
            <span>0.5× slow</span><span>2.0× fast</span>
          </div>
        </div>

        <div className={styles.sliderRow}>
          <label className={styles.fieldLabel}>
            Session Timeout
            <span className={styles.sliderVal}>{sessionTimeout}s</span>
          </label>
          <input
            type="range"
            className={styles.slider}
            min={3} max={30} step={1}
            value={sessionTimeout}
            onChange={e => setSessionTimeout(Number(e.target.value))}
            onMouseUp={e  => pushSettings({ session_timeout_s: Number(e.target.value) })}
            onTouchEnd={e => pushSettings({ session_timeout_s: Number(e.target.value) })}
          />
          <div className={styles.sliderBounds}>
            <span>3s</span><span>30s silence closes session</span>
          </div>
        </div>
      </div>

      {/* ── VOICE DESIGN ── */}
      <div className={styles.group}>
        <div className={styles.groupTitle}>Voice Design</div>
        <p className={styles.groupSub}>
          Describe Aura's voice and optionally provide reference audio samples.
          Phase 1: description is stored for Phase 2 MOSS-VoiceGenerator.
          Phase 2+: generates an acoustic voice profile used by MOSS-TTS-Realtime.
        </p>

        {/* Profile status badge */}
        <div className={styles.profileStatus}>
          <span className={hasProfile ? styles.profileBadgeActive : styles.profileBadgeNone}>
            {hasProfile
              ? `${status.profile.name || 'Voice profile'} — ${status.profile.tts_engine} · ${status.profile.created_at?.slice(0, 10)}`
              : 'No voice profile — using engine default'}
          </span>
        </div>

        {/* TTS Engine selector */}
        <div className={styles.fieldRow} style={{ flexDirection: 'column', alignItems: 'stretch', gap: '6px' }}>
          <span className={styles.fieldLabel}>TTS Engine</span>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              className={ttsEngine === 'piper' ? styles.engineBtnActive : styles.engineBtn}
              onClick={() => setTtsEngine('piper')}
              title="Fast CPU synthesis, generic voice"
            >
              Piper <span style={{ opacity: 0.55, fontSize: '10px' }}>CPU · fast</span>
            </button>
            <button
              className={ttsEngine === 'chatterbox' ? styles.engineBtnActive : styles.engineBtn}
              onClick={() => setTtsEngine('chatterbox')}
              title={status?.tts_chatterbox_available
                ? 'Voice cloning with emotion control — uses uploaded samples'
                : 'Chatterbox not installed — run: pip install chatterbox-tts'}
              disabled={!status?.tts_chatterbox_available}
            >
              Chatterbox <span style={{ opacity: 0.55, fontSize: '10px' }}>voice clone</span>
              {!status?.tts_chatterbox_available && (
                <span style={{ opacity: 0.4, fontSize: '10px' }}> · not installed</span>
              )}
            </button>
          </div>
          {ttsEngine === 'chatterbox' && (
            <p style={{ margin: '4px 0 0', fontSize: '11px', opacity: 0.5, lineHeight: 1.4 }}>
              Downloads ~1.5GB model on first use. Reference audio samples above are used for voice cloning.
              The more samples you upload, the more accurate the clone.
            </p>
          )}
        </div>

        {/* Voice name */}
        <div className={styles.fieldRow} style={{ flexDirection: 'column', alignItems: 'stretch', gap: '8px' }}>
          <label className={styles.fieldLabel} htmlFor="voice-name">
            Voice Name
          </label>
          <input
            id="voice-name"
            className={styles.textarea}
            style={{ minHeight: 'auto', height: '32px', resize: 'none' }}
            type="text"
            value={voiceName}
            onChange={e => setVoiceName(e.target.value)}
            placeholder='e.g. "Aura Alpha", "Mission Control", "Athena"'
          />
        </div>

        {/* Description input */}
        <div className={styles.fieldRow} style={{ flexDirection: 'column', alignItems: 'stretch', gap: '8px' }}>
          <label className={styles.fieldLabel} htmlFor="voice-description">
            Voice Description
          </label>
          <textarea
            id="voice-description"
            className={styles.textarea}
            rows={4}
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder={
              'Describe the voice you want for Aura.\n' +
              'e.g. "Calm, confident female voice. Low and warm. ' +
              'Measured pace. Slight resonance — mission control, not assistant."'
            }
          />
        </div>

        {/* Reference audio upload */}
        <div className={styles.fieldLabel} style={{ marginBottom: '6px' }}>
          Reference Audio Samples
          <span className={styles.fieldHint}> — WAV / MP3 / FLAC, 3-30s recommended</span>
        </div>

        <div
          className={[styles.dropZone, dragOver && styles.dropZoneActive].filter(Boolean).join(' ')}
          onDragOver={e => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={e => e.key === 'Enter' && fileInputRef.current?.click()}
          aria-label="Upload reference audio sample"
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".wav,.mp3,.flac,.ogg,.m4a"
            style={{ display: 'none' }}
            onChange={e => handleFileUpload(e.target.files?.[0])}
          />
          {uploadingFile
            ? <span className={styles.dropLabel}>Uploading...</span>
            : (
              <>
                <span className={styles.dropIcon}>↑</span>
                <span className={styles.dropLabel}>Drop audio here or click to browse</span>
                <span className={styles.dropHint}>
                  {samples.length > 0
                    ? `${samples.length} sample${samples.length > 1 ? 's' : ''} loaded`
                    : 'No samples yet'}
                </span>
              </>
            )
          }
        </div>

        {samples.length > 0 && (
          <div className={styles.sampleList}>
            {samples.map((s, i) => (
              <div key={i} className={styles.sampleRow}>
                <span className={styles.sampleName}>{s.filename}</span>
                <span className={styles.sampleSize}>
                  {s.size_bytes ? `${(s.size_bytes / 1024).toFixed(0)}KB` : ''}
                </span>
              </div>
            ))}
            <button className={styles.clearBtn} onClick={handleClearSamples}>
              Clear all samples
            </button>
          </div>
        )}

        {/* Actions */}
        <div className={styles.actionRow}>
          <button
            className={styles.generateBtn}
            onClick={handleSaveProfile}
            disabled={!description.trim() || savingProfile}
          >
            {savingProfile ? 'Saving...' : profileSaved ? '✓ Saved' : 'Save Voice Profile'}
          </button>
          <button
            className={styles.previewBtn}
            disabled={!tts}
            onClick={async () => {
              const preview = 'Hello. I am Aura. Your intelligence layer is online.';
              const res = await fetch(`${BASE}/voice/synthesize`, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ text: preview, speed }),
              });
              if (!res.ok) return;
              const blob = await res.blob();
              const url  = URL.createObjectURL(blob);
              const audio = new Audio(url);
              audio.play();
              audio.onended = () => URL.revokeObjectURL(url);
            }}
          >
            ▶ Preview
          </button>
        </div>
      </div>

      {/* ── PHASE NOTE ── */}
      <div className={styles.phaseNote}>
        <span className={styles.phaseLabel}>PHASE GATE</span>
        Phase 1: piper-tts (CPU, generic voice, testing).
        Phase 2 hardware: MOSS-TTS-Realtime activates automatically using this profile.
        No settings changes needed at upgrade.
      </div>

    </div>
  );
};

export default SectionVoice;
