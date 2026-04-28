/*
 * Copyright 2026 Alarkius Elvya Jay
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */
// MultiRP renderer — profile state, UI, live preview
const MAX_PROFILES = 5;
const FIELD_KEYS = [
  'name', 'clientId', 'activityType', 'timestampMode',
  'startTimestamp', 'endTimestamp',
  'details', 'state',
  'largeImageKey', 'largeImageText',
  'smallImageKey', 'smallImageText',
  'partyCurrent', 'partyMax',
  'button1Label', 'button1Url',
  'button2Label', 'button2Url'
];

function newProfile(idx) {
  return {
    id: 'p_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    name: 'Profile ' + idx,
    clientId: '',
    activityType: 0,
    timestampMode: 'none',
    startTimestamp: '',
    endTimestamp: '',
    details: '',
    state: '',
    largeImageKey: '',
    largeImageText: '',
    smallImageKey: '',
    smallImageText: '',
    partyCurrent: '',
    partyMax: '',
    button1Label: '',
    button1Url: '',
    button2Label: '',
    button2Url: ''
  };
}

let state = {
  profiles: [newProfile(1)],
  activeTab: 0,
  liveProfileId: null,
  view: 'profile',          // 'profile' | 'updates'
  updateState: null,        // last update state from main
  autoInstall: true,        // mirror of persisted setting
  autoStart: false,         // launch at login
  startMinimized: true,     // start hidden in tray
  closeToTray: true,        // close hides instead of quits
  hasSeenLatestUpdate: true // false when an update arrives & we need a dot
};

// ---------- Persistence ----------
async function loadStore() {
  const data = await window.multirp.loadStore();
  if (data && Array.isArray(data.profiles) && data.profiles.length > 0) {
    state.profiles = data.profiles.slice(0, MAX_PROFILES);
    state.activeTab = Math.min(data.activeTab || 0, state.profiles.length - 1);
  }
}

async function saveStore() {
  await window.multirp.saveStore({
    profiles: state.profiles,
    activeTab: state.activeTab
  });
}

// ---------- Render: Tabs ----------
function renderTabs() {
  const tabsEl = document.getElementById('tabs');
  tabsEl.innerHTML = '';

  state.profiles.forEach((p, i) => {
    const tab = document.createElement('div');
    tab.className = 'tab' + (i === state.activeTab ? ' active' : '');
    tab.title = p.name;

    if (state.liveProfileId === p.id) {
      const dot = document.createElement('span');
      dot.className = 'live-dot';
      tab.appendChild(dot);
    }

    const label = document.createElement('span');
    label.textContent = p.name || `Profile ${i + 1}`;
    tab.appendChild(label);

    if (state.profiles.length > 1) {
      const close = document.createElement('span');
      close.className = 'tab-close';
      close.textContent = '×';
      close.title = 'Delete profile';
      close.onclick = (e) => {
        e.stopPropagation();
        deleteProfile(i);
      };
      tab.appendChild(close);
    }

    tab.onclick = () => switchTab(i);
    tabsEl.appendChild(tab);
  });

  if (state.profiles.length < MAX_PROFILES) {
    const add = document.createElement('button');
    add.className = 'tab-add';
    add.textContent = '+ Add profile';
    add.title = `Add a new profile (max ${MAX_PROFILES})`;
    add.onclick = addProfile;
    tabsEl.appendChild(add);
  }
}

function switchTab(i) {
  if (state.view === 'updates') switchView('profile');
  state.activeTab = i;
  renderForm();
  renderTabs();
  saveStore();
}

function addProfile() {
  if (state.profiles.length >= MAX_PROFILES) return;
  if (state.view === 'updates') switchView('profile');
  state.profiles.push(newProfile(state.profiles.length + 1));
  state.activeTab = state.profiles.length - 1;
  renderTabs();
  renderForm();
  saveStore();
}

async function deleteProfile(i) {
  const p = state.profiles[i];
  if (state.liveProfileId === p.id) {
    await window.multirp.disconnect();
    state.liveProfileId = null;
  }
  state.profiles.splice(i, 1);
  if (state.profiles.length === 0) state.profiles.push(newProfile(1));
  if (state.activeTab >= state.profiles.length) state.activeTab = state.profiles.length - 1;
  renderTabs();
  renderForm();
  saveStore();
}

// ---------- Render: Form ----------
function currentProfile() {
  return state.profiles[state.activeTab];
}

function renderForm() {
  const p = currentProfile();
  document.getElementById('profileName').value = p.name || '';
  document.getElementById('clientId').value = p.clientId || '';
  document.getElementById('activityType').value = String(p.activityType ?? 0);
  document.getElementById('timestampMode').value = p.timestampMode || 'none';
  document.getElementById('startTimestamp').value = p.startTimestamp || '';
  document.getElementById('endTimestamp').value = p.endTimestamp || '';
  document.getElementById('details').value = p.details || '';
  document.getElementById('state').value = p.state || '';
  document.getElementById('largeImageKey').value = p.largeImageKey || '';
  document.getElementById('largeImageText').value = p.largeImageText || '';
  document.getElementById('smallImageKey').value = p.smallImageKey || '';
  document.getElementById('smallImageText').value = p.smallImageText || '';
  document.getElementById('partyCurrent').value = p.partyCurrent || '';
  document.getElementById('partyMax').value = p.partyMax || '';
  document.getElementById('button1Label').value = p.button1Label || '';
  document.getElementById('button1Url').value = p.button1Url || '';
  document.getElementById('button2Label').value = p.button2Label || '';
  document.getElementById('button2Url').value = p.button2Url || '';

  updateAllCounters();
  updateTimestampVisibility();
  updateActionButtons();
  renderPreview();
}

function updateCounter(inputId, counterId, max) {
  const input = document.getElementById(inputId);
  const counter = document.getElementById(counterId);
  const len = input.value.length;
  counter.textContent = `${len}/${max}`;
  counter.classList.remove('warn', 'full');
  if (len >= max) counter.classList.add('full');
  else if (len >= max * 0.85) counter.classList.add('warn');
}

function updateAllCounters() {
  updateCounter('details', 'detailsCounter', 128);
  updateCounter('state', 'stateCounter', 128);
  updateCounter('largeImageText', 'largeImageTextCounter', 128);
  updateCounter('smallImageText', 'smallImageTextCounter', 128);
  updateCounter('button1Label', 'btn1LabelCounter', 32);
  updateCounter('button2Label', 'btn2LabelCounter', 32);
}

function updateTimestampVisibility() {
  const mode = document.getElementById('timestampMode').value;
  const row = document.getElementById('customTimestampsRow');
  row.style.display = (mode === 'custom_start' || mode === 'custom_range') ? 'grid' : 'none';
}

function updateActionButtons() {
  const p = currentProfile();
  const isLive = state.liveProfileId === p.id;
  document.getElementById('btnActivate').disabled = isLive;
  document.getElementById('btnUpdate').disabled = !isLive;
  document.getElementById('btnDeactivate').disabled = !isLive;
}

function updateStatus(text, dotClass) {
  document.getElementById('statusText').textContent = text;
  const dot = document.getElementById('statusDot');
  dot.classList.remove('online', 'offline', 'error');
  dot.classList.add(dotClass);
}

function showError(msg) {
  const box = document.getElementById('errorBox');
  if (!msg) {
    box.style.display = 'none';
    box.textContent = '';
  } else {
    box.style.display = 'block';
    box.textContent = msg;
  }
}

// ---------- Live Preview ----------
function renderPreview() {
  const p = currentProfile();
  document.getElementById('prevAppName').textContent = p.name || 'App name';
  document.getElementById('prevDetails').textContent = p.details || '—';
  document.getElementById('prevState').textContent = p.state || '—';

  const btnsEl = document.getElementById('prevButtons');
  btnsEl.innerHTML = '';
  if (p.button1Label && p.button1Url) {
    const b = document.createElement('div');
    b.className = 'preview-button';
    b.textContent = p.button1Label;
    btnsEl.appendChild(b);
  }
  if (p.button2Label && p.button2Url) {
    const b = document.createElement('div');
    b.className = 'preview-button';
    b.textContent = p.button2Label;
    btnsEl.appendChild(b);
  }

  // Image placeholder coloring based on whether key is set
  const big = document.getElementById('prevLarge');
  big.style.background = p.largeImageKey ? 'linear-gradient(135deg,#5563d4,#7c8cff)' : 'var(--bg-3)';
  const small = document.getElementById('prevSmall');
  small.style.background = p.smallImageKey ? 'linear-gradient(135deg,#7c8cff,#5563d4)' : 'var(--bg-4)';
}

// ---------- Sync field <-> profile ----------
function bindField(inputId, key, isNumber = false) {
  const el = document.getElementById(inputId);
  el.addEventListener('input', () => {
    const p = currentProfile();
    p[key] = isNumber ? (el.value === '' ? '' : Number(el.value)) : el.value;
    if (key === 'name') renderTabs();
    if (key === 'timestampMode') updateTimestampVisibility();
    updateAllCounters();
    renderPreview();
    saveStore();
  });
}

function bindAllFields() {
  bindField('profileName', 'name');
  bindField('clientId', 'clientId');
  bindField('activityType', 'activityType', true);
  bindField('timestampMode', 'timestampMode');
  bindField('startTimestamp', 'startTimestamp');
  bindField('endTimestamp', 'endTimestamp');
  bindField('details', 'details');
  bindField('state', 'state');
  bindField('largeImageKey', 'largeImageKey');
  bindField('largeImageText', 'largeImageText');
  bindField('smallImageKey', 'smallImageKey');
  bindField('smallImageText', 'smallImageText');
  bindField('partyCurrent', 'partyCurrent');
  bindField('partyMax', 'partyMax');
  bindField('button1Label', 'button1Label');
  bindField('button1Url', 'button1Url');
  bindField('button2Label', 'button2Label');
  bindField('button2Url', 'button2Url');
}

// ---------- Validation ----------
function validateProfile(p) {
  if (!p.clientId || !/^\d{17,21}$/.test(p.clientId.trim())) {
    return 'Client ID must be a 17–21 digit Discord application ID.';
  }
  for (const [labelKey, urlKey, n] of [['button1Label','button1Url',1],['button2Label','button2Url',2]]) {
    const hasL = !!p[labelKey];
    const hasU = !!p[urlKey];
    if (hasL !== hasU) return `Button ${n}: both label and URL are required (or leave both empty).`;
    if (hasU) {
      try {
        const u = new URL(p[urlKey]);
        if (!/^https?:$/.test(u.protocol)) return `Button ${n}: URL must start with http:// or https://`;
      } catch {
        return `Button ${n}: URL is not valid.`;
      }
    }
  }
  if (p.partyCurrent || p.partyMax) {
    const c = parseInt(p.partyCurrent, 10);
    const m = parseInt(p.partyMax, 10);
    if (isNaN(c) || isNaN(m) || c < 0 || m < 1 || c > m) {
      return 'Party size: current and max must be numbers, with current ≤ max.';
    }
  }
  return null;
}

// ---------- Actions ----------
async function activate() {
  showError('');
  const p = currentProfile();
  const err = validateProfile(p);
  if (err) { showError(err); return; }

  updateStatus('Connecting…', 'offline');
  const result = await window.multirp.connect(p);
  if (!result.ok) {
    showError(result.error || 'Failed to connect. Is Discord running on this computer?');
    updateStatus('Connection failed', 'error');
    return;
  }
  state.liveProfileId = p.id;
  updateStatus(`Live: ${p.name}`, 'online');
  updateActionButtons();
  renderTabs();
}

async function deactivate() {
  await window.multirp.disconnect();
  state.liveProfileId = null;
  updateStatus('No profile active', 'offline');
  updateActionButtons();
  renderTabs();
}

async function updateLive() {
  showError('');
  const p = currentProfile();
  const err = validateProfile(p);
  if (err) { showError(err); return; }
  const result = await window.multirp.update(p);
  if (!result.ok) {
    showError(result.error || 'Update failed.');
  } else {
    updateStatus(`Live: ${p.name} (updated)`, 'online');
  }
}

async function exportProfile() {
  const p = currentProfile();
  const result = await window.multirp.exportProfile(p);
  if (result.ok) {
    showError('');
  } else if (result.error) {
    showError('Export failed: ' + result.error);
  }
}

async function importProfile() {
  const result = await window.multirp.importProfile();
  if (result.canceled) return;
  if (!result.ok) {
    showError('Import failed: ' + (result.error || 'unknown'));
    return;
  }
  // Merge into current tab (preserves current id)
  const incoming = result.profile;
  const cur = currentProfile();
  for (const key of FIELD_KEYS) {
    if (key in incoming) cur[key] = incoming[key];
  }
  renderForm();
  renderTabs();
  saveStore();
}

function resetProfile() {
  if (!confirm('Clear all fields in this profile?')) return;
  const p = currentProfile();
  const fresh = newProfile(state.activeTab + 1);
  for (const key of FIELD_KEYS) p[key] = fresh[key];
  renderForm();
  renderTabs();
  saveStore();
}

// ---------- Init ----------
async function init() {
  // Render an immediate fallback so the window is never blank, even if loadStore fails.
  try {
    if (!window.multirp) {
      throw new Error('Preload bridge missing — window.multirp is undefined.');
    }
  } catch (e) {
    document.body.innerHTML =
      '<div style="padding:24px;color:#eee;font-family:sans-serif;">' +
      '<h2>MultiRP could not start</h2>' +
      '<p>The preload script did not load. This usually means the install is corrupted — try reinstalling.</p>' +
      '<p style="opacity:.7;font-size:12px;">' + (e && e.message ? e.message : e) + '</p>' +
      '</div>';
    return;
  }

  try {
    await loadStore();
  } catch (e) {
    console.error('loadStore failed:', e);
  }
  renderTabs();
  renderForm();
  bindAllFields();

  document.getElementById('btnActivate').onclick = activate;
  document.getElementById('btnDeactivate').onclick = deactivate;
  document.getElementById('btnUpdate').onclick = updateLive;
  document.getElementById('btnExport').onclick = exportProfile;
  document.getElementById('btnImport').onclick = importProfile;
  document.getElementById('btnReset').onclick = resetProfile;

  // Brand logo (replaces M placeholder)
  document.getElementById('brandLogo').src = 'logo.png';

  // Updates wiring
  setupUpdatesView();

  document.getElementById('openDevPortal').onclick = (e) => {
    e.preventDefault();
    // Renderer is context-isolated so `require` is unavailable here.
    // Open via the preload-bridged helper if present, else fallback to window.open.
    if (window.multirp && typeof window.multirp.openExternal === 'function') {
      window.multirp.openExternal('https://discord.com/developers/applications');
    } else {
      try { window.open('https://discord.com/developers/applications', '_blank'); } catch {}
    }
  };

  // ---------- Help modal (dark themed) ----------
  const helpModal = document.getElementById('helpModal');
  const helpClose = document.getElementById('helpModalClose');
  const helpOk = document.getElementById('helpModalOk');
  const helpDevPortal = document.getElementById('helpDevPortal');

  const openHelpModal = () => {
    helpModal.hidden = false;
    // Focus the OK button for keyboard users
    setTimeout(() => helpOk && helpOk.focus(), 50);
  };
  const closeHelpModal = () => { helpModal.hidden = true; };

  document.getElementById('openHelp').onclick = (e) => {
    e.preventDefault();
    openHelpModal();
  };
  helpClose.onclick = closeHelpModal;
  helpOk.onclick = closeHelpModal;
  // Click outside modal to dismiss
  helpModal.addEventListener('click', (e) => {
    if (e.target === helpModal) closeHelpModal();
  });
  // Escape to dismiss
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !helpModal.hidden) closeHelpModal();
  });
  // Dev Portal link inside modal
  helpDevPortal.onclick = (e) => {
    e.preventDefault();
    if (window.multirp && typeof window.multirp.openExternal === 'function') {
      window.multirp.openExternal('https://discord.com/developers/applications');
    } else {
      try { window.open('https://discord.com/developers/applications', '_blank'); } catch {}
    }
  };

  window.multirp.onDisconnected(() => {
    state.liveProfileId = null;
    updateStatus('Disconnected', 'offline');
    updateActionButtons();
    renderTabs();
  });

  updateStatus('No profile active', 'offline');
}

// =============================================
// Updates view
// =============================================
function setupUpdatesView() {
  const updatesTab = document.getElementById('updatesTab');
  const checkBtn = document.getElementById('updCheckBtn');
  const downloadBtn = document.getElementById('updDownloadBtn');
  const installBtn = document.getElementById('updInstallBtn');
  const autoToggle = document.getElementById('updAutoToggle');
  const repoLink = document.getElementById('updRepoLink');

  updatesTab.onclick = () => switchView('updates');

  checkBtn.onclick = async () => {
    setUpdateMessage('info', 'Checking for updates…');
    const r = await window.multirp.updates.check();
    if (!r.ok) {
      setUpdateMessage('error', r.error || 'Update check failed.');
    }
  };

  downloadBtn.onclick = async () => {
    setUpdateMessage('info', 'Downloading update…');
    const r = await window.multirp.updates.download();
    if (!r.ok) setUpdateMessage('error', r.error || 'Download failed.');
  };

  installBtn.onclick = async () => {
    setUpdateMessage('info', 'Restarting to install…');
    const r = await window.multirp.updates.install();
    if (!r.ok) setUpdateMessage('error', r.error || 'Install failed.');
  };

  autoToggle.onchange = async () => {
    state.autoInstall = autoToggle.checked;
    await window.multirp.updates.setAutoInstall(autoToggle.checked);
  };

  repoLink.onclick = (e) => {
    e.preventDefault();
    window.multirp.openExternal('https://github.com/AlarkiusJay/MultiRPCustomizer/releases');
  };

  // Subscribe to live state
  window.multirp.updates.onState((newState) => {
    state.updateState = newState;
    renderUpdatesView();
    refreshUpdateDot();
  });

  // Startup & tray toggles
  const setAutoStart = document.getElementById('setAutoStart');
  const setStartMinimized = document.getElementById('setStartMinimized');
  const setCloseToTray = document.getElementById('setCloseToTray');

  function syncStartupToggleEnable() {
    // "Start minimized to tray" only matters when auto-start is on.
    setStartMinimized.disabled = !state.autoStart;
    setStartMinimized.parentElement.style.opacity = state.autoStart ? '1' : '0.5';
  }

  setAutoStart.onchange = async () => {
    state.autoStart = setAutoStart.checked;
    syncStartupToggleEnable();
    await window.multirp.settings.setAutoStart(setAutoStart.checked);
  };
  setStartMinimized.onchange = async () => {
    state.startMinimized = setStartMinimized.checked;
    await window.multirp.settings.setStartMinimized(setStartMinimized.checked);
  };
  setCloseToTray.onchange = async () => {
    state.closeToTray = setCloseToTray.checked;
    await window.multirp.settings.setCloseToTray(setCloseToTray.checked);
  };

  refreshStartupSettings = async function () {
    try {
      const s = await window.multirp.settings.get();
      state.autoStart = !!s.autoStart;
      state.startMinimized = !!s.startMinimized;
      state.closeToTray = !!s.closeToTray;
      setAutoStart.checked = state.autoStart;
      setStartMinimized.checked = state.startMinimized;
      setCloseToTray.checked = state.closeToTray;
      syncStartupToggleEnable();
    } catch (e) {
      console.error('refreshStartupSettings failed:', e);
    }
  };

  // Pull initial state
  refreshUpdatesAll();
  refreshStartupSettings();
}

// Forward-declared so renderUpdatesView/switchView can refresh on view enter.
let refreshStartupSettings = async () => {};

async function refreshUpdatesAll() {
  try {
    const status = await window.multirp.updates.status();
    state.updateState = status;
    if (status.settings && typeof status.settings.autoInstall === 'boolean') {
      state.autoInstall = status.settings.autoInstall;
    }
    // Pull current version from app if not in updateState yet
    if (!status.currentVersion) {
      try { status.currentVersion = await window.multirp.getVersion(); } catch {}
    }
    renderUpdatesView();
    refreshUpdateDot();
    refreshUpdateHistory();
  } catch (e) {
    console.error('refreshUpdatesAll failed:', e);
  }
}

async function refreshUpdateHistory() {
  try {
    const hist = await window.multirp.updates.getHistory();
    const ul = document.getElementById('updHistory');
    ul.innerHTML = '';
    if (!hist || hist.length === 0) {
      const li = document.createElement('li');
      li.className = 'updates-history-empty';
      li.textContent = 'No updates have been installed yet.';
      ul.appendChild(li);
      return;
    }
    // Show newest first
    [...hist].reverse().forEach((h) => {
      const li = document.createElement('li');
      const ev = document.createElement('span');
      ev.className = 'history-event ' + (h.event || '');
      ev.textContent = h.event || 'event';
      li.appendChild(ev);
      const txt = document.createElement('span');
      const from = h.from ? `v${h.from}` : '—';
      const to = h.to ? `v${h.to}` : '—';
      txt.innerHTML = `${from} <span class="history-arrow">→</span> ${to}`;
      li.appendChild(txt);
      const time = document.createElement('span');
      time.className = 'history-time';
      time.textContent = h.ts ? new Date(h.ts).toLocaleString() : '';
      li.appendChild(time);
      ul.appendChild(li);
    });
  } catch (e) {
    console.error('refreshUpdateHistory failed:', e);
  }
}

function switchView(view) {
  state.view = view;
  document.getElementById('viewProfile').hidden = (view !== 'profile');
  document.getElementById('viewUpdates').hidden = (view !== 'updates');
  document.getElementById('updatesTab').classList.toggle('active', view === 'updates');

  // Update active styling on profile tabs
  document.querySelectorAll('.tab').forEach((t, i) => {
    t.classList.toggle('active', view === 'profile' && i === state.activeTab);
  });

  if (view === 'updates') {
    state.hasSeenLatestUpdate = true;
    refreshUpdateDot();
    refreshUpdateHistory();
    refreshStartupSettings();
  }
}

function setUpdateMessage(level, text) {
  const el = document.getElementById('updMessage');
  if (!text) { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false;
  el.className = 'updates-message ' + (level || 'info');
  el.textContent = text;
}

function renderUpdatesView() {
  const us = state.updateState || {};
  const pill = document.getElementById('updStatusPill');
  const versionEl = document.getElementById('updCurrentVersion');
  const footerEl = document.getElementById('footerVersion');
  const checkBtn = document.getElementById('updCheckBtn');
  const downloadBtn = document.getElementById('updDownloadBtn');
  const installBtn = document.getElementById('updInstallBtn');
  const autoToggle = document.getElementById('updAutoToggle');
  const progressWrap = document.getElementById('updProgressWrap');
  const progressFill = document.getElementById('updProgressFill');
  const progressText = document.getElementById('updProgressText');
  const changelogEl = document.getElementById('updChangelog');

  const cur = us.currentVersion ? `v${us.currentVersion}` : '—';
  versionEl.textContent = cur;
  if (us.currentVersion) {
    footerEl.textContent = `v${us.currentVersion} · Built by Alarkius Elvya Jay`;
  }

  autoToggle.checked = !!state.autoInstall;

  pill.classList.remove('idle', 'checking', 'up-to-date', 'available', 'downloading', 'ready', 'error');

  // Reset action visibility
  checkBtn.disabled = false;
  downloadBtn.disabled = true;
  downloadBtn.hidden = false;
  installBtn.hidden = true;
  progressWrap.hidden = true;

  switch (us.status) {
    case 'checking':
      pill.textContent = 'Checking…';
      pill.classList.add('checking');
      checkBtn.disabled = true;
      break;
    case 'available':
      pill.textContent = `Update available — v${us.latestVersion || '?'}`;
      pill.classList.add('available');
      downloadBtn.disabled = false;
      break;
    case 'not-available':
      pill.textContent = 'Up to date';
      pill.classList.add('up-to-date');
      break;
    case 'downloading':
      pill.textContent = `Downloading… ${us.downloadPercent || 0}%`;
      pill.classList.add('downloading');
      progressWrap.hidden = false;
      progressFill.style.width = (us.downloadPercent || 0) + '%';
      progressText.textContent = (us.downloadPercent || 0) + '%';
      break;
    case 'downloaded':
      pill.textContent = `Update ready — v${us.latestVersion || '?'}`;
      pill.classList.add('ready');
      downloadBtn.hidden = true;
      installBtn.hidden = false;
      break;
    case 'error':
      pill.textContent = 'Update error';
      pill.classList.add('error');
      if (us.error) setUpdateMessage('error', us.error);
      break;
    default:
      pill.textContent = 'Idle';
      pill.classList.add('idle');
  }

  // Changelog
  if (us.releaseNotes) {
    changelogEl.innerHTML = formatReleaseNotes(us.releaseNotes, us.latestVersion);
  } else if (us.status === 'not-available') {
    changelogEl.textContent = `You’re on the latest version (v${us.currentVersion}).`;
  }
}

function formatReleaseNotes(notes, version) {
  // Strip HTML tags for safety, then preserve simple markdown bullets / line breaks.
  const escaped = String(notes)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  // Naive: turn lines starting with - or * into bullets, **bold** into <b>
  const lines = escaped.split(/\r?\n/).map((line) => {
    let l = line.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    l = l.replace(/`([^`]+)`/g, '<code>$1</code>');
    if (/^\s*[-*]\s+/.test(l)) l = '• ' + l.replace(/^\s*[-*]\s+/, '');
    return l;
  });
  const header = version ? `<b>v${version}</b>\n\n` : '';
  return header + lines.join('\n');
}

function refreshUpdateDot() {
  const dot = document.getElementById('updateDot');
  const us = state.updateState || {};
  // Show dot when there's a new version available or downloaded and the user hasn't viewed it yet
  const hasNew = us.status === 'available' || us.status === 'downloading' || us.status === 'downloaded';
  // Only flag as unseen if we discovered after the user last visited the tab
  if (hasNew && state.view !== 'updates') {
    state.hasSeenLatestUpdate = false;
  }
  dot.hidden = !(hasNew && !state.hasSeenLatestUpdate);
}

// Catch any unhandled error in init so the window shows something instead of pure grey.
init().catch((e) => {
  console.error('Init failed:', e);
  document.body.innerHTML =
    '<div style="padding:24px;color:#eee;font-family:sans-serif;background:#1a1a1d;">' +
    '<h2>MultiRP hit an error during startup</h2>' +
    '<pre style="white-space:pre-wrap;background:#222;padding:12px;border-radius:6px;">' +
    (e && e.stack ? e.stack : String(e)) +
    '</pre></div>';
});

window.addEventListener('error', (ev) => {
  console.error('Renderer error:', ev.error || ev.message);
});
window.addEventListener('unhandledrejection', (ev) => {
  console.error('Unhandled rejection:', ev.reason);
});
