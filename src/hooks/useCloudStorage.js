import { useState, useEffect, useCallback, useRef } from 'react';
import { useLog } from '../contexts/LogContext';
import { useSettings } from './useSettings';
import bridge from '../utils/bridge';

/**
 * useCloudStorage — the single frontend source of truth for Google Drive /
 * Dropbox connection state.
 *
 * Every call goes through src/utils/bridge.js, which picks the right impl:
 *   • Electron  → the real preload API (window.electronAPI), driving the
 *                  desktop loopback OAuth flow via Node http on :8765 and
 *                  storing tokens encrypted via the OS keychain (safeStorage).
 *   • Web       → the Implicit Grant OAuth flow in src/utils/webAuth.js,
 *                  storing access tokens in localStorage (no client secret
 *                  ships in the JS bundle), and uploading via plain fetch
 *                  against the providers' REST endpoints.
 *
 * In both modes, the hook:
 *   - Owns per-provider runtime state (connected / account / busy).
 *   - Mirrors { connected, account } into useSettings so the Settings badge
 *     can rehydrate instantly before the first wire IPC/fetch round-trip.
 *   - Surfaces OAuth connect/disconnect progress and errors via the
 *     System Console's addLog.
 *
 * The desktop's safeStorage-encrypted token blob and the web's
 * localStorage map use the SAME logical shape:
 *   { access_token, expiry_date, _account: { email, name } }
 * so nothing else in the app needs to know which store is in use.
 */

// Canonical provider keys used across IPC, secure store, and settings mirror.
const PROVIDERS = {
  googleDrive: {
    label: 'Google Drive',
    connectedKey: 'googleDriveConnected',
    accountKey: 'googleDriveAccount',
  },
  dropbox: {
    label: 'Dropbox',
    connectedKey: 'dropboxConnected',
    accountKey: 'dropboxAccount',
  },
};

/** Humanize the raw provider key for console logs. */
function labelFor(provider) {
  return PROVIDERS[provider]?.label || provider;
}

/**
 * Read the cloud bridge. In Electron this returns the real preload API; in
 * web mode it returns the mocking proxy from src/utils/bridge.js, whose
 * methods resolve `{ ok, ... }` so the hook's existing `if (!res?.ok)`
 * branches surface the desktop-only message — never throws.
 */
function cloudBridge() {
  return bridge.cloud;
}

export function useCloudStorage() {
  const { addLog } = useLog();
  const { updateMany } = useSettings();

  // Per-provider runtime state. `busy` drives the button spinner/disable;
  // `connected` + `account` are mirrored from the main-process secure store.
  const [states, setStates] = useState({
    googleDrive: { connected: false, account: null, busy: false },
    dropbox: { connected: false, account: null, busy: false },
  });

  // Throttle upload-progress logs so a fast resumable upload doesn't flood
  // the System Console with one entry per network tick.
  const lastProgressRef = useRef(0);

  const setProvider = useCallback((provider, patch) => {
    setStates((prev) => ({ ...prev, [provider]: { ...prev[provider], ...patch } }));
  }, []);

  // Mirror "connected + account label" into useSettings so the badge survives
  // an app restart without re-hitting the main process (or decrypting tokens).
  const mirrorToSettings = useCallback((provider, { connected, account }) => {
    const p = PROVIDERS[provider];
    if (!p) return;
    updateMany({
      [p.connectedKey]: Boolean(connected),
      [p.accountKey]: account?.email || account?.name || '',
    });
  }, [updateMany]);

  // ─── Hydrate from the main-process secure store on mount ───
  useEffect(() => {
    let cancelled = false;
    cloudBridge().isEncryptionAvailable().then((res) => {
      if (cancelled || !res?.ok) return;
      if (res.available === false) {
        addLog('warning', 'OS keychain unavailable — cloud tokens will be stored with reduced protection on this platform.');
      }
    }).catch(() => { /* non-fatal */ });

    (async () => {
      for (const provider of Object.keys(PROVIDERS)) {
        try {
          const res = await cloudBridge().status(provider);
          if (cancelled || !res?.ok) continue;
          setProvider(provider, { connected: res.connected, account: res.account });
          mirrorToSettings(provider, { connected: res.connected, account: res.account });
        } catch {
          /* bridge missing / web-only env — leave defaults */
        }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── connect(provider) — full OAuth round-trip ───
  const connect = useCallback(async (provider) => {
    const label = labelFor(provider);
    setProvider(provider, { busy: true });
    addLog('info', `[${label}] Starting OAuth 2.0 authorization. Complete the sign-in in your browser…`);
    try {
      const res = await cloudBridge().connect(provider);
      if (!res?.ok) throw new Error(res?.error || 'Authorization failed.');
      setProvider(provider, { connected: true, account: res.account });
      mirrorToSettings(provider, { connected: true, account: res.account });
      const emailBits = res.account?.email ? ` as ${res.account.email}` : '';
      addLog('success', `[${label}] Connected${emailBits}. Tokens stored securely via your OS keychain.`);
    } catch (err) {
      addLog('error', `[${label}] ${err.message || 'OAuth flow failed.'}`);
    } finally {
      setProvider(provider, { busy: false });
    }
  }, [addLog, mirrorToSettings, setProvider]);

  // ─── disconnect(provider) — revoke remotely + clear locally ───
  const disconnect = useCallback(async (provider) => {
    const label = labelFor(provider);
    setProvider(provider, { busy: true });
    addLog('info', `[${label}] Disconnecting…`);
    try {
      const res = await cloudBridge().disconnect(provider);
      if (!res?.ok) throw new Error(res?.error || 'Disconnect failed.');
      setProvider(provider, { connected: false, account: null });
      mirrorToSettings(provider, { connected: false, account: null });
      addLog('success', `[${label}] Disconnected. Local tokens cleared from the secure store.`);
      if (res.warning) addLog('warning', `[${label}] ${res.warning}`);
    } catch (err) {
      addLog('error', `[${label}] ${err.message || 'Disconnect failed.'}`);
    } finally {
      setProvider(provider, { busy: false });
    }
  }, [addLog, mirrorToSettings, setProvider]);

  // ─── upload(provider, ...) — stream a buffer, log progress ───
  const upload = useCallback(async (provider, { fileName, buffer, mimeType }) => {
    const label = labelFor(provider);
    lastProgressRef.current = 0;
    addLog('info', `[${label}] Uploading "${fileName}"…`);
    const res = await cloudBridge().upload({
      provider,
      fileName,
      buffer,
      mimeType,
      onProgress: (p) => {
        const pct = Math.round(p.progress * 100);
        // Only log milestones of ≥25% and completion, to avoid console spam.
        if (pct >= 100) {
          addLog('info', `[${label}] "${fileName}" → 100%`);
        } else if (pct >= lastProgressRef.current + 25) {
          lastProgressRef.current = pct;
          addLog('info', `[${label}] "${fileName}" → ${pct}%`);
        }
      },
    });
    if (res?.ok) {
      const linkMsg = res.webViewLink || res.link || (res.path ? `path: ${res.path}` : `file id: ${res.fileId}`);
      addLog('success', `[${label}] "${fileName}" uploaded — ${linkMsg}`);
      return res;
    }
    addLog('error', `[${label}] Upload of "${fileName}" failed: ${res?.error || 'unknown error'}`);
    return res || { ok: false, error: 'no response' };
  }, [addLog]);

  // ─── refresh() — re-hydrate connection state from the secure store ───
  // Used by components that are not the Settings tab (e.g. BookProcessor's
  // export modal) to guarantee a fresh view of "what is connected right now"
  // without sharing state with the Settings component instance.
  const refresh = useCallback(async () => {
    for (const provider of Object.keys(PROVIDERS)) {
      try {
        const res = await cloudBridge().status(provider);
        if (res?.ok) {
          setProvider(provider, { connected: res.connected, account: res.account });
          mirrorToSettings(provider, { connected: res.connected, account: res.account });
        }
      } catch { /* bridge missing / web-only env — keep last known state */ }
    }
  }, [mirrorToSettings, setProvider]);

  return { states, connect, disconnect, upload, refresh, PROVIDERS };
}
