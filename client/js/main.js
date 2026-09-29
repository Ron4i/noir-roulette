import { $, setIcon, toast } from './dom.js';
import { Signaling } from './signaling.js';
import { Peer } from './rtc.js';
import { getUserMedia, mediaErrorText, stopStream, toggleTrack } from './media.js';

const el = {
  body: document.body,
  intro: $('introPanel'),
  search: $('searchPanel'),
  queueSize: $('queueSize'),
  videoFrame: $('videoFrame'),
  remoteVideo: $('remoteVideo'),
  remotePlaceholder: $('remotePlaceholder'),
  remotePlaceholderTitle: $('remotePlaceholderTitle'),
  remotePlaceholderSub: $('remotePlaceholderSub'),
  peerTag: $('peerTag'),
  peerName: $('peerName'),
  connBadge: $('connBadge'),
  callClock: $('callClock'),
  localSlot: $('localSlot'),
  localVideo: $('localVideo'),
  localOff: $('localOff'),
  localMicState: $('localMicState'),
  localCamState: $('localCamState'),
  controls: $('controls'),
  micBtn: $('micBtn'),
  camBtn: $('camBtn'),
  nextBtn: $('nextBtn'),
  chatBtn: $('chatBtn'),
  reportBtn: $('reportBtn'),
  fullBtn: $('fullBtn'),
  startBtn: $('startBtn'),
  howBtn: $('howBtn'),
  cancelBtn: $('cancelBtn'),
  chatPanel: $('chatPanel'),
  chatClose: $('chatClose'),
  chatForm: $('chatForm'),
  chatInput: $('chatInput'),
  chatLog: $('chatLog'),
  chatBadge: $('chatBadge'),
  onlineCount: $('onlineCount'),
  netDot: $('netDot'),
  netText: $('netText'),
  versionTag: $('versionTag'),
  rulesBtn: $('rulesBtn'),
  rulesModal: $('rulesModal'),
  rulesClose: $('rulesClose'),
  rulesOk: $('rulesOk'),
  reportModal: $('reportModal'),
  reportCancel: $('reportCancel'),
};

const state = {
  phase: 'landing', // landing | searching | call
  stream: null,
  streamReady: null,
  peer: null,
  isInitiator: false,
  micOn: true,
  camOn: true,
  peerMicOn: true,
  peerCamOn: true,
  iceServers: [],
  unread: 0,
  startedAt: 0,
  clockTimer: null,
  wsState: 'connecting',
  iceState: 'new',
};

const signaling = new Signaling();

/* ------------------------------------------------------------------ фазы */

function setPhase(phase) {
  state.phase = phase;
  el.body.dataset.phase = phase;
  el.intro.hidden = phase !== 'landing';
  el.search.hidden = phase !== 'searching';
  el.videoFrame.hidden = false;
  el.controls.hidden = phase !== 'call';
  if (phase === 'landing') {
    showPlaceholder('Нажмите «Найти случайного»', 'Собеседник случайный, имя и профиль не нужны');
    el.peerTag.hidden = true;
    el.connBadge.hidden = true;
    stopClock();
  }
}

function showPlaceholder(title, sub) {
  el.remoteVideo.srcObject = null;
  el.remotePlaceholder.hidden = false;
  el.remotePlaceholderTitle.textContent = title;
  el.remotePlaceholderSub.textContent = sub;
}

function setNet(stateName, text) {
  el.netDot.className = `dot ${stateName}`;
  el.netText.textContent = text;
}

/* ------------------------------------------------------------- медиапоток */

async function ensureStream() {
  if (state.stream && state.stream.getTracks().some((t) => t.readyState === 'live')) {
    return state.stream;
  }
  setNet('warn', 'запрашиваем камеру…');
  try {
    state.stream = await getUserMedia({ video: true, audio: true });
  } catch (err) {
    setNet('bad', 'нет доступа');
    toast(mediaErrorText(err), { tone: 'error', ms: 7000 });
    throw err;
  }

  el.localVideo.srcObject = state.stream;
  el.localSlot.hidden = false;
  state.micOn = state.stream.getAudioTracks().some((t) => t.enabled);
  state.camOn = state.stream.getVideoTracks().some((t) => t.enabled);
  syncLocalButtons();
  el.localOff.hidden = state.camOn;
  return state.stream;
}

function syncLocalButtons() {
  el.micBtn.classList.toggle('is-off', !state.micOn);
  el.camBtn.classList.toggle('is-off', !state.camOn);
  setIcon(el.micBtn, state.micOn ? 'mic' : 'mic-off');
  setIcon(el.camBtn, state.camOn ? 'cam' : 'cam-off');
  el.micBtn.classList.toggle('off', !state.micOn);
  el.camBtn.classList.toggle('off', !state.camOn);
  setIcon(el.localMicState, state.micOn ? 'mic' : 'mic-off');
  setIcon(el.localCamState, state.camOn ? 'cam' : 'cam-off');
}

function publishMediaState() {
  signaling.send({ type: 'media:state', mic: state.micOn, cam: state.camOn });
}

/* ------------------------------------------------------------ очередь/матч */

async function startSearching({ fresh = true } = {}) {
  if (fresh) {
    teardownPeer();
    clearChat();
  }

  setPhase('searching');
  el.remotePlaceholderTitle.textContent = 'Ищем собеседника…';
  el.remotePlaceholderSub.textContent = 'Случайный человек, никаких фильтров';
  el.peerTag.hidden = true;
  el.connBadge.hidden = true;
  setNet('warn', 'в очереди');
  signaling.send({ type: 'queue:join' });

  // Камера запрашивается параллельно поиску: если доступ не выдан,
  // пользователь всё равно попадёт в очередь и сможет общаться в чате.
  await ensureStream().catch(() => {});
}

function teardownPeer() {
  if (state.peer) {
    state.peer.close();
    state.peer = null;
  }
  el.remoteVideo.srcObject = null;
  el.peerTag.hidden = true;
  stopClock();
}

async function onMatch(msg) {
  state.isInitiator = msg.initiator;
  state.iceServers = msg.iceServers || state.iceServers;

  clearChat();
  el.localOff.hidden = state.camOn && Boolean(state.stream);
  const peerColor = msg.peer?.color?.name || 'неизвестный цвет';
  showPlaceholder('Соединение с собеседником…', `Ваш собеседник — ${peerColor}`);

  const peer = new Peer({ iceServers: state.iceServers });
  state.peer = peer;
  peer.on('signal', (data) => signaling.send({ type: 'signal', data }));
  peer.on('track', ({ stream }) => {
    el.remoteVideo.srcObject = stream;
    el.remotePlaceholder.hidden = stream.getTracks().length > 0;
  });
  peer.on('ice', ({ state: ice }) => {
    state.iceState = ice;
    updateConnBadge();
  });
  peer.on('conn', ({ state: conn }) => {
    setNet(conn === 'connected' ? 'ok' : 'warn', conn === 'connected' ? 'p2p' : conn);
    if (conn === 'connected' && el.remoteVideo.srcObject === null) {
      showPlaceholder('Собеседник без видео', 'Продолжайте общение в чате справа');
    }
  });
  peer.on('failed', () => {
    toast('Соединение не установилось. Ищем заново…', { tone: 'warn' });
    startSearching({ fresh: true });
  });

  peer.create();
  if (state.stream) {
    await peer.setLocalStream(state.stream);
  }
  // Разрешение на камеру могло прийти уже после матча — догоняем поток.
  state.streamReady = ensureStream()
    .then(() => state.peer)
    .then((live) => live && live === state.peer ? live.setLocalStream(state.stream) : null)
    .catch(() => {
      setNet('bad', 'только чат');
      showPlaceholder('Видео недоступно', 'Общайтесь текстом в чате справа');
    });

  if (msg.peer) {
    el.peerName.textContent = `Собеседник · ${peerColor}`;
    el.peerTag.hidden = false;
  }

  el.connBadge.hidden = false;
  el.connBadge.textContent = 'соединение…';
  setPhase('call');
}

function updateConnBadge() {
  const labels = {
    new: 'подготовка…',
    checking: 'проверяем…',
    connected: 'защищённый канал',
    completed: 'канал закрыт',
    disconnected: 'нет сигнала…',
    failed: 'ошибка канала',
    closed: 'канал закрыт',
  };
  if (!el.connBadge.hidden) {
    el.connBadge.textContent = labels[state.iceState] || state.iceState;
    el.connBadge.classList.toggle('is-ok', state.iceState === 'connected');
  }
  if (state.iceState === 'connected') setNet('ok', 'p2p');
  if (state.iceState === 'failed') setNet('bad', 'ошибка');
}

/* ------------------------------------------------------------------ часы */

function startClock() {
  stopClock();
  state.startedAt = Date.now();
  el.callClock.hidden = false;
  const tick = () => {
    const s = Math.floor((Date.now() - state.startedAt) / 1000);
    el.callClock.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };
  tick();
  state.clockTimer = setInterval(tick, 1000);
}

function stopClock() {
  clearInterval(state.clockTimer);
  state.clockTimer = null;
  if (el.callClock) el.callClock.hidden = true;
}

/* ------------------------------------------------------------------ чат */

function clearChat() {
  el.chatLog.replaceChildren();
  state.unread = 0;
  el.chatBadge.hidden = true;
  el.chatBadge.textContent = '0';
}

function addMessage(text, mine) {
  el.chatLog.querySelector('.chat-empty')?.remove();
  const node = document.createElement('div');
  node.className = `msg ${mine ? 'msg-mine' : 'msg-theirs'}`;
  node.textContent = text;
  el.chatLog.append(node);
  el.chatLog.scrollTop = el.chatLog.scrollHeight;

  if (!mine && el.chatPanel.hidden) {
    state.unread += 1;
    el.chatBadge.textContent = String(state.unread);
    el.chatBadge.hidden = false;
  }
}

function toggleChat(force) {
  const open = force ?? el.chatPanel.hidden;
  el.chatPanel.hidden = !open;
  el.chatBtn.classList.toggle('is-active', open);
  if (open) {
    state.unread = 0;
    el.chatBadge.hidden = true;
    el.chatInput.focus();
  }
}

/* -------------------------------------------------------- серверные события */

signaling.on('status', ({ state: wsState }) => {
  state.wsState = wsState;
  if (wsState === 'open') setNet('warn', 'на связи');
  else if (wsState === 'connecting' || wsState === 'reconnecting')
    setNet('warn', 'подключение…');
  else if (wsState === 'closed' || wsState === 'error') setNet('bad', 'нет связи');
});

signaling.on('ready', (msg) => {
  state.iceServers = msg.iceServers || state.iceServers;
  el.onlineCount.textContent = String(msg.online ?? 0);
  setNet('ok', 'на связи');
});

signaling.on('stats', (msg) => {
  el.onlineCount.textContent = String(msg.online ?? 0);
  if (el.queueSize) el.queueSize.textContent = String(msg.waiting ?? 0);
  if (msg.waiting === 0 && state.phase === 'searching') {
    el.search.querySelector('h2').textContent = 'Пока никого нет…';
  } else if (state.phase === 'searching') {
    el.search.querySelector('h2').textContent = 'Ищем собеседника…';
  }
});

signaling.on('queue:waiting', (msg) => {
  if (el.queueSize) el.queueSize.textContent = String(msg.waiting ?? 0);
});

signaling.on('match', (msg) => {
  startClock();
  onMatch(msg);
});

signaling.on('signal', (msg) => {
  state.peer?.handleSignal(msg.data);
});

signaling.on('media:state', (msg) => {
  state.peerMicOn = msg.mic !== false;
  state.peerCamOn = msg.cam !== false;
  const remoteVideo = el.remoteVideo.srcObject?.getVideoTracks?.()[0];
  if (remoteVideo) remoteVideo.enabled = state.peerCamOn;
  const remoteAudio = el.remoteVideo.srcObject?.getAudioTracks?.()[0];
  if (remoteAudio) remoteAudio.enabled = state.peerMicOn;
  if (!state.peerCamOn) el.remotePlaceholder.hidden = false;
});

signaling.on('chat', (msg) => addMessage(msg.text, false));

signaling.on('peer:left', (msg) => {
  const reasons = {
    skipped: 'Собеседник ушёл к следующему.',
    reported: 'Разговор завершён по жалобе.',
    reported_peer: 'Разговор завершён по жалобе.',
    peer_disconnected: 'Собеседник отключился.',
    left: 'Собеседник завершил разговор.',
  };
  toast(reasons[msg.reason] || 'Собеседник отключился.', { tone: 'warn' });
  teardownPeer();
  clearChat();
  closeModals();
  startSearching({ fresh: false });
});

signaling.on('error', (msg) => {
  const map = {
    rate_limited: 'Слишком много сообщений. Подождите пару секунд.',
    no_peer: 'Собеседник ещё не подключён.',
    already_matched: 'Вы уже в разговоре.',
    bad_signal: 'Некорректный сигнал соединения.',
    bad_json: 'Ошибка формата сообщения.',
  };
  if (map[msg.code]) toast(map[msg.code], { tone: 'warn' });
});

signaling.on('report:accepted', () => toast('Жалоба принята. Соединение разорвано.'));

/* --------------------------------------------------------------- действия */

el.startBtn.addEventListener('click', () => startSearching({ fresh: true }));
el.howBtn.addEventListener('click', () => openModal(el.rulesModal));
el.cancelBtn.addEventListener('click', () => {
  signaling.send({ type: 'queue:leave' });
  setPhase('landing');
});

el.nextBtn.addEventListener('click', () => {
  if (state.phase === 'call') toast('Ищем следующего собеседника…');
  startSearching({ fresh: true });
});

el.micBtn.addEventListener('click', () => {
  state.micOn = toggleTrack(state.stream?.getAudioTracks()[0], !state.micOn);
  syncLocalButtons();
  publishMediaState();
});

el.camBtn.addEventListener('click', () => {
  state.camOn = toggleTrack(state.stream?.getVideoTracks()[0], !state.camOn);
  el.localOff.hidden = state.camOn;
  syncLocalButtons();
  publishMediaState();
});

el.chatBtn.addEventListener('click', () => toggleChat());
el.chatClose.addEventListener('click', () => toggleChat(false));

el.chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = el.chatInput.value.trim();
  if (!text) return;
  signaling.send({ type: 'chat', text });
  addMessage(text, true);
  el.chatInput.value = '';
});

el.reportBtn.addEventListener('click', () => {
  if (state.phase !== 'call') return toast('Жалоба доступна только во время разговора.', { tone: 'warn' });
  openModal(el.reportModal);
});

el.reportModal.querySelectorAll('.report-opt').forEach((btn) => {
  btn.addEventListener('click', () => {
    signaling.send({ type: 'report', reason: btn.dataset.reason });
    closeModals();
    teardownPeer();
    clearChat();
    setPhase('landing');
  });
});

el.fullBtn.addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else document.documentElement.requestFullscreen?.().catch(() => {});
});

el.rulesBtn.addEventListener('click', () => openModal(el.rulesModal));
el.rulesClose.addEventListener('click', () => closeModals());
el.rulesOk.addEventListener('click', () => closeModals());
el.reportCancel.addEventListener('click', () => closeModals());
document.addEventListener('click', (e) => {
  if (e.target.classList?.contains('overlay')) closeModals();
});
document.addEventListener('keydown', (e) => {
  if (e.target?.matches?.('input, textarea')) return;
  if (e.key === 'Escape') {
    closeModals();
    toggleChat(false);
    return;
  }
  const key = e.key.toLowerCase();
  const map = {
    m: () => el.micBtn.click(),
    v: () => el.camBtn.click(),
    n: () => el.nextBtn.click(),
    c: () => toggleChat(),
    r: () => el.reportBtn.click(),
    f: () => el.fullBtn.click(),
  };
  if (map[key]) {
    e.preventDefault();
    map[key]();
  }
});

function openModal(node) {
  node.hidden = false;
  node.querySelector('button')?.focus();
}

function closeModals() {
  el.rulesModal.hidden = true;
  el.reportModal.hidden = true;
}

window.addEventListener('beforeunload', () => {
  signaling.send({ type: 'queue:leave' });
  signaling.close();
  stopStream(state.stream);
});

/* ------------------------------------------------------------------ старт */

async function boot() {
  setPhase('landing');
  syncLocalButtons();
  try {
    const res = await fetch('/api/config');
    if (res.ok) {
      const cfg = await res.json();
      state.iceServers = cfg.iceServers || [];
      el.versionTag.textContent = `beta · ${cfg.version || ''}`.trim();
    }
  } catch {
    /* dev-режим без API — не критично */
  }
  signaling.connect();
}

boot();
