const http = require('http');
const { shell } = require('electron');

/**
 * oauthServer.js — a minimal loopback OAuth 2.0 redirect capture server.
 *
 * HOW THE FLOW WORKS (Authorization Code Grant):
 *   1. We build the provider's consent URL and open it in the user's default
 *      browser via `shell.openExternal`. The user signs in on the REAL
 *      google.com / dropbox.com page (we never see their password).
 *   2. On consent, the provider redirects the browser to
 *      http://localhost:8765/?code=<auth_code>&state=<nonce>
 *   3. This one-shot local server receives that GET request, verifies the
 *      `state` nonce to prevent CSRF / token swapping, and hands the mutable
 *      `code` back to the caller's `await start(...)`.
 *   4. The caller (googleDriveService / dropboxService) exchanges `code` for
 *      access + refresh tokens using their SDK.
 *   5. We immediately serve a friendly "You may close this tab" page and close
 *      the server, so the user isn't left on a dead host.
 *
 * SECURITY:
 *   • `state` is cryptographically random per flow and required to match.
 *   • Server listens only on 127.0.0.1, only for the duration of the flow,
 *     and rejects non-callback paths with 404.
 *   • No tokens transit through the page — only the one-time auth code.
 *
 * Pure Node + Electron `shell` only. No renderer dependency.
 */

// The one port we bind for all OAuth flows. Matches the redirect URI in
// googleDriveService / dropboxService defaults and the provider consoles.
const OAUTH_PORT = 8765;
// How long to wait for the user to finish consent before giving up.
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Dispose-safe wrapper so both resolve/reject can tear down the server/timer.
 */
function once(fn, cleanup) {
  let called = false;
  return (...args) => {
    if (called) return;
    called = true;
    cleanup();
    fn(...args);
  };
}

/**
 * Open the provider's consent URL in the default browser and block until the
 * loopback redirect arrives.
 *
 * @param {object}  opts
 * @param {string}  opts.provider     'Google Drive' | 'Dropbox' — only for the success page.
 * @param {string}  opts.authUrl      The provider's authorization/consent URL.
 * @param {string}  opts.state        Random nonce the provider must echo back.
 * @param {number} [opts.timeoutMs]   Abort after this long of user inactivity.
 *
 * @returns {Promise<{ code: string }>}  the authorization code.
 * @throws  {Error} on timeout, port conflict, state mismatch, or user denial.
 */
function start({ provider = 'Cloud provider', authUrl, state, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    let server = null;
    let timer = null;

    const cleanup = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (server) { try { server.close(); } catch { /* already closed */ } server = null; }
    };
    const done = once(resolve, cleanup);
    const fail = once(reject, cleanup);

    server = http.createServer((req, res) => {
      try {
        const url = new URL(req.url, `http://localhost:${OAUTH_PORT}`);
        // Only the loopback root path is a legitimate OAuth callback for us.
        if (url.pathname === '/') {
          const code = url.searchParams.get('code');
          const returnedState = url.searchParams.get('state');
          const oauthError = url.searchParams.get('error');

          // The user clicked "Cancel/deny" on the consent page.
          if (oauthError) {
            const desc = url.searchParams.get('error_description') || 'authorization was denied';
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end(errorPage(provider, `Authorization was not completed: ${desc}`));
            return fail(new Error(`${provider} authorization denied: ${oauthError} (${desc})`));
          }

          // CSRF / token-swap guard — the echoed state must equal ours.
          if (returnedState !== state) {
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end(errorPage(provider, 'Security check failed (state mismatch). Please try again.'));
            return fail(new Error(`${provider} OAuth state mismatch — aborting for security.`));
          }

          if (!code) {
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end(errorPage(provider, 'No authorization code received.'));
            return fail(new Error(`${provider} OAuth redirect missing 'code' parameter.`));
          }

          // Success! Show the user a friendly, brand-consistent page they can close.
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(successPage(provider));
          return done({ code });
        }

        // Catch-all: anything else on this port isn't ours.
        res.writeHead(404);
        res.end('Not found');
      } catch (err) {
        // Malformed request etc. — keep waiting, don't crash the flow.
        res.writeHead(500);
        res.end('Error');
      }
    });

    server.on('error', (err) => {
      // EADDRINUSE means another app holds port 8765 — actionable guidance.
      if (err.code === 'EADDRINUSE') {
        fail(new Error(`Port ${OAUTH_PORT} is already in use. Close the app that is using it (or another SubScribe AI instance) and retry.`));
      } else {
        fail(new Error(`Could not start OAuth listener on port ${OAUTH_PORT}: ${err.message}`));
      }
    });

    server.listen(OAUTH_PORT, '127.0.0.1', () => {
      // Open the consent screen in the user's default browser.
      shell.openExternal(authUrl).catch((err) => {
        fail(new Error(`Could not open ${provider} login in your browser: ${err.message}`));
      });
    });

    timer = setTimeout(() => {
      fail(new Error(`${provider} authorization timed out. No response received on localhost within ${Math.round(timeoutMs / 1000 / 60)} minutes.`));
    }, timeoutMs);
  });
}

// ─── The small HTML pages shown in the browser tab after redirect ───
function successPage(provider) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
    <title>${provider} connected</title>
    <meta name="viewport" content="width=device-width, initial-scale=1"/>
    <style>
      body {font-family:system-ui,Segoe UI,Roboto,sans-serif;background:#0f172a;color:#e2e8f0;
            display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}
      .card {background:#1e293b;border:1px solid #334155;border-radius:16px;padding:40px 48px;
             max-width:420px;text-align:center;box-shadow:0 10px 40px rgba(0,0,0,.4);}
      .icon {font-size:48px;margin-bottom:16px;display:block;}
      h1 {font-size:20px;margin:0 0 12px;color:#f1f5f9;}
      p {font-size:14px;color:#94a3b8;line-height:1.6;margin:0 0 20px;}
      .tag {display:inline-block;font-size:11px;background:#065f46;color:#6ee7b7;padding:4px 12px;
            border-radius:999px;font-weight:600;letter-spacing:.5px;}
    </style></head><body>
    <div class="card">
      <span class="icon">✅</span>
      <h1>${provider} Connected</h1>
      <p>Authorization completed successfully. You can now close this tab and return to <strong>SubScribe AI</strong>.</p>
      <span class="tag">SECURE CONNECTION</span>
    </div></body></html>`;
}

function errorPage(provider, message) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
    <title>${provider} — Error</title>
    <meta name="viewport" content="width=device-width, initial-scale=1"/>
    <style>
      body {font-family:system-ui,Segoe UI,Roboto,sans-serif;background:#0f172a;color:#e2e8f0;
            display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}
      .card {background:#1e293b;border:1px solid #334155;border-radius:16px;padding:40px 48px;
             max-width:420px;text-align:center;box-shadow:0 10px 40px rgba(0,0,0,.4);}
      .icon {font-size:48px;margin-bottom:16px;display:block;}
      h1 {font-size:20px;margin:0 0 12px;color:#fecaca;}
      p {font-size:14px;color:#94a3b8;line-height:1.6;margin:0 0 20px;word-break:break-word;}
      .hint {font-size:12px;color:#64748b;border-top:1px solid #334155;padding-top:16px;}
    </style></head><body>
    <div class="card">
      <span class="icon">⚠️</span>
      <h1>Connection Failed</h1>
      <p>${escapeHtml(message)}</p>
      <div class="hint">You can close this tab and try again from the Settings tab in SubScribe AI.</div>
    </div></body></html>`;
}

/** Escape HTML special chars for user-era error strings. */
function escapeHtml(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = { start, OAUTH_PORT };
