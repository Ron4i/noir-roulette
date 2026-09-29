import { randomUUID } from 'node:crypto';

/** Сколько живёт сессия без активности. */
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;

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
    this.micEnabled = true;
    this.camEnabled = true;
    this.reports = 0;
    this.alive = true;

    this.touch();
  }

  touch() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.close(4008, 'idle timeout');
    }, IDLE_TIMEOUT_MS);
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
}
