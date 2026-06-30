/**
 * ocrWorker.js  (runs in the Electron MAIN process)
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *   In the renderer, `tesseract.js` is loaded via a dynamic import() that
 *   Vite rewrites with `import.meta.url`. Under the file:// protocol inside
 *   a packaged ASAR archive, that URL cannot resolve the Tesseract worker
 *   script or the WASM core, so createWorker() hangs forever and the app
 *   shows a permanent black screen.
 *
 *   By moving OCR into the main process we get real Node `fs` access and
 *   can hand Tesseract absolute, on-disk paths (the tesseract.js-core files
 *   are asarUnpacked to app.asar.unpacked). Workers and WASM then spawn
 *   correctly. The renderer just sends a data URL and receives text.
 *
 * EXPOSED
 *   runOcr({ dataUrl, lang, onProgress })  →  { ok, text, error? }
 *   cancelOcr()                            →  void   (terminates active worker)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const path = require('path');

// Lazily required so the main process doesn't pay the cost until OCR is used.
let _Tesseract = null;
function getTesseract() {
  if (!_Tesseract) _Tesseract = require('tesseract.js');
  return _Tesseract;
}

let _activeWorker = null;

/**
 * Run Tesseract OCR on a single image.
 *
 * Path resolution note:
 *   We intentionally do NOT pass `workerPath` / `corePath` / `langPath`.
 *   Inside the Electron MAIN process, tesseract.js resolves its worker
 *   script and WASM core via Node's __dirname-relative logic against the
 *   (asarUnpacked) tesseract.js-core package on disk. That resolution is
 *   correct here — unlike in the renderer, where import.meta.url under
 *   file:// + asar breaks it. Passing explicit paths would couple us to
 *   the exact core version's on-disk layout (which differs across v5/v6/v7),
 *   so we let Tesseract use its own defaults, which already work in Node.
 *
 * @param {object} opts
 * @param {string} opts.dataUrl    "data:image/...;base64,..."
 * @param {string} [opts.lang='eng']
 * @param {(p:number)=>void} [opts.onProgress]  0..1
 * @returns {Promise<{ok:boolean,text:string,error?:string}>}
 */
async function runOcr({ dataUrl, lang = 'eng', onProgress } = {}) {
  if (!dataUrl) return { ok: false, text: '', error: 'No image data provided.' };

  let worker = null;
  try {
    const Tesseract = getTesseract();

    worker = _activeWorker = await Tesseract.createWorker(lang, 1, {
      logger: (m) => {
        if (m.status === 'recognizing text' && typeof onProgress === 'function') {
          onProgress(typeof m.progress === 'number' ? m.progress : 0);
        }
      },
    });

    const { data } = await worker.recognize(dataUrl);
    const text = (data?.text || '').trim();
    return { ok: true, text };
  } catch (err) {
    const msg = err?.name === 'AbortError' ? 'Cancelled.' : (err?.message || String(err));
    return { ok: false, text: '', error: msg };
  } finally {
    if (worker) {
      try { await worker.terminate(); } catch { /* ignore */ }
    }
    if (_activeWorker === worker) _activeWorker = null;
  }
}

/** Terminate any currently-running OCR worker (used for cancellation). */
async function cancelOcr() {
  if (_activeWorker) {
    try { await _activeWorker.terminate(); } catch { /* ignore */ }
    _activeWorker = null;
  }
}

module.exports = { runOcr, cancelOcr };
