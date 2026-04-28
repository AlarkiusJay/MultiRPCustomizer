/*
 * Copyright 2026 Alarkius Elvya Jay
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */
const { app, BrowserWindow, ipcMain, dialog, Menu, Tray, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const RPC = require('discord-rpc');
const { autoUpdater } = require('electron-updater');
const profileFormats = require('./profile-formats');

let mainWindow = null;
let tray = null;               // system tray instance
let activeClient = null;       // current discord-rpc Client
let activeProfileId = null;    // which profile is currently active
let activeActivity = null;     // last sent activity payload (for re-send)

// True quit vs hide-to-tray. Set by tray Quit menu / explicit quit IPC.
app.isQuitting = false;

// True when the process was launched with --hidden (auto-start to tray).
const startHidden = process.argv.includes('--hidden');

// ---------- Auto-update state ----------
// Persisted user setting: should we auto-install on next launch?
// Live state: surfaced to renderer via 'updates:status' IPC.
let updateState = {
  status: 'idle',          // 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
  currentVersion: null,    // populated on app ready
  latestVersion: null,
  releaseNotes: null,
  releaseName: null,
  releaseDate: null,
  downloadPercent: 0,
  error: null,
  lastChecked: null
};

// Where we persist profiles
const userDataPath = () => app.getPath('userData');
const profilesFile = () => path.join(userDataPath(), 'profiles.json');
const settingsFile = () => path.join(userDataPath(), 'settings.json');
const updateHistoryFile = () => path.join(userDataPath(), 'update-history.json');

const DEFAULT_SETTINGS = {
  autoInstall: true,       // auto-install updates on next launch
  autoStart: false,        // launch MultiRP at system login
  startMinimized: true,    // when auto-starting, start hidden in tray
  closeToTray: true        // closing the window hides to tray instead of quitting
};

function loadSettings() {
  try {
    if (fs.existsSync(settingsFile())) {
      const raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf-8'));
      return { ...DEFAULT_SETTINGS, ...raw };
    }
  } catch (e) {
    console.error('Failed to load settings:', e);
  }
  return { ...DEFAULT_SETTINGS };
}

function saveSettings(s) {
  try {
    fs.mkdirSync(userDataPath(), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
    return true;
  } catch (e) {
    console.error('Failed to save settings:', e);
    return false;
  }
}

function loadUpdateHistory() {
  try {
    if (fs.existsSync(updateHistoryFile())) {
      return JSON.parse(fs.readFileSync(updateHistoryFile(), 'utf-8'));
    }
  } catch (e) {
    console.error('Failed to load update history:', e);
  }
  return [];
}

function appendUpdateHistory(entry) {
  try {
    const hist = loadUpdateHistory();
    hist.push(entry);
    // Keep last 50 entries max
    while (hist.length > 50) hist.shift();
    fs.mkdirSync(userDataPath(), { recursive: true });
    fs.writeFileSync(updateHistoryFile(), JSON.stringify(hist, null, 2));
  } catch (e) {
    console.error('Failed to append update history:', e);
  }
}

// ---------- Auto-updater wiring ----------
function emitUpdateState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('updates:state', updateState);
  }
}

function setupAutoUpdater() {
  autoUpdater.autoDownload = false;          // we control download timing
  autoUpdater.autoInstallOnAppQuit = false;  // we honor user's auto-install toggle ourselves
  autoUpdater.allowPrerelease = false;

  autoUpdater.on('checking-for-update', () => {
    updateState.status = 'checking';
    updateState.error = null;
    updateState.lastChecked = Date.now();
    emitUpdateState();
  });

  autoUpdater.on('update-available', (info) => {
    updateState.status = 'available';
    updateState.latestVersion = info.version;
    updateState.releaseNotes = typeof info.releaseNotes === 'string' ? info.releaseNotes : (info.releaseNotes || null);
    updateState.releaseName = info.releaseName || null;
    updateState.releaseDate = info.releaseDate || null;
    updateState.error = null;
    emitUpdateState();

    // Auto-download if user has auto-install enabled
    const settings = loadSettings();
    if (settings.autoInstall) {
      autoUpdater.downloadUpdate().catch((err) => {
        console.error('autoUpdater.downloadUpdate failed:', err);
      });
    }
  });

  autoUpdater.on('update-not-available', (info) => {
    updateState.status = 'not-available';
    updateState.latestVersion = info.version;
    updateState.error = null;
    emitUpdateState();
  });

  autoUpdater.on('download-progress', (progress) => {
    updateState.status = 'downloading';
    updateState.downloadPercent = Math.round(progress.percent || 0);
    emitUpdateState();
  });

  autoUpdater.on('update-downloaded', (info) => {
    updateState.status = 'downloaded';
    updateState.latestVersion = info.version;
    updateState.downloadPercent = 100;
    emitUpdateState();

    appendUpdateHistory({
      ts: Date.now(),
      event: 'downloaded',
      from: updateState.currentVersion,
      to: info.version
    });
  });

  autoUpdater.on('error', (err) => {
    updateState.status = 'error';
    updateState.error = err && err.message ? err.message : String(err);
    emitUpdateState();
  });
}

// On launch, if a previous run downloaded an update AND user has auto-install ON,
// quitAndInstall() is the natural path. But since electron-updater stages the update
// and applies it at quit-time, the simplest "install on next launch" flow is:
// detect downloaded -> if autoInstall, prompt install at app ready.
// We'll instead run a post-install detection: if running version differs from a
// recorded "downloaded" entry, log the install in history.
function reconcileInstallHistory() {
  try {
    const hist = loadUpdateHistory();
    const last = hist.length ? hist[hist.length - 1] : null;
    const currentVersion = app.getVersion();
    if (last && last.event === 'downloaded' && last.to === currentVersion) {
      appendUpdateHistory({
        ts: Date.now(),
        event: 'installed',
        from: last.from || null,
        to: currentVersion
      });
    }
  } catch (e) {
    console.error('reconcileInstallHistory failed:', e);
  }
}

function loadProfilesFromDisk() {
  try {
    if (fs.existsSync(profilesFile())) {
      return JSON.parse(fs.readFileSync(profilesFile(), 'utf-8'));
    }
  } catch (e) {
    console.error('Failed to load profiles:', e);
  }
  return null;
}

function saveProfilesToDisk(data) {
  try {
    fs.mkdirSync(userDataPath(), { recursive: true });
    fs.writeFileSync(profilesFile(), JSON.stringify(data, null, 2));
    return true;
  } catch (e) {
    console.error('Failed to save profiles:', e);
    return false;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: '#1a1a1d',
    title: 'MultiRP',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  Menu.setApplicationMenu(null);

  // Hide on close instead of quitting when closeToTray is enabled.
  mainWindow.on('close', (e) => {
    if (app.isQuitting) return;
    const s = loadSettings();
    if (s.closeToTray) {
      e.preventDefault();
      mainWindow.hide();
      // macOS: also hide from dock so tray-only feel matches CustomRP
      if (process.platform === 'darwin' && app.dock) {
        try { app.dock.hide(); } catch (_) {}
      }
    }
  });

  const indexPath = path.join(__dirname, '..', 'renderer', 'index.html');
  console.log('[MultiRP] Loading renderer from:', indexPath);

  // Surface load failures so a blank window can be diagnosed.
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[MultiRP] did-fail-load', { code, desc, url });
    try {
      const html = `<!doctype html><html><body style="background:#1a1a1d;color:#fff;font-family:sans-serif;padding:24px;">
        <h2>MultiRP failed to load the UI</h2>
        <p><b>Code:</b> ${code}</p>
        <p><b>Reason:</b> ${desc}</p>
        <p><b>URL:</b> ${url}</p>
        <p><b>Resolved index:</b> ${indexPath}</p>
        <p>Please open an issue with this text at github.com/AlarkiusJay/MultiRPCustomizer</p>
      </body></html>`;
      mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    } catch (_) {}
  });

  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[MultiRP] render-process-gone', details);
  });

  mainWindow.webContents.on('preload-error', (_e, preloadPath, err) => {
    console.error('[MultiRP] preload-error', preloadPath, err);
  });

  // If we were launched hidden (auto-start to tray), don't show the window.
  // Default Electron behavior is to show on first paint, so suppress that.
  if (startHidden) {
    mainWindow.once('ready-to-show', () => {
      // Intentionally do not call show() — we live in the tray.
      if (process.platform === 'darwin' && app.dock) {
        try { app.dock.hide(); } catch (_) {}
      }
    });
  } else {
    mainWindow.once('ready-to-show', () => mainWindow.show());
  }

  mainWindow.loadFile(indexPath).catch((err) => {
    console.error('[MultiRP] loadFile threw:', err);
  });

  // Open DevTools when --dev OR when MULTIRP_DEBUG=1, so packaged users can self-diagnose.
  if (process.argv.includes('--dev') || process.env.MULTIRP_DEBUG === '1') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ---------- System tray ----------
function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (process.platform === 'darwin' && app.dock) {
    try { app.dock.show(); } catch (_) {}
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function loadProfilesForTray() {
  const data = loadProfilesFromDisk();
  if (data && Array.isArray(data.profiles)) return data.profiles;
  return [];
}

function buildTrayMenu() {
  const profiles = loadProfilesForTray();
  const items = [
    {
      label: 'Show MultiRP',
      click: () => showMainWindow()
    },
    { type: 'separator' }
  ];

  if (profiles.length > 0) {
    profiles.forEach((p) => {
      const label = p && p.name ? p.name : 'Untitled Profile';
      items.push({
        label: `Activate: ${label}`,
        type: 'checkbox',
        checked: activeProfileId === p.id,
        click: () => {
          // Run async without blocking the menu callback
          (async () => {
            try {
              await connectProfile(p);
              rebuildTrayMenu();
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('rpc:activeChanged', { activeProfileId });
              }
            } catch (e) {
              console.error('Tray activate failed:', e);
            }
          })();
        }
      });
    });
  } else {
    items.push({ label: 'No profiles yet', enabled: false });
  }

  items.push(
    { type: 'separator' },
    {
      label: 'Deactivate',
      enabled: !!activeClient,
      click: () => {
        (async () => {
          await disconnectClient();
          rebuildTrayMenu();
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('rpc:activeChanged', { activeProfileId: null });
          }
        })();
      }
    },
    { type: 'separator' },
    {
      label: 'Quit MultiRP',
      click: () => {
        app.isQuitting = true;
        app.quit();
      }
    }
  );

  return Menu.buildFromTemplate(items);
}

function rebuildTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  try {
    tray.setContextMenu(buildTrayMenu());
  } catch (e) {
    console.error('rebuildTrayMenu failed:', e);
  }
}

function setupTray() {
  if (tray) return;
  try {
    const iconPath = path.join(__dirname, 'tray-icon.png');
    let image = nativeImage.createFromPath(iconPath);
    if (image.isEmpty()) {
      // Fallback to brand logo if tray icon missing for any reason
      image = nativeImage.createFromPath(path.join(__dirname, '..', 'renderer', 'logo.png'));
    }
    // macOS prefers small template-style icons
    if (process.platform === 'darwin' && !image.isEmpty()) {
      image = image.resize({ width: 18, height: 18 });
    }
    tray = new Tray(image);
    tray.setToolTip('MultiRP — Discord Rich Presence');
    tray.setContextMenu(buildTrayMenu());

    // Left-click on Windows/Linux toggles the window; macOS uses the menu.
    tray.on('click', () => {
      if (process.platform === 'darwin') return;
      if (mainWindow && mainWindow.isVisible() && !mainWindow.isMinimized()) {
        mainWindow.hide();
      } else {
        showMainWindow();
      }
    });
    tray.on('double-click', () => showMainWindow());
  } catch (e) {
    console.error('Failed to set up tray:', e);
  }
}

// ---------- Login item (auto-start) ----------
function applyLoginItemSettings(settings) {
  // Skip in dev — Electron binary path makes no sense as a login item there.
  if (!app.isPackaged) return;
  try {
    app.setLoginItemSettings({
      openAtLogin: !!settings.autoStart,
      openAsHidden: !!settings.startMinimized, // macOS uses this hint
      args: settings.startMinimized ? ['--hidden'] : []
    });
  } catch (e) {
    console.error('setLoginItemSettings failed:', e);
  }
}

// Build the activity payload from a profile object
function buildActivity(profile) {
  const activity = {};
  if (profile.details) activity.details = profile.details.slice(0, 128);
  if (profile.state) activity.state = profile.state.slice(0, 128);

  // Timestamps
  if (profile.timestampMode === 'elapsed') {
    activity.startTimestamp = Math.floor(Date.now() / 1000);
  } else if (profile.timestampMode === 'custom_start' && profile.startTimestamp) {
    activity.startTimestamp = parseInt(profile.startTimestamp, 10);
  }
  if (profile.timestampMode === 'custom_range' && profile.endTimestamp) {
    activity.endTimestamp = parseInt(profile.endTimestamp, 10);
    if (profile.startTimestamp) activity.startTimestamp = parseInt(profile.startTimestamp, 10);
  }

  // Images
  if (profile.largeImageKey) activity.largeImageKey = profile.largeImageKey.trim();
  if (profile.largeImageText) activity.largeImageText = profile.largeImageText.slice(0, 128);
  if (profile.smallImageKey) activity.smallImageKey = profile.smallImageKey.trim();
  if (profile.smallImageText) activity.smallImageText = profile.smallImageText.slice(0, 128);

  // Party size
  if (profile.partyCurrent && profile.partyMax) {
    activity.partySize = parseInt(profile.partyCurrent, 10);
    activity.partyMax = parseInt(profile.partyMax, 10);
  }

  // Buttons (Discord allows max 2). These appear as clickable links for OTHER users.
  const buttons = [];
  if (profile.button1Label && profile.button1Url) {
    buttons.push({ label: profile.button1Label.slice(0, 32), url: profile.button1Url.trim() });
  }
  if (profile.button2Label && profile.button2Url) {
    buttons.push({ label: profile.button2Label.slice(0, 32), url: profile.button2Url.trim() });
  }
  if (buttons.length > 0) activity.buttons = buttons;

  // Activity type — 0=Playing, 2=Listening, 3=Watching, 5=Competing
  if (typeof profile.activityType === 'number') activity.type = profile.activityType;

  // Instance flag
  activity.instance = false;

  return activity;
}

async function disconnectClient() {
  if (activeClient) {
    try {
      await activeClient.clearActivity().catch(() => {});
      await activeClient.destroy().catch(() => {});
    } catch (e) {
      console.warn('Disconnect error:', e);
    }
    activeClient = null;
    activeProfileId = null;
    activeActivity = null;
  }
}

// Shared connect implementation — used by both the renderer IPC and the tray menu.
async function connectProfile(profile) {
  await disconnectClient();

  if (!profile || !profile.clientId) {
    return { ok: false, error: 'Missing Client ID' };
  }
  if (!/^\d{17,21}$/.test(String(profile.clientId).trim())) {
    return { ok: false, error: 'Client ID must be 17–21 digits (snowflake)' };
  }

  try {
    const client = new RPC.Client({ transport: 'ipc' });
    const activity = buildActivity(profile);

    await client.login({ clientId: String(profile.clientId).trim() });
    await client.setActivity(activity);

    activeClient = client;
    activeProfileId = profile.id;
    activeActivity = activity;

    client.on('disconnected', () => {
      activeClient = null;
      activeProfileId = null;
      activeActivity = null;
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('rpc:disconnected');
      rebuildTrayMenu();
    });

    return { ok: true, activeProfileId: profile.id };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

ipcMain.handle('rpc:connect', async (_evt, profile) => {
  const r = await connectProfile(profile);
  rebuildTrayMenu();
  return r;
});

ipcMain.handle('rpc:disconnect', async () => {
  await disconnectClient();
  rebuildTrayMenu();
  return { ok: true };
});

ipcMain.handle('rpc:status', async () => {
  return { activeProfileId };
});

ipcMain.handle('rpc:update', async (_evt, profile) => {
  // Re-send activity for the currently connected profile (when user edits while live)
  if (!activeClient || activeProfileId !== profile.id) {
    return { ok: false, error: 'Profile is not currently active' };
  }
  try {
    const activity = buildActivity(profile);
    await activeClient.setActivity(activity);
    activeActivity = activity;
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

// Persistence
ipcMain.handle('store:load', async () => {
  return loadProfilesFromDisk();
});

ipcMain.handle('store:save', async (_evt, data) => {
  const ok = saveProfilesToDisk(data);
  // Profiles changed — refresh tray menu so per-profile entries stay current.
  rebuildTrayMenu();
  return ok;
});

// ---------- Settings IPC (startup + tray) ----------
ipcMain.handle('settings:get', async () => {
  return loadSettings();
});

ipcMain.handle('settings:setAutoStart', async (_evt, enabled) => {
  const s = loadSettings();
  s.autoStart = !!enabled;
  saveSettings(s);
  applyLoginItemSettings(s);
  return { ok: true, settings: s };
});

ipcMain.handle('settings:setStartMinimized', async (_evt, enabled) => {
  const s = loadSettings();
  s.startMinimized = !!enabled;
  saveSettings(s);
  applyLoginItemSettings(s);
  return { ok: true, settings: s };
});

ipcMain.handle('settings:setCloseToTray', async (_evt, enabled) => {
  const s = loadSettings();
  s.closeToTray = !!enabled;
  saveSettings(s);
  return { ok: true, settings: s };
});

ipcMain.handle('window:show', async () => {
  showMainWindow();
  return { ok: true };
});

// ---------- Updates IPC ----------
ipcMain.handle('updates:status', async () => {
  return {
    ...updateState,
    settings: loadSettings()
  };
});

ipcMain.handle('updates:check', async () => {
  try {
    const r = await autoUpdater.checkForUpdates();
    return { ok: true, info: r ? r.updateInfo : null };
  } catch (err) {
    updateState.status = 'error';
    updateState.error = err && err.message ? err.message : String(err);
    emitUpdateState();
    return { ok: false, error: updateState.error };
  }
});

ipcMain.handle('updates:download', async () => {
  try {
    await autoUpdater.downloadUpdate();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
});

ipcMain.handle('updates:install', async () => {
  // Quit and install. Prevents our before-quit handler from blocking via the silent flag.
  try {
    await disconnectClient();
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
});

ipcMain.handle('updates:setAutoInstall', async (_evt, enabled) => {
  const s = loadSettings();
  s.autoInstall = !!enabled;
  saveSettings(s);
  return { ok: true, settings: s };
});

ipcMain.handle('updates:getHistory', async () => {
  return loadUpdateHistory();
});

ipcMain.handle('app:getVersion', async () => {
  return app.getVersion();
});

// ---------------- Discord App Asset resolver ----------------
// Resolves an image "key" (asset name) for a given Discord Application Client ID
// to a real CDN URL so the live preview can render the actual image.
//
// Three cases:
//  1. Empty / missing  -> null
//  2. Already an http(s) URL  -> return as-is (Discord RPC also accepts external URLs)
//  3. Plain key  -> look up the application's published Art Assets via the
//     public oauth2 endpoint and return a CDN URL for the matching asset.
//
// Results are cached per-clientId for 5 minutes so we don't spam Discord.
const assetCache = new Map(); // clientId -> { fetchedAt, assets: [{id,name,type}] }
const ASSET_TTL_MS = 5 * 60 * 1000;

async function fetchAppAssets(clientId) {
  if (!/^\d{15,25}$/.test(String(clientId || ''))) {
    throw new Error('Invalid Client ID');
  }
  const cached = assetCache.get(clientId);
  if (cached && (Date.now() - cached.fetchedAt) < ASSET_TTL_MS) {
    return cached.assets;
  }
  // Public endpoint — no auth required for published Rich Presence assets.
  const url = `https://discord.com/api/v10/oauth2/applications/${clientId}/assets`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': `MultiRP/${app.getVersion()} (+https://github.com/AlarkiusJay/MultiRPCustomizer)`,
      'Accept': 'application/json'
    }
  });
  if (!res.ok) {
    throw new Error(`Discord API ${res.status}`);
  }
  const assets = await res.json();
  assetCache.set(clientId, { fetchedAt: Date.now(), assets });
  return assets;
}

ipcMain.handle('assets:resolve', async (_evt, { clientId, key }) => {
  try {
    if (!key) return { ok: true, url: null };
    const trimmed = String(key).trim();

    // Direct URL keys: Discord allows external URLs as image keys via mp:external,
    // but here we just let the renderer load them directly.
    if (/^https?:\/\//i.test(trimmed)) {
      return { ok: true, url: trimmed };
    }
    // mp:external/... -> Discord media proxy
    if (trimmed.startsWith('mp:external/')) {
      const rest = trimmed.replace(/^mp:external\//, '');
      return { ok: true, url: `https://media.discordapp.net/external/${rest}` };
    }

    if (!clientId) return { ok: false, error: 'No Client ID' };
    const assets = await fetchAppAssets(clientId);
    // Asset name match is case-insensitive in Discord's RPC.
    const lower = trimmed.toLowerCase();
    const match = assets.find(a => String(a.name || '').toLowerCase() === lower);
    if (!match) return { ok: false, error: 'Asset key not found in Developer Portal' };
    const cdn = `https://cdn.discordapp.com/app-assets/${clientId}/${match.id}.png?size=512`;
    return { ok: true, url: cdn };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('assets:list', async (_evt, { clientId }) => {
  try {
    if (!clientId) return { ok: false, error: 'No Client ID' };
    const assets = await fetchAppAssets(clientId);
    return { ok: true, assets: assets.map(a => ({ id: a.id, name: a.name, type: a.type })) };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

// Import / Export single profile — multi-format with CustomRP (.crp) interop.
// Supported on export: .json (MultiRP native), .crp (CustomRP XML), .csv, .md, .txt.
// Supported on import: same set, format auto-detected from extension and content.
ipcMain.handle('profile:export', async (_evt, profile) => {
  const safeName = (profile.name || 'profile').replace(/[^a-z0-9-_]/gi, '_');
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Profile',
    defaultPath: `${safeName}.multirp.json`,
    filters: [
      { name: 'MultiRP Profile (JSON)', extensions: ['json'] },
      { name: 'CustomRP Preset (.crp)', extensions: ['crp'] },
      { name: 'Markdown', extensions: ['md'] },
      { name: 'CSV', extensions: ['csv'] },
      { name: 'Plain Text', extensions: ['txt'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  try {
    const ext = path.extname(filePath).slice(1).toLowerCase();
    const format = profileFormats.formatFromExtension(ext);
    const content = profileFormats.exportToString(profile, format);
    fs.writeFileSync(filePath, content, 'utf-8');
    return { ok: true, filePath, format };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('profile:import', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Import Profile',
    filters: [
      { name: 'Profile Files', extensions: ['json', 'crp', 'csv', 'md', 'markdown', 'txt', 'xml'] },
      { name: 'MultiRP Profile (JSON)', extensions: ['json'] },
      { name: 'CustomRP Preset (.crp)', extensions: ['crp', 'xml'] },
      { name: 'Markdown', extensions: ['md', 'markdown'] },
      { name: 'CSV', extensions: ['csv'] },
      { name: 'Plain Text', extensions: ['txt'] },
      { name: 'All Files', extensions: ['*'] }
    ],
    properties: ['openFile']
  });
  if (canceled || !filePaths || filePaths.length === 0) return { ok: false, canceled: true };
  try {
    const filePath = filePaths[0];
    const raw = fs.readFileSync(filePath, 'utf-8');
    const { profile, format } = profileFormats.importFromContent(filePath, raw);
    return { ok: true, profile, format, filePath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

app.whenReady().then(() => {
  updateState.currentVersion = app.getVersion();
  reconcileInstallHistory();
  setupAutoUpdater();

  // Reconcile login item with persisted setting so user's preference survives reinstalls.
  applyLoginItemSettings(loadSettings());

  setupTray();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    showMainWindow();
  });

  // Silent check ~3s after launch. Skipped in dev (no published feed).
  if (app.isPackaged) {
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch((err) => {
        console.warn('Initial update check failed:', err && err.message);
      });
    }, 3000);
  }
});

app.on('window-all-closed', async () => {
  // With tray support, we stay alive until the user explicitly quits via the tray menu.
  // Only fall back to the legacy quit-on-last-window behavior if we are quitting for real.
  if (!app.isQuitting) return;
  await disconnectClient();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async (e) => {
  app.isQuitting = true;
  if (activeClient) {
    e.preventDefault();
    await disconnectClient();
    app.quit();
  }
});

app.on('will-quit', () => {
  if (tray && !tray.isDestroyed()) {
    try { tray.destroy(); } catch (_) {}
    tray = null;
  }
});
