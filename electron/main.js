/* OpenToon Studio - Electron main process (desktop app + OTA updates) */
'use strict';
const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
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
  autoUpdater.on('update-downloaded', info => {
    dialog.showMessageBox(win, {
      type: 'info',
      title: 'Update ready',
      message: 'OpenToon ' + (info && info.version ? info.version : '') +
        ' has been downloaded. Restart now to install it?',
      buttons: ['Restart', 'Later'],
      defaultId: 0
    }).then(r => { if (r.response === 0) autoUpdater.quitAndInstall(); });
  });
  autoUpdater.on('error', err => console.log('Update check failed:', err && err.message));
  try { autoUpdater.checkForUpdatesAndNotify(); } catch (e) { /* offline */ }
  // re-check every 30 minutes while running
  setInterval(() => { try { autoUpdater.checkForUpdates(); } catch (e) {} }, 30 * 60 * 1000);
}

app.whenReady().then(() => {
  createWindow();
  watchForDev();
  setupUpdates();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
