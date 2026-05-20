/* OpenToon Studio - Electron main process (desktop app + OTA updates) */
'use strict';
const { app, BrowserWindow, Menu, shell, dialog, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');

const isDev = process.argv.includes('--dev') || !app.isPackaged;
let win = null;
let penWin = null;         // secondary canvas-only "pen display" window
let splash = null;
let updater = null;
let splashAt = 0;          // when the splash became visible (0 = not shown yet)
let appReady = false;      // renderer has signalled it finished booting
let revealed = false;
let pendingOpenFile = null; // .otoon path the app was launched to open

// Pull a .otoon path out of a process argv list (file association / drag-onto-exe).
function argvFile(argv) {
  for (const arg of (argv || [])) {
    if (typeof arg === 'string' && /\.otoon$/i.test(arg)) {
      try { if (fs.existsSync(arg)) return arg; } catch (e) { /* ignore */ }
    }
  }
  return null;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 900,
    minHeight: 600,
    show: false,                 // revealed once the renderer signals app:ready
    backgroundColor: '#14161a',
    title: 'OpenToon Studio',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
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
  // re-created via 'activate' after startup -> no splash to wait on
  if (revealed) win.show();

  // closing the main window also closes its pen-display companion
  win.on('closed', () => {
    win = null;
    if (penWin && !penWin.isDestroyed()) penWin.close();
  });
}

/* ---- secondary "pen display" drawing window ----
   A canvas-only window meant to be dragged onto a Wacom-style pen display.
   It owns no project; it mirrors the main window's stage and forwards input
   back. See src/pencast.js and pen/pen.js for the two ends of the bridge. */
function createPenWindow() {
  if (penWin && !penWin.isDestroyed()) { penWin.focus(); return; }

  // a pen tablet is usually a second monitor -- open there if one exists
  let bounds = { x: undefined, y: undefined, width: 1180, height: 800 };
  try {
    const primary = screen.getPrimaryDisplay();
    const ext = screen.getAllDisplays().find(d => d.id !== primary.id);
    if (ext && ext.workArea) {
      bounds = {
        x: ext.workArea.x, y: ext.workArea.y,
        width: ext.workArea.width, height: ext.workArea.height
      };
    }
  } catch (e) { /* single display -- use the default size */ }

  penWin = new BrowserWindow({
    x: bounds.x, y: bounds.y,
    width: bounds.width, height: bounds.height,
    minWidth: 480, minHeight: 360,
    backgroundColor: '#0c0d10',
    title: 'OpenToon — Drawing Window',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'pen-preload.js')
    }
  });
  penWin.loadFile(path.join(__dirname, '..', 'pen', 'pen.html'));
  penWin.on('closed', () => {
    penWin = null;
    if (win && !win.isDestroyed()) win.webContents.send('opentoon:pen-detach');
  });
}

/* ---- launch splash window ---- */
const MIN_SPLASH_MS = 2200;   // keep the splash on screen at least this long

function createSplash() {
  splash = new BrowserWindow({
    width: 540,
    height: 360,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    show: false,
    backgroundColor: '#00000000',
    title: 'OpenToon',
    webPreferences: {
      preload: path.join(__dirname, 'splash-preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  splash.loadFile(path.join(__dirname, '..', 'splash', 'splash.html'));

  const showSplash = () => {
    if (splash && !splash.isDestroyed() && !splash.isVisible()) {
      splash.show();
      splashAt = Date.now();
      maybeReveal();
    }
  };
  // did-finish-load is reliable for a local file; ready-to-show is a bonus
  splash.webContents.once('did-finish-load', () => {
    showSplash();
    if (splash && !splash.isDestroyed())
      splash.webContents.send('splash:version', app.getVersion());
  });
  splash.once('ready-to-show', showSplash);
  splash.webContents.on('did-fail-load', () => forceReveal());
  splash.on('closed', () => { splash = null; });
}

// Reveal the main window once the app is ready AND the splash has had its
// minimum time on screen -- so a fast boot can't flash straight past it.
function maybeReveal() {
  if (revealed || !appReady) return;
  // splash exists but hasn't painted yet -> wait; showSplash() re-calls this
  if (splash && !splash.isDestroyed() && !splash.isVisible()) return;
  if (splashAt) {
    const shown = Date.now() - splashAt;
    if (shown < MIN_SPLASH_MS) {
      setTimeout(maybeReveal, MIN_SPLASH_MS - shown + 20);
      return;
    }
  }
  forceReveal();
}

// Unconditional reveal -- the safety net so the app can never get stuck.
function forceReveal() {
  if (revealed) return;
  revealed = true;
  if (win && !win.isDestroyed()) win.show();
  if (splash && !splash.isDestroyed()) splash.close();
  splash = null;
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
  // When an update has finished downloading, electron-updater will run the
  // installer the next time the app quits -- silently, with no installer
  // wizard -- and relaunch the new version. No more modal dialog asking the
  // artist to choose Restart / Later.
  autoUpdater.autoInstallOnAppQuit = true;
  // forward the update lifecycle to the renderer so the About dialog can show it
  autoUpdater.on('checking-for-update', () => sendUpdateStatus('checking'));
  autoUpdater.on('update-available', info =>
    sendUpdateStatus('available', { version: info && info.version }));
  autoUpdater.on('update-not-available', () => sendUpdateStatus('uptodate'));
  autoUpdater.on('download-progress', p =>
    sendUpdateStatus('downloading', { percent: Math.round((p && p.percent) || 0) }));
  autoUpdater.on('update-downloaded', info => {
    // No modal dialog. The renderer can surface a non-modal status if it
    // wants ("Update v1.0.x ready -- will install next time you quit"), and
    // the existing 'Install now' control via the IPC below still works.
    sendUpdateStatus('downloaded', { version: info && info.version });
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
    // isSilent=true, isForceRunAfter=true: pass /S to the NSIS installer so
    // no wizard appears, then relaunch the app on its own. Matches the
    // "silent install" flow the user expects from a desktop production tool.
    if (updater) { try { updater.quitAndInstall(true, true); } catch (e) { /* ignore */ } }
  });

  /* ---- project file IO ---- */
  ipcMain.handle('opentoon:save-dialog', async (_e, defaultPath) => {
    const r = await dialog.showSaveDialog(win, {
      title: 'Save Project',
      defaultPath: defaultPath || 'untitled.otoon',
      filters: [{ name: 'OpenToon Project', extensions: ['otoon'] }]
    });
    return r.canceled ? null : r.filePath;
  });
  ipcMain.handle('opentoon:open-dialog', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Open Project',
      properties: ['openFile'],
      filters: [{ name: 'OpenToon Project', extensions: ['otoon'] }]
    });
    return (r.canceled || !r.filePaths.length) ? null : r.filePaths[0];
  });
  ipcMain.handle('opentoon:read-file', (_e, file) => {
    try { return { ok: true, data: fs.readFileSync(file, 'utf8') }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('opentoon:write-file', (_e, file, data) => {
    try { fs.writeFileSync(file, data, 'utf8'); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  /* ---- crash-safe autosave to the userData folder (no quota limit) ---- */
  const autosaveFile = () => path.join(app.getPath('userData'), 'autosave.otoon');
  ipcMain.handle('opentoon:autosave-write', (_e, data) => {
    try { fs.writeFileSync(autosaveFile(), data, 'utf8'); return true; }
    catch (e) { return false; }
  });
  ipcMain.handle('opentoon:autosave-read', () => {
    try {
      const f = autosaveFile();
      if (!fs.existsSync(f)) return null;
      return { data: fs.readFileSync(f, 'utf8'), time: fs.statSync(f).mtimeMs };
    } catch (e) { return null; }
  });
  ipcMain.handle('opentoon:autosave-clear', () => {
    try { fs.unlinkSync(autosaveFile()); } catch (e) { /* already gone */ }
    return true;
  });

  /* ---- file the app was launched to open (double-click a .otoon) ---- */
  ipcMain.handle('opentoon:pending-file', () => {
    const f = pendingOpenFile;
    pendingOpenFile = null;
    return f;
  });

  /* ---- secondary pen-display window: open + relay frames / input ---- */
  ipcMain.handle('opentoon:pen-open', () => {
    const existed = !!(penWin && !penWin.isDestroyed());
    createPenWindow();
    return { ok: true, focused: existed };
  });
  // the pen window finished loading -> tell the main window to start streaming
  ipcMain.on('opentoon:pen-ready', () => {
    if (win && !win.isDestroyed()) win.webContents.send('opentoon:pen-attach');
  });
  // main -> pen : a composited stage frame (WebP ArrayBuffer + meta)
  ipcMain.on('opentoon:pen-frame', (_e, buf, meta) => {
    if (penWin && !penWin.isDestroyed())
      penWin.webContents.send('opentoon:pen-frame', buf, meta);
  });
  // pen -> main : forwarded pointer input
  ipcMain.on('opentoon:pen-input', (_e, msg) => {
    if (win && !win.isDestroyed()) win.webContents.send('opentoon:pen-input', msg);
  });
  // pen -> main : forwarded toolbar command
  ipcMain.on('opentoon:pen-command', (_e, msg) => {
    if (win && !win.isDestroyed()) win.webContents.send('opentoon:pen-command', msg);
  });
}

// Single-instance: a second launch (e.g. double-clicking another .otoon)
// hands its file to the already-running window instead of opening twice.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  pendingOpenFile = argvFile(process.argv);

  app.on('second-instance', (_e, argv) => {
    const f = argvFile(argv);
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.focus();
      if (f) win.webContents.send('opentoon:open-file', f);
    } else if (f) {
      pendingOpenFile = f;
    }
  });
  // macOS opens documents through this event rather than argv
  app.on('open-file', (e, p) => {
    e.preventDefault();
    if (win && !win.isDestroyed() && appReady) win.webContents.send('opentoon:open-file', p);
    else pendingOpenFile = p;
  });

  app.whenReady().then(() => {
    createSplash();
    createWindow();
    // the renderer signals app:ready once the project is loaded
    ipcMain.once('app:ready', () => { appReady = true; maybeReveal(); });
    ipcMain.on('app:loading', (_e, data) => {
      if (splash && !splash.isDestroyed())
        splash.webContents.send('splash:status', data || {});
    });
    // hard fallback: reveal anyway if the renderer never signals (load error)
    setTimeout(forceReveal, 12000);
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
}
