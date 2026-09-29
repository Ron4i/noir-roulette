import { toast } from './dom.js';

const RECONNECT_STEPS = [0, 1200, 3000, 6000, 10_000, 15_000];

/**
 * Обёртка над WebSocket: автопереподключение, очередь исходящих,
 * аппаратный пинг и колбэки по всем серверным сообщениям.
 */
export class Signaling extends EventTarget {
  constructor(url = defaultUrl()) {
    super();
    this.url = url;
    this.ws = null;
    this.attempt = 0;
    this.queue = [];
    this.closedByUser = false;
    this.heartbeat = null;
  }

  connect() {
    this.closedByUser = false;
    this.#open();
  }

  #open() {
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;
    this.emit('status', { state: 'connecting' });

    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.#scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.attempt = 0;
      this.emit('status', { state: 'open' });
      for (const payload of this.queue.splice(0)) ws.send(JSON.stringify(payload));
      this.#startHeartbeat();
    });

    ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg?.type) this.emit(msg.type, msg);
      this.emit('*', msg);
    });

    ws.addEventListener('close', () => {
      this.#stopHeartbeat();
      this.emit('status', { state: 'closed' });
      if (!this.closedByUser) this.#scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      this.emit('status', { state: 'error' });
    });
  }

  #scheduleReconnect() {
    const delay = RECONNECT_STEPS[Math.min(this.attempt, RECONNECT_STEPS.length - 1)];
    this.attempt += 1;
    if (this.attempt > 1 && this.attempt <= 3) {
      toast('Связь с сервером потеряна, переподключаемся…', { tone: 'warn' });
    }
    this.emit('status', { state: 'reconnecting', in: delay });
    setTimeout(() => {
      if (!this.closedByUser) this.#open();
    }, delay);
  }

  #startHeartbeat() {
    this.#stopHeartbeat();
    this.heartbeat = setInterval(() => this.send({ type: 'ping' }), 20_000);
  }

  #stopHeartbeat() {
    clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  send(payload) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    } else if (payload.type !== 'ping') {
      this.queue.push(payload);
      if (this.queue.length > 32) this.queue.shift();
    }
  }

  close() {
    this.closedByUser = true;
    this.#stopHeartbeat();
    this.ws?.close(1000, 'bye');
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  on(type, handler) {
    this.addEventListener(type, (e) => handler(e.detail));
  }
}

function defaultUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}
