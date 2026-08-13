import './style.css';
import { api } from './api.js';
import { call } from './call-controller.js';
import { emit, embedded, listen } from './bridge.js';
import { navigate, route } from './router.js';

const root = document.querySelector('#app');
const esc = (value = '') => String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
const errorText = (error) => ({ missing_auth_identity: 'Войдите через RaftForge, чтобы управлять комнатами.', token_not_found: 'Ссылка недействительна.', token_revoked: 'Ссылка отозвана.', room_closed: 'Комната закрыта.' })[error.message] || 'Не удалось выполнить запрос.';

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

function shell(title, body) {
  root.innerHTML = `<header><a class="brand" href="/" data-link>CALL</a><span>${embedded ? 'RaftForge' : 'standalone'}</span></header><main><section class="hero"><p class="eyebrow">Защищённая видеосвязь</p><h1>${esc(title)}</h1></section>${body}</main><div id="audio-sink"></div>`;
  root.querySelectorAll('[data-link]').forEach((el) => el.addEventListener('click', (event) => { event.preventDefault(); navigate(el.getAttribute('href')); }));
}

async function ownerView() {
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
  shell('Войти в комнату', `<form id="guest" class="panel stack"><label>Как вас представить?<input name="displayName" required maxlength="200" autocomplete="name" autofocus></label><button>Продолжить</button><p id="notice"></p></form>`);
  root.querySelector('#guest').onsubmit = async (event) => { event.preventDefault(); const button = event.target.querySelector('button'); button.disabled = true; try { const descriptor = await api.guestJoin(token, new FormData(event.target).get('displayName')); await enterRoom(descriptor); } catch (error) { root.querySelector('#notice').className = 'error'; root.querySelector('#notice').textContent = errorText(error); button.disabled = false; } };
}

async function enterRoom(descriptor) { await call.connect(descriptor); navigate(`/room/${descriptor.room_id}`); emit('shell.navigate', { to: `/call/${descriptor.room_id}` }); }

function roomView() {
  if (!call.room) { shell('Звонок не подключён', `<section class="panel empty"><p>После перезагрузки защищённый media token не сохраняется.</p><a class="button" href="/" data-link>На главную</a></section>`); return; }
  const participant = call.room.localParticipant;
  const mediaNotice = call.error ? `<p class="error" role="alert">${esc(call.error)}</p>` : (call.status ? `<p class="success" role="status">${esc(call.status)}</p>` : '');
  shell(call.descriptor.room_human_id, `<section class="call-shell"><div id="stage-media" class="stage"><div class="empty-stage">Экран собеседника появится здесь</div></div>${mediaNotice}<div class="controls"><button type="button" id="audio">Включить звук</button><button type="button" id="mic" ${!call.descriptor.capabilities.can_publish_audio || call.pending.mic ? 'disabled' : ''}>${call.pending.mic ? 'Микрофон…' : (participant.isMicrophoneEnabled ? 'Микрофон: вкл' : 'Микрофон: выкл')}</button><button type="button" id="screen" ${!call.descriptor.capabilities.can_share_screen || call.pending.screen ? 'disabled' : ''}>${call.pending.screen ? 'Демонстрация…' : (participant.isScreenShareEnabled ? 'Остановить экран' : 'Показать экран')}</button><button type="button" id="leave" class="danger">Выйти</button></div></section>`);
  root.querySelector('#audio').onclick = async () => call.startAudio();
  root.querySelector('#mic').onclick = async () => call.toggleMic();
  root.querySelector('#screen').onclick = async () => call.toggleScreen();
  root.querySelector('#leave').onclick = async () => { await call.leave(); navigate('/'); };
  queueMicrotask(() => call.mountMedia());
}

function render() { const current = route(); if (current.name === 'guest') guestView(current.token); else if (current.name === 'room') roomView(); else ownerView(); }
addEventListener('popstate', render);
call.addEventListener('change', () => { if (route().name === 'room') roomView(); });
listen((type, payload) => { if (type === 'shell.pill_action' && payload.action_id === 'mute') call.toggleMic(); if (type === 'shell.pill_action' && payload.action_id === 'leave') call.leave().then(() => navigate('/')); if (type === 'shell.navigate_frame' && payload.path) navigate(payload.path); });
render();
