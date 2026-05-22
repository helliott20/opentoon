/* OpenToon Studio - preload for the secondary "pen display" window.
   Bridges the canvas-only drawing window to the main window via the main
   process. The pen window owns no project state of its own. */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('OpenToonPen', {
  // STATE CHANNEL — project / cel / layer / tool / live-stroke ops. Tiny
  // JSON messages, ride a different IPC channel so they aren't starved by
  // the heavy bitmap encoder.
  onState: cb => ipcRenderer.on('opentoon:pen-state', (_e, msg) => cb(msg)),
  sendStateAck: seq => ipcRenderer.send('opentoon:pen-state-ack', seq),
  // forward pen / mouse pointer input to the main window
  sendInput: msg => ipcRenderer.send('opentoon:pen-input', msg),
  // forward a toolbar command (tool / colour / undo / ...) to the main window
  sendCommand: msg => ipcRenderer.send('opentoon:pen-command', msg),
  // signal that this window has finished loading and wants the first frame
  ready: () => ipcRenderer.send('opentoon:pen-ready')
});
