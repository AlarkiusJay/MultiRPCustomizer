/*
 * Copyright 2026 Alarkius Elvya Jay
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */
const { app, BrowserWindow, ipcMain, dialog, Menu, Tray, nativeImage, shell, Notification, powerMonitor, globalShortcut, safeStorage } = require('electron');
const https = require('https');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const RPC = require('discord-rpc');
const { autoUpdater } = require('electron-updater');
const profileFormats = require('./profile-formats');
const secureExport = require('./secure-export');

let mainWindow = null;
let tray = null;               // system tray instance
let activeClient = null;       // current discord-rpc Client
let activeProfileId = null;    // which profile is currently active
let activeActivity = null;     // last sent activity payload (for re-send)

// True quit vs hide-to-tray. Set by tray Quit menu / explicit quit IPC.
app.isQuitting = false;

// =============================================================
// v1.9.7 — Boot benchmark + soft fade transitions
// =============================================================
// process.hrtime.bigint() is captured the moment main.js loads. We then mark
// 'app-ready', 'window-shown', and 'first-paint' phases. The total is
// pushed to the renderer once it asks for it (so it can show the
// 'Booted in 0.94s' line under the version footer).
const BOOT_T0 = process.hrtime.bigint();
const bootMarks = {};
function markBoot(label) {
  bootMarks[label] = Number(process.hrtime.bigint() - BOOT_T0) / 1e6; // ms
}
function bootSummary() {
  return {
    totalMs: bootMarks['first-paint'] || bootMarks['window-shown'] || bootMarks['app-ready'] || 0,
    phases: { ...bootMarks }
  };
}

// Soft-fade the renderer to opacity 0 over ~180ms before quitting. Resolves
// when the animation is done OR after a 250ms safety timeout so we never
// wedge the quit path.
function softFadeAndQuit() {
  if (app.isQuitting) return;
  app.isQuitting = true;
  const win = mainWindow;
  if (!win || win.isDestroyed() || !win.isVisible()) {
    app.quit();
    return;
  }
  const fadeMs = 180;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    try { app.quit(); } catch (_) {}
  };
  // Renderer-side fade triggered via IPC; main also fades the BrowserWindow
  // opacity in case the renderer is unresponsive.
  try { win.webContents.send('app:fade-out', { ms: fadeMs }); } catch (_) {}
  try {
    const steps = 12;
    for (let i = 1; i <= steps; i++) {
      setTimeout(() => {
        try { win && !win.isDestroyed() && win.setOpacity(1 - i / steps); } catch (_) {}
      }, (fadeMs * i) / steps);
    }
  } catch (_) {}
  setTimeout(finish, fadeMs + 70); // safety
}

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
    show: false,                  // v1.9.7 — prevent white flash before ready-to-show
    opacity: 0,                   // v1.9.7 — fade up to 1 once ready
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: true, // v1.9.7 — throttle hidden renderer aggressively
      spellcheck: false           // v1.9.7 — not needed in our forms; saves memory
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
      markBoot('window-shown');
      // Intentionally do not call show() — we live in the tray.
      if (process.platform === 'darwin' && app.dock) {
        try { app.dock.hide(); } catch (_) {}
      }
    });
  } else {
    mainWindow.once('ready-to-show', () => {
      markBoot('window-shown');
      mainWindow.show();
      // v1.9.7 — opacity fade-in (180ms) — pairs with v1.9.5 motion language
      const fadeMs = 180;
      const steps = 12;
      for (let i = 1; i <= steps; i++) {
        setTimeout(() => {
          try { mainWindow && !mainWindow.isDestroyed() && mainWindow.setOpacity(i / steps); } catch (_) {}
        }, (fadeMs * i) / steps);
      }
    });
  }

  mainWindow.webContents.once('did-finish-load', () => {
    markBoot('first-paint');
    const summary = bootSummary();
    console.log('[MultiRP] boot →', JSON.stringify(summary));
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
        // v1.9.7 — soft fade before exit if window is visible
        softFadeAndQuit();
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

// =============================================================
// v1.8.0 — Custom About Field (per-profile App Description override)
//
// Lets a user overwrite their Discord Application's Description field
// (Dev Portal → General Information → Description) without leaving MultiRP.
//
// Storage:
//   - The bot token is stored encrypted via Electron's safeStorage API,
//     which sits on top of the OS keychain (DPAPI on Windows, Keychain on
//     macOS, libsecret/kwallet on Linux). The encrypted blob lives in
//     userData/about-tokens.json keyed by profileId. Plaintext tokens never
//     touch disk in our own files.
//   - On systems where safeStorage isn't available (rare — Linux without
//     a working secret service), we refuse to persist tokens rather than
//     fall back to plaintext, and the renderer surfaces a clear error.
//
// Push timing:
//   - PATCH /applications/@me on explicit Save button click AND on profile
//     activation. We dedupe against `lastPushedDescription` cached on the
//     profile object so re-activating the same profile doesn't re-PATCH.
//   - Soft rate-limit guard: minimum 30s between PATCHes per profile.
// =============================================================

const ABOUT_TOKENS_FILE = () => path.join(app.getPath('userData'), 'about-tokens.json');
const ABOUT_PUSH_MIN_INTERVAL_MS = 30 * 1000;
const ABOUT_DESCRIPTION_MAX = 400; // Discord caps the description field around here.
const aboutLastPushAt = new Map(); // profileId -> ms timestamp of last successful PATCH

function readAboutTokenStore() {
  try {
    const raw = fs.readFileSync(ABOUT_TOKENS_FILE(), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function writeAboutTokenStore(store) {
  try {
    fs.writeFileSync(ABOUT_TOKENS_FILE(), JSON.stringify(store, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('Failed to persist about-tokens.json', e);
    return false;
  }
}

function aboutSetToken(profileId, token) {
  if (!profileId || typeof token !== 'string') return { ok: false, error: 'Bad arguments' };
  if (!safeStorage.isEncryptionAvailable()) {
    return { ok: false, error: 'OS secure storage is unavailable; cannot save token safely.' };
  }
  const store = readAboutTokenStore();
  if (!token.trim()) {
    delete store[profileId];
  } else {
    const enc = safeStorage.encryptString(token.trim());
    store[profileId] = { enc: enc.toString('base64'), savedAt: Date.now() };
  }
  if (!writeAboutTokenStore(store)) return { ok: false, error: 'Disk write failed.' };
  return { ok: true };
}

function aboutGetToken(profileId) {
  if (!profileId) return null;
  if (!safeStorage.isEncryptionAvailable()) return null;
  const store = readAboutTokenStore();
  const entry = store[profileId];
  if (!entry || !entry.enc) return null;
  try {
    return safeStorage.decryptString(Buffer.from(entry.enc, 'base64'));
  } catch (_) {
    return null;
  }
}

function aboutHasToken(profileId) {
  const store = readAboutTokenStore();
  return !!(store[profileId] && store[profileId].enc);
}

function aboutClearToken(profileId) {
  const store = readAboutTokenStore();
  if (!store[profileId]) return { ok: true };
  delete store[profileId];
  return { ok: writeAboutTokenStore(store) };
}

// PATCH https://discord.com/api/v10/applications/@me with the bot token.
// Returns { ok, status, body } so the renderer can show real Discord errors.
function patchApplicationDescription(token, description) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ description: String(description || '') });
    const req = https.request({
      method: 'PATCH',
      hostname: 'discord.com',
      path: '/api/v10/applications/@me',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Authorization': 'Bot ' + token,
        'User-Agent': 'MultiRP (https://github.com/AlarkiusJay/MultiRPCustomizer, ' + app.getVersion() + ')'
      }
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        resolve({ ok, status: res.statusCode, body });
      });
    });
    req.on('error', (err) => resolve({ ok: false, status: 0, body: err.message || String(err) }));
    req.write(payload);
    req.end();
  });
}

// Public push entry-point. Used both by the Save button (force=true) and by
// the activation hook (force=false, dedupe against lastPushedDescription).
async function pushAboutDescription(profile, { force = false } = {}) {
  if (!profile || !profile.id) return { ok: false, error: 'No profile.' };
  const desc = String((profile.aboutText || '')).slice(0, ABOUT_DESCRIPTION_MAX);

  // Dedupe: if the same description was already pushed and not forced, skip.
  if (!force && profile.lastPushedDescription === desc) {
    return { ok: true, skipped: 'unchanged' };
  }

  // Soft rate-limit — don't hammer Discord on rapid activations.
  const last = aboutLastPushAt.get(profile.id) || 0;
  if (!force && (Date.now() - last) < ABOUT_PUSH_MIN_INTERVAL_MS) {
    return { ok: true, skipped: 'rate-limited' };
  }

  const token = aboutGetToken(profile.id);
  if (!token) return { ok: false, error: 'No bot token saved for this profile.' };

  const result = await patchApplicationDescription(token, desc);
  if (result.ok) {
    aboutLastPushAt.set(profile.id, Date.now());
    profile.lastPushedDescription = desc;
    // Persist the dedupe marker so it survives restarts.
    persistLastPushedDescription(profile.id, desc);
    return { ok: true, status: result.status };
  }
  // Surface Discord's own error message when possible (rate-limit body etc.)
  let parsed = null;
  try { parsed = JSON.parse(result.body); } catch (_) {}
  return {
    ok: false,
    status: result.status,
    error: parsed && parsed.message ? parsed.message : ('HTTP ' + result.status + ': ' + result.body)
  };
}

// Update lastPushedDescription on the persisted profile so the dedupe survives
// app restarts. We re-read profiles.json from disk, mutate, write back.
function persistLastPushedDescription(profileId, desc) {
  try {
    const data = loadProfilesFromDisk();
    if (!data || !Array.isArray(data.profiles)) return;
    const p = data.profiles.find(x => x.id === profileId);
    if (!p) return;
    p.lastPushedDescription = desc;
    saveProfilesToDisk(data);
  } catch (e) {
    console.error('Failed to persist lastPushedDescription', e);
  }
}

// IPC — renderer side bridge
ipcMain.handle('about:setToken', async (_e, { profileId, token }) => aboutSetToken(profileId, token));
ipcMain.handle('about:clearToken', async (_e, { profileId }) => aboutClearToken(profileId));
ipcMain.handle('about:hasToken', async (_e, { profileId }) => ({ has: aboutHasToken(profileId) }));
ipcMain.handle('about:isAvailable', async () => ({ available: !!safeStorage.isEncryptionAvailable() }));
ipcMain.handle('about:push', async (_e, { profile, force }) => pushAboutDescription(profile, { force: !!force }));

// =============================================================
// v1.9.9 — Encrypted bot-token export / import
// =============================================================
//
// The user supplies a passphrase. We encrypt the bot token (already in OS
// keychain) with AES-256-GCM, derive the key via PBKDF2-SHA256 (200k iter),
// and write a .multirp-secure.json file. Importing the same file with the
// correct passphrase restores the token into the OS keychain on the new
// machine — no need to regenerate a token in the Discord developer portal.
//
// The plaintext profile fields (clientId, details, etc.) are stored in the
// envelope unencrypted so users can still inspect what they're importing.
// Only the secret material lives behind the KDF.

ipcMain.handle('secure:export', async (_e, { profile, passphrase }) => {
  if (!profile || !profile.id) return { ok: false, error: 'No profile provided.' };
  if (typeof passphrase !== 'string' || passphrase.length < 8) {
    return { ok: false, error: 'Passphrase must be at least 8 characters.' };
  }
  const token = aboutGetToken(profile.id);
  if (!token) {
    return { ok: false, error: 'No bot token saved for this profile. Save one in Custom About first.' };
  }
  const safeName = (profile.name || 'profile').replace(/[^a-z0-9-_]/gi, '_');
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Profile (Secure)',
    defaultPath: `${safeName}.multirp-secure.json`,
    filters: [
      { name: 'MultiRP Secure Profile', extensions: ['multirp-secure.json', 'json'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  try {
    // Strip the runtime-only profile id so importing creates a fresh entry
    // rather than colliding with whatever id exists on the target machine.
    const sanitized = profileFormats.sanitizeProfile(profile);
    const { id, ...clean } = sanitized;
    const content = secureExport.serializeSecure(clean, token, passphrase);
    fs.writeFileSync(filePath, content, 'utf-8');
    return { ok: true, filePath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('secure:import', async (_e, { passphrase }) => {
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    return { ok: false, error: 'Passphrase required.' };
  }
  if (!safeStorage.isEncryptionAvailable()) {
    return { ok: false, error: 'OS secure storage is unavailable; cannot save imported token safely.' };
  }
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Import Profile (Secure)',
    filters: [
      { name: 'MultiRP Secure Profile', extensions: ['multirp-secure.json', 'json'] },
      { name: 'All Files', extensions: ['*'] }
    ],
    properties: ['openFile']
  });
  if (canceled || !filePaths || filePaths.length === 0) return { ok: false, canceled: true };
  try {
    const filePath = filePaths[0];
    const raw = fs.readFileSync(filePath, 'utf-8');
    if (!secureExport.looksSecure(raw)) {
      return { ok: false, error: 'Not a MultiRP secure profile file. Use the regular Import for plain .multirp.json files.' };
    }
    const { profile, botToken } = secureExport.parseSecure(raw, passphrase);
    return { ok: true, profile, botToken: botToken || null, filePath };
  } catch (e) {
    // Wrong passphrase / tamper / parse errors all surface here.
    return { ok: false, error: e.message };
  }
});

// Save an imported token into the keychain under a freshly-created profile id.
// The renderer calls this AFTER the new profile has been added to the store
// (so we have a stable id to key on). We don't expose the plaintext token
// back to the renderer beyond this hop.
ipcMain.handle('secure:adoptToken', async (_e, { profileId, token }) => {
  if (!profileId || typeof token !== 'string') return { ok: false, error: 'Bad arguments' };
  return aboutSetToken(profileId, token);
});

// v1.9.7 — boot benchmark IPC
ipcMain.handle('boot:summary', async () => bootSummary());
// Soft-fade quit triggered from renderer (e.g. about modal, hotkey)
ipcMain.handle('app:soft-quit', async () => { softFadeAndQuit(); });

ipcMain.handle('rpc:connect', async (_evt, profile) => {
  // If auto-presence is running and the user wants manual to pause it, flip the
  // pause flag before activating. The renderer will see the new status and
  // surface a 'Resume Auto' affordance.
  if (autoConfig.enabled && !autoConfig.paused && autoConfig.pauseOnManual) {
    autoConfig.paused = true;
    saveAutoConfig();
    stopAutoEngine();
  }
  const r = await connectProfile(profile);
  rebuildTrayMenu();
  // v1.8.0 — best-effort push of the Custom About description on activation.
  // Fires only if a token is configured for this profile; deduped against
  // lastPushedDescription so it's a no-op when nothing changed. We never block
  // the activation itself if the PATCH fails or rate-limits.
  if (r && r.ok) {
    try {
      const result = await pushAboutDescription(profile, { force: false });
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('about:pushed', { profileId: profile.id, result });
      }
    } catch (_) {}
  }
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

// ---------------- "View as others" popout window ----------------
// A separate, frameless BrowserWindow that renders the same Discord-style
// presence card. Useful because Discord hides your own buttons from your own
// profile card, so this gives you a way to actually *see* what others see.
let popoutWindow = null;

function createPopoutWindow() {
  if (popoutWindow && !popoutWindow.isDestroyed()) {
    popoutWindow.focus();
    return popoutWindow;
  }
  popoutWindow = new BrowserWindow({
    width: 380,
    height: 580,
    minWidth: 320,
    minHeight: 480,
    title: 'MultiRP — View as others',
    frame: false,
    transparent: false,
    backgroundColor: '#16171c',
    resizable: true,
    fullscreenable: false,
    skipTaskbar: false,
    parent: mainWindow || undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  Menu.setApplicationMenu(null);
  popoutWindow.setMenuBarVisibility(false);
  const popoutPath = path.join(__dirname, '..', 'renderer', 'popout.html');
  popoutWindow.loadFile(popoutPath).catch((err) => {
    console.error('[MultiRP] Failed to load popout:', err);
  });
  popoutWindow.on('closed', () => { popoutWindow = null; });
  return popoutWindow;
}

ipcMain.handle('popout:open', async () => {
  createPopoutWindow();
  return { ok: true };
});

ipcMain.handle('popout:close', async () => {
  if (popoutWindow && !popoutWindow.isDestroyed()) {
    popoutWindow.close();
  }
  return { ok: true };
});

// Snapshot relay: main window pushes a snapshot, we forward to the popout.
ipcMain.on('popout:sync', (_evt, snapshot) => {
  if (popoutWindow && !popoutWindow.isDestroyed()) {
    popoutWindow.webContents.send('popout:snapshot', snapshot);
  }
});

// Popout signals it's ready and wants the latest snapshot pushed to it.
ipcMain.on('popout:ready', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('popout:requestSnapshot');
  }
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

// =============================================================
// Auto Presence — scheduler engine (v1.6.0)
// =============================================================
//
// Source of truth for the auto-presence config and timer. Persists to
// settings.json under `autoPresence`, evaluates current state on each tick,
// activates the appropriate profile via the existing connectProfile() flow,
// and broadcasts status updates back to the renderer + popout.

const autoConfigFile = () => path.join(userDataPath(), 'auto-presence.json');

const DEFAULT_AUTO_CONFIG = {
  enabled: false,
  paused: false,
  mode: 'rotation',
  intervalValue: 30,
  intervalUnit: 'minutes',
  selectedProfileIds: [],
  rotationOrder: [],
  scheduleRules: [],
  notifyOnSwitch: false,
  pauseOnManual: true,
  lastActivatedProfileId: null,
  nextSwitchAt: null
};

let autoConfig = { ...DEFAULT_AUTO_CONFIG };
let autoTimer = null;
let autoRotationIdx = 0;

function loadAutoConfig() {
  try {
    if (fs.existsSync(autoConfigFile())) {
      const raw = JSON.parse(fs.readFileSync(autoConfigFile(), 'utf-8'));
      autoConfig = { ...DEFAULT_AUTO_CONFIG, ...raw };
    }
  } catch (e) {
    console.error('Failed to load auto-presence config:', e);
    autoConfig = { ...DEFAULT_AUTO_CONFIG };
  }
  return autoConfig;
}

function saveAutoConfig() {
  try {
    fs.mkdirSync(userDataPath(), { recursive: true });
    fs.writeFileSync(autoConfigFile(), JSON.stringify(autoConfig, null, 2));
    return true;
  } catch (e) {
    console.error('Failed to save auto-presence config:', e);
    return false;
  }
}

function autoUnitToMs(value, unit) {
  const n = Math.max(1, Math.floor(Number(value) || 1));
  switch (unit) {
    case 'seconds': return n * 1000;
    case 'minutes': return n * 60_000;
    case 'hours':   return n * 3_600_000;
    case 'days':    return n * 86_400_000;
    default:        return n * 60_000;
  }
}

function broadcastAutoStatus() {
  const payload = {
    enabled: autoConfig.enabled,
    paused: autoConfig.paused,
    nextSwitchAt: autoConfig.nextSwitchAt,
    lastActivatedProfileId: autoConfig.lastActivatedProfileId
  };
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('auto:status', payload);
    }
  } catch (_) {}
}

// Decide which profile should be active right now.
// Returns a profile object from disk, or null if nothing should change.
function evaluateAutoPresence(profiles) {
  if (!autoConfig.enabled || autoConfig.paused) return null;
  if (!Array.isArray(profiles) || profiles.length === 0) return null;

  const byId = new Map(profiles.map(p => [p.id, p]));

  if (autoConfig.mode === 'schedule') {
    const now = new Date();
    const dow = now.getDay();
    const minOfDay = now.getHours() * 60 + now.getMinutes();
    for (const rule of (autoConfig.scheduleRules || [])) {
      if (!rule || !Array.isArray(rule.days)) continue;
      if (!rule.days.includes(dow)) continue;
      const start = Math.max(0, Math.min(1439, Number(rule.startMin) || 0));
      const end = Math.max(0, Math.min(1440, Number(rule.endMin) || 0));
      // Handle overnight rules where end <= start (e.g. 22:00 → 06:00)
      const matches = (end > start)
        ? (minOfDay >= start && minOfDay < end)
        : (minOfDay >= start || minOfDay < end);
      if (matches && byId.has(rule.profileId)) {
        return byId.get(rule.profileId);
      }
    }
    return null;
  }

  // Rotation / shuffle: filter selected profiles to ones that still exist.
  const selectedAvailable = (autoConfig.selectedProfileIds || []).filter(id => byId.has(id));
  if (selectedAvailable.length === 0) return null;

  if (autoConfig.mode === 'shuffle') {
    // Avoid repeating the same profile back-to-back when possible.
    let pool = selectedAvailable;
    if (selectedAvailable.length > 1 && autoConfig.lastActivatedProfileId) {
      pool = selectedAvailable.filter(id => id !== autoConfig.lastActivatedProfileId);
      if (pool.length === 0) pool = selectedAvailable;
    }
    const pick = pool[Math.floor(Math.random() * pool.length)];
    return byId.get(pick) || null;
  }

  // Rotation: walk rotationOrder, then any leftover selected ids.
  const order = (autoConfig.rotationOrder || []).filter(id => selectedAvailable.includes(id));
  for (const id of selectedAvailable) {
    if (!order.includes(id)) order.push(id);
  }
  if (order.length === 0) return null;
  // Find current index based on lastActivatedProfileId to advance
  if (autoConfig.lastActivatedProfileId) {
    const lastIdx = order.indexOf(autoConfig.lastActivatedProfileId);
    autoRotationIdx = (lastIdx >= 0) ? (lastIdx + 1) % order.length : 0;
  } else {
    autoRotationIdx = autoRotationIdx % order.length;
  }
  return byId.get(order[autoRotationIdx]) || null;
}

function notifyAutoSwitch(profile) {
  if (!autoConfig.notifyOnSwitch) return;
  if (!Notification || !Notification.isSupported || !Notification.isSupported()) return;
  try {
    const n = new Notification({
      title: 'MultiRP — Auto Presence',
      body: `Switched to: ${profile.name || profile.id || 'profile'}`,
      silent: true
    });
    n.show();
  } catch (_) { /* notifications optional */ }
}

async function tickAutoPresence() {
  if (!autoConfig.enabled || autoConfig.paused) {
    autoConfig.nextSwitchAt = null;
    broadcastAutoStatus();
    return;
  }

  const data = loadProfilesFromDisk();
  const profiles = (data && Array.isArray(data.profiles)) ? data.profiles : [];

  const target = evaluateAutoPresence(profiles);

  if (target && target.id !== activeProfileId) {
    const result = await connectProfile(target);
    if (result && result.ok) {
      autoConfig.lastActivatedProfileId = target.id;
      try { rebuildTrayMenu(); } catch (_) {}
      try {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('rpc:activeChanged', { activeProfileId: target.id, source: 'auto' });
        }
      } catch (_) {}
      notifyAutoSwitch(target);
    } else {
      console.warn('Auto-presence connect failed:', result && result.error);
    }
  } else if (target && target.id === activeProfileId) {
    // Already active — keep lastActivatedProfileId in sync.
    autoConfig.lastActivatedProfileId = target.id;
  }

  // Schedule next tick.
  let nextDelay;
  if (autoConfig.mode === 'schedule') {
    // Re-evaluate every 30 seconds so day/time boundaries trigger promptly.
    nextDelay = 30_000;
  } else {
    nextDelay = autoUnitToMs(autoConfig.intervalValue, autoConfig.intervalUnit);
  }
  autoConfig.nextSwitchAt = Date.now() + nextDelay;
  saveAutoConfig();
  broadcastAutoStatus();

  if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
  autoTimer = setTimeout(tickAutoPresence, nextDelay);
}

function startAutoEngine(opts = {}) {
  if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
  if (!autoConfig.enabled || autoConfig.paused) {
    autoConfig.nextSwitchAt = null;
    saveAutoConfig();
    broadcastAutoStatus();
    return;
  }
  // Run an immediate tick when first enabled / config saved so the user sees
  // the right profile go active right away. On startup we wait one delay so
  // we don't yank a freshly-launched session.
  if (opts.runImmediately !== false) {
    setImmediate(tickAutoPresence);
  } else {
    const delay = (autoConfig.mode === 'schedule')
      ? 30_000
      : autoUnitToMs(autoConfig.intervalValue, autoConfig.intervalUnit);
    autoConfig.nextSwitchAt = Date.now() + delay;
    saveAutoConfig();
    broadcastAutoStatus();
    autoTimer = setTimeout(tickAutoPresence, delay);
  }
}

function stopAutoEngine() {
  if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
  autoConfig.nextSwitchAt = null;
  broadcastAutoStatus();
}

// IPC: renderer <-> auto engine
ipcMain.handle('auto:get', async () => {
  return autoConfig;
});

ipcMain.handle('auto:set', async (_evt, partial) => {
  if (!partial || typeof partial !== 'object') return autoConfig;
  const wasEnabled = autoConfig.enabled && !autoConfig.paused;
  autoConfig = { ...autoConfig, ...partial };
  // Sanity-clamp
  autoConfig.intervalValue = Math.max(1, Math.floor(Number(autoConfig.intervalValue) || 1));
  if (!['seconds','minutes','hours','days'].includes(autoConfig.intervalUnit)) autoConfig.intervalUnit = 'minutes';
  if (!['rotation','shuffle','schedule'].includes(autoConfig.mode)) autoConfig.mode = 'rotation';
  saveAutoConfig();

  const nowEnabled = autoConfig.enabled && !autoConfig.paused;
  if (nowEnabled) {
    startAutoEngine({ runImmediately: !wasEnabled });
  } else {
    stopAutoEngine();
  }
  return autoConfig;
});

// =============================================================
// v1.7.0: Settings v2 — hotkeys, idle, game detection, always-on-top
// =============================================================
//
// Stored in a separate file so legacy settings.json stays clean and small.
// Anything that's purely renderer-side display (theme, tab order) lives in
// profiles.json. Anything that affects OS-level behavior lives here.

const extSettingsFile = () => path.join(userDataPath(), 'settings-v2.json');

const DEFAULT_HOTKEYS = {
  cycleNext:    '',
  jumpProfile1: '',
  jumpProfile2: '',
  jumpProfile3: '',
  jumpProfile4: '',
  jumpProfile5: '',
  toggleAuto:   '',
  showWindow:   '',
  toggleOnTop:  ''
};

const DEFAULT_EXT_SETTINGS = {
  hotkeys: { ...DEFAULT_HOTKEYS },
  idle: {
    enabled: false,
    onLock: true,
    onSystemIdle: false,
    afterMinutes: 10,
    idleProfileId: null
  },
  game: {
    alwaysOnTop: false,
    alwaysOnTopAuto: false,
    autoActivate: false,
    mappings: []  // [{id, exe, profileId, running:false}]
  }
};

let extSettings = JSON.parse(JSON.stringify(DEFAULT_EXT_SETTINGS));

function loadExtSettings() {
  try {
    if (fs.existsSync(extSettingsFile())) {
      const raw = JSON.parse(fs.readFileSync(extSettingsFile(), 'utf-8'));
      // Deep merge with defaults so new fields land in old configs
      extSettings = {
        hotkeys: { ...DEFAULT_HOTKEYS, ...(raw.hotkeys || {}) },
        idle:    { ...DEFAULT_EXT_SETTINGS.idle, ...(raw.idle || {}) },
        game:    { ...DEFAULT_EXT_SETTINGS.game, ...(raw.game || {}) }
      };
      // Sanitize mappings
      if (!Array.isArray(extSettings.game.mappings)) extSettings.game.mappings = [];
    }
  } catch (e) {
    console.error('Failed to load v2 settings:', e);
    extSettings = JSON.parse(JSON.stringify(DEFAULT_EXT_SETTINGS));
  }
  return extSettings;
}

function saveExtSettings() {
  try {
    fs.mkdirSync(userDataPath(), { recursive: true });
    fs.writeFileSync(extSettingsFile(), JSON.stringify(extSettings, null, 2));
    return true;
  } catch (e) {
    console.error('Failed to save v2 settings:', e);
    return false;
  }
}

ipcMain.handle('extSettings:get', async () => {
  return extSettings;
});

ipcMain.handle('extSettings:set', async (_evt, partial) => {
  if (!partial || typeof partial !== 'object') return extSettings;
  if (partial.hotkeys) extSettings.hotkeys = { ...extSettings.hotkeys, ...partial.hotkeys };
  if (partial.idle)    extSettings.idle    = { ...extSettings.idle,    ...partial.idle };
  if (partial.game)    extSettings.game    = { ...extSettings.game,    ...partial.game };
  saveExtSettings();

  // Re-apply side effects
  reapplyHotkeys();
  applyAlwaysOnTop();
  return extSettings;
});

// =============================================================
// Custom Hotkeys (v1.7.0) — globalShortcut wiring
// =============================================================

const HOTKEY_ACTIONS = {
  cycleNext: () => cycleProfile(+1),
  jumpProfile1: () => jumpToProfileSlot(0),
  jumpProfile2: () => jumpToProfileSlot(1),
  jumpProfile3: () => jumpToProfileSlot(2),
  jumpProfile4: () => jumpToProfileSlot(3),
  jumpProfile5: () => jumpToProfileSlot(4),
  toggleAuto: () => toggleAutoFromHotkey(),
  showWindow: () => showMainWindow(),
  toggleOnTop: () => {
    extSettings.game.alwaysOnTop = !extSettings.game.alwaysOnTop;
    saveExtSettings();
    applyAlwaysOnTop();
    broadcastExtSettings();
  }
};

async function cycleProfile(direction) {
  const data = loadProfilesFromDisk();
  const profiles = (data && Array.isArray(data.profiles)) ? data.profiles : [];
  if (profiles.length === 0) return;
  let idx = profiles.findIndex(p => p.id === activeProfileId);
  if (idx < 0) idx = -1;
  idx = ((idx + direction) % profiles.length + profiles.length) % profiles.length;
  await connectProfile(profiles[idx]);
  rebuildTrayMenu();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('rpc:activeChanged', { activeProfileId: profiles[idx].id, source: 'hotkey' });
  }
}

async function jumpToProfileSlot(slot) {
  const data = loadProfilesFromDisk();
  const profiles = (data && Array.isArray(data.profiles)) ? data.profiles : [];
  if (slot < 0 || slot >= profiles.length) return;
  await connectProfile(profiles[slot]);
  rebuildTrayMenu();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('rpc:activeChanged', { activeProfileId: profiles[slot].id, source: 'hotkey' });
  }
}

function toggleAutoFromHotkey() {
  if (!autoConfig.enabled) {
    autoConfig.enabled = true;
    autoConfig.paused = false;
    saveAutoConfig();
    startAutoEngine({ runImmediately: true });
  } else {
    autoConfig.paused = !autoConfig.paused;
    saveAutoConfig();
    if (autoConfig.paused) stopAutoEngine();
    else startAutoEngine({ runImmediately: true });
  }
  // Notify renderer
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('auto:status', {
      enabled: autoConfig.enabled,
      paused: autoConfig.paused,
      nextSwitchAt: autoConfig.nextSwitchAt,
      lastActivatedProfileId: autoConfig.lastActivatedProfileId
    });
  }
}

function reapplyHotkeys() {
  try {
    globalShortcut.unregisterAll();
  } catch (_) {}
  const seen = new Set();
  for (const [action, accel] of Object.entries(extSettings.hotkeys || {})) {
    if (!accel || typeof accel !== 'string') continue;
    if (seen.has(accel)) continue; // skip duplicate bindings
    const fn = HOTKEY_ACTIONS[action];
    if (!fn) continue;
    try {
      globalShortcut.register(accel, fn);
      seen.add(accel);
    } catch (e) {
      console.warn(`Hotkey register failed for ${action} (${accel}):`, e.message);
    }
  }
}

function broadcastExtSettings() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('extSettings:changed', extSettings);
  }
}

// =============================================================
// Always-On-Top window flag (v1.7.0)
// =============================================================
//
// Pin the main window above everything else — "card stack" behavior over
// games. Use the highest level ("screen-saver") so it floats over fullscreen
// borderless games on most platforms.

function applyAlwaysOnTop() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const wantsOnTop = !!extSettings.game.alwaysOnTop;
  // If autoOnTop is enabled, only pin when a tracked game is running
  const shouldPin = wantsOnTop && (
    !extSettings.game.alwaysOnTopAuto ||
    (extSettings.game.mappings || []).some(m => m && m.running)
  );
  try {
    mainWindow.setAlwaysOnTop(shouldPin, 'screen-saver');
  } catch (_) {
    try { mainWindow.setAlwaysOnTop(shouldPin); } catch (__) {}
  }
}

// =============================================================
// Game Detection (v1.7.0) — cross-platform process scanner
// =============================================================

let gameScanTimer = null;

function listProcesses() {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const cmd = isWin ? 'tasklist /FO CSV /NH' : 'ps -A -o comm';
    exec(cmd, { timeout: 4000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) { resolve([]); return; }
      const lines = String(stdout || '').split(/\r?\n/);
      const names = [];
      for (const line of lines) {
        if (!line) continue;
        if (isWin) {
          // "name.exe","PID",...
          const m = line.match(/^"([^"]+)"/);
          if (m) names.push(m[1]);
        } else {
          const trimmed = line.trim();
          if (!trimmed || trimmed === 'COMMAND') continue;
          // ps -A -o comm prints full path on macOS — take basename
          names.push(trimmed.split('/').pop());
        }
      }
      resolve(names);
    });
  });
}

async function scanGames() {
  const mappings = extSettings.game.mappings || [];
  if (mappings.length === 0) return;

  const procs = (await listProcesses()).map(s => s.toLowerCase());
  const procSet = new Set(procs);

  let stateChanged = false;
  let firstNewlyRunning = null;

  for (const m of mappings) {
    if (!m || !m.exe) continue;
    const wasRunning = !!m.running;
    const exe = String(m.exe).toLowerCase();
    const nowRunning = procSet.has(exe);
    if (wasRunning !== nowRunning) {
      m.running = nowRunning;
      stateChanged = true;
      if (nowRunning && !firstNewlyRunning) firstNewlyRunning = m;
    }
  }

  if (stateChanged) {
    saveExtSettings();
    broadcastExtSettings();
    applyAlwaysOnTop();

    // Auto-activate the matching profile if user opted in
    if (firstNewlyRunning && extSettings.game.autoActivate && firstNewlyRunning.profileId) {
      const data = loadProfilesFromDisk();
      const profiles = (data && Array.isArray(data.profiles)) ? data.profiles : [];
      const target = profiles.find(p => p.id === firstNewlyRunning.profileId);
      if (target) {
        await connectProfile(target);
        rebuildTrayMenu();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('rpc:activeChanged', { activeProfileId: target.id, source: 'game' });
        }
      }
    }
  }
}

// v1.9.7 — adaptive game scanner.
// Default 5s tick. After 60s without any process state change, fall back
// to 15s. After 3 min still quiet, fall back to 30s. Any state change
// resets to fast 5s. This saves real CPU during long writing sessions when
// no tracked game is running.
let gameScanLastChange = Date.now();
function currentGameScanInterval() {
  const quietMs = Date.now() - gameScanLastChange;
  if (quietMs > 3 * 60 * 1000) return 30000;
  if (quietMs > 60 * 1000) return 15000;
  return 5000;
}
async function scanGamesAdaptive() {
  const before = JSON.stringify((extSettings.game && extSettings.game.mappings || []).map(m => !!m.running));
  await scanGames().catch(() => {});
  const after = JSON.stringify((extSettings.game && extSettings.game.mappings || []).map(m => !!m.running));
  if (before !== after) gameScanLastChange = Date.now();
}
function startGameScanner() {
  if (gameScanTimer) return;
  const tick = async () => {
    if (!gameScanTimer) return;
    await scanGamesAdaptive();
    if (!gameScanTimer) return;
    gameScanTimer = setTimeout(tick, currentGameScanInterval());
  };
  gameScanTimer = setTimeout(tick, 0);
  // Run once immediately
  scanGamesAdaptive();
}

function stopGameScanner() {
  if (gameScanTimer) { clearTimeout(gameScanTimer); gameScanTimer = null; }
}

// =============================================================
// Idle Detection (v1.7.0)
// =============================================================
//
// Tracks whether the user is currently considered idle and what profile was
// active before going idle, so we can restore it on resume.

let idleState = {
  isIdle: false,
  prevProfileId: null,
  systemIdleTimer: null
};

async function enterIdleState(reason) {
  if (idleState.isIdle) return;
  if (!extSettings.idle.enabled) return;
  if (!extSettings.idle.idleProfileId) return;

  idleState.isIdle = true;
  idleState.prevProfileId = activeProfileId;

  const data = loadProfilesFromDisk();
  const profiles = (data && Array.isArray(data.profiles)) ? data.profiles : [];
  const idleProfile = profiles.find(p => p.id === extSettings.idle.idleProfileId);
  if (!idleProfile) return;

  await connectProfile(idleProfile);
  rebuildTrayMenu();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('rpc:activeChanged', { activeProfileId: idleProfile.id, source: 'idle:' + reason });
  }
}

async function exitIdleState() {
  if (!idleState.isIdle) return;
  idleState.isIdle = false;
  const restoreId = idleState.prevProfileId;
  idleState.prevProfileId = null;
  if (!restoreId) return;

  const data = loadProfilesFromDisk();
  const profiles = (data && Array.isArray(data.profiles)) ? data.profiles : [];
  const target = profiles.find(p => p.id === restoreId);
  if (!target) return;

  await connectProfile(target);
  rebuildTrayMenu();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('rpc:activeChanged', { activeProfileId: target.id, source: 'idle:resume' });
  }
}

function setupIdleDetection() {
  // Only set up powerMonitor handlers once — they're cheap & idempotent
  try {
    powerMonitor.on('lock-screen', () => {
      if (extSettings.idle.enabled && extSettings.idle.onLock) enterIdleState('lock').catch(() => {});
    });
    powerMonitor.on('unlock-screen', () => {
      if (extSettings.idle.enabled && extSettings.idle.onLock) exitIdleState().catch(() => {});
    });
    powerMonitor.on('suspend', () => {
      if (extSettings.idle.enabled && extSettings.idle.onLock) enterIdleState('suspend').catch(() => {});
    });
    powerMonitor.on('resume', () => {
      if (extSettings.idle.enabled && extSettings.idle.onLock) exitIdleState().catch(() => {});
    });
  } catch (e) {
    console.warn('powerMonitor unavailable:', e.message);
  }

  // v1.9.7 — Only poll when system-idle detection is enabled. The lock-screen
  // / suspend / resume events above are always wired (they're free) but the
  // 30s polling timer is the one with measurable cost, so we gate it.
  if (idleState.systemIdleTimer) clearInterval(idleState.systemIdleTimer);
  if (extSettings.idle.enabled && extSettings.idle.onSystemIdle) {
    idleState.systemIdleTimer = setInterval(() => {
      try {
        const idleSec = powerMonitor.getSystemIdleTime();
        const threshold = Math.max(1, Number(extSettings.idle.afterMinutes) || 10) * 60;
        if (idleSec >= threshold && !idleState.isIdle) {
          enterIdleState('system-idle').catch(() => {});
        } else if (idleSec < 5 && idleState.isIdle) {
          // Snap back the moment activity returns
          exitIdleState().catch(() => {});
        }
      } catch (_) { /* getSystemIdleTime not available on some envs */ }
    }, 30_000);
  }
}

app.whenReady().then(() => {
  markBoot('app-ready');
  updateState.currentVersion = app.getVersion();
  reconcileInstallHistory();

  // ---- HOT PATH ----
  // The bare minimum we need before the window paints: settings, auto-config,
  // tray, and the window itself. Everything else is deferred.
  applyLoginItemSettings(loadSettings());
  loadAutoConfig();
  setupTray();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    showMainWindow();
  });

  // ---- DEFERRED PATH ----
  // Spin up subsystems after the first paint so they don't fight the renderer
  // for CPU during startup. setImmediate() yields to the IO loop; the chained
  // setTimeout cascades each subsystem onto its own tick to avoid one big
  // synchronous spike.
  setImmediate(() => {
    setupAutoUpdater();
    if (autoConfig.enabled && !autoConfig.paused) {
      startAutoEngine({ runImmediately: false });
    }
    setTimeout(() => loadExtSettings(), 0);
    setTimeout(() => reapplyHotkeys(), 30);
    setTimeout(() => setupIdleDetection(), 60);
    setTimeout(() => startGameScanner(), 100);
    setTimeout(() => applyAlwaysOnTop(), 130);
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
  // Release every globalShortcut so the OS doesn't keep them bound after quit.
  try { globalShortcut.unregisterAll(); } catch (_) {}
  // Stop the game-scanner interval if it's still ticking.
  try { stopGameScanner(); } catch (_) {}
});
