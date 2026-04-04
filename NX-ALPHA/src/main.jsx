/**
 * AURA NX-Alpha — Renderer Entry Point
 *
 * Vite renderer entry. Mounts the React tree into #root.
 *
 * Design tokens (CSS custom properties) are imported here so they are
 * loaded once, globally, before any component renders. This prevents
 * a flash of unstyled content and ensures all var(--…) references
 * resolve correctly on first paint.
 *
 * StrictMode is enabled in development (Vite's `import.meta.env.DEV`
 * is already handled by React — StrictMode is stripped in production
 * React builds automatically).
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

// Global design tokens — must be the first style import.
// All components use var(--token-name) references defined here.
import '../design-tokens.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
