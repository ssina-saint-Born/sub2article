import React, { useState, useCallback, useRef } from 'react';
import { useLog } from '../../contexts/LogContext';
import { useSettings } from '../../hooks/useSettings';
import { extractLocal, extractCloud, fileToDataUrl, toTesseractLang } from '../../utils/ocrEngine';

const VALID_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp'];
const MIME_PREFIX = 'image/';

function getExt(name) {
  return name.split('.').pop().toLowerCase();
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

export default function ImageOCR() {
  const { addLog } = useLog();
  const { settings } = useSettings();

  const [images, setImages] = useState([]);          // [{ id, file, dataUrl, name, size }]
  const [dragActive, setDragActive] = useState(false);
  const [ocrMode, setOcrMode] = useState('local');   // 'local' | 'cloud'
  const [exportFormat, setExportFormat] = useState('txt'); // 'txt' | 'doc'
  const [ocrLanguage, setOcrLanguage] = useState('English');

  const [isExtracting, setIsExtracting] = useState(false);
  const [currentIdx, setCurrentIdx] = useState(-1);   // which image is being processed
  const [localProgress, setLocalProgress] = useState(0); // 0..1 for tesseract
  const [combinedText, setCombinedText] = useState('');
  const [copied, setCopied] = useState(false);
  const abortRef = useRef(null);
  const fileInputRef = useRef(null);

  const OCR_LANGUAGES = ['English', 'Persian (فارسی)', 'Spanish (Español)', 'French (Français)',
    'German (Deutsch)', 'Arabic (العربية)', 'Chinese (中文)', 'Japanese (日本語)'];

  // ─── Add files (from drop or input) ───
  const addFiles = useCallback(async (fileList) => {
    const files = Array.from(fileList);
    const valid = [];
    let invalidCount = 0;

    for (const file of files) {
      const ext = getExt(file.name);
      const isImageMime = file.type.startsWith(MIME_PREFIX);
      const isImageExt = VALID_EXTENSIONS.includes(ext);

      if (!isImageMime && !isImageExt) {
        invalidCount++;
        continue;
      }
      valid.push(file);
    }

    if (invalidCount > 0) {
      addLog('error', 'Invalid file type. Please upload images (PNG, JPG, JPEG, WEBP).');
    }

    if (valid.length === 0) return;

    // Build image entries with data URLs
    const newEntries = await Promise.all(
      valid.map(async (file) => {
        try {
          const dataUrl = await fileToDataUrl(file);
          return {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            file,
            dataUrl,
            name: file.name,
            size: file.size,
          };
        } catch {
          return null;
        }
      })
    );

    const clean = newEntries.filter(Boolean);
    setImages(prev => [...prev, ...clean]);
    addLog('success', `${clean.length} image(s) added. Queue size: ${images.length + clean.length}.`);
  }, [addLog, images.length]);

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

  // ─── Remove / Clear ───
  const removeImage = useCallback((id) => {
    setImages(prev => {
      const target = prev.find(i => i.id === id);
      if (target) addLog('info', `Image "${target.name}" removed from queue.`);
      return prev.filter(i => i.id !== id);
    });
  }, [addLog]);

  const clearAll = useCallback(() => {
    setImages([]);
    setCombinedText('');
    addLog('info', 'Image queue cleared.');
  }, [addLog]);

  // ─── Sequential extraction ───
  const handleExtract = useCallback(async () => {
    if (images.length === 0) {
      addLog('warning', 'No images uploaded. Please add images first.');
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setIsExtracting(true);
    setCombinedText('');
    setLocalProgress(0);

    const modeLabel = ocrMode === 'local' ? 'Local Mode' : 'Cloud AI Mode';
    addLog('info', `Starting OCR extraction (${modeLabel}) on ${images.length} image(s)...`);

    const results = [];

    try {
      for (let i = 0; i < images.length; i++) {
        if (controller.signal.aborted) break;

        const img = images[i];
        setCurrentIdx(i);
        setLocalProgress(0);
        addLog('info', `Extracting text from image ${i + 1} of ${images.length} via ${modeLabel}...`);

        let result;
        if (ocrMode === 'local') {
          result = await extractLocal(img.dataUrl, {
            lang: toTesseractLang(ocrLanguage),
            onProgress: (p) => setLocalProgress(p),
            signal: controller.signal,
          });
        } else {
          // Cloud mode — validate settings first
          if (!settings.apiKey || !settings.providerUrl) {
            addLog('error', 'API Key or Base URL is missing. Please check your Settings.');
            break;
          }
          result = await extractCloud(img.dataUrl, {
            baseUrl: settings.providerUrl,
            apiKey: settings.apiKey,
            model: settings.modelName,
            signal: controller.signal,
          });
        }

        if (result.ok) {
          const wordCount = (result.text.match(/\S+/g) || []).length;
          results.push({ name: img.name, text: result.text });
          // Live-update combined text as each image completes
          const combined = results.map((r, idx) =>
            `--- Image ${idx + 1}: ${r.name} ---\n${r.text || '(no text detected)'}`
          ).join('\n\n');
          setCombinedText(combined);
          addLog('success', `Image ${i + 1} (${img.name}) done — ${wordCount} words extracted.`);
        } else {
          results.push({ name: img.name, text: `[Extraction failed: ${result.error}]` });
          const combined = results.map((r, idx) =>
            `--- Image ${idx + 1}: ${r.name} ---\n${r.text || '(no text detected)'}`
          ).join('\n\n');
          setCombinedText(combined);
          addLog('error', `Image ${i + 1} (${img.name}) failed: ${result.error}`);
        }
      }

      if (results.length > 0 && !controller.signal.aborted) {
        const totalWords = results.reduce((sum, r) =>
          sum + (r.text.match(/\S+/g) || []).length, 0);
        addLog('success', `OCR complete. ${results.length} image(s) processed, ~${totalWords} total words.`);
      }
    } catch (err) {
      // Defensive: ocrEngine functions catch their own errors, but guard
      // against any unexpected throw so the UI never stays stuck.
      const msg = err?.name === 'AbortError' ? 'Extraction cancelled.' : err.message;
      addLog('error', `OCR Error: ${msg}`);
    } finally {
      // Always reset all loading/progress state — even on crash or cancel.
      setCurrentIdx(-1);
      setLocalProgress(0);
      abortRef.current = null;
      setIsExtracting(false);
    }
  }, [images, ocrMode, ocrLanguage, settings, addLog]);

  // ─── Cancel ───
  const handleCancel = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
      setIsExtracting(false);
      setCurrentIdx(-1);
      addLog('info', 'OCR extraction cancelled by user.');
    }
  }, [addLog]);

  // ─── Export ───
  const handleExport = useCallback(async () => {
    if (!combinedText) {
      addLog('warning', 'No extracted text to export.');
      return;
    }

    const api = window.electronAPI;
    let blob;
    let defaultName;
    let extension;

    if (exportFormat === 'doc') {
      // Minimal HTML wrapper that opens cleanly in MS Word
      const html = `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8"><title>SubScribe AI — OCR Export</title>
<style>body{font-family:'Calibri',sans-serif;font-size:11pt;line-height:1.6;white-space:pre-wrap;}h1{font-size:16pt;}</style>
</head>
<body><h1>SubScribe AI — Extracted Text</h1>${escapeHtml(combinedText)}</body>
</html>`;
      blob = new Blob([html], { type: 'application/msword' });
      defaultName = 'subscribe-ocr-export.doc';
      extension = 'doc';
    } else {
      blob = new Blob([combinedText], { type: 'text/plain;charset=utf-8' });
      defaultName = 'subscribe-ocr-export.txt';
      extension = 'txt';
    }

    // ─── Native save dialog path (Electron) ───
    if (api?.fs?.showSaveDialog && api?.fs?.writeFile) {
      try {
        const result = await api.fs.showSaveDialog({
          title: 'Save OCR Export',
          defaultName,
          filters: [
            { name: exportFormat === 'doc' ? 'Word Document' : 'Text File', extensions: [extension] },
            { name: 'All Files', extensions: ['*'] },
          ],
        });
        if (result.ok && result.path) {
          // Read the blob as ArrayBuffer and write via IPC. Since writeFile
          // expects a string, we read text for .txt and the HTML string for .doc.
          const writeResult = await api.fs.writeFile(
            result.path,
            exportFormat === 'doc'
              ? await blob.text()
              : combinedText
          );
          if (writeResult.ok) {
            addLog('success', `Exported to "${result.path.split(/[\\/]/).pop()}".`);
          } else {
            addLog('error', `Export failed: ${writeResult.error}`);
          }
          return;
        }
        addLog('info', 'Export cancelled.');
        return;
      } catch (err) {
        addLog('error', `Export error: ${err.message}`);
      }
    }

    // ─── Fallback: browser blob download ───
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = defaultName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    addLog('success', `Exported as ${defaultName} via browser download.`);
  }, [combinedText, exportFormat, addLog]);

  // ─── Copy ───
  const handleCopy = useCallback(async () => {
    if (!combinedText) return;
    try {
      await navigator.clipboard.writeText(combinedText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      addLog('info', 'Extracted text copied to clipboard.');
    } catch {
      addLog('warning', 'Clipboard not available.');
    }
  }, [combinedText, addLog]);

  const totalWords = (combinedText.match(/\S+/g) || []).length;

  return (
    <div className="max-w-6xl mx-auto space-y-6 animate-slide-up">
      {/* ─── Page Header ─── */}
      <div>
        <h1 className="text-2xl font-bold text-surface-100 flex items-center gap-3">
          <span className="w-8 h-8 rounded-lg bg-purple-600/20 flex items-center justify-center">
            <svg className="w-4.5 h-4.5 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
          </span>
          Image OCR Extractor
        </h1>
        <p className="text-sm text-surface-500 mt-1 ml-11">
          Upload images and extract text using Local OCR or Cloud AI.
        </p>
      </div>

      {/* ─── Two-column layout: left (input + gallery + config), right (output) ─── */}
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
                ? 'border-purple-500 bg-purple-600/10 glow-md scale-[1.01]'
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
                ${dragActive ? 'bg-purple-600/20' : 'bg-surface-800/60'}`}>
                <svg className={`w-7 h-7 transition-colors ${dragActive ? 'text-purple-400' : 'text-surface-500'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
              </div>
              <h3 className="text-sm font-semibold text-surface-200 mb-0.5">
                {dragActive ? 'Drop images here' : 'Drag & Drop images'}
              </h3>
              <p className="text-xs text-surface-500">PNG, JPG, JPEG, WEBP — multiple allowed</p>
            </div>
          </div>

          {/* ─── Gallery ─── */}
          {images.length > 0 && (
            <div className="rounded-xl bg-surface-900/40 border border-surface-800/40 overflow-hidden">
              <div className="flex items-center justify-between px-4 py-2.5 border-b border-surface-800/40 bg-surface-900/60">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-purple-400" />
                  <span className="text-xs font-semibold text-surface-300">
                    Queue ({images.length})
                  </span>
                </div>
                <button
                  onClick={clearAll}
                  className="text-[10px] font-medium text-surface-500 hover:text-red-400 transition-colors"
                >
                  Clear All
                </button>
              </div>
              <div className="p-3 grid grid-cols-3 sm:grid-cols-4 gap-2.5 max-h-60 overflow-y-auto">
                {images.map((img, idx) => {
                  const isProcessing = isExtracting && currentIdx === idx;
                  const isDone = isExtracting && currentIdx > idx;
                  return (
                    <div
                      key={img.id}
                      className={`relative group rounded-lg overflow-hidden bg-surface-800/40 border transition-all
                        ${isProcessing ? 'border-purple-500/60 glow-sm' : isDone ? 'border-emerald-500/40' : 'border-surface-700/30'}
                      `}
                    >
                      <div className="aspect-square bg-surface-800/60 overflow-hidden relative">
                        <img src={img.dataUrl} alt={img.name} className="w-full h-full object-cover" />
                        {/* Processing overlay */}
                        {isProcessing && (
                          <div className="absolute inset-0 bg-purple-950/70 flex flex-col items-center justify-center backdrop-blur-sm">
                            <div className="w-8 h-8 rounded-full border-2 border-purple-400/30 border-t-purple-400 animate-spin" />
                            {ocrMode === 'local' && (
                              <span className="text-[9px] font-mono text-purple-300 mt-1.5">
                                {Math.round(localProgress * 100)}%
                              </span>
                            )}
                          </div>
                        )}
                        {isDone && (
                          <div className="absolute inset-0 bg-emerald-950/40 flex items-center justify-center">
                            <svg className="w-5 h-5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M5 13l4 4L19 7" />
                            </svg>
                          </div>
                        )}
                      </div>
                      <div className="px-1.5 py-1">
                        <p className="text-[9px] font-medium text-surface-300 truncate">{img.name}</p>
                        <p className="text-[8px] text-surface-600">{formatSize(img.size)}</p>
                      </div>
                      {/* Remove badge */}
                      {!isExtracting && (
                        <button
                          onClick={(e) => { e.stopPropagation(); removeImage(img.id); }}
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

          {/* ─── OCR Mode Selector ─── */}
          <div className="p-4 rounded-xl bg-surface-900/40 border border-surface-800/40">
            <label className="block text-xs font-semibold text-surface-400 uppercase tracking-wider mb-3">
              OCR Mode
            </label>
            <div className="grid grid-cols-2 gap-2 mb-3">
              <button
                onClick={() => { setOcrMode('local'); addLog('info', 'OCR mode: Local Mode (Fast/Offline)'); }}
                disabled={isExtracting}
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
                onClick={() => { setOcrMode('cloud'); addLog('info', 'OCR mode: Cloud AI Mode (High Precision)'); }}
                disabled={isExtracting}
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

            {/* Language (local only) */}
            {ocrMode === 'local' && (
              <div className="mb-3">
                <label className="block text-[10px] font-semibold text-surface-500 uppercase tracking-wider mb-1.5">
                  OCR Language (Tesseract)
                </label>
                <select
                  value={ocrLanguage}
                  onChange={(e) => setOcrLanguage(e.target.value)}
                  disabled={isExtracting}
                  className="w-full bg-surface-800/60 border border-surface-700/50 rounded-lg px-3 py-2 text-xs text-surface-200 focus:outline-none focus:ring-2 focus:ring-brand-500/40 cursor-pointer"
                >
                  {OCR_LANGUAGES.map(lang => <option key={lang} value={lang}>{lang}</option>) }
                </select>
              </div>
            )}

            {/* Export format */}
            <div>
              <label className="block text-[10px] font-semibold text-surface-500 uppercase tracking-wider mb-1.5">
                Export Format
              </label>
              <div className="flex gap-2">
                <button
                  onClick={() => setExportFormat('txt')}
                  disabled={isExtracting}
                  className={`flex-1 px-3 py-2 rounded-lg text-xs font-medium transition-colors disabled:opacity-50
                    ${exportFormat === 'txt' ? 'bg-brand-500/15 border border-brand-500/30 text-brand-300' : 'bg-surface-800/30 border border-surface-700/30 text-surface-400 hover:bg-surface-800/50'}`}
                >
                  Plain Text (.txt)
                </button>
                <button
                  onClick={() => setExportFormat('doc')}
                  disabled={isExtracting}
                  className={`flex-1 px-3 py-2 rounded-lg text-xs font-medium transition-colors disabled:opacity-50
                    ${exportFormat === 'doc' ? 'bg-brand-500/15 border border-brand-500/30 text-brand-300' : 'bg-surface-800/30 border border-surface-700/30 text-surface-400 hover:bg-surface-800/50'}`}
                >
                  Word (.doc)
                </button>
              </div>
            </div>
          </div>

          {/* ─── Extract / Cancel Button ─── */}
          <button
            onClick={isExtracting ? handleCancel : handleExtract}
            disabled={!isExtracting && images.length === 0}
            className={`w-full py-3.5 rounded-xl font-semibold text-sm transition-all duration-300 flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed
              ${isExtracting
                ? 'bg-red-600/30 text-red-300 hover:bg-red-600/40 border border-red-500/30'
                : 'bg-gradient-to-r from-purple-600 to-pink-600 text-white hover:from-purple-500 hover:to-pink-500 glow-md hover:glow-lg active:scale-[0.99]'
              }`}
          >
            {isExtracting ? (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
                Cancel Extraction
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                Extract Text ({ocrMode === 'local' ? 'Local OCR' : 'Cloud AI'})
              </>
            )}
          </button>
        </div>

        {/* ═══ RIGHT COLUMN: Output Preview ═══ */}
        <div className="rounded-xl bg-surface-900/40 border border-surface-800/40 overflow-hidden flex flex-col">
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-surface-800/40 bg-surface-900/60">
            <div className="flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full ${isExtracting ? 'bg-amber-400 animate-pulse' : combinedText ? 'bg-emerald-400' : 'bg-surface-600'}`} />
              <span className="text-xs font-semibold text-surface-300">Extracted Text</span>
              {totalWords > 0 && (
                <span className="text-[10px] font-mono text-surface-600">~{totalWords} words</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {combinedText && !isExtracting && (
                <>
                  <button
                    onClick={handleCopy}
                    className={`text-[10px] font-medium transition-colors flex items-center gap-1 ${copied ? 'text-emerald-400' : 'text-brand-400 hover:text-brand-300'}`}
                  >
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                  <button
                    onClick={handleExport}
                    className="text-[10px] font-medium text-emerald-400 hover:text-emerald-300 transition-colors flex items-center gap-1"
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                    </svg>
                    Export
                  </button>
                </>
              )}
            </div>
          </div>
          <div className="flex-1 p-5 h-[28rem] overflow-y-auto text-sm leading-7 text-surface-200 whitespace-pre-wrap font-mono">
            {isExtracting && !combinedText ? (
              <div className="flex items-center gap-2 text-surface-500">
                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Connecting to {ocrMode === 'local' ? 'Tesseract OCR' : 'Cloud AI'}...
              </div>
            ) : combinedText ? (
              combinedText
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-surface-600">
                <svg className="w-10 h-10 mb-2 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                <span className="text-xs">Extracted text from images will appear here</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── Helpers ─── */
function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
