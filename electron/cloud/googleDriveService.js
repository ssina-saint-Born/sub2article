const { google } = require('googleapis');
const crypto = require('crypto');
const oauthServer = require('./oauthServer');

/**
 * googleDriveService.js — Google Drive OAuth + upload, via the official
 * `googleapis` Node SDK.
 *
 * This module is PURE business logic — it knows nothing about Electron IPC,
 * React, or the System Console. The index.js dispatcher drives it and adapters
 * (task 7/8 token persistence, progress forwarding) are injected. Keeping it
 * standalone preserves our Task 11 goal of porting to a plain Node/be web API.
 *
 * SCOPE: we request the narrowest working scope,
 *   https://www.googleapis.com/auth/drive.file
 * which grants access ONLY to files this app creates (and files the user opens
 * via the Drive picker) — not full Drive access. That's the correct choice for
 * an uploader: least privilege, and it satisfies Drive's app-verification bar
 * for "recommended" scopes.
 */

const SCOPE = ['https://www.googleapis.com/auth/drive.file'];

/** Build the OAuth2 client from the provider's credentials. */
function buildClient({ clientId, clientSecret, redirectUri }) {
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

/** Authenticated Drive v3 client for the given token set. */
function driveClient(creds, tokens) {
  const oauth2 = buildClient(creds);
  oauth2.setCredentials(tokens);
  return { drive: google.drive({ version: 'v3', auth: oauth2 }), oauth2 };
}

/**
 * Run the full OAuth 2.0 authorization-code flow:
 *   build consent URL → open browser → wait for loopback code → exchange code.
 *
 * @returns {Promise<{ tokens: object, account: { email: string, name: string } }>}
 *   `tokens` is the raw googleapis Credentials object (includes access_token,
 *   refresh_token, expiry_date). `account` is fetched immediately so the UI can
 *   show "Connected as <email>" without a second round-trip.
 */
async function authorize(creds) {
  const oauth2 = buildClient(creds);
  // CSRF guard: random per-flow state the callback must echo back.
  const state = crypto.randomBytes(16).toString('hex');

  const authUrl = oauth2.generateAuthUrl({
    access_type: 'offline',          // Request a refresh token.
    prompt: 'consent',               // Force consent so we ALWAYS get one (even if previously granted).
    scope: SCOPE,
    redirect_uri: creds.redirectUri,
    state,
  });

  const { code } = await oauthServer.start({
    provider: 'Google Drive',
    authUrl,
    state,
  });

  const { tokens } = await oauth2.getToken({
    code,
    redirect_uri: creds.redirectUri,
  });

  oauth2.setCredentials(tokens);
  // Fetch profile now so the Settings card can display it instantly.
  let account = { email: '', name: '' };
  try {
    const about = await google.drive({ version: 'v3', auth: oauth2 })
      .about.get({ fields: 'user(displayName,emailAddress)' });
    account = {
      email: about.data.user?.emailAddress || '',
      name: about.data.user?.displayName || '',
    };
  } catch {
    // Non-fatal — the connection works even if the profile lookup fails.
  }

  return { tokens, account };
}

/**
 * Refresh the access token if expired, using the stored refresh token.
 * Returns the (possibly updated) token set. Callers should persist the
 * returned value (googleapis mutates its internal Credentials).
 */
async function refreshIfNeeded(creds, tokens) {
  const oauth2 = buildClient(creds);
  oauth2.setCredentials(tokens);
  const expiry = tokens?.expiry_date || 0;
  const skew = 60 * 1000; // refresh if expiring within the next minute
  if (expiry && Date.now() < expiry - skew && tokens.access_token) {
    return tokens;
  }
  const { credentials } = await oauth2.refreshAccessToken();
  // Preserve fields googleapis may omit on refresh (e.g. refresh_token itself).
  return { ...tokens, ...credentials };
}

/**
 * Upload a Buffer to Google Drive into the app's working folder.
 *
 * @param {object} opts
 * @param {object} opts.creds      Provider credentials.
 * @param {object} opts.tokens     Stored token set.
 * @param {string} opts.fileName   e.g. "dataset-2026-08-09.json"
 * @param {string} opts.mimeType   e.g. "application/json" | "application/pdf" | DOCX MIME
 * @param {Buffer} opts.buffer     File contents.
 * @param {(progress:number)=>void} [opts.onProgress]  0..1 login throttled.
 *
 * @returns {Promise<{ fileId: string, webViewLink: string }>}
 */
async function uploadFile({ creds, tokens, fileName, mimeType, buffer, onProgress }) {
  const { drive } = driveClient(creds, tokens);

  // Resumable upload with progress: googleapis streams through request,
  // and we tap via its onUploadProgress handler.
  const res = await drive.files.create(
    {
      requestBody: {
        name: fileName,
        mimeType: mimeType || 'application/octet-stream',
        // Folder rooting for organization; safe to omit (root) if delete fails.
      },
      media: { mimeType: mimeType || 'application/octet-stream', body: buffer },
      fields: 'id, webViewLink',
      uploadType: 'resumable',
    },
    {
      onUploadProgress: (evt) => {
        if (onProgress && evt.bytesRead > 0 && buffer.length > 0) {
          onProgress(Math.min(1, evt.bytesRead / buffer.length));
        }
      },
    }
  );

  const fileId = res.data.id;
  const webViewLink = res.data.webViewLink || null;

  // Best-effort: give anyone-with-link view access so the webViewLink opens.
  // If the user hasn't authorized sharing beyond the app's own file, this
  // may 403; we swallow that so the upload itself still counts as success.
  try {
    await drive.permissions.create({
      fileId,
      requestBody: { type: 'anyone', role: 'reader' },
    });
  } catch { /* sharing expansion is optional */ }

  return { fileId, webViewLink };
}

/** Best-effort remote revoke of the current token set. Ignores failures. */
async function revoke(creds, tokens) {
  try {
    if (!tokens?.access_token && !tokens?.refresh_token) return;
    const oauth2 = buildClient(creds);
    oauth2.setCredentials(tokens);
    await oauth2.revokeCredentials();
  } catch { /* offline-revoke: keep clearing locally regardless */ }
}

module.exports = { authorize, refreshIfNeeded, uploadFile, revoke };
