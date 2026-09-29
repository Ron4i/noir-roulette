import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { randomBytes } from 'node:crypto';

import { Session } from './session.js';
import { Matchmaker } from './room.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const PORT = Number(process.env.PORT || 3001);
const HOST = process.env.HOST || '0.0.0.0';
const IS_PROD = process.env.NODE_ENV === 'production';

/** Публичные STUN-серверы. TURN для продакшена задаётся через ICE_SERVERS (JSON). */
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

const ICE_SERVERS = readIceServers();
const MAX_MESSAGE_CHARS = 500;
const CHAT_RATE = { limit: 12, windowMs: 10_000 };

/** @type {Map<string, Session>} */
const sessions = new Map();

const matchmaker = new Matchmaker({
  onMatch(a, b) {
    // Проверяем, что оба ещё живы на момент матчинга.
    if (!a.alive || !b.alive) return;

    const aInitiator = randomBytes(1)[0] % 2 === 0;
    for (const [self, peer, initiator] of [
      [a, b, aInitiator],
      [b, a, !aInitiator],
    ]) {
      self.send({
        type: 'match',
        initiator,
        peer: { color: colorFor(peer.id) },
        iceServers: ICE_SERVERS,
        at: Date.now(),
      });
    }
    broadcastStats();
  },
});

/** Стабильный псевдоним цвета для соседа — единственное, что о нём известно. */
const COLORS = [
  'янтарный',
  'багровый',
  'лазурный',
  'изумрудный',
  'фиолетовый',
  'бирюзовый',
  'обсидиан',
  'медный',
];
function colorFor(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return { name: COLORS[hash % COLORS.length], hue: hash % 360 };
}

function broadcastStats() {
  const payload = JSON.stringify({
    type: 'stats',
    online: sessions.size,
    waiting: matchmaker.size,
    chats: Math.floor(sessions.size / 2),
  });
  for (const session of sessions.values()) {
    if (session.socket.readyState === 1) session.socket.send(payload);
  }
}

function rateLimitOk(session) {
  const now = Date.now();
  session.rate = session.rate || { count: 0, reset: now + CHAT_RATE.windowMs };
  if (now > session.rate.reset) {
    session.rate = { count: 0, reset: now + CHAT_RATE.windowMs };
  }
  session.rate.count += 1;
  return session.rate.count <= CHAT_RATE.limit;
}

function sanitize(text) {
  return String(text ?? '')
    .split('')
    // Выкидываем управляющие символы (CR/LF тоже): сообщение остаётся одной строкой.
    .filter((ch) => ch.codePointAt(0) > 0x1f && ch.codePointAt(0) !== 0x7f)
    .join('')
    .trim()
    .slice(0, MAX_MESSAGE_CHARS);
}

function peerOf(session) {
  return session.peerId ? sessions.get(session.peerId) : undefined;
}

/** Разорвать пару: обоим сообщаем, что разговор окончен. */
function breakPair(session, { reason, notifyPeer = true } = {}) {
  const peer = peerOf(session);
  session.peerId = null;
  session.startedAt = null;
  if (peer) {
    peer.peerId = null;
    peer.startedAt = null;
    peer.state = 'new';
    if (notifyPeer && peer.alive) {
      peer.send({ type: 'peer:left', reason });
    }
  }
  broadcastStats();
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, version: readVersion(), uptime: Math.round(process.uptime()) });
});

app.get('/api/stats', (_req, res) => {
  res.json({ online: sessions.size, waiting: matchmaker.size });
});

app.get('/api/config', (_req, res) => {
  res.json({
    iceServers: ICE_SERVERS,
    maxMessageChars: MAX_MESSAGE_CHARS,
    version: readVersion(),
    beta: true,
  });
});

const CLIENT_DIR = path.join(ROOT, IS_PROD ? 'dist' : 'client');

/** Клиент целиком отдаётся с одного пути — того, который собрал Vite. */
app.use(express.static(CLIENT_DIR, { index: false, maxAge: IS_PROD ? '1h' : 0 }));
app.get('/', (_req, res) => {
  res.sendFile(path.join(CLIENT_DIR, 'index.html'));
});
app.get(/^\/(css|js|assets)\//, (_req, res) => {
  res
    .status(404)
    .type('text/plain')
    .send(IS_PROD
      ? 'Клиент не собран: выполните npm run build'
      : 'Клиент запускается Vite: откройте http://localhost:5173');
});

function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

wss.on('connection', (socket) => {
  const session = new Session(socket);
  sessions.set(session.id, session);
  log(`+ сессия ${session.id.slice(0, 8)} (${sessions.size} онлайн)`);

  session.send({
    type: 'ready',
    sessionId: session.id,
    iceServers: ICE_SERVERS,
    online: sessions.size,
    waiting: matchmaker.size,
    maxMessageChars: MAX_MESSAGE_CHARS,
  });
  broadcastStats();

  socket.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      session.send({ type: 'error', code: 'bad_json' });
      return;
    }
    handleMessage(session, message);
  });

  socket.on('pong', () => session.touch());

  socket.on('close', () => {
    const wasWaiting = session.state === 'waiting';
    matchmaker.remove(session);
    breakPair(session, { reason: 'peer_disconnected' });
    sessions.delete(session.id);
    broadcastStats();
    log(`- сессия ${session.id.slice(0, 8)} (${sessions.size} онлайн)${wasWaiting ? ' [снимаем с ожидания]' : ''}`);
  });

  socket.on('error', () => {
    /* закрытие обработает 'close' */
  });
});

function handleMessage(session, message) {
  session.touch();
  const peer = peerOf(session);

  switch (message?.type) {
    case 'ping':
      session.send({ type: 'pong', at: Date.now() });
      break;

    case 'queue:join': {
      if (session.peerId) {
        session.send({ type: 'error', code: 'already_matched' });
        return;
      }
      if (!matchmaker.add(session)) {
        session.send({ type: 'queue:waiting', position: matchmaker.size, online: sessions.size });
        broadcastStats();
      }
      break;
    }

    case 'queue:next': {
      // «Далее»: разрываем текущую пару и сразу ищем новую.
      breakPair(session, { reason: 'skipped' });
      session.state = 'new';
      if (!matchmaker.add(session)) {
        session.send({ type: 'queue:waiting', position: matchmaker.size, online: sessions.size });
        broadcastStats();
      }
      break;
    }

    case 'queue:leave': {
      matchmaker.remove(session);
      session.state = 'new';
      session.send({ type: 'queue:left' });
      broadcastStats();
      break;
    }

    case 'signal': {
      if (!peer) {
        session.send({ type: 'error', code: 'no_peer' });
        return;
      }
      // Проксируем SDP/ICE без изменений, но валидируем форму.
      if (!['offer', 'answer', 'ice'].includes(message.data?.kind)) {
        session.send({ type: 'error', code: 'bad_signal' });
        return;
      }
      peer.send({ type: 'signal', data: message.data });
      break;
    }

    case 'media:state': {
      if (typeof message.mic === 'boolean') session.micEnabled = message.mic;
      if (typeof message.cam === 'boolean') session.camEnabled = message.cam;
      peer?.send({ type: 'media:state', mic: session.micEnabled, cam: session.camEnabled });
      break;
    }

    case 'chat': {
      if (!peer) return;
      if (!rateLimitOk(session)) {
        session.send({ type: 'error', code: 'rate_limited' });
        return;
      }
      const text = sanitize(message.text);
      if (!text) return;
      peer.send({ type: 'chat', text, at: Date.now() });
      break;
    }

    case 'report': {
      if (!peer) return;
      peer.reports += 1;
      session.reports += 1;
      const reason = sanitize(message.reason) || 'unspecified';
      log(`! жалоба: сессия ${session.id.slice(0, 8)} на ${peer.id.slice(0, 8)} — ${reason}`);
      session.send({ type: 'report:accepted' });
      // В бете разрыв соединения — единственная доступная модерация.
      breakPair(peer, { reason: 'reported' });
      breakPair(session, { reason: 'reported' });
      break;
    }

    case 'bye': {
      breakPair(session, { reason: 'left' });
      break;
    }

    default:
      session.send({ type: 'error', code: 'unknown_type' });
  }
}

// Heartbeat: рвём «мёртвые» соединения, чтобы очередь не копила призраков.
const heartbeat = setInterval(() => {
  for (const session of sessions.values()) {
    if (session.socket.readyState !== 1) continue;
    try {
      session.socket.ping();
    } catch {
      session.close(1011, 'ping failed');
    }
  }
}, 30_000);

wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, HOST, () => {
  log(`Noir Roulette beta — сервер слушает http://localhost:${PORT}`);
  if (!IS_PROD) log('режим разработки: фронтенд → http://localhost:5173');
});

function log(...args) {
  const time = new Date().toISOString().slice(11, 19);
  console.log(`[${time}]`, ...args);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log('останавливаюсь…');
    clearInterval(heartbeat);
    for (const session of sessions.values()) session.close(1001, 'server shutdown');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
