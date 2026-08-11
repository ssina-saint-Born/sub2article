const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs/promises');

// Keep a global reference of the window object
let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    frame: false,
    transparent: false,
    backgroundColor: '#0f172a',
    titleBarStyle: 'hidden',
    titleBarOverlay: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: path.join(__dirname, '../public/icon.png'),
    show: false,
  });

  // ─── Sync the maximize icon state to the renderer ───
  mainWindow.on('maximize', () => mainWindow.webContents.send('window-maximized'));
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('window-unmaximized'));

  // Graceful show after ready-to-show
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // In development, load from Vite dev server; in production, load built files.
  // `--dev` flag or an unpackaged app triggers dev mode. We only attempt the
  // dev server when explicitly requested via --dev, so `npm run start` (which
  // runs against the built dist/) works reliably without Vite running.
  const isDev = process.argv.includes('--dev');

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    // Production / packaged — load the built Vite output.
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// IPC: Window controls (called from TitleBar via preload)
// ─────────────────────────────────────────────────────────────────────────────
ipcMain.on('window-minimize', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on('window-maximize', () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  }
});

ipcMain.on('window-close', () => {
  if (mainWindow) mainWindow.close();
});

ipcMain.handle('window-is-maximized', () => {
  return mainWindow ? mainWindow.isMaximized() : false;
});

// ─────────────────────────────────────────────────────────────────────────────
// IPC: File system (for reading subtitles/images and writing exports)
// ─────────────────────────────────────────────────────────────────────────────

// Read a file and return its contents as UTF-8 text
ipcMain.handle('fs:read-text', async (_event, filePath) => {
  try {
    const data = await fs.readFile(filePath, 'utf-8');
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Read a file and return it as a base64 data URL (for images)
ipcMain.handle('fs:read-data-url', async (_event, filePath) => {
  try {
    const buffer = await fs.readFile(filePath);
    const ext = path.extname(filePath).slice(1).toLowerCase();
    const mimeMap = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };
    const mime = mimeMap[ext] || 'application/octet-stream';
    const base64 = buffer.toString('base64');
    return { ok: true, data: `data:${mime};base64,${base64}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Write text contents to a file (for exports)
ipcMain.handle('fs:write-file', async (_event, filePath, contents) => {
  try {
    await fs.writeFile(filePath, contents, 'utf-8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// IPC: Native dialogs
// ─────────────────────────────────────────────────────────────────────────────

// Open-file dialog. Options: { filters, multiple, title }
ipcMain.handle('dialog:open', async (_event, options = {}) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: options.title || 'Open File',
    properties: options.multiple ? ['openFile', 'multiSelections'] : ['openFile'],
    filters: options.filters || [
      { name: 'Subtitles', extensions: ['srt', 'vtt'] },
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) {
    return { ok: false, paths: [] };
  }
  return { ok: true, paths: result.filePaths };
});

// Save-file dialog. Options: { title, defaultName, filters }
ipcMain.handle('dialog:save', async (_event, options = {}) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: options.title || 'Save File',
    defaultPath: options.defaultName || 'output.txt',
    filters: options.filters || [
      { name: 'Text', extensions: ['txt'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (result.canceled || !result.filePath) {
    return { ok: false, path: '' };
  }
  return { ok: true, path: result.filePath };
});

// ─────────────────────────────────────────────────────────────────────────────
// IPC: Environment info
// ─────────────────────────────────────────────────────────────────────────────
ipcMain.handle('app:platform', () => process.platform);
ipcMain.handle('app:version', () => app.getVersion());

// Open an external URL in the user's default browser. The renderer cannot
// do this itself — clicking an `<a target="_blank">` would otherwise load
// the URL inside our frameless app window. Returns { ok, error? }.
ipcMain.handle('app:open-external', async (_event, url) => {
  try {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      throw new Error('Only http(s) URLs may be opened externally.');
    }
    await shell.openExternal(url);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// IPC: OCR (Tesseract runs in the MAIN process to avoid file:// + asar
// worker/WASM resolution failures that black-screen the renderer.)
// ─────────────────────────────────────────────────────────────────────────────
const ocr = require('./ocrWorker');

ipcMain.handle('ocr:run', async (event, payload) => {
  const { dataUrl, lang } = payload || {};
  // Forward progress to the renderer that requested this run.
  const sender = event.sender;
  const onProgress = (p) => {
    if (!sender.isDestroyed()) sender.send('ocr:progress', p);
  };
  return ocr.runOcr({ dataUrl, lang, onProgress });
});

ipcMain.handle('ocr:cancel', async () => {
  await ocr.cancelOcr();
  return { ok: true };
});

// ─────────────────────────────────────────────────────────────────────────────
// IPC: Cloud storage (Google Drive / Dropbox OAuth + upload)
//
// Channel naming follows the existing `namespace:action` convention. All
// handlers return { ok, ...payload, error? } so the renderer can log through
// its useLog() System Console uniformly (the main process has no visibility
// into React state).
// ─────────────────────────────────────────────────────────────────────────────
const cloud = require('./cloud');

ipcMain.handle('cloud:status', async (_event, provider) => {
  try {
    return await cloud.getStatus(provider);
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('cloud:connect', async (_event, provider) => {
  try {
    return await cloud.connect(provider);
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('cloud:disconnect', async (_event, provider) => {
  try {
    return await cloud.disconnect(provider);
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('cloud:upload', async (event, payload) => {
  try {
    const { provider, fileName, buffer, mimeType } = payload || {};
    const sender = event.sender;
    const onProgress = (progress) => {
      if (!sender.isDestroyed()) sender.send('cloud:upload-progress', { provider, fileName, progress });
    };
    // `buffer` arrives from the renderer as a serialized Buffer (Node IPC
    // preserves typed-array/buffer payloads across the context bridge).
    return await cloud.upload({ provider, fileName, buffer, mimeType, onProgress });
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Convenience: does the OS keychain (safeStorage) exist? The renderer uses
// this to warn if secrets fall back to plaintext on this platform.
ipcMain.handle('creds:encryption-available', async () => {
  try {
    return { ok: true, available: await cloud.credentialsAvailable() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
