import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { WebSocketServer } from 'ws';

import { config, ROOT, readVersion } from './config.js';
import { TOPICS, REPORT_REASONS, isKnownTopic } from './catalog.js';
import { Session } from './session.js';
import { Matchmaker } from './room.js';
import { RoomRegistry } from './rooms.js';
import { Moderation } from './moderation.js';

const { iceServers: ICE_SERVERS } = config;

/** @type {Map<string, Session>} */
const sessions = new Map();
const moderation = new Moderation();

/* ------------------------------------------------------------- псевдонимы */

/**
 * Стабильный цвет-алиас для соседа — единственное, что о нём известно.
 * Имя выводится из цвета, чтобы в интерфейсе не было никаких настоящих ников.
 */
const COLORS = [
  'янтарный', 'багровый', 'лазурный', 'изумрудный', 'фиолетовый',
  'бирюзовый', 'обсидиан', 'медный', 'малиновый', 'нефритовый',
  'индиговый', 'оливковый', 'титановый', 'коралловый',
];
const ADJ = ['Тихий', 'Быстрый', 'Ночной', 'Дальний', 'Тихий', 'Смелый', 'Мягкий', 'Ясный'];
const NOUN = ['Странник', 'Сигнал', 'Контур', 'Импульс', 'Эхо', 'Комета', 'Вихрь', 'Пульс'];

function colorFor(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  const name = COLORS[hash % COLORS.length];
  const hue = hash % 360;
  const label = `${ADJ[hash % ADJ.length]} ${NOUN[(hash >> 3) % NOUN.length]}`;
  return { name, hue, label };
}

/* ------------------------------------------------------------- matchmaker */

const matchmaker = new Matchmaker({
  onMatch(a, b) {
    if (!a.alive || !b.alive) return;
    for (const [self, peer] of [
      [a, b],
      [b, a],
    ]) {
      self.send({
        type: 'match',
        initiator: self.initiator,
        peer: { color: colorFor(peer.id), topics: peer.topicIds.slice(0, 6) },
        iceServers: ICE_SERVERS,
        at: Date.now(),
      });
    }
    startMediaWatchdog(a, b);
    broadcastStats();
  },
});

const roomRegistry = new RoomRegistry();

/* ------------------------------------------------------------- утилиты */

function log(...args) {
  const time = new Date().toISOString().slice(11, 19);
  console.log(`[${time}]`, ...args);
}

function peerOf(session) {
  return session.peerId ? sessions.get(session.peerId) : undefined;
}

/** Разорвать пару: обоим сообщаем, что разговор окончен. */
function breakPair(session, { reason, notifyPeer = true } = {}) {
  const peer = peerOf(session);
  session.peerId = null;
  session.startedAt = null;
  session.initiator = false;
  if (peer) {
    peer.peerId = null;
    peer.startedAt = null;
    peer.initiator = false;
    peer.state = 'new';
    if (notifyPeer && peer.alive) peer.send({ type: 'peer:left', reason });
  }
  broadcastStats();
}

/** Разорвать все пары внутри комнаты (гость ушёл). */
function breakRoomPairs(session, reason) {
  const room = session.room;
  if (!room) return;
  for (const guest of room.guests) {
    if (guest.peer && guest.peer.room === room) breakPair(guest, { reason });
  }
  room.leave(session);
  roomRegistry.maybeDispose(room);
  if (room.guests.size > 0) {
    for (const guest of room.guests) {
      guest.send({ type: 'room:peer:left', room: room.id, leftId: session.id });
    }
  }
}

/** Таймер: если после матча не пришли медиатреки — предупреждаем и разрываем. */
function startMediaWatchdog(a, b) {
  const timer = setTimeout(() => {
    const noVideo = (s) => s.peerId && !s.receivedRemoteMedia;
    if (noVideo(a) || noVideo(b)) {
      log(`! медиа не пошло в паре ${a.id.slice(0, 4)}-${b.id.slice(0, 4)}`);
      for (const s of [a, b]) if (s.peerId) s.send({ type: 'peer:lost', reason: 'no_media' });
      if (a.peerId) breakPair(a, { reason: 'no_media' });
    }
  }, config.mediaTimeoutMs);
  timer.unref?.();
}

function broadcastStats() {
  const payload = JSON.stringify({
    type: 'stats',
    online: sessions.size,
    waiting: matchmaker.size,
    chats: Math.floor(sessions.size / 2),
    rooms: roomRegistry.size,
    topics: matchmaker.liveTopics().slice(0, 8),
  });
  for (const session of sessions.values()) {
    if (session.socket.readyState === 1) session.socket.send(payload);
  }
}

/* ------------------------------------------------------------- rate limit */

function rateLimitOk(session, kind) {
  const limit = config.chatRate;
  const now = Date.now();
  session.rate = session.rate || {};
  const bucket = session.rate[kind];
  if (!bucket || now > bucket.reset) {
    session.rate[kind] = { count: 1, reset: now + limit.windowMs };
    return true;
  }
  bucket.count += 1;
  return bucket.count <= limit.limit;
}

function sanitize(text) {
  return String(text ?? '')
    .split('')
    // Выкидываем управляющие символы (CR/LF тоже): сообщение остаётся одной строкой.
    .filter((ch) => ch.codePointAt(0) > 0x1f && ch.codePointAt(0) !== 0x7f)
    .join('')
    .trim()
    .slice(0, config.maxMessageChars);
}

/* ------------------------------------------------------------------ HTTP */

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, version: readVersion(), uptime: Math.round(process.uptime()) });
});

app.get('/api/stats', (_req, res) => {
  res.json({
    online: sessions.size,
    waiting: matchmaker.size,
    rooms: roomRegistry.catalog(),
    moderation: moderation.snapshot(),
    topics: matchmaker.liveTopics(),
  });
});

app.get('/api/catalog', (_req, res) => {
  res.json({
    topics: TOPICS,
    reasons: Object.fromEntries(Object.entries(REPORT_REASONS).map(([k, v]) => [k, v.label])),
    maxMessageChars: config.maxMessageChars,
    minMessageChars: config.minMessageChars,
  });
});

app.get('/api/config', (_req, res) => {
  res.json({
    iceServers: ICE_SERVERS,
    maxMessageChars: config.maxMessageChars,
    minMessageChars: config.minMessageChars,
    version: readVersion(),
    accessMode: config.accessMode,
    features: { tts: true, screenShare: true, rooms: true, randomTopics: true },
  });
});

const CLIENT_DIR = path.join(ROOT, config.isProd ? 'dist' : 'client');

/** Клиент целиком отдаётся с одного пути — того, который собрал Vite. */
app.use(express.static(CLIENT_DIR, { index: false, maxAge: config.isProd ? '1h' : 0 }));
app.get('/', (_req, res) => {
  res.sendFile(path.join(CLIENT_DIR, 'index.html'));
});
app.get(/^\/(css|js|assets)\//, (_req, res) => {
  res
    .status(404)
    .type('text/plain')
    .send(config.isProd
      ? 'Клиент не собран: выполните npm run build'
      : 'Клиент запускается Vite: откройте http://localhost:5173');
});

/* ---------------------------------------------------------- WebSocket */

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

wss.on('connection', (socket, req) => {
  const session = new Session(socket);
  // Лучший публичный IP из заголовка прокси (для IP-бана). За обратным прокси
  // без доверия к XFF это даёт адрес прокси, поэтому берём первый публичный хост.
  const fwd = req.headers['x-forwarded-for'];
  session.ip = (typeof fwd === 'string' ? fwd.split(',')[0] : req.socket.remoteAddress || '').trim() || 'unknown';

  // Бан проверяем до регистрации в сессиях.
  const ban = moderation.banStatus(session);
  if (ban.banned) {
    session.send({ type: 'banned', reason: ban.reason, until: ban.until, permanent: ban.permanent });
    session.close(4003, 'banned');
    return;
  }

  sessions.set(session.id, session);
  log(`+ сессия ${session.id.slice(0, 8)} (${sessions.size} онлайн)`);

  session.send({
    type: 'ready',
    sessionId: session.id,
    iceServers: ICE_SERVERS,
    online: sessions.size,
    waiting: matchmaker.size,
    maxMessageChars: config.maxMessageChars,
    minMessageChars: config.minMessageChars,
    accessMode: config.accessMode,
    version: readVersion(),
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
    if (session.room) breakRoomPairs(session, 'left');
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
      if (session.prefs.mode === 'private') {
        session.send({ type: 'error', code: 'private_mode' });
        return;
      }
      // Настройки подбора и случайные «живые» темы.
      const randomPicks = matchmaker.randomActiveTopics();
      session.enteredQueueAt = Date.now();
      session.setPreferences(message.prefs || {}, randomPicks);
      session.send({ type: 'queue:joined', prefs: session.prefsPayload() });

      if (!matchmaker.add(session)) {
        session.send({ type: 'queue:waiting', position: matchmaker.size, online: sessions.size });
        broadcastStats();
      }
      break;
    }

    case 'queue:next': {
      // «Далее»: разрываем текущую пару и сразу ищем нового.
      breakPair(session, { reason: 'skipped' });
      session.state = 'new';
      session.statsIn = { ...session.statsIn, skipped: (session.statsIn.skipped || 0) + 1 };
      const randomPicks = matchmaker.randomActiveTopics();
      session.enteredQueueAt = Date.now();
      // Настройки подбора клиент шлёт на каждый вход; сервер лишь переподмешивает
      // случайные темы, поэтому прошлая нормализация годится как база.
      session.setPreferences(message.prefs || session.prefsPayload(), randomPicks);
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

    case 'prefs': {
      // Обновляем настройки подбора «на лету» (меню настроек).
      const randomPicks = matchmaker.randomActiveTopics();
      const prefs = session.setPreferences(message.prefs || {}, randomPicks);
      session.send({ type: 'prefs:updated', prefs, topics: matchmaker.liveTopics().slice(0, 12) });
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
      if (typeof message.screen === 'boolean') session.screenSharing = message.screen;
      peer?.send({
        type: 'media:state',
        mic: session.micEnabled,
        cam: session.camEnabled,
        screen: session.screenSharing,
      });
      break;
    }

    case 'media:ready': {
      // Клиент сообщил, что у него есть хотя бы один живой трек.
      session.receivedRemoteMedia = true;
      break;
    }

    case 'stats:report': {
      // Клиент отправляет локальную телеметрию связи (для приоритета и профиля).
      if (message.quality !== undefined) {
        const q = Math.max(0, Math.min(1, Number(message.quality) || 0));
        session.quality = q;
      }
      if (message.peerId && peerOf(session)?.id === message.peerId) {
        peerOf(session).quality = session.quality;
      }
      break;
    }

    case 'chat': {
      if (!peer) return;
      if (moderation.isMuted(session)) {
        session.send({ type: 'error', code: 'muted' });
        return;
      }
      if (!rateLimitOk(session, 'chat')) {
        session.send({ type: 'error', code: 'rate_limited' });
        return;
      }
      const text = sanitize(message.text);
      if (!text) return;
      peer.send({ type: 'chat', text, at: Date.now() });
      break;
    }

    case 'room:create': {
      const room = roomRegistry.create(session, {
        title: message.title,
        topic: isKnownTopic(message.topic) ? message.topic : 'justchat',
        isPublic: message.isPublic !== false,
      });
      room.join(session);
      session.roomId = room.id;
      session.send({ type: 'room:joined', room: { id: room.id, title: room.title, topic: room.topic, guests: room.size, max: config.maxRoomGuests }, self: true });
      broadcastStats();
      break;
    }

    case 'room:join': {
      const room = roomRegistry.get(String(message.room || ''));
      if (!room) {
        session.send({ type: 'error', code: 'room_not_found' });
        return;
      }
      if (room.isFull) {
        session.send({ type: 'error', code: 'room_full' });
        return;
      }
      room.join(session);
      session.roomId = room.id;
      session.send({ type: 'room:joined', room: { id: room.id, title: room.title, topic: room.topic, guests: room.size, max: config.maxRoomGuests } });
      // Уведомляем остальных и рассылаем историю.
      for (const guest of room.guests) {
        if (guest !== session) guest.send({ type: 'room:peer:joined', room: room.id, peer: { id: session.id, color: colorFor(session.id) } });
      }
      broadcastStats();
      break;
    }

    case 'room:leave': {
      if (session.room) breakRoomPairs(session, 'left');
      session.send({ type: 'room:left' });
      broadcastStats();
      break;
    }

    case 'room:chat': {
      const room = session.room;
      if (!room || !room.has(session)) return;
      if (moderation.isMuted(session)) {
        session.send({ type: 'error', code: 'muted' });
        return;
      }
      if (!rateLimitOk(session, 'chat')) {
        session.send({ type: 'error', code: 'rate_limited' });
        return;
      }
      const text = sanitize(message.text);
      if (!text) return;
      roomRegistry.broadcast(room, { color: colorFor(session.id) }, text);
      break;
    }

    case 'room:invite': {
      const room = session.room;
      if (!room) return;
      const peer = peerOf(session);
      if (peer && peer.alive) {
        peer.send({ type: 'room:invite', room: { id: room.id, title: room.title, topic: room.topic } });
        session.send({ type: 'room:invited', to: colorFor(peer.id).name });
      }
      break;
    }

    case 'report': {
      if (!peer) return;
      const reason = sanitize(message.reason) || 'unspecified';
      const outcome = moderation.recordReport(peer, reason);
      peer.reportsAgainst += 1;
      session.reports += 1;
      log(`! жалоба: ${session.id.slice(0, 8)} на ${peer.id.slice(0, 8)} — ${reason}`);

      session.send({ type: 'report:accepted', banned: outcome.banned });

      // Разрыв соединения — немедленный. Если сработал бан — сообщаем и виновнику,
      // и жертве жалобы (report:accepted выше уже подтвердил приём).
      if (outcome.banned) {
        peer.send({ type: 'banned', reason, until: outcome.until, permanent: false });
      }
      if (peer) {
        peer.peerId = null;
        peer.startedAt = null;
        peer.initiator = false;
        peer.state = 'new';
        peer.send({ type: 'peer:left', reason: 'reported' });
      }
      session.peerId = null;
      session.startedAt = null;
      session.initiator = false;
      session.state = 'new';
      session.send({ type: 'peer:left', reason: 'reported' });
      broadcastStats();
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

/* ------------------------------------------------------------- heartbeat */

// Рвём «мёртвые» соединения, чтобы очередь не копила призраков.
const heartbeat = setInterval(() => {
  for (const session of sessions.values()) {
    if (session.socket.readyState !== 1) continue;
    try {
      session.socket.ping();
    } catch {
      session.close(1011, 'ping failed');
    }
  }
}, config.heartbeatMs);

wss.on('close', () => clearInterval(heartbeat));

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `\n[ошибка] Порт ${config.port} уже занят.\n` +
        '         Остановите процесс на этом порту или запустите с другим портом: PORT=3002 npm start\n',
    );
    process.exit(1);
  }
  throw err;
});

server.listen(config.port, config.host, () => {
  log(`Noir Roulette — сервер слушает http://localhost:${config.port}`);
  if (!config.isProd) log('режим разработки: фронтенд → http://localhost:5173');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log('останавливаюсь…');
    clearInterval(heartbeat);
    for (const session of sessions.values()) session.close(1001, 'server shutdown');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
