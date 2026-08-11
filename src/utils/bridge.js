/**
 * bridge.js
 * ─────────────────────────────────────────────────────────────
 * The single, environment-aware proxy for the Electron preload API.
 *
 * Every React component / hook that needs a desktop capability imports
 * from HERE — never from `window.electronAPI`. This module picks the
 * right implementation once at load time:
 *
 *   • Electron  → re-exports the real `window.electronAPI` injected
 *                 by electron/preload.js (zero overhead, identity).
 *   • Web       → returns a browser-native implementation where one
 *                 exists, and a Promise-resolving mock otherwise. All
 *                 methods still return the `{ ok, ... }` shape callers
 *                 expect so any existing `if (!res?.ok)` branch works.
 *
 * **FULL PARITY MODE (Task 11 revised):** the web implementation is no
 * longer a "graceful degradation" stub. Where the browser CAN do the
 * work natively, it does — so Web users get:
 *   - Real local Tesseract.js OCR via WASM (CDN-loaded worker/core/lang).
 *   - Real Google Drive + Dropbox OAuth via Implicit Grant (no server).
 *   - Real cloud uploads via plain fetch (no Node IPC).
 *   - Real Blob-download file saving.
 * Where the browser fundamentally CANNOT do the work (native file dialogs,
 * OS window controls), we either don't render the UI at all (TitleBar) or
 * fall through to the browser-native substitute (file input picker).
 * ─────────────────────────────────────────────────────────────
 */
import { isElectron } from './env';
import { webStatus, webConnect, webDisconnect, webUpload } from './webAuth';

/** Canonical message surfaced to web users for desktop-only features. */
export const WEB_FALLBACK_MESSAGE = 'This feature is only available in the SubScribe AI Desktop version.';

/**
 * Helper: build a rejected-capability promise for a given feature label.
 * Returning `ok:false` lets callers log uniformly via their `addLog` hook.
 */
const desktopOnly = (feature) =>
  Promise.resolve({
    ok: false,
    error: `${feature} is only available in the SubScribe AI Desktop version.`,
  });

/**
 * Trigger a browser Blob download. Used by the web implementation of
 * bridge.fs.writeFile when a caller hands us a path + contents.
 */
function triggerBlobDownload(contents, filename, mimeType = 'application/octet-stream') {
  const blob = contents instanceof Blob
    ? contents
    : new Blob([contents], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return filename;
}

// ─────────────────────────────────────────────────────────────────
// WEB implementation — real browser-native functionality where possible.
// ─────────────────────────────────────────────────────────────────

const webBridge = {
  // ─── Window controls (TitleBar hides these in Web Mode, so the
  //     methods exist as no-op safety nets but nothing calls them) ───
  window: {
    minimize: () => undefined,
    maximize: () => undefined,
    close: () => undefined,
    isMaximized: () => Promise.resolve(false),
    onMaximizeChange: () => () => {}, // returns an unsubscribe no-op
  },

  // ─── File system ───
  // These are not used by today's UI flows in web mode:
  //   • SubtitleProcessor.handleBrowse has its own direct
  //     `<input type=file>` fallback and never calls bridge.fs.showOpenDialog.
  //   • ImageOCR.handleExport has its own Blob-download fallback and the
  //     bridge call is gated behind `isElectron()`.
  // They remain as Promise-returning stubs so unexpected callers fail
  // predictably rather than throwing.
  fs: {
    readFileText: () => desktopOnly('Reading files by path'),
    readFileDataURL: () => desktopOnly('Reading files by path'),
    showOpenDialog: () => Promise.resolve({ ok: false, paths: [] }),
    showSaveDialog: () => Promise.resolve({ ok: false, path: '' }),

    // Real web implementation — genuinely useful if anyone ever relaxes
    // the isElectron() gate on ImageOCR's handleExport: the user picks
    // the filename via the download dialog and we hand the bytes to the
    // browser's download manager. Returns the shape callers expect.
    writeFile: (filePath, contents) => {
      try {
        const fileName = (filePath || 'output.txt').split(/[\\/]/).pop();
        triggerBlobDownload(contents, fileName);
        return Promise.resolve({ ok: true, fileName });
      } catch (err) {
        return Promise.resolve({ ok: false, error: err?.message || 'Download failed.' });
      }
    },
  },

  // ─── Environment info ───
  app: {
    getPlatform: () => Promise.resolve('web'),
    getVersion: () => Promise.resolve('1.0.0-web'),
    // Opens http(s) links the way a browser already does. Returns ok:true
    // so the Settings external-link handler doesn't double-open a tab.
    openExternal: (url) => {
      try {
        if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
          window.open(url, '_blank', 'noopener,noreferrer');
        }
        return Promise.resolve({ ok: true });
      } catch (err) {
        return Promise.resolve({ ok: false, error: err?.message || 'Failed to open link.' });
      }
    },
  },

  // ─── OCR ───
  // REAL implementation: run tesseract.js in the browser via WASM.
  // Lazy-imported so we don't pay the WASM cost until OCR is actually used.
  //
  // IMPORTANT: this does NOT call `ocrEngine.extractLocal`. That function's
  // web path is what creates the worker; routing back through it would
  // (because `isElectron()` is false here, this webBridge's own `ocr.run`
  // exists) loop `extractLocal → webBridge.ocr.run → extractLocal → …`
  // forever. This cascade is the frozen-tab crash the user reported on the
  // VPS/Coolify (static web) deploy. Instead we create the WASM worker
  // right here — the true browser-native equivalent of the desktop's
  // main-process OCR IPC handler.
  ocr: {
    run: async ({ dataUrl, lang = 'eng', onProgress } = {}) => {
      let worker = null;
      try {
        const { default: Tesseract } = await import('tesseract.js');
        worker = await Tesseract.createWorker(lang, 1, {
          // Pin to the installed version so CDN URLs never drift.
          workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@7/dist/worker.min.js',
          corePath:   'https://cdn.jsdelivr.net/npm/tesseract.js-core@7/tesseract-core.wasm.js',
          langPath:   'https://tessdata.projectnaptha.com/4.0.0',
          logger: (m) => {
            if (m.status === 'recognizing text' && typeof onProgress === 'function') {
              onProgress(typeof m.progress === 'number' ? m.progress : 0);
            }
          },
        });
        const { data } = await worker.recognize(dataUrl);
        return { ok: true, text: (data?.text || '').trim() };
      } catch (err) {
        return { ok: false, text: '', error: err?.message || String(err) };
      } finally {
        if (worker) {
          try { await worker.terminate(); } catch { /* ignore */ }
        }
      }
    },
    // Tesseract.js v7's createWorker doesn't expose an AbortSignal at the
    // worker level; the extractor already handles cancellation by dropping
    // its pending promise. This is a no-op that's safe to call.
    cancel: () => Promise.resolve({ ok: true }),
  },

  // ─── Cloud storage — REAL browser-native OAuth + fetch uploads ───
  // webStatus / webConnect / webDisconnect / webUpload import from
  // `src/utils/webAuth.js`, which implements Implicit Grant OAuth,
  // localStorage token storage, and plain-fetch uploads for both
  // Google Drive (multipart/related) and Dropbox (content-upload).
  cloud: {
    status: (provider) => webStatus(provider),
    connect: (provider) => webConnect(provider),
    disconnect: (provider) => webDisconnect(provider),
    upload: ({ provider, fileName, buffer, mimeType, onProgress }) =>
      webUpload({ provider, fileName, buffer, mimeType, onProgress }),
    isEncryptionAvailable: () => Promise.resolve({ ok: true, available: false }),
  },
};

// ─────────────────────────────────────────────────────────────────
// Select once at module load. This object is what every importer gets
// as `bridge`; in Electron it IS window.electronAPI (same reference),
// in Web it's the implementation above.
// ─────────────────────────────────────────────────────────────────

const bridge = isElectron()
  ? window.electronAPI
  : webBridge;

export default bridge;
