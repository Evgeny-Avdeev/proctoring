import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const MAX_PDF = 8 * 1024 * 1024;
const MAX_PAGES = 30;
const OFFLINE_AFTER = 18_000;
const RETENTION = 48 * 60 * 60_000;
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 8080);
const data = process.env.DATA_DIR || './data';
const allowedOrigins = new Set((process.env.ALLOWED_ORIGINS || '').split(',').map(item => item.trim()).filter(Boolean));
const teacherKey = process.env.TEACHER_KEY || randomBytes(18).toString('base64url');
if ((allowedOrigins.size || !['127.0.0.1', '::1', 'localhost'].includes(host)) && (process.env.TEACHER_KEY || '').length < 16) {
  throw new Error('Для сетевого запуска задайте TEACHER_KEY длиной не менее 16 символов.');
}
await mkdir(data, { recursive: true, mode: 0o700 });
const db = new DatabaseSync(data + '/rooms.sqlite');
db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  PRAGMA secure_delete = ON;
  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY, admin TEXT NOT NULL, title TEXT NOT NULL, duration INTEGER NOT NULL,
    pages INTEGER NOT NULL, pdf BLOB NOT NULL, created INTEGER NOT NULL,
    started INTEGER, ends INTEGER, closed INTEGER
  );
  CREATE TABLE IF NOT EXISTS students (
    room TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, id TEXT NOT NULL, secret TEXT NOT NULL,
    name TEXT NOT NULL, name_key TEXT NOT NULL, seen INTEGER NOT NULL, sequence INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL, departures INTEGER NOT NULL DEFAULT 0, last_away INTEGER,
    PRIMARY KEY(room, id), UNIQUE(room, name_key)
  );
  CREATE TABLE IF NOT EXISTS images (
    room TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, page INTEGER NOT NULL,
    image BLOB NOT NULL, PRIMARY KEY(room, page)
  );
`);
const purge = () => db.prepare('DELETE FROM rooms WHERE COALESCE(closed, ends, created) < ?').run(Date.now() - RETENTION);
purge();
setInterval(purge, 15 * 60_000).unref();

const token = () => randomBytes(24).toString('base64url');
const digest = value => createHash('sha256').update(String(value)).digest('hex');
const matches = (value, hash) => typeof value === 'string'
  && timingSafeEqual(Buffer.from(digest(value), 'hex'), Buffer.from(hash, 'hex'));
const bearer = req => /^Bearer (\S+)$/.exec(req.headers.authorization || '')?.[1];
const roomById = db.prepare('SELECT id, admin, title, duration, pages, created, started, ends, closed FROM rooms WHERE id = ?');
const studentById = db.prepare('SELECT * FROM students WHERE room = ? AND id = ?');
const publicRoom = (room, now) => ({
  id: room.id, title: room.title, minutes: room.duration, now,
  started: room.started, ends: room.ends, pages: room.started ? room.pages : 0,
  phase: room.closed || (room.ends && now >= room.ends) ? 'ended' : room.started ? 'running' : 'waiting'
});
const textValue = value => typeof value === 'string' ? value.trim().replace(/\s+/gu, ' ') : '';
const error = (status, message) => Object.assign(new Error(message), { status });
const renderQueue = new Map();
let pdfProcesses = 0;

async function poppler(program, args, input) {
  if (pdfProcesses >= 4) throw error(503, 'Сервер обрабатывает PDF. Повторите через несколько секунд.');
  pdfProcesses++;
  try {
    const child = spawn(program, args, { stdio: ['pipe', 'pipe', 'ignore'], timeout: 12_000 });
    const outcome = once(child, 'close');
    outcome.catch(() => {});
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    const chunks = [];
    let size = 0;
    for await (const chunk of child.stdout) {
      size += chunk.length;
      if (size > MAX_PDF) {
        child.kill();
        throw error(422, 'Страница PDF слишком велика для просмотра.');
      }
      chunks.push(chunk);
    }
    if ((await outcome)[0] !== 0) throw error(422, 'Не удалось прочитать PDF. Проверьте, что файл открывается без пароля.');
    return Buffer.concat(chunks);
  } finally {
    pdfProcesses--;
  }
}

function renderPage(id, page) {
  const saved = db.prepare('SELECT image FROM images WHERE room = ? AND page = ?').get(id, page);
  if (saved) return Promise.resolve(saved.image);
  const key = id + '/' + page;
  if (!renderQueue.has(key)) {
    const pdf = db.prepare('SELECT pdf FROM rooms WHERE id = ?').get(id).pdf;
    const task = poppler('pdftoppm', ['-f', String(page), '-l', String(page), '-scale-to', '1600', '-png', '-singlefile', '-'], pdf)
      .then(image => {
        if (!image.length) throw error(422, 'Не удалось показать страницу PDF.');
        if (roomById.get(id)) db.prepare('INSERT OR IGNORE INTO images VALUES (?, ?, ?)').run(id, page, image);
        return image;
      }).finally(() => renderQueue.delete(key));
    renderQueue.set(key, task);
  }
  return renderQueue.get(key);
}

async function bytes(req, limit) {
  if (Number(req.headers['content-length']) > limit) {
    req.resume();
    throw error(413, 'Файл превышает допустимый размер.');
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > limit) {
      req.resume();
      throw error(413, 'Файл превышает допустимый размер.');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function json(req) {
  const body = await bytes(req, 4096);
  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw error(400, 'Некорректный запрос.');
  }
}

const assets = new Map(await Promise.all([
  ['/', 'index.html', 'text/html; charset=utf-8'],
  ['/index.html', 'index.html', 'text/html; charset=utf-8'],
  ['/styles.css', 'styles.css', 'text/css; charset=utf-8'],
  ['/app.mjs', 'app.mjs', 'text/javascript; charset=utf-8'],
  ['/config.mjs', 'config.mjs', 'text/javascript; charset=utf-8'],
  ['/icon.svg', 'icon.svg', 'image/svg+xml']
].map(async ([route, file, type]) => [route, [await readFile(new URL('../docs/' + file, import.meta.url)), type]])));

const server = createServer(async (req, res) => {
  const send = (status, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(status, { 'Content-Type': type });
    res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
  };
  const origin = req.headers.origin;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Vary', 'Origin');
  if (origin && (allowedOrigins.has(origin) || ['http', 'https'].some(scheme => origin === scheme + '://' + req.headers.host))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  try {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    if (!path.startsWith('/api/')) {
      const asset = assets.get(path);
      if (req.method === 'GET' && asset) return send(200, ...asset);
      throw error(404, 'Страница не найдена.');
    }
    if (origin && !res.hasHeader('Access-Control-Allow-Origin')) throw error(403, 'Адрес сайта не разрешён сервером.');
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Max-Age', '600');
      return send(204, '');
    }

    const now = Date.now();
    if (path === '/api/health' && req.method === 'GET') return send(200, { ok: true });
    if (path === '/api/rooms' && req.method === 'POST') {
      if (!matches(bearer(req), digest(teacherKey))) throw error(401, 'Неверный ключ учителя.');
      const title = textValue(url.searchParams.get('title'));
      const minutes = Number(url.searchParams.get('minutes'));
      if (!title || title.length > 100 || !Number.isInteger(minutes) || minutes < 1 || minutes > 180)
        throw error(400, 'Укажите название и длительность от 1 до 180 минут.');
      const pdf = await bytes(req, MAX_PDF);
      if (pdf.subarray(0, 5).toString() !== '%PDF-') throw error(400, 'Выберите файл PDF.');
      const info = await poppler('pdfinfo', ['-'], pdf);
      const pages = Number(/^Pages:\s+(\d+)/m.exec(info.toString())?.[1]);
      if (!pages || pages > MAX_PAGES) throw error(400, 'Допускается от 1 до 30 страниц PDF.');
      const firstPage = await poppler('pdftoppm', ['-f', '1', '-l', '1', '-scale-to', '1600', '-png', '-singlefile', '-'], pdf);
      if (!firstPage.length) throw error(422, 'PDF не содержит доступных для просмотра страниц.');
      const id = randomBytes(12).toString('base64url');
      const admin = token();
      db.exec('BEGIN');
      try {
        db.prepare('INSERT INTO rooms (id, admin, title, duration, pages, pdf, created) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(id, digest(admin), title, minutes, pages, pdf, now);
        db.prepare('INSERT INTO images VALUES (?, 1, ?)').run(id, firstPage);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      return send(201, { ...publicRoom(roomById.get(id), now), admin });
    }

    const route = /^\/api\/rooms\/([\w-]{16})(?:\/(join|panel|start|end|ping|pages)(?:\/(\d+))?)?$/.exec(path);
    if (!route) throw error(404, 'Страница не найдена.');
    const [, id, action, pageNumber] = route;
    const room = roomById.get(id);
    if (!room) throw error(404, 'Работа не найдена или уже удалена.');
    const info = publicRoom(room, now);
    if (!action && req.method === 'GET') return send(200, info);

    if (action === 'join' && req.method === 'POST') {
      const { name: rawName, id: studentId, secret } = await json(req);
      const name = textValue(rawName);
      if (!name || name.length > 70 || !/^[\w-]{32}$/.test(studentId || '') || !/^[\w-]{32}$/.test(secret || ''))
        throw error(400, 'Введите имя длиной до 70 символов.');
      const known = studentById.get(id, studentId);
      if (known && matches(secret, known.secret)) return send(200, publicRoom(roomById.get(id), Date.now()));
      if (publicRoom(roomById.get(id), Date.now()).phase !== 'waiting') throw error(409, 'Регистрация закрыта.');
      const num = db.prepare('SELECT count(*) AS total FROM students WHERE room = ?').get(id).total;
      if (num >= 100) throw error(409, 'Достигнут предел в 100 учеников.');
      const inserted = db.prepare(`INSERT OR IGNORE INTO students (room, id, secret, name, name_key, seen, state)
        VALUES (?, ?, ?, ?, ?, ?, 'waiting')`).run(id, studentId, digest(secret), name, name.normalize('NFKC').toLocaleLowerCase('ru'), Date.now());
      if (!inserted.changes) throw error(409, 'Это имя уже зарегистрировано. Проверьте имя или добавьте инициал.');
      return send(201, publicRoom(roomById.get(id), Date.now()));
    }

    if (action === 'ping' && req.method === 'POST') {
      const { student: studentId, secret, state, sequence, departures } = await json(req);
      const student = typeof studentId === 'string' && studentById.get(id, studentId);
      if (!student || !matches(secret, student.secret)) throw error(401, 'Регистрация на этом устройстве недействительна.');
      if (!['active', 'away'].includes(state) || !Number.isSafeInteger(sequence) || !Number.isSafeInteger(departures) || departures < 0)
        throw error(400, 'Некорректный статус.');
      const received = Date.now();
      const current = publicRoom(roomById.get(id), received);
      if (current.phase !== 'ended' && sequence > student.sequence) {
        const count = current.phase === 'running' ? Math.max(student.departures, departures) : student.departures;
        const lastAway = current.phase === 'running' && (state === 'away' && student.state !== 'away' || count > student.departures)
          ? received : student.last_away;
        db.prepare('UPDATE students SET state = ?, seen = ?, sequence = ?, departures = ?, last_away = ? WHERE room = ? AND id = ?')
          .run(state, received, sequence, count, lastAway, id, studentId);
      }
      return send(200, current);
    }

    if (action === 'pages' && req.method === 'GET' && pageNumber) {
      const student = studentById.get(id, url.searchParams.get('student') || '');
      const own = matches(bearer(req), room.admin) || student && matches(bearer(req), student.secret);
      if (!own) throw error(401, 'Для просмотра войдите в работу.');
      const page = Number(pageNumber);
      if (info.phase !== 'running' || page < 1 || page > room.pages) throw error(404, 'Страница задания недоступна.');
      return send(200, await renderPage(id, page), 'image/png');
    }

    if (!matches(bearer(req), room.admin)) throw error(401, 'Нет доступа к панели этой работы.');
    if (action === 'panel' && req.method === 'GET') {
      const students = db.prepare('SELECT id, name, seen, state, departures, last_away FROM students WHERE room = ? ORDER BY rowid').all(id);
      return send(200, {
        ...info, students: students.map(student => ({
          id: student.id, name: student.name, seen: student.seen, departures: student.departures, lastAway: student.last_away,
          state: info.phase === 'ended' ? 'ended' : now - student.seen > OFFLINE_AFTER ? 'offline' : student.state === 'away'
            ? 'away' : info.phase === 'waiting' ? 'waiting' : 'active'
        }))
      });
    }
    if (action === 'start' && req.method === 'POST') {
      if (info.phase !== 'waiting') throw error(409, 'Работа уже начата или завершена.');
      db.prepare('UPDATE rooms SET started = ?, ends = ? WHERE id = ?').run(now, now + room.duration * 60_000, id);
      return send(200, publicRoom(roomById.get(id), now));
    }
    if (action === 'end' && req.method === 'POST') {
      if (info.phase !== 'ended') db.prepare('UPDATE rooms SET closed = ? WHERE id = ?').run(now, id);
      return send(200, publicRoom(roomById.get(id), now));
    }
    throw error(404, 'Страница не найдена.');
  } catch (err) {
    if (res.destroyed) return;
    if (!err.status) console.error(err);
    return send(err.status || 500, { error: err.status ? err.message : 'Ошибка сервера.' });
  }
});
server.requestTimeout = 30_000;
server.listen(port, host, () => {
  console.log('Прокторинг запущен на порту ' + port + '.');
  if (!process.env.TEACHER_KEY) console.log('Ключ учителя для локального запуска: ' + teacherKey);
});
