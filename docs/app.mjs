import { API_ORIGIN } from './config.mjs';

const $ = id => document.getElementById(id);
const route = new URL(location.href);
const roomId = route.searchParams.get('room');
const api = (API_ORIGIN || location.origin).replace(/\/$/, '') + '/api';
const missingBackend = !API_ORIGIN && location.hostname.endsWith('.github.io');
const roomPath = id => '/rooms/' + encodeURIComponent(id);
const statuses = {
  waiting: 'Готов к началу', active: 'На странице', away: 'Страница неактивна',
  offline: 'Нет связи', ended: 'Работа завершена'
};
const phases = { waiting: 'Регистрация открыта', running: 'Работа идёт', ended: 'Работа завершена' };
const timeFormat = new Intl.DateTimeFormat('ru', { timeStyle: 'medium' });
const show = (id, visible = true) => { $(id).hidden = !visible; };
const write = (id, value) => { if ($(id).textContent !== String(value)) $(id).textContent = value; };
const views = ['setup', 'teacher', 'join', 'student'];
const view = id => views.forEach(name => show(name, name === id));
const saved = (storage, key) => {
  try { return JSON.parse(storage.getItem(key)); } catch { return null; }
};
const store = (storage, key, value) => {
  try { storage.setItem(key, JSON.stringify(value)); } catch { /* The live session can continue without persistence. */ }
};
const makeToken = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');

function notice(message = '') {
  write('connection', message);
  show('connection', Boolean(message));
}

async function request(path, { method = 'GET', key, body, type, keepalive = false, binary = false } = {}) {
  let response;
  const headers = {};
  if (key) headers.Authorization = 'Bearer ' + key;
  if (type) headers['Content-Type'] = type;
  try {
    response = await fetch(api + path, {
      method, body, headers, keepalive, cache: 'no-store',
      signal: keepalive ? undefined : AbortSignal.timeout(binary || type === 'application/pdf' ? 30_000 : 8_000)
    });
  } catch {
    throw new Error('Нет связи с сервером. Проверьте подключение.');
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw Object.assign(new Error(payload.error || 'Запрос к серверу не выполнен.'), { status: response.status });
  }
  return binary ? response.blob() : response.json();
}

async function busy(button, operation) {
  if (button.disabled) return;
  button.disabled = true;
  notice();
  try { await operation(); } catch (err) { notice(err.message); }
  finally { button.disabled = false; }
}

let room;
let anchor;
function updateRoom(next) {
  if (room?.id === next.id && next.now < room.now) return false;
  room = next;
  anchor = performance.now();
  return true;
}

function tick() {
  if (!room) return;
  const elapsed = performance.now() - anchor;
  const remaining = room.phase === 'running' ? Math.max(0, room.ends - room.now - elapsed) : 0;
  const seconds = room.phase === 'waiting' ? room.minutes * 60 : Math.ceil(remaining / 1000);
  const display = [Math.floor(seconds / 60), seconds % 60].map(n => String(n).padStart(2, '0')).join(':');
  write('teacher-clock', display);
  write('student-clock', display);
  // Hide the task on time even while the next server update is in flight.
  if (student?.joined && room.phase === 'running' && remaining === 0) {
    show('assignment', false);
    write('student-state', 'Время истекло.');
    void wakeLock(false);
  }
}
setInterval(tick, 250);

const teacherStorage = 'classroom-teacher:' + api;
let teacher = saved(localStorage, teacherStorage);
let teacherGeneration = 0;
let panelTask;
function teacherPanel(data) {
  if (!updateRoom(data)) return;
  view('teacher');
  write('phase', phases[data.phase]);
  write('teacher-title', data.title);
  write('teacher-clock-label', data.phase === 'waiting' ? 'Длительность' : 'До окончания');
  const link = new URL('./', location.href);
  link.searchParams.set('room', data.id);
  if ($('invite-link').value !== link.href) $('invite-link').value = link.href;
  show('invite', data.phase === 'waiting');
  show('start', data.phase === 'waiting');
  show('end', data.phase !== 'ended');
  show('new', data.phase === 'ended');
  const students = data.students || [];
  write('total', students.length);
  write('active-count', students.filter(item => item.state === 'active').length);
  write('away-count', students.filter(item => item.state === 'away' || item.state === 'offline').length);
  show('empty', !students.length);
  show('roster-wrap', Boolean(students.length));
  const fragment = document.createDocumentFragment();
  for (const item of students) {
    const tr = document.createElement('tr');
    const name = tr.insertCell();
    name.textContent = item.name;
    name.className = 'name-' + item.state;
    const badge = document.createElement('span');
    badge.className = 'badge badge-' + item.state;
    badge.textContent = statuses[item.state];
    tr.insertCell().append(badge);
    tr.insertCell().textContent = item.departures;
    tr.insertCell().textContent = item.lastAway ? timeFormat.format(item.lastAway) : '—';
    fragment.append(tr);
  }
  $('students').replaceChildren(fragment);
  write('panel-sync', data.phase === 'ended' ? 'Результаты наблюдения' : 'Статусы обновляются автоматически');
  tick();
}

function refreshPanel() {
  if (!teacher) return Promise.resolve();
  if (panelTask) return panelTask;
  const generation = teacherGeneration;
  panelTask = request(roomPath(teacher.id) + '/panel', { key: teacher.admin }).then(data => {
    if (generation === teacherGeneration) {
      teacherPanel(data);
      notice();
    }
  }).catch(err => {
    if (generation !== teacherGeneration) return;
    if ([401, 404].includes(err.status)) {
      teacher = null;
      store(localStorage, teacherStorage, null);
      teacherSetup();
    }
    write('panel-sync', 'Связь потеряна. Статусы могли измениться.');
    notice(err.message);
  }).finally(() => { panelTask = null; });
  return panelTask;
}

function teacherSetup() {
  teacherGeneration++;
  room = null;
  view('setup');
  show('resume', Boolean(teacher));
}

$('create').addEventListener('submit', event => {
  event.preventDefault();
  const fields = new FormData(event.currentTarget);
  void busy(event.submitter, async () => {
    const pdf = fields.get('pdf');
    if (pdf.size > 8 * 1024 * 1024) throw new Error('Выберите PDF размером до 8 МБ.');
    const query = new URLSearchParams({ title: fields.get('title'), minutes: fields.get('minutes') });
    const result = await request('/rooms?' + query, {
      method: 'POST', body: pdf, key: String(fields.get('key')).trim(), type: 'application/pdf'
    });
    teacherGeneration++;
    teacher = { id: result.id, admin: result.admin };
    store(localStorage, teacherStorage, teacher);
    $('create').reset();
    teacherPanel(result);
    await refreshPanel();
  });
});
$('resume').onclick = () => { void refreshPanel(); };
$('new').onclick = () => { notice(); teacherSetup(); };
$('copy').onclick = () => void busy($('copy'), async () => {
  const input = $('invite-link');
  try {
    await navigator.clipboard.writeText(input.value);
    write('copy', 'Скопировано');
    setTimeout(() => write('copy', 'Копировать'), 2000);
  } catch {
    input.focus();
    input.select();
    notice('Скопируйте выделенную ссылку.');
  }
});
async function teacherAction(action, button) {
  await busy(button, async () => {
    const result = await request(roomPath(teacher.id) + '/' + action, { method: 'POST', key: teacher.admin });
    teacherPanel({ ...result, students: room?.students || [] });
    await panelTask;
    await refreshPanel();
  });
}
$('start').onclick = () => { void teacherAction('start', $('start')); };
$('end').onclick = () => { $('confirm').returnValue = 'cancel'; $('confirm').showModal(); };
$('confirm').onclose = () => { if ($('confirm').returnValue === 'end') void teacherAction('end', $('end')); };

const studentStorage = 'classroom-student:' + api + ':' + roomId;
let student = roomId ? saved(sessionStorage, studentStorage) : null;
let lock;
let lockPending = false;
let visiblePage = 1;
let imageUrl;
let imageVersion = 0;
let lastState;
let statusError = '';
let sendingPeriodic = false;

async function wakeLock(wanted) {
  if (!wanted) {
    if (lock && !lock.released) await lock.release().catch(() => {});
    return;
  }
  if (!navigator.wakeLock || lockPending || lock && !lock.released) return;
  lockPending = true;
  try {
    lock = await navigator.wakeLock.request('screen');
    lock.addEventListener('release', studentStatus, { once: true });
    if (room?.phase !== 'running' || document.hidden || !document.hasFocus()) await lock.release();
  } catch {
    lock = null;
  } finally {
    lockPending = false;
    studentStatus();
  }
}
const browserActive = () => !document.hidden && document.hasFocus();
function studentStatus() {
  if (!student?.joined || !room) return;
  if (room.phase === 'running' && performance.now() - anchor >= room.ends - room.now) return;
  $('student-state').classList.toggle('error', Boolean(statusError) || room.phase === 'running' && !browserActive());
  if (statusError) write('student-state', statusError);
  else if (room.phase === 'waiting') write('student-state', 'Вы зарегистрированы. Задание откроется, когда учитель начнёт работу.');
  else if (room.phase === 'ended') write('student-state', 'Работа завершена.');
  else if (!browserActive()) write('student-state', 'Страница неактивна. Вернитесь к заданию.');
  else if (lock && !lock.released) write('student-state', 'Страница активна. Автоблокировка экрана приостановлена.');
  else write('student-state', 'Страница активна. Браузер может погасить экран по настройкам устройства.');
}

async function displayPage(page) {
  if (room?.phase !== 'running' || page < 1 || page > room.pages) return;
  const version = ++imageVersion;
  visiblePage = page;
  write('page-count', page + ' / ' + room.pages);
  $('prev').disabled = page === 1;
  $('next').disabled = page === room.pages;
  show('pdf-page', false);
  show('retry-pdf', false);
  write('pdf-message', 'Загружается страница…');
  try {
    const query = new URLSearchParams({ student: student.id });
    const blob = await request(roomPath(roomId) + '/pages/' + page + '?' + query, { key: student.secret, binary: true });
    if (version !== imageVersion) return;
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    imageUrl = URL.createObjectURL(blob);
    $('pdf-page').alt = 'Страница ' + page + ' задания';
    $('pdf-page').src = imageUrl;
    show('pdf-page');
    write('pdf-message', '');
  } catch (err) {
    if (version !== imageVersion) return;
    write('pdf-message', err.message);
    show('retry-pdf');
  }
}

function studentPanel(data) {
  const wasRunning = room?.phase === 'running' && !$('assignment').hidden;
  if (!updateRoom(data)) return;
  view('student');
  write('student-phase', data.phase === 'waiting' ? 'Ожидание начала' : phases[data.phase]);
  write('student-title', data.title);
  write('student-name', student.name);
  const running = data.phase === 'running';
  show('student-clock-box', running);
  show('assignment', running);
  if (running && !wasRunning) void displayPage(visiblePage);
  if (!running && wasRunning) {
    ++imageVersion;
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    imageUrl = null;
    $('pdf-page').removeAttribute('src');
  }
  void wakeLock(running && browserActive());
  studentStatus();
  tick();
}

function signalState(state = browserActive() ? 'active' : 'away', leaving = false, periodic = false) {
  if (!student?.joined || room?.phase === 'ended' || periodic && sendingPeriodic) return;
  if (periodic) sendingPeriodic = true;
  if (state === 'away' && lastState !== 'away' && room?.phase === 'running') student.departures++;
  lastState = state;
  student.sequence++;
  store(sessionStorage, studentStorage, student);
  const body = JSON.stringify({
    student: student.id, secret: student.secret, state, sequence: student.sequence, departures: student.departures
  });
  const path = roomPath(roomId) + '/ping';
  if (leaving && navigator.sendBeacon?.(api + path, body)) return;
  const sequence = student.sequence;
  void request(path, { method: 'POST', body, type: 'text/plain;charset=UTF-8', keepalive: !periodic }).then(data => {
    if (sequence < (student.lastReply || 0)) return;
    student.lastReply = sequence;
    statusError = '';
    notice();
    studentPanel(data);
  }).catch(err => {
    if (sequence < (student.lastReply || 0)) return;
    statusError = err.message;
    studentStatus();
  }).finally(() => { if (periodic) sendingPeriodic = false; });
}

async function registration() {
  try {
    const data = await request(roomPath(roomId));
    if (student?.joined) {
      studentPanel(data);
      signalState(undefined, false, true);
      return;
    }
    view('join');
    write('join-title', data.title);
    write('join-info', data.phase === 'waiting' ? 'Введите имя, чтобы появиться в списке учителя.' : 'Регистрация на эту работу закрыта.');
    show('join-form', data.phase === 'waiting' || Boolean(student));
    const field = $('join-form').elements.name;
    if (student?.name && !field.value) field.value = student.name;
  } catch (err) {
    view('join');
    show('join-form', false);
    notice(err.message);
  }
}

$('join-form').addEventListener('submit', event => {
  event.preventDefault();
  const name = event.currentTarget.elements.name.value.trim();
  void busy(event.submitter, async () => {
    if (!student || student.name !== name) student = { name, id: makeToken(), secret: makeToken(), sequence: 0, departures: 0 };
    store(sessionStorage, studentStorage, student);
    const data = await request(roomPath(roomId) + '/join', {
      method: 'POST', body: JSON.stringify(student), type: 'text/plain;charset=UTF-8'
    });
    student.joined = true;
    store(sessionStorage, studentStorage, student);
    studentPanel(data);
    signalState();
  });
});
$('prev').onclick = () => { void displayPage(visiblePage - 1); };
$('next').onclick = () => { void displayPage(visiblePage + 1); };
$('retry-pdf').onclick = () => { void displayPage(visiblePage); };
function attentionChanged() {
  if (!student?.joined || room?.phase === 'ended') return;
  const active = browserActive();
  const state = active ? 'active' : 'away';
  if (lastState !== state) signalState(state);
  void wakeLock(active && room?.phase === 'running');
  studentStatus();
}

if (missingBackend) {
  view(roomId ? 'join' : 'setup');
  notice('Сервер статусов ещё не подключён. Для запуска укажите его HTTPS-адрес в config.mjs.');
  $('create').querySelector('button').disabled = true;
  show('join-form', false);
} else if (roomId !== null) {
  write('role', 'Страница ученика');
  void registration();
  document.addEventListener('visibilitychange', attentionChanged);
  window.addEventListener('focus', attentionChanged);
  window.addEventListener('blur', attentionChanged);
  window.addEventListener('pageshow', attentionChanged);
  window.addEventListener('pagehide', () => signalState('away', true));
  window.addEventListener('online', () => { if (student?.joined) signalState(); else void registration(); });
  setInterval(() => {
    if (student?.joined) signalState(undefined, false, true);
    else if (!$('join').hidden && !$('join-form').querySelector('button').disabled) void registration();
  }, 5000);
} else {
  teacherSetup();
  if (teacher) void refreshPanel();
  setInterval(() => {
    if (!$('teacher').hidden && room?.phase !== 'ended') void refreshPanel();
  }, 2000);
}
