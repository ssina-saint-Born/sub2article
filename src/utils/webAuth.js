/**
 * webAuth.js
 * ─────────────────────────────────────────────────────────────
 * Full cloud-storage (Google Drive / Dropbox) integration for the Web
 * build — the browser-native counterpart to electron/cloud/index.js,
 * googleDriveService.js, dropboxService.js, and credentialsManager.js
 * combined.
 *
 * WHY THIS EXISTS
 *   The desktop app runs an Electron main-process loopback OAuth flow
 *   (localhost:8765) so OAuth client SECRETS can stay out of the UI.
 *   A static web build has no main process and no secrets, so we use the
 *   OAuth 2.0 Implicit Grant instead:
 *
 *     1. Build the provider's authorize URL, redirect this tab away.
 *     2. Provider redirects back to our own URL with the access token
 *        in the URL hash:
 *        https://app/#access_token=ya29.A0...&token_type=Bearer&expires_in=3599&state=...
 *     3. We parse the hash, validate the `state` nonce, persist the token,
 *        fetch the "Connected as <email>" account label, clean the hash,
 *        and reload the UI.
 *
 *   Implicit Grant ships no client secret in the browser (there's nothing
 *   to leak), which is why the Desktop's electron/cloud/cloud.providers.json
 *   (with its clientSecret/appSecret fields) is NEVER included in the web
 *   bundle. Config lives in vite env vars: `VITE_GOOGLE_CLIENT_ID`,
 *   `VITE_DROPBOX_APP_KEY`.
 *
 * TOKEN STORE
 *   Tokens live in `localStorage` under `{ [provider]: { access_token,
 *   expiry_date, _account:{ email, name } } }` — same logical shape as
 *   the desktop's encrypted store, minus the OS keychain layer (which
 *   doesn't exist in a browser).
 *
 * UPLOADS
 *   Both providers support Direct REST uploads with just the bearer token:
 *     • Google Drive  →  POST https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart
 *     • Dropbox       →  POST https://content.dropboxapi.com/2/files/upload
 *   No SDKs, no Node Buffer — plain fetch with Blob/Uint8Array bodies.
 * ─────────────────────────────────────────────────────────────
 */

// ─────────────────────────────────────────────────────────────────
// Config — inlined by Vite at build time from .env / .env.production
// ─────────────────────────────────────────────────────────────────

const GOOGLE_CLIENT_ID = import.meta.env?.VITE_GOOGLE_CLIENT_ID || '';
const DROPBOX_APP_KEY = import.meta.env?.VITE_DROPBOX_APP_KEY || '';

// Scopes mirror the desktop Electron implementation (googleDriveService.js):
// 'drive.file' grants access ONLY to files this app creates — least privilege.
const SCOPES = {
  googleDrive: 'https://www.googleapis.com/auth/drive.file',
};

/** localStorage key that holds the entire token map (per-provider entries). */
const TOKEN_STORE_KEY = 'subscribe-ai-web-tokens';

/** sessionStorage keys for the in-flight OAuth flow. Cleaned after callback. */
const SESSION = {
  state: 'subscribe-oauth.state',
  provider: 'subscribe-oauth.provider',
  returnTo: 'subscribe-oauth.returnTo',
};

// ─────────────────────────────────────────────────────────────────
// Internal: token store helpers
// Shape mirrors electron/cloud/credentialsManager.js so the UI badge logic
// (and any future shared code) stays identical.
// ─────────────────────────────────────────────────────────────────

function readTokenMap() {
  try {
    const raw = localStorage.getItem(TOKEN_STORE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeTokenMap(map) {
  try {
    localStorage.setItem(TOKEN_STORE_KEY, JSON.stringify(map));
  } catch {
    // Storage disabled/full — skip. Cloud status will read empty next load.
  }
}

/**
 * Get the stored token entry for a provider, or null.
 * @param {'googleDrive'|'dropbox'} provider
 * @returns {{ access_token: string, expiry_date: number, _account?: object } | null}
 */
function getTokens(provider) {
  const entry = readTokenMap()[provider];
  if (!entry || typeof entry !== 'object') return null;
  // Implicit-grant tokens have an expiry; treat expired entries as absent so
  // the UI shows "Not Connected" rather than failing an upload later.
  if (entry.expiry_date && Date.now() > entry.expiry_date) return null;
  return entry;
}

/**
 * Save or clear { access_token, expiry_date, _account } for a provider.
 * Passing null clears the entry.
 */
function setTokens(provider, entry) {
  const map = readTokenMap();
  if (entry == null) delete map[provider];
  else map[provider] = entry;
  writeTokenMap(map);
}

// ─────────────────────────────────────────────────────────────────
// Internal: misc
// ─────────────────────────────────────────────────────────────────

/** Random hex for the `state` CSRF nonce. */
function randomState() {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Normalize a provider key. Matches electron/cloud/index.js normalizeProvider
 * so that 'Google Drive' / 'GoogleDrive' / 'googledrive' / 'gdrive' all map
 * to the same canonical key.
 */
function normalizeProvider(provider) {
  const p = String(provider || '').trim().toLowerCase().replace(/[\s_-]/g, '');
  if (p === 'googledrive' || p === 'gdrive' || p === 'google') return 'googleDrive';
  if (p === 'dropbox') return 'dropbox';
  return null;
}

/**
 * Current page URL with the hash/query stripped — this is what we register
 * as the OAuth redirect_uri and it's also where we return the user to.
 */
function currentOriginAndPath() {
  return `${window.location.origin}${window.location.pathname}`;
}

// ─────────────────────────────────────────────────────────────────
// OAuth — Public API (these are what bridge.cloud calls)
// ─────────────────────────────────────────────────────────────────

/**
 * Read connection state from localStorage. SyncResult is the same shape the
 * desktop IPC returns: {ok, connected, account}.
 */
export async function webStatus(provider) {
  const key = normalizeProvider(provider);
  if (!key) return { ok: false, error: `Unknown provider "${provider}".` };
  const entry = getTokens(key);
  return {
    ok: true,
    connected: Boolean(entry?.access_token),
    account: entry?._account || { email: '', name: '' },
  };
}

/**
 * Kick off the OAuth Implicit Grant flow for a provider.
 *
 * This function STASHES the return URL + a state nonce in sessionStorage,
 * then NAVIGATES THE BROWSER AWAY to the provider's authorize page. The
 * Promise never resolves — the current page unloads. After consent, the
 * provider redirects back to the same URL; main.jsx calls
 * `handleOAuthCallback()` before React mounts, which routes the fresh
 * token into the store and reloads the UI.
 */
export async function webConnect(provider) {
  const key = normalizeProvider(provider);
  if (!key) return { ok: false, error: `Unknown provider "${provider}".` };

  // Bail if we don't have a client id configured for this provider.
  const clientId = key === 'googleDrive' ? GOOGLE_CLIENT_ID : DROPBOX_APP_KEY;
  if (!clientId) {
    const providerName = key === 'googleDrive' ? 'Google Drive' : 'Dropbox';
    const envVar = key === 'googleDrive' ? 'VITE_GOOGLE_CLIENT_ID' : 'VITE_DROPBOX_APP_KEY';
    return { ok: false, error: `${providerName} isn't configured for the web build. Set ${envVar} in your environment (or .env file) before building.` };
  }

  const redirectUri = currentOriginAndPath();
  const state = randomState();

  // Stash so the callback handler knows which provider this round-trip was for.
  sessionStorage.setItem(SESSION.state, state);
  sessionStorage.setItem(SESSION.provider, key);
  sessionStorage.setItem(SESSION.returnTo, redirectUri);

  let authUrl;
    if (key === 'googleDrive') {
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'token',
      scope: SCOPES.googleDrive,
      state,
      include_granted_scopes: 'false',
    });
    authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  } else {
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'token',
      state,
    });
    authUrl = `https://www.dropbox.com/oauth2/authorize?${params.toString()}`;
  }

  // Hand off to the provider. The promise intentionally never resolves —
  // the page unloads and the callback handler on load picks up the hash.
  window.location.assign(authUrl);
  return new Promise(() => {});
}

/**
 * Parse the OAuth callback (if any) from the current URL hash. Called by
 * main.jsx BEFORE React mounts so the System Console hydration sees the
 * fresh connection state. Cleans up the hash afterward.
 *
 * @returns {Promise<{ handled: boolean, provider?: string, connected?: boolean, error?: string }>}
 */
export async function handleOAuthCallback() {
  // The callback arrives as URL hash: "#access_token=...&token_type=Bearer&..."
  if (!window.location.hash || window.location.hash.length < 2) {
    return { handled: false };
  }
  const params = new URLSearchParams(window.location.hash.slice(1));
  const accessToken = params.get('access_token');
  const incomingState = params.get('state');
  const error = params.get('error');
  const expiresIn = params.get('expires_in');

  // Stored context for the flow in flight.
  const pendingState = sessionStorage.getItem(SESSION.state);
  const pendingProvider = sessionStorage.getItem(SESSION.provider);
  const returnTo = sessionStorage.getItem(SESSION.returnTo) || currentOriginAndPath();

  // No flow in flight, or the state doesn't match — not ours. Don't clean the
  // hash; some other caller might have placed it there.
  if (!pendingProvider || !pendingState || incomingState !== pendingState) {
    return { handled: false };
  }

  // User clicked "Deny" on the consent screen.
  if (error) {
    sessionStorage.removeItem(SESSION.state);
    sessionStorage.removeItem(SESSION.provider);
    sessionStorage.removeItem(SESSION.returnTo);
    window.history.replaceState({}, '', returnTo);
    // Return handled=true so the caller surfaces the denial via addLog.
    return { handled: true, provider: pendingProvider, connected: false, error };
  }

  if (!accessToken) {
    sessionStorage.removeItem(SESSION.state);
    sessionStorage.removeItem(SESSION.provider);
    sessionStorage.removeItem(SESSION.returnTo);
    window.history.replaceState({}, '', returnTo);
    return { handled: true, provider: pendingProvider, connected: false, error: 'No access_token returned from the OAuth redirect.' };
  }

  // Persist the token + expiry.
  const expiry = expiresIn ? Date.now() + Number(expiresIn) * 1000 : null;
  const entry = { access_token: accessToken, expiry_date: expiry, token_type: 'bearer' };

  // Fetch the account label the Settings card shows ("Connected as ...").
  let account = { email: '', name: '' };
  try {
    if (pendingProvider === 'googleDrive') {
      const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const data = await res.json().catch(() => ({}));
      account = { email: data.email || '', name: data.name || '' };
    } else if (pendingProvider === 'dropbox') {
      // Dropbox's account-info endpoint expects a JSON-RPC POST with no body.
      const res = await fetch('https://api.dropboxapi.com/2/users/get_current_account', {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const data = await res.json().catch(() => ({}));
      account = {
        email: data.email || '',
        name: [data?.name?.given_name, data?.name?.surname].filter(Boolean).join(' ').trim(),
      };
    }
  } catch (e) {
    // Non-fatal: the connection works even if the profile round-trip fails.
  }
  entry._account = account;

  setTokens(pendingProvider, entry);

  // Cleanup: strip the token from the URL hash, tell React what happened.
  sessionStorage.removeItem(SESSION.state);
  sessionStorage.removeItem(SESSION.provider);
  sessionStorage.removeItem(SESSION.returnTo);
  window.history.replaceState({}, '', returnTo);

  return { handled: true, provider: pendingProvider, connected: true, account };
}

// ─────────────────────────────────────────────────────────────────
// Disconnect + optional remote revoke
// ─────────────────────────────────────────────────────────────────

export async function webDisconnect(provider) {
  const key = normalizeProvider(provider);
  if (!key) return { ok: false, error: `Unknown provider "${provider}".` };
  const entry = getTokens(key);

  // Best-effort remote revoke so the token is useless server-side too.
  if (entry?.access_token) {
    try {
      if (key === 'googleDrive') {
        await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(entry.access_token)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });
      } else if (key === 'dropbox') {
        await fetch('https://api.dropboxapi.com/2/auth/token/revoke', {
          method: 'POST',
          headers: { Authorization: `Bearer ${entry.access_token}` },
        });
      }
    } catch (e) {
      // Offline or API failure — local clear proceeds regardless.
      return { ok: true, warning: `Remote revoke may have failed; local token cleared: ${e.message}` };
    }
  }

  setTokens(key, null);
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────
// Real browser uploads — plain fetch, no SDKs
// ─────────────────────────────────────────────────────────────────

/**
 * Upload a file to Google Drive via the multipart/related REST endpoint.
 * Returns { ok, fileId, webViewLink } matching the electron contract.
 *
 * @param {object} opts
 * @param {string} opts.accessToken   A fresh bearer token.
 * @param {string} opts.fileName      e.g. "dataset-2026-08-09.json"
 * @param {Uint8Array|ArrayBuffer|string} opts.buffer
 * @param {string} [opts.mimeType]
 * @param {(n:number)=>void} [opts.onProgress]
 */
async function driveUpload({ accessToken, fileName, buffer, mimeType, onProgress }) {
  // Normalize input into a Blob. Uint8Array / ArrayBuffer / string all work.
  let body;
  if (buffer instanceof Uint8Array) {
    body = new Blob([buffer], { type: mimeType || 'application/octet-stream' });
  } else if (buffer instanceof ArrayBuffer) {
    body = new Blob([buffer], { type: mimeType || 'application/octet-stream' });
  } else if (typeof buffer === 'string') {
    body = new Blob([buffer], { type: mimeType || 'text/plain' });
  } else {
    return { ok: false, error: 'Unsupported file buffer type.' };
  }

  const boundary = 'subscribe-ai-' + Math.random().toString(36).slice(2);
  const metadata = { name: fileName, mimeType: mimeType || 'application/octet-stream' };

  const multipartBody =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${mimeType || 'application/octet-stream'}\r\n\r\n`;

  const closingBoundary = `\r\n--${boundary}--`;

  const encoder = new TextEncoder();
  const headerBytes = encoder.encode(multipartBody);
  const bodyBytes = new Uint8Array(await body.arrayBuffer());
  const footerBytes = encoder.encode(closingBoundary);

  const finalBytes = new Uint8Array(headerBytes.length + bodyBytes.length + footerBytes.length);
  finalBytes.set(headerBytes, 0);
  finalBytes.set(bodyBytes, headerBytes.length);
  finalBytes.set(footerBytes, headerBytes.length + bodyBytes.length);

  const res = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body: finalBytes,
    }
  );

  if (onProgress) onProgress(1);
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    return { ok: false, error: `Google Drive upload failed (HTTP ${res.status}): ${errBody.slice(0, 200)}` };
  }
  const data = await res.json();
  return { ok: true, fileId: data.id, webViewLink: data.webViewLink };
}

/**
 * Upload a file to Dropbox via the content-upload endpoint.
 * Returns { ok, fileId, path, webViewLink } matching the electron contract.
 */
async function dropboxUpload({ accessToken, fileName, buffer, mimeType, onProgress }) {
  let body;
  if (buffer instanceof Uint8Array) body = new Blob([buffer], { type: mimeType || 'application/octet-stream' });
  else if (buffer instanceof ArrayBuffer) body = new Blob([buffer], { type: mimeType || 'application/octet-stream' });
  else if (typeof buffer === 'string') body = new Blob([buffer], { type: mimeType || 'text/plain' });
  else return { ok: false, error: 'Unsupported file buffer type.' };

  const destPath = `/SubScribe AI/${fileName}`;

  const res = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Dropbox-API-Arg': JSON.stringify({
        path: destPath,
        mode: { '.tag': 'overwrite' },
        autorename: false,
        mute: true,
      }),
      'Content-Type': 'application/octet-stream',
    },
    body,
  });

  if (onProgress) onProgress(1);
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    return { ok: false, error: `Dropbox upload failed (HTTP ${res.status}): ${errBody.slice(0, 200)}` };
  }
  const data = await res.json();
  return { ok: true, fileId: data.id, path: data.path_display || destPath, webViewLink: null };
}

/**
 * Public upload entry point. Returns the same shape the desktop IPC handler
 * returns: { ok, fileId?, webViewLink?, path?, link?, error? }.
 *
 * @param {object} opts
 * @param {string} opts.provider
 * @param {string} opts.fileName
 * @param {Uint8Array|ArrayBuffer|string} opts.buffer
 * @param {string} [opts.mimeType]
 * @param {(n:number)=>void} [opts.onProgress]
 */
export async function webUpload({ provider, fileName, buffer, mimeType, onProgress }) {
  const key = normalizeProvider(provider);
  if (!key) return { ok: false, error: `Unknown provider "${provider}".` };

  const entry = getTokens(key);
  if (!entry?.access_token) {
    return { ok: false, error: `${provider === 'dropbox' ? 'Dropbox' : 'Google Drive'} is not connected. Connect it in the Settings tab first.` };
  }

  if (onProgress) onProgress(0);

  const result = key === 'googleDrive'
    ? await driveUpload({ accessToken: entry.access_token, fileName, buffer, mimeType, onProgress })
    : await dropboxUpload({ accessToken: entry.access_token, fileName, buffer, mimeType, onProgress });

  return result;
}
