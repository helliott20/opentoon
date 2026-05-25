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
  // a .otoon double-clicked while the app is already running
  onOpenFile: cb => ipcRenderer.on('opentoon:open-file', (_e, p) => cb(p)),
  // secondary "pen display" drawing window (see src/pencast.js)
  openPenWindow: (opts) => ipcRenderer.invoke('opentoon:pen-open', opts),
  // one-shot query for the current pen-window open state + bounds —
  // used by io.js#captureWorkspace when saving the project.
  getPenWindowState: () => ipcRenderer.invoke('opentoon:pen-window-state'),
  // streamed bounds — fires whenever the user moves or resizes the
  // pen window so the renderer can cache the latest values without
  // a round-trip on every save.
  onPenBounds: cb => ipcRenderer.on('opentoon:pen-bounds', (_e, b) => cb(b)),
  onPenAttach: cb => ipcRenderer.on('opentoon:pen-attach', () => cb()),
  onPenDetach: cb => ipcRenderer.on('opentoon:pen-detach', () => cb()),
  // STATE CHANNEL for the pen window — see pen-preload.js. Tiny JSON ops
  // (project/cel/layer/tool/live-stroke). Acks ride back so the publisher
  // can detect divergence and resync.
  sendPenState: msg => ipcRenderer.send('opentoon:pen-state', msg),
  onPenStateAck: cb => ipcRenderer.on('opentoon:pen-state-ack', (_e, seq) => cb(seq)),
  onPenInput: cb => ipcRenderer.on('opentoon:pen-input', (_e, msg) => cb(msg)),
  onPenCommand: cb => ipcRenderer.on('opentoon:pen-command', (_e, msg) => cb(msg)),
  // real file IO for the desktop app: native dialogs, save-in-place, autosave
  fs: {
    saveDialog: (defaultPath) => ipcRenderer.invoke('opentoon:save-dialog', defaultPath),
    openDialog: () => ipcRenderer.invoke('opentoon:open-dialog'),
    readFile: (file) => ipcRenderer.invoke('opentoon:read-file', file),
    writeFile: (file, data) => ipcRenderer.invoke('opentoon:write-file', file, data),
    autosaveWrite: (data) => ipcRenderer.invoke('opentoon:autosave-write', data),
    autosaveRead: () => ipcRenderer.invoke('opentoon:autosave-read'),
    autosaveClear: () => ipcRenderer.invoke('opentoon:autosave-clear'),
    pendingFile: () => ipcRenderer.invoke('opentoon:pending-file'),
    statFile: (file) => ipcRenderer.invoke('opentoon:stat-file', file)
  }
});
