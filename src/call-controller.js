import { DisconnectReason, Room, RoomEvent, Track } from 'livekit-client';
import { emit } from './bridge.js';

class CallController extends EventTarget {
  room = null;
  descriptor = null;
  startedAt = 0;
  timer = null;
  pending = { mic: false, screen: false };
  status = '';
  error = '';
  disconnectReason = null;
  diagnostics = null;
  diagnosticTimeline = [];
  failedDescriptor = null;
  icePolicy = 'relay';

  changed() { this.dispatchEvent(new Event('change')); }

  setStatus(status = '', error = '') {
    this.status = status;
    this.error = error;
    this.changed();
  }

  async connect(descriptor, { icePolicy = 'relay' } = {}) {
    await this.leave();
    this.disconnectReason = null;
    this.diagnostics = null;
    this.diagnosticTimeline = [];
    this.failedDescriptor = null;
    this.icePolicy = icePolicy;
    this.descriptor = descriptor;
    this.room = new Room({ adaptiveStream: true, dynacast: true });
    const connectingRoom = this.room;
    this.recordDiagnostic('connect:start');
    this.room.on(RoomEvent.SignalConnected, () => {
      this.recordDiagnostic('signal:connected');
      queueMicrotask(() => this.watchIceErrors());
    });
    this.room.on(RoomEvent.ConnectionStateChanged, (state) => this.recordDiagnostic(`room:${state}`));
    this.room.on(RoomEvent.TrackSubscribed, (track) => {
      this.changed();
      this.attach(track);
    });
    this.room.on(RoomEvent.TrackUnsubscribed, (track) => track.detach().forEach((el) => el.remove()));
    this.room.on(RoomEvent.LocalTrackPublished, () => this.changed());
    this.room.on(RoomEvent.LocalTrackUnpublished, () => this.changed());
    this.room.on(RoomEvent.TrackMuted, () => this.changed());
    this.room.on(RoomEvent.TrackUnmuted, () => this.changed());
    this.room.on(RoomEvent.Reconnecting, () => this.setStatus('Восстанавливаем связь…'));
    this.room.on(RoomEvent.Reconnected, () => this.setStatus('Связь восстановлена.'));
    this.room.on(RoomEvent.MediaDevicesError, (error) => this.setStatus('', this.deviceError(error)));
    this.room.on(RoomEvent.Disconnected, (reason) => this.finish(reason));
    const iceServers = descriptor.media_config.ice_servers.map((server) => ({
      urls: server.urls,
      ...(server.username ? { username: server.username } : {}),
      ...(server.credential ? { credential: server.credential } : {}),
    }));
    try {
      await this.room.connect(descriptor.media_endpoint, descriptor.media_token, {
        // Mobile/provider NATs observed during CL-6 smoke repeatedly broke the
        // direct UDP path and forced full LiveKit reconnects. CALL is a small
        // deployment, so prefer a stable coturn relay over direct-path savings.
        rtcConfig: { iceServers, iceTransportPolicy: icePolicy },
      });
    } catch (error) {
      this.recordDiagnostic(`connect:error:${error?.name || 'Error'}`);
      this.diagnostics = await this.buildDiagnostics(error, iceServers, connectingRoom);
      this.failedDescriptor = descriptor;
      throw error;
    }
    this.startedAt = Date.now();
    this.timer = setInterval(() => this.publishPill(), 1000);
    this.publishPill();
    this.setStatus('');
  }

  attach(track) {
    const target = track.kind === Track.Kind.Audio ? document.querySelector('#audio-sink') : document.querySelector('#stage-media');
    if (!target) return;
    const element = track.attach();
    element.autoplay = true;
    element.playsInline = true;
    target.append(element);
  }

  mountMedia() {
    if (!this.room) return;
    // Never attach local microphone tracks to the local audio sink. Doing so
    // creates self-monitoring and, with speakers enabled, an acoustic echo
    // loop. The stage/audio sink only renders subscribed remote media.
    const publications = [...this.room.remoteParticipants.values()]
      .flatMap((participant) => [...participant.trackPublications.values()]);
    publications.forEach((publication) => {
      const track = publication.track;
      if (!track) return;
      track.detach().forEach((element) => element.remove());
      this.attach(track);
    });
  }

  async toggleMic() {
    if (!this.room || !this.descriptor?.capabilities.can_publish_audio || this.pending.mic) return;
    this.pending.mic = true;
    this.setStatus('');
    try {
      await this.room.localParticipant.setMicrophoneEnabled(!this.room.localParticipant.isMicrophoneEnabled);
      this.publishPill();
    } catch (error) {
      this.setStatus('', this.deviceError(error));
    } finally {
      this.pending.mic = false;
      this.changed();
    }
  }

  async toggleScreen() {
    if (!this.room || !this.descriptor?.capabilities.can_share_screen || this.pending.screen) return;
    this.pending.screen = true;
    this.setStatus('');
    try {
      await this.room.localParticipant.setScreenShareEnabled(!this.room.localParticipant.isScreenShareEnabled);
    } catch (error) {
      this.setStatus('', this.deviceError(error));
    } finally {
      this.pending.screen = false;
      this.changed();
    }
  }

  async startAudio() { await this.room?.startAudio(); }

  recordDiagnostic(event) {
    this.diagnosticTimeline.push({ ms: performance.now(), event });
  }

  watchIceErrors() {
    const manager = this.room?.engine?.pcManager;
    for (const [target, transport] of [['publisher', manager?.publisher], ['subscriber', manager?.subscriber]]) {
      if (!transport) continue;
      transport.onIceCandidateError = (event) => {
        this.recordDiagnostic(`ice-error:${target}:${event.errorCode || 'unknown'}:${event.errorText || ''}`);
      };
    }
  }

  async buildDiagnostics(error, iceServers, diagnosticRoom = this.room) {
    const candidates = {};
    const transports = {};
    const manager = diagnosticRoom?.engine?.pcManager;
    for (const [target, transport] of [['publisher', manager?.publisher], ['subscriber', manager?.subscriber]]) {
      if (!transport) continue;
      transports[target] = {
        connection: transport.getConnectionState(),
        ice: transport.getICEConnectionState(),
        signaling: transport.getSignallingState(),
      };
      try {
        const stats = await transport.getStats();
        stats.forEach((stat) => {
          if (stat.type !== 'local-candidate' && stat.type !== 'remote-candidate') return;
          const key = [stat.type, stat.candidateType || 'unknown', stat.protocol || 'unknown', stat.relayProtocol || 'none'].join('/');
          candidates[key] = (candidates[key] || 0) + 1;
        });
      } catch {
        candidates[`${target}/stats-unavailable`] = 1;
      }
    }
    const started = this.diagnosticTimeline[0]?.ms || performance.now();
    return JSON.stringify({
      kind: 'call-ice-diagnostic-v1',
      browser: navigator.userAgent.replace(/\([^)]*\)/g, '(platform)'),
      error: { name: error?.name || 'Error', message: String(error?.message || error).slice(0, 240) },
      policy: this.icePolicy,
      iceServers: iceServers.flatMap((server) => server.urls).map((url) => {
        const value = String(url).toLowerCase();
        return {
          scheme: value.split(':', 1)[0] || 'unknown',
          transport: value.includes('transport=tcp') ? 'tcp' : (value.includes('transport=udp') ? 'udp' : 'default'),
        };
      }),
      timeline: this.diagnosticTimeline.map(({ ms, event }) => ({ after_ms: Math.round(ms - started), event })),
      transports,
      candidates,
    }, null, 2);
  }

  async leave() {
    if (this.room) await this.room.disconnect(true);
    this.finish(DisconnectReason.CLIENT_INITIATED);
  }

  finish(reason) {
    clearInterval(this.timer);
    this.timer = null;
    if (reason !== undefined) this.disconnectReason = reason;
    this.room = null;
    this.descriptor = null;
    this.pending = { mic: false, screen: false };
    this.status = '';
    this.error = '';
    document.querySelectorAll('#audio-sink audio, #stage-media video').forEach((el) => el.remove());
    emit('shell.pill', { hidden: true });
    this.changed();
  }

  deviceError(error) {
    if (error?.name === 'NotAllowedError') return 'Браузер не дал доступ к микрофону или экрану.';
    if (error?.name === 'NotFoundError') return 'Медиаустройство не найдено.';
    return 'Не удалось изменить состояние медиа. Проверьте разрешения браузера.';
  }

  publishPill() {
    if (!this.room) return;
    const seconds = Math.floor((Date.now() - this.startedAt) / 1000);
    emit('shell.pill', {
      icon: 'phone',
      text: `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`,
      actions: [{ id: 'mute', icon: this.room.localParticipant.isMicrophoneEnabled ? 'mic' : 'mic-off' }, { id: 'leave', icon: 'phone-off' }],
    });
  }
}

export const call = new CallController();
