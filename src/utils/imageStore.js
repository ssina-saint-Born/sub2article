/**
 * imageStore.js
 * ─────────────────────────────────────────────────────────────
 * Ephemeral client-side store for uploaded OCR page images.
 *
 * IMPORTANT ARCHITECTURE NOTE (Web build — VPS / Coolify / Nginx):
 *   The production build is a pure static SPA. Uploaded images NEVER
 *   touch the server — they live entirely in the user's browser (memory
 *   + this IndexedDB cache). So the "server memory / disk fills up"
 *   concern is really the *browser tab's* heap quota and the on-device
 *   IndexedDB. This store exists to:
 *
 *     1. Keep large base64 image payloads OUT of long-lived React state
 *        (components hold only a lightweight `ref`), so a big batch of
 *        pages doesn't balloon the render tree / context.
 *     2. Give us a single, reliable place to PURGE images the moment the
 *        user Extracts → Copies / Exports (PDF / Word) — the exact
 *        lifecycle the user asked for. We never keep an image longer than
 *        strictly necessary.
 *
 *   On the Electron desktop build this module is inert (isElectronIndexedDB
 *   is not used; the desktop already OCRs via the Node main process and
 *   doesn't persist images). Every API is a safe no-op when IndexedDB is
 *   unavailable, so the desktop path and unsupported browsers degrade
 *   gracefully without try/catch noise at every call site.
 *
 * Why a new table instead of reusing cloudUpload/webAuth storage?
 *   Books-to-digital images can be large (multi-MB base64) and are
 *   write-once / read-once / delete. We keep them isolated in their own
 *   object store so purging is one `clear()` and so we don't entangle
 *   auth tokens or upload buffers with page images.
 * ─────────────────────────────────────────────────────────────
 */

const DB_NAME   = 'subscribe-ai-ocr';
const STORE     = 'page-images';
const DB_VERSION = 1;

/**
 * One shared, lazily-opened connection. IndexedDB is happiest when a single
 * connection is reused; we open it once and queue transactions against it.
 * @type {Promise<IDBDatabase>|null}
 */
let dbPromise = null;

/** Is the IndexedDB API present at all in this runtime? */
function idbAvailable() {
  return typeof indexedDB !== 'undefined';
}

function getDb() {
  if (!idbAvailable()) return Promise.resolve(null);
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      // Create the object store on first run / version bump.
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error || new Error('IndexedDB open failed'));
      req.onblocked = () => reject(new Error('IndexedDB blocked (another tab holds an upgrade lock)'));
    });
  }
  return dbPromise;
}

/** Run `fn(store)` inside a read-write transaction, resolving on complete. */
function withStore(mode, fn) {
  return getDb().then((db) => {
    if (!db) return undefined; // IDB unavailable → silent no-op
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      let result;
      const maybeDone = (v) => { result = v; };
      try {
        fn(store, maybeDone);
      } catch (err) {
        reject(err);
        return;
      }
      tx.oncomplete = () => resolve(result);
      tx.onerror    = () => reject(tx.error || new Error('IDB transaction failed'));
      tx.onabort    = () => reject(tx.error || new Error('IDB transaction aborted'));
    });
  });
}

/**
 * Persist an image payload under `key`. Storing the full base64 dataUrl so
 * the caller can drop its in-memory copy. Values are strings (data URLs).
 * @param {string} key
 * @param {string} dataUrl
 * @returns {Promise<boolean>} true when actually stored
 */
export async function putImage(key, dataUrl) {
  if (!key || dataUrl == null) return false;
  try {
    await withStore('readwrite', (store) => store.put(dataUrl, key));
    return true;
  } catch {
    return false; // quota full / private mode — caller keeps dataUrl in memory
  }
}

/**
 * Retrieve a stored image dataUrl by key (null when missing/unavailable).
 * @param {string} key
 * @returns {Promise<string|null>}
 */
export async function getImage(key) {
  if (!key) return null;
  try {
    const value = await withStore('readonly', (store, done) => {
      const req = store.get(key);
      req.onsuccess = () => done(req.result ?? null);
      req.onerror   = () => done(null);
    });
    return value ?? null;
  } catch {
    return null;
  }
}

/** Delete a single image by key. Safe no-op when unavailable. */
export async function deleteImage(key) {
  if (!key) return;
  try {
    await withStore('readwrite', (store) => store.delete(key));
  } catch {
    /* ignore */
  }
}

/** Drop every stored image — the "purge after extract/download" hammer. */
export async function clearAllImages() {
  try {
    await withStore('readwrite', (store) => store.clear());
  } catch {
    /* ignore */
  }
}
