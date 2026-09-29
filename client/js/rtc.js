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

    return this.pc;
  }

  /** @param {MediaStream} stream */
  async setLocalStream(stream) {
    if (!stream) return;
    this.localStream = stream;
    const pc = this.pc || this.create();
    for (const track of stream.getTracks()) {
      const already = pc.getSenders().some((s) => s.track === track);
      if (!already) pc.addTrack(track, stream);
    }
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
