/*
 * Copyright 2026 Alarkius Elvya Jay
 * Licensed under the Apache License, Version 2.0
 *
 * Profile interop: serializers + parsers for MultiRP's native JSON
 * and CustomRP's .crp (XML) format. Also writes Markdown / CSV / plain TXT
 * as one-way exports for sharing or documentation.
 *
 * No external XML library — CustomRP presets are flat single-level XML which
 * we can safely (de)serialize with simple regex / string ops.
 */

const FIELD_KEYS = [
  'name', 'clientId', 'activityType', 'timestampMode',
  'startTimestamp', 'endTimestamp',
  'details', 'state',
  'largeImageKey', 'largeImageText',
  'smallImageKey', 'smallImageText',
  'partyCurrent', 'partyMax',
  'button1Label', 'button1Url',
  'button2Label', 'button2Url',
  // v1.8.0 — Custom About Field. Bot tokens are NEVER exported with profiles
  // (they live encrypted in OS keychain only); aboutText travels with the
  // preset so a re-import on the same machine keeps your description intact.
  'aboutText'
];

// ---------- XML helpers (no deps) ----------
function xmlEscape(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function xmlUnescape(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function readTag(xml, tag) {
  // Self-closing form: <Tag />
  const selfClose = new RegExp(`<${tag}\\s*/>`);
  if (selfClose.test(xml)) return '';
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`);
  const m = xml.match(re);
  if (!m) return null;
  return xmlUnescape(m[1]);
}

// ---------- CustomRP <-> MultiRP mapping ----------
// CustomRP `Type` enum (from CustomRP source): 0=Playing, 2=Listening, 3=Watching, 4=Custom (n/a), 5=Competing.
// CustomRP `Timestamps` enum: 0=None, 1=Since app start, 2=Local time, 3=Custom.
// MultiRP `timestampMode`: 'none' | 'elapsed' | 'custom_start' | 'custom_range'

function crpTypeToActivityType(t) {
  const n = parseInt(t, 10);
  if (Number.isNaN(n)) return 0;
  // 0/2/3/5 are valid Discord activity types we already support.
  // 4 is CustomRP's "Custom" which doesn't map to a real Discord type — fall back to Playing.
  if (n === 4) return 0;
  return n;
}

function activityTypeToCrpType(t) {
  const n = parseInt(t, 10);
  if (Number.isNaN(n)) return 0;
  return n;
}

function crpTimestampsToMode(tsMode) {
  const n = parseInt(tsMode, 10);
  // 0=None, 1=Since launch, 2=Local time (no real equivalent — treat as elapsed),
  // 3=Custom (single timestamp)
  if (n === 1 || n === 2) return 'elapsed';
  if (n === 3) return 'custom_start';
  return 'none';
}

function modeToCrpTimestamps(mode) {
  if (mode === 'elapsed') return 1;
  if (mode === 'custom_start' || mode === 'custom_range') return 3;
  return 0;
}

// CustomRP stores CustomTimestamp as ISO local datetime ("yyyy-MM-ddTHH:mm:ss").
// MultiRP stores startTimestamp as a unix epoch in seconds (string).
function crpCustomTsToEpochSec(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return String(Math.floor(d.getTime() / 1000));
}

function epochSecToCrpCustomTs(epoch) {
  const n = parseInt(epoch, 10);
  if (!n || Number.isNaN(n)) return '';
  const d = new Date(n * 1000);
  if (Number.isNaN(d.getTime())) return '';
  // Output local-time-style ISO, no Z, no ms — matches CustomRP's format.
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ---------- Sanitizer / shape filler ----------
function sanitizeProfile(p) {
  const out = {};
  for (const k of FIELD_KEYS) {
    out[k] = p[k] === undefined || p[k] === null ? '' : p[k];
  }
  // Coerce numeric defaults
  if (typeof out.activityType !== 'number') {
    const n = parseInt(out.activityType, 10);
    out.activityType = Number.isNaN(n) ? 0 : n;
  }
  if (!out.timestampMode) out.timestampMode = 'none';
  if (!out.name) out.name = 'Imported Profile';
  return out;
}

// ---------- CRP (XML) ----------
function parseCrp(xml) {
  if (!/^[\s]*<\?xml/i.test(xml) && !/<Preset\b/i.test(xml)) {
    throw new Error('Not a CustomRP preset: missing <Preset> root.');
  }
  if (!/<Preset\b/.test(xml)) {
    throw new Error('Not a CustomRP preset: missing <Preset> root.');
  }

  const id = readTag(xml, 'ID') || '';
  const type = readTag(xml, 'Type');
  const details = readTag(xml, 'Details') || '';
  const state = readTag(xml, 'State') || '';
  const partySize = readTag(xml, 'PartySize') || '';
  const partyMax = readTag(xml, 'PartyMax') || '';
  const timestamps = readTag(xml, 'Timestamps');
  const customTs = readTag(xml, 'CustomTimestamp') || '';
  const largeKey = readTag(xml, 'LargeKey') || '';
  const largeText = readTag(xml, 'LargeText') || '';
  const smallKey = readTag(xml, 'SmallKey') || '';
  const smallText = readTag(xml, 'SmallText') || '';
  const b1t = readTag(xml, 'Button1Text') || '';
  const b1u = readTag(xml, 'Button1URL') || '';
  const b2t = readTag(xml, 'Button2Text') || '';
  const b2u = readTag(xml, 'Button2URL') || '';

  const profile = {
    name: 'Imported Preset',
    clientId: String(id || '').trim(),
    activityType: crpTypeToActivityType(type),
    timestampMode: crpTimestampsToMode(timestamps),
    startTimestamp: crpCustomTsToEpochSec(customTs),
    endTimestamp: '',
    details,
    state,
    largeImageKey: largeKey,
    largeImageText: largeText,
    smallImageKey: smallKey,
    smallImageText: smallText,
    partyCurrent: partySize === '0' ? '' : (partySize || ''),
    partyMax: partyMax === '0' ? '' : (partyMax || ''),
    button1Label: b1t,
    button1Url: b1u,
    button2Label: b2t,
    button2Url: b2u
  };
  return sanitizeProfile(profile);
}

function serializeCrp(profile) {
  const p = sanitizeProfile(profile);
  const tsMode = modeToCrpTimestamps(p.timestampMode);
  const customTs = (p.timestampMode === 'custom_start' || p.timestampMode === 'custom_range')
    ? epochSecToCrpCustomTs(p.startTimestamp)
    : '';
  const lines = [
    '<?xml version="1.0"?>',
    '<Preset xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">',
    `  <ID>${xmlEscape(p.clientId)}</ID>`,
    `  <Type>${activityTypeToCrpType(p.activityType)}</Type>`,
    `  <Details>${xmlEscape(p.details)}</Details>`,
    p.state ? `  <State>${xmlEscape(p.state)}</State>` : '  <State />',
    `  <PartySize>${parseInt(p.partyCurrent, 10) || 0}</PartySize>`,
    `  <PartyMax>${parseInt(p.partyMax, 10) || 0}</PartyMax>`,
    `  <Timestamps>${tsMode}</Timestamps>`,
    customTs ? `  <CustomTimestamp>${xmlEscape(customTs)}</CustomTimestamp>` : '  <CustomTimestamp>0001-01-01T00:00:00</CustomTimestamp>',
    p.largeImageKey ? `  <LargeKey>${xmlEscape(p.largeImageKey)}</LargeKey>` : '  <LargeKey />',
    p.largeImageText ? `  <LargeText>${xmlEscape(p.largeImageText)}</LargeText>` : '  <LargeText />',
    p.smallImageKey ? `  <SmallKey>${xmlEscape(p.smallImageKey)}</SmallKey>` : '  <SmallKey />',
    p.smallImageText ? `  <SmallText>${xmlEscape(p.smallImageText)}</SmallText>` : '  <SmallText />',
    p.button1Label ? `  <Button1Text>${xmlEscape(p.button1Label)}</Button1Text>` : '  <Button1Text />',
    p.button1Url ? `  <Button1URL>${xmlEscape(p.button1Url)}</Button1URL>` : '  <Button1URL />',
    p.button2Label ? `  <Button2Text>${xmlEscape(p.button2Label)}</Button2Text>` : '  <Button2Text />',
    p.button2Url ? `  <Button2URL>${xmlEscape(p.button2Url)}</Button2URL>` : '  <Button2URL />',
    '</Preset>'
  ];
  return lines.join('\r\n');
}

// ---------- JSON (MultiRP native) ----------
function parseJson(text) {
  const obj = JSON.parse(text);
  // Auto-detect MultiRP-native schema vs anything else.
  // MultiRP profile has 'clientId' or any FIELD_KEYS keys.
  if (!obj || typeof obj !== 'object') throw new Error('JSON is not an object.');
  return sanitizeProfile(obj);
}

function serializeJson(profile) {
  const p = sanitizeProfile(profile);
  // Strip transient id so the same export can be imported into any tab.
  // eslint-disable-next-line no-unused-vars
  const { id, ...clean } = p;
  return JSON.stringify(clean, null, 2);
}

// ---------- CSV (one row of key,value pairs) ----------
function csvEscape(v) {
  const s = v === null || v === undefined ? '' : String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function serializeCsv(profile) {
  const p = sanitizeProfile(profile);
  const headers = FIELD_KEYS;
  const row = headers.map((h) => csvEscape(p[h]));
  return headers.join(',') + '\r\n' + row.join(',') + '\r\n';
}

function parseCsv(text) {
  // Two-row CSV: header row, value row. Tolerate quoted values.
  const rows = [];
  let cur = '';
  let row = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { cur += c; }
    } else {
      if (c === '"') { inQuotes = true; }
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
      else if (c === '\r') { /* swallow */ }
      else { cur += c; }
    }
  }
  if (cur.length > 0 || row.length > 0) { row.push(cur); rows.push(row); }

  if (rows.length < 2) throw new Error('CSV needs a header row and a value row.');
  const headers = rows[0].map((h) => h.trim());
  const values = rows[1];
  const obj = {};
  headers.forEach((h, i) => { obj[h] = values[i] !== undefined ? values[i] : ''; });
  return sanitizeProfile(obj);
}

// ---------- Markdown (export-only, human readable) ----------
function serializeMarkdown(profile) {
  const p = sanitizeProfile(profile);
  const typeNames = { 0: 'Playing', 2: 'Listening', 3: 'Watching', 5: 'Competing' };
  const tsNames = {
    none: 'None',
    elapsed: 'Elapsed since activate',
    custom_start: 'Custom start time',
    custom_range: 'Custom range'
  };
  const lines = [
    `# ${p.name || 'MultiRP Profile'}`,
    '',
    `**Discord Client ID:** ${p.clientId || '_(not set)_'}`,
    `**Activity Type:** ${typeNames[p.activityType] || p.activityType}`,
    `**Timestamp Mode:** ${tsNames[p.timestampMode] || p.timestampMode}`,
    '',
    '## Status',
    `- **Details:** ${p.details || '_(empty)_'}`,
    `- **State:** ${p.state || '_(empty)_'}`,
    '',
    '## Images',
    `- **Large Image Key:** ${p.largeImageKey || '_(empty)_'}`,
    `- **Large Image Text:** ${p.largeImageText || '_(empty)_'}`,
    `- **Small Image Key:** ${p.smallImageKey || '_(empty)_'}`,
    `- **Small Image Text:** ${p.smallImageText || '_(empty)_'}`,
    '',
    '## Party',
    `- **Current:** ${p.partyCurrent || '_(empty)_'}`,
    `- **Max:** ${p.partyMax || '_(empty)_'}`,
    '',
    '## Buttons',
    `- **Button 1:** ${p.button1Label || '_(empty)_'} \u2014 ${p.button1Url || '_(no url)_'}`,
    `- **Button 2:** ${p.button2Label || '_(empty)_'} \u2014 ${p.button2Url || '_(no url)_'}`,
    '',
    '---',
    '_Exported from MultiRP \u2014 https://github.com/AlarkiusJay/MultiRPCustomizer_'
  ];
  return lines.join('\n');
}

function parseMarkdown(text) {
  // Best-effort markdown import: parse "**Field:** value" lines.
  const grab = (label) => {
    const re = new RegExp(`\\*\\*${label}\\s*:\\*\\*\\s*([^\\n]+)`, 'i');
    const m = text.match(re);
    if (!m) return '';
    let v = m[1].trim();
    if (v === '_(empty)_' || v === '_(not set)_' || v === '_(no url)_') return '';
    return v;
  };

  // Buttons line: "**Button 1:** Label — URL"
  const grabButton = (n) => {
    const re = new RegExp(`\\*\\*Button\\s*${n}\\s*:\\*\\*\\s*([^\\n]+)`, 'i');
    const m = text.match(re);
    if (!m) return { label: '', url: '' };
    const parts = m[1].split(/\s\u2014\s|\s-\s/);
    let label = (parts[0] || '').trim();
    let url = (parts[1] || '').trim();
    if (label === '_(empty)_') label = '';
    if (url === '_(no url)_') url = '';
    return { label, url };
  };

  const titleMatch = text.match(/^#\s+(.+)$/m);
  const name = titleMatch ? titleMatch[1].trim() : 'Imported Profile';

  const typeName = grab('Activity Type').toLowerCase();
  const typeMap = { playing: 0, listening: 2, watching: 3, competing: 5 };
  let activityType = 0;
  if (typeName in typeMap) activityType = typeMap[typeName];
  else { const n = parseInt(typeName, 10); if (!Number.isNaN(n)) activityType = n; }

  const tsName = grab('Timestamp Mode').toLowerCase();
  let timestampMode = 'none';
  if (tsName.includes('elapsed')) timestampMode = 'elapsed';
  else if (tsName.includes('range')) timestampMode = 'custom_range';
  else if (tsName.includes('custom')) timestampMode = 'custom_start';

  const b1 = grabButton(1);
  const b2 = grabButton(2);

  return sanitizeProfile({
    name,
    clientId: grab('Discord Client ID'),
    activityType,
    timestampMode,
    details: grab('Details'),
    state: grab('State'),
    largeImageKey: grab('Large Image Key'),
    largeImageText: grab('Large Image Text'),
    smallImageKey: grab('Small Image Key'),
    smallImageText: grab('Small Image Text'),
    partyCurrent: grab('Current'),
    partyMax: grab('Max'),
    button1Label: b1.label,
    button1Url: b1.url,
    button2Label: b2.label,
    button2Url: b2.url
  });
}

// ---------- Plain TXT (export-only) ----------
function serializeTxt(profile) {
  const p = sanitizeProfile(profile);
  const typeNames = { 0: 'Playing', 2: 'Listening', 3: 'Watching', 5: 'Competing' };
  return [
    `MultiRP Profile: ${p.name}`,
    `Discord Client ID: ${p.clientId}`,
    `Activity Type: ${typeNames[p.activityType] || p.activityType}`,
    `Timestamp Mode: ${p.timestampMode}`,
    `Details: ${p.details}`,
    `State: ${p.state}`,
    `Large Image Key: ${p.largeImageKey}`,
    `Large Image Text: ${p.largeImageText}`,
    `Small Image Key: ${p.smallImageKey}`,
    `Small Image Text: ${p.smallImageText}`,
    `Party Current: ${p.partyCurrent}`,
    `Party Max: ${p.partyMax}`,
    `Button 1: ${p.button1Label} | ${p.button1Url}`,
    `Button 2: ${p.button2Label} | ${p.button2Url}`,
    '',
    '-- Exported from MultiRP --'
  ].join('\n');
}

function parseTxt(text) {
  const grab = (label) => {
    const re = new RegExp(`^${label}\\s*:\\s*(.*)$`, 'mi');
    const m = text.match(re);
    return m ? m[1].trim() : '';
  };
  const grabButton = (n) => {
    const raw = grab(`Button ${n}`);
    const [label = '', url = ''] = raw.split('|').map((s) => s.trim());
    return { label, url };
  };

  const typeName = grab('Activity Type').toLowerCase();
  const typeMap = { playing: 0, listening: 2, watching: 3, competing: 5 };
  let activityType = 0;
  if (typeName in typeMap) activityType = typeMap[typeName];
  else { const n = parseInt(typeName, 10); if (!Number.isNaN(n)) activityType = n; }

  const b1 = grabButton(1);
  const b2 = grabButton(2);

  return sanitizeProfile({
    name: grab('MultiRP Profile') || 'Imported Profile',
    clientId: grab('Discord Client ID'),
    activityType,
    timestampMode: grab('Timestamp Mode') || 'none',
    details: grab('Details'),
    state: grab('State'),
    largeImageKey: grab('Large Image Key'),
    largeImageText: grab('Large Image Text'),
    smallImageKey: grab('Small Image Key'),
    smallImageText: grab('Small Image Text'),
    partyCurrent: grab('Party Current'),
    partyMax: grab('Party Max'),
    button1Label: b1.label,
    button1Url: b1.url,
    button2Label: b2.label,
    button2Url: b2.url
  });
}

// ---------- Format detection / dispatch ----------
function detectFormat(filePath, content) {
  const ext = (filePath || '').toLowerCase().split('.').pop();
  if (ext === 'crp' || ext === 'xml') return 'crp';
  if (ext === 'json' || ext === 'multirp') return 'json';
  if (ext === 'csv') return 'csv';
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (ext === 'txt') return 'txt';
  // Sniff content
  const trimmed = (content || '').trimStart();
  if (trimmed.startsWith('<?xml') || /<Preset\b/.test(trimmed)) return 'crp';
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'json';
  if (trimmed.startsWith('#') || /\*\*[A-Za-z]/.test(trimmed)) return 'markdown';
  if (trimmed.includes(',') && /\n/.test(trimmed)) return 'csv';
  return 'txt';
}

function importFromContent(filePath, content) {
  const fmt = detectFormat(filePath, content);
  switch (fmt) {
    case 'crp': return { profile: parseCrp(content), format: 'crp' };
    case 'json': return { profile: parseJson(content), format: 'json' };
    case 'csv': return { profile: parseCsv(content), format: 'csv' };
    case 'markdown': return { profile: parseMarkdown(content), format: 'markdown' };
    case 'txt': return { profile: parseTxt(content), format: 'txt' };
    default: throw new Error(`Unknown profile format for: ${filePath}`);
  }
}

function exportToString(profile, format) {
  switch (format) {
    case 'crp': return serializeCrp(profile);
    case 'json': return serializeJson(profile);
    case 'csv': return serializeCsv(profile);
    case 'markdown':
    case 'md': return serializeMarkdown(profile);
    case 'txt': return serializeTxt(profile);
    default: throw new Error(`Unsupported export format: ${format}`);
  }
}

function formatFromExtension(ext) {
  const e = String(ext || '').toLowerCase().replace(/^\./, '');
  if (e === 'crp' || e === 'xml') return 'crp';
  if (e === 'json' || e === 'multirp') return 'json';
  if (e === 'csv') return 'csv';
  if (e === 'md' || e === 'markdown') return 'markdown';
  if (e === 'txt') return 'txt';
  return 'json';
}

module.exports = {
  FIELD_KEYS,
  sanitizeProfile,
  parseCrp,
  serializeCrp,
  parseJson,
  serializeJson,
  parseCsv,
  serializeCsv,
  parseMarkdown,
  serializeMarkdown,
  parseTxt,
  serializeTxt,
  detectFormat,
  importFromContent,
  exportToString,
  formatFromExtension
};
