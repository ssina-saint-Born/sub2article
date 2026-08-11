/**
 * env.js
 * ─────────────────────────────────────────────────────────────
 * Runtime environment detection for SubScribe AI.
 *
 * The app ships as two products from one source tree:
 *   • Desktop  — Electron + preload injects `window.electronAPI`
 *                (Node/fs/OCR/cloud live in the main process).
 *   • Web      — the same React/React frontend compiled by Vite and
 *                served as static `dist/` by Nginx/Traefik/Coolify.
 *                No Node, no preload, no `window.electronAPI`. Browser-
 *                native implementations (WASM Tesseract, Implicit Grant
 *                OAuth, Blob downloads) stand in for the desktop APIs.
 *
 * Components ask `isElectron()` once and then go through `bridge.js`,
 * which returns the real preload API in Electron and browser-native
 * implementations (WASM Tesseract for OCR, Implicit Grant OAuth for
 * cloud, Blob downloads for file saves) for the web build.

 * The detection is defensive: every guard must hold before we claim
 * Electron mode, so a browser with a stubbed global (or an automated
 * test runner) can't fool us into calling a non-existent IPC channel.
 * ─────────────────────────────────────────────────────────────
 */

/**
 * True only when running inside the Electron desktop container.
 *
 * Three conditions must ALL hold:
 *   1. A `window` exists (we're in a JS DOM runtime, not Node CLI).
 *   2. `window.electronAPI` was injected by preload.js — without it,
 *      none of the channels exist regardless of the UA.
 *   3. The user-agent advertises Electron. A plain Chrome/Firefox UA
 *      means a real browser tab, even if a test harness stubbed the
 *      global. The UA check is the discriminator.
 *
 * @returns {boolean}
 */
export function isElectron() {
  if (typeof window === 'undefined') return false;
  if (typeof window.electronAPI === 'undefined' || window.electronAPI === null) {
    return false;
  }
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  return ua.includes('Electron');
}

/**
 * Stable, memoized mode label. Evaluated once at module load so every
 * importer sees the same value for the lifetime of the page — `isElectron()`
 * can't flip during a session (the preload either ran or it didn't).
 *
 * @returns {'electron' | 'web'}
 */
const MODE = isElectron() ? 'electron' : 'web';

export function getMode() {
  return MODE;
}

/** Convenience booleans for component conditionals. */
export const isDesktop = MODE === 'electron';
export const isWeb = MODE === 'web';

export default { isElectron, getMode, isDesktop, isWeb };
