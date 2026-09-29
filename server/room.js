/**
 * Очередь ожидания: ищем случайную пару «в очереди + в очереди».
 * Ник, пол и город не хранятся и не участвуют в подборе — только факт ожидания.
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

    let partner = null;
    for (const candidate of this.waiting) {
      this.waiting.delete(candidate);
      if (candidate !== session && candidate.alive && !candidate.peerId) {
        partner = candidate;
        break;
      }
    }

    if (!partner) {
      this.waiting.add(session);
      session.state = 'waiting';
      return null;
    }

    return this.connect(partner, session);
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
    this.onMatch(a, b);
    return [a, b];
  }

  /** Убрать сессию из очереди (например, при отключении). */
  remove(session) {
    this.waiting.delete(session);
  }
}
