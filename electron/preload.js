const { contextBridge, ipcRenderer } = require('electron');

/**
 * preload.js — the ONLY bridge between the renderer (React) and the
 * Node.js/Electron main process. Because contextIsolation is enabled,
 * the renderer cannot access Node directly; it must go through here.
 *
 * We expose a deliberately narrow, named API under window.electronAPI.
 */

contextBridge.exposeInMainWorld('electronAPI', {
  // ─── Window controls (used by TitleBar.jsx) ───
  window: {
    minimize: () => ipcRenderer.send('window-minimize'),
    maximize: () => ipcRenderer.send('window-maximize'),
    close: () => ipcRenderer.send('window-close'),
    isMaximized: () => ipcRenderer.invoke('window-is-maximized'),
    onMaximizeChange: (callback) => {
      const handler = () => callback(true);
      const handlerUn = () => callback(false);
      ipcRenderer.on('window-maximized', handler);
      ipcRenderer.on('window-unmaximized', handlerUn);
      // Return an unsubscribe function
      return () => {
        ipcRenderer.removeListener('window-maximized', handler);
        ipcRenderer.removeListener('window-unmaximized', handlerUn);
      };
    },
  },

  // ─── File system (for upcoming phases: reading subtitles/images, writing exports) ───
  fs: {
    // Read a file as text (e.g., .srt / .vtt)
    readFileText: (filePath) => ipcRenderer.invoke('fs:read-text', filePath),
    // Read a file as a base64 data URL (e.g., images)
    readFileDataURL: (filePath) => ipcRenderer.invoke('fs:read-data-url', filePath),
    // Write text to a file (e.g., exports)
    writeFile: (filePath, contents) => ipcRenderer.invoke('fs:write-file', filePath, contents),
    // Open a native open-file dialog → returns array of paths or empty
    showOpenDialog: (options) => ipcRenderer.invoke('dialog:open', options),
    // Open a native save-file dialog → returns path or empty
    showSaveDialog: (options) => ipcRenderer.invoke('dialog:save', options),
  },

  // ─── Environment info (safe to expose) ───
  app: {
    getPlatform: () => ipcRenderer.invoke('app:platform'),
    getVersion: () => ipcRenderer.invoke('app:version'),
  },

  // ─── OCR (Tesseract runs in the main process) ───
  ocr: {
    // Run OCR on a data URL. Returns { ok, text, error? }.
    // Progress is delivered via onProgress(p) where p is 0..1.
    run: ({ dataUrl, lang, onProgress } = {}) => {
      // Wire up the progress listener for this call.
      const handler = (_e, p) => {
        if (typeof onProgress === 'function') onProgress(p);
      };
      ipcRenderer.on('ocr:progress', handler);
      return ipcRenderer
        .invoke('ocr:run', { dataUrl, lang })
        .finally(() => ipcRenderer.removeListener('ocr:progress', handler));
    },
    // Cancel any in-flight OCR run.
    cancel: () => ipcRenderer.invoke('ocr:cancel'),
  },
});
