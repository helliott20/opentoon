/* OpenToon Studio - Electron preload (safe bridge to the renderer) */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('OpenToonDesktop', {
  platform: process.platform,
  isDesktop: true,
  // real app version (works in packaged builds, unlike npm_package_version)
  getVersion: () => ipcRenderer.invoke('opentoon:get-version'),
  // ask the main process to check GitHub Releases for an update
  checkForUpdates: () => ipcRenderer.invoke('opentoon:check-updates'),
  // subscribe to update lifecycle events (checking / available / ... )
  onUpdateStatus: cb =>
    ipcRenderer.on('opentoon:update-status', (_e, data) => cb(data)),
  quitAndInstall: () => ipcRenderer.send('opentoon:quit-install'),
  // tell the main process the app has finished booting (dismisses the splash)
  signalReady: () => ipcRenderer.send('app:ready'),
  splashProgress: (pct, label) => ipcRenderer.send('app:loading', { pct: pct, label: label }),
  // real file IO for the desktop app: native dialogs, save-in-place, autosave
  fs: {
    saveDialog: (defaultPath) => ipcRenderer.invoke('opentoon:save-dialog', defaultPath),
    openDialog: () => ipcRenderer.invoke('opentoon:open-dialog'),
    readFile: (file) => ipcRenderer.invoke('opentoon:read-file', file),
    writeFile: (file, data) => ipcRenderer.invoke('opentoon:write-file', file, data),
    autosaveWrite: (data) => ipcRenderer.invoke('opentoon:autosave-write', data),
    autosaveRead: () => ipcRenderer.invoke('opentoon:autosave-read'),
    autosaveClear: () => ipcRenderer.invoke('opentoon:autosave-clear')
  }
});
