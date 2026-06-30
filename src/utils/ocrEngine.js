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
 * ─────────────────────────────────────────────────────────────
 */

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

  // ─── Electron path: delegate to the main process ───
  const api = typeof window !== 'undefined' && window.electronAPI;
  if (api?.ocr?.run) {
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

  // ─── Browser fallback: direct dynamic import (dev/preview only) ───
  let worker = null;
  try {
    const { default: Tesseract } = await import('tesseract.js');

    worker = await Tesseract.createWorker(lang, 1, {
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
 * Map a human-readable language label (from the SubtitleProcessor dropdown)
 * to a Tesseract language code. Falls back to 'eng'.
 */
export function toTesseractLang(languageLabel) {
  if (!languageLabel) return 'eng';
  const lower = languageLabel.toLowerCase();
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
