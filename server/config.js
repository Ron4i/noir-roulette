/**
 * Конфигурация сервера из переменных окружения.
 * Ничего не валидируется «на входе» — только читается и нормализуется,
 * чтобы поведение дефолтов было явным.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

const num = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/** Публичные STUN по умолчанию. TURN для продакшена задаётся через ICE_SERVERS (JSON). */
const DEFAULT_ICE_SERVERS = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];

function readIceServers() {
  const raw = process.env.ICE_SERVERS;
  if (!raw) return DEFAULT_ICE_SERVERS;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : DEFAULT_ICE_SERVERS;
  } catch {
    console.warn('[warn] ICE_SERVERS невалидный JSON, используются STUN по умолчанию');
    return DEFAULT_ICE_SERVERS;
  }
}

export const config = {
  port: num(process.env.PORT, 3001),
  host: process.env.HOST || '0.0.0.0',
  isProd: process.env.NODE_ENV === 'production',

  iceServers: readIceServers(),

  /** Сколько живёт сессия без входящей активности. */
  idleTimeoutMs: num(process.env.IDLE_TIMEOUT_MS, 10 * 60 * 1000),
  /** Как часто пинговать сокеты, чтобы в очереди не копились «призраки». */
  heartbeatMs: num(process.env.HEARTBEAT_MS, 30_000),

  /** Жёсткий лимит символов в одном сообщении. */
  maxMessageChars: num(process.env.MAX_MESSAGE_CHARS, 500),
  /** Сколько текста пропускает клиент на ввод (мягче серверного лимита). */
  minMessageChars: 6,
  /** Окно и лимит чата: короткое окно, чтобы флуд обрывался быстро. */
  chatRate: { limit: num(process.env.CHAT_RATE_LIMIT, 14), windowMs: num(process.env.CHAT_RATE_WINDOW_MS, 10_000) },
  /** Лимит на попытки перебора тем в одной очереди. */
  interestPicksPerJoin: num(process.env.INTEREST_PICKS_PER_JOIN, 3),
  /** Сколько случайных людей подсовывать в «случайную очередь». */
  randomSuggestions: num(process.env.RANDOM_SUGGESTIONS, 3),

  /** Предупреждать, если у собеседника не зарегистрировался ни один медиатрек. */
  mediaTimeoutMs: num(process.env.MEDIA_TIMEOUT_MS, 12_000),
  /** Максимум жалоб до временного бана. */
  banThreshold: num(process.env.BAN_THRESHOLD, 3),
  /** Длительность бана после достижения порога. */
  banDurationMs: num(process.env.BAN_DURATION_MS, 30 * 60 * 1000),
  /** Сколько секунд тишины в чате считается «красным флагом». */
  inactivityWarnMs: num(process.env.INACTIVITY_WARN_MS, 25_000),

  /** Максимум гостей в комнате. */
  maxRoomGuests: num(process.env.MAX_ROOM_GUESTS, 8),
  /** Сколько последних матчей и сообщений помнит сервер в рамках сессии. */
  maxRetainedEvents: num(process.env.MAX_RETAINED_EVENTS, 200),

  /**
   * Политика допуска: 'open' — любой, 'adult' — только 18+.
   * Проверка основана на самодекларации, поэтому режим adult — не гарантия,
   * а лишь фильтр верхнего уровня поверх очереди «только взрослые».
   */
  accessMode: process.env.ACCESS_MODE === 'adult' ? 'adult' : 'open',
};

export function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
}
