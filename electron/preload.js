/* OpenToon Studio - Electron preload (safe bridge to the renderer) */
'use strict';
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('OpenToonDesktop', {
  version: process.env.npm_package_version || '',
  platform: process.platform,
  isDesktop: true
});
