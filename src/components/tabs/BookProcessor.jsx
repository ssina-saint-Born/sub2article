import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useLog } from '../../contexts/LogContext';
import { useBook } from '../../contexts/BookContext';
import { useSettings } from '../../hooks/useSettings';
import { useCloudStorage } from '../../hooks/useCloudStorage';
import { uploadTextToCloud } from '../../utils/cloudUpload';
import {
  extractLocal,
  extractCloud,
  fileToDataUrl,
  toTesseractLang,
} from '../../utils/ocrEngine';
import {
  putImage,
  getImage,
  deleteImage,
  clearAllImages,
} from '../../utils/imageStore';
import { exportToDocx, exportToPdf } from '../../utils/exportUtils';
import { callLLM } from '../../utils/apiClient';
import { getDatasetPrompt } from '../../utils/prompts';
import { LangSelect } from './ImageOCR.jsx';

const VALID_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp'];
const MIME_PREFIX = 'image/';

function getExt(name) {
  return name.split('.').pop().toLowerCase();
}

/**
 * Strip any accidental markdown code fences and leading/trailing prose the
 * model may add despite the "raw JSON only" instruction, then isolate the
 * outermost JSON array/object so the result is parseable.
 *
 * Not exported — BookProcessor-only helper.
 */
function sanitizeDatasetJSON(raw) {
  let s = (raw || '').trim();
  // Remove ```json …``` / ```… ``` fences anywhere they appear.
  s = s.replace(/```/g, '');
  // Trim away any prose before the first '[' or '{', and after the last
  // matching ']' or '}'.
  const start = s.search(/[[{]/);
  const end = Math.max(s.lastIndexOf(']'), s.lastIndexOf('}'));
  if (start !== -1 && end !== -1 && end > start) {
    s = s.slice(start, end + 1);
  }
  return s.trim();
}

/**
 * Trigger a browser download of `content` as the given file.
 * Uses a temporary <a> tag + object URL, revoked shortly after.
 */
function downloadBlob(content, mimeType, filename) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * BookProcessor — "Book to Digital" (تبدیل کتاب به دیجیتال)
 *
 * Phase 1, Task 3: Text Accumulation (انباشتگی متن).
 * Real OCR is now wired in. Pages dropped or selected are immediately
 * processed by the shared ocrEngine (local Tesseract or Cloud AI),
 * and each page's extracted text is appended — never overwritten — to
 * the accumulated book text, separated by a blank line.
 *
 * All long-lived state (pages, accumulatedText, isProcessing) lives in
 * BookContext so it survives tab switches. This component only owns
 * ephemeral UI state (drag flag, current-OCR index, OCR mode selector).
 *
 * NOTE: This component does NOT touch SubtitleProcessor, ImageOCR,
 * Settings, or LogContext logic.
 */
export default function BookProcessor() {
  const { addLog } = useLog();
  const { settings } = useSettings();
  // Cloud storage state for the "Upload to Cloud" section of the export
  // modal. Refreshing here (rather than only in Settings) guarantees the
  // buttons reflect real connection state even if the user changed it in
  // another tab or restarted the app since Settings last ran.
  const cloud = useCloudStorage();
  const {
    pages,
    setPages,
    accumulatedText,
    appendText,
    isProcessing,
    setIsProcessing,
    clearAll,
    updatePageStatus,
  } = useBook();

  // ─── Local UI-only state ───
  const [dragActive, setDragActive] = useState(false);
  const [ocrMode, setOcrMode] = useState('local');       // 'local' | 'cloud'
  const [ocrLanguage, setOcrLanguage] = useState('English');
  const [currentIdx, setCurrentIdx] = useState(-1);
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [exporting, setExporting] = useState(null);      // 'docx' | 'pdf' | null
  // Which cloud provider is currently uploading, or null.
  const [cloudUploading, setCloudUploading] = useState(null); // 'googleDrive' | 'dropbox' | null
  // Which dataset type is currently being generated, or null.
  // 'instruction' | 'causal' | 'chat' | null — drives the per-card spinner.
  const [isGeneratingDataset, setIsGeneratingDataset] = useState(null);

  const abortRef = useRef(null);            // OCR abort (owned by processQueue)
  const datasetAbortRef = useRef(null);     // Dataset-generation abort (owned by handleGenerateDataset)
  const fileInputRef = useRef(null);

  // ─── Announce view entry once on mount ───
  useEffect(() => {
    addLog('info', 'Book to Digital module loaded. Ready for configuration.');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Cleanup any in-flight OCR on unmount (tab switch safety) ───
  useEffect(() => {
    return () => {
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
      }
    };
  }, []);

  // ─── Derived stats (memoized so long books stay cheap) ───
  const stats = useMemo(() => {
    const words = (accumulatedText.match(/\S+/g) || []).length;
    const done = pages.filter(p => p.status === 'done').length;
    return {
      pages: pages.length,
      processed: done,
      words,
      chars: accumulatedText.length,
    };
  }, [pages, accumulatedText]);

  // ────────────────────────────────────────────────────────────────────
  // OCR queue processor.
  // Accepts the freshly-created page entries directly (NOT re-read from
  // context state). Re-reading `pages` from the closure was a stale-closure
  // trap: by the time this runs, the `setPages` calls in `addFiles` may
  // not have committed yet, so the queue reads empty and the function
  // silently returns — no OCR runs and no error surfaces.
  // ────────────────────────────────────────────────────────────────────
  const processQueue = useCallback(async (incoming, payloads) => {
    const queue = Array.isArray(incoming) ? incoming : [];
    if (queue.length === 0) return;

    // Cloud mode needs credentials before we start iterating
    if (ocrMode === 'cloud' && (!settings.apiKey || !settings.providerUrl)) {
      addLog('error', 'API Key or Base URL is missing. Please check your Settings.');
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setIsProcessing(true);

    const modeLabel = ocrMode === 'local' ? 'Local Mode' : 'Cloud AI Mode';
    addLog('info', `Starting book page OCR (${modeLabel}) on ${queue.length} page(s)…`);

    let successCount = 0;
    let failCount = 0;

    try {
      for (let i = 0; i < queue.length; i++) {
        if (controller.signal.aborted) break;

        const page = queue[i];
        updatePageStatus(page.id, 'processing');
        setCurrentIdx(i);
        addLog('info', `Extracting text from page "${page.name}" (${i + 1}/${queue.length}) via ${modeLabel}…`);

        // Resolve the image payload for OCR: prefer the in-flight map (most
        // recent batch), fall back to the imageStore cache. When neither has
        // it (hard refresh / cache eviction), OCR this page is impossible —
        // mark it failed and move on rather than hanging.
        let dataUrl = payloads?.get(page.id) || null;
        if (!dataUrl && page.imageRef) {
          dataUrl = await getImage(page.imageRef);
        }

        let result;
        if (!dataUrl) {
          result = { ok: false, text: '', error: 'Image payload is no longer available in browser memory.' };
        } else if (ocrMode === 'local') {
          result = await extractLocal(dataUrl, {
            lang: toTesseractLang(ocrLanguage),
            signal: controller.signal,
          });
        } else {
          result = await extractCloud(dataUrl, {
            baseUrl: settings.providerUrl,
            apiKey: settings.apiKey,
            model: settings.modelName,
            signal: controller.signal,
          });
        }

        if (result.ok) {
          const wordCount = (result.text.match(/\S+/g) || []).length;
          // Append this page's text onto the existing accumulated text.
          // appendText handles the \n\n separator and never overwrites.
          appendText(`--- Page: ${page.name} ---\n${result.text || '(no text detected)'}`);
          updatePageStatus(page.id, 'done');
          successCount++;
          addLog('success', `Page "${page.name}" done — ${wordCount} words extracted.`);
        } else {
          updatePageStatus(page.id, 'failed');
          failCount++;
          // Append a failure marker so the gap in the book is visible.
          appendText(`--- Page: ${page.name} ---\n[Extraction failed: ${result.error}]`);
          addLog('error', `Page "${page.name}" failed: ${result.error}`);
        }

        // ─── Memory lifecycle: drop THIS page's image the moment OCR is over ───
        // Free the in-memory copy for this page and, when the page was cached
        // in IndexedDB, delete it there too. This is the per-image half of the
        // requested auto-purge; the batch purge lives in handleClearMemory /
        // the copy+export paths below.
        payloads?.delete(page.id);
        if (page.imageRef) {
          deleteImage(page.imageRef);
        }
      }

      if (!controller.signal.aborted && (successCount + failCount) > 0) {
        addLog(
          successCount > 0 ? 'success' : 'warning',
          `Book OCR complete. ${successCount} page(s) extracted, ${failCount} failed.`
        );
      }
    } catch (err) {
      const msg = err?.name === 'AbortError' ? 'Extraction cancelled.' : err.message;
      addLog('error', `Book OCR error: ${msg}`);
    } finally {
      // Always reset loading flags and the abort handle.
      abortRef.current = null;
      setCurrentIdx(-1);
      setIsProcessing(false);
    }
  }, [
    ocrMode,
    ocrLanguage,
    settings,
    appendText,
    addLog,
    updatePageStatus,
    setIsProcessing,
  ]);

  // ─── Add files (drop or click) — build entries, push to context,Then OCR ───
  // We resolve all dataUrls first, flush the entries to context together,
  // and hand the SAME enriched array to processQueue so it can OCR them
  // without re-reading uncommitted state.
  const addFiles = useCallback(async (fileList) => {
    const files = Array.from(fileList);
    const valid = [];
    let invalidCount = 0;

    for (const file of files) {
      const ext = getExt(file.name);
      if (!file.type.startsWith(MIME_PREFIX) && !VALID_EXTENSIONS.includes(ext)) {
        invalidCount++;
        continue;
      }
      valid.push(file);
    }

    if (invalidCount > 0) {
      addLog('error', 'Invalid file type. Please upload images (PNG, JPG, JPEG, WEBP).');
    }
    if (valid.length === 0) return;

    // Build all entries and persist their payloads to the ephemeral
    // imageStore BEFORE touching state or OCR. React state keeps only a
    // lightweight ref (imageRef) — holding multi-MB base64 strings in the point
    // render tree / context is exactly what we want to avoid; the store is
    // purged the instant the page is done being OCR'd.
    const entries = [];
    for (const file of valid) {
      try {
        const dataUrl = await fileToDataUrl(file);
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${entries.length}`;
        const imageRef = `book:${id}`;
        // Best-effort cache (IndexedDB). If it fails (private mode / quota),
        // we fall back herein via the local `payloads` map passed to processQueue.
        await putImage(imageRef, dataUrl);
        entries.push({
          id,
          name: file.name,
          size: formatSize(file.size),
          imageRef,
          // dataUrl kept on the entry ONLY long enough for addFiles to build
          // the local payload map below; we null it before the entry is
          // committed to context so long-lived state doesn't retain it.
          __dataUrl: dataUrl,
          status: 'queued',
        });
      } catch {
        addLog('error', `Failed to read "${file.name}".`);
      }
    }
    if (entries.length === 0) return;

    // Local payload map (id → dataUrl) for the OCR processor. We never rely
    // on re-reading state; this array is the single source of truth for the
    // queue processor.
    const payloads = new Map(entries.map(e => [e.id, e.__dataUrl]));
    const lightEntries = entries.map(({ __dataUrl, ...rest }) => rest);

    // Single batched update: push the LIGHT entries (no dataUrl) into the
    // queue at once. OCR data comes from the `payloads` map / imageStore,
    // not from React state.
    setPages(prev => [...prev, ...lightEntries]);
    addLog('success', `${lightEntries.length} page image(s) added to the book.`);

    // Hand the new entries + their payloads straight to the processor so it
    // can OCR them without depending on a (potentially uncommitted) state read.
    processQueue(lightEntries, payloads);
  }, [addLog, setPages, processQueue]);

  // ─── Drag handlers ───
  const handleDrag = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') setDragActive(true);
    else if (e.type === 'dragleave') setDragActive(false);
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
  }, [addFiles]);

  const handleFileInput = useCallback((e) => {
    if (e.target.files?.length) addFiles(e.target.files);
    e.target.value = '';
  }, [addFiles]);

  const removePage = useCallback((id) => {
    setPages(prev => {
      const target = prev.find(p => p.id === id);
      if (target) {
        addLog('info', `Page "${target.name}" removed from the queue.`);
        // Free the cached image payload for the removed page too.
        if (target.imageRef) deleteImage(target.imageRef);
      }
      return prev.filter(p => p.id !== id);
    });
  }, [setPages, addLog]);

  // ─── Finish Book Processing (پایان پردازش کتاب) ───
  // Opens the Export Options modal. The modal itself drives the actual
  // DOCX/PDF downloads (the AI-Dataset buttons are reserved for Phase 2).
  const handleFinishBook = useCallback(() => {
    if (!accumulatedText) return;
    setExportModalOpen(true);
  }, [accumulatedText]);

  // ─── Export handler — drives the modal's two real download buttons ───
  // Streams accumulatedText through the exportUtils generators and logs
  // a single success/error per attempt so the System Logs are clear.
  const handleExport = useCallback(async (format) => {
    if (!accumulatedText) return;
    setExporting(format);
    try {
      const result = format === 'docx'
        ? await exportToDocx(accumulatedText, { filename: 'subscribe-book-export.docx' })
        : await exportToPdf(accumulatedText, { filename: 'subscribe-book-export.pdf' });
      if (result.ok) {
        addLog('success', `Exported as ${format.toUpperCase()}${result.filename ? ` (${result.filename})` : ''}.`);
        // ─── Memory lifecycle ─── A successful DOCX/PDF download is the
        // canonical "I'm done with these images" signal. Purge the cached
        // page payloads and clear the queue text-stays so the VPS-hosted
        // (browser) session doesn't hold multi-MB dataUrls long after use.
        clearAllImages();
        setPages([]);
      } else {
        addLog('error', `Export failed: ${result.error}`);
      }
    } catch (err) {
      addLog('error', `Export error: ${err?.message || 'unknown error'}`);
    } finally {
      setExporting(null);
    }
  }, [accumulatedText, addLog, setPages]);

  // ─── Generate AI Dataset (Phase 2, Task 6) ───────────────────────
  // Real AI-backed dataset generation. Sends the accumulated book text
  // through callLLM (the same shared OpenAI-compatible client used by
  // SubtitleProcessor and extractCloud) with one of three specialized
  // system prompts, cleans the returned JSON, and downloads it.
  //
  // `type` is one of: 'instruction' | 'causal' | 'chat'
  //
  // Safety: this does NOT touch BookContext accumulator state, the page
  // OCR queue, SubtitleProcessor, or ImageOCR. It uses its OWN abort
  // ref (datasetAbortRef) so cancelling OCR never kills a dataset build
  // and vice-versa.
  const handleGenerateDataset = useCallback(async (type) => {
    const labelMap = {
      instruction: 'Instruction / QA',
      causal: 'Causal LM',
      chat: 'Chat / DPO',
    };
    const label = labelMap[type] || type;

    // ─── Guard: need extracted text to build a dataset ───
    if (!accumulatedText || !accumulatedText.trim()) {
      addLog('warning', 'No book text available. Please extract pages before generating a dataset.');
      return;
    }

    // ─── Guard: need valid API credentials ───
    const { providerUrl, apiKey, modelName } = settings;
    if (!apiKey || !providerUrl) {
      addLog('error', 'API Key or Base URL is missing. Please check your Settings.');
      return;
    }

    // ─── Guard: unknown dataset type ───
    const systemPrompt = getDatasetPrompt(type);
    if (!systemPrompt) {
      addLog('error', `Unknown dataset type "${type}".`);
      return;
    }

    addLog('info', `Generating ${label} dataset with model "${modelName}"…`);
    setIsGeneratingDataset(type);

    const controller = new AbortController();
    datasetAbortRef.current = controller;

    let result;
    try {
      result = await callLLM({
        baseUrl: providerUrl,
        apiKey,
        model: modelName,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Source book text:\n\n---\n${accumulatedText}\n---` },
        ],
        // Non-streaming + low temperature: we want one complete, valid JSON
        // payload, not a token-by-token stream that we'd have to reassemble.
        stream: false,
        maxTokens: 4096,
        temperature: 0.3,
        signal: controller.signal,
      });
    } catch (err) {
      // callLLM catches its own errors, but guard defensively so the
      // spinner never gets stuck on an unexpected throw.
      const msg = err?.name === 'AbortError' ? 'Dataset generation cancelled.' : err.message;
      addLog('error', `Dataset generation error: ${msg}`);
      return;
    } finally {
      datasetAbortRef.current = null;
      setIsGeneratingDataset(null);
    }

    // ─── AI call failed → surface the error and abort ───
    if (!result || !result.ok) {
      addLog('error', `Dataset generation failed: ${result?.error || 'unknown error'}`);
      return;
    }

    // ─── Clean → validate → format → download ───
    const cleaned = sanitizeDatasetJSON(result.text);
    let output;
    let isJSON = false;
    try {
      const parsed = JSON.parse(cleaned);
      // Pretty-print so the downloaded file is human-readable & diff-friendly.
      output = JSON.stringify(parsed, null, 2);
      isJSON = true;
      const itemCount = Array.isArray(parsed) ? parsed.length : 1;
      addLog('success', `${label} dataset ready — ${itemCount} item(s). Downloaded as JSON.`);
    } catch {
      // The model violated the "raw JSON only" contract. Fall back to a
      // .txt file so the user can still inspect what came back; nothing is
      // silently dropped.
      output = cleaned || result.text || '';
      addLog('warning', 'AI returned non-JSON output; saving raw text for inspection as .txt.');
    }

    const ext = isJSON ? '.json' : '.txt';
    const mime = isJSON ? 'application/json' : 'text/plain';
    downloadBlob(output, mime, `dataset-${type}-${Date.now()}${ext}`);
  }, [accumulatedText, settings, addLog]);

  // ─── Upload last-exported text to a connected cloud provider ───
  // Called from the ExportOptionsModal. The upload itself is buffered into a
  // Uint8Array and streamed by `electron/cloud/*` so large datasets are
  // resumable; all progress lands on the System Console via useCloudStorage.
  const handleUploadToCloud = useCallback(async (provider) => {
    if (!accumulatedText || !accumulatedText.trim()) {
      addLog('warning', 'No text available to upload. Extract pages first.');
      return;
    }
    const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const fileName = `subscribe-book-${timestamp}.txt`;
    setCloudUploading(provider);
    try {
      const res = await uploadTextToCloud(cloud, {
        provider,
        fileName,
        data: accumulatedText,
        mimeType: 'text/plain; charset=utf-8',
      });
      if (res?.ok) {
        addLog('success', `Uploaded "${fileName}" to ${provider === 'googleDrive' ? 'Google Drive' : 'Dropbox'}.`);
        // Same lifecycle as copy/export — the text is now safely in the
        // cloud, so release the source page images.
        clearAllImages();
        setPages([]);
      } else {
        addLog('error', `Cloud upload failed: ${res?.error || 'unknown error'}`);
      }
    } catch (err) {
      addLog('error', `Cloud upload error: ${err?.message || 'unknown error'}`);
    } finally {
      setCloudUploading(null);
    }
  }, [accumulatedText, cloud, addLog, setPages]);

  // Refresh cloud-connection state the moment the export modal opens so the
  // provider buttons never show a stale "Not connected" from a prior session.
  useEffect(() => {
    if (exportModalOpen) {
      cloud.refresh().catch(() => { /* offline env — keep current state */ });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exportModalOpen]);

  // ─── Clear Temporary Memory (پاک‌سازی حافظه موقت) ───
  // Wipes accumulated text + page queue via context.
  const handleClearMemory = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setCurrentIdx(-1);
    clearAll();
    // Also drop every cached page image from the imageStore.
    clearAllImages();
    addLog('info', 'Temporary memory cleared — extracted text and page queue reset.');
  }, [clearAll, addLog]);

  return (
    <div className="max-w-6xl mx-auto space-y-6 animate-slide-up">
      {/* ─── Page Header ─── */}
      <div>
        <h1 className="text-2xl font-bold text-surface-100 flex items-center gap-3">
          <span className="w-8 h-8 rounded-lg bg-brand-600/20 flex items-center justify-center">
            <svg className="w-4.5 h-4.5 text-brand-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
            </svg>
          </span>
          Book to Digital
        </h1>
        <p className="text-sm text-surface-500 mt-1 ml-11">
          تبدیل کتاب به دیجیتال — Convert physical books into searchable, structured digital content.
        </p>
      </div>

      {/* ─── Stats Bar ─── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatChip label="Pages" value={stats.pages} />
        <StatChip label="Processed" value={stats.processed} />
        <StatChip label="Words" value={stats.words.toLocaleString()} />
        <StatChip label="Characters" value={stats.chars.toLocaleString()} />
      </div>

      {/* ─── Two-column layout: left (upload + queue + actions), right (text) ─── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* ═══ LEFT COLUMN ═══ */}
        <div className="space-y-4">
          {/* ─── Drop Zone ─── */}
          <div
            onDragEnter={handleDrag}
            onDragLeave={handleDrag}
            onDragOver={handleDrag}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            className={`relative rounded-2xl border-2 border-dashed transition-all duration-300 cursor-pointer
              ${dragActive
                ? 'border-brand-500 bg-brand-600/10 glow-md scale-[1.01]'
                : 'border-surface-700/60 bg-surface-900/30 hover:border-surface-600 hover:bg-surface-900/50'
              }`}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
              multiple
              onChange={handleFileInput}
              className="hidden"
            />
            <div className="flex flex-col items-center justify-center py-10 px-6">
              <div className={`w-14 h-14 rounded-2xl flex items-center justify-center mb-3 transition-all duration-300
                ${dragActive ? 'bg-brand-600/20' : 'bg-surface-800/60'}`}>
                <svg className={`w-7 h-7 transition-colors ${dragActive ? 'text-brand-400' : 'text-surface-500'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                </svg>
              </div>
              <h3 className="text-sm font-semibold text-surface-200 mb-0.5">
                {dragActive ? 'Drop book pages here' : 'Drag & Drop book page images'}
              </h3>
              <p className="text-xs text-surface-500">or click to browse — PNG, JPG, JPEG, WEBP • multiple allowed</p>
            </div>
          </div>

          {/* ─── Page Queue ─── */}
          {pages.length > 0 && (
            <div className="rounded-xl bg-surface-900/40 border border-surface-800/40 overflow-hidden">
              <div className="flex items-center justify-between px-4 py-2.5 border-b border-surface-800/40 bg-surface-900/60">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-brand-400" />
                  <span className="text-xs font-semibold text-surface-300">
                    Page Queue ({pages.length})
                  </span>
                </div>
                <button
                  onClick={() => {
                    setPages([]);
                    clearAllImages();
                    addLog('info', 'Page queue cleared.');
                  }}
                  className="text-[10px] font-medium text-surface-500 hover:text-red-400 transition-colors"
                >
                  Clear All
                </button>
              </div>
              <div className="p-3 grid grid-cols-3 sm:grid-cols-4 gap-2.5 max-h-60 overflow-y-auto">
                {pages.map((page, idx) => {
                  const isCurrent = page.status === 'processing';
                  const isDone = page.status === 'done';
                  const isFailed = page.status === 'failed';
                  return (
                    <div
                      key={page.id}
                      className={`relative group rounded-lg overflow-hidden bg-surface-800/40 border transition-all
                        ${isCurrent
                          ? 'border-brand-500/60 glow-sm'
                          : isDone
                            ? 'border-emerald-500/40'
                            : isFailed
                              ? 'border-red-500/40'
                              : 'border-surface-700/30'
                        }`}
                    >
                      <div className="aspect-[3/4] bg-surface-800/60 overflow-hidden relative">
                        <PageThumb page={page} />
                        {/* Processing overlay */}
                        {isCurrent && (
                          <div className="absolute inset-0 bg-brand-950/70 flex items-center justify-center backdrop-blur-sm">
                            <div className="w-8 h-8 rounded-full border-2 border-brand-400/30 border-t-brand-400 animate-spin" />
                          </div>
                        )}
                        {/* Done overlay */}
                        {isDone && !isCurrent && (
                          <div className="absolute inset-0 bg-emerald-950/40 flex items-center justify-center">
                            <svg className="w-5 h-5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M5 13l4 4L19 7" />
                            </svg>
                          </div>
                        )}
                        {/* Failed overlay */}
                        {isFailed && !isCurrent && (
                          <div className="absolute inset-0 bg-red-950/40 flex items-center justify-center">
                            <svg className="w-5 h-5 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          </div>
                        )}
                      </div>
                      <div className="px-1.5 py-1">
                        <p className="text-[9px] font-medium text-surface-300 truncate">{page.name}</p>
                        <p className="text-[8px] text-surface-600">Page {idx + 1} • {page.size}</p>
                      </div>
                      {!isProcessing && (
                        <button
                          onClick={(e) => { e.stopPropagation(); removePage(page.id); }}
                          className="absolute top-1 right-1 w-5 h-5 rounded-full bg-red-500/80 hover:bg-red-500 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ─── OCR Mode Selector (compact) ─── */}
          <div className="p-4 rounded-xl bg-surface-900/40 border border-surface-800/40">
            <label className="block text-xs font-semibold text-surface-400 uppercase tracking-wider mb-3">
              OCR Mode
            </label>
            <div className="grid grid-cols-2 gap-2 mb-3">
              <button
                onClick={() => { setOcrMode('local'); addLog('info', 'Book OCR mode: Local (Fast/Offline)'); }}
                disabled={isProcessing}
                className={`p-3 rounded-lg text-left transition-all duration-200 disabled:opacity-50
                  ${ocrMode === 'local'
                    ? 'bg-emerald-500/10 border border-emerald-500/30'
                    : 'bg-surface-800/30 border border-transparent hover:bg-surface-800/50'}`}
              >
                <div className="flex items-center gap-2 mb-0.5">
                  <div className={`w-2.5 h-2.5 rounded-full border-2 ${ocrMode === 'local' ? 'border-emerald-400 bg-emerald-400' : 'border-surface-600'}`} />
                  <span className={`text-xs font-semibold ${ocrMode === 'local' ? 'text-emerald-300' : 'text-surface-300'}`}>Local</span>
                </div>
                <p className="text-[10px] text-surface-500 ml-4.5">Fast • Offline (Tesseract)</p>
              </button>
              <button
                onClick={() => { setOcrMode('cloud'); addLog('info', 'Book OCR mode: Cloud AI (High Precision)'); }}
                disabled={isProcessing}
                className={`p-3 rounded-lg text-left transition-all duration-200 disabled:opacity-50
                  ${ocrMode === 'cloud'
                    ? 'bg-purple-500/10 border border-purple-500/30'
                    : 'bg-surface-800/30 border border-transparent hover:bg-surface-800/50'}`}
              >
                <div className="flex items-center gap-2 mb-0.5">
                  <div className={`w-2.5 h-2.5 rounded-full border-2 ${ocrMode === 'cloud' ? 'border-purple-400 bg-purple-400' : 'border-surface-600'}`} />
                  <span className={`text-xs font-semibold ${ocrMode === 'cloud' ? 'text-purple-300' : 'text-surface-300'}`}>Cloud AI</span>
                </div>
                <p className="text-[10px] text-surface-500 ml-4.5">High Precision (Vision)</p>
              </button>
            </div>

            {/* Language (local only) — uses the shared LangSelect so both
                ImageOCR and BookProcessor show the same premium dropdown.
                The options come from OCR_LANGS in ocrEngine.js (includes
                Persian + the eng+fas multi-lang mode). */}
            {ocrMode === 'local' && (
              <div>
                <label className="block text-[10px] font-semibold text-surface-500 uppercase tracking-wider mb-1.5">
                  OCR Language (Tesseract)
                </label>
                <LangSelect
                  value={ocrLanguage}
                  onChange={setOcrLanguage}
                  disabled={isProcessing}
                />
              </div>
            )}
          </div>

          {/* ─── Action Buttons ─── */}
          <div className="space-y-3">
            {/* Finish Book Processing — پایان پردازش کتاب */}
            <button
              onClick={handleFinishBook}
              disabled={!accumulatedText}
              className="w-full py-3.5 rounded-xl font-semibold text-sm transition-all duration-300 flex items-center justify-center gap-2
                bg-gradient-to-r from-brand-600 to-purple-600 text-white hover:from-brand-500 hover:to-purple-500
                glow-md hover:glow-lg active:scale-[0.99] disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:glow-md"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span>Finish Book Processing</span>
              <span className="text-[11px] font-normal opacity-80">(پایان پردازش کتاب)</span>
            </button>

            {/* Clear Temporary Memory — پاک‌سازی حافظه موقت */}
            <button
              onClick={handleClearMemory}
              disabled={!accumulatedText && pages.length === 0}
              className="w-full py-3 rounded-xl font-semibold text-sm transition-all duration-300 flex items-center justify-center gap-2
                bg-red-600/10 text-red-300 border border-red-500/20 hover:bg-red-600/20 hover:border-red-500/40
                active:scale-[0.99] disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
              </svg>
              <span>Clear Temporary Memory</span>
              <span className="text-[11px] font-normal opacity-80">(پاک‌سازی حافظه موقت)</span>
            </button>

            {isProcessing && (
              <p className="text-center text-[11px] text-amber-400/80">Processing…</p>
            )}
          </div>
        </div>

        {/* ═══ RIGHT COLUMN: Live Extracted Text ═══ */}
        <div className="rounded-xl bg-surface-900/40 border border-surface-800/40 overflow-hidden flex flex-col">
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-surface-800/40 bg-surface-900/60">
            <div className="flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full transition-colors ${isProcessing ? 'bg-amber-400 animate-pulse' : accumulatedText ? 'bg-emerald-400' : 'bg-surface-600'}`} />
              <span className="text-xs font-semibold text-surface-300">Extracted Book Text</span>
              <span className="text-[10px] font-mono text-surface-600">LIVE ACCUMULATION</span>
              {stats.words > 0 && (
                <span className="text-[10px] font-mono text-surface-600">~{stats.words.toLocaleString()} words</span>
              )}
            </div>
            {accumulatedText && (
              <button
                onClick={() => {
                  navigator.clipboard?.writeText(accumulatedText)
                    .then(() => {
                      addLog('info', 'Accumulated text copied to clipboard.');
                      // ─── Memory lifecycle ─── Copy is an end-of-use action:
                      // once the text is on the clipboard the source images are
                      // no longer needed. Purge the imageStore cache AND clear
                      // the page queue (text stays) so browser memory stays lean.
                      clearAllImages();
                      setPages([]);
                    })
                    .catch(() => addLog('warning', 'Clipboard not available.'));
                }}
                className="text-[10px] font-medium text-brand-400 hover:text-brand-300 transition-colors flex items-center gap-1"
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
                Copy
              </button>
            )}
          </div>
          <div className="flex-1 p-5 h-[32rem] lg:h-auto min-h-[32rem] overflow-y-auto text-sm leading-7 text-surface-200 whitespace-pre-wrap font-mono bg-surface-950/30">
            {isProcessing && !accumulatedText ? (
              <div className="flex items-center gap-2 text-surface-500">
                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Connecting to {ocrMode === 'local' ? 'Tesseract OCR' : 'Cloud AI'}…
              </div>
            ) : accumulatedText ? (
              accumulatedText
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-surface-600">
                <svg className="w-10 h-10 mb-2 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
                </svg>
                <span className="text-xs">Extracted text from book pages will accumulate here</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ─── Export Options Modal (opened by "Finish Book Processing") ─── */}
      {exportModalOpen && (
        <ExportOptionsModal
          accumulatedText={accumulatedText}
          exporting={exporting}
          generatingDataset={isGeneratingDataset}
          cloudStates={cloud.states}
          cloudUploading={cloudUploading}
          onUploadToCloud={handleUploadToCloud}
          onExport={handleExport}
          onGenerateDataset={handleGenerateDataset}
          onClose={() => { if (!exporting && !isGeneratingDataset && !cloudUploading) setExportModalOpen(false); }}
        />
      )}
    </div>
  );
}

/* ─── Small stat chip (matches SubtitleProcessor pattern) ─── */
function StatChip({ label, value }) {
  return (
    <div className="px-4 py-3 rounded-xl bg-surface-900/40 border border-surface-800/40">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-surface-500">{label}</p>
      <p className="text-lg font-bold text-surface-100 mt-0.5">{value}</p>
    </div>
  );
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

/**
 * PageThumb — lazy-loads a page's base64 image from the imageStore by its
 * `imageRef`, so the queue's React state can stay payload-free. Falls back
 * to a faded placeholder while loading or if the image was already purged.
 */
function PageThumb({ page }) {
  const [src, setSrc] = useState(null);

  useEffect(() => {
    let cancelled = false;
    // Back-compat: an entry that still carries an inline dataUrl (e.g. from
    // before this change in the same session) renders it directly.
    if (page.dataUrl) {
      setSrc(page.dataUrl);
      return;
    }
    if (!page.imageRef) return;
    getImage(page.imageRef).then((dataUrl) => {
      if (!cancelled) setSrc(dataUrl);
    });
    return () => { cancelled = true; };
  }, [page.dataUrl, page.imageRef]);

  if (!src) {
    return (
      <div className="w-full h-full flex items-center justify-center text-surface-700">
        <svg className="w-5 h-5 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
      </div>
    );
  }
  return <img src={src} alt={page.name} className="w-full h-full object-cover" />;
}

/**
 * ExportOptionsModal
 * ─────────────────────────────────────────────────────────────
 * Dark-themed modal opened by "Finish Book Processing". Lets the
 * user download the accumulated book text as a real .docx or .pdf,
 * and (Phase 2, Task 5) exposes the three "Generate AI Dataset"
 * options as interactive cards.
 *
 * The dataset cards are currently wired to a MOCK handler
 * (onGenerateDataset) — the actual AI fetch logic / prompt
 * engineering / aiClient.js integration is reserved for Task 6.
 * No changes here affect the DOCX/PDF export path.
 *
 * Closes on backdrop click, the ✕ button, or the Escape key.
 */
function ExportOptionsModal({ accumulatedText, exporting, generatingDataset, cloudStates, cloudUploading, onUploadToCloud, onExport, onGenerateDataset, onClose }) {
  const wordCount = (accumulatedText.match(/\S+/g) || []).length;
  const charCount = accumulatedText.length;
  const busy = !!exporting || !!generatingDataset || !!cloudUploading;

  // Esc to close (only when not mid-export)
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [busy, onClose]);

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-md animate-fade-in"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-md mx-4 rounded-2xl bg-surface-900 border border-surface-700/60 glow-lg shadow-2xl overflow-hidden animate-slide-up"
      >
        {/* ─── Title bar ─── */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-surface-800/60 bg-surface-900/80">
          <div className="flex items-center gap-2.5">
            <span className="w-7 h-7 rounded-lg bg-brand-600/20 flex items-center justify-center">
              <svg className="w-4 h-4 text-brand-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 16h9m-9-8h9M12 4h9M4 4h.01M4 12h.01M4 20h.01" />
              </svg>
            </span>
            <h2 className="text-sm font-semibold text-surface-100">Export Options</h2>
          </div>
          <button
            onClick={onClose}
            disabled={busy}
            className="w-7 h-7 rounded-md flex items-center justify-center text-surface-500 hover:text-surface-200 hover:bg-surface-800/60 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* ─── Body ─── */}
        <div className="p-5 space-y-5">
          {/* Section A — File Downloads */}
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-surface-500 mb-2.5">
              File Downloads
            </p>
            <div className="grid grid-cols-2 gap-3">
              <ExportButton
                label="Word"
                sublabel=".docx"
                color="brand"
                busy={exporting === 'docx'}
                disabled={busy && exporting !== 'docx'}
                onClick={() => onExport('docx')}
              />
              <ExportButton
                label="PDF"
                sublabel=".pdf"
                color="red"
                busy={exporting === 'pdf'}
                disabled={busy && exporting !== 'pdf'}
                onClick={() => onExport('pdf')}
              />
            </div>
          </div>

          {/* Section B — Generate AI Dataset (Phase 2, Task 5) */}
          <div>
            <div className="flex items-center justify-between mb-2.5">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-surface-500">
                Generate AI Dataset
              </p>
              <span className="text-[9px] font-medium px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-300 border border-purple-500/20">
                AI Training Ready
              </span>
            </div>
            <div className="space-y-2.5">
              <DatasetCard
                type="instruction"
                title="Instruction / QA Dataset"
                titleFa="دیتاست پرسش و پاسخ"
                description="Converts text into prompt / response pairs."
                accent="brand"
                busy={generatingDataset === 'instruction'}
                onClick={onGenerateDataset}
              />
              <DatasetCard
                type="causal"
                title="Causal LM Dataset"
                titleFa="تکمیل متن"
                description="Chunks text for continuous text generation training."
                accent="emerald"
                busy={generatingDataset === 'causal'}
                onClick={onGenerateDataset}
              />
              <DatasetCard
                type="chat"
                title="Chat / DPO Dataset"
                titleFa="چت و ترجیحات"
                description="Formats into multi-turn conversational roles (System / User / Assistant)."
                accent="purple"
                busy={generatingDataset === 'chat'}
                onClick={onGenerateDataset}
              />
            </div>
          </div>

          {/* Section C — Upload to Cloud (Task 8) */}
          <div>
            <div className="flex items-center justify-between mb-2.5">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-surface-500">
                Upload to Cloud
              </p>
              <span className="text-[9px] font-medium px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-300 border border-sky-500/20">
                Google Drive • Dropbox
              </span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => onUploadToCloud('googleDrive')}
                disabled={!cloudStates?.googleDrive?.connected || busy}
                className="px-4 py-3 rounded-xl text-xs font-semibold transition-all duration-200
                  bg-sky-600/15 border border-sky-500/30 text-sky-200
                  hover:bg-sky-600/25 hover:border-sky-500/50
                  disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-sky-600/15
                  flex flex-col items-center justify-center gap-1"
              >
                {cloudUploading === 'googleDrive'
                  ? 'Uploading…'
                  : cloudStates?.googleDrive?.connected
                    ? 'Google Drive'
                    : 'Google Drive (not connected)'}
              </button>
              <button
                onClick={() => onUploadToCloud('dropbox')}
                disabled={!cloudStates?.dropbox?.connected || busy}
                className="px-4 py-3 rounded-xl text-xs font-semibold transition-all duration-200
                  bg-blue-600/15 border border-blue-500/30 text-blue-200
                  hover:bg-blue-600/25 hover:border-blue-500/50
                  disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-blue-600/15
                  flex flex-col items-center justify-center gap-1"
              >
                {cloudUploading === 'dropbox'
                  ? 'Uploading…'
                  : cloudStates?.dropbox?.connected
                    ? 'Dropbox'
                    : 'Dropbox (not connected)'}
              </button>
            </div>
            <p className="text-[10px] text-surface-600 mt-2">
              Connect a provider in the Settings tab to enable cloud upload.
            </p>
          </div>

          {/* Footer — what's being exported */}
          <div className="pt-3 border-t border-surface-800/50 flex items-center justify-between text-[11px] text-surface-500 font-mono">
            <span>{wordCount.toLocaleString()} words</span>
            <span>{charCount.toLocaleString()} characters</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── Single export action button (used in both modal sections) ─── */
function ExportButton({ label, sublabel, color, busy, disabled, onClick }) {
  const base = 'relative w-full p-3.5 rounded-xl flex flex-col items-center justify-center gap-1 text-xs font-semibold transition-all duration-200';
  const colorClasses = {
    brand: 'bg-brand-600/15 border border-brand-500/30 text-brand-200 hover:bg-brand-600/25 hover:border-brand-500/50',
    red:   'bg-red-600/15 border border-red-500/30 text-red-200 hover:bg-red-600/25 hover:border-red-500/50',
  }[color] || 'bg-surface-800/40 text-surface-400 border border-surface-700/30';

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`${base} ${colorClasses} disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.99]`}
    >
      {busy ? (
        <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      ) : (
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
        </svg>
      )}
      <span>{busy ? 'Generating…' : label}</span>
      <span className="text-[10px] font-normal opacity-70">{sublabel}</span>
    </button>
  );
}

/* ─── Dataset Card (Phase 2, Task 6 — wired to real AI generation) ─── */
/**
 * A single "Generate AI Dataset" option card. Clickable, premium dark-
 * themed, with a subtle border and hover lift + accent glow. Calls the
 * real onGenerateDataset(type) handler that runs the LLM and downloads
 * the resulting JSON.
 *
 * @param {('instruction'|'causal'|'chat')} type  Sent back to the handler.
 * @param {string} title      English label.
 * @param {string} titleFa    Persian (فارسی) label shown under the title.
 * @param {string} description One-line explanation of the dataset shape.
 * @param {('brand'|'emerald'|'purple')} accent  Color scheme of the card.
 * @param {boolean} [busy=false]  True while THIS card's dataset is being
 *   generated by the AI. Shows a spinner, disables click, and is not
 *   subject to hover styling. Other DatasetCards stay clickable.
 * @param {(type: string) => void} onClick  Handler from BookProcessor.
 */
function DatasetCard({ type, title, titleFa, description, accent, busy, onClick }) {
  // Per-accent styling. Each accent has three coordinated layers:
  //   • icon badge bg/tint + icon stroke color
  //   • card resting border + faint bg tint
  //   • hover-only border + bg + glow accent + icon chip hover tint
  const accents = {
    brand: {
      badge: 'bg-brand-600/15 text-brand-300 group-hover:bg-brand-600/25 group-hover:text-brand-200',
      card:  'border-brand-500/20 bg-brand-950/10',
      hover: 'hover:border-brand-400/50 hover:bg-brand-950/20 hover:glow-sm',
    },
    emerald: {
      badge: 'bg-emerald-500/15 text-emerald-300 group-hover:bg-emerald-500/25 group-hover:text-emerald-200',
      card:  'border-emerald-500/20 bg-emerald-950/10',
      hover: 'hover:border-emerald-400/50 hover:bg-emerald-950/20 hover:glow-sm',
    },
    purple: {
      badge: 'bg-purple-500/15 text-purple-300 group-hover:bg-purple-500/25 group-hover:text-purple-200',
      card:  'border-purple-500/20 bg-purple-950/10',
      hover: 'hover:border-purple-400/50 hover:bg-purple-950/20 hover:glow-sm',
    },
  }[accent] || {
    badge: 'bg-surface-800/60 text-surface-300',
    card:  'border-surface-700/40 bg-surface-900/30',
    hover: 'hover:border-surface-600 hover:bg-surface-900/50',
  };

  // Per-type icon path — kept in the same outline style as the rest of
  // the modal's SVGs so the visual language stays consistent.
  const icons = {
    // Question/answer pairing — prompt + response loop.
    instruction: 'M8 10h8M8 14h5m-5 7a8 8 0 100-16 8 8 0 000 16z',
    // Horizontal stacked layers — text chunking for causal training.
    causal:      'M4 7h16M4 12h16M4 17h10',
    // Speech bubbles — multi-turn conversational roles.
    chat:        'M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.86 9.86 0 01-4-.8L3 20l1.2-3.6A7.96 7.96 0 013 12c0-4.418 4.03-8 9-8s9 3.582 9 8z',
  }[type] || 'M12 6v12m6-6H6';

  return (
    <button
      type="button"
      onClick={() => onClick?.(type)}
      disabled={busy}
      className={`group w-full p-3.5 rounded-xl flex items-start gap-3 text-left transition-all duration-200 active:scale-[0.99] border
        ${accents.card}
        ${busy ? 'opacity-70 cursor-wait' : accents.hover}
        disabled:cursor-not-allowed`}
    >
      {/* Icon badge — keeps its accent even while busy */}
      <span className={`shrink-0 w-9 h-9 rounded-lg flex items-center justify-center transition-colors duration-200 ${accents.badge}`}>
        <svg className="w-4.5 h-4.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.75" d={icons[type]} />
        </svg>
      </span>

      {/* Label block */}
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-semibold text-surface-100 leading-tight">
          {busy ? 'Generating…' : title}
        </span>
        <span className="block text-[11px] font-medium text-surface-400 mt-0.5" dir="rtl" lang="fa">{titleFa}</span>
        <span className="block text-[11px] text-surface-500 mt-1 leading-relaxed">{description}</span>
      </span>

      {/* Trailing affordance — spinner when busy, chevron (nudges on hover) otherwise */}
      {busy ? (
        <span className="shrink-0 self-center">
          <svg className="w-4 h-4 animate-spin text-surface-300" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        </span>
      ) : (
        <span className="shrink-0 self-center text-surface-600 group-hover:text-surface-300 transition-all duration-200 group-hover:translate-x-0.5">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7" />
          </svg>
        </span>
      )}
    </button>
  );
}


