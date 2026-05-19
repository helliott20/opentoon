/* OpenToon Studio - Electron main process (desktop app + OTA updates) */
'use strict';
const { app, BrowserWindow, Menu, shell, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const isDev = process.argv.includes('--dev') || !app.isPackaged;
let win = null;
let updater = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#14161a',
    title: 'OpenToon Studio',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, '..', 'index.html'));

  // open external links in the real browser, not the app window
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) { shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'allow' };
  });

  if (isDev) win.webContents.openDevTools({ mode: 'detach' });
}

/* ---- live reload while developing ---- */
function watchForDev() {
  if (!isDev) return;
  const dirs = ['src', 'styles'].map(d => path.join(__dirname, '..', d));
  let timer = null;
  const reload = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { if (win) win.webContents.reloadIgnoringCache(); }, 150);
  };
  for (const d of dirs) {
    try { fs.watch(d, { recursive: true }, reload); } catch (e) { /* ignore */ }
  }
  try {
    fs.watch(path.join(__dirname, '..', 'index.html'), reload);
  } catch (e) { /* ignore */ }
}

/* ---- OTA auto-update (electron-updater + GitHub Releases) ---- */
function sendUpdateStatus(state, data) {
  if (win && !win.isDestroyed())
    win.webContents.send('opentoon:update-status', Object.assign({ state }, data || {}));
}

function setupUpdates() {
  if (isDev) return;
  let autoUpdater;
  try {
    autoUpdater = require('electron-updater').autoUpdater;
  } catch (e) {
    console.log('electron-updater not installed - skipping OTA updates');
    return;
  }
  updater = autoUpdater;
  autoUpdater.autoDownload = true;
  // forward the update lifecycle to the renderer so the About dialog can show it
  autoUpdater.on('checking-for-update', () => sendUpdateStatus('checking'));
  autoUpdater.on('update-available', info =>
    sendUpdateStatus('available', { version: info && info.version }));
  autoUpdater.on('update-not-available', () => sendUpdateStatus('uptodate'));
  autoUpdater.on('download-progress', p =>
    sendUpdateStatus('downloading', { percent: Math.round((p && p.percent) || 0) }));
  autoUpdater.on('update-downloaded', info => {
    sendUpdateStatus('downloaded', { version: info && info.version });
    dialog.showMessageBox(win, {
      type: 'info',
      title: 'Update ready',
      message: 'OpenToon ' + (info && info.version ? info.version : '') +
        ' has been downloaded. Restart now to install it?',
      buttons: ['Restart', 'Later'],
      defaultId: 0
    }).then(r => { if (r.response === 0) autoUpdater.quitAndInstall(); });
  });
  autoUpdater.on('error', err => {
    sendUpdateStatus('error', { message: err && err.message });
    console.log('Update check failed:', err && err.message);
  });
  try { autoUpdater.checkForUpdatesAndNotify(); } catch (e) { /* offline */ }
  // re-check every 30 minutes while running
  setInterval(() => { try { autoUpdater.checkForUpdates(); } catch (e) {} }, 30 * 60 * 1000);
}

/* ---- IPC bridge for the renderer (version + manual update check) ---- */
function setupIpc() {
  ipcMain.handle('opentoon:get-version', () => app.getVersion());
  ipcMain.handle('opentoon:check-updates', () => {
    if (isDev) return { state: 'disabled', reason: 'dev' };
    if (!updater) return { state: 'disabled', reason: 'unavailable' };
    try { updater.checkForUpdates(); return { state: 'checking' }; }
    catch (e) { return { state: 'error', message: e && e.message }; }
  });
  ipcMain.on('opentoon:quit-install', () => {
    if (updater) { try { updater.quitAndInstall(); } catch (e) { /* ignore */ } }
  });
}

app.whenReady().then(() => {
  createWindow();
  setupIpc();
  watchForDev();
  setupUpdates();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
