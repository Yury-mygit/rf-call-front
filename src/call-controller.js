import { DisconnectReason, Room, RoomEvent, Track } from 'livekit-client';
import { emit } from './bridge.js';
import { api } from './api.js';

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
  outputMuted = false;
  screenClosing = false;
  screenCloseTimer = null;

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
    this.room.on(RoomEvent.TrackUnsubscribed, (track) => {
      track.detach().forEach((el) => el.remove());
      if (track.source === Track.Source.ScreenShare) this.beginScreenClose();
      else this.changed();
    });
    this.room.on(RoomEvent.LocalTrackPublished, (publication) => {
      if (publication.source === Track.Source.ScreenShare) {
        this.status = '';
        this.error = '';
      }
      this.changed();
    });
    this.room.on(RoomEvent.LocalTrackUnpublished, (publication) => {
      if (publication.source === Track.Source.ScreenShare) {
        this.releaseScreenClaim();
        this.beginScreenClose();
      } else {
        this.changed();
      }
    });
    this.room.on(RoomEvent.TrackMuted, () => this.changed());
    this.room.on(RoomEvent.TrackUnmuted, () => this.changed());
    this.room.on(RoomEvent.ParticipantConnected, () => this.changed());
    this.room.on(RoomEvent.ParticipantDisconnected, () => this.changed());
    this.room.on(RoomEvent.ParticipantNameChanged, () => this.changed());
    this.room.on(RoomEvent.AudioPlaybackStatusChanged, () => this.changed());
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
    if (track.kind === Track.Kind.Audio) element.muted = this.outputMuted;
    if (track.kind === Track.Kind.Video) {
      element.addEventListener('loadedmetadata', () => {
        if (!element.videoWidth || !element.videoHeight) return;
        target.style.setProperty('--share-ratio', String(element.videoWidth / element.videoHeight));
      });
    }
    target.append(element);
  }

  mountMedia() {
    if (!this.room) return;
    // Never attach local microphone tracks to the local audio sink. Doing so
    // creates self-monitoring and, with speakers enabled, an acoustic echo
    // loop. The stage/audio sink only renders subscribed remote media.
    const localScreen = [...this.room.localParticipant.trackPublications.values()]
      .filter((publication) => publication.source === Track.Source.ScreenShare);
    const publications = [
      ...localScreen,
      ...[...this.room.remoteParticipants.values()]
        .flatMap((participant) => [...participant.trackPublications.values()]),
    ];
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
    if (!this.room || !this.descriptor?.capabilities.can_share_screen || !this.canShareScreen() || this.pending.screen) return;
    const enabling = !this.room.localParticipant.isScreenShareEnabled;
    this.pending.screen = true;
    this.setStatus('');
    try {
      if (enabling) {
        await api.setScreenShare(this.descriptor.room_id, this.descriptor.control_token, true);
      }
      await this.room.localParticipant.setScreenShareEnabled(enabling);
      if (!enabling) {
        await api.setScreenShare(this.descriptor.room_id, this.descriptor.control_token, false);
      }
    } catch (error) {
      const publishedDespiteError = enabling && this.room?.localParticipant.isScreenShareEnabled;
      if (enabling && !publishedDespiteError) {
        await api.setScreenShare(this.descriptor.room_id, this.descriptor.control_token, false).catch(() => {});
      }
      if (publishedDespiteError) {
        this.setStatus('');
      } else {
        console.warn('CALL media operation failed', { name: error?.name, message: error?.message });
        this.setStatus('', error?.message === 'screen_share_busy' ? 'Другой участник уже показывает экран.' : this.deviceError(error));
      }
    } finally {
      this.pending.screen = false;
      this.changed();
    }
  }

  canShareScreen() {
    return typeof navigator.mediaDevices?.getDisplayMedia === 'function';
  }

  async toggleAudio() {
    if (!this.room) return;
    if (this.outputMuted || !this.room.canPlaybackAudio) {
      await this.room.startAudio();
      this.outputMuted = false;
    } else {
      this.outputMuted = true;
    }
    document.querySelectorAll('#audio-sink audio').forEach((element) => {
      element.muted = this.outputMuted;
    });
    this.changed();
  }

  participants() {
    if (!this.room) return [];
    const local = this.room.localParticipant;
    const remote = [...this.room.remoteParticipants.values()]
      .map((participant) => ({ name: participant.name?.trim() || 'Участник', local: false }))
      .sort((left, right) => left.name.localeCompare(right.name, 'ru'));
    return [{ name: local.name?.trim() || 'Вы', local: true }, ...remote];
  }

  screenShare() {
    if (!this.room) return null;
    const local = [...this.room.localParticipant.trackPublications.values()]
      .find((publication) => publication.source === Track.Source.ScreenShare && publication.track);
    if (local) return { publication: local, local: true };
    for (const participant of this.room.remoteParticipants.values()) {
      const publication = [...participant.trackPublications.values()]
        .find((item) => item.source === Track.Source.ScreenShare && item.track);
      if (publication) return { publication, local: false };
    }
    return null;
  }

  async releaseScreenClaim() {
    if (!this.descriptor) return;
    await api.setScreenShare(
      this.descriptor.room_id,
      this.descriptor.control_token,
      false,
    ).catch(() => {});
  }

  beginScreenClose() {
    clearTimeout(this.screenCloseTimer);
    this.screenClosing = true;
    this.changed();
    this.screenCloseTimer = setTimeout(() => {
      this.screenClosing = false;
      this.screenCloseTimer = null;
      this.changed();
    }, 420);
  }

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
    if (this.room?.localParticipant.isScreenShareEnabled && this.descriptor) {
      await this.releaseScreenClaim();
    }
    if (this.room) await this.room.disconnect(true);
    this.finish(DisconnectReason.CLIENT_INITIATED);
  }

  finish(reason) {
    clearInterval(this.timer);
    clearTimeout(this.screenCloseTimer);
    this.timer = null;
    if (reason !== undefined) this.disconnectReason = reason;
    this.room = null;
    this.descriptor = null;
    this.pending = { mic: false, screen: false };
    this.outputMuted = false;
    this.screenClosing = false;
    this.screenCloseTimer = null;
    this.status = '';
    this.error = '';
    document.querySelectorAll('#audio-sink audio, #stage-media video').forEach((el) => el.remove());
    emit('shell.pill', { hidden: true });
    this.changed();
  }

  deviceError(error) {
    if (error?.name === 'NotAllowedError') return 'Браузер не дал доступ к микрофону или экрану.';
    if (error?.name === 'NotFoundError') return 'Медиаустройство не найдено.';
    if (error?.name === 'AbortError') return 'Выбор экрана был отменён или прерван браузером.';
    if (error?.name === 'InvalidStateError') return 'Браузер не разрешил демонстрацию из текущей вкладки. Активируйте окно и повторите.';
    if (error?.name === 'NotReadableError') return 'Выбранный экран недоступен для захвата. Закройте другое приложение захвата и повторите.';
    if (error?.name === 'DeviceUnsupportedError') return 'Демонстрация экрана на этом устройстве не поддерживается.';
    const detail = error?.name || error?.message;
    return detail ? `Не удалось включить медиа (${String(detail).slice(0, 80)}).` : 'Не удалось изменить состояние медиа. Проверьте разрешения браузера.';
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
