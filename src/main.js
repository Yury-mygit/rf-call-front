import './style.css';
import { DisconnectReason } from 'livekit-client';
import { api } from './api.js';
import { call } from './call-controller.js';
import { emit, embedded, listen } from './bridge.js';
import { navigate, route } from './router.js';

const root = document.querySelector('#app');
let guestSession = null;
let guestEvents = null;
let ownerSession = null;
const esc = (value = '') => String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
const icon = (name) => ({
  audio: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 9v6h4l5 4V5L9 9H5Z"/><path d="M17 9a4 4 0 0 1 0 6M19.5 6.5a8 8 0 0 1 0 11"/></svg>',
  audioOff: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 9v6h4l5 4V5L9 9H5Z"/><path d="m18 9 4 4M22 9l-4 4"/></svg>',
  mic: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6"/></svg>',
  micOff: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 9v2a3 3 0 0 0 5.1 2.1M15 9V6a3 3 0 0 0-5.6-1.5M5 11a7 7 0 0 0 11.7 5.2M19 11a7 7 0 0 1-.4 2.3M12 18v3M9 21h6M3 3l18 18"/></svg>',
  screen: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4M9 11l3-3 3 3M12 8v6"/></svg>',
  screenOff: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4M9 8h6v5H9z"/></svg>',
  link: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1M14 11a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 12 20l1.1-1.1"/></svg>',
  leave: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 15.5a11 11 0 0 1 14 0M7.5 14l-2 4M16.5 14l2 4"/></svg>',
})[name];
const errorText = (error) => ({ missing_auth_identity: 'Войдите через RaftForge, чтобы управлять комнатами.', token_not_found: 'Ссылка недействительна.', token_revoked: 'Ссылка отозвана.', room_closed: 'Комната закрыта.' })[error.message] || 'Не удалось выполнить запрос.';

function diagnosticMarkup() {
  if (!call.diagnostics) return '';
  const firefoxRetry = /Firefox\//.test(navigator.userAgent) && call.icePolicy === 'relay' && call.failedDescriptor
    ? '<button type="button" data-direct-retry>Повторить с прямым соединением</button>'
    : '';
  return `<span class="diagnostic-actions"><button type="button" class="secondary" data-copy-diagnostics>Скопировать диагностику</button>${firefoxRetry}</span><small data-diagnostic-status>Отчёт не содержит токенов, IP-адресов или SDP.</small>`;
}

function wireDiagnostics(container) {
  const button = container.querySelector('[data-copy-diagnostics]');
  if (button) button.onclick = async () => {
    const status = container.querySelector('[data-diagnostic-status]');
    try {
      await navigator.clipboard.writeText(call.diagnostics);
      status.textContent = 'Диагностика скопирована.';
    } catch {
      status.textContent = 'Копирование заблокировано. Откройте консоль: CALL ICE DIAGNOSTIC.';
      console.info('CALL ICE DIAGNOSTIC', call.diagnostics);
    }
  };
  const retry = container.querySelector('[data-direct-retry]');
  if (retry) retry.onclick = async () => {
    const descriptor = call.failedDescriptor;
    const status = container.querySelector('[data-diagnostic-status]');
    retry.disabled = true;
    status.textContent = 'Проверяем прямое ICE-соединение…';
    try {
      await call.connect(descriptor, { icePolicy: 'all' });
      navigate(`/room/${descriptor.room_id}`);
    } catch (error) {
      container.innerHTML = `<span>${esc(errorText(error))}</span>${diagnosticMarkup()}`;
      wireDiagnostics(container);
    }
  };
}

async function copyIssuedLink(input, status) {
  input.focus();
  input.select();
  try {
    if (!embedded && navigator.clipboard) {
      await navigator.clipboard.writeText(input.value);
    } else if (!document.execCommand('copy')) {
      throw new Error('copy_blocked');
    }
    status.textContent = 'Скопировано.';
  } catch {
    status.textContent = 'Копирование заблокировано браузером — ссылка выделена, нажмите Ctrl/Cmd+C.';
  }
}

async function copyRoomLink(button, status) {
  button.disabled = true;
  status.textContent = 'Готовим ссылку…';
  try {
    let url;
    if (guestSession) {
      url = `${location.origin}${guestPath(guestSession.token)}`;
    } else {
      const token = await api.issueToken(call.descriptor.room_id, { can_publish_audio: true, can_publish_video: false, can_share_screen: true });
      url = `${location.origin}/j/${token.token}`;
    }
    status.innerHTML = `<input class="room-link-fallback" aria-label="Ссылка на комнату" readonly value="${esc(url)}"><small data-room-copy-status>Можно скопировать вручную.</small>`;
    await copyIssuedLink(status.querySelector('input'), status.querySelector('[data-room-copy-status]'));
  } catch {
    status.textContent = 'Не удалось создать ссылку. Попробуйте ещё раз.';
  } finally {
    button.disabled = false;
  }
}

function guestPath(token) { return `/j/${encodeURIComponent(token)}`; }

function closeGuestEvents() {
  guestEvents?.close();
  guestEvents = null;
}

function watchGuestState(token) {
  closeGuestEvents();
  guestEvents = new EventSource(`/api/call/v1/join/${encodeURIComponent(token)}/events`);
  guestEvents.addEventListener('state', (event) => {
    const state = JSON.parse(event.data).state;
    if (state === 'active') return;
    closeGuestEvents();
    guestSession.state = state === 'room_closed' ? 'ended' : 'unavailable';
    history.replaceState({ guestReturn: true, displayName: guestSession.displayName }, '', guestPath(token));
    guestView(token);
  });
}

function shell(title, body, homePath = '/') {
  const brand = homePath ? `<a class="brand" href="${esc(homePath)}" data-link>CALL</a>` : '<span class="brand">CALL</span>';
  root.innerHTML = `<header>${brand}<span>${embedded ? 'RaftForge' : 'standalone'}</span></header><main><section class="hero"><p class="eyebrow">Защищённая видеосвязь</p><h1>${esc(title)}</h1></section>${body}</main><div id="audio-sink"></div>`;
  root.querySelectorAll('[data-link]').forEach((el) => el.addEventListener('click', (event) => { event.preventDefault(); navigate(el.getAttribute('href')); }));
}

async function ownerView() {
  closeGuestEvents();
  shell('Ваши комнаты', `<form id="create" class="panel row"><input name="name" required maxlength="200" placeholder="Название комнаты"><button>Создать</button></form><div id="notice"></div><div id="rooms" class="grid"><article class="panel">Загрузка…</article></div>`);
  const notice = root.querySelector('#notice');
  try {
    const rooms = await api.rooms();
    const activeRooms = rooms.filter((room) => room.status === 'active');
    root.querySelector('#rooms').innerHTML = activeRooms.length ? activeRooms.map((room) => `<article class="panel room"><div><small>${esc(room.human_id)}</small><h2>${esc(room.name)}</h2><span class="status">${esc(room.status)}</span></div><div class="actions"><button data-join="${room.id}">Войти</button><button class="secondary" data-link-token="${room.id}">Ссылка</button><button class="danger" data-close="${room.id}">Закрыть</button></div></article>`).join('') : '<article class="panel empty">Создайте первую комнату — постоянную ссылку можно отозвать в любой момент.</article>';
  } catch (error) { notice.innerHTML = `<p class="error">${errorText(error)}</p>`; root.querySelector('#rooms').innerHTML = ''; }
  root.querySelector('#create').addEventListener('submit', async (event) => { event.preventDefault(); try { await api.createRoom(new FormData(event.target).get('name')); ownerView(); } catch (error) { notice.innerHTML = `<p class="error">${errorText(error)}</p>`; } });
  root.querySelectorAll('[data-join]').forEach((button) => button.onclick = async () => { button.disabled = true; try { const descriptor = await api.ownerJoin(button.dataset.join); await enterRoom(descriptor); } catch (error) { notice.innerHTML = `<p class="error">${errorText(error)}</p>`; button.disabled = false; } });
  root.querySelectorAll('[data-link-token]').forEach((button) => button.onclick = async () => {
    try {
      const token = await api.issueToken(button.dataset.linkToken, { can_publish_audio: true, can_publish_video: false, can_share_screen: true });
      const url = `${location.origin}/j/${token.token}`;
      notice.innerHTML = `<div class="success"><strong>Ссылка создана.</strong><div class="copy-row"><input data-issued-link readonly value="${esc(url)}"><button type="button" data-copy-link>Копировать</button></div><small data-copy-status>Можно скопировать вручную.</small></div>`;
      const input = notice.querySelector('[data-issued-link]');
      input.focus();
      input.select();
      notice.querySelector('[data-copy-link]').onclick = () => copyIssuedLink(input, notice.querySelector('[data-copy-status]'));
    } catch (error) {
      notice.innerHTML = `<p class="error">${errorText(error)}</p>`;
    }
  });
  root.querySelectorAll('[data-close]').forEach((button) => button.onclick = async () => {
    if (button.dataset.armed !== 'true') {
      button.dataset.armed = 'true';
      button.textContent = 'Подтвердить закрытие';
      notice.innerHTML = '<p class="error">Повторно нажмите кнопку в течение 5 секунд. Все ссылки будут отозваны.</p>';
      setTimeout(() => {
        if (!button.isConnected || button.dataset.armed !== 'true') return;
        delete button.dataset.armed;
        button.textContent = 'Закрыть';
        notice.textContent = '';
      }, 5000);
      return;
    }
    button.disabled = true;
    try {
      await api.closeRoom(button.dataset.close);
      ownerView();
    } catch (error) {
      notice.innerHTML = `<p class="error">${errorText(error)}</p>`;
      button.disabled = false;
    }
  });
}

function guestView(token) {
  if (!guestSession || guestSession.token !== token) {
    guestSession = {
      token,
      displayName: history.state?.displayName || '',
      state: history.state?.guestReturn ? 'left' : 'ready',
    };
  }
  const path = guestPath(token);
  if (guestSession.state === 'ended') {
    shell('Конференция завершена', '<section class="panel empty"><p>Организатор закрыл комнату. Вернуться в этот звонок больше нельзя.</p></section>', path);
    return;
  }
  if (guestSession.state === 'unavailable') {
    shell('Ссылка недоступна', '<section class="panel empty"><p>Ссылка недействительна или была отозвана организатором.</p></section>', path);
    return;
  }
  if (guestSession.state === 'left' || guestSession.state === 'disconnected') {
    watchGuestState(token);
  } else {
    closeGuestEvents();
  }
  const returnNotice = guestSession.state === 'left' ? '<p class="success" role="status">Вы вышли из звонка. Пока конференция продолжается, можно вернуться.</p>' : (guestSession.state === 'disconnected' ? '<p class="error" role="status">Связь прервалась. Попробуйте войти снова.</p>' : '');
  shell('Войти в комнату', `${returnNotice}<form id="guest" class="panel stack"><label>Как вас представить?<input name="displayName" required maxlength="200" autocomplete="name" autofocus value="${esc(guestSession.displayName)}"></label><button>${guestSession.state === 'ready' ? 'Продолжить' : 'Вернуться'}</button><p id="notice"></p></form>`, path);
  root.querySelector('#guest').onsubmit = async (event) => {
    event.preventDefault();
    const button = event.target.querySelector('button');
    const displayName = new FormData(event.target).get('displayName');
    button.disabled = true;
    guestSession.displayName = displayName;
    try {
      closeGuestEvents();
      const descriptor = await api.guestJoin(token, displayName);
      guestSession.state = 'connected';
      await enterRoom(descriptor, true);
    } catch (error) {
      if (error.message === 'room_closed' || error.message === 'token_revoked' || error.message === 'token_not_found') {
        guestSession.state = error.message === 'room_closed' ? 'ended' : 'unavailable';
        guestView(token);
        return;
      }
      root.querySelector('#notice').className = 'error';
      root.querySelector('#notice').innerHTML = `<span>${esc(errorText(error))}</span>${diagnosticMarkup()}`;
      wireDiagnostics(root.querySelector('#notice'));
      button.disabled = false;
    }
  };
}

async function enterRoom(descriptor, asGuest = false) {
  closeGuestEvents();
  if (!asGuest) {
    guestSession = null;
    ownerSession = { roomId: descriptor.room_id, reconnecting: false };
  }
  await call.connect(descriptor);
  navigate(`/room/${descriptor.room_id}`);
  emit('shell.navigate', { to: `/call/${descriptor.room_id}` });
}

async function leaveRoom() {
  const returningGuest = guestSession;
  ownerSession = null;
  await call.leave();
  if (returningGuest) {
    returningGuest.state = 'left';
    navigate(guestPath(returningGuest.token), {
      state: { guestReturn: true, displayName: returningGuest.displayName },
    });
  } else {
    navigate('/');
  }
}

async function reconnectOwner() {
  if (!ownerSession || ownerSession.reconnecting) return;
  ownerSession.reconnecting = true;
  const { roomId } = ownerSession;
  shell('Восстанавливаем звонок', '<section class="panel empty"><p>Соединение прервалось. Повторно подключаемся к комнате…</p></section>', null);
  for (const delay of [0, 1000, 2500]) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    if (!ownerSession || ownerSession.roomId !== roomId) return;
    try {
      const descriptor = await api.ownerJoin(roomId);
      await call.connect(descriptor);
      ownerSession.reconnecting = false;
      navigate(`/room/${roomId}`, { replace: true });
      return;
    } catch {
      // A fresh descriptor is requested for every attempt; media tokens are
      // intentionally short lived and must not be cached across reconnects.
    }
  }
  ownerSession = null;
  navigate('/', { replace: true });
}

function roomView() {
  if (!call.room) { shell('Звонок не подключён', `<section class="panel empty"><p>После перезагрузки защищённый media token не сохраняется.</p><a class="button" href="/" data-link>На главную</a></section>`); return; }
  const participant = call.room.localParticipant;
  const screenShare = call.screenShare();
  const participants = call.participants();
  const participantCards = participants.map((item) => `<li class="participant-card"><span class="participant-name">${esc(item.name)}</span>${item.local ? '<small>Вы</small>' : ''}</li>`).join('');
  const participantPanel = `<aside class="participants-panel" aria-label="Участники созвона"><div class="participants-heading"><strong>Участники</strong><span aria-label="Количество участников">${participants.length}</span></div><ul class="participant-list">${participantCards}</ul></aside>`;
  const roomLabel = `<div class="room-label" aria-label="Комната ${esc(call.descriptor.room_human_id)}">${esc(call.descriptor.room_human_id)}</div>`;
  const audioEnabled = call.room.canPlaybackAudio && !call.outputMuted;
  const audioLabel = audioEnabled ? 'Выключить звук собеседников' : 'Включить звук собеседников';
  const micLabel = participant.isMicrophoneEnabled ? 'Выключить микрофон' : 'Включить микрофон';
  const shareBusy = Boolean(screenShare && !screenShare.local);
  const canShareScreen = call.canShareScreen();
  const screenLabel = participant.isScreenShareEnabled ? 'Остановить демонстрацию' : (shareBusy ? 'Другой участник показывает экран' : 'Показать экран');
  const screenControl = canShareScreen ? `<button type="button" id="screen" class="control-button${participant.isScreenShareEnabled ? ' active' : ''}" aria-label="${screenLabel}" title="${screenLabel}" aria-pressed="${participant.isScreenShareEnabled}" ${!call.descriptor.capabilities.can_share_screen || call.pending.screen || shareBusy ? 'disabled' : ''}>${icon(participant.isScreenShareEnabled ? 'screenOff' : 'screen')}</button>` : '';
  const controls = `<div class="controls" aria-label="Управление звонком"><button type="button" id="audio" class="control-button${audioEnabled ? ' active' : ''}" aria-label="${audioLabel}" title="${audioLabel}" aria-pressed="${audioEnabled}">${icon(audioEnabled ? 'audio' : 'audioOff')}</button><button type="button" id="mic" class="control-button${participant.isMicrophoneEnabled ? ' active' : ''}" aria-label="${micLabel}" title="${micLabel}" aria-pressed="${participant.isMicrophoneEnabled}" ${!call.descriptor.capabilities.can_publish_audio || call.pending.mic ? 'disabled' : ''}>${icon(participant.isMicrophoneEnabled ? 'mic' : 'micOff')}</button>${screenControl}</div>`;
  const roomActions = `<div class="room-actions" aria-label="Действия комнаты"><button type="button" id="room-link" class="control-button" aria-label="Скопировать ссылку на комнату" title="Скопировать ссылку на комнату">${icon('link')}</button><button type="button" id="leave" class="control-button danger" aria-label="Выйти из звонка" title="Выйти из звонка">${icon('leave')}</button></div><div class="room-action-status" role="status" aria-live="polite"></div>`;
  const mediaNotice = call.error ? `<p class="error" role="alert">${esc(call.error)}</p>` : (call.status ? `<p class="success" role="status">${esc(call.status)}</p>` : '');
  const localShareNotice = screenShare?.local ? '<div class="local-share-notice">Предпросмотр демонстрации</div>' : '';
  const stageClass = screenShare ? ` sharing${screenShare.local ? ' local-preview' : ''}` : (call.screenClosing ? ' closing' : '');
  shell(call.descriptor.room_human_id, `<section class="call-shell"><div class="stage-wrap"><div id="stage-media" class="stage${stageClass}" aria-hidden="${screenShare ? 'false' : 'true'}">${localShareNotice}</div>${roomLabel}${participantPanel}${controls}${roomActions}</div>${mediaNotice}</section>`, null);
  root.querySelector('header').remove();
  root.querySelector('.hero').remove();
  root.querySelector('main').classList.add('call-main');
  root.querySelector('#audio').onclick = async () => call.toggleAudio();
  root.querySelector('#mic').onclick = async () => call.toggleMic();
  const screenButton = root.querySelector('#screen');
  if (screenButton) screenButton.onclick = async () => call.toggleScreen();
  root.querySelector('#room-link').onclick = (event) => copyRoomLink(event.currentTarget, root.querySelector('.room-action-status'));
  root.querySelector('#leave').onclick = leaveRoom;
  queueMicrotask(() => call.mountMedia());
}

function render() { const current = route(); if (current.name === 'guest') guestView(current.token); else if (current.name === 'room') roomView(); else ownerView(); }
addEventListener('popstate', render);
call.addEventListener('change', () => {
  if (route().name !== 'room') return;
  if (!call.room && guestSession) {
    guestSession.state = call.disconnectReason === DisconnectReason.ROOM_DELETED ? 'ended' : 'disconnected';
    navigate(guestPath(guestSession.token), {
      replace: true,
      state: { guestReturn: true, displayName: guestSession.displayName },
    });
    return;
  }
  if (!call.room && ownerSession) {
    reconnectOwner();
    return;
  }
  roomView();
});
listen((type, payload) => { if (type === 'shell.pill_action' && payload.action_id === 'mute') call.toggleMic(); if (type === 'shell.pill_action' && payload.action_id === 'leave') leaveRoom(); if (type === 'shell.navigate_frame' && payload.path) navigate(payload.path); });
render();
