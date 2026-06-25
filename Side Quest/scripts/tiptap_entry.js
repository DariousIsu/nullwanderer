/* scripts/tiptap_entry.js — esbuild ENTRY for the Creator's editor bundle.
 *
 * This is the one ESM source file esbuild follows to produce renderer/vendor/tiptap.bundle.js
 * (an IIFE that hangs `window.ZoeEditor`). The renderer loads that vendored file with a plain
 * <script src> — identical idiom to renderer/vendor/force-graph.min.js. We generate it instead
 * of downloading it because Tiptap ships as many cross-importing ESM packages with no UMD build.
 *
 * Keep the surface SMALL and explicit: only the extensions the Creator actually uses. Re-run
 * `npm run build:editor` whenever this set changes. The block model the Creator round-trips
 * (heading / paragraph / list_item / code) is fully covered by StarterKit.
 */
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
// ProseMirror primitives for the clinical-assist layer: inline decorations (the spelling/grammar
// squiggles + source/fact-check marks) ride a plugin keyed by PluginKey; the renderer rebuilds the
// DecorationSet from the scan's findings without mutating the document.
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

// Single global the renderer consumes. Namespaced so it can grow (table, changeset) without
// colliding with anything else on window.
window.ZoeEditor = { Editor, StarterKit, Plugin, PluginKey, Decoration, DecorationSet };
