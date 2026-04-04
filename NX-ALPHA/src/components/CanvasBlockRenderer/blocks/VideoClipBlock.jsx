/**
 * AURA NX-Alpha — VideoClipBlock
 *
 * Canvas block for video clips from CLI-Anything tools (screen recordings, ffmpeg output).
 * Renders an inline HTML5 video player. Not to be confused with VideoBlock (live HLS/HTTP
 * streaming). VideoClipBlock is for local/exported clip files.
 * Bible §34 — CLI toolchain video output.
 *
 * PROPS:
 *   src        — URL, local file path, or data-URI
 *   title      — Display title
 *   duration_s — Duration in seconds
 *   format     — 'mp4' | 'webm' | 'mkv' (default 'mp4')
 *   poster     — Optional poster image URL
 *   source     — Producer label (e.g. 'ffmpeg', 'recorder')
 */

import styles from './VideoClipBlock.module.css';

const VideoClipBlock = ({
  src        = null,
  title      = 'Video Clip',
  duration_s = null,
  format     = 'mp4',
  poster     = undefined,
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
        <span className={styles.icon} aria-hidden="true">▶</span>
        <span className={styles.title}>{title}</span>
        {duration_s != null && (
          <span className={styles.duration}>{formatDuration(duration_s)}</span>
        )}
        {source && <span className={styles.badge}>{source}</span>}
        <span className={styles.format}>{format.toUpperCase()}</span>
      </div>

      {src ? (
        <video
          controls
          className={styles.player}
          poster={poster}
          aria-label={title}
        >
          <source src={src} type={`video/${format}`} />
          Your browser does not support inline video playback.
        </video>
      ) : (
        <div className={styles.placeholder}>
          <span className={styles.placeholderIcon} aria-hidden="true">▶</span>
          No video source
        </div>
      )}
    </div>
  );
};

export default VideoClipBlock;
