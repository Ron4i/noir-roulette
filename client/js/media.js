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
 * @param {{video?: boolean, audio?: boolean}} constraints
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
