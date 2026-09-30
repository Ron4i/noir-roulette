/**
 * WebRTC-слой: один PeerConnection на одну пару, пересоздаётся на каждом «Далее».
 * Сигнал (SDP/ICE) проксируется сервером, медиапотоки идут напрямую P2P.
 */
export class Peer extends EventTarget {
  /** @param {{iceServers: RTCIceServer[]}} options */
  constructor({ iceServers }) {
    super();
    this.iceServers = iceServers?.length ? iceServers : [{ urls: 'stun:stun.l.google.com:19302' }];
    /** @type {RTCPeerConnection|null} */
    this.pc = null;
    this.localStream = null;
    this.remoteStream = new MediaStream();
    this.makingOffer = false;
    this.ignoreOffer = false;
    /** Активный видеотрек камеры: по нему всегда можно вернуться с экрана. */
    this.cameraTrack = null;
    /** Текущий видеотрек в эфире (камера или экран). */
    this.outgoingVideo = null;
    this.screenSharing = false;
    this.statsTimer = null;
    this.prevStats = null;
  }

  create() {
    this.close();
    this.pc = new RTCPeerConnection({ iceServers: this.iceServers, bundlePolicy: 'max-bundle' });
    this.remoteStream = new MediaStream();

    this.pc.ontrack = (e) => {
      for (const stream of [e.streams?.[0], this.remoteStream]) {
        if (stream && !stream.getTracks().includes(e.track)) stream.addTrack(e.track);
      }
      this.emit('track', { track: e.track, stream: this.remoteStream });
    };

    this.pc.onicecandidate = (e) => {
      if (e.candidate) this.emit('signal', { kind: 'ice', candidate: e.candidate.toJSON() });
    };

    this.pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await this.pc.setLocalDescription();
        this.emit('signal', { kind: 'offer', sdp: this.pc.localDescription });
      } catch (err) {
        this.emit('error', { error: err });
      } finally {
        this.makingOffer = false;
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      const state = this.pc?.iceConnectionState;
      this.emit('ice', { state });
      if (state === 'failed') this.emit('failed', {});
    };

    this.pc.onconnectionstatechange = () => {
      const state = this.pc?.connectionState;
      this.emit('conn', { state });
      if (state === 'failed') this.emit('failed', {});
    };

    this.prevStats = null;
    this.startStats();
    return this.pc;
  }

  /** @param {MediaStream} stream */
  async setLocalStream(stream) {
    this.localStream = stream;
    const pc = this.pc || this.create();
    for (const track of stream.getTracks()) {
      if (track.kind === 'video' && !this.cameraTrack) this.cameraTrack = track;
      if (track.kind === 'video' && !this.screenSharing) this.outgoingVideo = track;
      const already = pc.getSenders().some((s) => s.track === track);
      if (!already) pc.addTrack(track, stream);
    }
  }

  /** Отправитель по типу дорожки — нужен для replaceTrack при смене устройства. */
  senderFor(kind) {
    return this.pc?.getSenders().find((s) => s.track?.kind === kind) || null;
  }

  /**
   * Включить или выключить демонстрацию экрана.
   * Экран подменяет дорожку камеры через replaceTrack, поэтому пересогласование не нужно.
   * @param {boolean} on
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  async setScreenShare(on) {
    if (on === this.screenSharing) return { ok: true };

    if (on) {
      if (!navigator.mediaDevices?.getDisplayMedia) {
        return { ok: false, error: 'Браузер не умеет показывать экран.' };
      }
      let display;
      try {
        display = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: { ideal: 15, max: 30 } },
          audio: false,
        });
      } catch (err) {
        // Пользователь нажал «Отмена» — это не ошибка, а обычное завершение.
        if (err?.name === 'NotAllowedError') return { ok: false, cancelled: true };
        return { ok: false, error: 'Не удалось получить доступ к экрану.' };
      }

      const screenTrack = display.getVideoTracks()[0];
      if (!screenTrack) {
        for (const t of display.getTracks()) t.stop();
        return { ok: false, error: 'Экран не дал видеодорожку.' };
      }

      const sender = this.senderFor('video');
      if (!sender) {
        for (const t of display.getTracks()) t.stop();
        return { ok: false, error: 'Соединение ещё не установлено.' };
      }

      await sender.replaceTrack(screenTrack);
      this.outgoingVideo = screenTrack;
      this.screenSharing = true;

      // «Стоп» в панели браузера тоже должен выключать демонстрацию.
      screenTrack.addEventListener('ended', () => {
        this.setScreenShare(false).catch(() => {});
      });
      this.emit('screen', { on: true });
      return { ok: true };
    }

    // Выключаем экран: возвращаем камеру, если она ещё жива.
    if (!this.cameraTrack || this.cameraTrack.readyState === 'ended') {
      this.screenSharing = false;
      this.outgoingVideo = null;
      this.emit('screen', { on: false });
      return { ok: false, error: 'Камера недоступна, вернитесь к видео.' };
    }
    const sender = this.senderFor('video');
    if (sender) await sender.replaceTrack(this.cameraTrack);
    this.outgoingVideo = this.cameraTrack;
    this.screenSharing = false;
    this.emit('screen', { on: false });
    return { ok: true };
  }

  /** Раз в секунду снимать метрики соединения и отдавать их подписчикам. */
  startStats(intervalMs = 1000) {
    this.stopStats();
    this.statsTimer = setInterval(() => {
      this.pollStats().catch(() => {});
    }, intervalMs);
  }

  stopStats() {
    clearInterval(this.statsTimer);
    this.statsTimer = null;
  }

  async pollStats() {
    const pc = this.pc;
    if (!pc || pc.connectionState === 'closed') return null;

    const report = { bitrateKbps: 0, rttMs: null, packetLoss: 0, quality: 'unknown' };
    let bytes = 0;
    let packets = 0;
    let lost = 0;

    const stats = await pc.getStats();
    stats.forEach((s) => {
      if (s.type === 'candidate-pair' && s.state === 'succeeded' && s.nominated !== false) {
        if (s.currentRoundTripTime != null) report.rttMs = Math.round(s.currentRoundTripTime * 1000);
      }
      if (s.type === 'inbound-rtp' && s.kind === 'video') {
        bytes += s.bytesReceived || 0;
        packets += s.packetsReceived || 0;
        lost += s.packetsLost || 0;
      }
    });

    if (this.prevStats) {
      const dBytes = bytes - this.prevStats.bytes;
      const dMs = Date.now() - this.prevStats.at;
      if (dMs > 0 && dBytes >= 0) report.bitrateKbps = Math.max(0, Math.round((dBytes * 8) / dMs));
    }
    this.prevStats = { bytes, at: Date.now() };

    const total = packets + lost;
    report.packetLoss = total > 0 ? Math.round((lost / total) * 100) : 0;
    report.quality = gradeQuality(report);
    this.emit('stats', report);
    return report;
  }

  /** Обработать сообщение из сигнального сервера. */
  async handleSignal(data) {
    const pc = this.pc;
    if (!pc) return;

    try {
      if (data.kind === 'offer') {
        const collision = this.makingOffer || pc.signalingState !== 'stable';
        this.ignoreOffer = !this.collideSafe(collision);
        if (this.ignoreOffer) return;
        await pc.setRemoteDescription(data.sdp);
        await pc.setAnswer();
        this.emit('signal', { kind: 'answer', sdp: pc.localDescription });
      } else if (data.kind === 'answer') {
        if (pc.signalingState !== 'have-local-offer') return;
        await pc.setRemoteDescription(data.sdp);
      } else if (data.kind === 'ice') {
        try {
          await pc.addIceCandidate(data.candidate);
        } catch (err) {
          if (!this.ignoreOffer) throw err;
        }
      }
    } catch (err) {
      this.emit('error', { error: err });
    }
  }

  /**
   * Безопасное разрешение «идеального негаotiation»-конфликта:
   * при коллизии офферов один узел откатывается и ждёт второй.
   */
  collideSafe(collision) {
    if (!collision) return true;
    this.ignoreOffer = true;
    return false;
  }

  close() {
    this.stopStats();
    this.screenSharing = false;
    this.outgoingVideo = null;
    if (this.pc) {
      this.pc.ontrack = null;
      this.pc.onicecandidate = null;
      this.pc.onnegotiationneeded = null;
      this.pc.oniceconnectionstatechange = null;
      this.pc.onconnectionstatechange = null;
      try {
        this.pc.close();
      } catch {
        /* already closed */
      }
      this.pc = null;
    }
    for (const track of this.remoteStream.getTracks()) track.stop();
    this.remoteStream = new MediaStream();
  }

  get state() {
    return this.pc?.iceConnectionState ?? 'closed';
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  on(type, handler) {
    this.addEventListener(type, (e) => handler(e.detail));
  }
}

/** Светофор качества связи: зелёный — ровно, жёлтый — терпимо, красный — стоит «Далее». */
export function gradeQuality({ bitrateKbps, rttMs, packetLoss }) {
  if (packetLoss > 8 || rttMs > 450) return 'bad';
  if (packetLoss > 3 || rttMs > 250) return 'fair';
  if (bitrateKbps === 0 && rttMs === null) return 'unknown';
  return 'good';
}
