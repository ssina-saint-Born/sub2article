import React, { useState, useEffect } from 'react';
import { useLog } from '../../contexts/LogContext';
import { useSettings } from '../../hooks/useSettings';
import { useCloudStorage } from '../../hooks/useCloudStorage';
import bridge from '../../utils/bridge';
import { isElectron } from '../../utils/env';

const PRESETS = [
  { name: 'OpenAI GPT-4o', url: 'https://api.openai.com/v1', model: 'gpt-4o' },
  { name: 'Claude Sonnet', url: 'https://api.anthropic.com/v1', model: 'claude-3-5-sonnet-20241022' },
  { name: 'Ollama Local', url: 'http://localhost:11434/v1', model: 'llama3' },
  { name: 'Gemini Pro', url: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-1.5-pro' },
];

export default function Settings() {
  const { addLog } = useLog();
  const { settings, updateMany, resetSettings } = useSettings();
  // Cloud OAuth state (Google Drive & Dropbox) comes from the secure Electron
  // store via useCloudStorage — not from localStorage. The hook also handles
  // connect/disconnect with full System Console logging.
  const { states: cloud, connect: cloudConnect, disconnect: cloudDisconnect } = useCloudStorage();

  // ─── Local form state (fields the user is editing) ───
  // These track the form inputs. They initialize from persisted settings,
  // but are NOT saved back until the user clicks "Save Settings".
  const [providerUrl, setProviderUrl] = useState(settings.providerUrl);
  const [apiKey, setApiKey] = useState(settings.apiKey);
  const [modelName, setModelName] = useState(settings.modelName);
  const [showKey, setShowKey] = useState(false);
  const [saved, setSaved] = useState(false);

  // ─── Cloud Storage Integrations form state ───
  // OAuth providers (Google Drive, Dropbox) no longer keep tokens in this
  // component — `useCloudStorage()` above owns that (secure Electron store).
  // Mega & WebDAV still use plain credential fields pending their own Task.
  const [megaEmail, setMegaEmail] = useState(settings.megaEmail);
  const [megaPassword, setMegaPassword] = useState(settings.megaPassword);
  const [webdavUrl, setWebdavUrl] = useState(settings.webdavUrl);
  const [webdavUser, setWebdavUser] = useState(settings.webdavUser);
  const [webdavPassword, setWebdavPassword] = useState(settings.webdavPassword);
  const [showMegaPassword, setShowMegaPassword] = useState(false);
  const [showWebdavPassword, setShowWebdavPassword] = useState(false);

  // ─── Detect unsaved changes (for UI hint) ───
  // OAuth providers were removed from this list: their tokens live in the
  // secure store and connection state is managed immediately by useCloudStorage
  // (no "Save Settings" dependency), so they no longer participate here.
  const hasUnsavedChanges =
    providerUrl !== settings.providerUrl ||
    apiKey !== settings.apiKey ||
    modelName !== settings.modelName ||
    megaEmail !== settings.megaEmail ||
    megaPassword !== settings.megaPassword ||
    webdavUrl !== settings.webdavUrl ||
    webdavUser !== settings.webdavUser ||
    webdavPassword !== settings.webdavPassword;

  // ─── Save handler: validates, persists, and logs ───
  const handleSave = () => {
    if (!providerUrl.trim()) {
      addLog('error', 'Provider Base URL cannot be empty.');
      return;
    }
    if (!apiKey.trim()) {
      addLog('warning', 'API Key is empty. Processing will not work without a valid key.');
    }

    // Persist non-sensitive settings to localStorage via the hook. OAuth
    // connected/account mirrors are NOT written here — useCloudStorage owns
    // them and updates them live during connect/disconnect.
    updateMany({
      providerUrl: providerUrl.trim(),
      apiKey: apiKey.trim(),
      modelName: modelName.trim(),
      megaEmail: megaEmail.trim(),
      megaPassword: megaPassword.trim(),
      webdavUrl: webdavUrl.trim(),
      webdavUser: webdavUser.trim(),
      webdavPassword: webdavPassword.trim(),
    });

    // Mask the key for logging
    const maskedKey = apiKey.trim()
      ? `${apiKey.substring(0, 6)}${'*'.repeat(Math.max(0, apiKey.length - 6))}`
      : '(empty)';

    addLog('success', 'Configuration saved successfully.');
    addLog('info', `Provider: ${providerUrl.trim()} | Model: ${modelName.trim()} | Key: ${maskedKey}`);

    const cloudConfigured = [
      cloud.googleDrive.connected && 'Google Drive',
      cloud.dropbox.connected && 'Dropbox',
      (megaEmail.trim() || megaPassword.trim()) && 'Mega',
      (webdavUrl.trim() || webdavUser.trim() || webdavPassword.trim()) && 'WebDAV',
    ].filter(Boolean);
    if (cloudConfigured.length) {
      addLog('info', `Cloud storage configured: ${cloudConfigured.join(', ')}.`);
    }

    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  // ─── Reset handler: clears form + persisted state ───
  const handleReset = () => {
    resetSettings();
    setProviderUrl('https://api.openai.com/v1');
    setApiKey('');
    setModelName('gpt-4o');
    // OAuth connection state is NOT reset here — it's managed independently
    // by useCloudStorage and survives a settings reset by design.
    setMegaEmail('');
    setMegaPassword('');
    setWebdavUrl('');
    setWebdavUser('');
    setWebdavPassword('');
    addLog('info', 'Settings reset to defaults. Remember to click Save to persist.');
  };

  // ─── OAuth connect/disconnect ───
  // Real Task 8 implementation: delegates to useCloudStorage, which runs the
  // loopback OAuth flow in the main process and updates both its own state
  // and the settings mirror. All success/failure/progress goes to useLog().
  // The provider display name ('Google Drive' | 'Dropbox') maps to the
  // canonical secure-store key inside useCloudStorage.PROVIDERS.
  const providerToKey = { 'Google Drive': 'googleDrive', 'Dropbox': 'dropbox' };
  const handleOAuthConnect = (provider) => cloudConnect(providerToKey[provider] || provider);
  const handleOAuthDisconnect = (provider) => cloudDisconnect(providerToKey[provider] || provider);

  // ─── Preset handler: fills the form fields only (does NOT persist) ───
  const applyPreset = (preset) => {
    setProviderUrl(preset.url);
    setModelName(preset.model);
    addLog('info', `Preset "${preset.name}" applied. Click "Save Settings" to persist.`);
  };

  // ─── External link handler ───
  // In the Electron build, a plain `<a target="_blank">` would load the URL
  // INSIDE our frameless app window. We route through the preload bridge
  // (shell.openExternal) so http(s) links open in the user's default browser.
  // In the web build, `bridge.app.openExternal` falls back to a browser
  // `window.open()` itself and returns { ok:true } — so we DON'T also call
  // `window.open` here. The secondary fallback below runs only on desktop,
  // when shell.openExternal itself rejected.
  const openExternalLink = async (e, url) => {
    e.preventDefault();
    try {
      const res = await bridge.app.openExternal(url);
      if (res?.ok) return;
      if (res?.error) addLog('warning', `Could not open link: ${res.error}`);
      // Desktop-only safety net: shell.openExternal failed, bail to a tab.
      if (isElectron()) window.open(url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      addLog('warning', `Could not open link: ${err.message || 'unknown error'}`);
      if (isElectron()) window.open(url, '_blank', 'noopener,noreferrer');
    }
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

      {/* ─── Cloud Storage Integrations Card ─── */}
      <div className="rounded-xl bg-surface-900/40 border border-surface-800/40 overflow-hidden">
        <div className="flex items-center gap-2 px-5 py-3 border-b border-surface-800/40 bg-surface-900/60">
          <div className="w-2 h-2 rounded-full bg-sky-400" />
          <span className="text-xs font-semibold text-surface-300">
            Cloud Storage Integrations · اتصال به فضاهای ابری
          </span>
        </div>

        <div className="p-5 space-y-6">
          <p className="text-[11px] text-surface-500 -mt-2">
            Connect your cloud storage accounts to enable direct uploads of generated articles.
            Credentials are stored locally on your device only and are never transmitted externally
            outside of their respective providers.
          </p>
          {/* Credential-file status (helps first-time setup) */}
          {!cloud.googleDrive.connected && !cloud.dropbox.connected && (
            <p className="text-[10px] text-amber-400/80 flex items-center gap-1.5">
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 15.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
              Configure <span className="font-mono">electron/cloud/cloud.providers.json</span> to enable cloud upload.
            </p>
          )}

          {/* Google Drive — OAuth */}
          <OAuthCard
            provider='Google Drive'
            connected={cloud.googleDrive.connected}
            account={cloud.googleDrive.account}
            busy={cloud.googleDrive.busy}
            onConnect={() => handleOAuthConnect('Google Drive')}
            onDisconnect={() => handleOAuthDisconnect('Google Drive')}
            icon={
              <svg className="w-3.5 h-3.5 text-sky-400" viewBox="0 0 24 24" fill="currentColor">
                <path d="M7.71 3.5L1.15 15l3.28 5.5h11.72L19.43 15 12.87 3.5H7.71zM12 18H6.6l2.7-4.5L12 18zm6.84-3l-2.7-4.5L8.7 6h5.4l5.74 9z" />
              </svg>
            }
            iconColor="bg-sky-500/15 text-sky-400"
            description="Upload articles directly to your Google Drive. Requires OAuth 2.0 authorization."
          />

          {/* Dropbox — OAuth */}
          <OAuthCard
            provider='Dropbox'
            connected={cloud.dropbox.connected}
            account={cloud.dropbox.account}
            busy={cloud.dropbox.busy}
            onConnect={() => handleOAuthConnect('Dropbox')}
            onDisconnect={() => handleOAuthDisconnect('Dropbox')}
            icon={
              <svg className="w-3.5 h-3.5 text-blue-400" viewBox="0 0 24 24" fill="currentColor">
                <path d="M7 2L2 5.25 7 8.5l5-3.25L7 2zm10 0l-5 3.25 5 3.25 5-3.25L17 2zM2 12.75L7 16l5-3.25L7 9.5l-5 3.25zm15-3.25l-5 3.25 5 3.25 5-3.25-5-3.25zM7.25 17.5l5 3.25 5-3.25-5-3.25-5 3.25z" />
              </svg>
            }
            iconColor="bg-blue-500/15 text-blue-400"
            description="Upload articles directly to your Dropbox. Requires OAuth 2.0 authorization."
          />

          {/* Mega — standard auth */}
          <div className="rounded-lg bg-surface-800/30 border border-surface-700/40 p-4 space-y-3">
            <div className="flex items-center gap-2">
              <span className="w-6 h-6 rounded-md bg-rose-500/15 flex items-center justify-center">
                <svg className="w-3.5 h-3.5 text-rose-400" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 2l9 5v10l-9 5-9-5V7l9-5zM6 8v3l4-2v9h2V8H6zm12 0l-4 3v2l4-2v8h2V8h-2z" />
                </svg>
              </span>
              <h4 className="text-sm font-semibold text-surface-200">Mega</h4>
            </div>
            <CloudInput
              label="Email"
              type="email"
              value={megaEmail}
              onChange={(e) => setMegaEmail(e.target.value)}
              placeholder="your.email@example.com"
              hint="The email registered to your Mega account."
            />
            <CloudInput
              label="Password"
              type={showMegaPassword ? 'text' : 'password'}
              value={megaPassword}
              onChange={(e) => setMegaPassword(e.target.value)}
              placeholder="••••••••••••"
              secret
              showSecret={showMegaPassword}
              onToggleSecret={() => setShowMegaPassword(!showMegaPassword)}
              hint="Your Mega account password. Used with the email above for login."
            />
          </div>

          {/* WebDAV (Apple iCloud) — standard auth */}
          <div className="rounded-lg bg-surface-800/30 border border-surface-700/40 p-4 space-y-3">
            <div className="flex items-center gap-2">
              <span className="w-6 h-6 rounded-md bg-purple-500/15 flex items-center justify-center">
                <svg className="w-3.5 h-3.5 text-purple-400" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 2a4 4 0 014 4v1h1a3 3 0 013 3v2a3 3 0 01-3 3h-1v1a4 4 0 01-8 0v-1H7a3 3 0 01-3-3v-2a3 3 0 013-3h1V6a4 4 0 014-4zm0 2a2 2 0 00-2 2v1h4V6a2 2 0 00-2-2z" />
                </svg>
              </span>
              <h4 className="text-sm font-semibold text-surface-200">WebDAV · Apple iCloud</h4>
            </div>
            <CloudInput
              label="Server URL"
              type="url"
              value={webdavUrl}
              onChange={(e) => setWebdavUrl(e.target.value)}
              placeholder="https://icloud.com/webdav"
              hint="The full WebDAV endpoint URL (e.g., iCloud's WebDAV server address)."
            />
            <CloudInput
              label="Username / Apple ID"
              type="text"
              value={webdavUser}
              onChange={(e) => setWebdavUser(e.target.value)}
              placeholder="your.apple.id@icloud.com"
              hint="The username used to authenticate against the WebDAV server."
            />
            <CloudInput
              label="Password / App-Specific Password"
              type={showWebdavPassword ? 'text' : 'password'}
              value={webdavPassword}
              onChange={(e) => setWebdavPassword(e.target.value)}
              placeholder="••••••••••••"
              secret
              showSecret={showWebdavPassword}
              onToggleSecret={() => setShowWebdavPassword(!showWebdavPassword)}
              hint="WebDAV password. For iCloud, generate an app-specific password from your Apple ID account."
            />
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

          {/* ─── Brand attribution footer (Phase 4, Task 10) ─── */}
          {/* Persian RTL text wrapping a hyperlinked brand name. The link is
              routed through openExternalLink() so it opens in the OS browser
              rather than hijacking the frameless app window. The `dir="rtl"`
              span keeps the Persian glyphs + embedded LTR link visually tidy. */}
          <div className="mt-4 pt-4 border-t border-surface-800/40">
            <span dir="rtl" className="flex items-center justify-center gap-1.5 text-[11px] text-surface-500">
              ساخته شده توسط
              <a
                href="https://rayomandtech.ir"
                onClick={(e) => openExternalLink(e, 'https://rayomandtech.ir')}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-surface-400 hover:text-blue-500 transition-colors duration-200 underline-offset-2 hover:underline"
              >
                Rayomand Technology
              </a>
            </span>
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

/* ─── Reusable OAuth Card Component ─── */
/* Premium status card for OAuth-based providers (Google Drive, Dropbox).
   Renders the provider icon, a Connected/Not Connected badge, the connected
   account's email (post-auth), and a Connect/Disconnect button with a busy
   spinner. The OAuth 2.0 flow itself lives in useCloudStorage + the Electron
   main process; this component only reflects that state. */
function OAuthCard({ provider, connected, account, busy, onConnect, onDisconnect, icon, iconColor, description }) {
  return (
    <div className="rounded-lg bg-surface-800/30 border border-surface-700/40 p-4">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <span className={`w-9 h-9 rounded-md flex items-center justify-center shrink-0 ${iconColor}`}>
            {icon}
          </span>
          <div className="min-w-0">
            <h4 className="text-sm font-semibold text-surface-200">{provider}</h4>
            <p className="text-[11px] text-surface-500 mt-0.5 truncate">{description}</p>
            {/* Connected account label — hydrated from the secure store. */}
            {connected && account?.email ? (
              <p className="text-[10px] text-surface-600 mt-0.5 truncate">Connected as {account.email}</p>
            ) : null}
          </div>
        </div>

        {/* Status badge */}
        <span
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium shrink-0 ${
            connected
              ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-400'
              : 'bg-surface-700/40 border border-surface-600/40 text-surface-400'
          }`}
        >
          <span
            className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-emerald-400' : 'bg-surface-500'}`}
          />
          {connected ? 'Connected' : 'Not Connected'}
        </span>
      </div>

      {/* Action button */}
      <div className="mt-3 pt-3 border-t border-surface-700/30">
        {connected ? (
          <button
            onClick={onDisconnect}
            disabled={busy}
            className="w-full py-2 rounded-lg text-xs font-semibold text-rose-300 bg-rose-500/10 border border-rose-500/30
              hover:bg-rose-500/20 hover:border-rose-500/40 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-1.5"
          >
            {busy ? (
              <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
              </svg>
            ) : (
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            )}
            {busy ? 'Disconnecting…' : 'Disconnect'}
          </button>
        ) : (
          <button
            onClick={onConnect}
            disabled={busy}
            className="w-full py-2 rounded-lg text-xs font-semibold text-surface-100 bg-surface-700/40 border border-surface-600/40
              hover:bg-surface-700/60 hover:border-surface-500/50 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-1.5"
          >
            {busy ? (
              <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
              </svg>
            ) : (
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            )}
            {busy ? 'Waiting for sign-in…' : `Connect to ${provider}`}
          </button>
        )}
      </div>
    </div>
  );
}

/* ─── Reusable Cloud Input Component ─── */
/* Matches the AI Provider input styling. The `secret` prop enables the
   Show/Hide toggle for password-style fields, identical to the API Key field. */
function CloudInput({ label, type, value, onChange, placeholder, hint, secret, showSecret, onToggleSecret }) {
  return (
    <div>
      <label className="block text-xs font-semibold text-surface-400 uppercase tracking-wider mb-2">
        {label}
      </label>
      <div className="relative">
        <input
          type={type}
          value={value}
          onChange={onChange}
          placeholder={placeholder}
          className="w-full bg-surface-800/50 border border-surface-700/50 rounded-lg px-4 py-2.5 text-sm text-surface-200 placeholder-surface-600 font-mono
            focus:outline-none focus:ring-2 focus:ring-sky-500/40 focus:border-sky-500/40 transition-all"
        />
        {secret && (
          <button
            onClick={onToggleSecret}
            className="absolute right-2 top-1/2 -translate-y-1/2 px-2.5 py-1 rounded-md text-[11px] font-medium text-surface-400 hover:text-surface-200 hover:bg-surface-700/50 transition-colors"
          >
            {showSecret ? 'Hide' : 'Show'}
          </button>
        )}
      </div>
      {hint && <p className="text-[11px] text-surface-500 mt-1.5 ml-1">{hint}</p>}
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
