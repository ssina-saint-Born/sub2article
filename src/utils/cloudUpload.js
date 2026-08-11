import { useLog } from '../contexts/LogContext';

/**
 * cloudUpload.js — a small, pure helper for uploading raw bytes to a
 * connected cloud provider from any React component, WITHOUT needing to know
 * how OAuth/tokens are stored or how progress is logged.
 *
 * The component supplies its `cloud` object (from `useCloudStorage`) and this
 * function handles the protocol detail of turning UTF-8 text / a Uint8Array /
 * an ArrayBuffer into the `buffer` the preload bridge expects.
 *
 * PORTABILITY: This file has zero Electron imports and zero React state.
 * When Task 11 ships a web API, only `useCloudStorage`'s `upload` impl
 * changes; this helper stays untouched.
 *
 * @param {ReturnType<typeof import('../hooks/useCloudStorage').useCloudStorage>} cloud
 * @param {object} opts
 * @param {string} opts.provider            'googleDrive' | 'dropbox'
 * @param {string} opts.fileName            e.g. "dataset-instruction-1719.json"
 * @param {string|ArrayBuffer|Uint8Array} opts.data   contents to upload
 * @param {string} opts.mimeType            e.g. 'application/json'
 * @param {(msg:type)=>void} [opts.onLog]   optional override for logging
 *
 * @returns {Promise<{ok, webViewLink?, link?, path?, fileId?, error?}>}
 */
export async function uploadTextToCloud(cloud, { provider, fileName, data, mimeType = 'application/octet-stream' }) {
  if (!cloud || typeof cloud.upload !== 'function') {
    return { ok: false, error: 'Cloud storage is not available in this environment.' };
  }
  let buffer;
  try {
    if (typeof data === 'string') {
      buffer = new TextEncoder().encode(data);           // UTF-8 → Uint8Array
    } else if (data instanceof ArrayBuffer) {
      buffer = new Uint8Array(data);
    } else if (data instanceof Uint8Array) {
      buffer = data;
    } else {
      throw new Error('Unsupported data type for upload.');
    }
  } catch (err) {
    return { ok: false, error: `Could not prepare file: ${err.message}` };
  }
  return cloud.upload(provider, { fileName, buffer, mimeType });
}

export default uploadTextToCloud;
