import React, { useState, useCallback, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useLog } from '../../contexts/LogContext';
import { useSettings } from '../../hooks/useSettings';
import { parseSubtitle, detectFormat, formatDuration } from '../../utils/subtitleParser';
import { buildSystemPrompt, buildUserPrompt, getFormatLabel } from '../../utils/prompts';
import { callLLM } from '../../utils/apiClient';

const OUTPUT_TYPES = [
  { id: 'lecture', label: 'Student Lecture Notes', desc: 'Organized study notes with key concepts highlighted' },
  { id: 'academic', label: 'Academic Article', desc: 'Formal academic writing with citations structure' },
  { id: 'seo', label: 'SEO-Optimized Blog Post', desc: 'Engaging blog post with headers & keywords' },
];

const LANGUAGES = [
  'Persian (فارسی)',
  'English',
  'Spanish (Español)',
  'French (Français)',
  'German (Deutsch)',
  'Arabic (العربية)',
  'Chinese (中文)',
  'Japanese (日本語)',
  'Korean (한국어)',
  'Turkish (Türkçe)',
  'Hindi (हिन्दी)',
  'Portuguese (Português)',
];

const VALID_EXTENSIONS = ['srt', 'vtt'];

function getExt(name) {
  return name.split('.').pop().toLowerCase();
}

export default function SubtitleProcessor() {
  const { addLog } = useLog();
  const { settings } = useSettings();

  const [fileLoaded, setFileLoaded] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [fileMeta, setFileMeta] = useState(null); // { name, format, sizeKB, words, cues, durationSec }
  const [rawContent, setRawContent] = useState('');
  const [parsedText, setParsedText] = useState('');
  const [outputText, setOutputText] = useState('');
  const [outputType, setOutputType] = useState('lecture');
  const [language, setLanguage] = useState('Persian (فارسی)');
  const [isProcessing, setIsProcessing] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [outputCopied, setOutputCopied] = useState(false);
  const [streamWordCount, setStreamWordCount] = useState(0);
  const fileInputRef = useRef(null);
  const abortRef = useRef(null);

  // ─── Core: ingest raw subtitle text + metadata ───
  const ingestFile = useCallback((name, sizeBytes, raw) => {
    const ext = getExt(name);
    const format = detectFormat(name);
    const { text, stats } = parseSubtitle(raw);

    if (stats.cues === 0) {
      addLog('warning', `"${name}" contained no recognizable subtitle cues.`);
    }

    setFileMeta({
      name,
      format,
      sizeKB: sizeBytes / 1024,
      words: stats.words,
      cues: stats.cues,
      durationSec: stats.durationSec,
    });
    setRawContent(raw);
    setParsedText(text);
    setOutputText('');
    setFileLoaded(true);

    addLog('success', `Subtitle file "${name}" successfully loaded.`);
    addLog('info', `Parsed ${stats.cues} cues → ${stats.words} words, ${formatDuration(stats.durationSec)} duration.`);
  }, [addLog]);

  // ─── Handle a dropped/selected File object (browser File API) ───
  const handleFileObject = useCallback(async (file) => {
    const ext = getExt(file.name);
    if (!VALID_EXTENSIONS.includes(ext)) {
      addLog('error', `Invalid file type. Please upload .srt or .vtt.`);
      return false;
    }
    setIsLoading(true);
    try {
      const text = await file.text();
      ingestFile(file.name, file.size, text);
      return true;
    } catch (err) {
      addLog('error', `Failed to read "${file.name}": ${err.message}`);
      return false;
    } finally {
      setIsLoading(false);
    }
  }, [addLog, ingestFile]);

  // ─── Drag & drop handlers ───
  const handleDrag = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);

    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    handleFileObject(files[0]);
  }, [handleFileObject]);

  // ─── Click-to-browse: prefer Electron native dialog, fall back to <input> ───
  const handleBrowse = useCallback(async () => {
    const api = window.electronAPI;
    // Native dialog path (production / electron:dev)
    if (api?.fs?.showOpenDialog) {
      try {
        const result = await api.fs.showOpenDialog({
          title: 'Select a subtitle file',
          multiple: false,
          filters: [{ name: 'Subtitles', extensions: ['srt', 'vtt'] }],
        });
        if (!result.ok || result.paths.length === 0) {
          addLog('info', 'File selection cancelled.');
          return;
        }
        const filePath = result.paths[0];
        const readResult = await api.fs.readFileText(filePath);
        if (!readResult.ok) {
          addLog('error', `Failed to read file: ${readResult.error}`);
          return;
        }
        const baseName = filePath.split(/[\\/]/).pop();
        const sizeBytes = new Blob([readResult.data]).size;
        ingestFile(baseName, sizeBytes, readResult.data);
      } catch (err) {
        addLog('error', `Dialog error: ${err.message}`);
      }
      return;
    }
    // Fallback: hidden <input> (pure browser dev preview)
    fileInputRef.current?.click();
  }, [addLog, ingestFile]);

  const handleFileInput = useCallback((e) => {
    const file = e.target.files?.[0];
    if (file) handleFileObject(file);
    // Reset so selecting the same file again re-triggers onChange
    e.target.value = '';
  }, [handleFileObject]);

  // ─── Remove loaded file ───
  const handleRemove = useCallback(() => {
    setFileLoaded(false);
    setFileMeta(null);
    setRawContent('');
    setParsedText('');
    setOutputText('');
    addLog('info', 'Subtitle file removed.');
  }, [addLog]);

  // ─── Copy parsed text ───
  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(parsedText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      addLog('info', 'Parsed text copied to clipboard.');
    } catch {
      addLog('warning', 'Clipboard not available.');
    }
  }, [parsedText, addLog]);

  // ─── Start Intelligent Processing — calls the real LLM API ───
  const handleProcess = useCallback(async () => {
    if (!fileLoaded || !parsedText) {
      addLog('warning', 'No subtitle file loaded. Please drop a file first.');
      return;
    }

    // ─── Validate settings ───
    const { providerUrl, apiKey, modelName } = settings;
    if (!apiKey || !providerUrl) {
      addLog('error', 'API Key or Base URL is missing. Please check your Settings.');
      return;
    }

    // ─── Build prompts ───
    const systemPrompt = buildSystemPrompt(language, outputType);
    const userPrompt = buildUserPrompt(parsedText);
    const modeLabel = getFormatLabel(outputType);

    setIsProcessing(true);
    setOutputText('');
    setStreamWordCount(0);
    addLog('info', `Initiating AI processing using model "${modelName}" for "${modeLabel}" in ${language}...`);

    // ─── Create abort controller for cancellation ───
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const result = await callLLM({
        baseUrl: providerUrl,
        apiKey,
        model: modelName,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        stream: true,
        maxTokens: 4096,
        temperature: 0.7,
        signal: controller.signal,
        onChunk: (text) => {
          setOutputText(text);
          setStreamWordCount((text.match(/\S+/g) || []).length);
        },
      });

      if (result.ok) {
        const wordCount = (result.text.match(/\S+/g) || []).length;
        addLog('success', `AI Processing completed successfully. ~${wordCount} words generated.`);
      } else {
        addLog('error', `API Error: ${result.error}`);
      }
    } catch (err) {
      // Defensive: callLLM should catch its own errors, but guard against
      // any unexpected throw so the button never stays stuck.
      const msg = err?.name === 'AbortError' ? 'Processing cancelled.' : err.message;
      addLog('error', `API Error: ${msg}`);
    } finally {
      // Always reset loading state + abort ref, even on crash or cancel.
      abortRef.current = null;
      setIsProcessing(false);
    }
  }, [fileLoaded, parsedText, settings, outputType, language, addLog]);

  // ─── Cancel an in-progress API call ───
  const handleCancel = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
      setIsProcessing(false);
      addLog('info', 'AI processing cancelled by user.');
    }
  }, [addLog]);

  // ─── Copy AI output ───
  const handleCopyOutput = useCallback(async () => {
    if (!outputText) return;
    try {
      await navigator.clipboard.writeText(outputText);
      setOutputCopied(true);
      setTimeout(() => setOutputCopied(false), 1500);
      addLog('info', 'AI output copied to clipboard.');
    } catch {
      addLog('warning', 'Clipboard not available.');
    }
  }, [outputText, addLog]);

  return (
    <div className="max-w-6xl mx-auto space-y-6 animate-slide-up">
      {/* ─── Page Header ─── */}
      <div>
        <h1 className="text-2xl font-bold text-surface-100 flex items-center gap-3">
          <span className="w-8 h-8 rounded-lg bg-brand-600/20 flex items-center justify-center">
            <svg className="w-4.5 h-4.5 text-brand-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
            </svg>
          </span>
          Subtitle Processor
        </h1>
        <p className="text-sm text-surface-500 mt-1 ml-11">
          Upload subtitle files and transform them into structured, intelligent content.
        </p>
      </div>

      {/* ─── Drop Zone ─── */}
      {!fileLoaded ? (
        <div
          onDragEnter={handleDrag}
          onDragLeave={handleDrag}
          onDragOver={handleDrag}
          onDrop={handleDrop}
          onClick={handleBrowse}
          className={`relative rounded-2xl border-2 border-dashed transition-all duration-300 cursor-pointer
            ${dragActive
              ? 'border-brand-500 bg-brand-600/10 glow-md scale-[1.01]'
              : 'border-surface-700/60 bg-surface-900/30 hover:border-surface-600 hover:bg-surface-900/50'
            }
          `}
        >
          {/* Hidden input as browser fallback */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".srt,.vtt"
            onChange={handleFileInput}
            className="hidden"
          />
          <div className="flex flex-col items-center justify-center py-16 px-8">
            <div className={`w-16 h-16 rounded-2xl flex items-center justify-center mb-4 transition-all duration-300
              ${dragActive ? 'bg-brand-600/20' : 'bg-surface-800/60'}
            `}>
              {isLoading ? (
                <svg className="w-8 h-8 text-brand-400 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              ) : (
                <svg className={`w-8 h-8 transition-colors ${dragActive ? 'text-brand-400' : 'text-surface-500'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                </svg>
              )}
            </div>

            <h3 className="text-base font-semibold text-surface-200 mb-1">
              {isLoading ? 'Reading file...' : dragActive ? 'Drop your subtitle file here' : 'Drag & Drop subtitle files here'}
            </h3>
            <p className="text-sm text-surface-500 mb-4">
              or click to browse your files
            </p>

            <div className="flex items-center gap-2">
              <span className="px-2.5 py-1 rounded-md bg-surface-800/80 text-[11px] font-medium text-surface-400">
                .srt
              </span>
              <span className="px-2.5 py-1 rounded-md bg-surface-800/80 text-[11px] font-medium text-surface-400">
                .vtt
              </span>
            </div>
          </div>
        </div>
      ) : (
        <>
          {/* ─── File Info Bar ─── */}
          <div className="flex items-center justify-between p-3 rounded-xl bg-surface-900/60 border border-surface-800/40">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-emerald-500/15 flex items-center justify-center">
                <svg className="w-4 h-4 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <div>
                <p className="text-sm font-medium text-surface-200">{fileMeta.name}</p>
                <p className="text-[11px] text-surface-500">
                  Subtitle file loaded successfully
                </p>
              </div>
            </div>
            <button
              onClick={handleRemove}
              className="px-3 py-1.5 rounded-lg text-xs font-medium text-surface-400 hover:text-red-400 hover:bg-red-500/10 transition-colors"
            >
              Remove
            </button>
          </div>

          {/* ─── File Stats Bar ─── */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatChip label="Format" value={fileMeta.format} />
            <StatChip label="Cues" value={fileMeta.cues} />
            <StatChip label="Words" value={fileMeta.words} />
            <StatChip label="Duration" value={formatDuration(fileMeta.durationSec)} />
          </div>

          {/* ─── Configuration Panel ─── */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Output Type */}
            <div className="p-4 rounded-xl bg-surface-900/40 border border-surface-800/40">
              <label className="block text-xs font-semibold text-surface-400 uppercase tracking-wider mb-3">
                Output Type
              </label>
              <div className="space-y-2">
                {OUTPUT_TYPES.map(type => (
                  <button
                    key={type.id}
                    onClick={() => {
                      setOutputType(type.id);
                      addLog('info', `Output type changed to: ${type.label}`);
                    }}
                    className={`w-full text-left p-3 rounded-lg transition-all duration-200
                      ${outputType === type.id
                        ? 'bg-brand-600/15 border border-brand-500/30 glow-sm'
                        : 'bg-surface-800/30 border border-transparent hover:bg-surface-800/50'
                      }
                    `}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className={`w-3 h-3 rounded-full border-2 transition-colors
                          ${outputType === type.id ? 'border-brand-400 bg-brand-400' : 'border-surface-600'}
                        `} />
                        <span className={`text-sm font-medium ${outputType === type.id ? 'text-brand-300' : 'text-surface-300'}`}>
                          {type.label}
                        </span>
                        {type.id === 'lecture' && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-brand-500/20 text-brand-400 font-medium">
                            DEFAULT
                          </span>
                        )}
                      </div>
                    </div>
                    <p className="text-[11px] text-surface-500 mt-1 ml-6">{type.desc}</p>
                  </button>
                ))}
              </div>
            </div>

            {/* Language */}
            <div className="p-4 rounded-xl bg-surface-900/40 border border-surface-800/40">
              <label className="block text-xs font-semibold text-surface-400 uppercase tracking-wider mb-3">
                Target Language
              </label>
              <select
                value={language}
                onChange={(e) => {
                  setLanguage(e.target.value);
                  addLog('info', `Target language changed to: ${e.target.value}`);
                }}
                className="w-full bg-surface-800/60 border border-surface-700/50 rounded-lg px-3 py-2.5 text-sm text-surface-200
                  focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-brand-500/40
                  transition-all appearance-none cursor-pointer"
              >
                {LANGUAGES.map(lang => (
                  <option key={lang} value={lang}>{lang}</option>
                ))}
              </select>

              <div className="mt-3 p-3 rounded-lg bg-surface-800/30 border border-surface-700/30">
                <div className="flex items-center gap-2 mb-1">
                  <svg className="w-3.5 h-3.5 text-surface-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <span className="text-[11px] font-medium text-surface-400">Translation Info</span>
                </div>
                <p className="text-[11px] text-surface-500 leading-relaxed">
                  Content will be intelligently translated and formatted for {language}.
                  Academic terminology is preserved with contextual accuracy.
                </p>
              </div>
            </div>
          </div>

          {/* ─── Process Button / Cancel ─── */}
          <button
            onClick={isProcessing ? handleCancel : handleProcess}
            className={`w-full py-3.5 rounded-xl font-semibold text-sm transition-all duration-300 flex items-center justify-center gap-2
              ${isProcessing
                ? 'bg-red-600/30 text-red-300 hover:bg-red-600/40 border border-red-500/30'
                : 'bg-gradient-to-r from-brand-600 to-purple-600 text-white hover:from-brand-500 hover:to-purple-500 glow-md hover:glow-lg active:scale-[0.99]'
              }
            `}
          >
            {isProcessing ? (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 10a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z" />
                </svg>
                Cancel Processing
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
                Start Intelligent Processing
              </>
            )}
          </button>

          {/* ─── Side-by-Side Panels ─── */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Source Panel — the reading interface */}
            <div className="rounded-xl bg-surface-900/40 border border-surface-800/40 overflow-hidden flex flex-col">
              <div className="flex items-center justify-between px-4 py-2.5 border-b border-surface-800/40 bg-surface-900/60">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-sky-400" />
                  <span className="text-xs font-semibold text-surface-300">Source Text</span>
                  <span className="text-[10px] font-mono text-surface-600">CLEAN PARSED</span>
                </div>
                <button
                  onClick={handleCopy}
                  className={`text-[10px] font-medium transition-colors flex items-center gap-1 ${copied ? 'text-emerald-400' : 'text-brand-400 hover:text-brand-300'}`}
                >
                  {copied ? (
                    <>
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
                      </svg>
                      Copied
                    </>
                  ) : (
                    <>
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                      Copy
                    </>
                  )}
                </button>
              </div>
              <div className="p-5 h-72 overflow-y-auto text-sm leading-7 text-surface-200 prose-invert">
                {parsedText ? (
                  parsedText.split(/\n\n+/).map((para, i) => (
                    <p key={i} className="mb-3 last:mb-0">{para}</p>
                  ))
                ) : (
                  <p className="text-surface-600 italic">No content parsed from this file.</p>
                )}
              </div>
            </div>

            {/* Output Panel — Markdown rendered */}
            <div className="rounded-xl bg-surface-900/40 border border-surface-800/40 overflow-hidden flex flex-col">
              <div className="flex items-center justify-between px-4 py-2.5 border-b border-surface-800/40 bg-surface-900/60">
                <div className="flex items-center gap-2">
                  <div className={`w-2 h-2 rounded-full ${isProcessing ? 'bg-amber-400 animate-pulse' : outputText ? 'bg-emerald-400' : 'bg-surface-600'}`} />
                  <span className="text-xs font-semibold text-surface-300">AI Output</span>
                  {streamWordCount > 0 && (
                    <span className="text-[10px] font-mono text-surface-600">
                      ~{streamWordCount} words
                    </span>
                  )}
                </div>
                {outputText && !isProcessing && (
                  <button
                    onClick={handleCopyOutput}
                    className={`text-[10px] font-medium transition-colors flex items-center gap-1 ${outputCopied ? 'text-emerald-400' : 'text-brand-400 hover:text-brand-300'}`}
                  >
                    {outputCopied ? (
                      <>
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
                        </svg>
                        Copied
                      </>
                    ) : (
                      <>
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                        </svg>
                        Copy
                      </>
                    )}
                  </button>
                )}
              </div>
              <div className="flex-1 p-5 h-72 overflow-y-auto text-sm leading-7 text-surface-200 ai-output-content">
                {isProcessing && !outputText ? (
                  <div className="flex items-center gap-2 text-surface-500">
                    <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    Connecting to AI...
                  </div>
                ) : outputText ? (
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{outputText}</ReactMarkdown>
                ) : (
                  <div className="flex flex-col items-center justify-center h-full text-surface-600">
                    <svg className="w-8 h-8 mb-2 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                    </svg>
                    <span className="text-xs">AI output will appear here</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/* ─── Small stat chip for the file info bar ─── */
function StatChip({ label, value }) {
  return (
    <div className="px-4 py-3 rounded-xl bg-surface-900/40 border border-surface-800/40">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-surface-500">{label}</p>
      <p className="text-lg font-bold text-surface-100 mt-0.5">{value}</p>
    </div>
  );
}
