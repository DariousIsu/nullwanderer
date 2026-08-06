/* scripts/mermaid_entry.js — esbuild ENTRY for the canvas DIAGRAM bundle.
 *
 * Bundles mermaid → renderer/vendor/mermaid.bundle.js (an IIFE that hangs `window.mermaid`). The canvas
 * renderer loads it with a plain <script src> (same idiom as vendor/tiptap.bundle.js) and calls
 * window.mermaid.run() on the .mermaid blocks after each canvas paint (renderer/canvas.js renderMermaid).
 * Re-run `node scripts/build_mermaid.js` when mermaid is upgraded.
 *
 * securityLevel 'strict' escapes HTML in node labels (the diagram source is operator-authored text, and
 * the canvas is single-operator, but strict keeps a mis-emitted label from injecting markup). theme dark
 * matches the canvas surface; startOnLoad false because WE drive rendering explicitly per paint.
 */
import mermaid from 'mermaid';

// 'base' + explicit themeVariables (not the stock 'dark' theme, which rendered white node text on
// near-white node fills — unreadable on our surface). These give dark node fills, light label text, and
// a blue accent border that matches the canvas palette, so labels are legible on var(--bg-raised).
mermaid.initialize({
  startOnLoad: false,
  securityLevel: 'strict',
  theme: 'base',
  fontFamily: 'inherit',
  // Mermaid v11 renders node labels as HTML in <foreignObject> by default, so SVG fill/theme text color
  // never reaches them (they stayed invisible white-on-white). false → labels become real SVG <text> that
  // obey nodeTextColor + our CSS override.
  htmlLabels: false,
  flowchart: { htmlLabels: false, useMaxWidth: true },
  themeVariables: {
    darkMode: true,
    background: '#1a1a20',
    // node fill is mainBkg (primaryColor alone left nodes default-white); border + text for contrast
    mainBkg: '#26263a',
    nodeBorder: '#4f9cff',
    nodeTextColor: '#e8e8eb',
    primaryColor: '#26263a',
    primaryTextColor: '#e8e8eb',
    primaryBorderColor: '#4f9cff',
    secondaryColor: '#2c2c3d',
    secondaryBorderColor: '#8aa6c9',
    secondaryTextColor: '#e8e8eb',
    tertiaryColor: '#232331',
    tertiaryBorderColor: '#4a4a52',
    tertiaryTextColor: '#e8e8eb',
    clusterBkg: '#17171d',
    clusterBorder: '#2a2a30',
    lineColor: '#8aa6c9',
    textColor: '#e8e8eb',
    titleColor: '#e8e8eb',
    edgeLabelBackground: '#1a1a20',
    labelBoxBkgColor: '#26263a',
    labelBoxBorderColor: '#4f9cff',
    labelTextColor: '#e8e8eb',
    fontSize: '13px',
  },
});

window.mermaid = mermaid;
