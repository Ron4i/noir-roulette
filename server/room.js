import { config } from './config.js';
import { TOPICS } from './catalog.js';

/**
 * Очередь ожидания. Подбирает пару «совместимых + похожих по приоритету» участников.
 * Ник, пол и город не хранятся и не участвуют в подборе — только факт ожидания
 * и технические предпочтения (темы, возрастной фильтр, регион «рядом»).
 */
export class Matchmaker {
  constructor({ onMatch } = {}) {
    /** @type {Set<import('./session.js').Session>} */
    this.waiting = new Set();
    this.onMatch = onMatch || (() => {});
  }

  get size() {
    return this.waiting.size;
  }

  /**
   * @param {import('./session.js').Session} session
   * @returns {import('./session.js').Session[]|null} пара [уже ожидавший, только что пришедший]
   */
  add(session) {
    if (session.peerId) {
      return [session, session];
    }

    // Приводим время ожидания к общему виду: сначала ищем строго совместимого кандидата,
    // затем — с запасом по приоритету, чтобы не давать «лучшему» ждать вечно.
    const exact = this.pick(session, true);
    const partner = exact ?? this.pick(session, false);

    if (!partner) {
      this.waiting.add(session);
      session.state = 'waiting';
      return null;
    }

    this.waiting.delete(partner);
    return this.connect(partner, session);
  }

  /**
   * Ищет кандидата среди ожидающих.
   * @param {import('./session.js').Session} session
   * @param {boolean} strictPriority строгое совпадение bucket'а приоритета
   * @returns {import('./session.js').Session|null}
   */
  pick(session, strictPriority) {
    const myBucket = Math.floor(session.priority / 10);
    let best = null;
    let bestWait = -1;

    for (const candidate of this.waiting) {
      if (candidate === session || !candidate.alive || candidate.peerId) continue;
      if (!session.compatibleWith(candidate)) continue;
      if (strictPriority && Math.floor(candidate.priority / 10) !== myBucket) continue;

      const waited = Date.now() - (candidate.enteredQueueAt || Date.now());
      if (waited > bestWait) {
        bestWait = waited;
        best = candidate;
      }
    }
    return best;
  }

  /**
   * @param {import('./session.js').Session} a
   * @param {import('./session.js').Session} b
   */
  connect(a, b) {
    a.peerId = b.id;
    b.peerId = a.id;
    a.state = 'matched';
    b.state = 'matched';
    a.startedAt = Date.now();
    b.startedAt = Date.now();
    // Роль инициатора решается монеткой: обе стороны одинаково готовы к offer.
    a.initiator = Math.random() < 0.5;
    b.initiator = !a.initiator;
    this.onMatch(a, b);
    return [a, b];
  }

  /** Убрать сессию из очереди (например, при отключении). */
  remove(session) {
    this.waiting.delete(session);
  }

  /** Очередь по темам для показа «кого можно выбрать прямо сейчас». */
  liveTopics() {
    const counts = new Map();
    for (const session of this.waiting) {
      for (const topic of session.prefs.topics) {
        counts.set(topic, (counts.get(topic) || 0) + 1);
      }
    }
    return TOPICS.map((t) => ({ ...t, waiting: counts.get(t.id) || 0 }))
      .filter((t) => t.waiting > 0)
      .sort((a, b) => b.waiting - a.waiting);
  }

  /**
   * Подбирает случайный набор тем, в которых сейчас кто-то ждёт.
   * Используется, чтобы «случайная» очередь тоже ощущалась живой.
   */
  randomActiveTopics(count = config.randomSuggestions) {
    const live = this.liveTopics();
    if (live.length === 0) return [];
    const pool = [...live];
    const picked = [];
    while (picked.length < Math.min(count, pool.length)) {
      picked.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0].id);
    }
    return picked;
  }
}
