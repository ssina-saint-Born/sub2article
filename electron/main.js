const { app, BrowserWindow, ipcMain, dialog } = require('electron');
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
