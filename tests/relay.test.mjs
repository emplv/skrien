import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WebSocket } from 'ws';
import { createSkrienServer } from '../server.mjs';
import { RelayClient } from '../web/relay.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'skrien-relay-'));
  await writeFile(path.join(dir, 'index.html'), '<h1>SKRIEN</h1>');
  await writeFile(path.join(dir, 'app.js'), 'x'.repeat(100000));
  await writeFile(path.join(dir, 'model.task'), 'model');
  await writeFile(path.join(dir, 'vision.wasm'), 'wasm');
  const app = await createSkrienServer({ host: '127.0.0.1', port: 0, staticDir: dir });
  const sockets = [];
  t.after(async () => {
    sockets.forEach(socket => socket.terminate());
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  return {
    app, dir,
    async connect() {
      const socket = new WebSocket(`ws://127.0.0.1:${app.port}/relay`);
      sockets.push(socket);
      const messages = [], waiters = [];
      socket.on('message', bytes => {
        const message = JSON.parse(bytes.toString());
        const index = waiters.findIndex(w => w.predicate(message));
        if (index >= 0) {
          const waiter = waiters.splice(index, 1)[0];
          clearTimeout(waiter.timer);
          waiter.resolve(message);
        } else messages.push(message);
      });
      socket.on('error', () => {});
      await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
      return {
        socket, messages,
        send: data => socket.send(JSON.stringify(data)),
        next(type) {
          const predicate = typeof type === 'function' ? type : data => data.type === type;
          const index = messages.findIndex(predicate);
          if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
          return new Promise((resolve, reject) => {
            const waiter = { predicate, resolve, reject };
            waiter.timer = setTimeout(() => {
              const index = waiters.indexOf(waiter);
              if (index >= 0) waiters.splice(index, 1);
              reject(new Error('Timed out waiting for relay message: ' + String(type)));
            }, 2000);
            waiters.push(waiter);
          });
        },
      };
    },
  };
}

async function pair(f) {
  const host = await f.connect();
  host.send({ type: 'create' });
  const { room } = await host.next('created');
  const phone = await f.connect();
  phone.send({ type: 'join', room });
  await phone.next('joined');
  await host.next(data => data.type === 'status' && data.state === 'paired');
  return { host, phone, room };
}

test('relay pairs one TV and camera, forwarding actions, commands and game state', async t => {
  const f = await fixture(t);
  const { host, phone, room } = await pair(f);
  assert.match(room, /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/);
  for (const action of [{ action: 'lane', value: -1 }, { action: 'run', value: 0.7 }, { action: 'jump', value: 1 }]) {
    phone.send({ type: 'action', ...action });
    assert.deepEqual(await host.next('action'), { type: 'action', ...action });
  }
  phone.send({ type: 'command', command: 'start' });
  assert.deepEqual(await host.next('command'), { type: 'command', command: 'start' });
  phone.send({ type: 'command', command: 'pause' });
  assert.deepEqual(await host.next('command'), { type: 'command', command: 'pause' });
  phone.send({ type: 'command', command: 'resume' });
  assert.deepEqual(await host.next('command'), { type: 'command', command: 'resume' });
  host.send({ type: 'state', state: 'playing' });
  assert.deepEqual(await phone.next(data => data.type === 'state' && data.state === 'playing'), { type: 'state', state: 'playing' });
});

test('relay rejects invalid movements, unauthorized state and frame-shaped payloads', async t => {
  const f = await fixture(t);
  const { host, phone } = await pair(f);
  for (const message of [
    { type: 'action', action: 'run', value: 99 },
    { type: 'action', action: 'lane', value: '1' },
    { type: 'action', action: 'teleport', value: 1 },
    { type: 'action', action: 'jump', value: 1, frame: 'private camera bytes' },
    { type: 'state', state: 'playing' },
    { type: 'video', data: 'private camera bytes' },
  ]) {
    phone.send(message);
    assert.equal((await phone.next('error')).type, 'error');
  }
  await delay(30);
  assert.equal(host.messages.some(message => message.type === 'action'), false);
  phone.send({ type: 'action', action: 'clap' });
  assert.deepEqual(await host.next('action'), { type: 'action', action: 'clap', value: 1 });
  host.send({ type: 'action', action: 'jump', value: 1 });
  assert.equal((await host.next('error')).code, 'not_controller');
});

test('duplicate controllers are rejected; disconnect pauses TV and allows a fresh controller', async t => {
  const f = await fixture(t);
  const { host, phone, room } = await pair(f);
  const other = await f.connect();
  other.send({ type: 'join', room });
  assert.equal((await other.next('error')).code, 'room_full');
  phone.socket.close();
  assert.deepEqual(await host.next('action'), { type: 'action', action: 'run', value: 0 });
  assert.equal((await host.next('command')).command, 'pause');
  other.send({ type: 'join', room });
  assert.equal((await other.next('joined')).room, room);
  const closed = new Promise(resolve => other.socket.once('close', resolve));
  host.socket.close();
  await closed;
  const health = await fetch(f.app.url + '/api/health').then(response => response.json());
  assert.equal(health.rooms, 0);
});

test('HTTP server serves complete assets with camera model MIME types and blocks traversal/symlinks', async t => {
  const f = await fixture(t);
  assert.equal(await fetch(f.app.url).then(response => response.text()), '<h1>SKRIEN</h1>');
  assert.equal((await fetch(f.app.url + '/app.js').then(response => response.text())).length, 100000);
  assert.match((await fetch(f.app.url + '/vision.wasm')).headers.get('content-type'), /application\/wasm/);
  assert.match((await fetch(f.app.url + '/model.task')).headers.get('content-type'), /application\/octet-stream/);
  assert.equal((await fetch(f.app.url + '/%2e%2e%2fpackage.json')).status, 403);
  assert.equal((await fetch(f.app.url + '/.env')).status, 403);
  await symlink(path.resolve('package.json'), path.join(f.dir, 'outside.json'));
  assert.equal((await fetch(f.app.url + '/outside.json')).status, 403);
  assert.equal((await fetch(f.app.url + '/index.html', { method: 'POST' })).status, 405);
  const head = await fetch(f.app.url + '/app.js', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});

test('browser RelayClient API works end to end and reports a nonexistent room clearly', async t => {
  const f = await fixture(t);
  const original = globalThis.WebSocket;
  globalThis.WebSocket = WebSocket;
  const events = [];
  const host = new RelayClient({ onEvent: event => events.push(event) });
  const phone = new RelayClient();
  const invalid = new RelayClient();
  t.after(() => { host.close(); phone.close(); invalid.close(); globalThis.WebSocket = original; });
  const { room } = await host.create(f.app.url);
  assert.equal(host.room, room);
  await phone.join(f.app.url, room.toLowerCase());
  assert.equal(phone.sendAction('lane', { value: 1 }), true);
  assert.equal(phone.sendAction('lane', { value: 9 }), false);
  assert.equal(phone.sendCommand('start'), true);
  assert.equal(phone.sendCommand('pause'), true);
  assert.equal(phone.sendCommand('resume'), true);
  for (let i = 0; i < 100 && events.length < 4; i++) await delay(5);
  assert.deepEqual(events, [{ type: 'action', action: 'lane', value: 1 }, { type: 'command', command: 'start' }, { type: 'command', command: 'pause' }, { type: 'command', command: 'resume' }]);
  await assert.rejects(invalid.join(f.app.url, 'AAAAAA'), /Room not found/);
});

test('host settings are stored, delivered on join, updated live, and retained for controller rejoin', async t => {
  const f = await fixture(t);
  const host = await f.connect(); host.send({ type: 'create' });
  const { room } = await host.next('created');
  host.send({ type: 'settings', gentle: true, difficulty: 'workout' });
  // Ordered ping/pong is a network barrier after the host's update.
  await new Promise(resolve => { host.socket.once('pong', resolve); host.socket.ping(); });
  const phone = await f.connect(); phone.send({ type: 'join', room });
  assert.deepEqual(await phone.next('settings'), { type: 'settings', gentle: true, difficulty: 'workout' });
  await phone.next('joined');
  host.send({ type: 'settings', gentle: false, difficulty: 'easy' });
  assert.deepEqual(await phone.next('settings'), { type: 'settings', gentle: false, difficulty: 'easy' });
  phone.socket.close();
  await host.next(data => data.type === 'command' && data.command === 'pause');
  host.send({ type: 'settings', gentle: true, difficulty: 'medium' });
  await new Promise(resolve => { host.socket.once('pong', resolve); host.socket.ping(); });
  const replacement = await f.connect(); replacement.send({ type: 'join', room });
  assert.deepEqual(await replacement.next('settings'), { type: 'settings', gentle: true, difficulty: 'medium' });
  await replacement.next('joined');
});

test('settings are host-authoritative, typed, and reject unsupported values or extra fields', async t => {
  const f = await fixture(t);
  const { host, phone } = await pair(f);
  assert.deepEqual(await phone.next('settings'), { type: 'settings', gentle: false, difficulty: 'medium' });
  phone.send({ type: 'settings', gentle: true, difficulty: 'workout' });
  assert.equal((await phone.next('error')).code, 'not_host');
  for (const settings of [
    { gentle: 'true', difficulty: 'easy' },
    { gentle: true, difficulty: 'extreme' },
    { gentle: true },
    { gentle: true, difficulty: 'medium', frame: 'not permitted' },
  ]) {
    host.send({ type: 'settings', ...settings });
    assert.equal((await host.next('error')).code, 'invalid_settings');
  }
  await delay(25);
  assert.equal(phone.messages.some(message => message.type === 'settings'), false);
  host.send({ type: 'settings', gentle: true, difficulty: 'easy' });
  assert.deepEqual(await phone.next('settings'), { type: 'settings', gentle: true, difficulty: 'easy' });
});

test('RelayClient applies host settings before join resolves and before paired UI is announced', async t => {
  const f = await fixture(t);
  const original = globalThis.WebSocket;
  globalThis.WebSocket = WebSocket;
  const order = [];
  const host = new RelayClient();
  const phone = new RelayClient({
    onEvent: event => { if (event.type === 'settings') order.push(event); },
    onStatus: status => { if (status.state === 'paired') order.push('paired'); },
  });
  t.after(() => { host.close(); phone.close(); globalThis.WebSocket = original; });
  const { room } = await host.create(f.app.url);
  assert.equal(host.sendSettings({ gentle: true, difficulty: 'workout' }), true);
  assert.equal(host.sendSettings({ gentle: 'true', difficulty: 'workout' }), false);
  await phone.join(f.app.url, room);
  order.push('join resolved');
  assert.deepEqual(order[0], { type: 'settings', gentle: true, difficulty: 'workout' });
  assert.ok(order.indexOf('paired') > 0);
  assert.ok(order.indexOf('join resolved') > 0);
  assert.equal(phone.sendSettings({ gentle: false, difficulty: 'easy' }), false);
  assert.equal(host.sendSettings({ gentle: false, difficulty: 'medium' }), true);
  for (let i = 0; i < 100 && !order.some(e => e?.difficulty === 'medium'); i++) await delay(5);
  assert.ok(order.some(event => event?.type === 'settings' && event.gentle === false && event.difficulty === 'medium'));
});
