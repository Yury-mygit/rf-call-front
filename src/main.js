import './style.css';
import { DisconnectReason } from 'livekit-client';
import { api } from './api.js';
import { call } from './call-controller.js';
import { emit, embedded, listen } from './bridge.js';
import { navigate, route } from './router.js';

const root = document.querySelector('#app');
let guestSession = null;
let guestEvents = null;
const esc = (value = '') => String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
const errorText = (error) => ({ missing_auth_identity: 'Войдите через RaftForge, чтобы управлять комнатами.', token_not_found: 'Ссылка недействительна.', token_revoked: 'Ссылка отозвана.', room_closed: 'Комната закрыта.' })[error.message] || 'Не удалось выполнить запрос.';

function diagnosticMarkup() {
  if (!call.diagnostics) return '';
  return '<button type="button" class="secondary" data-copy-diagnostics>Скопировать диагностику</button><small data-diagnostic-status>Отчёт не содержит токенов, IP-адресов или SDP.</small>';
}

function wireDiagnosticCopy(container) {
  const button = container.querySelector('[data-copy-diagnostics]');
  if (!button) return;
  button.onclick = async () => {
    const status = container.querySelector('[data-diagnostic-status]');
    try {
      await navigator.clipboard.writeText(call.diagnostics);
      status.textContent = 'Диагностика скопирована.';
    } catch {
      status.textContent = 'Копирование заблокировано. Откройте консоль: CALL ICE DIAGNOSTIC.';
      console.info('CALL ICE DIAGNOSTIC', call.diagnostics);
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
      wireDiagnosticCopy(root.querySelector('#notice'));
      button.disabled = false;
    }
  };
}

async function enterRoom(descriptor, asGuest = false) {
  closeGuestEvents();
  if (!asGuest) guestSession = null;
  await call.connect(descriptor);
  navigate(`/room/${descriptor.room_id}`);
  emit('shell.navigate', { to: `/call/${descriptor.room_id}` });
}

async function leaveRoom() {
  const returningGuest = guestSession;
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

function roomView() {
  if (!call.room) { shell('Звонок не подключён', `<section class="panel empty"><p>После перезагрузки защищённый media token не сохраняется.</p><a class="button" href="/" data-link>На главную</a></section>`); return; }
  const participant = call.room.localParticipant;
  const mediaNotice = call.error ? `<p class="error" role="alert">${esc(call.error)}</p>` : (call.status ? `<p class="success" role="status">${esc(call.status)}</p>` : '');
  shell(call.descriptor.room_human_id, `<section class="call-shell"><div id="stage-media" class="stage"><div class="empty-stage">Экран собеседника появится здесь</div></div>${mediaNotice}<div class="controls"><button type="button" id="audio">Включить звук</button><button type="button" id="mic" ${!call.descriptor.capabilities.can_publish_audio || call.pending.mic ? 'disabled' : ''}>${call.pending.mic ? 'Микрофон…' : (participant.isMicrophoneEnabled ? 'Микрофон: вкл' : 'Микрофон: выкл')}</button><button type="button" id="screen" ${!call.descriptor.capabilities.can_share_screen || call.pending.screen ? 'disabled' : ''}>${call.pending.screen ? 'Демонстрация…' : (participant.isScreenShareEnabled ? 'Остановить экран' : 'Показать экран')}</button><button type="button" id="leave" class="danger">Выйти</button></div></section>`, null);
  root.querySelector('#audio').onclick = async () => call.startAudio();
  root.querySelector('#mic').onclick = async () => call.toggleMic();
  root.querySelector('#screen').onclick = async () => call.toggleScreen();
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
  roomView();
});
listen((type, payload) => { if (type === 'shell.pill_action' && payload.action_id === 'mute') call.toggleMic(); if (type === 'shell.pill_action' && payload.action_id === 'leave') leaveRoom(); if (type === 'shell.navigate_frame' && payload.path) navigate(payload.path); });
render();
