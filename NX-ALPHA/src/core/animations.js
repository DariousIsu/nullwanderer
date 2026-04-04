/**
 * AURA NX-Alpha — Animation Core
 * Single source of truth for all GSAP configuration and shared animation functions.
 *
 * RULE: Import and call initAnimations() once at app startup (main renderer entry point).
 * Never register plugins or CustomEases anywhere else in the codebase.
 *
 * RULE: Animation communicates state change or it gets cut.
 *       GSAP handles transitions. CSS handles ambient repeating indicators.
 *       See Design System Section 5 for the full split.
 */

import gsap from 'gsap';
import { Flip }       from 'gsap/Flip';
import { CustomEase } from 'gsap/CustomEase';
import { useGSAP }    from '@gsap/react';

// ─────────────────────────────────────────────────────────────────────────────
// PLUGIN REGISTRATION
// ─────────────────────────────────────────────────────────────────────────────

gsap.registerPlugin(Flip, CustomEase, useGSAP);

// ─────────────────────────────────────────────────────────────────────────────
// CUSTOM EASING CURVES
// Named for intent, not shape. These give Aura the mechanical / hardware feel.
// ─────────────────────────────────────────────────────────────────────────────

const EASES = {
  /** Panel popping out of command center — firm, decisive, no float */
  panelOut: CustomEase.create('panel-out', 'M0,0 C0.2,0 0.1,1 1,1'),

  /** Panel docking back — decelerates like finding its slot */
  panelIn: CustomEase.create('panel-in', 'M0,0 C0.6,0 0.8,0.9 1,1'),

  /** Status badge state change — slight mechanical overshoot */
  statusChange: CustomEase.create('status-change', 'M0,0 C0.4,0 0.2,1.15 1,1'),

  /** Gauge needle / data value update — weighted, analog feel */
  analogGauge: CustomEase.create('analog-gauge', 'M0,0 C0.15,0 0.05,0.95 1,1'),
};

// ─────────────────────────────────────────────────────────────────────────────
// GSAP DEFAULTS
// ─────────────────────────────────────────────────────────────────────────────

gsap.defaults({
  ease:     'panel-out',
  duration: 0.2,
});

// ─────────────────────────────────────────────────────────────────────────────
// INIT — call once at renderer startup
// ─────────────────────────────────────────────────────────────────────────────

export function initAnimations() {
  // Verify plugins registered correctly in dev
  if (process.env.NODE_ENV === 'development') {
    console.log('[AURA animations] GSAP initialized. Plugins: Flip, CustomEase, useGSAP.');
    console.log('[AURA animations] Custom eases registered:', Object.keys(EASES).join(', '));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PANEL ANIMATIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Panel entrance — runs once when a panel first mounts.
 * @param {Element} el - The panel root element
 */
export function animatePanelEntrance(el) {
  return gsap.from(el, {
    opacity:  0,
    y:        8,
    duration: 0.35,
    ease:     'panel-out',
    clearProps: 'transform',
  });
}

/**
 * Panel pop-out — captures before/after Flip state and animates the transition.
 * Call this before updating the DOM (setIsFloating(true)), pass the captured state.
 *
 * Usage:
 *   const state = captureFlipState(panelRef.current);
 *   setIsFloating(true);
 *   requestAnimationFrame(() => animatePanelPopOut(state));
 *
 * @param {FlipState} flipState - State captured via captureFlipState()
 */
export function captureFlipState(el) {
  return Flip.getState(el);
}

export function animatePanelPopOut(flipState) {
  return Flip.from(flipState, {
    duration:    0.35,
    ease:        'panel-out',
    clearProps:  'all',
    absoluteOnLeave: true,
  });
}

export function animatePanelDock(flipState) {
  return Flip.from(flipState, {
    duration:   0.3,
    ease:       'panel-in',
    clearProps: 'all',
  });
}

/**
 * Panel body expand/collapse (accordion within command center).
 * @param {Element} bodyEl  - The panel body element
 * @param {boolean} expand  - true = expanding, false = collapsing
 */
export function animatePanelCollapse(bodyEl, expand) {
  if (expand) {
    return gsap.fromTo(bodyEl,
      { height: 0, opacity: 0 },
      { height: 'auto', opacity: 1, duration: 0.2, ease: 'panel-out', clearProps: 'height' }
    );
  } else {
    return gsap.to(bodyEl, {
      height:  0,
      opacity: 0,
      duration: 0.18,
      ease:    'power2.in',
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AGENT ANIMATIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Agent team card entrance — called when a new team is spawned.
 * @param {Element} teamEl - The team card root element
 */
export function animateTeamEntrance(teamEl) {
  return gsap.from(teamEl, {
    opacity:  0,
    y:        10,
    duration: 0.3,
    ease:     'panel-out',
    clearProps: 'transform',
  });
}

/**
 * Agent team archive — collapses and fades when team completes.
 * @param {Element} teamEl   - The team card root element
 * @param {Function} onComplete - Called after animation finishes (remove from DOM)
 */
export function animateTeamArchive(teamEl, onComplete) {
  return gsap.to(teamEl, {
    opacity:  0,
    height:   0,
    marginBottom: 0,
    paddingTop:   0,
    paddingBottom: 0,
    duration:   0.28,
    ease:       'power2.in',
    onComplete,
  });
}

/**
 * Status badge state transition — cross-fades between badge states.
 * @param {Element} badgeEl - The badge element
 * @param {Function} updateFn - React state setter called at midpoint of fade
 */
export function animateBadgeTransition(badgeEl, updateFn) {
  const tl = gsap.timeline();
  tl.to(badgeEl, {
    opacity:  0,
    scale:    0.95,
    duration: 0.08,
    ease:     'power2.in',
  })
  .call(updateFn)
  .to(badgeEl, {
    opacity:  1,
    scale:    1,
    duration: 0.14,
    ease:     'status-change',
  });
  return tl;
}

// ─────────────────────────────────────────────────────────────────────────────
// FLOATING PANEL ANIMATIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * FloatingPanel entrance — runs on mount (new panel or restore from peek).
 * Appears from slightly above, scaling up from canvas layer.
 * @param {Element} el - FloatingPanel root element
 */
export function animateFloatingPanelEntrance(el) {
  return gsap.from(el, {
    opacity:  0,
    scale:    0.94,
    y:        -10,
    duration: 0.3,
    ease:     'panel-out',
    clearProps: 'transform',
  });
}

/**
 * FloatingPanel minimize → peek tab.
 * Panel slides and fades toward the right edge, then calls onComplete
 * so CommandCenter can remove it from DOM.
 * @param {Element}  el         - FloatingPanel root element
 * @param {Function} onComplete - Called after animation finishes
 */
export function animateFloatingPanelMinimize(el, onComplete) {
  return gsap.to(el, {
    opacity:  0,
    scale:    0.92,
    x:        36,
    duration: 0.22,
    ease:     'power2.in',
    onComplete,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// DROP PANEL ANIMATIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * DropPanel open — slides down from above the canvas top edge.
 * Caller is responsible for setting el to visibility:visible BEFORE calling.
 * @param {Element} el - DropPanel root element
 */
export function animateDropPanelOpen(el) {
  gsap.set(el, { visibility: 'visible' });
  return gsap.fromTo(el,
    { y: '-102%', opacity: 0.4 },
    { y: '0%',   opacity: 1, duration: 0.28, ease: 'panel-out', clearProps: 'opacity' }
  );
}

/**
 * DropPanel close — slides back above canvas top edge, then hides.
 * @param {Element}  el         - DropPanel root element
 * @param {Function} onComplete - Called after slide finishes (set visibility:hidden here)
 */
export function animateDropPanelClose(el, onComplete) {
  return gsap.to(el, {
    y:        '-102%',
    opacity:  0.4,
    duration: 0.22,
    ease:     'power2.in',
    onComplete: () => {
      gsap.set(el, { visibility: 'hidden', clearProps: 'transform,opacity' });
      onComplete?.();
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PEEK STACK ANIMATIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Peek tab entrance — slides in from the right edge.
 * @param {Element} el - Individual peek tab button element
 */
export function animatePeekTabEntrance(el) {
  return gsap.from(el, {
    opacity:  0,
    x:        18,
    duration: 0.25,
    ease:     'panel-out',
    clearProps: 'transform',
  });
}

/**
 * Peek tab exit — slides out to right edge, then calls onComplete.
 * @param {Element}  el         - Individual peek tab button element
 * @param {Function} onComplete - Called after animation (remove from state)
 */
export function animatePeekTabExit(el, onComplete) {
  return gsap.to(el, {
    opacity:  0,
    x:        18,
    duration: 0.18,
    ease:     'power2.in',
    onComplete,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// RIGHT DOCK ANIMATIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Right dock open — expands from 0 to full width when the first panel docks.
 * @param {Element} el    - The .dock root element
 * @param {number}  width - Target width in px (default 264)
 */
export function animateRightDockOpen(el, width = 264) {
  return gsap.fromTo(el,
    { width: 0 },
    { width, duration: 0.30, ease: 'panel-out' }
  );
}

/**
 * Right dock close — collapses to 0 when the last panel leaves.
 * @param {Element}  el         - The .dock root element
 * @param {Function} onComplete - Called after collapse (optional)
 */
export function animateRightDockClose(el, onComplete) {
  return gsap.to(el, {
    width:    0,
    duration: 0.22,
    ease:     'power2.in',
    onComplete,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// CHAT SIDEBAR ANIMATIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Animate the chat sidebar collapse or expand.
 * Replaces CSS width transition on .chatSide.
 * @param {Element} el       - The .chatSide div element
 * @param {boolean} collapse - true = collapsing to 24px, false = expanding to 300px
 */
/**
 * @param {Element} el
 * @param {boolean} collapse
 * @param {number}  [expandedWidth=300] — current user-set sidebar width; used for expand target
 */
export function animateChatSidebar(el, collapse, expandedWidth = 300) {
  if (collapse) {
    return gsap.to(el, {
      width:    24,
      duration: 0.22,
      ease:     'power2.in',
    });
  } else {
    return gsap.to(el, {
      width:    expandedWidth,
      duration: 0.28,
      ease:     'panel-out',
      // No clearProps — inline width stays so the resize handle's value persists
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CANVAS ANIMATIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Canvas content crossfade — transitions between content types.
 * @param {Element} outgoingEl - Current content element
 * @param {Element} incomingEl - New content element (initially hidden)
 * @param {Function} onMidpoint - Called when outgoing is fully faded (swap content here)
 */
export function animateCanvasCrossfade(outgoingEl, incomingEl, onMidpoint) {
  const tl = gsap.timeline();
  tl.to(outgoingEl, {
    opacity:  0,
    duration: 0.2,
    ease:     'power2.in',
  })
  .call(onMidpoint)
  .fromTo(incomingEl,
    { opacity: 0, y: 6 },
    { opacity: 1, y: 0, duration: 0.3, ease: 'panel-out', clearProps: 'transform' }
  );
  return tl;
}

// ─────────────────────────────────────────────────────────────────────────────
// DATA ANIMATIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Numeric value roll — animates a displayed number from old to new value.
 * Used for data panels when a significant value change occurs.
 * @param {Element} el      - Element containing the displayed number
 * @param {number}  toValue - Target value
 * @param {string}  prefix  - Optional prefix (e.g. '$')
 * @param {string}  suffix  - Optional suffix (e.g. '%')
 * @param {number}  decimals - Decimal places to display
 */
export function animateValueRoll(el, toValue, { prefix = '', suffix = '', decimals = 0 } = {}) {
  const obj = { value: parseFloat(el.dataset.value || 0) };
  return gsap.to(obj, {
    value:    toValue,
    duration: 0.45,
    ease:     'analog-gauge',
    onUpdate: () => {
      el.textContent = `${prefix}${obj.value.toFixed(decimals)}${suffix}`;
      el.dataset.value = obj.value;
    },
    onComplete: () => {
      el.dataset.value = toValue;
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// CANVAS BLOCK ANIMATIONS — Programmable Matter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Canvas block entrance — legacy simple fade/scale.
 * Kept for reference; prefer animateMaterialize for new code.
 * @param {Element} el - CanvasBlock root element
 */
export function animateBlockEntrance(el) {
  return gsap.from(el, {
    opacity:    0,
    scale:      0.97,
    y:          10,
    duration:   0.30,
    ease:       'panel-out',
    clearProps: 'transform,opacity',
  });
}

/**
 * Programmable Matter materialization — the three-phase canvas block entrance.
 *
 * Phase 1 — Blueprint: An amber wireframe border traces the block perimeter,
 *            as if a holographic schematic is guiding the matter.
 * Phase 2 — Voxel Fill: A grid of amber nanite-voxels floods in from random
 *            positions, visibly filling the block boundary.
 * Phase 3 — Surface Lock: Content surfaces through the voxel layer.
 *            Voxels dissolve. A brief amber glow flash seals the matter.
 *            The block settles into its final glass+metal state.
 *
 * Overlay elements (blueprint SVG, voxel grid, glow) are injected as direct
 * children of blockEl and are removed on completion — no React state touched.
 *
 * @param {Element}  blockEl   - CanvasBlock .block root (must be in DOM, sized)
 * @param {Element}  contentEl - The .content wrapper (revealed by this animation)
 * @param {Function} onComplete - Called after all phases complete (optional)
 */
export function animateMaterialize(blockEl, contentEl, onComplete) {
  const w = blockEl.offsetWidth;
  const h = blockEl.offsetHeight;

  // ── Phase 0: Hide content until surface lock ──
  gsap.set(contentEl, { opacity: 0 });

  // ── Blueprint SVG ──
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg   = document.createElementNS(svgNS, 'svg');
  Object.assign(svg.style, {
    position:      'absolute',
    inset:         '-1px',
    width:         'calc(100% + 2px)',
    height:        'calc(100% + 2px)',
    pointerEvents: 'none',
    zIndex:        '20',
    overflow:      'visible',
  });

  const bpRect    = document.createElementNS(svgNS, 'rect');
  const perimeter = 2 * (w + h);
  bpRect.setAttribute('x', '1');
  bpRect.setAttribute('y', '1');
  bpRect.setAttribute('width',  String(w - 2));
  bpRect.setAttribute('height', String(h - 2));
  bpRect.setAttribute('fill',   'none');
  bpRect.setAttribute('stroke', '#f0a830');
  bpRect.setAttribute('stroke-width', '1.2');
  bpRect.style.strokeDasharray  = String(perimeter);
  bpRect.style.strokeDashoffset = String(perimeter);
  svg.appendChild(bpRect);
  blockEl.appendChild(svg);

  // ── Voxel grid ──
  const VOXEL = 14;
  const cols  = Math.ceil(w / VOXEL);
  const rows  = Math.ceil(h / VOXEL);
  const voxelWrap = document.createElement('div');
  Object.assign(voxelWrap.style, {
    position:      'absolute',
    inset:         '0',
    zIndex:        '18',
    pointerEvents: 'none',
    overflow:      'hidden',
  });

  const voxels = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const v = document.createElement('div');
      Object.assign(v.style, {
        position:     'absolute',
        left:         `${c * VOXEL}px`,
        top:          `${r * VOXEL}px`,
        width:        `${VOXEL - 2}px`,
        height:       `${VOXEL - 2}px`,
        background:   'rgba(240,168,48,0.65)',
        borderRadius: '1px',
        opacity:      '0',
      });
      voxelWrap.appendChild(v);
      voxels.push(v);
    }
  }
  blockEl.appendChild(voxelWrap);

  // ── Glow overlay ──
  const glow = document.createElement('div');
  Object.assign(glow.style, {
    position:   'absolute',
    inset:      '0',
    background: 'radial-gradient(ellipse at center, rgba(240,168,48,0.30) 0%, transparent 65%)',
    opacity:    '0',
    zIndex:     '19',
    pointerEvents: 'none',
  });
  blockEl.appendChild(glow);

  // ── Timeline ──
  const cleanup = () => {
    svg.remove();
    voxelWrap.remove();
    glow.remove();
    onComplete?.();
  };

  const tl = gsap.timeline({ onComplete: cleanup });

  // Phase 1 — blueprint traces the perimeter (220ms)
  tl.to(bpRect, {
    strokeDashoffset: 0,
    duration: 0.22,
    ease: 'power2.inOut',
  });

  // Phase 2 — voxels storm in from random positions (400ms staggered)
  tl.to(voxels, {
    opacity:  1,
    duration: 0.05,
    stagger:  { from: 'random', amount: 0.38 },
    ease:     'none',
  }, '-=0.04');

  // Phase 3a — content surfaces through voxel layer
  tl.to(contentEl, {
    opacity:  1,
    duration: 0.18,
    ease:     'power2.out',
  }, '+=0.04');

  // Phase 3b — voxels dissolve (concurrent)
  tl.to(voxels, {
    opacity:  0,
    duration: 0.22,
    stagger:  { from: 'random', amount: 0.20 },
    ease:     'power2.in',
  }, '-=0.12');

  // Phase 3c — glow flash then fade (surface lock moment)
  tl.to(glow,  { opacity: 1, duration: 0.07 }, '-=0.22');
  tl.to(glow,  { opacity: 0, duration: 0.28, ease: 'power2.in' });

  // Blueprint fades as matter settles (runs concurrently)
  tl.to(svg,   { opacity: 0, duration: 0.22 }, '-=0.42');

  return tl;
}

/**
 * Canvas block exit — programmable matter dissolution.
 * Voxels flood in over the content, then scatter as the block collapses.
 * Calls onComplete after animation so CanvasBlockRenderer can purge from state.
 *
 * @param {Element}  blockEl   - CanvasBlock root element
 * @param {Element}  contentEl - The .content wrapper (faded before voxels appear)
 * @param {Function} onComplete - Called after animation finishes
 */
export function animateBlockExit(blockEl, contentEl, onComplete) {
  const w = blockEl.offsetWidth;
  const h = blockEl.offsetHeight;

  // Voxel grid for dissolution
  const VOXEL = 14;
  const cols  = Math.ceil(w / VOXEL);
  const rows  = Math.ceil(h / VOXEL);
  const voxelWrap = document.createElement('div');
  Object.assign(voxelWrap.style, {
    position:      'absolute',
    inset:         '0',
    zIndex:        '20',
    pointerEvents: 'none',
    overflow:      'hidden',
  });
  const voxels = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const v = document.createElement('div');
      Object.assign(v.style, {
        position:     'absolute',
        left:         `${c * VOXEL}px`,
        top:          `${r * VOXEL}px`,
        width:        `${VOXEL - 2}px`,
        height:       `${VOXEL - 2}px`,
        background:   'rgba(240,168,48,0.55)',
        borderRadius: '1px',
        opacity:      '0',
      });
      voxelWrap.appendChild(v);
      voxels.push(v);
    }
  }
  blockEl.appendChild(voxelWrap);

  const tl = gsap.timeline({ onComplete });

  // Content fades, voxels flood in
  if (contentEl) tl.to(contentEl, { opacity: 0, duration: 0.12 });
  tl.to(voxels, {
    opacity:  0.75,
    duration: 0.05,
    stagger:  { from: 'random', amount: 0.20 },
  }, '-=0.08');

  // Voxels scatter outward from center
  tl.to(voxels, {
    opacity:  0,
    scale:    0,
    duration: 0.18,
    stagger:  { from: 'center', amount: 0.15 },
    ease:     'power2.in',
  });

  tl.to(blockEl, { opacity: 0, duration: 0.10 });

  return tl;
}

// ─────────────────────────────────────────────────────────────────────────────
// WARNING POPUP ANIMATIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * WarningPopup entrance — backdrop fades in, card surfaces from below.
 * The interrupt feel: decisive, not gentle. Fast backdrop, firm card.
 * @param {Element} backdropEl - The full-overlay backdrop element
 * @param {Element} cardEl     - The centered warning card element
 */
export function animateWarningIn(backdropEl, cardEl) {
  const tl = gsap.timeline();
  tl.fromTo(backdropEl,
    { opacity: 0 },
    { opacity: 1, duration: 0.16, ease: 'power2.out' }
  )
  .fromTo(cardEl,
    { opacity: 0, scale: 0.91, y: 14 },
    { opacity: 1, scale: 1, y: 0, duration: 0.26, ease: 'panel-out', clearProps: 'transform,opacity' },
    '-=0.08'
  );
  return tl;
}

/**
 * WarningPopup exit — card snaps up and fades, backdrop dissolves behind it.
 * Calls onComplete when fully gone (state can then be cleared).
 * @param {Element}  backdropEl - The full-overlay backdrop element
 * @param {Element}  cardEl     - The centered warning card element
 * @param {Function} onComplete - Called after animation finishes
 */
export function animateWarningOut(backdropEl, cardEl, onComplete) {
  const tl = gsap.timeline({ onComplete });
  tl.to(cardEl, {
    opacity:  0,
    scale:    0.93,
    y:        -10,
    duration: 0.16,
    ease:     'power2.in',
  })
  .to(backdropEl, {
    opacity:  0,
    duration: 0.14,
    ease:     'power2.in',
  }, '-=0.06');
  return tl;
}

// gsap, Flip, useGSAP, EASES are exported below since they are imports, not declarations
export { gsap, Flip, useGSAP, EASES };
