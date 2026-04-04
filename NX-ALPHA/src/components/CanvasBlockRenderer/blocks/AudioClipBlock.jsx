/**
 * AURA NX-Alpha — AudioClipBlock
 *
 * Canvas block for audio clips from CLI-Anything tools or TTS exports.
 * Renders an inline audio player.
 * Bible §34 — CLI toolchain audio output.
 *
 * PROPS:
 *   src        — URL or data-URI of audio file
 *   title      — Display title
 *   duration_s — Duration in seconds
 *   format     — 'wav' | 'mp3' | 'ogg' (default 'wav')
 *   source     — Producer label (e.g. 'tts', 'recorder', 'ffmpeg')
 */

import styles from './AudioClipBlock.module.css';

const AudioClipBlock = ({
  src        = null,
  title      = 'Audio Clip',
  duration_s = null,
  format     = 'wav',
  source     = '',
}) => {
  const formatDuration = (s) => {
    if (s == null) return '';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60).toString().padStart(2, '0');
    return `${m}:${sec}`;
  };

  return (
    <div className={styles.wrap}>
      <div className={styles.header}>
        <span className={styles.icon} aria-hidden="true">♫</span>
        <span className={styles.title}>{title}</span>
        {duration_s != null && (
          <span className={styles.duration}>{formatDuration(duration_s)}</span>
        )}
        {source && <span className={styles.badge}>{source}</span>}
        <span className={styles.format}>{format.toUpperCase()}</span>
      </div>

      {src ? (
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <audio
          controls
          className={styles.player}
          src={src}
          aria-label={title}
        />
      ) : (
        <div className={styles.placeholder}>No audio source</div>
      )}
    </div>
  );
};

export default AudioClipBlock;
