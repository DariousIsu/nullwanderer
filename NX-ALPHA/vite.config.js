import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// ─────────────────────────────────────────────────────────────────────────────
// VITE — Renderer process config
// ─────────────────────────────────────────────────────────────────────────────
//
// This config is for the Vite dev server and production renderer bundle.
// The Electron main process lives in /electron/ and is NOT bundled by Vite.
//
// Dev:  `npm run dev` → Vite serves on :5173, Electron loads http://localhost:5173
// Prod: `npm run build` → outputs to dist/renderer/, Electron loads index.html
//

export default defineConfig({
  plugins: [
    react({
      // Enable Fast Refresh (already default, explicit for clarity)
      fastRefresh: true,
    }),
  ],

  root: '.',
  base: './',  // Relative base — required for Electron file:// loading in production

  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
    rollupOptions: {
      // Keep vendor chunks separate for better caching
      output: {
        manualChunks: {
          react:    ['react', 'react-dom'],
          gsap:     ['gsap'],
          recharts: ['recharts'],
          three:    ['three'],
          hls:      ['hls.js'],
          maplibre: ['maplibre-gl', 'react-map-gl/maplibre'],
        },
      },
    },
    // Target modern Chromium — Electron ships its own version
    target: 'chrome120',
  },

  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },

  server: {
    port: 5173,
    strictPort: true,  // Fail fast if :5173 is taken rather than auto-incrementing
  },

  css: {
    modules: {
      // .module.css: both camelCase and kebab-case class names work
      localsConvention: 'camelCaseOnly',
    },
  },

  // Expose env vars prefixed with VITE_ to renderer (standard Vite behaviour)
  // VITE_STREAM_URL — backend SSE endpoint, used in browser-only dev fallback
  envPrefix: 'VITE_',
});
