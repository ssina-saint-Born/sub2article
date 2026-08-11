const {
  Storage,
  MegaClient: _MegaClient, // not used directly; megajs exposes `Storage` as the entry point
} = require('megajs');

/**
 * megaService.js — Mega.nz credential auth + upload, via the `megajs` package.
 *
 * SISTER MODULE TO googleDriveService.js / dropboxService.js: pure business
 * logic, no Electron / IPC / UI imports. The dispatcher (index.js) drives it
 * and persists the (email, password, derived session key) blob through
 * credentialsManager.js — exactly the same path OAuth tokens take, except
 * Mega has no rotating tokens, so refreshIfNeeded is a no-op.
 *
 * WHY NO OAUTH: Mega is a password-credential service (email + password,
 * optionally 2FA). megajs also accepts a `key` derived from a session — once
 * we have logged in once, we persist a base64'd `key` so subsequent sessions
 * skip the slow login round-trip. We keep BOTH email/password AND the derived
 * key in the secure store: the password is needed if the key expires, and the
 * key is what makes re-auth instant on app restart.
 *
 * All megajs operations return events that progress through `onUploadProgress`
 * ('progress' / 'complete' / 'error' chunks). We collapse those into a single
 * `onProgress(0..1)` callback so this module has the same contract as the
 * OAuth services — the IPC layer doesn't need a per-provider code path.
 */

/** Localized upload destination — matches the Google Drive / Dropbox layout. */
const UPLOAD_DIR = 'SubScribe AI';

/**
 * Build a logged-in megajs Storage (mega client).
 *
 * We prefer a previously-derived session `key` (fast path, no password
 * log-in) when present; otherwise we fall back to email + password.
 *
 * @param {object} stored  Whatever credentialsManager handed us
 *   ({ email, password, key, account })
 * @returns {Storage}
 */
function buildClient(stored) {
  const opts = {
    // megajs uses an email + password OR an email + pre-derived base64 key.
    // A valid key alone gets us in without the password — but email is still
    // required for the user-agent and audit trail.
    email: stored?.email,
    keepLoggedin: true,
  };
  if (stored?.key) {
    opts.email = stored.email;
    opts.key = stored.key; // base64 session key (fast auth)
    opts.password = stored.password; // fallback if key fails server-side
  } else if (stored?.password) {
    opts.email = stored.email;
    opts.password = stored.password;
  } else {
    throw new Error('Mega connection is missing email and password/key.');
  }
  return new Storage(opts);
}

/** Wrap the Storage.login()-style callback API in a promise. */
function onceReady(client) {
  return new Promise((resolve, reject) => {
    client.once('ready', () => resolve());
    client.once('error', (err) => reject(err));
    // The constructor does not auto-log-in; we must call .login() / catch its
    // own ready event.  megajs fires `ready` once the API is primed and user
    // is authenticated (the .ready event is what `Storage` emits when the
    // session is established).
  });
}

/**
 * authorize — try a credential-based login, persist the derived session key.
 *
 * @param {object} input  { email, password }  (fresh input from the renderer)
 * @returns {Promise<{ tokens: object, account: { email, name } }>}
 *
 * The stored blob shape: { email, password, key, _account, _ts }.
 * `key` is the megajs base64 session key — appended on successful login so
 * restarts use the fast-path login.
 */
async function authorize(input) {
  const { email, password } = input || {};
  if (!email || !password) {
    throw new Error('Mega requires an email and a password.');
  }

  // Login with email + password (no stored key the first time).
  const client = new Storage({ email, password, keepLoggedin: true });

  // megajs's Storage emits `ready` after a successful login; `error` otherwise.
  await new Promise((resolve, reject) => {
    client.once('ready', resolve);
    client.once('error', reject);
  });

  // Capture the derived session key so restarts skip the password log-in.
  // megajs exposes a derived base64 key after login. The exact accessor
  // depends on the version — we attempt the documented ones defensively.
  let key = null;
  try {
    key = client.key
      ? Buffer.from(client.key).toString('base64')
      : null;
  } catch { /* non-fatal: we can just use password on next connect */ }

  // Account label: the email itself is the Mega identity (no separate username).
  const account = { email, name: email };

  // Stored "tokens" blob mirrors the OAuth shape so credentialsManager can
  // handle it uniformly. account label embeds so the renderer can render the
  // "Connected as ..." badge without a second API call.
  const tokens = {
    email,
    password,
    key,
    _account: account,
    _ts: Date.now(),
  };

  return { tokens, account };
}

/**
 * refreshIfNeeded — Mega sessions do not rotate (no OAuth refresh token).
 * We could optionally re-validate the session here, but the storage layer
 * will lazily surface a stale session as a login error on next upload —
 * and the renderer's `disconnect` + `connect` flow fully recovers. No-op.
 */
async function refreshIfNeeded(storedCreds, tokens) {
  return tokens;
}

/**
 * Get-or-create the app's working folder on the mega drive.
 * Returns the Storage node handle (folder) so we can drop the file into it.
 *
 * Mega folder names are case-sensitive and use leading slashes (root = '').
 */
function findOrCreateFolder(client, folderName) {
  // Root is at client.root; mkdir is idempotent — returns the existing node
  // if a child with that name already exists.
  let existing = null;
  try {
    existing = client.root.children.find(
      (c) => c.name === folderName && c.directory === true
    );
  } catch { /* children may be empty mid-bootstrap */ }

  if (existing) return existing;

  return new Promise((resolve, reject) => {
    const folder = client.mkdir(folderName, (err) => {
      if (err) {
        // Race-resilient: another concurrent mkdir may have created it.
        const created = client.root.children.find(
          (c) => c.name === folderName && c.directory === true
        );
        if (created) return resolve(created);
        return reject(err);
      }
      resolve(folder);
    });
  });
}

/**
 * Upload a Buffer to Mega. Destination is the app's dedicated folder, created
 * lazily (like Google Drive/Dropbox).
 *
 * @param {object} opts
 * @param {object} opts.creds     (unused — kept for signature parity)
 * @param {object} opts.tokens    Stored blob with email/password/key.
 * @param {string} opts.fileName
 * @param {string} [opts.mimeType]
 * @param {Buffer} opts.buffer
 * @param {(p:number)=>void} [opts.onProgress]
 *
 * @returns {Promise<{ fileId, webViewLink, path }>}
 */
async function uploadFile({ tokens, fileName, mimeType, buffer, onProgress }) {
  if (!tokens || (!tokens.password && !tokens.key)) {
    throw new Error('Mega is not connected. Reconnect in Settings.');
  }

  const client = buildClient(tokens);
  await new Promise((resolve, reject) => {
    client.once('ready', resolve);
    client.once('error', reject);
  });

  // Ensure the destination folder exists.
  const folder = await findOrCreateFolder(client, UPLOAD_DIR);
  const destPath = `${UPLOAD_DIR}/${fileName}`;

  // Upload with real-time progress. megajs `upload` accepts a Buffer or stream
  // and fires a progress event -1 → totalBytes regularly during put.
  const res = await new Promise((resolve, reject) => {
    const upload = client.upload(buffer, {
      name: fileName,
      // Drop the file into our working folder instead of root.
      target: folder,
      // onUploadProgress callback gives a partial request bytes-loaded array
      // (chunks), totalled by us.
    });

    // Progress events: `chunk` payloads carry a loaded/total pair per chunk.
    let totalLoaded = 0;
    const totalSize = buffer.length;

    upload.on('chunk', (chunk) => {
      totalLoaded += chunk.bytesLoaded || 0;
      if (onProgress && totalSize > 0) {
        onProgress(Math.min(1, totalLoaded / totalSize));
      }
    });

    upload.on('error', reject);
    upload.on('complete', (file) => {
      onProgress?.(1);
      resolve(file);
    });
  }).catch((err) => {
    // Some megajs versions emit through the Storage('upload') callback chain
    // intrinsically; if the events didn't fire (older API shape), fall through
    // to a callback-style retry.
    throw err;
  });

  // Best-effort URL. megajs returns a node handle, not a direct download URL.
  // A shareable link can be derived by creating a public link via
  // `file.link()` — non-fatal if permissions/storage quotas reject it.
  let webViewLink = null;
  try {
    if (res && typeof res.link === 'function') {
      webViewLink = await new Promise((r) =>
        res.link((err, url) => r(err ? null : url))
      );
    }
  } catch { /* sharing is optional */ }

  // The fileId placeholder we keep analogous to other services:
  const fileId = res?.nodeId || res?.attributes?.id || '';

  return {
    fileId,
    path: destPath,
    webViewLink,
  };
}

/**
 * disconnect — best-effort log-out. Mega doesn't expose a remote revoke, so
 * we just close the local session. The dispatcher clears the stored blob.
 */
async function revoke(storedCreds, tokens) {
  try {
    // megajs requires a logged-in client to close(); if storage has been
    // wiped already we silently no-op — local clear is the only thing that
    // matters for Mega (no remote token to invalidate).
    if (!tokens?.password && !tokens?.key) return;
    const client = buildClient(tokens);
    await new Promise((resolve) => {
      client.once('ready', () => {
        try { client.close(); } catch { /* ignore */ }
        resolve();
      });
      client.once('error', () => resolve());
    });
  } catch { /* local-clear proceeds regardless */ }
}

module.exports = {
  authorize,
  refreshIfNeeded,
  uploadFile,
  revoke,
};
