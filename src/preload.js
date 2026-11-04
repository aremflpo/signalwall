const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('signalWall', {
  getState: () => ipcRenderer.invoke('app:get-state'),
  addSource: (source) => ipcRenderer.invoke('source:add', source),
  updateSource: (id, source) => ipcRenderer.invoke('source:update', id, source),
  removeSource: (id) => ipcRenderer.invoke('source:remove', id),
  startSource: (id) => ipcRenderer.invoke('source:start', id),
  stopSource: (id) => ipcRenderer.invoke('source:stop', id),
  startAll: () => ipcRenderer.invoke('source:start-all'),
  stopAll: () => ipcRenderer.invoke('source:stop-all'),
  setColumns: (columns) => ipcRenderer.invoke('settings:set-columns', columns),
  saveMultiview: (multiview) => ipcRenderer.invoke('multiview:save', multiview),
  createMultiview: (name, gridSize) => ipcRenderer.invoke('multiview:create', name, gridSize),
  activateMultiview: (id) => ipcRenderer.invoke('multiview:activate', id),
  exportMultiview: (id) => ipcRenderer.invoke('multiview:export', id),
  importMultiview: () => ipcRenderer.invoke('multiview:import'),
  chooseFfmpeg: () => ipcRenderer.invoke('settings:choose-ffmpeg'),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  onStatus: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('stream:status', handler);
    return () => ipcRenderer.removeListener('stream:status', handler);
  },
  onStateReplaced: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('app:state-replaced', handler);
    return () => ipcRenderer.removeListener('app:state-replaced', handler);
  },
});
