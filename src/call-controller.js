import { Room, RoomEvent, Track } from 'livekit-client';
import { emit } from './bridge.js';

class CallController extends EventTarget {
  room = null;
  descriptor = null;
  startedAt = 0;
  timer = null;
  pending = { mic: false, screen: false };
  status = '';
  error = '';

  changed() { this.dispatchEvent(new Event('change')); }

  setStatus(status = '', error = '') {
    this.status = status;
    this.error = error;
    this.changed();
  }

  async connect(descriptor) {
    await this.leave();
    this.descriptor = descriptor;
    this.room = new Room({ adaptiveStream: true, dynacast: true });
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
    this.room.on(RoomEvent.Disconnected, () => this.finish());
    const iceServers = descriptor.media_config.ice_servers.map((server) => ({
      urls: server.urls,
      ...(server.username ? { username: server.username } : {}),
      ...(server.credential ? { credential: server.credential } : {}),
    }));
    await this.room.connect(descriptor.media_endpoint, descriptor.media_token, {
      // Mobile/provider NATs observed during CL-6 smoke repeatedly broke the
      // direct UDP path and forced full LiveKit reconnects. CALL is a small
      // deployment, so prefer a stable coturn relay over direct-path savings.
      rtcConfig: { iceServers, iceTransportPolicy: 'relay' },
    });
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

  async leave() {
    if (this.room) await this.room.disconnect(true);
    this.finish();
  }

  finish() {
    clearInterval(this.timer);
    this.timer = null;
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
