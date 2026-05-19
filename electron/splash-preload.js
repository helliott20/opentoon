/* OpenToon Studio - Electron preload for the launch splash window.
   Bridges the main process -> splash renderer without nodeIntegration. */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('opentoonSplash', {
  onStatus(cb) { ipcRenderer.on('splash:status', (_e, payload) => cb(payload)); },
  onVersion(cb) { ipcRenderer.on('splash:version', (_e, v) => cb(v)); }
});
