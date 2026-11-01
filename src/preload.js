const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sessionmax', {
  onSessions: (cb) => ipcRenderer.on('sessions', (_e, data) => cb(data)),
  onMode: (cb) => ipcRenderer.on('mode', (_e, data) => cb(data)),
  onDrag: (cb) => ipcRenderer.on('drag', (_e, data) => cb(data)),
  minimize: () => ipcRenderer.send('minimize'),
  expand: () => ipcRenderer.send('expand'),
  closeTask: (id) => ipcRenderer.send('close-task', id),
  closeAll: () => ipcRenderer.send('close-all'),
  openSession: (hostSessionId) => ipcRenderer.send('open-session', hostSessionId),
  setMuted: (m) => ipcRenderer.send('set-muted', m),
  setPinned: (p) => ipcRenderer.send('set-pinned', p),
  dragStart: () => ipcRenderer.send('pill-drag-start'),
  dragMove: () => ipcRenderer.send('pill-drag-move'),
  dragEnd: () => ipcRenderer.send('pill-drag-end'),
  hide: () => ipcRenderer.send('hide'),
  hidePanel: () => ipcRenderer.send('hide-panel'),
});
