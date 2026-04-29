const { contextBridge, ipcRenderer, shell } = require('electron');

contextBridge.exposeInMainWorld('multirp', {
  // RPC controls
  connect: (profile) => ipcRenderer.invoke('rpc:connect', profile),
  disconnect: () => ipcRenderer.invoke('rpc:disconnect'),
  update: (profile) => ipcRenderer.invoke('rpc:update', profile),
  status: () => ipcRenderer.invoke('rpc:status'),
  onDisconnected: (cb) => ipcRenderer.on('rpc:disconnected', cb),
  onActiveChanged: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('rpc:activeChanged', listener);
    return () => ipcRenderer.removeListener('rpc:activeChanged', listener);
  },

  // Persistence
  loadStore: () => ipcRenderer.invoke('store:load'),
  saveStore: (data) => ipcRenderer.invoke('store:save', data),

  // Per-profile import/export
  exportProfile: (profile) => ipcRenderer.invoke('profile:export', profile),
  importProfile: () => ipcRenderer.invoke('profile:import'),

  // Discord application asset resolver (for live preview thumbnails)
  resolveAsset: (clientId, key) => ipcRenderer.invoke('assets:resolve', { clientId, key }),
  listAssets: (clientId) => ipcRenderer.invoke('assets:list', { clientId }),

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

  // "View as others" popout window
  openPopout: () => ipcRenderer.invoke('popout:open'),
  closePopout: () => ipcRenderer.invoke('popout:close'),
  popoutSync: (snapshot) => ipcRenderer.send('popout:sync', snapshot),
  popoutReady: () => ipcRenderer.send('popout:ready'),
  onPopoutSnapshot: (cb) => {
    const listener = (_e, snap) => cb(snap);
    ipcRenderer.on('popout:snapshot', listener);
    return () => ipcRenderer.removeListener('popout:snapshot', listener);
  },
  onPopoutReady: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('popout:requestSnapshot', listener);
    return () => ipcRenderer.removeListener('popout:requestSnapshot', listener);
  },

  // Startup / tray settings bridge
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    setAutoStart: (enabled) => ipcRenderer.invoke('settings:setAutoStart', enabled),
    setStartMinimized: (enabled) => ipcRenderer.invoke('settings:setStartMinimized', enabled),
    setCloseToTray: (enabled) => ipcRenderer.invoke('settings:setCloseToTray', enabled)
  },

  // Auto Presence bridge (v1.6.0)
  auto: {
    get: () => ipcRenderer.invoke('auto:get'),
    set: (cfg) => ipcRenderer.invoke('auto:set', cfg),
    onStatus: (cb) => {
      const listener = (_e, status) => cb(status);
      ipcRenderer.on('auto:status', listener);
      return () => ipcRenderer.removeListener('auto:status', listener);
    }
  },

  // v1.8.0 — Custom About Field (Discord App Description override)
  about: {
    setToken: (profileId, token) => ipcRenderer.invoke('about:setToken', { profileId, token }),
    clearToken: (profileId) => ipcRenderer.invoke('about:clearToken', { profileId }),
    hasToken: (profileId) => ipcRenderer.invoke('about:hasToken', { profileId }),
    isAvailable: () => ipcRenderer.invoke('about:isAvailable'),
    push: (profile, force) => ipcRenderer.invoke('about:push', { profile, force: !!force }),
    onPushed: (cb) => {
      const listener = (_e, payload) => cb(payload);
      ipcRenderer.on('about:pushed', listener);
      return () => ipcRenderer.removeListener('about:pushed', listener);
    }
  },

  // v1.7.0 — Hotkeys + Idle + Game Detection + Always-On-Top
  extSettings: {
    get: () => ipcRenderer.invoke('extSettings:get'),
    set: (cfg) => ipcRenderer.invoke('extSettings:set', cfg),
    onChanged: (cb) => {
      const listener = (_e, s) => cb(s);
      ipcRenderer.on('extSettings:changed', listener);
      return () => ipcRenderer.removeListener('extSettings:changed', listener);
    }
  },

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
