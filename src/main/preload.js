const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('multirp', {
  // RPC controls
  connect: (profile) => ipcRenderer.invoke('rpc:connect', profile),
  disconnect: () => ipcRenderer.invoke('rpc:disconnect'),
  update: (profile) => ipcRenderer.invoke('rpc:update', profile),
  status: () => ipcRenderer.invoke('rpc:status'),
  onDisconnected: (cb) => ipcRenderer.on('rpc:disconnected', cb),

  // Persistence
  loadStore: () => ipcRenderer.invoke('store:load'),
  saveStore: (data) => ipcRenderer.invoke('store:save', data),

  // Per-profile import/export
  exportProfile: (profile) => ipcRenderer.invoke('profile:export', profile),
  importProfile: () => ipcRenderer.invoke('profile:import')
});
