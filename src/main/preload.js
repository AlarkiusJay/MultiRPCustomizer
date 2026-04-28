const { contextBridge, ipcRenderer, shell } = require('electron');

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
  importProfile: () => ipcRenderer.invoke('profile:import'),

  // External link opener (safe wrapper — only allows http/https URLs)
  openExternal: (url) => {
    try {
      const u = new URL(url);
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        return shell.openExternal(url);
      }
    } catch (_) {}
    return Promise.resolve(false);
  },

  // App info
  getVersion: () => ipcRenderer.invoke('app:getVersion'),

  // Auto-updater bridge
  updates: {
    status: () => ipcRenderer.invoke('updates:status'),
    check: () => ipcRenderer.invoke('updates:check'),
    download: () => ipcRenderer.invoke('updates:download'),
    install: () => ipcRenderer.invoke('updates:install'),
    setAutoInstall: (enabled) => ipcRenderer.invoke('updates:setAutoInstall', enabled),
    getHistory: () => ipcRenderer.invoke('updates:getHistory'),
    onState: (cb) => {
      const listener = (_e, state) => cb(state);
      ipcRenderer.on('updates:state', listener);
      return () => ipcRenderer.removeListener('updates:state', listener);
    }
  }
});
