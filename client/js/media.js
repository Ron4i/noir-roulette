/** Понятные тексты вместо кодов MediaDevices-ошибок. */
const ERROR_HINTS = {
  NotAllowedError: 'Доступ к камере или микрофону запрещён. Разрешите его в настройках браузера.',
  PermissionDeniedError: 'Браузер запретил доступ к камере или микрофону.',
  NotFoundError: 'Камера или микрофон не найдены. Подключите устройство и попробуйте снова.',
  DevicesNotFoundError: 'Камера или микрофон не найдены.',
  NotReadableError: 'Устройство занято другим приложением.',
  TrackStartError: 'Не удалось запустить камеру или микрофон.',
  OverconstrainedError: 'Настройки камеры не поддерживаются устройством.',
  AbortError: 'Запуск камеры прерван.',
  SecurityError: 'Браузер запретил доступ: нужен HTTPS или localhost.',
  InsecureContext: 'Соединение не защищено. Откройте сайт по HTTPS.',
  NotSupportedError: 'Браузер не поддерживает доступ к камере и микрофону.',
};

export function mediaErrorText(err) {
  const name = err?.name || '';
  if (ERROR_HINTS[name]) return ERROR_HINTS[name];
  if (name === 'TypeError') {
    return 'Браузер не поддерживает getUserMedia. Попробуйте Chrome, Edge или Firefox.';
  }
  return `Не удалось получить доступ к устройствам (${name || 'ошибка'}).`;
}

export function isSecureEnough() {
  return window.isSecureContext || location.hostname === 'localhost';
}

/**
 * Получить локальный поток. `video` может быть объектом с точными ограничениями
 * ({ deviceId, width, height, facingMode }) — так работает переключение устройств.
 * @param {{video?: boolean|object, audio?: boolean|object}} constraints
 * @returns {Promise<MediaStream>}
 */
export async function getUserMedia({ video = true, audio = true } = {}) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw Object.assign(new Error('unsupported'), { name: 'NotSupportedError' });
  }
  if (!isSecureEnough()) {
    throw Object.assign(new Error('insecure'), { name: 'SecurityError' });
  }
  return navigator.mediaDevices.getUserMedia({ video, audio });
}

/** Список доступных камер, микрофонов и динамиков. Пустые списки, если доступа нет. */
export async function listDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) {
    return { cameras: [], microphones: [], speakers: [] };
  }
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    const pick = (kind, fallback) =>
      all
        .filter((d) => d.kind === kind)
        .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `${fallback} ${i + 1}` }));
    return {
      cameras: pick('videoinput', 'Камера'),
      microphones: pick('audioinput', 'Микрофон'),
      speakers: pick('audiooutput', 'Динамик'),
    };
  } catch {
    return { cameras: [], microphones: [], speakers: [] };
  }
}

export function stopStream(stream) {
  if (!stream) return;
  for (const track of stream.values()) {
    try {
      track.stop();
    } catch {
      /* track already stopped */
    }
  }
}

export function toggleTrack(track, enabled) {
  if (!track) return enabled;
  track.enabled = enabled;
  return track.enabled;
}

/**
 * Переключить камеру или микрофон на живой дорожке, без пересоздания потока.
 * Прежний трек освобождается только после успешного получения нового.
 * @param {MediaStream} stream
 * @param {'video'|'audio'} kind
 * @param {string} deviceId
 * @param {RTCRtpSender|null} sender отправитель в RTCPeerConnection, если он есть
 * @returns {Promise<{ok: boolean, stream?: MediaStream, track?: MediaStreamTrack, error?: string}>}
 */
export async function switchDevice(stream, kind, deviceId, sender = null) {
  if (!stream) return { ok: false, error: 'Нет активного потока.' };
  const exact = { deviceId: { exact: deviceId } };
  try {
    const fresh = await getUserMedia({
      video: kind === 'video' ? exact : false,
      audio: kind === 'audio' ? exact : false,
    });
    const newTrack = kind === 'video' ? fresh.getVideoTracks()[0] : fresh.getAudioTracks()[0];
    if (!newTrack) throw Object.assign(new Error('no track'), { name: 'NotFoundError' });

    // Сохраняем прежнее состояние mute — переключение не должно «включать звук» молча.
    const old = stream.getTracks().filter((t) => t.kind === kind);
    if (old.length) newTrack.enabled = old[0].enabled;

    // Замена дорожки у отправителя не требует пересогласования.
    if (sender) await sender.replaceTrack(newTrack);

    for (const t of old) {
      stream.removeTrack(t);
      try {
        t.stop();
      } catch {
        /* уже остановлен */
      }
    }
    stream.addTrack(newTrack);
    return { ok: true, stream, track: newTrack };
  } catch (err) {
    return { ok: false, error: mediaErrorText(err) };
  }
}

/**
 * Применить к живой видеодорожке новые ограничения (разрешение, кадры, зеркало).
 * @param {MediaStream} stream
 * @param {{width?:number,height?:number,frameRate?:number,facingMode?:string}} options
 */
export async function applyVideoQuality(stream, options = {}) {
  const track = stream?.getVideoTracks?.()[0];
  if (!track) return { ok: false, error: 'Камера не активна.' };
  const constraints = {};
  if (options.width && options.height) {
    constraints.width = { ideal: options.width };
    constraints.height = { ideal: options.height };
  }
  if (options.frameRate) constraints.frameRate = { ideal: options.frameRate };
  if (options.facingMode) constraints.facingMode = { ideal: options.facingMode };
  if (!Object.keys(constraints).length) return { ok: true, stream };
  try {
    await track.applyConstraints(constraints);
    return { ok: true, stream };
  } catch (err) {
    return { ok: false, error: mediaErrorText(err) };
  }
}

/** Разрешения, реально поддерживаемые камерой (best-effort, требует разрешения). */
export async function videoResolutions() {
  const all = [
    { label: '360p', width: 640, height: 360 },
    { label: '480p', width: 854, height: 480 },
    { label: '720p', width: 1280, height: 720 },
    { label: '1080p', width: 1920, height: 1080 },
  ];
  try {
    const cams = (await listDevices()).cameras;
    if (!cams.length) return all;
    const probe = await getUserMedia({ video: { deviceId: { exact: cams[0].deviceId } }, audio: false });
    const caps = probe.getVideoTracks()[0]?.getCapabilities?.();
    for (const t of probe.getTracks()) t.stop();
    if (!caps?.width?.max) return all;
    return all.filter((r) => caps.width.max >= r.width && caps.height.max >= r.height);
  } catch {
    return all;
  }
}

/** Зеркальное отражение — только для локального превью. */
export function setMirrored(videoEl, mirrored) {
  if (videoEl) videoEl.style.transform = mirrored ? 'scaleX(-1)' : 'none';
}
