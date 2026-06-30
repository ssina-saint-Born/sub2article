import React, { useState, useEffect } from 'react';
import { useLog } from '../../contexts/LogContext';
import { useSettings } from '../../hooks/useSettings';

const PRESETS = [
  { name: 'OpenAI GPT-4o', url: 'https://api.openai.com/v1', model: 'gpt-4o' },
  { name: 'Claude Sonnet', url: 'https://api.anthropic.com/v1', model: 'claude-3-5-sonnet-20241022' },
  { name: 'Ollama Local', url: 'http://localhost:11434/v1', model: 'llama3' },
  { name: 'Gemini Pro', url: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-1.5-pro' },
];

export default function Settings() {
  const { addLog } = useLog();
  const { settings, updateMany, resetSettings } = useSettings();

  // ─── Local form state (fields the user is editing) ───
  // These track the form inputs. They initialize from persisted settings,
  // but are NOT saved back until the user clicks "Save Settings".
  const [providerUrl, setProviderUrl] = useState(settings.providerUrl);
  const [apiKey, setApiKey] = useState(settings.apiKey);
  const [modelName, setModelName] = useState(settings.modelName);
  const [showKey, setShowKey] = useState(false);
  const [saved, setSaved] = useState(false);

  // ─── Detect unsaved changes (for UI hint) ───
  const hasUnsavedChanges =
    providerUrl !== settings.providerUrl ||
    apiKey !== settings.apiKey ||
    modelName !== settings.modelName;

  // ─── Save handler: validates, persists, and logs ───
  const handleSave = () => {
    if (!providerUrl.trim()) {
      addLog('error', 'Provider Base URL cannot be empty.');
      return;
    }
    if (!apiKey.trim()) {
      addLog('warning', 'API Key is empty. Processing will not work without a valid key.');
    }

    // Persist to localStorage via the hook
    updateMany({ providerUrl: providerUrl.trim(), apiKey: apiKey.trim(), modelName: modelName.trim() });

    // Mask the key for logging
    const maskedKey = apiKey.trim()
      ? `${apiKey.substring(0, 6)}${'*'.repeat(Math.max(0, apiKey.length - 6))}`
      : '(empty)';

    addLog('success', 'Configuration saved successfully.');
    addLog('info', `Provider: ${providerUrl.trim()} | Model: ${modelName.trim()} | Key: ${maskedKey}`);

    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  // ─── Reset handler: clears form + persisted state ───
  const handleReset = () => {
    resetSettings();
    setProviderUrl('https://api.openai.com/v1');
    setApiKey('');
    setModelName('gpt-4o');
    addLog('info', 'Settings reset to defaults. Remember to click Save to persist.');
  };

  // ─── Preset handler: fills the form fields only (does NOT persist) ───
  const applyPreset = (preset) => {
    setProviderUrl(preset.url);
    setModelName(preset.model);
    addLog('info', `Preset "${preset.name}" applied. Click "Save Settings" to persist.`);
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6 animate-slide-up">
      {/* ─── Page Header ─── */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-surface-100 flex items-center gap-3">
            <span className="w-8 h-8 rounded-lg bg-amber-600/20 flex items-center justify-center">
              <svg className="w-4.5 h-4.5 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </span>
            Settings
          </h1>
          <p className="text-sm text-surface-500 mt-1 ml-11">
            Configure your AI provider, API credentials, and application preferences.
          </p>
        </div>
        {/* ─── Unsaved changes indicator ─── */}
        {hasUnsavedChanges && (
          <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-amber-500/10 border border-amber-500/30 text-[11px] font-medium text-amber-400 animate-fade-in">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
            Unsaved changes
          </span>
        )}
      </div>

      {/* ─── API Configuration Card ─── */}
      <div className="rounded-xl bg-surface-900/40 border border-surface-800/40 overflow-hidden">
        <div className="flex items-center gap-2 px-5 py-3 border-b border-surface-800/40 bg-surface-900/60">
          <div className="w-2 h-2 rounded-full bg-brand-400" />
          <span className="text-xs font-semibold text-surface-300">AI Provider Configuration</span>
        </div>

        <div className="p-5 space-y-5">
          {/* Provider Base URL */}
          <div>
            <label className="block text-xs font-semibold text-surface-400 uppercase tracking-wider mb-2">
              Provider Base URL
            </label>
            <input
              type="url"
              value={providerUrl}
              onChange={(e) => setProviderUrl(e.target.value)}
              placeholder="https://api.openai.com/v1"
              className="w-full bg-surface-800/50 border border-surface-700/50 rounded-lg px-4 py-2.5 text-sm text-surface-200 placeholder-surface-600
                focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-brand-500/40 transition-all"
            />
            <p className="text-[11px] text-surface-500 mt-1.5 ml-1">
              The base URL of your AI provider's API (OpenAI, Anthropic, Ollama, etc.)
            </p>
          </div>

          {/* API Key */}
          <div>
            <label className="block text-xs font-semibold text-surface-400 uppercase tracking-wider mb-2">
              API Key
            </label>
            <div className="relative">
              <input
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                className="w-full bg-surface-800/50 border border-surface-700/50 rounded-lg px-4 py-2.5 pr-20 text-sm text-surface-200 placeholder-surface-600 font-mono
                  focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-brand-500/40 transition-all"
              />
              <button
                onClick={() => setShowKey(!showKey)}
                className="absolute right-2 top-1/2 -translate-y-1/2 px-2.5 py-1 rounded-md text-[11px] font-medium text-surface-400 hover:text-surface-200 hover:bg-surface-700/50 transition-colors"
              >
                {showKey ? 'Hide' : 'Show'}
              </button>
            </div>
            <p className="text-[11px] text-surface-500 mt-1.5 ml-1">
              Your secret API key. Stored locally and never shared. Leave empty for local models (e.g., Ollama).
            </p>
          </div>

          {/* Model Name */}
          <div>
            <label className="block text-xs font-semibold text-surface-400 uppercase tracking-wider mb-2">
              Model Name
            </label>
            <input
              type="text"
              value={modelName}
              onChange={(e) => setModelName(e.target.value)}
              placeholder="gpt-4o"
              className="w-full bg-surface-800/50 border border-surface-700/50 rounded-lg px-4 py-2.5 text-sm text-surface-200 placeholder-surface-600 font-mono
                focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-brand-500/40 transition-all"
            />
            <p className="text-[11px] text-surface-500 mt-1.5 ml-1">
              The model identifier (e.g., gpt-4o, claude-3-5-sonnet, llama3, gemini-pro)
            </p>
          </div>

          {/* Quick presets */}
          <div>
            <label className="block text-xs font-semibold text-surface-400 uppercase tracking-wider mb-2">
              Quick Presets
            </label>
            <div className="flex flex-wrap gap-2">
              {PRESETS.map(preset => (
                <button
                  key={preset.name}
                  onClick={() => applyPreset(preset)}
                  className="px-3 py-1.5 rounded-lg bg-surface-800/40 border border-surface-700/30 text-xs font-medium text-surface-400 hover:text-surface-200 hover:bg-surface-800/60 hover:border-surface-600/40 transition-all"
                >
                  {preset.name}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-surface-600 mt-2 ml-1">
              Presets fill the form — click "Save Settings" to persist them.
            </p>
          </div>
        </div>
      </div>

      {/* ─── Application Preferences ─── */}
      <div className="rounded-xl bg-surface-900/40 border border-surface-800/40 overflow-hidden">
        <div className="flex items-center gap-2 px-5 py-3 border-b border-surface-800/40 bg-surface-900/60">
          <div className="w-2 h-2 rounded-full bg-emerald-400" />
          <span className="text-xs font-semibold text-surface-300">Application Preferences</span>
        </div>

        <div className="p-5 space-y-4">
          <SettingToggle
            label="Dark Mode"
            description="Application always runs in dark mode for reduced eye strain."
            checked={true}
            disabled={true}
          />
          <SettingToggle
            label="Auto-save Output"
            description="Automatically save generated output to the default export folder."
            checked={settings.autoSave}
            onChange={(v) => {
              updateMany({ autoSave: v });
              addLog('info', `Auto-save Output ${v ? 'enabled' : 'disabled'}.`);
            }}
          />
          <SettingToggle
            label="System Notifications"
            description="Show desktop notifications when processing is complete."
            checked={settings.notifications}
            onChange={(v) => {
              updateMany({ notifications: v });
              addLog('info', `System Notifications ${v ? 'enabled' : 'disabled'}.`);
            }}
          />
        </div>
      </div>

      {/* ─── About Card ─── */}
      <div className="rounded-xl bg-surface-900/40 border border-surface-800/40 overflow-hidden">
        <div className="flex items-center gap-2 px-5 py-3 border-b border-surface-800/40 bg-surface-900/60">
          <div className="w-2 h-2 rounded-full bg-surface-500" />
          <span className="text-xs font-semibold text-surface-300">About</span>
        </div>
        <div className="p-5">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-brand-500 to-purple-500 flex items-center justify-center shrink-0">
              <span className="text-lg font-bold text-white">S</span>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-surface-200">SubScribe AI</h3>
              <p className="text-[11px] text-surface-500">Version 1.0.0 • Built with Electron + React + Tailwind CSS</p>
              <p className="text-[11px] text-surface-600 mt-0.5">
                Intelligent subtitle processing and image OCR for content creators.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* ─── Action Buttons ─── */}
      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          className={`flex-1 py-3 rounded-xl font-semibold text-sm transition-all duration-300 flex items-center justify-center gap-2
            ${saved
              ? 'bg-emerald-600/30 text-emerald-300'
              : 'bg-gradient-to-r from-brand-600 to-purple-600 text-white hover:from-brand-500 hover:to-purple-500 glow-md hover:glow-lg active:scale-[0.99]'
            }
          `}
        >
          {saved ? (
            <>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
              </svg>
              Saved Successfully!
            </>
          ) : (
            <>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
              </svg>
              Save Settings
            </>
          )}
        </button>

        <button
          onClick={handleReset}
          className="px-6 py-3 rounded-xl font-semibold text-sm text-surface-400 bg-surface-800/40 border border-surface-700/40 hover:text-surface-200 hover:bg-surface-800/60 transition-all"
        >
          Reset Defaults
        </button>
      </div>
    </div>
  );
}

/* ─── Reusable Toggle Component ─── */
function SettingToggle({ label, description, checked, onChange, disabled }) {
  return (
    <div className={`flex items-center justify-between p-3 rounded-lg transition-colors ${disabled ? 'opacity-50' : 'hover:bg-surface-800/30'}`}>
      <div className="flex-1 mr-4">
        <p className="text-sm font-medium text-surface-300">{label}</p>
        <p className="text-[11px] text-surface-500 mt-0.5">{description}</p>
      </div>
      <button
        onClick={() => !disabled && onChange(!checked)}
        disabled={disabled}
        className={`relative rounded-full transition-all duration-200 shrink-0 ${checked ? 'bg-brand-600' : 'bg-surface-700'}`}
        style={{ width: 40, height: 22 }}
      >
        <span
          className={`absolute top-0.5 left-0.5 rounded-full bg-white shadow-sm transition-transform duration-200 ${checked ? 'translate-x-[18px]' : 'translate-x-0'}`}
          style={{ width: 16, height: 16 }}
        />
      </button>
    </div>
  );
}
