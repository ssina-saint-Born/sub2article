const fs = require('fs');
const path = require('path');

/**
 * cloudProviders.js — loads the OAuth client credentials (client ID / secret /
 * app key / app secret) our app uses to talk to Google Drive and Dropbox.
 *
 * WHY NOT HARDCODED: OAuth client secrets are per-application and must be kept
 * out of source control. The user supplies their own registered apps:
 *   • Google Drive  → Google Cloud Console → APIs & Services → Credentials
 *                     (OAuth client of type "Desktop app")
 *   • Dropbox       → Dropbox App Console  → Scoped app (Full access or
 *                     App folder)
 * and drops the values into a gitignored `cloud.providers.json` next to this
 * file. As a fallback (useful for CI / packaging), we also read environment
 * variables.
 *
 * REDIRECT URI: Both providers are configured to redirect to
 *   http://localhost:8765/
 * which our loopback `oauthServer` listens on. In your provider consoles, add
 * that exact URI to the "Authorized redirect URIs" list.
 *
 * This module is synchronous & pure Node — it throws descriptive Errors with
 * actionable guidance, which the IPC layer catches and returns as
 * `{ ok: false, error }`.
 */

const EXAMPLE_PATH = path.join(__dirname, 'cloud.providers.example.json');
const CONFIG_PATH = path.join(__dirname, 'cloud.providers.json');

const DEFAULT_REDIRECT_URI = 'http://localhost:8765/';

/** Read the optional user-supplied config file, or null if absent/corrupt. */
function readConfigFile() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return null;
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) || null;
  } catch (err) {
    // A malformed file is a hard error — user must fix it rather than
    // silently fall back to env vars and confuse which config is active.
    throw new Error(
      `cloud.providers.json exists but is not valid JSON: ${err.message}`
    );
  }
}

/**
 * Load provider credentials for a specific provider.
 * Throws a descriptive Error only if *that* provider's credentials are missing.
 *
 * @param {'googleDrive'|'dropbox'} provider
 * @returns {Promise<{ clientId?, clientSecret?, appKey?, appSecret?, redirectUri: string }>}
 */
async function loadProviderCredentials(provider) {
  const cfg = readConfigFile() || {};

  const google = {
    clientId: cfg?.googleDrive?.clientId?.trim() || process.env.GOOGLE_DRIVE_CLIENT_ID || '',
    clientSecret: cfg?.googleDrive?.clientSecret?.trim() || process.env.GOOGLE_DRIVE_CLIENT_SECRET || '',
    redirectUri: (cfg?.googleDrive?.redirectUri?.trim() || DEFAULT_REDIRECT_URI),
  };

  const dropbox = {
    appKey: cfg?.dropbox?.appKey?.trim() || process.env.DROPBOX_APP_KEY || '',
    appSecret: cfg?.dropbox?.appSecret?.trim() || process.env.DROPBOX_APP_SECRET || '',
    redirectUri: (cfg?.dropbox?.redirectUri?.trim() || DEFAULT_REDIRECT_URI),
  };

  if (provider === 'googleDrive') {
    if (!google.clientId || !google.clientSecret) {
      throw new Error(
        `Google Drive is not configured.\n` +
        `Create ${path.basename(CONFIG_PATH)} next to ${path.basename(EXAMPLE_PATH)} ` +
        `(copy the example and fill in your Google OAuth clientId + clientSecret), or set GOOGLE_DRIVE_CLIENT_ID/SECRET.\n` +
        `Redirect URI must include ${google.redirectUri}`
      );
    }
    return { ...google, provider: 'googleDrive' };
  }
  if (provider === 'dropbox') {
    if (!dropbox.appKey || !dropbox.appSecret) {
      throw new Error(
        `Dropbox is not configured.\n` +
        `Create ${path.basename(CONFIG_PATH)} next to ${path.basename(EXAMPLE_PATH)} ` +
        `(copy the example and fill in your Dropbox appKey + appSecret), or set DROPBOX_APP_KEY/SECRET.\n` +
        `Redirect URI must include ${dropbox.redirectUri}`
      );
    }
    return { ...dropbox, provider: 'dropbox' };
  }
  throw new Error(`Unknown provider "${provider}".`);
}

/** Load both providers at once (for IPC status checks). Never throws. */
async function loadAllProviders() {
  const cfg = readConfigFile() || {};
  return {
    googleDrive: {
      clientId: cfg?.googleDrive?.clientId?.trim() || process.env.GOOGLE_DRIVE_CLIENT_ID || '',
      clientSecret: cfg?.googleDrive?.clientSecret?.trim() || process.env.GOOGLE_DRIVE_CLIENT_SECRET || '',
      redirectUri: cfg?.googleDrive?.redirectUri?.trim() || DEFAULT_REDIRECT_URI,
    },
    dropbox: {
      appKey: cfg?.dropbox?.appKey?.trim() || process.env.DROPBOX_APP_KEY || '',
      appSecret: cfg?.dropbox?.appSecret?.trim() || process.env.DROPBOX_APP_SECRET || '',
      redirectUri: cfg?.dropbox?.redirectUri?.trim() || DEFAULT_REDIRECT_URI,
    },
  };
}

module.exports = { loadProviderCredentials, loadAllProviders, DEFAULT_REDIRECT_URI };
