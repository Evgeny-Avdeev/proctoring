import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setImmediate as settle } from 'node:timers/promises';
import { test } from 'node:test';

class Sentinel extends EventTarget {
  released = false;
  releaseCalls = 0;

  revoke() {
    this.released = true;
    this.dispatchEvent(new Event('release'));
  }

  async release() {
    this.releaseCalls++;
    this.revoke();
  }
}

const elementIds = [...readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8')
  .matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
const running = { id: 'test', phase: 'running', now: 1000, ends: 61_000, pages: 0 };
let importNumber = 0;

async function startStudent(t, { supported = true, secure = true, reply, policy, initialRoom = running } = {}) {
  let time = 0;
  let focused = true;
  let room = initialRoom;
  const intervals = new Map();
  const requests = [];
  const warnings = [];
  const elements = new Map(elementIds.map(id => [id, Object.assign(new EventTarget(), {
    hidden: true, classList: { toggle() {} }, removeAttribute() {}
  })]));
  const storage = { getItem() { return null; }, setItem() {} };
  const joinedStorage = {
    ...storage,
    getItem() { return JSON.stringify({ joined: true, name: 'Тест', sequence: 0, departures: 0 }); }
  };
  const window = Object.assign(new EventTarget(), { isSecureContext: secure });
  const document = Object.assign(new EventTarget(), {
    hidden: false,
    hasFocus: () => focused,
    getElementById: id => elements.get(id),
    permissionsPolicy: policy
  });
  const navigator = { sendBeacon: () => true };
  if (supported) navigator.wakeLock = {
    async request(type) {
      assert.equal(type, 'screen');
      const sentinel = new Sentinel();
      requests.push(sentinel);
      return reply ? reply(sentinel, requests.length) : sentinel;
    }
  };
  const globals = {
    window, document, navigator,
    performance: { now: () => time },
    location: new URL('https://example.test/?room=test'),
    localStorage: storage,
    sessionStorage: joinedStorage,
    setInterval: (fn, delay) => intervals.set(delay, fn),
    fetch: async () => Response.json(room)
  };
  for (const [key, value] of Object.entries(globals)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, key, original);
      else delete globalThis[key];
    });
  }
  t.mock.method(console, 'warn', (...args) => warnings.push(args));

  await import('../docs/app.mjs?test=' + ++importNumber);
  await settle();

  return {
    requests, warnings, window,
    get status() { return elements.get('student-state').textContent; },
    get canRetry() { return !elements.get('keep-screen-on').hidden; },
    async retry() {
      elements.get('keep-screen-on').onclick();
      await settle();
    },
    async visibility(hidden) {
      document.hidden = hidden;
      focused = !hidden;
      document.dispatchEvent(new Event('visibilitychange'));
      await settle();
    },
    async blur() {
      focused = false;
      window.dispatchEvent(new Event('blur'));
      await settle();
    },
    async poll(next = room) {
      room = next;
      intervals.get(5000)();
      await settle();
    },
    async expire() {
      time += running.ends - running.now;
      intervals.get(250)();
      await settle();
    }
  };
}

test('acquires one lock on entry and keeps it while visible without focus', async t => {
  const student = await startStudent(t);
  assert.match(student.status, /приостановлена/);
  assert.equal(student.canRetry, false);
  await student.blur();
  await student.poll();
  assert.equal(student.requests.length, 1);
  assert.equal(student.requests[0].released, false);
  assert.match(student.status, /Страница неактивна/);
});

test('waits for the work to start before requesting a lock', async t => {
  const student = await startStudent(t, { initialRoom: { ...running, phase: 'waiting', minutes: 1 } });
  assert.equal(student.requests.length, 0);
  assert.equal(student.canRetry, false);
  await student.poll(running);
  assert.equal(student.requests.length, 1);
});

test('reports browser denial, avoids periodic retries and lets the pupil retry', async t => {
  const student = await startStudent(t, {
    reply(sentinel, attempt) {
      if (attempt === 1) throw new DOMException('Platform refused', 'NotAllowedError');
      return sentinel;
    }
  });
  assert.match(student.status, /Браузер отклонил запрос/);
  assert.deepEqual(student.warnings[0].slice(1), ['NotAllowedError', 'Platform refused']);
  assert.equal(student.canRetry, true);
  await student.poll();
  assert.equal(student.requests.length, 1);
  await student.retry();
  assert.equal(student.requests.length, 2);
  assert.match(student.status, /приостановлена/);
});

test('reports a browser-confirmed Permissions Policy restriction', async t => {
  const student = await startStudent(t, {
    policy: { features: () => ['screen-wake-lock'], allowsFeature: () => false },
    reply() { throw new DOMException('Denied', 'NotAllowedError'); }
  });
  assert.match(student.status, /Политика безопасности страницы/);
});

test('recovers once on revocation without waiting for the server', async t => {
  const student = await startStudent(t);
  student.requests[0].revoke();
  await settle();
  assert.equal(student.requests.length, 2);
  assert.match(student.status, /приостановлена/);
  student.requests[1].revoke();
  await student.poll();
  assert.equal(student.requests.length, 2);
  assert.match(student.status, /Браузер снял удержание/);
  assert.equal(student.canRetry, true);
  await student.retry();
  assert.match(student.status, /приостановлена/);
});

test('reports denial during automatic recovery and stops retrying', async t => {
  const student = await startStudent(t, {
    reply(sentinel, attempt) {
      if (attempt > 1) throw new DOMException('Platform refused', 'NotAllowedError');
      return sentinel;
    }
  });
  student.requests[0].revoke();
  await student.poll();
  assert.equal(student.requests.length, 2);
  assert.match(student.status, /Браузер отклонил запрос/);
  assert.equal(student.canRetry, true);
});

test('releases in a background tab and reacquires on return', async t => {
  const student = await startStudent(t);
  await student.visibility(true);
  await student.poll();
  assert.equal(student.requests[0].releaseCalls, 1);
  assert.equal(student.requests.length, 1);
  assert.equal(student.canRetry, false);
  await student.visibility(false);
  assert.equal(student.requests.length, 2);
  assert.match(student.status, /приостановлена/);
});

test('releases on pagehide and reacquires on pageshow even without a visibility event', async t => {
  const student = await startStudent(t);
  student.window.dispatchEvent(new Event('pagehide'));
  await student.poll();
  assert.equal(student.requests[0].releaseCalls, 1);
  assert.equal(student.requests.length, 1);
  student.window.dispatchEvent(new Event('pageshow'));
  await settle();
  assert.equal(student.requests.length, 2);
});

test('releases when the teacher ends the work', async t => {
  const student = await startStudent(t);
  await student.poll({ ...running, phase: 'ended', now: 2000 });
  assert.equal(student.requests[0].releaseCalls, 1);
  assert.equal(student.canRetry, false);
  assert.equal(student.status, 'Работа завершена.');
  student.window.dispatchEvent(new Event('focus'));
  await settle();
  assert.equal(student.requests.length, 1);
});

test('releases a delayed grant after the local timer expires', async t => {
  const pending = Promise.withResolvers();
  const student = await startStudent(t, { reply: () => pending.promise });
  const requestingStatus = student.status;
  await student.expire();
  pending.resolve(student.requests[0]);
  await settle();
  assert.equal(student.requests[0].releaseCalls, 1);
  assert.equal(student.requests.length, 1);
  assert.equal(student.canRetry, false);
  assert.equal(student.status, 'Время истекло.');
  assert.match(requestingStatus, /Запрашиваем удержание/);
});

test('releases an active lock when the local timer expires', async t => {
  const student = await startStudent(t);
  await student.expire();
  assert.equal(student.requests[0].releaseCalls, 1);
  assert.equal(student.requests.length, 1);
  assert.equal(student.status, 'Время истекло.');
});

test('retries on return when the previous request failed in flight', async t => {
  const pending = Promise.withResolvers();
  const student = await startStudent(t, {
    reply: (sentinel, attempt) => attempt === 1 ? pending.promise : sentinel
  });
  await student.visibility(true);
  await student.visibility(false);
  assert.equal(student.requests.length, 1);
  pending.reject(new DOMException('Page was hidden', 'NotAllowedError'));
  await settle();
  assert.equal(student.requests.length, 2);
  assert.match(student.status, /приостановлена/);
  assert.equal(student.warnings.length, 0);
});

test('explains unavailable API without showing an ineffective retry button', async t => {
  const student = await startStudent(t, { supported: false });
  assert.match(student.status, /удержание экрана недоступно/);
  assert.equal(student.canRetry, false);
});

test('explains the HTTPS requirement on an insecure origin', async t => {
  const student = await startStudent(t, { supported: false, secure: false });
  assert.match(student.status, /HTTPS/);
  assert.equal(student.canRetry, false);
});
