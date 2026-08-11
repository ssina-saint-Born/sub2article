import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { handleOAuthCallback } from './utils/webAuth';

/**
 * main.jsx — application entry point.
 *
 * On the WEB build (non-Electron), cloud OAuth uses the Implicit Grant flow
 * (see src/utils/webAuth.js). The provider redirects back to this very URL
 * with the access token in the URL hash. We must parse and stash that
 * token BEFORE React mounts, so:
 *   - The token doesn't linger in the URL hash any longer than necessary.
 *   - useCloudStorage's hydration sees the freshest "connected" state.
 *
 * handleOAuthCallback() is a no-op unless there's an in-flight OAuth flow
 * (validates the `state` nonce stored in sessionStorage), so this add is
 * harmless in the desktop Electron build (where the IPC-based flow lives
 * in the main process and never lands on this page with a token hash).
 */

// Parse the OAuth callback (if any) BEFORE rendering React.
// Fire-and-forget: the App mounts immediately; webAuth's promise resolves
// asynchronously once the token is stashed into localStorage. React will
// re-hydrate useCloudStorage with the fresh token on first render of the
// Settings tab because useCloudStorage reads the store on mount.
// (A synchronous wait here would just delay First Paint for no reason.)
handleOAuthCallback();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
