const { app, safeStorage } = require('electron');
const fs = require('fs/promises');
const path = require('path');

/**
 * credentialsManager.js — the secure token store (Phase 3, Task 7 foundation).
 *
 * OAuth tokens for cloud providers are sensitive credentials: they must NOT
 * live in plaintext localStorage. This module encrypts each provider's token
 * blob with Electron's `safeStorage`, which delegates to the OS keychain
 * (DPAPI on Windows, Keychain on macOS, libsecret on Linux). The encrypted
 * result is persisted to a single JSON file in the app's userData directory.
 *
 * The on-disk shape is:
 *   {
 *     "googleDrive": "<base64-of-encrypted-JSON>",
 *     "dropbox": "<base64-of-encrypted-JSON>"
 *   }
 *
 * Portability note: safeStorage produces ciphertext tied to the machine (and,
 * on some platforms, the user account). Tokens are NOT portable across
 * machines — which is the desired behavior for OAuth refresh tokens. If
 * `safeStorage.isEncryptionAvailable()` is false (e.g. Linux without
 * libsecret), we gracefully fall back to storing a plain JSON file and the
 * caller logs a warning. NODE/Electron-only — no renderer imports.
 */

// Where the encrypted token file lives.
function getStorePath() {
  return path.join(app.getPath('userData'), 'cloud-tokens.json');
}

/** True when the OS keychain is available for safeStorage encryption. */
function isEncryptionAvailable() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/** Encrypt a string to base64 ciphertext. Falls back to plaintext prefix if no keychain. */
function encrypt(plain) {
  if (isEncryptionAvailable()) {
    return `enc:${safeStorage.encryptString(plain).toString('base64')}`;
  }
  return `plain:${Buffer.from(plain, 'utf-8').toString('base64')}`;
}

/** Decrypt a base64 ciphertext produced by `encrypt`. */
function decrypt(stored) {
  if (stored.startsWith('enc:')) {
    const buf = Buffer.from(stored.slice(4), 'base64');
    return safeStorage.decryptString(buf);
  }
  if (stored.startsWith('plain:')) {
    return Buffer.from(stored.slice(6), 'base64').toString('utf-8');
  }
  // Legacy / unknown format — treat as unencrypted JSON directly.
  return stored;
}

/**
 * Read the raw { provider: encryptedString } map from disk.
 * Returns {} on any failure (missing file, corrupt JSON) — never throws.
 */
async function readRawMap() {
  try {
    const raw = await fs.readFile(getStorePath(), 'utf-8');
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

/** Persist the raw { provider: encryptedString } map to disk. */
async function writeRawMap(map) {
  const file = getStorePath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(map, null, 2), 'utf-8');
}

/**
 * Get the stored token object for a provider, or null.
 * @param {'googleDrive'|'dropbox'} provider
 * @returns {Promise<object|null>}  the decrypted token object (e.g. { access_token, refresh_token, ... })
 */
async function getTokens(provider) {
  const map = await readRawMap();
  const stored = map[provider];
  if (!stored) return null;
  try {
    return JSON.parse(decrypt(stored));
  } catch {
    return null;
  }
}

/**
 * Store a token object for a provider (encrypting it at rest).
 * Passing null/undefined clears the provider's entry.
 * @param {'googleDrive'|'dropbox'} provider
 * @param {object|null} tokens
 */
async function setTokens(provider, tokens) {
  const map = await readRawMap();
  if (tokens == null) {
    delete map[provider];
  } else {
    map[provider] = encrypt(JSON.stringify(tokens));
  }
  await writeRawMap(map);
}

/** Remove a provider's tokens entirely. */
async function clearTokens(provider) {
  return setTokens(provider, null);
}

/** Does this provider currently have stored tokens? (no decryption — cheap.) */
async function hasTokens(provider) {
  const map = await readRawMap();
  return Boolean(map[provider]);
}

module.exports = {
  getTokens,
  setTokens,
  clearTokens,
  hasTokens,
  isEncryptionAvailable,
};
