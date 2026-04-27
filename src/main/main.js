/*
 * Copyright 2026 Alarkius Elvya Jay
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */
const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const RPC = require('discord-rpc');

let mainWindow = null;
let activeClient = null;       // current discord-rpc Client
let activeProfileId = null;    // which profile is currently active
let activeActivity = null;     // last sent activity payload (for re-send)

// Where we persist profiles
const userDataPath = () => app.getPath('userData');
const profilesFile = () => path.join(userDataPath(), 'profiles.json');

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

  mainWindow.loadFile(indexPath).catch((err) => {
    console.error('[MultiRP] loadFile threw:', err);
  });

  // Open DevTools when --dev OR when MULTIRP_DEBUG=1, so packaged users can self-diagnose.
  if (process.argv.includes('--dev') || process.env.MULTIRP_DEBUG === '1') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('closed', () => { mainWindow = null; });
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

ipcMain.handle('rpc:connect', async (_evt, profile) => {
  // Disconnect any existing connection first (one active profile at a time)
  await disconnectClient();

  if (!profile || !profile.clientId) {
    return { ok: false, error: 'Missing Client ID' };
  }
  if (!/^\d{17,21}$/.test(profile.clientId.trim())) {
    return { ok: false, error: 'Client ID must be 17–21 digits (snowflake)' };
  }

  try {
    const client = new RPC.Client({ transport: 'ipc' });
    const activity = buildActivity(profile);

    // login() resolves once the local Discord client accepts the handshake
    await client.login({ clientId: profile.clientId.trim() });
    await client.setActivity(activity);

    activeClient = client;
    activeProfileId = profile.id;
    activeActivity = activity;

    client.on('disconnected', () => {
      activeClient = null;
      activeProfileId = null;
      activeActivity = null;
      if (mainWindow) mainWindow.webContents.send('rpc:disconnected');
    });

    return { ok: true, activeProfileId: profile.id };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('rpc:disconnect', async () => {
  await disconnectClient();
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
  return saveProfilesToDisk(data);
});

// Import / Export single profile
ipcMain.handle('profile:export', async (_evt, profile) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Profile',
    defaultPath: `${(profile.name || 'profile').replace(/[^a-z0-9-_]/gi, '_')}.multirp.json`,
    filters: [{ name: 'MultiRP Profile', extensions: ['json'] }]
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(filePath, JSON.stringify(profile, null, 2));
    return { ok: true, filePath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('profile:import', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Import Profile',
    filters: [{ name: 'MultiRP Profile', extensions: ['json'] }],
    properties: ['openFile']
  });
  if (canceled || !filePaths || filePaths.length === 0) return { ok: false, canceled: true };
  try {
    const raw = fs.readFileSync(filePaths[0], 'utf-8');
    const profile = JSON.parse(raw);
    return { ok: true, profile };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', async () => {
  await disconnectClient();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async (e) => {
  if (activeClient) {
    e.preventDefault();
    await disconnectClient();
    app.quit();
  }
});
