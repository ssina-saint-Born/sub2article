/**
 * ocrEngine.js
 * ─────────────────────────────────────────────────────────────
 * Dual-mode OCR engine for SubScribe AI.
 *
 *   - extractLocal()  : runs Tesseract.js. In Electron this delegates to
 *                       the MAIN process via IPC, because the renderer-side
 *                       dynamic import('tesseract.js') breaks worker/WASM
 *                       resolution under file:// + asar and black-screens
 *                       the app. In a plain browser it falls back to a
 *                       direct dynamic import.
 *   - extractCloud()  : sends the image as a base64 data URL to an
 *                       OpenAI-compatible vision model. High precision,
 *                       works on handwriting & complex layouts.
 *
 * Both functions accept a data URL and return clean extracted text.
 *
 * Environment: `extractLocal()` reaches the main-process OCR worker via
 * `bridge.ocr.run` (the environment-aware proxy in src/utils/bridge.js).
 * In the Electron build `bridge` IS `window.electronAPI`; in the web
 * build it's the browser-native tesseract.js WASM worker with explicit
 * CDN paths for the worker script/core/language packs. Cloud OCR
 * (`extractCloud`) is pure fetch and works in both modes.
 * ─────────────────────────────────────────────────────────────
 */
import bridge from './bridge';
import { isElectron } from './env';

/**
 * Run Tesseract.js OCR on a single image.
 *
 * In Electron this calls the main-process OCR worker over IPC (so the heavy
 * tesseract.js dependency — and its worker/WASM core — never enters the
 * renderer bundle, which is what previously caused the production black
 * screen). In a non-Electron browser it falls back to a direct import.
 *
 * @param {string} dataUrl   - Image as a "data:image/...;base64,..." URL
 * @param {object} [options]
 * @param {string} [options.lang='eng']   - Tesseract language code (e.g. 'eng', 'fas', 'ara')
 * @param {function} [options.onProgress] - Called with a 0..1 progress value
 * @param {AbortSignal} [options.signal]  - For cancellation
 * @returns {Promise<{ok: boolean, text: string, error?: string}>}
 */
export async function extractLocal(dataUrl, options = {}) {
  const { lang = 'eng', onProgress, signal } = options;

  // ─── Desktop path: delegate to the main process via the bridge ───
  // CRITICAL (web build): this guard MUST be Electron-only. In the web
  // build `bridge.ocr.run` is the *browser* implementation (webBridge),
  // whose job is to hand the work BACK to load tesseract.js WASM (see the
  // "Browser fallback" below). If we let the web webBridge enter this
  // branch, `extractLocal` → webBridge.ocr.run → `extractLocal` → ...
  // recurses forever and freezes the tab (the exact "website crashes and
  // stays frozen" symptom). In Electron the real preload API is present so
  // we DO delegate to the main-process worker here.
  const api = isElectron() ? bridge : null;
  if (api && typeof api.ocr?.run === 'function') {
    // Honor a pre-aborted signal immediately.
    if (signal?.aborted) return { ok: false, text: '', error: 'Cancelled.' };

    // Forward aborts to the main-process worker terminator.
    const onAbort = () => { api.ocr.cancel?.(); };
    signal?.addEventListener?.('abort', onAbort, { once: true });

    try {
      return await api.ocr.run({
        dataUrl,
        lang,
        onProgress: (p) => typeof onProgress === 'function' && onProgress(p),
      });
    } catch (err) {
      const msg = err?.name === 'AbortError' ? 'Cancelled.' : err.message;
      return { ok: false, text: '', error: msg };
    } finally {
      signal?.removeEventListener?.('abort', onAbort);
    }
  }

  // ─── Browser fallback: direct dynamic import (Web build path) ──────────────
  // In Electron, the renderer-side `await import('tesseract.js')` hangs under
  // file:// + asar because Vite rewrites it with `import.meta.url`. In the WEB
  // build we're over plain http(s), so tesseract.js CAN load its worker and
  // WASM — but not by `import.meta.url` (Vite bundles it as a chunk whose
  // URL never matches another file). We hand-create the worker with explicit
  // CDN URLs for the worker script, the WASM core, and the tessdata language
  // packs (language codes like 'eng', 'fas', or 'eng+fas' pull from langPath).
  //
  // vite.config.mjs keeps `optimizeDeps.exclude` in place (so Vite dev doesn't
  // pre-bundle it), but removes `rollupOptions.external` in web builds so the
  // lazy dynamic import emits a real chunk shipped to dist/assets/.
  let worker = null;
  try {
    const { default: Tesseract } = await import('tesseract.js');

    const isWeb = !isElectron();
    worker = await Tesseract.createWorker(lang, 1, {
      ...(isWeb && {
        // Pin to the installed version so the CDN URLs never drift.
        workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@7/dist/worker.min.js',
        corePath:   'https://cdn.jsdelivr.net/npm/tesseract.js-core@7/tesseract-core.wasm.js',
        langPath:   'https://tessdata.projectnaptha.com/4.0.0',
        // Language packs are downloaded per-code ('eng', 'fas', ...). gzip
        // encoding is handled automatically by the fetch of .traineddata.gz.
      }),
      logger: (m) => {
        if (m.status === 'recognizing text' && onProgress) {
          onProgress(typeof m.progress === 'number' ? m.progress : 0);
        }
      },
    });

    if (signal?.aborted) {
      await worker.terminate();
      return { ok: false, text: '', error: 'Cancelled.' };
    }

    const { data } = await worker.recognize(dataUrl);
    const text = (data?.text || '').trim();

    return { ok: true, text };
  } catch (err) {
    const msg = err?.name === 'AbortError' ? 'Cancelled.' : err.message;
    return { ok: false, text: '', error: msg };
  } finally {
    if (worker) {
      try { await worker.terminate(); } catch { /* ignore */ }
    }
  }
}

/**
 * Send an image to an OpenAI-compatible vision model for transcription.
 *
 * Uses the standard vision payload format:
 *   { role: 'user', content: [ { type: 'text', text }, { type: 'image_url',
 *     image_url: { url: 'data:image/png;base64,...' } } ] }
 *
 * @param {string} dataUrl  - Image as a data URL
 * @param {object} apiConfig
 * @param {string} apiConfig.baseUrl   - e.g. "https://api.openai.com/v1"
 * @param {string} apiConfig.apiKey    - Bearer token
 * @param {string} apiConfig.model     - Vision-capable model (gpt-4o, etc.)
 * @param {AbortSignal} [apiConfig.signal]
 * @returns {Promise<{ok: boolean, text: string, error?: string}>}
 */
export async function extractCloud(dataUrl, apiConfig = {}) {
  const { baseUrl, apiKey, model, signal } = apiConfig;

  if (!baseUrl || !apiKey) {
    return { ok: false, text: '', error: 'API Key or Base URL is missing.' };
  }

  let url = baseUrl.replace(/\/+$/, '');
  if (!url.endsWith('/chat/completions')) {
    url += '/chat/completions';
  }

  const systemPrompt =
    'You are a precise OCR engine. Transcribe ALL text visible in the provided image exactly as written. ' +
    'Preserve line breaks, paragraphs, and the original language. ' +
    'Do NOT add commentary, explanations, formatting instructions, or any text that is not present in the image. ' +
    'Output ONLY the transcribed text, nothing else.';

  const body = {
    model,
    max_tokens: 4096,
    temperature: 0,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Transcribe all text from this image exactly. Output only the text.' },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
  };

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    const msg = err?.name === 'AbortError' ? 'Cancelled.' : `Network error: ${err.message}`;
    return { ok: false, text: '', error: msg };
  }

  if (!response.ok) {
    let errorMsg = `HTTP ${response.status}`;
    try {
      const errBody = await response.json();
      errorMsg += ` — ${errBody?.error?.message || errBody?.message || JSON.stringify(errBody)}`;
    } catch { /* ignore */ }
    return { ok: false, text: '', error: errorMsg };
  }

  try {
    const data = await response.json();
    const text = (data.choices?.[0]?.message?.content || '').trim();
    return { ok: true, text };
  } catch (err) {
    return { ok: false, text: '', error: `Failed to parse response: ${err.message}` };
  }
}

/**
 * Convert a browser File object to a data URL string.
 * @param {File} file
 * @returns {Promise<string>}
 */
export function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Failed to read file.'));
    reader.readAsDataURL(file);
  });
}

/**
 * Map a human-readable language label (from the OCR language dropdowns) to a
 * Tesseract language code. Falls back to 'eng'. The combined "English + Persian"
 * label maps to the real multi-lang string 'eng+fas' that Tesseract.js accepts.
 */
export function toTesseractLang(languageLabel) {
  if (!languageLabel) return 'eng';
  const lower = languageLabel.toLowerCase();
  if (lower.includes('english + persian') ||
      (lower.includes('english') && lower.includes('persian'))) {
    return 'eng+fas';
  }
  if (lower.includes('persian') || lower.includes('فارسی')) return 'fas';
  if (lower.includes('english')) return 'eng';
  if (lower.includes('spanish') || lower.includes('español')) return 'spa';
  if (lower.includes('french') || lower.includes('français')) return 'fra';
  if (lower.includes('german') || lower.includes('deutsch')) return 'deu';
  if (lower.includes('arabic') || lower.includes('العربية')) return 'ara';
  if (lower.includes('chinese') || lower.includes('中文')) return 'chi_sim';
  if (lower.includes('japanese') || lower.includes('日本語')) return 'jpn';
  if (lower.includes('korean') || lower.includes('한국어')) return 'kor';
  if (lower.includes('turkish') || lower.includes('türkçe')) return 'tur';
  if (lower.includes('hindi') || lower.includes('हिन्दी')) return 'hin';
  if (lower.includes('portuguese') || lower.includes('português')) return 'por';
  return 'eng';
}

/**
 * The OCR language choices shared by every dropdown in the app (ImageOCR,
 * BookProcessor). `lang` is the raw string handed to Tesseract.createWorker.
 * 'eng+fas' is the multi-language sum — Tesseract.js natively stitches both
 * packs and dispatches per-glyph recognition.
 */
export const OCR_LANGS = [
  { value: 'English',                    label: 'English',                    lang: 'eng'       },
  { value: 'Persian (فارسی)',            label: 'Persian (فارسی)',            lang: 'fas'       },
  { value: 'English + Persian (فارسی)',  label: 'English + Persian (فارسی)',  lang: 'eng+fas'   },
  { value: 'Spanish (Español)',          label: 'Spanish (Español)',          lang: 'spa'       },
  { value: 'French (Français)',          label: 'French (Français)',          lang: 'fra'       },
  { value: 'German (Deutsch)',           label: 'German (Deutsch)',           lang: 'deu'       },
  { value: 'Arabic (العربية)',           label: 'Arabic (العربية)',           lang: 'ara'       },
  { value: 'Chinese (中文)',             label: 'Chinese (中文)',             lang: 'chi_sim'   },
  { value: 'Japanese (日本語)',          label: 'Japanese (日本語)',          lang: 'jpn'       },
  { value: 'Korean (한국어)',            label: 'Korean (한국어)',            lang: 'kor'       },
  { value: 'Turkish (Türkçe)',           label: 'Turkish (Türkçe)',           lang: 'tur'       },
  { value: 'Hindi (हिन्दी)',             label: 'Hindi (हिन्दी)',             lang: 'hin'       },
  { value: 'Portuguese (Português)',     label: 'Portuguese (Português)',     lang: 'por'       },
];
