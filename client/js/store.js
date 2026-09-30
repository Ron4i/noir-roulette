/**
 * Локальное хранилище: настройки, статистика и история разговоров.
 * Всё живёт только в этом браузере — на сервер ничего не уходит.
 */

const SETTINGS_KEY = 'noir.settings.v1';
const STATS_KEY = 'noir.stats.v1';

const DEFAULT_SETTINGS = {
  mode: 'random',
  interests: [],
  require18Plus: false,
  region: '',
  theme: 'dark',
  mirror: true,
  tts: false,
  captions: false,
  reduceData: false,
  camDevice: '',
  micDevice: '',
  videoHeight: 720,
  fx: 'none',
};

const DEFAULT_STATS = { chats: 0, skipped: 0, reports: 0, messages: 0, seconds: 0, history: [] };

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return { ...fallback };
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? { ...fallback, ...parsed } : { ...fallback };
  } catch {
    return { ...fallback };
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* приватный режим или переполненное хранилище — не критично */
  }
}

export function loadSettings() {
  return read(SETTINGS_KEY, DEFAULT_SETTINGS);
}

export function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  write(SETTINGS_KEY, next);
  return next;
}

export function loadStats() {
  const stats = read(STATS_KEY, DEFAULT_STATS);
  stats.history = Array.isArray(stats.history) ? stats.history.slice(0, 40) : [];
  return stats;
}

export function bumpStat(key, by = 1) {
  const stats = loadStats();
  stats[key] = (stats[key] || 0) + by;
  write(STATS_KEY, stats);
  return stats;
}

export function addCall(durationSec, peerName) {
  const stats = loadStats();
  stats.chats = (stats.chats || 0) + 1;
  stats.seconds = (stats.seconds || 0) + Math.max(0, Math.round(durationSec));
  if (peerName) {
    stats.history.unshift({ name: peerName, sec: Math.round(durationSec), at: Date.now() });
    stats.history = stats.history.slice(0, 40);
  }
  write(STATS_KEY, stats);
  return stats;
}

export function resetStats() {
  write(STATS_KEY, { ...DEFAULT_STATS });
  return loadStats();
}

/** Средняя длительность разговора в минутах, либо null. */
export function averageMinutes(stats = loadStats()) {
  if (!stats.chats) return null;
  return stats.seconds / stats.chats / 60;
}
