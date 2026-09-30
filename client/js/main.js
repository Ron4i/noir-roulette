import { $, setIcon, toast } from './dom.js';
import { Signaling } from './signaling.js';
import { Peer, gradeQuality } from './rtc.js';
import {
  applyVideoQuality,
  getUserMedia,
  listDevices,
  mediaErrorText,
  setMirrored,
  stopStream,
  switchDevice,
  toggleTrack,
} from './media.js';
import { addCall, averageMinutes, bumpStat, loadSettings, loadStats, resetStats, saveSettings } from './store.js';

const el = {
  body: document.body,
  intro: $('introPanel'),
  search: $('searchPanel'),
  queueSize: $('queueSize'),
  searchHeading: $('searchPanel')?.querySelector('h2'),
  videoFrame: $('videoFrame'),
  remoteVideo: $('remoteVideo'),
  remotePlaceholder: $('remotePlaceholder'),
  remotePlaceholderTitle: $('remotePlaceholderTitle'),
  remotePlaceholderSub: $('remotePlaceholderSub'),
  liveTopics: $('liveTopics'),
  peerTag: $('peerTag'),
  peerName: $('peerName'),
  connBadge: $('connBadge'),
  callClock: $('callClock'),
  localSlot: $('localSlot'),
  localVideo: $('localVideo'),
  localOff: $('localOff'),
  localMicState: $('localMicState'),
  localCamState: $('localCamState'),
  screenFlag: $('screenFlag'),
  captionOverlay: $('captionOverlay'),
  fxStrip: $('fxStrip'),
  controls: $('controls'),
  micBtn: $('micBtn'),
  camBtn: $('camBtn'),
  screenBtn: $('screenBtn'),
  fxBtn: $('fxBtn'),
  statsBtn: $('statsBtn'),
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
  ttsBtn: $('ttsBtn'),
  onlineCount: $('onlineCount'),
  netDot: $('netDot'),
  netText: $('netText'),
  qualityPill: $('qualityPill'),
  qualityText: $('qualityText'),
  versionTag: $('versionTag'),
  rulesBtn: $('rulesBtn'),
  rulesModal: $('rulesModal'),
  rulesClose: $('rulesClose'),
  rulesOk: $('rulesOk'),
  reportModal: $('reportModal'),
  reportCancel: $('reportCancel'),
  themeBtn: $('themeBtn'),
  settingsBtn: $('settingsBtn'),
  settingsModal: $('settingsModal'),
  settingsClose: $('settingsClose'),
  settingsOk: $('settingsOk'),
  settingsReset: $('settingsReset'),
  camSelect: $('camSelect'),
  micSelect: $('micSelect'),
  qualitySelect: $('qualitySelect'),
  optMirror: $('optMirror'),
  optTts: $('optTts'),
  optCaptions: $('optCaptions'),
  optReduceData: $('optReduceData'),
  themeSeg: $('themeSeg'),
  statsModal: $('statsModal'),
  statsClose: $('statsClose'),
  statsOk: $('statsOk'),
  statsOpenBtn: $('statsOpenBtn'),
  localStatsGrid: $('localStatsGrid'),
  historyList: $('historyList'),
  roomsBtn: $('roomsBtn'),
  roomsModal: $('roomsModal'),
  roomsClose: $('roomsClose'),
  roomsOk: $('roomsOk'),
  roomCreateForm: $('roomCreateForm'),
  roomTitle: $('roomTitle'),
  roomTopic: $('roomTopic'),
  roomSearch: $('roomSearch'),
  roomList: $('roomList'),
  roomPanel: $('roomPanel'),
  roomTitleLabel: $('roomTitleLabel'),
  roomMetaLabel: $('roomMetaLabel'),
  roomLog: $('roomLog'),
  roomForm: $('roomForm'),
  roomInput: $('roomInput'),
  roomInvite: $('roomInvite'),
  roomLeave: $('roomLeave'),
  prefsBox: $('prefsBox'),
  prefsToggle: $('prefsToggle'),
  topicsWrap: $('topicsWrap'),
  topicsGrid: $('topicsGrid'),
  prefExtras: $('prefExtras'),
  require18: $('require18'),
  nearbyOnly: $('nearbyOnly'),
};

const state = {
  phase: 'landing', // landing | searching | call
  stream: null,
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
  peerName: '',
  screenSharing: false,
  settings: loadSettings(),
  topics: [],
  topicLabels: new Map(),
  liveTopics: [],
  room: null,
  roomFilter: '',
  captionTimer: null,
  quality: 'unknown',
  features: { tts: true, screenShare: true, rooms: true, randomTopics: true },
  accessMode: 'open',
  maxMessageChars: 500,
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
    el.screenFlag.hidden = true;
    el.qualityPill.hidden = true;
    el.captionOverlay.hidden = true;
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

/* ----------------------------------------------------------------- тема */

function applyTheme(theme) {
  const value = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = value;
  const icon = el.themeBtn?.querySelector('use');
  if (icon) icon.setAttribute('href', value === 'light' ? '#i-moon' : '#i-sun');
  for (const opt of el.themeSeg?.querySelectorAll('.seg-opt') || []) {
    opt.classList.toggle('is-on', opt.dataset.theme === value);
  }
  state.settings = saveSettings({ theme: value });
}

/* ------------------------------------------------------------- эффекты */

function applyFx(fx) {
  const value = fx || 'none';
  el.localVideo.dataset.fx = value;
  for (const opt of el.fxStrip?.querySelectorAll('.fx-opt') || []) {
    opt.classList.toggle('is-on', opt.dataset.fx === value);
  }
  if (state.stream) {
    const track = state.stream.getVideoTracks()[0];
    if (track) {
      setMirrored(el.localVideo, state.settings.mirror && !state.screenSharing);
      track.enabled = state.camOn;
    }
  }
  state.settings = saveSettings({ fx: value });
}

function toggleFxStrip(force) {
  const show = force ?? el.fxStrip.hidden;
  el.fxStrip.hidden = !show;
}

/* --------------------------------------------------- настройки подбора */

function selectedTopics() {
  return el.topicsGrid?.querySelectorAll('.topic-chip.is-on').length
    ? [...el.topicsGrid.querySelectorAll('.topic-chip.is-on')].map((b) => b.dataset.topic)
    : [...state.settings.interests];
}

function currentPrefs() {
  return {
    mode: state.settings.mode,
    interests: selectedTopics(),
    preferGender: '',
    require18Plus: el.require18?.checked ?? state.settings.require18Plus,
    region: el.nearbyOnly?.checked ? state.settings.region || 'local' : '',
  };
}

function syncPrefsUi() {
  for (const opt of document.querySelectorAll('.mode-opt')) {
    const on = opt.dataset.mode === state.settings.mode;
    opt.classList.toggle('is-on', on);
    opt.setAttribute('aria-checked', String(on));
  }
  const interests = state.settings.mode === 'interests';
  el.topicsWrap.hidden = !interests;
  el.prefExtras.hidden = !interests;
  if (el.require18) el.require18.checked = Boolean(state.settings.require18Plus);
  if (el.nearbyOnly) el.nearbyOnly.checked = Boolean(state.settings.region === 'local');
  for (const chip of el.topicsGrid?.querySelectorAll('.topic-chip') || []) {
    chip.classList.toggle('is-on', state.settings.interests.includes(chip.dataset.topic));
  }
}

function renderTopics() {
  if (!el.topicsGrid) return;
  el.topicsGrid.replaceChildren();
  for (const topic of state.topics) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'topic-chip';
    chip.dataset.topic = topic.id;
    chip.textContent = `${topic.emoji} ${topic.label}`;
    chip.addEventListener('click', () => {
      const picked = selectedTopics();
      const has = picked.includes(topic.id);
      if (!has && picked.length >= 3) {
        toast('Можно выбрать не больше трёх тем.', { tone: 'warn' });
        return;
      }
      const next = has ? picked.filter((t) => t !== topic.id) : [...picked, topic.id];
      state.settings = saveSettings({ interests: next });
      syncPrefsUi();
      pushPrefs();
    });
    el.topicsGrid.append(chip);
  }
}

function pushPrefs() {
  signaling.send({ type: 'prefs', prefs: currentPrefs() });
}

function renderLiveTopics(topics) {
  state.liveTopics = Array.isArray(topics) ? topics : [];
  if (!el.liveTopics) return;
  if (!state.liveTopics.length) {
    el.liveTopics.hidden = true;
    el.liveTopics.replaceChildren();
    return;
  }
  el.liveTopics.hidden = false;
  el.liveTopics.replaceChildren();
  for (const topic of state.liveTopics.slice(0, 8)) {
    const chip = document.createElement('span');
    chip.className = 'live-topic';
    chip.textContent = `${topic.emoji || ''} ${topic.label || ''} · ${topic.waiting ?? 0}`;
    el.liveTopics.append(chip);
  }
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
  applyFx(state.settings.fx);
  setMirrored(el.localVideo, state.settings.mirror);
  applyVideoQuality(state.stream, { height: state.settings.videoHeight, width: state.settings.videoHeight * (16 / 9) });
  refreshDevices();
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
  if (el.screenBtn) el.screenBtn.classList.toggle('is-active', state.screenSharing);
}

function publishMediaState() {
  signaling.send({ type: 'media:state', mic: state.micOn, cam: state.camOn, screen: state.screenSharing });
}

function reportMediaReady() {
  if (state.stream && state.stream.getTracks().some((t) => t.readyState === 'live')) {
    signaling.send({ type: 'media:ready' });
  }
}

/** Заполнить выпадающие списки камер и микрофонов. */
async function refreshDevices() {
  const { cameras, microphones } = await listDevices();
  fillDeviceSelect(el.camSelect, cameras, state.settings.camDevice, 'Камера по умолчанию');
  fillDeviceSelect(el.micSelect, microphones, state.settings.micDevice, 'Микрофон по умолчанию');
}

function fillDeviceSelect(select, devices, selected, placeholder) {
  if (!select) return;
  const previous = selected || select.value;
  select.replaceChildren();
  const blank = document.createElement('option');
  blank.value = '';
  blank.textContent = placeholder;
  select.append(blank);
  for (const device of devices) {
    const opt = document.createElement('option');
    opt.value = device.deviceId;
    opt.textContent = device.label;
    select.append(opt);
  }
  if (previous && devices.some((d) => d.deviceId === previous)) select.value = previous;
}

async function onDeviceChange(kind, deviceId) {
  if (!deviceId) return;
  state.settings = saveSettings(kind === 'video' ? { camDevice: deviceId } : { micDevice: deviceId });
  if (!state.stream) return;
  const sender = state.peer?.senderFor?.(kind) || null;
  const result = await switchDevice(state.stream, kind, deviceId, sender);
  if (!result.ok) {
    toast(result.error, { tone: 'error' });
    await refreshDevices();
    return;
  }
  if (result.stream) {
    el.localVideo.srcObject = result.stream;
    await state.peer?.setLocalStream?.(result.stream);
  }
  if (kind === 'audio') {
    state.micOn = result.track?.enabled ?? state.micOn;
  } else {
    state.camOn = result.track?.enabled ?? state.camOn;
    state.screenSharing = false;
    el.localOff.hidden = state.camOn;
  }
  syncLocalButtons();
  publishMediaState();
  reportMediaReady();
}

async function onQualityChange(height) {
  state.settings = saveSettings({ videoHeight: Number(height) || 720 });
  if (!state.stream) return;
  const result = await applyVideoQuality(state.stream, { width: height * (16 / 9), height });
  if (!result.ok) toast(result.error, { tone: 'warn' });
}

async function toggleScreenShare() {
  if (!state.peer || state.phase !== 'call') {
    toast('Демонстрация экрана доступна во время разговора.', { tone: 'warn' });
    return;
  }
  const want = !state.screenSharing;
  const result = await state.peer.setScreenShare(want);
  if (result.cancelled) return;
  if (!result.ok) {
    toast(result.error || 'Не удалось включить демонстрацию экрана.', { tone: 'error' });
    return;
  }
  state.screenSharing = want;
  el.screenFlag.hidden = !want;
  setMirrored(el.localVideo, state.settings.mirror && !want);
  syncLocalButtons();
  publishMediaState();
  toast(want ? 'Экран отправляется собеседнику.' : 'Вернулись к камере.', { tone: 'info' });
}

function onQuality(report) {
  state.quality = report.quality || gradeQuality(report);
  if (!el.qualityPill) return;
  el.qualityPill.hidden = state.phase !== 'call';
  el.qualityPill.dataset.q = state.quality;
  const bits = [];
  if (report.bitrateKbps) bits.push(`${report.bitrateKbps} кбит/с`);
  if (report.rttMs != null) bits.push(`${report.rttMs} мс`);
  if (report.packetLoss) bits.push(`потери ${report.packetLoss}%`);
  el.qualityText.textContent = bits.length ? bits.join(' · ') : 'измеряем…';
}

/* ------------------------------------------------------------ очередь/матч */

async function startSearching({ fresh = true } = {}) {
  try {
    await ensureStream();
  } catch {
    return;
  }

  if (fresh) {
    finishCall();
    teardownPeer();
    clearChat();
  }

  setPhase('searching');
  el.remotePlaceholderTitle.textContent = 'Ищем собеседника…';
  el.remotePlaceholderSub.textContent = 'Случайный человек, никаких фильтров';
  el.peerTag.hidden = true;
  el.connBadge.hidden = true;
  el.qualityPill.hidden = true;
  setNet('warn', 'в очереди');
  if (fresh) bumpStat('skipped');
  signaling.send({ type: 'queue:join', prefs: currentPrefs() });
}

function teardownPeer() {
  if (state.peer) {
    state.peer.close();
    state.peer = null;
  }
  el.remoteVideo.srcObject = null;
  el.peerTag.hidden = true;
  el.screenFlag.hidden = true;
  state.screenSharing = false;
  el.captionOverlay.hidden = true;
  stopClock();
}

/** Записать завершённый разговор в локальную статистику. */
function finishCall() {
  if (!state.startedAt) return;
  const sec = (Date.now() - state.startedAt) / 1000;
  if (sec >= 3) addCall(sec, state.peerName);
  state.peerName = '';
  state.startedAt = 0;
}

async function onMatch(msg) {
  state.isInitiator = msg.initiator;
  state.iceServers = msg.iceServers || state.iceServers;
  state.peerName = msg.peer?.name || '';

  clearChat();
  el.captionOverlay.hidden = true;
  el.localOff.hidden = state.camOn;

  const peer = new Peer({ iceServers: state.iceServers });
  state.peer = peer;
  peer.on('signal', (data) => signaling.send({ type: 'signal', data }));
  peer.on('track', ({ stream }) => {
    el.remoteVideo.srcObject = stream;
    el.remotePlaceholder.hidden = stream.getTracks().length > 0;
    reportMediaReady();
  });
  peer.on('ice', ({ state: ice }) => {
    state.iceState = ice;
    updateConnBadge();
  });
  peer.on('conn', ({ state: conn }) => {
    setNet(conn === 'connected' ? 'ok' : 'warn', conn === 'connected' ? 'p2p' : conn);
  });
  peer.on('stats', (report) => {
    onQuality(report);
    signaling.send({ type: 'stats:report', quality: qualityScore(report) });
  });
  peer.on('screen', ({ on }) => {
    state.peerScreenSharing = on;
    el.screenFlag.hidden = !on;
    if (!on && state.peerCamOn) el.remotePlaceholder.hidden = true;
  });
  peer.on('failed', () => {
    toast('Соединение не установилось. Ищем заново…', { tone: 'warn' });
    startSearching({ fresh: true });
  });

  peer.create();
  await peer.setLocalStream(state.stream);

  if (msg.peer) {
    el.peerName.textContent = `Собеседник · ${msg.peer.name}`;
    el.peerTag.hidden = false;
    toast(`Соединение с «${msg.peer.name}»`, { tone: 'ok', ms: 2400 });
  }

  el.connBadge.hidden = false;
  el.connBadge.textContent = 'соединение…';
  el.screenBtn.hidden = !state.features.screenShare;
  el.fxBtn.hidden = false;
  el.statsBtn.hidden = false;
  setPhase('call');
}

/** Числовой «здоровый»Connections score 0..1 — сервер использует его в приоритете. */
function qualityScore(report) {
  const loss = Math.min(1, (report.packetLoss || 0) / 10);
  const rtt = Math.min(1, (report.rttMs || 0) / 500);
  return Math.max(0, Math.min(1, 1 - loss * 0.6 - rtt * 0.4));
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

/* ------------------------------------------------- озвучка и субтитры */

function speak(text) {
  if (!state.settings.tts || !state.features.tts) return;
  if (!('speechSynthesis' in window)) return;
  // Не даём накопиться очереди озвучки при потоке сообщений.
  speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = 'ru-RU';
  utter.rate = 1.05;
  speechSynthesis.speak(utter);
}

function showCaption(text, mine) {
  if (!state.settings.captions || !el.captionOverlay) return;
  el.captionOverlay.replaceChildren();
  const who = document.createElement('span');
  who.className = 'cap-who';
  who.textContent = mine ? 'Вы' : state.peerName || 'Собеседник';
  const body = document.createElement('span');
  body.textContent = text;
  el.captionOverlay.append(who, body);
  el.captionOverlay.hidden = false;
  clearTimeout(state.captionTimer);
  state.captionTimer = setTimeout(() => {
    el.captionOverlay.hidden = true;
  }, 6000);
}

/* ------------------------------------------------------ локальная статистика */

function formatDuration(totalSec) {
  const m = Math.floor(totalSec / 60);
  const h = Math.floor(m / 60);
  if (h) return `${h} ч ${m % 60} мин`;
  return `${m} мин ${String(Math.floor(totalSec % 60)).padStart(2, '0')} с`;
}

function renderStats() {
  if (!el.localStatsGrid) return;
  const stats = loadStats();
  const avg = averageMinutes(stats);
  const cards = [
    { value: String(stats.chats || 0), label: 'разговоров', accent: true },
    { value: stats.seconds ? formatDuration(stats.seconds) : '0 с', label: 'всего в эфире' },
    { value: avg != null ? `${avg.toFixed(1)} мин` : '—', label: 'средний разговор' },
    { value: String(stats.skipped || 0), label: 'пропущено' },
    { value: String(stats.messages || 0), label: 'сообщений' },
    { value: String(stats.reports || 0), label: 'жалоб' },
  ];
  el.localStatsGrid.replaceChildren();
  for (const card of cards) {
    const node = document.createElement('div');
    node.className = `stat-card${card.accent ? ' is-accent' : ''}`;
    const b = document.createElement('b');
    b.textContent = card.value;
    const span = document.createElement('span');
    span.textContent = card.label;
    node.append(b, span);
    el.localStatsGrid.append(node);
  }

  if (!el.historyList) return;
  el.historyList.replaceChildren();
  if (!stats.history.length) {
    const note = document.createElement('p');
    note.className = 'empty-note';
    note.textContent = 'История пуста — первый разговор ещё не начался.';
    el.historyList.append(note);
    return;
  }
  for (const item of stats.history) {
    const node = document.createElement('div');
    node.className = 'history-item';
    const name = document.createElement('span');
    name.className = 'h-name';
    name.textContent = item.name || 'Собеседник';
    const time = document.createElement('span');
    time.className = 'h-time';
    const when = new Date(item.at || Date.now());
    time.textContent = `${formatDuration(item.sec || 0)} · ${when.toLocaleDateString('ru-RU')}`;
    node.append(name, time);
    el.historyList.append(node);
  }
}

/* ------------------------------------------------------------------ комнаты */

function renderRoomList() {
  if (!el.roomList) return;
  const rooms = state.rooms || [];
  const filter = state.roomFilter.trim().toLowerCase();
  el.roomList.replaceChildren();
  const visible = filter ? rooms.filter((r) => r.title.toLowerCase().includes(filter)) : rooms;
  if (!visible.length) {
    const note = document.createElement('p');
    note.className = 'empty-note';
    note.textContent = filter ? 'Ничего не найдено.' : 'Пока нет открытых комнат — создайте первую.';
    el.roomList.append(note);
    return;
  }
  for (const room of visible) {
    const topic = state.topics.find((t) => t.id === room.topic);
    const node = document.createElement('div');
    node.className = 'room-item';
    const emoji = document.createElement('span');
    emoji.className = 'r-emoji';
    emoji.textContent = topic?.emoji || '💬';
    const info = document.createElement('div');
    info.className = 'r-info';
    const title = document.createElement('b');
    title.className = 'r-title';
    title.textContent = room.title;
    const meta = document.createElement('span');
    meta.className = 'r-meta';
    meta.textContent = `${topic?.label || 'Общение'} · ${room.guests ?? 0} из ${room.max ?? 8}`;
    info.append(title, meta);
    const join = document.createElement('button');
    join.type = 'button';
    join.className = 'join-btn';
    join.textContent = 'Войти';
    join.addEventListener('click', () => {
      signaling.send({ type: 'room:join', room: room.id });
      closeModals();
    });
    node.append(emoji, info, join);
    el.roomList.append(node);
  }
}

function openRoom(msg) {
  state.room = msg.room;
  el.roomPanel.hidden = false;
  el.roomTitleLabel.textContent = msg.room.title;
  el.roomMetaLabel.textContent = `участников: ${msg.room.guests ?? 1} · ${msg.room.max ?? 8}`;
  el.roomLog.replaceChildren();
  addRoomLine(`Вы вошли в «${msg.room.title}»`, 'system');
}

function closeRoom() {
  state.room = null;
  el.roomPanel.hidden = true;
  el.roomLog.replaceChildren();
}

function addRoomLine(text, who = 'other') {
  if (!el.roomLog) return;
  const node = document.createElement('div');
  node.className = `msg msg-${who}`;
  if (who === 'other' || who === 'system') {
    const name = document.createElement('b');
    name.className = 'room-user';
    name.textContent = who === 'system' ? '' : `${who}:`;
    node.append(name, document.createTextNode(` ${text}`));
  } else {
    node.textContent = text;
  }
  el.roomLog.append(node);
  el.roomLog.scrollTop = el.roomLog.scrollHeight;
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
  pushPrefs();
});

signaling.on('stats', (msg) => {
  el.onlineCount.textContent = String(msg.online ?? 0);
  if (el.queueSize) el.queueSize.textContent = String(msg.waiting ?? 0);
  if (state.rooms) state.rooms = msg.rooms || state.rooms;
  renderLiveTopics(msg.topics);
  if (state.phase === 'searching') {
    if (el.searchHeading) {
      el.searchHeading.textContent = msg.waiting === 0 ? 'Пока никого нет…' : 'Ищем собеседника…';
    }
  }
  if (!el.roomsModal.hidden) renderRoomList();
});

signaling.on('queue:waiting', (msg) => {
  if (el.queueSize) el.queueSize.textContent = String(msg.waiting ?? 0);
});

signaling.on('queue:joined', (msg) => {
  if (msg.prefs) {
    // Сервер нормализует настройки — синхронизируемся с его пониманием.
    if (Array.isArray(msg.prefs.interests)) {
      state.settings = saveSettings({ interests: msg.prefs.interests });
      syncPrefsUi();
    }
  }
});

signaling.on('prefs:updated', (msg) => {
  renderLiveTopics(msg.topics);
  if (msg.prefs && Array.isArray(msg.prefs.interests)) {
    state.settings = saveSettings({ interests: msg.prefs.interests });
    syncPrefsUi();
  }
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
  state.peerScreenSharing = Boolean(msg.screen);
  el.screenFlag.hidden = !state.peerScreenSharing;
  const remoteVideo = el.remoteVideo.srcObject?.getVideoTracks?.()[0];
  if (remoteVideo) remoteVideo.enabled = state.peerCamOn || state.peerScreenSharing;
  const remoteAudio = el.remoteVideo.srcObject?.getAudioTracks?.()[0];
  if (remoteAudio) remoteAudio.enabled = state.peerMicOn;
  if (!state.peerCamOn && !state.peerScreenSharing) {
    el.remotePlaceholder.hidden = false;
    el.remotePlaceholderTitle.textContent = 'Собеседник выключил камеру';
  } else {
    el.remotePlaceholder.hidden = true;
  }
});

signaling.on('chat', (msg) => {
  addMessage(msg.text, false);
  bumpStat('messages');
  showCaption(msg.text, false);
  speak(msg.text);
});

signaling.on('peer:lost', () => {
  toast('Собеседник не передаёт видео. Переходим к следующему.', { tone: 'warn' });
  if (state.phase === 'call') startSearching({ fresh: true });
  else teardownPeer();
});

signaling.on('peer:left', (msg) => {
  const reasons = {
    skipped: 'Собеседник ушёл к следующему.',
    reported: 'Разговор завершён по жалобе.',
    peer_disconnected: 'Собеседник отключился.',
    left: 'Собеседник завершил разговор.',
    no_media: 'Видео не пошло — ищем заново.',
  };
  toast(reasons[msg.reason] || 'Собеседник отключился.', { tone: 'warn' });
  finishCall();
  teardownPeer();
  clearChat();
  closeModals();
  startSearching({ fresh: false });
});

signaling.on('banned', (msg) => {
  const why = msg.reason ? ` (причина: ${msg.reason})` : '';
  toast(`Вас заблокировали${why}. Разговор недоступен.`, { tone: 'error', ms: 8000 });
  teardownPeer();
  setPhase('landing');
});

signaling.on('room:joined', (msg) => openRoom(msg));
signaling.on('room:left', () => {
  closeRoom();
  toast('Вы вышли из комнаты.', { tone: 'info' });
});
signaling.on('room:chat', (msg) => addRoomLine(msg.text, msg.color?.name || 'Гость'));
signaling.on('room:peer:joined', (msg) =>
  addRoomLine('вошёл в комнату', msg.peer?.color?.name || 'Гость'),
);
signaling.on('room:peer:left', () => addRoomLine('вышел из комнаты', 'Гость'));
signaling.on('room:invite', (msg) => {
  const id = msg.room?.id;
  const title = msg.room?.title || 'без названия';
  toast(`Вас пригласили в комнату «${title}»`, { tone: 'info', ms: 8000 });
  if (id) {
    el.roomsBtn?.insertAdjacentElement?.('afterend', inviteChip(id, title));
  }
});

/** Временная кнопка «Войти» рядом с «Комнаты» после приглашения. */
function inviteChip(roomId, title) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'invite-chip';
  btn.textContent = `Войти: ${title.slice(0, 22)}`;
  btn.title = 'Войти в комнату по приглашению';
  btn.addEventListener('click', () => {
    signaling.send({ type: 'room:join', room: roomId });
    btn.remove();
  });
  setTimeout(() => btn.remove(), 60_000);
  return btn;
}
signaling.on('room:invited', (msg) => toast(`Приглашение отправлено: ${msg.to || 'собеседник'}`, { tone: 'info' }));

signaling.on('report:accepted', (msg) => {
  toast(
    msg.banned ? 'Жалоба принята. Собеседник заблокирован.' : 'Жалоба принята. Соединение разорвано.',
    { tone: 'ok' },
  );
});

signaling.on('error', (msg) => {
  const map = {
    rate_limited: 'Слишком много сообщений. Подождите пару секунд.',
    no_peer: 'Собеседник ещё не подключён.',
    already_matched: 'Вы уже в разговоре.',
    bad_signal: 'Некорректный сигнал соединения.',
    bad_json: 'Ошибка формата сообщения.',
    muted: 'Ваш доступ к чату временно ограничен.',
    room_not_found: 'Комната уже закрыта.',
    room_full: 'В комнате нет свободных мест.',
    private_mode: 'Личный режим недоступен.',
    unknown_type: 'Сервер не понял команду.',
  };
  if (map[msg.code]) toast(map[msg.code], { tone: 'warn' });
});

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
  if (state.screenSharing) {
    toast('Сначала выключите демонстрацию экрана.', { tone: 'warn' });
    return;
  }
  state.camOn = toggleTrack(state.stream?.getVideoTracks()[0], !state.camOn);
  el.localOff.hidden = state.camOn;
  syncLocalButtons();
  publishMediaState();
});

el.screenBtn.addEventListener('click', () => toggleScreenShare());
el.fxBtn.addEventListener('click', () => toggleFxStrip());
el.statsBtn.addEventListener('click', () => {
  renderStats();
  openModal(el.statsModal);
});

el.fxStrip?.querySelectorAll('.fx-opt').forEach((opt) => {
  opt.addEventListener('click', () => applyFx(opt.dataset.fx));
});

el.chatBtn.addEventListener('click', () => toggleChat());
el.chatClose.addEventListener('click', () => toggleChat(false));

el.ttsBtn.addEventListener('click', () => {
  const next = !state.settings.tts;
  state.settings = saveSettings({ tts: next });
  el.ttsBtn.classList.toggle('is-on', next);
  if (el.optTts) el.optTts.checked = next;
  if (next) speechSynthesis?.cancel?.();
  toast(next ? 'Входящие сообщения будут озвучиваться.' : 'Озвучка выключена.', { tone: 'info', ms: 2200 });
});

el.chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = el.chatInput.value.trim();
  if (!text) return;
  signaling.send({ type: 'chat', text });
  addMessage(text, true);
  showCaption(text, true);
  bumpStat('messages');
  el.chatInput.value = '';
});

el.reportBtn.addEventListener('click', () => {
  if (state.phase !== 'call') return toast('Жалоба доступна только во время разговора.', { tone: 'warn' });
  openModal(el.reportModal);
});

el.reportModal.querySelectorAll('.report-opt').forEach((btn) => {
  btn.addEventListener('click', () => submitReport(btn.dataset.reason));
});

/** Отправить жалобу и сразу свернуть разговор. */
function submitReport(reason) {
  signaling.send({ type: 'report', reason });
  bumpStat('reports');
  finishCall();
  closeModals();
  teardownPeer();
  clearChat();
  setPhase('landing');
}

el.fullBtn.addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else document.documentElement.requestFullscreen?.().catch(() => {});
});

/* -------------------------------------------------- подбор и настройки */

el.prefsToggle.addEventListener('click', () => {
  const open = el.prefsBox.dataset.open === '1';
  el.prefsBox.dataset.open = open ? '0' : '1';
  el.prefsToggle.textContent = open ? 'настроить' : 'свернуть';
  el.prefsToggle.setAttribute('aria-expanded', String(!open));
  if (!open && state.settings.mode === 'random') {
    toast('Подбор по интересам включается кнопкой «По интересам».', { tone: 'info', ms: 3000 });
  }
});

document.querySelectorAll('.mode-opt').forEach((opt) => {
  opt.addEventListener('click', () => {
    state.settings = saveSettings({ mode: opt.dataset.mode });
    syncPrefsUi();
    pushPrefs();
  });
});

el.require18.addEventListener('change', () => {
  state.settings = saveSettings({ require18Plus: el.require18.checked });
  pushPrefs();
});

el.nearbyOnly.addEventListener('change', () => {
  state.settings = saveSettings({ region: el.nearbyOnly.checked ? 'local' : '' });
  pushPrefs();
});

el.themeBtn.addEventListener('click', () => {
  applyTheme(state.settings.theme === 'light' ? 'dark' : 'light');
});

el.themeSeg?.querySelectorAll('.seg-opt').forEach((opt) => {
  opt.addEventListener('click', () => applyTheme(opt.dataset.theme));
});

el.settingsBtn.addEventListener('click', () => {
  refreshDevices();
  openModal(el.settingsModal);
});
el.settingsClose.addEventListener('click', () => closeModals());
el.settingsOk.addEventListener('click', () => closeModals());
el.settingsReset.addEventListener('click', () => {
  resetStats();
  renderStats();
  toast('Статистика сброшена.', { tone: 'ok' });
});

el.camSelect.addEventListener('change', () => onDeviceChange('video', el.camSelect.value));
el.micSelect.addEventListener('change', () => onDeviceChange('audio', el.micSelect.value));
el.qualitySelect.addEventListener('change', () => onQualityChange(el.qualitySelect.value));

el.optMirror.addEventListener('change', () => {
  state.settings = saveSettings({ mirror: el.optMirror.checked });
  setMirrored(el.localVideo, el.optMirror.checked && !state.screenSharing);
});

el.optTts.addEventListener('change', () => {
  state.settings = saveSettings({ tts: el.optTts.checked });
  el.ttsBtn.classList.toggle('is-on', el.optTts.checked);
});

el.optCaptions.addEventListener('change', () => {
  state.settings = saveSettings({ captions: el.optCaptions.checked });
  if (!el.optCaptions.checked) el.captionOverlay.hidden = true;
});

el.optReduceData.addEventListener('change', () => {
  state.settings = saveSettings({ reduceData: el.optReduceData.checked });
});

el.statsOpenBtn.addEventListener('click', () => {
  renderStats();
  openModal(el.statsModal);
});
el.statsClose.addEventListener('click', () => closeModals());
el.statsOk.addEventListener('click', () => closeModals());

/* ------------------------------------------------------------- комнаты */

el.roomsBtn.addEventListener('click', () => {
  renderRoomList();
  openModal(el.roomsModal);
});
el.roomsClose.addEventListener('click', () => closeModals());
el.roomsOk.addEventListener('click', () => closeModals());
el.roomSearch.addEventListener('input', () => {
  state.roomFilter = el.roomSearch.value;
  renderRoomList();
});

el.roomCreateForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const title = el.roomTitle.value.trim();
  if (!title) return toast('Введите название комнаты.', { tone: 'warn' });
  signaling.send({ type: 'room:create', title, topic: el.roomTopic.value || 'justchat' });
  el.roomTitle.value = '';
  closeModals();
});

el.roomForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = el.roomInput.value.trim();
  if (!text) return;
  signaling.send({ type: 'room:chat', text });
  addRoomLine(text, 'self');
  el.roomInput.value = '';
});

el.roomLeave.addEventListener('click', () => signaling.send({ type: 'room:leave' }));

el.roomInvite.addEventListener('click', () => {
  if (state.phase !== 'call') {
    toast('Пригласить можно только собеседника из текущего разговора.', { tone: 'warn' });
    return;
  }
  signaling.send({ type: 'room:invite' });
});

el.rulesBtn.addEventListener('click', () => openModal(el.rulesModal));
el.rulesClose.addEventListener('click', () => closeModals());
el.rulesOk.addEventListener('click', () => closeModals());
el.reportCancel.addEventListener('click', () => closeModals());
document.addEventListener('click', (e) => {
  if (e.target.classList?.contains('overlay')) closeModals();
});
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select')) return;
  if (e.key === 'Escape') {
    closeModals();
    toggleChat(false);
    toggleFxStrip(false);
    return;
  }
  const key = e.key.toLowerCase();
  const map = {
    m: () => el.micBtn.click(),
    v: () => el.camBtn.click(),
    d: () => el.screenBtn.click(),
    n: () => el.nextBtn.click(),
    c: () => toggleChat(),
    r: () => el.reportBtn.click(),
    f: () => el.fullBtn.click(),
    x: () => toggleFxStrip(),
    i: () => el.statsBtn.click(),
    s: () => el.settingsBtn.click(),
  };
  if (map[key]) {
    e.preventDefault();
    map[key]();
  }
});

function openModal(node) {
  if (!node) return;
  node.hidden = false;
  node.querySelector('button')?.focus();
}

function closeModals() {
  el.rulesModal.hidden = true;
  el.reportModal.hidden = true;
  el.settingsModal.hidden = true;
  el.statsModal.hidden = true;
  el.roomsModal.hidden = true;
}

window.addEventListener('beforeunload', () => {
  signaling.send({ type: 'queue:leave' });
  signaling.close();
  stopStream(state.stream);
});

/* -------------------------------------------------------- энергосбережение */

document.addEventListener('visibilitychange', () => {
  if (!state.settings.reduceData || !state.stream) return;
  const video = state.stream.getVideoTracks()[0];
  if (!video) return;
  // В фоне видео не нужно — экономим трафик и батарею.
  video.enabled = !document.hidden && state.camOn;
});

/* ------------------------------------------------------------------ старт */

async function loadCatalog() {
  try {
    const res = await fetch('/api/catalog');
    if (!res.ok) return;
    const data = await res.json();
    state.topics = Array.isArray(data.topics) ? data.topics : [];
    state.topicLabels = new Map(state.topics.map((t) => [t.id, t.label]));
    if (data.reasons && el.reportModal) {
      const grid = el.reportModal.querySelector('.report-grid');
      grid?.replaceChildren();
      // Сервер отдаёт причины картой id → подпись.
      for (const [id, label] of Object.entries(data.reasons)) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'report-opt';
        btn.dataset.reason = id;
        btn.textContent = label;
        btn.addEventListener('click', () => submitReport(id));
        grid?.append(btn);
      }
    }
    if (el.roomTopic) {
      el.roomTopic.replaceChildren();
      for (const topic of state.topics) {
        const opt = document.createElement('option');
        opt.value = topic.id;
        opt.textContent = `${topic.emoji} ${topic.label}`;
        el.roomTopic.append(opt);
      }
    }
    renderTopics();
  } catch {
    /* каталог не критичен — подбор всё равно работает */
  }
}

async function boot() {
  applyTheme(state.settings.theme);
  setPhase('landing');
  syncLocalButtons();
  applyFx(state.settings.fx);

  if (el.optMirror) el.optMirror.checked = Boolean(state.settings.mirror);
  if (el.optTts) el.optTts.checked = Boolean(state.settings.tts);
  if (el.optCaptions) el.optCaptions.checked = Boolean(state.settings.captions);
  if (el.optReduceData) el.optReduceData.checked = Boolean(state.settings.reduceData);
  if (el.ttsBtn) el.ttsBtn.classList.toggle('is-on', Boolean(state.settings.tts));
  if (el.qualitySelect) el.qualitySelect.value = String(state.settings.videoHeight || 720);
  el.chatInput.maxLength = state.maxMessageChars;
  if (el.roomInput) el.roomInput.maxLength = state.maxMessageChars;
  syncPrefsUi();

  try {
    const res = await fetch('/api/config');
    if (res.ok) {
      const cfg = await res.json();
      state.iceServers = cfg.iceServers || [];
      state.maxMessageChars = cfg.maxMessageChars || 500;
      state.accessMode = cfg.accessMode || 'open';
      state.features = { ...state.features, ...(cfg.features || {}) };
      el.versionTag.textContent = `beta · ${cfg.version || ''}`.trim();
      el.chatInput.maxLength = state.maxMessageChars;
      if (el.roomInput) el.roomInput.maxLength = state.maxMessageChars;
      if (el.screenBtn) el.screenBtn.hidden = !state.features.screenShare;
      if (el.roomsBtn) el.roomsBtn.hidden = !state.features.rooms;
    }
  } catch {
    /* dev-режим без API — не критично */
  }

  await loadCatalog();
  signaling.connect();
}

boot();
