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

// =============================================================
// Profile Theme defaults & helpers (v1.7.0)
// =============================================================
//
// Each profile carries an optional `theme` object. When the profile is
// activated (and theme.enabled is true), the renderer injects these as CSS
// variables on :root and <body> gets a class to flip into themed mode.
// `null`/missing theme = stock dark.
const DEFAULT_PROFILE_THEME = {
  enabled: false,
  accent: '#7c8cff',          // primary brand / button color
  accentHover: '#93a0ff',     // primary hover
  bg1: '#1a1a1d',             // app background
  bg2: '#212124',             // panel background
  bg3: '#28282c',             // raised surface
  border: '#38383d',
  text: '#e6e8ee',
  textDim: '#a4a8b3',
  bgGradient: ''              // optional CSS background image, e.g. linear-gradient(...) — empty = solid bg1
};

function profileTheme(profile) {
  if (!profile || !profile.theme) return null;
  return { ...DEFAULT_PROFILE_THEME, ...profile.theme };
}

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
    button2Url: '',
    theme: { ...DEFAULT_PROFILE_THEME }
  };
}

let state = {
  profiles: [newProfile(1)],
  activeTab: 0,
  liveProfileId: null,
  view: 'profile',          // 'profile' | 'updates' | 'auto'
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
    // Migrate older profiles that pre-date v1.7.0 themes
    state.profiles.forEach(p => {
      if (!p.theme) p.theme = { ...DEFAULT_PROFILE_THEME };
      else p.theme = { ...DEFAULT_PROFILE_THEME, ...p.theme };
    });
    state.activeTab = Math.min(data.activeTab || 0, state.profiles.length - 1);
  }
}

// =============================================================
// Theme application (v1.7.0)
// =============================================================
// Apply a profile's theme to the live UI by setting CSS variables on :root
// and toggling a `.themed` class on <body>. Pass null to revert to stock.
function applyThemeFromProfile(profile) {
  const root = document.documentElement;
  const body = document.body;
  const t = profileTheme(profile);

  if (!t || !t.enabled) {
    // Revert all overrides
    root.style.removeProperty('--accent');
    root.style.removeProperty('--accent-hover');
    root.style.removeProperty('--bg-1');
    root.style.removeProperty('--bg-2');
    root.style.removeProperty('--bg-3');
    root.style.removeProperty('--border');
    root.style.removeProperty('--text');
    root.style.removeProperty('--text-dim');
    root.style.removeProperty('--profile-bg-image');
    body && body.classList.remove('themed');
    return;
  }

  root.style.setProperty('--accent', t.accent);
  root.style.setProperty('--accent-hover', t.accentHover || t.accent);
  root.style.setProperty('--bg-1', t.bg1);
  root.style.setProperty('--bg-2', t.bg2);
  root.style.setProperty('--bg-3', t.bg3);
  root.style.setProperty('--border', t.border);
  root.style.setProperty('--text', t.text);
  root.style.setProperty('--text-dim', t.textDim);
  root.style.setProperty('--profile-bg-image', t.bgGradient ? t.bgGradient : 'none');
  body && body.classList.add('themed');
}

// Refresh the theme based on current state. Active profile beats current tab
// so when something is live, the app reflects what's actually on Discord.
function refreshAppTheme() {
  let target = null;
  if (state.liveProfileId) {
    target = state.profiles.find(p => p.id === state.liveProfileId) || null;
  }
  if (!target) target = currentProfile();
  applyThemeFromProfile(target);
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
    tab.title = `${p.name} — drag to reorder`;
    tab.draggable = true;
    tab.dataset.index = String(i);

    if (state.liveProfileId === p.id) {
      const dot = document.createElement('span');
      dot.className = 'live-dot';
      tab.appendChild(dot);
    }

    const label = document.createElement('span');
    label.className = 'tab-label';
    label.textContent = p.name || `Profile ${i + 1}`;
    tab.appendChild(label);

    if (state.profiles.length > 1) {
      const close = document.createElement('span');
      close.className = 'tab-close';
      close.textContent = '×';
      close.title = 'Delete profile';
      close.draggable = false; // close button shouldn't initiate drags
      close.onmousedown = (e) => e.stopPropagation();
      close.onclick = (e) => {
        e.stopPropagation();
        deleteProfile(i);
      };
      tab.appendChild(close);
    }

    tab.addEventListener('click', (e) => {
      // Don't switch if drag just ended on this element
      if (tab.dataset.justDropped === '1') {
        delete tab.dataset.justDropped;
        return;
      }
      switchTab(i);
    });

    // Drag-and-drop reorder handlers
    tab.addEventListener('dragstart', (e) => {
      tab.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      // Required for Firefox; data is unused (we read state.dragIndex)
      try { e.dataTransfer.setData('text/plain', String(i)); } catch (_) {}
      state.dragIndex = i;
    });
    tab.addEventListener('dragend', () => {
      tab.classList.remove('dragging');
      document.querySelectorAll('.tab.drop-before, .tab.drop-after').forEach(el => {
        el.classList.remove('drop-before', 'drop-after');
      });
      state.dragIndex = null;
    });
    tab.addEventListener('dragover', (e) => {
      if (state.dragIndex == null || state.dragIndex === i) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const rect = tab.getBoundingClientRect();
      const before = (e.clientX - rect.left) < rect.width / 2;
      tab.classList.toggle('drop-before', before);
      tab.classList.toggle('drop-after', !before);
    });
    tab.addEventListener('dragleave', () => {
      tab.classList.remove('drop-before', 'drop-after');
    });
    tab.addEventListener('drop', (e) => {
      e.preventDefault();
      tab.classList.remove('drop-before', 'drop-after');
      const from = state.dragIndex;
      if (from == null || from === i) return;
      const rect = tab.getBoundingClientRect();
      const before = (e.clientX - rect.left) < rect.width / 2;
      let to = before ? i : i + 1;
      // Account for index shift when moving forward
      if (from < to) to -= 1;
      reorderProfiles(from, to);
      // Suppress the click that fires after drop
      tab.dataset.justDropped = '1';
    });

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

function reorderProfiles(from, to) {
  if (from === to || from < 0 || from >= state.profiles.length) return;
  to = Math.max(0, Math.min(state.profiles.length - 1, to));
  // Track active profile by id so its highlight follows the move
  const activeId = state.profiles[state.activeTab] ? state.profiles[state.activeTab].id : null;
  const [moved] = state.profiles.splice(from, 1);
  state.profiles.splice(to, 0, moved);
  if (activeId != null) {
    const newIdx = state.profiles.findIndex(p => p.id === activeId);
    if (newIdx !== -1) state.activeTab = newIdx;
  }
  renderTabs();
  saveStore();
}

function switchTab(i) {
  if (state.view === 'updates' || state.view === 'auto') switchView('profile');
  state.activeTab = i;
  renderForm();
  renderTabs();
  refreshAppTheme();
  saveStore();
}

function addProfile() {
  if (state.profiles.length >= MAX_PROFILES) return;
  if (state.view === 'updates' || state.view === 'auto') switchView('profile');
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
  renderThemeEditor();
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
//
// Asset resolution: when a clientId + image key are present, ask main to look up
// the real CDN URL via Discord's public application-assets endpoint. Cache results
// by `${clientId}|${key}` so we don't spam Discord with every keystroke.
const assetUrlCache = new Map(); // "clientId|key" -> url|null
const assetPending = new Map();   // "clientId|key" -> Promise
let assetDebounceTimer = null;

function setPreviewImage(el, url, fallbackGradient) {
  // Clear any prior background-image / state
  el.classList.remove('has-image', 'loading');
  el.style.backgroundImage = '';
  if (url) {
    // Probe first so a broken URL doesn't leave us showing a broken-image icon
    const probe = new Image();
    probe.onload = () => {
      el.style.background = `center / cover no-repeat url("${url}")`;
      el.classList.add('has-image');
    };
    probe.onerror = () => {
      el.style.background = fallbackGradient;
    };
    probe.src = url;
  } else {
    el.style.background = fallbackGradient;
  }
}

async function resolveAndApply(el, clientId, key, fallbackGradient) {
  if (!key) {
    setPreviewImage(el, null, fallbackGradient);
    return;
  }
  const cacheKey = `${clientId || ''}|${key}`;
  if (assetUrlCache.has(cacheKey)) {
    setPreviewImage(el, assetUrlCache.get(cacheKey), fallbackGradient);
    return;
  }
  // Show fallback while loading
  setPreviewImage(el, null, fallbackGradient);
  el.classList.add('loading');
  let promise = assetPending.get(cacheKey);
  if (!promise) {
    promise = window.multirp.resolveAsset(clientId, key).catch(() => ({ ok: false }));
    assetPending.set(cacheKey, promise);
  }
  const result = await promise;
  assetPending.delete(cacheKey);
  const url = (result && result.ok) ? result.url : null;
  assetUrlCache.set(cacheKey, url);
  // Re-check the user is still viewing this profile/key combo before applying
  const cur = currentProfile();
  const stillRelevant =
    (el.id === 'prevLarge' && cur.largeImageKey === key && cur.clientId === clientId) ||
    (el.id === 'prevSmall' && cur.smallImageKey === key && cur.clientId === clientId);
  if (stillRelevant) {
    setPreviewImage(el, url, fallbackGradient);
  }
}

// Map activity type id -> Discord's user-facing verb shown above the activity card
function activityVerb(type) {
  switch (Number(type)) {
    case 2: return 'Listening to';
    case 3: return 'Watching';
    case 5: return 'Competing in';
    default: return 'Playing'; // 0 and any unknown
  }
}

// Compute the elapsed/range string Discord shows under the activity. Mirrors
// the visual format "H:MM:SS elapsed" / "M:SS elapsed" / "M:SS — M:SS left".
function formatElapsedString(p) {
  const now = Math.floor(Date.now() / 1000);
  const fmt = (sec) => {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
  };
  const mode = p.timestampMode || 'none';
  if (mode === 'none') return '';
  if (mode === 'elapsed') {
    return `${fmt(0)} elapsed`;
  }
  if (mode === 'custom_start') {
    const start = Number(p.startTimestamp || 0);
    if (!start) return '';
    return `${fmt(now - start)} elapsed`;
  }
  if (mode === 'custom_range') {
    const start = Number(p.startTimestamp || 0);
    const end = Number(p.endTimestamp || 0);
    if (!end) return '';
    if (now < start) return `starts in ${fmt(start - now)}`;
    if (now > end) return 'ended';
    return `${fmt(now - start)} — ${fmt(end - now)} left`;
  }
  return '';
}

// Live ticker for the elapsed counter — fires once per second only when the
// active profile uses a timestamp mode that needs ticking.
let elapsedTickTimer = null;
function startElapsedTicker() {
  if (elapsedTickTimer) return;
  elapsedTickTimer = setInterval(() => {
    const p = currentProfile();
    const mode = p.timestampMode || 'none';
    if (mode === 'none') return;
    const el = document.getElementById('prevElapsed');
    if (!el) return;
    el.textContent = formatElapsedString(p);
    // Also push to popout if it's open
    pushPreviewToPopout({ elapsed: el.textContent });
  }, 1000);
}
startElapsedTicker();

function renderPreview() {
  const p = currentProfile();
  document.getElementById('prevActivityLabel').textContent = activityVerb(p.activityType);
  document.getElementById('prevAppName').textContent = p.name || 'App name';
  document.getElementById('prevDetails').textContent = p.details || '—';
  document.getElementById('prevState').textContent = p.state || '—';

  const elapsedEl = document.getElementById('prevElapsed');
  const elapsedStr = formatElapsedString(p);
  elapsedEl.textContent = elapsedStr;
  elapsedEl.style.display = elapsedStr ? '' : 'none';

  const btnsEl = document.getElementById('prevButtons');
  btnsEl.innerHTML = '';
  const makeButton = (label, url) => {
    const b = document.createElement('div');
    b.className = 'preview-button';
    b.textContent = label;
    b.title = `${label} — ${url}\nClick to open in browser`;
    b.onclick = (e) => {
      e.preventDefault();
      if (url && /^https?:\/\//i.test(url) && window.multirp && window.multirp.openExternal) {
        window.multirp.openExternal(url);
      }
    };
    return b;
  };
  if (p.button1Label && p.button1Url) btnsEl.appendChild(makeButton(p.button1Label, p.button1Url));
  if (p.button2Label && p.button2Url) btnsEl.appendChild(makeButton(p.button2Label, p.button2Url));

  const big = document.getElementById('prevLarge');
  const small = document.getElementById('prevSmall');
  const bigFallback = p.largeImageKey ? 'linear-gradient(135deg,#5563d4,#7c8cff)' : 'var(--bg-3)';
  const smallFallback = p.smallImageKey ? 'linear-gradient(135deg,#7c8cff,#5563d4)' : 'var(--bg-4)';

  // Show fallback immediately for instant feedback, then debounce the network call.
  setPreviewImage(big, null, bigFallback);
  setPreviewImage(small, null, smallFallback);

  clearTimeout(assetDebounceTimer);
  assetDebounceTimer = setTimeout(() => {
    const cur = currentProfile();
    if (cur.largeImageKey) {
      resolveAndApply(big, cur.clientId, cur.largeImageKey, bigFallback);
    }
    if (cur.smallImageKey) {
      resolveAndApply(small, cur.clientId, cur.smallImageKey, smallFallback);
    }
    // Also push fully-resolved snapshot to popout once images settle
    pushPreviewSnapshot();
  }, 500);

  // Tooltips for images using the user-provided tooltip text
  big.title = p.largeImageTooltip || '';
  small.title = p.smallImageTooltip || '';

  pushPreviewSnapshot();
}

// ---------- Popout sync ----------
// Build a serializable snapshot of everything the popout window needs to
// render the same card. Resolved image URLs are read from the cache so the
// popout doesn't have to do its own asset lookups.
function buildPreviewSnapshot() {
  const p = currentProfile();
  const lookupUrl = (key) => {
    if (!key) return null;
    if (/^https?:\/\//i.test(key)) return key;
    return assetUrlCache.get(`${p.clientId || ''}|${key}`) || null;
  };
  return {
    activityVerb: activityVerb(p.activityType),
    appName: p.name || 'App name',
    details: p.details || '',
    state: p.state || '',
    elapsed: formatElapsedString(p),
    largeUrl: lookupUrl(p.largeImageKey),
    smallUrl: lookupUrl(p.smallImageKey),
    largeTooltip: p.largeImageTooltip || '',
    smallTooltip: p.smallImageTooltip || '',
    buttons: [
      (p.button1Label && p.button1Url) ? { label: p.button1Label, url: p.button1Url } : null,
      (p.button2Label && p.button2Url) ? { label: p.button2Label, url: p.button2Url } : null,
    ].filter(Boolean),
    isLive: state.liveProfileId === p.id,
  };
}

function pushPreviewSnapshot() {
  if (window.multirp && window.multirp.popoutSync) {
    try { window.multirp.popoutSync(buildPreviewSnapshot()); } catch (_) {}
  }
}
// Lightweight push for partial updates (e.g. just the ticking elapsed string)
function pushPreviewToPopout(partial) {
  if (window.multirp && window.multirp.popoutSync) {
    try { window.multirp.popoutSync({ ...buildPreviewSnapshot(), ...partial }); } catch (_) {}
  }
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
  refreshAppTheme();
}

async function deactivate() {
  await window.multirp.disconnect();
  state.liveProfileId = null;
  updateStatus('No profile active', 'offline');
  updateActionButtons();
  renderTabs();
  refreshAppTheme();
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

  // Friendly toast: tell the user which format was detected.
  const fmt = result.format;
  const labels = {
    crp: 'CustomRP preset (.crp)',
    json: 'MultiRP profile (JSON)',
    csv: 'CSV',
    markdown: 'Markdown',
    txt: 'plain text'
  };
  if (fmt && labels[fmt]) {
    showError(`Imported ${labels[fmt]} into this tab.`);
    setTimeout(() => showError(''), 4000);
  }
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

  // Auto Presence wiring
  setupAutoPresenceView();

  // Profile Theme editor wiring (v1.7.0)
  setupThemeEditor();
  refreshAppTheme();

  // v1.7.0 — Hotkeys / Idle / Game UI
  setupHotkeysUI();
  setupIdleUI();
  setupGameUI();
  // Live updates from main process (game scanner running flags, etc.)
  if (window.multirp && window.multirp.extSettings && window.multirp.extSettings.onChanged) {
    window.multirp.extSettings.onChanged((s) => {
      extState = s || extState;
      refreshExtUI();
    });
  }

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
  // CustomRP inspiration link
  // "View as others" popout button — opens a separate window styled like
  // another user's Discord client looking at your profile.
  const openPopoutBtn = document.getElementById('openPopout');
  if (openPopoutBtn) {
    openPopoutBtn.onclick = async () => {
      if (window.multirp && window.multirp.openPopout) {
        await window.multirp.openPopout();
        // Send the current state immediately so the popout has data on first paint
        pushPreviewSnapshot();
      }
    };
  }
  // When the popout asks for an initial snapshot (e.g. on its first load), push one.
  if (window.multirp && window.multirp.onPopoutReady) {
    window.multirp.onPopoutReady(() => pushPreviewSnapshot());
  }

  const helpCustomrpLink = document.getElementById('helpCustomrpLink');
  if (helpCustomrpLink) {
    helpCustomrpLink.onclick = (e) => {
      e.preventDefault();
      if (window.multirp && typeof window.multirp.openExternal === 'function') {
        window.multirp.openExternal('https://www.customrp.xyz');
      } else {
        try { window.open('https://www.customrp.xyz', '_blank'); } catch {}
      }
    };
  }

  window.multirp.onDisconnected(() => {
    state.liveProfileId = null;
    updateStatus('Disconnected', 'offline');
    updateActionButtons();
    renderTabs();
    refreshAppTheme();
  });

  // When auto-presence (or any other engine in main) flips the active profile,
  // sync our local state so theme + tabs reflect reality.
  if (window.multirp.onActiveChanged) {
    window.multirp.onActiveChanged((payload) => {
      if (!payload) return;
      state.liveProfileId = payload.activeProfileId || null;
      const idx = state.profiles.findIndex(p => p.id === state.liveProfileId);
      if (idx >= 0) state.activeTab = idx;
      renderForm();
      renderTabs();
      refreshAppTheme();
      updateActionButtons();
      const liveProfile = state.profiles.find(p => p.id === state.liveProfileId);
      if (liveProfile) updateStatus(`Live: ${liveProfile.name}`, 'online');
    });
  }

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
  document.getElementById('autoTab').onclick = () => switchView('auto');

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
  document.getElementById('viewAuto').hidden = (view !== 'auto');
  document.getElementById('updatesTab').classList.toggle('active', view === 'updates');
  document.getElementById('autoTab').classList.toggle('active', view === 'auto');

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
  if (view === 'auto') {
    refreshAutoView();
  }
}

function setUpdateMessage(level, text) {
  const el = document.getElementById('updMessage');
  if (!text) { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false;
  el.className = 'updates-message ' + (level || 'info');
  el.textContent = text;
}

// =============================================
// Auto Presence view
// =============================================
//
// Local mirror of the auto-presence config. The main process is the source of
// truth (it owns the timer & schedule logic), but we keep a copy here so the
// UI renders without round-tripping IPC for every reflow. Saved via
// window.multirp.auto.set(...).
let autoConfig = {
  enabled: false,
  paused: false,
  mode: 'rotation',                  // 'rotation' | 'shuffle' | 'schedule'
  intervalValue: 30,
  intervalUnit: 'minutes',           // 'seconds' | 'minutes' | 'hours' | 'days'
  selectedProfileIds: [],            // for rotation/shuffle
  rotationOrder: [],                 // ordered profile ids for rotation
  scheduleRules: [],                 // [{id, profileId, days:[0..6], startMin, endMin}]
  notifyOnSwitch: false,
  pauseOnManual: true,
  lastActivatedProfileId: null,
  nextSwitchAt: null,                // unix ms
};

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function unitToMs(value, unit) {
  const n = Math.max(1, Math.floor(Number(value) || 1));
  switch (unit) {
    case 'seconds': return n * 1000;
    case 'minutes': return n * 60_000;
    case 'hours':   return n * 3_600_000;
    case 'days':    return n * 86_400_000;
    default:        return n * 60_000;
  }
}

function humanInterval(value, unit) {
  const n = Math.max(1, Math.floor(Number(value) || 1));
  const label = (n === 1) ? unit.replace(/s$/, '') : unit;
  return `${n} ${label}`;
}

function setupAutoPresenceView() {
  // Mode picker
  document.querySelectorAll('input[name="autoMode"]').forEach(r => {
    r.onchange = () => {
      autoConfig.mode = r.value;
      saveAutoConfig();
      refreshAutoView();
    };
  });

  // Interval inputs
  document.getElementById('autoIntervalValue').oninput = (e) => {
    autoConfig.intervalValue = Math.max(1, Math.floor(Number(e.target.value) || 1));
    document.getElementById('autoIntervalHint').textContent =
      `Effective interval: ${humanInterval(autoConfig.intervalValue, autoConfig.intervalUnit)}`;
    saveAutoConfig();
  };
  document.getElementById('autoIntervalUnit').onchange = (e) => {
    autoConfig.intervalUnit = e.target.value;
    document.getElementById('autoIntervalHint').textContent =
      `Effective interval: ${humanInterval(autoConfig.intervalValue, autoConfig.intervalUnit)}`;
    saveAutoConfig();
  };

  // Toggles
  document.getElementById('autoNotifyToggle').onchange = (e) => {
    autoConfig.notifyOnSwitch = e.target.checked;
    saveAutoConfig();
  };
  document.getElementById('autoPauseOnManual').onchange = (e) => {
    autoConfig.pauseOnManual = e.target.checked;
    saveAutoConfig();
  };

  // Master toggle
  document.getElementById('autoToggleBtn').onclick = async () => {
    autoConfig.enabled = !autoConfig.enabled;
    autoConfig.paused = false;
    await saveAutoConfig();
    refreshAutoView();
  };
  document.getElementById('autoResumeBtn').onclick = async () => {
    autoConfig.paused = false;
    await saveAutoConfig();
    refreshAutoView();
  };

  // Add schedule rule
  document.getElementById('autoAddRuleBtn').onclick = () => {
    const firstId = state.profiles[0] ? state.profiles[0].id : null;
    autoConfig.scheduleRules.push({
      id: 'r' + Math.random().toString(36).slice(2, 9),
      profileId: firstId,
      days: [1, 2, 3, 4, 5], // weekdays
      startMin: 9 * 60,      // 09:00
      endMin: 18 * 60,       // 18:00
    });
    saveAutoConfig();
    refreshAutoView();
  };

  // Listen for status updates pushed from main
  if (window.multirp && window.multirp.auto && window.multirp.auto.onStatus) {
    window.multirp.auto.onStatus((status) => {
      // Merge status fields without losing UI-side edits
      Object.assign(autoConfig, status || {});
      refreshAutoDot();
      if (state.view === 'auto') refreshAutoView();
    });
  }

  // Initial fetch
  fetchAutoConfig();
}

async function fetchAutoConfig() {
  if (!window.multirp || !window.multirp.auto) return;
  try {
    const cfg = await window.multirp.auto.get();
    if (cfg) {
      autoConfig = { ...autoConfig, ...cfg };
    }
  } catch (e) { console.warn('auto.get failed', e); }
  refreshAutoDot();
}

async function saveAutoConfig() {
  if (!window.multirp || !window.multirp.auto) return;
  // Strip transient fields the engine recomputes
  const { nextSwitchAt, ...persisted } = autoConfig;
  try {
    const updated = await window.multirp.auto.set(persisted);
    if (updated) Object.assign(autoConfig, updated);
  } catch (e) { console.warn('auto.set failed', e); }
  refreshAutoDot();
}

function refreshAutoDot() {
  const dot = document.getElementById('autoDot');
  if (!dot) return;
  if (autoConfig.enabled && !autoConfig.paused) dot.removeAttribute('hidden');
  else dot.setAttribute('hidden', '');
}

function refreshAutoView() {
  // Mode radio reflection
  document.querySelectorAll('input[name="autoMode"]').forEach(r => {
    r.checked = (r.value === autoConfig.mode);
  });

  // Section visibility per mode
  const isSchedule = (autoConfig.mode === 'schedule');
  document.getElementById('autoIntervalSection').hidden = isSchedule;
  document.getElementById('autoProfilePickerSection').hidden = isSchedule;
  document.getElementById('autoScheduleSection').hidden = !isSchedule;

  // Interval values
  document.getElementById('autoIntervalValue').value = autoConfig.intervalValue;
  document.getElementById('autoIntervalUnit').value = autoConfig.intervalUnit;
  document.getElementById('autoIntervalHint').textContent =
    `Effective interval: ${humanInterval(autoConfig.intervalValue, autoConfig.intervalUnit)}`;

  // Toggles
  document.getElementById('autoNotifyToggle').checked = !!autoConfig.notifyOnSwitch;
  document.getElementById('autoPauseOnManual').checked = autoConfig.pauseOnManual !== false;

  // Master button + status
  const toggleBtn = document.getElementById('autoToggleBtn');
  const statusLine = document.getElementById('autoStatusLine');
  const pausedBanner = document.getElementById('autoPausedBanner');
  if (autoConfig.enabled) {
    toggleBtn.textContent = 'Stop Auto Presence';
    toggleBtn.classList.remove('primary');
    toggleBtn.classList.add('danger');
    if (autoConfig.paused) {
      statusLine.textContent = 'Paused after manual switch.';
      pausedBanner.hidden = false;
    } else {
      const next = autoConfig.nextSwitchAt
        ? `next switch in ${formatRelative(autoConfig.nextSwitchAt - Date.now())}`
        : 'running';
      statusLine.textContent = `Running — ${next}.`;
      pausedBanner.hidden = true;
    }
  } else {
    toggleBtn.textContent = 'Start Auto Presence';
    toggleBtn.classList.add('primary');
    toggleBtn.classList.remove('danger');
    statusLine.textContent = 'Stopped — manual control.';
    pausedBanner.hidden = true;
  }

  // Profile checkboxes
  renderAutoProfileList();
  // Schedule rules
  renderAutoScheduleList();
  // Up-next
  const nextSection = document.getElementById('autoNextSection');
  const nextLine = document.getElementById('autoNextLine');
  if (autoConfig.enabled && !autoConfig.paused && autoConfig.nextSwitchAt) {
    nextSection.hidden = false;
    nextLine.textContent = `In ${formatRelative(autoConfig.nextSwitchAt - Date.now())} — ${formatTimeOfDay(autoConfig.nextSwitchAt)}`;
  } else {
    nextSection.hidden = true;
  }

  refreshAutoDot();
}

function renderAutoProfileList() {
  const listEl = document.getElementById('autoProfileList');
  listEl.innerHTML = '';
  // Build the working order: existing order first, then any unselected at the end
  const order = autoConfig.rotationOrder.length
    ? autoConfig.rotationOrder.filter(id => state.profiles.find(p => p.id === id))
    : state.profiles.map(p => p.id);
  const tail = state.profiles.map(p => p.id).filter(id => !order.includes(id));
  const ordered = [...order, ...tail];

  ordered.forEach((pid, idx) => {
    const p = state.profiles.find(x => x.id === pid);
    if (!p) return;
    const row = document.createElement('div');
    row.className = 'auto-profile-row';
    row.draggable = true;
    row.dataset.pid = String(pid);

    row.innerHTML = `
      <span class="auto-drag-handle" title="Drag to reorder">⋮⋮</span>
      <label class="auto-profile-check">
        <input type="checkbox" data-pid="${pid}" ${autoConfig.selectedProfileIds.includes(pid) ? 'checked' : ''} />
        <span></span>
      </label>
      <span class="auto-profile-name">${escapeHtml(p.name || ('Profile ' + (idx + 1)))}</span>
      <span class="auto-profile-pos">${idx + 1}</span>
    `;

    const cb = row.querySelector('input[type="checkbox"]');
    cb.onchange = () => {
      const id = Number(cb.dataset.pid);
      if (cb.checked) {
        if (!autoConfig.selectedProfileIds.includes(id)) autoConfig.selectedProfileIds.push(id);
      } else {
        autoConfig.selectedProfileIds = autoConfig.selectedProfileIds.filter(x => x !== id);
      }
      saveAutoConfig();
    };

    // DnD reorder
    row.addEventListener('dragstart', (e) => {
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', String(pid)); } catch {}
    });
    row.addEventListener('dragend', () => row.classList.remove('dragging'));
    row.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    });
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      const from = Number(e.dataTransfer.getData('text/plain'));
      const to = pid;
      if (from === to) return;
      const cur = ordered.slice();
      const fromIdx = cur.indexOf(from);
      const toIdx = cur.indexOf(to);
      if (fromIdx < 0 || toIdx < 0) return;
      cur.splice(fromIdx, 1);
      cur.splice(toIdx, 0, from);
      autoConfig.rotationOrder = cur;
      saveAutoConfig();
      refreshAutoView();
    });

    listEl.appendChild(row);
  });

  // Persist current order if it wasn't set
  if (!autoConfig.rotationOrder.length) {
    autoConfig.rotationOrder = ordered;
  }
}

function renderAutoScheduleList() {
  const listEl = document.getElementById('autoScheduleList');
  listEl.innerHTML = '';
  if (!autoConfig.scheduleRules.length) {
    const empty = document.createElement('div');
    empty.className = 'auto-rule-empty';
    empty.textContent = 'No rules yet — click “+ Add Rule” to create one.';
    listEl.appendChild(empty);
    return;
  }
  autoConfig.scheduleRules.forEach((rule, idx) => {
    const row = document.createElement('div');
    row.className = 'auto-rule';
    const profileOptions = state.profiles
      .map(p => `<option value="${p.id}" ${rule.profileId === p.id ? 'selected' : ''}>${escapeHtml(p.name || ('Profile ' + p.id))}</option>`)
      .join('');
    const dayChips = DAY_LABELS.map((label, i) => `
      <label class="auto-day-chip ${rule.days.includes(i) ? 'on' : ''}" data-rule="${rule.id}" data-day="${i}">
        <input type="checkbox" ${rule.days.includes(i) ? 'checked' : ''} />
        <span>${label}</span>
      </label>
    `).join('');
    row.innerHTML = `
      <div class="auto-rule-head">
        <span class="auto-rule-num">#${idx + 1}</span>
        <select class="auto-rule-profile" data-rule="${rule.id}">${profileOptions}</select>
        <button class="auto-rule-del" data-rule="${rule.id}" title="Delete rule">×</button>
      </div>
      <div class="auto-rule-days">${dayChips}</div>
      <div class="auto-rule-times">
        <span>From</span>
        <input type="time" class="auto-rule-time" data-rule="${rule.id}" data-which="start" value="${minToHHMM(rule.startMin)}" />
        <span>to</span>
        <input type="time" class="auto-rule-time" data-rule="${rule.id}" data-which="end" value="${minToHHMM(rule.endMin)}" />
      </div>
    `;
    listEl.appendChild(row);
  });

  // Wire up dynamic handlers
  listEl.querySelectorAll('.auto-rule-profile').forEach(sel => {
    sel.onchange = () => {
      const r = autoConfig.scheduleRules.find(x => x.id === sel.dataset.rule);
      if (r) { r.profileId = Number(sel.value); saveAutoConfig(); }
    };
  });
  listEl.querySelectorAll('.auto-rule-del').forEach(btn => {
    btn.onclick = () => {
      autoConfig.scheduleRules = autoConfig.scheduleRules.filter(x => x.id !== btn.dataset.rule);
      saveAutoConfig();
      refreshAutoView();
    };
  });
  listEl.querySelectorAll('.auto-day-chip input').forEach(cb => {
    cb.onchange = () => {
      const chip = cb.closest('.auto-day-chip');
      const ruleId = chip.dataset.rule;
      const day = Number(chip.dataset.day);
      const r = autoConfig.scheduleRules.find(x => x.id === ruleId);
      if (!r) return;
      if (cb.checked) { if (!r.days.includes(day)) r.days.push(day); }
      else { r.days = r.days.filter(d => d !== day); }
      r.days.sort();
      saveAutoConfig();
      refreshAutoView();
    };
  });
  listEl.querySelectorAll('.auto-rule-time').forEach(inp => {
    inp.onchange = () => {
      const r = autoConfig.scheduleRules.find(x => x.id === inp.dataset.rule);
      if (!r) return;
      const [h, m] = inp.value.split(':').map(Number);
      const total = (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
      if (inp.dataset.which === 'start') r.startMin = total;
      else r.endMin = total;
      saveAutoConfig();
    };
  });
}

function minToHHMM(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function formatRelative(ms) {
  if (ms <= 0) return 'now';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}
function formatTimeOfDay(ms) {
  const d = new Date(ms);
  return d.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// Refresh the up-next ticker every second while viewing the auto page so the
// "next switch in 4m 12s" countdown stays alive.
setInterval(() => {
  if (state.view === 'auto' && autoConfig.enabled && !autoConfig.paused) {
    const statusLine = document.getElementById('autoStatusLine');
    const nextLine = document.getElementById('autoNextLine');
    if (autoConfig.nextSwitchAt) {
      const rel = formatRelative(autoConfig.nextSwitchAt - Date.now());
      if (statusLine) statusLine.textContent = `Running — next switch in ${rel}.`;
      if (nextLine) nextLine.textContent = `In ${rel} — ${formatTimeOfDay(autoConfig.nextSwitchAt)}`;
    }
  }
}, 1000);

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

// =============================================================
// Profile Theme editor (v1.7.0)
// =============================================================
//
// Field IDs in the editor map to keys on profile.theme. Each color has a
// linked color-picker + hex input pair that stay in sync. Live preview means
// any change instantly reflects in the running app.

const THEME_FIELDS = [
  ['themeAccent',      'themeAccentHex',      'accent'],
  ['themeAccentHover', 'themeAccentHoverHex', 'accentHover'],
  ['themeBg1',         'themeBg1Hex',         'bg1'],
  ['themeBg2',         'themeBg2Hex',         'bg2'],
  ['themeBg3',         'themeBg3Hex',         'bg3'],
  ['themeBorder',      'themeBorderHex',      'border'],
  ['themeText',        'themeTextHex',        'text'],
  ['themeTextDim',     'themeTextDimHex',     'textDim']
];

const THEME_PRESETS = {
  spiritual: {
    enabled: true,
    accent: '#b993ff', accentHover: '#cdaeff',
    bg1: '#1a1428', bg2: '#241936', bg3: '#2d1f44',
    border: '#3d2d5a', text: '#ece4ff', textDim: '#a89bc4',
    bgGradient: 'linear-gradient(135deg, #1a1428 0%, #2d1f44 100%)'
  },
  dragon: {
    enabled: true,
    accent: '#ff6b3d', accentHover: '#ff8761',
    bg1: '#1c1410', bg2: '#28190f', bg3: '#3a2316',
    border: '#52301b', text: '#ffe9dc', textDim: '#c4a08a',
    bgGradient: 'linear-gradient(135deg, #1c1410 0%, #3a1f0e 100%)'
  },
  ocean: {
    enabled: true,
    accent: '#4dd0e1', accentHover: '#6fdfee',
    bg1: '#0d1d24', bg2: '#142932', bg3: '#1c3742',
    border: '#2c5060', text: '#e0f4f8', textDim: '#8eb4c0',
    bgGradient: 'linear-gradient(135deg, #0d1d24 0%, #1a3a4a 100%)'
  },
  sakura: {
    enabled: true,
    accent: '#f48fb1', accentHover: '#f7a9c4',
    bg1: '#241418', bg2: '#321922', bg3: '#42222e',
    border: '#5e3144', text: '#ffe4ec', textDim: '#caa1b3',
    bgGradient: 'linear-gradient(135deg, #241418 0%, #4a1f30 100%)'
  }
};

function renderThemeEditor() {
  const p = currentProfile();
  if (!p) return;
  if (!p.theme) p.theme = { ...DEFAULT_PROFILE_THEME };

  document.getElementById('themeEnabled').checked = !!p.theme.enabled;

  for (const [colorId, hexId, key] of THEME_FIELDS) {
    const val = p.theme[key] || DEFAULT_PROFILE_THEME[key];
    document.getElementById(colorId).value = val;
    document.getElementById(hexId).value = val;
  }
  document.getElementById('themeGradient').value = p.theme.bgGradient || '';
}

function normalizeHex(v) {
  if (!v) return null;
  let s = String(v).trim();
  if (!s.startsWith('#')) s = '#' + s;
  // Accept #abc or #aabbcc
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    s = '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
  }
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s.toLowerCase() : null;
}

function setupThemeEditor() {
  // Wire color/hex pairs to update both inputs + the live profile + the app
  for (const [colorId, hexId, key] of THEME_FIELDS) {
    const colorEl = document.getElementById(colorId);
    const hexEl = document.getElementById(hexId);
    if (!colorEl || !hexEl) continue;

    colorEl.addEventListener('input', () => {
      const v = colorEl.value;
      hexEl.value = v;
      const p = currentProfile();
      if (!p.theme) p.theme = { ...DEFAULT_PROFILE_THEME };
      p.theme[key] = v;
      refreshAppTheme();
      saveStore();
    });

    hexEl.addEventListener('input', () => {
      const norm = normalizeHex(hexEl.value);
      if (!norm) return;
      colorEl.value = norm;
      const p = currentProfile();
      if (!p.theme) p.theme = { ...DEFAULT_PROFILE_THEME };
      p.theme[key] = norm;
      refreshAppTheme();
      saveStore();
    });
  }

  document.getElementById('themeEnabled').addEventListener('change', (e) => {
    const p = currentProfile();
    if (!p.theme) p.theme = { ...DEFAULT_PROFILE_THEME };
    p.theme.enabled = e.target.checked;
    refreshAppTheme();
    saveStore();
  });

  document.getElementById('themeGradient').addEventListener('input', (e) => {
    const p = currentProfile();
    if (!p.theme) p.theme = { ...DEFAULT_PROFILE_THEME };
    p.theme.bgGradient = e.target.value;
    refreshAppTheme();
    saveStore();
  });

  // Presets
  const applyPreset = (presetKey) => {
    const preset = THEME_PRESETS[presetKey];
    if (!preset) return;
    const p = currentProfile();
    p.theme = { ...DEFAULT_PROFILE_THEME, ...preset };
    renderThemeEditor();
    refreshAppTheme();
    saveStore();
  };
  document.getElementById('themePresetSpiritual').onclick = () => applyPreset('spiritual');
  document.getElementById('themePresetDragon').onclick    = () => applyPreset('dragon');
  document.getElementById('themePresetOcean').onclick     = () => applyPreset('ocean');
  document.getElementById('themePresetSakura').onclick    = () => applyPreset('sakura');
  document.getElementById('themePresetReset').onclick = () => {
    const p = currentProfile();
    p.theme = { ...DEFAULT_PROFILE_THEME };
    renderThemeEditor();
    refreshAppTheme();
    saveStore();
  };
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

// =============================================================
// v1.7.0 — Hotkeys / Idle / Game Detection UI
// =============================================================

let extState = {
  hotkeys: {
    cycleNext: '', jumpProfile1: '', jumpProfile2: '', jumpProfile3: '',
    jumpProfile4: '', jumpProfile5: '', toggleAuto: '', showWindow: '', toggleOnTop: ''
  },
  idle: { enabled: false, onLock: true, onSystemIdle: false, afterMinutes: 10, idleProfileId: null },
  game: { alwaysOnTop: false, alwaysOnTopAuto: false, autoActivate: false, mappings: [] }
};

const HOTKEY_DEFS = [
  { key: 'cycleNext',    label: 'Cycle to next profile',         desc: 'Activates the next profile in the list (wraps around).' },
  { key: 'jumpProfile1', label: 'Jump to profile slot 1',        desc: 'Activate the profile in slot 1.' },
  { key: 'jumpProfile2', label: 'Jump to profile slot 2',        desc: 'Activate the profile in slot 2.' },
  { key: 'jumpProfile3', label: 'Jump to profile slot 3',        desc: 'Activate the profile in slot 3.' },
  { key: 'jumpProfile4', label: 'Jump to profile slot 4',        desc: 'Activate the profile in slot 4.' },
  { key: 'jumpProfile5', label: 'Jump to profile slot 5',        desc: 'Activate the profile in slot 5.' },
  { key: 'toggleAuto',   label: 'Toggle Auto Presence',          desc: 'Pause / resume the auto-presence engine.' },
  { key: 'showWindow',   label: 'Show / focus MultiRP window',   desc: 'Bring MultiRP to the front from anywhere.' },
  { key: 'toggleOnTop',  label: 'Toggle always-on-top overlay',  desc: 'Pin or un-pin MultiRP above other windows.' }
];

// -------- Accelerator capture --------
// Keys we never accept on their own (must be combined with a modifier)
const FORBIDDEN_BARE_KEYS = new Set([
  'Control', 'Shift', 'Alt', 'Meta', 'CapsLock', 'NumLock', 'ScrollLock',
  'OS', 'Hyper', 'Super', 'ContextMenu', 'Dead', 'Unidentified', 'Process'
]);

function eventToAccelerator(e) {
  const parts = [];
  // CommandOrControl handles both Win/Linux Ctrl and macOS Cmd
  if (e.ctrlKey || e.metaKey) parts.push('CommandOrControl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');

  let key = e.key;
  if (FORBIDDEN_BARE_KEYS.has(key)) return null; // modifier-only press
  // Map function & arrow keys to Electron's accelerator vocabulary
  if (/^F\d{1,2}$/.test(key)) {
    parts.push(key);
  } else if (key === ' ' || e.code === 'Space') {
    parts.push('Space');
  } else if (key === 'ArrowUp') parts.push('Up');
  else if (key === 'ArrowDown') parts.push('Down');
  else if (key === 'ArrowLeft') parts.push('Left');
  else if (key === 'ArrowRight') parts.push('Right');
  else if (key === 'Escape') parts.push('Escape');
  else if (key === 'Enter') parts.push('Enter');
  else if (key === 'Tab') parts.push('Tab');
  else if (key === 'Backspace') parts.push('Backspace');
  else if (key === 'Delete') parts.push('Delete');
  else if (key === 'Home') parts.push('Home');
  else if (key === 'End') parts.push('End');
  else if (key === 'PageUp') parts.push('PageUp');
  else if (key === 'PageDown') parts.push('PageDown');
  else if (key.length === 1) {
    // Letters & digits & punctuation — uppercase letters per Electron docs
    parts.push(key.length === 1 && /[a-z]/.test(key) ? key.toUpperCase() : key);
  } else {
    parts.push(key);
  }

  // Require at least one modifier for letters/digits to avoid stomping on typing.
  // Function keys, escape, etc. are fine bare.
  const modifierCount = parts.length - 1;
  const lastPart = parts[parts.length - 1];
  const isFunctionKey = /^F\d{1,2}$/.test(lastPart);
  if (modifierCount === 0 && !isFunctionKey) return null;
  return parts.join('+');
}

function findHotkeyConflicts(hotkeys) {
  // Returns { accelerator: [actionKeys, ...] } for any accelerator bound to >1 action
  const seen = {};
  for (const [k, v] of Object.entries(hotkeys || {})) {
    if (!v) continue;
    if (!seen[v]) seen[v] = [];
    seen[v].push(k);
  }
  const conflicts = {};
  for (const [accel, keys] of Object.entries(seen)) {
    if (keys.length > 1) conflicts[accel] = keys;
  }
  return conflicts;
}

function setupHotkeysUI() {
  const list = document.getElementById('hotkeyList');
  if (!list) return;

  // Render rows once; binding handlers live across renders.
  list.innerHTML = HOTKEY_DEFS.map(def => `
    <div class="hotkey-row" data-key="${def.key}">
      <div class="hotkey-row-label">
        <div class="hotkey-row-title">${def.label}</div>
        <div class="hotkey-row-desc">${def.desc}</div>
      </div>
      <button class="hotkey-bind unset" data-action="record">Click to record</button>
      <button class="hotkey-clear" data-action="clear" title="Clear shortcut">✕</button>
    </div>
  `).join('');

  list.querySelectorAll('.hotkey-row').forEach(row => {
    const key = row.getAttribute('data-key');
    const recordBtn = row.querySelector('[data-action="record"]');
    const clearBtn = row.querySelector('[data-action="clear"]');

    recordBtn.addEventListener('click', () => {
      // Avoid double-record state if user spams clicks
      if (recordBtn.classList.contains('recording')) return;
      recordBtn.classList.add('recording');
      recordBtn.textContent = 'Press a combo… (Esc to cancel)';

      const onKey = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (ev.key === 'Escape' && !ev.ctrlKey && !ev.altKey && !ev.metaKey && !ev.shiftKey) {
          cleanup();
          renderHotkeyButton(recordBtn, extState.hotkeys[key] || '');
          return;
        }
        const accel = eventToAccelerator(ev);
        if (!accel) return; // wait for a real key
        cleanup();
        const next = { ...(extState.hotkeys || {}), [key]: accel };
        persistHotkeys(next);
      };

      const cleanup = () => {
        window.removeEventListener('keydown', onKey, true);
        recordBtn.classList.remove('recording');
      };
      window.addEventListener('keydown', onKey, true);
    });

    clearBtn.addEventListener('click', () => {
      const next = { ...(extState.hotkeys || {}), [key]: '' };
      persistHotkeys(next);
    });
  });

  // Initial paint from current state — load happens in refreshExtUI() after fetch.
  loadExtSettingsIntoUI();
}

function renderHotkeyButton(btn, accel) {
  if (accel) {
    btn.textContent = accel;
    btn.classList.remove('unset');
  } else {
    btn.textContent = 'Click to record';
    btn.classList.add('unset');
  }
}

async function persistHotkeys(nextHotkeys) {
  extState.hotkeys = nextHotkeys;
  try {
    const res = await window.multirp.extSettings.set({ hotkeys: nextHotkeys });
    if (res) extState = res;
  } catch (e) {
    console.error('Failed to persist hotkeys', e);
  }
  refreshExtUI();
}

function refreshHotkeysUI() {
  const list = document.getElementById('hotkeyList');
  if (!list) return;
  const conflicts = findHotkeyConflicts(extState.hotkeys);
  list.querySelectorAll('.hotkey-row').forEach(row => {
    const key = row.getAttribute('data-key');
    const btn = row.querySelector('.hotkey-bind');
    const accel = (extState.hotkeys || {})[key] || '';
    renderHotkeyButton(btn, accel);
    if (accel && conflicts[accel]) {
      row.classList.add('conflict');
    } else {
      row.classList.remove('conflict');
    }
  });

  const banner = document.getElementById('hotkeyConflict');
  if (banner) {
    const list = Object.entries(conflicts);
    if (!list.length) {
      banner.hidden = true;
      banner.textContent = '';
    } else {
      banner.hidden = false;
      banner.textContent = list
        .map(([accel, keys]) => `${accel} is bound to multiple actions (${keys.join(', ')}). Only one will fire.`)
        .join(' ');
    }
  }
}

// -------- Idle UI --------

function setupIdleUI() {
  const onLock = document.getElementById('idleOnLock');
  const onSysIdle = document.getElementById('idleOnSystemIdle');
  const mins = document.getElementById('idleAfterMinutes');
  const sel = document.getElementById('idleProfileSelect');

  if (onLock) onLock.addEventListener('change', persistIdleFromUI);
  if (onSysIdle) onSysIdle.addEventListener('change', persistIdleFromUI);
  if (mins) mins.addEventListener('change', persistIdleFromUI);
  if (sel) sel.addEventListener('change', persistIdleFromUI);
}

async function persistIdleFromUI() {
  const onLock = document.getElementById('idleOnLock');
  const onSysIdle = document.getElementById('idleOnSystemIdle');
  const mins = document.getElementById('idleAfterMinutes');
  const sel = document.getElementById('idleProfileSelect');

  const next = {
    onLock: !!(onLock && onLock.checked),
    onSystemIdle: !!(onSysIdle && onSysIdle.checked),
    afterMinutes: Math.max(1, Math.min(240, Number(mins && mins.value) || 10)),
    idleProfileId: (sel && sel.value) || null
  };
  // Idle is enabled if any trigger is on AND we have a target profile
  next.enabled = (next.onLock || next.onSystemIdle) && !!next.idleProfileId;

  try {
    const res = await window.multirp.extSettings.set({ idle: next });
    if (res) extState = res;
  } catch (e) {
    console.error('Failed to persist idle settings', e);
  }
  refreshExtUI();
}

function refreshIdleUI() {
  const onLock = document.getElementById('idleOnLock');
  const onSysIdle = document.getElementById('idleOnSystemIdle');
  const mins = document.getElementById('idleAfterMinutes');
  const sel = document.getElementById('idleProfileSelect');
  const idle = extState.idle || {};

  if (onLock) onLock.checked = !!idle.onLock;
  if (onSysIdle) onSysIdle.checked = !!idle.onSystemIdle;
  if (mins) mins.value = Number(idle.afterMinutes) || 10;

  if (sel) {
    const profiles = (state && Array.isArray(state.profiles)) ? state.profiles : [];
    const current = idle.idleProfileId || '';
    sel.innerHTML = '<option value="">— pick a profile —</option>' +
      profiles.map(p => {
        const name = (p.name || 'Untitled').replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
        return `<option value="${p.id}"${p.id === current ? ' selected' : ''}>${name}</option>`;
      }).join('');
  }
}

// -------- Game Detection UI --------

function setupGameUI() {
  const aot = document.getElementById('alwaysOnTop');
  const aotAuto = document.getElementById('alwaysOnTopAuto');
  const autoAct = document.getElementById('gameAutoActivate');
  const addBtn = document.getElementById('addGameMapping');

  if (aot) aot.addEventListener('change', persistGameTogglesFromUI);
  if (aotAuto) aotAuto.addEventListener('change', persistGameTogglesFromUI);
  if (autoAct) autoAct.addEventListener('change', persistGameTogglesFromUI);

  if (addBtn) {
    addBtn.addEventListener('click', async () => {
      const mappings = (extState.game && Array.isArray(extState.game.mappings)) ? extState.game.mappings.slice() : [];
      mappings.push({
        id: 'g_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        exe: '',
        profileId: '',
        running: false
      });
      await persistGameMappings(mappings);
    });
  }
}

async function persistGameTogglesFromUI() {
  const aot = document.getElementById('alwaysOnTop');
  const aotAuto = document.getElementById('alwaysOnTopAuto');
  const autoAct = document.getElementById('gameAutoActivate');
  const next = {
    alwaysOnTop: !!(aot && aot.checked),
    alwaysOnTopAuto: !!(aotAuto && aotAuto.checked),
    autoActivate: !!(autoAct && autoAct.checked)
  };
  try {
    const res = await window.multirp.extSettings.set({ game: next });
    if (res) extState = res;
  } catch (e) {
    console.error('Failed to persist game toggles', e);
  }
  refreshExtUI();
}

async function persistGameMappings(mappings) {
  // Strip the volatile `running` flag — main process owns that.
  const clean = mappings.map(m => ({
    id: m.id,
    exe: (m.exe || '').trim(),
    profileId: m.profileId || ''
  }));
  try {
    const res = await window.multirp.extSettings.set({ game: { mappings: clean } });
    if (res) extState = res;
  } catch (e) {
    console.error('Failed to persist game mappings', e);
  }
  refreshExtUI();
}

function refreshGameUI() {
  const aot = document.getElementById('alwaysOnTop');
  const aotAuto = document.getElementById('alwaysOnTopAuto');
  const autoAct = document.getElementById('gameAutoActivate');
  const list = document.getElementById('gameMappingsList');
  const game = extState.game || {};

  if (aot) aot.checked = !!game.alwaysOnTop;
  if (aotAuto) aotAuto.checked = !!game.alwaysOnTopAuto;
  if (autoAct) autoAct.checked = !!game.autoActivate;

  if (!list) return;
  const mappings = Array.isArray(game.mappings) ? game.mappings : [];
  if (!mappings.length) {
    list.innerHTML = '<div class="game-mappings-empty">No tracked games yet. Click <strong>+ Add Game</strong> to start.</div>';
    return;
  }

  const profiles = (state && Array.isArray(state.profiles)) ? state.profiles : [];
  list.innerHTML = mappings.map((m, idx) => {
    const exeAttr = (m.exe || '').replace(/"/g, '&quot;');
    const dotClass = m.running ? 'game-mapping-running on' : 'game-mapping-running';
    const dotTitle = m.running ? 'Running right now' : 'Not detected';
    const profOpts = '<option value="">— pick a profile —</option>' +
      profiles.map(p => {
        const safe = (p.name || 'Untitled').replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
        return `<option value="${p.id}"${p.id === m.profileId ? ' selected' : ''}>${safe}</option>`;
      }).join('');
    return `
      <div class="game-mapping-row" data-idx="${idx}">
        <span class="${dotClass}" title="${dotTitle}"></span>
        <input type="text" class="game-mapping-name" placeholder="e.g. Genshin.exe" value="${exeAttr}" />
        <span class="game-mapping-arrow">→</span>
        <select class="game-mapping-profile">${profOpts}</select>
        <button class="game-mapping-del" title="Remove">✕</button>
      </div>
    `;
  }).join('');

  // Wire row controls
  list.querySelectorAll('.game-mapping-row').forEach(row => {
    const idx = Number(row.getAttribute('data-idx'));
    const exeInput = row.querySelector('.game-mapping-name');
    const profSel = row.querySelector('.game-mapping-profile');
    const delBtn = row.querySelector('.game-mapping-del');

    const commit = () => {
      const next = (extState.game && Array.isArray(extState.game.mappings)) ? extState.game.mappings.slice() : [];
      if (!next[idx]) return;
      next[idx] = {
        ...next[idx],
        exe: exeInput.value.trim(),
        profileId: profSel.value || ''
      };
      persistGameMappings(next);
    };
    exeInput.addEventListener('change', commit);
    profSel.addEventListener('change', commit);
    delBtn.addEventListener('click', () => {
      const next = (extState.game && Array.isArray(extState.game.mappings)) ? extState.game.mappings.slice() : [];
      next.splice(idx, 1);
      persistGameMappings(next);
    });
  });
}

// -------- Combined refresh + initial load --------

async function loadExtSettingsIntoUI() {
  try {
    const s = await window.multirp.extSettings.get();
    if (s) extState = s;
  } catch (e) {
    console.error('Failed to load ext settings', e);
  }
  refreshExtUI();
}

function refreshExtUI() {
  refreshHotkeysUI();
  refreshIdleUI();
  refreshGameUI();
}
