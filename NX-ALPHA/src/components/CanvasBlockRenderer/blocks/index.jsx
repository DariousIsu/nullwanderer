/**
 * AURA NX-Alpha — Canvas Block Content Registry
 *
 * Exports all block content components + the BlockContent dispatcher.
 * CanvasBlockRenderer imports only BlockContent — new block types are
 * added here without touching the renderer.
 *
 * ADDING A NEW BLOCK TYPE:
 *   1. Create <Type>Block.jsx in this directory
 *   2. Import it below
 *   3. Add a case to the BLOCK_MAP
 *   Done. CanvasBlockRenderer renders it automatically.
 *
 * PHASE 1 (11 types): heading, paragraph, list, table, chart, code,
 *                     email, image, metric_card, callout, html
 * PHASE 2 (2 types):  scene_3d (Three.js WebGL), video (HTML5 + HLS live stream)
 * CLI-Anything §34:   diagram, image_generated, document_file, audio_clip, video_clip
 */

// ── Phase 1 ──
import HeadingBlock    from './HeadingBlock';
import ParagraphBlock  from './ParagraphBlock';
import ListBlock       from './ListBlock';
import TableBlock      from './TableBlock';
import ChartBlock      from './ChartBlock';
import CodeBlock       from './CodeBlock';
import EmailBlock      from './EmailBlock';
import ImageBlock      from './ImageBlock';
import MetricCardBlock from './MetricCardBlock';
import CalloutBlock    from './CalloutBlock';
import HtmlBlock       from './HtmlBlock';

// ── Phase 2 ──
import ThreeBlock from './ThreeBlock';
import VideoBlock from './VideoBlock';

// ── Phase 9 ──
import BrowserSnapshotBlock from './BrowserSnapshotBlock';

// ── CLI-Anything (§34) ──
import DiagramBlock       from './DiagramBlock';
import ImageGeneratedBlock from './ImageGeneratedBlock';
import DocumentFileBlock  from './DocumentFileBlock';
import AudioClipBlock     from './AudioClipBlock';
import VideoClipBlock     from './VideoClipBlock';
import FileBlock          from './FileBlock';
import CardListBlock      from './CardListBlock';

// ─────────────────────────────────────────────────────────────────────────────
// BLOCK MAP — type string → component
// ─────────────────────────────────────────────────────────────────────────────

const BLOCK_MAP = {
  // Phase 1
  heading:     HeadingBlock,
  paragraph:   ParagraphBlock,
  list:        ListBlock,
  table:       TableBlock,
  chart:       ChartBlock,
  code:        CodeBlock,
  email:       EmailBlock,
  image:       ImageBlock,
  metric_card: MetricCardBlock,
  callout:     CalloutBlock,
  html:        HtmlBlock,
  // Aliases — models sometimes emit these instead of the canonical type
  website:     HtmlBlock,
  web:         HtmlBlock,
  text:        ParagraphBlock,
  header:      HeadingBlock,
  // Phase 2
  scene_3d:        ThreeBlock,
  video:           VideoBlock,
  // Phase 9
  browser_snapshot: BrowserSnapshotBlock,
  // CLI-Anything (§34)
  diagram:         DiagramBlock,
  image_generated: ImageGeneratedBlock,
  document_file:   DocumentFileBlock,
  audio_clip:      AudioClipBlock,
  video_clip:      VideoClipBlock,
  // Canvas drop upload placeholder
  file:            FileBlock,
  // Card list (news, memory, files, screen awareness)
  'card-list':     CardListBlock,
};

// ─────────────────────────────────────────────────────────────────────────────
// BLOCK CONTENT DISPATCHER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolves block type → component and renders it with data props.
 * Unknown types render an amber-bordered fallback rather than crashing.
 *
 * @param {string} type — block type string
 * @param {object} data — block data payload (spread as props)
 */
export const BlockContent = ({ type, data = {} }) => {
  const Component = BLOCK_MAP[type];
  if (!Component) {
    return (
      <div style={{
        padding:     '12px 14px',
        color:       'var(--amber-bright)',
        fontFamily:  'var(--font-condensed)',
        fontSize:    10,
        letterSpacing: '0.10em',
        textTransform: 'uppercase',
      }}>
        Unknown block type: {type}
      </div>
    );
  }
  return <Component {...data} />;
};

// Named exports for direct use
export {
  // Phase 1
  HeadingBlock,
  ParagraphBlock,
  ListBlock,
  TableBlock,
  ChartBlock,
  CodeBlock,
  EmailBlock,
  ImageBlock,
  MetricCardBlock,
  CalloutBlock,
  HtmlBlock,
  // Phase 2
  ThreeBlock,
  VideoBlock,
  // Phase 9
  BrowserSnapshotBlock,
  // CLI-Anything (§34)
  DiagramBlock,
  ImageGeneratedBlock,
  DocumentFileBlock,
  AudioClipBlock,
  VideoClipBlock,
  FileBlock,
  CardListBlock,
};

export default BLOCK_MAP;
