const crypto = require('crypto');
const oauthServer = require('./oauthServer');

/**
 * dropboxService.js — Dropbox OAuth + upload, via the official `dropbox` SDK.
 *
 * PURE business logic module (see googleDriveService.js for the rationale):
 * no IPC, no UI, no Electron imports beyond what index.js injects.
 *
 * We hand-roll the OAuth authorization-code handshake against Dropbox's
 * HTTP endpoints (`https://api.dropboxapi.com/oauth2/token`) rather than
 * relying on SDK sugar, because the standalone `DropboxAuth` class in the
 * Node build doesn't include a hosted loopback helper and the remote-flow
 * details are the same two HTTP calls (authorize URL + token exchange).
 * We use the SDK for the actual files API (`filesUpload` etc.).
 *
 * SCOPES: `files.content.write` (upload) + `account_info.read` (display email
 * in the "Connected as ..." subtitle). Enable matching app-folder or
 * full-access permissions in your Dropbox App Console.
 */

const { Dropbox } = require('dropbox');

const OAUTH_TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';

/** Build the consent URL the user opens in their browser. */
function buildAuthorizeUrl({ appKey, redirectUri, state }) {
  const params = new URLSearchParams({
    client_id: appKey,
    response_type: 'code',
    redirect_uri: redirectUri,
    token_access_type: 'offline',        // ask for a refresh token
    state,
    // Foreground account & files-create scopes; account_info.read is for the
    // "Connected as <email>" label.
    scope: 'files.content.write account_info.read',
  });
  return `https://www.dropbox.com/oauth2/authorize?${params.toString()}`;
}

/** Exchange an authorization code for tokens at the token endpoint. */
async function exchangeCode({ appKey, appSecret, redirectUri, code }) {
  const body = new URLSearchParams({
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
    client_id: appKey,
    client_secret: appSecret,
  });
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json.error_description || json.error || `token exchange failed (${res.status})`);
  }
  return json; // { access_token, refresh_token, expires_in, account_id, ... }
}

/** Use a refresh_token to mint a fresh access_token. */
async function refreshAccessToken({ appKey, appSecret, refreshToken }) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: appKey,
    client_secret: appSecret,
  });
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json.error_description || json.error || `token refresh failed (${res.status})`);
  }
  return json; // { access_token, token_type, expires_in, ... } (no refresh_token on refresh)
}

/** Instantiate a Dropbox API client for a token set. */
function dbxClient(creds, tokens) {
  return new Dropbox({
    accessToken: tokens.access_token,
    clientId: creds.appKey,
  });
}

/**
 * Full authorization flow: open consent → capture loopback code → exchange.
 * Also grabs account info so the UI can render "Connected as <email>".
 *
 * @returns {Promise<{ tokens: object, account: { email: string, name: string } }>}
 */
async function authorize(creds) {
  const state = crypto.randomBytes(16).toString('hex');
  const authUrl = buildAuthorizeUrl({ ...creds, state });

  const { code } = await oauthServer.start({
    provider: 'Dropbox',
    authUrl,
    state,
  });

  const tokens = await exchangeCode({ ...creds, code });
  // Stamp a best-effort expiry timestamp so refreshIfNeeded can be lazy.
  if (tokens.expires_in) {
    tokens.expiry_date = Date.now() + Number(tokens.expires_in) * 1000;
  }

  // Fetch account info for the "Connected as" label (non-fatal failure).
  let account = { email: '', name: '' };
  try {
    const dbx = dbxClient(creds, tokens);
    const info = await dbx.usersGetCurrentAccount();
    account = {
      email: info.result?.email || '',
      name: [info.result?.name?.given_name, info.result?.name?.surname].filter(Boolean).join(' ').trim(),
    };
  } catch { /* label is cosmetic — skip */ }

  return { tokens, account };
}

/** Refresh the access token if we have a stored refresh token + expiry says so. */
async function refreshIfNeeded(creds, tokens) {
  const expiry = tokens?.expiry_date || 0;
  const skew = 60 * 1000;
  if (tokens?.refresh_token && expiry && Date.now() < expiry - skew) {
    return tokens;
  }
  if (!tokens?.refresh_token) {
    // Old-style long-lived token or missing refresh token — nothing to do.
    return tokens;
  }
  const fresh = await refreshAccessToken({
    ...creds,
    refreshToken: tokens.refresh_token,
  });
  // Merge, preserving the refresh_token if the response omits it.
  return {
    ...tokens,
    ...fresh,
    refresh_token: fresh.refresh_token || tokens.refresh_token,
    expiry_date: fresh.expires_in
      ? Date.now() + Number(fresh.expires_in) * 1000
      : tokens.expiry_date,
  };
}

/**
 * Upload a Buffer to Dropbox. Destination is a dedicated app-adjacent folder
 * we create on demand (`/SubScribe AI`).
 *
 * @param {object} opts
 * @param {object} opts.creds / opts.tokens / opts.fileName / opts.mimeType /
 *                opts.buffer — same contract as googleDriveService.uploadFile.
 * @param {(n:number)=>void} [opts.onProgress] — Dropbox filesUpload is
 *                single-shot; we report 0 start / ~0.1 prepped / 1 done so
 *                the System Console still shows activity.
 *
 * @returns {Promise<{ fileId, webViewLink, path }}>  fileId is the Dropbox
 *          file id, path is the final dropbox path.
 */
const UPLOAD_DIR = '/SubScribe AI';

async function uploadFile({ creds, tokens, fileName, mimeType, buffer, onProgress }) {
  onProgress?.(0);

  const dbx = dbxClient(creds, tokens);

  // Ensure the destination folder exists (idempotent; ignore "already exists").
  try {
    await dbx.filesCreateFolderV2({ path: UPLOAD_DIR, autorename: false });
  } catch { /* folder exists or 404 on a thinner-permission app */ }

  const destPath = `${UPLOAD_DIR}/${fileName}`;
  onProgress?.(0.1);

  const res = await dbx.filesUpload({
    path: destPath,
    contents: buffer,
    mode: { '.tag': 'overwrite' },
    autorename: false,
    mute: true,
  });

  onProgress?.(1);

  // Best-effort shareable link; many apps won't have sharing scopes — tolerate 409/403.
  let webViewLink = null;
  try {
    const link = await dbx.sharingCreateSharedLinkWithSettings({
      path: res.result?.path_display || destPath,
      settings: { requested_visibility: { '.tag': 'public' } },
    });
    webViewLink = link.result?.url || null;
    // Convert "...?dl=0" to a layout-friendlier view link if it appears.
    if (webViewLink) webViewLink = webViewLink.replace('dl=0', 'raw=1').replace(/dl=\d/, 'raw=1');
  } catch { /* sharing is optional */ }

  return {
    fileId: res.result?.id || '',
    path: res.result?.path_display || destPath,
    webViewLink,
  };
}

/** Best-effort revoke of the OAuth token pair. Ignores network failures. */
async function revoke(creds, tokens) {
  try {
    if (!tokens?.access_token) return;
    const dbx = dbxClient(creds, tokens);
    await dbx.authTokenRevoke();
  } catch { /* local-clear proceeds regardless */ }
}

module.exports = { authorize, refreshIfNeeded, uploadFile, revoke };
