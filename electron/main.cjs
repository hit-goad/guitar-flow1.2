const { app, BrowserWindow, dialog, ipcMain, session, shell, desktopCapturer } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');

const DEV_URL = process.env.VITE_DEV_SERVER_URL || 'http://127.0.0.1:5173';
const isDev = !app.isPackaged;

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#0b0e13',
    title: 'GuitarFlow 吉他流',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
    },
  });

  if (isDev) {
    mainWindow.loadURL(DEV_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/** 系统内录：Windows 上 Electron 支持 loopback 音频 */
function setupDisplayMedia() {
  session.defaultSession.setDisplayMediaRequestHandler(
    async (request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen'] });
        callback({ video: sources[0], audio: 'loopback' });
      } catch (err) {
        console.error('[display-media]', err);
        callback({});
      }
    },
    { useSystemPicker: false },
  );
}

ipcMain.handle('gf:openFiles', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择曲谱文件',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '曲谱', extensions: ['gp', 'gp3', 'gp4', 'gp5', 'gpx', 'gp7', 'musicxml', 'xml', 'mid', 'midi', 'tex', 'txt', 'tab', 'crd', 'cho', 'chordpro', 'pdf', 'png', 'jpg', 'jpeg', 'webp'] },
      { name: '全部文件', extensions: ['*'] },
    ],
  });
  if (result.canceled) return [];
  const files = [];
  for (const filePath of result.filePaths) {
    const buf = await fs.readFile(filePath);
    files.push({ name: path.basename(filePath), bytes: new Uint8Array(buf) });
  }
  return files;
});

ipcMain.handle('gf:saveFile', async (_event, defaultName, bytes) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '保存',
    defaultPath: defaultName,
  });
  if (result.canceled || !result.filePath) return null;
  await fs.writeFile(result.filePath, Buffer.from(bytes));
  return result.filePath;
});

ipcMain.handle('gf:httpGet', async (_event, url, headers) => {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 GuitarFlow/1.0', ...(headers || {}) },
      redirect: 'follow',
    });
    const body = await res.text();
    return { status: res.status, body };
  } catch (err) {
    return { status: 0, body: String(err && err.message ? err.message : err) };
  }
});

ipcMain.handle('gf:httpGetBinary', async (_event, url, headers) => {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 GuitarFlow/1.0', ...(headers || {}) },
      redirect: 'follow',
    });
    const arrayBuffer = await res.arrayBuffer();
    return { status: res.status, bytes: new Uint8Array(arrayBuffer) };
  } catch (err) {
    console.error('[httpGetBinary]', err);
    return { status: 0, bytes: new Uint8Array() };
  }
});

ipcMain.handle('gf:captureSystemAudio', async () => {
  if (!mainWindow) return false;
  // 渲染进程会调用 getDisplayMedia；这里只确认能力
  return true;
});

app.whenReady().then(() => {
  setupDisplayMedia();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});