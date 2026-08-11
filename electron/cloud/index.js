/**
 * index.js (electron/cloud) — single entry point the IPC layer calls for all
 * cloud-storage operations. It dispatches to the provider-specific service
 * module, reads provider credentials via cloudProviders.js, and persists
 * OAuth tokens via credentialsManager.js.
 *
 * Task 11 portability: this dispatcher is pure Node and has no Electron import
 * other than the ones above (all of which live in `electron/` for safeStorage
 * and loopback listening). Swapping to a web/HTTP backend means replacing
 * `credentialsManager` with HTTP calls and adding a server-side oauthServer —
 * the service modules (googleDriveService / dropboxService) stay untouched.
 */

const credentials = require('./credentialsManager');
const { loadProviderCredentials, loadAllProviders } = require('./cloudProviders');
const googleDrive = require('./googleDriveService');
const dropbox = require('./dropboxService');

/** Normalize a provider key to the canonical 'googleDrive' | 'dropbox'. */
function normalizeProvider(provider) {
  const p = String(provider || '').trim().toLowerCase().replace(/[\s_-]/g, '');
  if (p === 'googledrive' || p === 'gdrive' || p === 'google') return 'googleDrive';
  if (p === 'dropbox') return 'dropbox';
  return null;
}

const PROVIDERS = {
  googleDrive: googleDrive,
  dropbox,
};

/** Load creds for a single provider, failing with a friendly message if not configured. */
async function credsFor(provider) {
  try {
    return await loadProviderCredentials(provider);
  } catch (err) {
    throw new Error(err.message);
  }
}

/**
 * status — tells the renderer whether a provider is connected and (if so)
 * the account label we captured at connect time. The connection state itself
 * is derived from the presence of stored tokens; the account label is stored
 * alongside them so the Settings card can render without an extra API call.
 */
async function getStatus(provider) {
  const key = normalizeProvider(provider);
  if (!key) return { ok: false, error: `Unknown provider "${provider}".` };
  const tokens = await credentials.getTokens(key);
  return {
    ok: true,
    connected: Boolean(tokens && tokens.access_token),
    account: tokens?._account || { email: '', name: '' },
  };
}

/**
 * connect — run the full OAuth flow, persist tokens, and return the account
 * label so the renderer can update Settings immediately.
 */
async function connect(provider) {
  const key = normalizeProvider(provider);
  const svc = PROVIDERS[key];
  if (!svc) return { ok: false, error: `Unknown provider "${provider}".` };

  let creds;
  try {
    creds = await credsFor(key);
  } catch (err) {
    return { ok: false, error: err.message };
  }

  const { tokens, account } = await svc.authorize(creds);
  // Attach the account label into the stored token blob (it's non-sensitive
  // display data; the whole blob is still encrypted at rest).
  const toStore = { ...tokens, _account: account };
  await credentials.setTokens(key, toStore);
  return { ok: true, account };
}

/**
 * disconnect — best-effort remote revoke, then wipe local stored tokens.
 * Always succeeds from the renderer's perspective (local sign-out); remote
 * revoke failure is surfaced as a non-fatal message the renderer can `warning`.
 */
async function disconnect(provider) {
  const key = normalizeProvider(provider);
  const svc = PROVIDERS[key];
  if (!svc) return { ok: false, error: `Unknown provider "${provider}".` };

  const creds = await credsFor(key).catch(() => null);
  const tokens = await credentials.getTokens(key);
  let revokeWarning = null;
  if (creds && tokens) {
    try {
      await svc.revoke(creds, tokens);
    } catch (err) {
      revokeWarning = `Remote revoke failed (tokens cleared locally anyway): ${err.message}`;
    }
  }
  await credentials.clearTokens(key);
  return { ok: true, warning: revokeWarning };
}

/**
 * upload — refresh tokens if needed, stream the buffer to the provider, and
 * persist any rotated tokens back to the credentials store.
 *
 * @param {object} opts
 * @param {string} opts.provider
 * @param {string} opts.fileName
 * @param {Buffer} opts.buffer
 * @param {string} [opts.mimeType]
 * @param {(n:number)=>void} [opts.onProgress]
 *
 * @returns {Promise<{ ok, fileId?, webViewLink?, path?, link?, error? }>}
 */
async function upload({ provider, fileName, buffer, mimeType, onProgress }) {
  const key = normalizeProvider(provider);
  const svc = PROVIDERS[key];
  if (!svc) return { ok: false, error: `Unknown provider "${provider}".` };
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { ok: false, error: 'File buffer is empty.' };
  }

  let creds;
  try {
    creds = await credsFor(key);
  } catch (err) {
    return { ok: false, error: err.message };
  }

  let tokens = await credentials.getTokens(key);
  if (!tokens || !tokens.access_token) {
    return { ok: false, error: `${provider} is not connected. Connect it in the Settings tab first.` };
  }

  try {
    tokens = await svc.refreshIfNeeded(creds, tokens);
    // Persist rotated tokens so the store always holds the freshest set.
    await credentials.setTokens(key, tokens);
  } catch (err) {
    return { ok: false, error: `Could not refresh your ${provider} session: ${err.message}. Try disconnecting and reconnecting.` };
  }

  const result = await svc.uploadFile({ creds, tokens, fileName, mimeType, buffer, onProgress });

  // Best-effort auto-link expansion for services that return a path only.
  if (!result.webViewLink && result.path) {
    result.link = `${provider === 'dropbox' ? 'Dropbox' : provider} → ${result.path}`;
  }

  return { ok: true, ...result };
}

module.exports = {
  getStatus,
  connect,
  disconnect,
  upload,
  // Exposed for IPC layer convenience & future "Secrets storage" tab.
  credentialsAvailable: async () => credentials.isEncryptionAvailable(),
  // Returns which providers have credentials configured (for UI hints).
  configuredProviders: async () => {
    const all = await loadAllProviders();
    return {
      googleDrive: Boolean(all.googleDrive.clientId),
      dropbox: Boolean(all.dropbox.appKey),
    };
  },
};
