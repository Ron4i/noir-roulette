import { randomUUID } from 'node:crypto';

import { config } from './config.js';
import { isKnownTopic } from './catalog.js';

/** Набор тем, с которыми сессия реально может говорить: свои + случайные. */
function buildTopicSet(mode, interests, randomPicks) {
  const set = new Set();
  if (mode === 'interests') {
    for (const id of interests) set.add(id);
  }
  for (const id of randomPicks) {
    if (isKnownTopic(id)) set.add(id);
  }
  return set;
}

/**
 * Сессия одного участника: сокет, состояние очереди, пара, предпочтения подбора
 * и накопленная «репутация» (жалобы, качество связи, время в разговорах).
 *
 * Никаких личных данных: ни ника, ни истории переписки — только технические счётчики,
 * которые нужны для подбора и антифлуда.
 */
export class Session {
  /**
   * @param {import('ws').WebSocket} socket
   * @param {{id?: string}} [options]
   */
  constructor(socket, { id = randomUUID() } = {}) {
    this.id = id;
    this.socket = socket;
    /** @type {string|null} */
    this.peerId = null;
    /** @type {'new'|'waiting'|'matched'} */
    this.state = 'new';
    this.createdAt = Date.now();
    /** @type {number|null} */
    this.startedAt = null;

    /** Кто инициирует WebRTC-переговоры в текущей паре. */
    this.initiator = false;

    this.micEnabled = true;
    this.camEnabled = true;
    this.screenSharing = false;
    /** Собеседник поделился экраном (для бейджа «экран»). */
    this.peerScreenSharing = false;

    /** Самодекларация для фильтров подбора. Никаких проверок личности. */
    this.gender = 'any';
    this.region = null;

    /** Топология: публичный сервер → rooms, приватная сессия → private. */
    this.roomId = null;

    /** Предпочтения подбора, нормализованные в setPreferences(). */
    this.prefs = {
      mode: 'random',
      interests: [],
      topics: new Set(),
      preferGender: 'any',
      require18Plus: false,
      region: 'any',
    };
    this.declared18Plus = false;
    this.agreeToChat = true;
    /** Стартовая статистика клиента, влияет на приоритет в очереди. */
    this.statsIn = { chats: 0, skipped: 0, reportsAgainst: 0, reportsBy: 0, averageRating: 0 };

    this.reports = 0; // жалобы, отправленные этой сессией
    this.reportsAgainst = 0; // жалобы на эту сессию
    /** Качество связи последнего разговора: 0..1, null = неизвестно. */
    this.quality = null;
    this.mediaWarned = false;
    this.alive = true;

    /** @type {import('./room.js').Room|null} */
    this.room = null;

    this.touch();
  }

  /* ------------------------------------------------------------ активность */

  touch() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close(4008, 'idle timeout'), config.idleTimeoutMs);
  }

  /** @param {object} payload */
  send(payload) {
    if (this.socket.readyState !== 1 /* OPEN */) return;
    this.socket.send(JSON.stringify(payload));
  }

  close(code = 1000, reason = '') {
    this.alive = false;
    clearTimeout(this.idleTimer);
    try {
      this.socket.close(code, reason);
    } catch {
      /* socket already gone */
    }
  }

  /* --------------------------------------------------------- предпочтения */

  /**
   * Нормализует входящие предпочтения подбора. Неизвестные значения отбрасываются,
   * чтобы клиент не мог прислать серверу мусор, который сломает подбор.
   *
   * @param {object} raw
   * @param {string[]} randomPicks
   */
  setPreferences(raw = {}, randomPicks = []) {
    const interests = Array.isArray(raw.interests)
      ? raw.interests.filter(isKnownTopic).slice(0, config.interestPicksPerJoin)
      : [];

    const mode = ['interests', 'random', 'nearby', 'private'].includes(raw.mode) ? raw.mode : 'random';
    const require18Plus = raw.require18Plus === true;

    this.gender = ['any', 'male', 'female', 'other'].includes(raw.gender) ? raw.gender : 'any';
    this.region = typeof raw.region === 'string' && raw.region.length > 0 ? raw.region.slice(0, 32) : null;

    this.prefs = {
      mode,
      interests,
      topics: buildTopicSet(mode, interests, randomPicks),
      preferGender: ['any', 'male', 'female', 'other'].includes(raw.preferGender) ? raw.preferGender : 'any',
      require18Plus,
      region: this.region ?? 'any',
    };

    // Режим «рядом» и фильтр «только 18+» — оба подразумевают совершеннолетие.
    this.declared18Plus = raw.agreeToChat === true || require18Plus || mode === 'nearby';
    this.agreeToChat = raw.agreeToChat !== false;

    return this.prefs;
  }

  /** Идентификаторы тем, по которым реально идёт подбор. */
  get topicIds() {
    return [...this.prefs.topics];
  }

  /** Собирает текущие настройки для отправки клиенту (без Set). */
  prefsPayload() {
    return {
      mode: this.prefs.mode,
      interests: this.prefs.interests,
      topics: this.topicIds,
      preferGender: this.prefs.preferGender,
      require18Plus: this.prefs.require18Plus,
    };
  }

  /* ------------------------------------------------------------------ пара */

  /**
   * Совместимость двух сессий: темы, пол, возрастной фильтр и регион.
   * Используется и matchmaker'ом (подбор пары), и комнатами (гости внутри комнаты).
   *
   * @param {Session} other
   */
  compatibleWith(other) {
    const a = this.prefs;
    const b = other.prefs;

    if (a.require18Plus && !other.declared18Plus) return false;
    if (b.require18Plus && !this.declared18Plus) return false;

    if (a.preferGender !== 'any' && this.gender !== 'any' && other.gender !== 'any' && other.gender !== a.preferGender) {
      return false;
    }
    if (b.preferGender !== 'any' && other.gender !== 'any' && this.gender !== 'any' && this.gender !== b.preferGender) {
      return false;
    }

    if (a.mode === 'nearby' || b.mode === 'nearby') {
      if (!this.region || !other.region) return false;
      if (this.region !== other.region) return false;
    }

    // Пересечение тем — «мягкий» фильтр: оно обязательно, только когда обе
    // стороны явно выбрали режим интересов. Иначе темы не блокируют матч.
    if (a.mode === 'interests' && b.mode === 'interests') {
      for (const topic of a.topics) {
        if (b.topics.has(topic)) return true;
      }
      return false;
    }
    return true;
  }

  /** Метрика приоритета: меньше — раньше в очереди. Учитывает жалобы и качество связи. */
  get priority() {
    let score = this.reportsAgainst * 25;
    score += Math.max(0, 3 - (this.statsIn.chats || 0)) * 2; // новичкам — быстрее
    if (this.quality !== null && this.quality < 0.5) score += 4; // плохая связь → реже
    return score;
  }
}
