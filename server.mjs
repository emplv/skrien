import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomInt } from 'node:crypto';
import os from 'node:os';
import { WebSocket, WebSocketServer } from 'ws';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.wasm': 'application/wasm',
  '.task': 'application/octet-stream', '.bin': 'application/octet-stream',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
};
const DISCRETE = new Set(['left', 'right', 'jump', 'duck', 'clap']);
const COMMANDS = new Set(['start', 'pause', 'resume']);
const STATES = new Set(['playing', 'paused', 'home', 'finished']);
const DIFFICULTIES = new Set(['easy', 'medium', 'workout']);
const exactKeys = (data, keys) => Object.keys(data).every(key => keys.includes(key));
const send = (socket, data) => {
  if (socket?.readyState === WebSocket.OPEN && socket.bufferedAmount < 64000) socket.send(JSON.stringify(data));
};

export function validateAction(message) {
  if (!message || !exactKeys(message, ['type', 'action', 'value'])) return null;
  const { action, value } = message;
  if (action === 'run' && Number.isFinite(value) && value >= 0 && value <= 1) return { type: 'action', action, value };
  if (action === 'lane' && Number.isInteger(value) && value >= -1 && value <= 1) return { type: 'action', action, value };
  if (DISCRETE.has(action) && (value === undefined || value === 1)) return { type: 'action', action, value: 1 };
  return null;
}

/** Start a small local/demo relay. No account, recorded video or persistent data. */
export async function createSkrienServer({ host = '0.0.0.0', port = 4173, staticDir = path.join(ROOT, 'dist') } = {}) {
  const rooms = new Map();
  const directory = path.resolve(staticDir);
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
    catch { res.writeHead(400); res.end('Invalid URL'); return; }
    if (pathname === '/api/health') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'no-store');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, service: 'skrien-relay', version: '0.3.0', rooms: rooms.size, clients: wss.clients.size }));
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }); res.end('Method not allowed'); return;
    }
    // Resolve both the lexical path and symlinks before exposing a file.
    if (pathname.includes('\0') || pathname.includes('\\') || pathname.split('/').some(segment => segment.startsWith('.'))) {
      res.writeHead(403); res.end('Forbidden'); return;
    }
    if (pathname === '/') pathname = '/index.html';
    const candidate = path.resolve(directory, '.' + pathname);
    if (candidate !== directory && !candidate.startsWith(directory + path.sep)) {
      res.writeHead(403); res.end('Forbidden'); return;
    }
    try {
      const [resolvedRoot, resolvedFile, info] = await Promise.all([realpath(directory), realpath(candidate), stat(candidate)]);
      if (!info.isFile() || !resolvedFile.startsWith(resolvedRoot + path.sep)) {
        res.writeHead(403); res.end('Forbidden'); return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(resolvedFile).toLowerCase()] || 'application/octet-stream',
        'Content-Length': info.size,
        'Cache-Control': path.extname(resolvedFile) === '.html' ? 'no-cache' : 'public, max-age=3600',
      });
      if (req.method === 'HEAD') res.end();
      else {
        const stream = createReadStream(resolvedFile);
        stream.on('error', () => res.destroy());
        res.on('close', () => stream.destroy());
        stream.pipe(res);
      }
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found. Run npm run build before starting SKRIEN.');
    }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2048, perMessageDeflate: false });

  server.on('upgrade', (req, socket, head) => {
    let pathname;
    try { pathname = new URL(req.url, 'http://localhost').pathname; }
    catch { socket.destroy(); return; }
    if (pathname !== '/relay') { socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); return; }
    if (wss.clients.size >= 100) { socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });

  wss.on('connection', socket => {
    socket.alive = true;
    socket.role = null;
    socket.room = null;
    socket.invalid = 0;
    socket.windowStart = Date.now();
    socket.eventsInWindow = 0;
    const joinTimer = setTimeout(() => {
      if (!socket.room) socket.close(1008, 'Pairing timed out');
    }, 15000);
    joinTimer.unref();

    const error = (code, message) => {
      send(socket, { type: 'error', code, message });
      if (++socket.invalid >= 8) socket.close(1008, 'Too many invalid messages');
    };
    socket.on('pong', () => { socket.alive = true; });
    socket.on('error', () => {});
    socket.on('message', (bytes, binary) => {
      const now = Date.now();
      if (now - socket.windowStart >= 1000) { socket.windowStart = now; socket.eventsInWindow = 0; }
      if (++socket.eventsInWindow > 100) { socket.close(1008, 'Message rate exceeded'); return; }
      if (binary) { socket.close(1003, 'Only game action JSON is accepted'); return; }
      let data;
      try { data = JSON.parse(bytes.toString()); }
      catch { error('invalid_json', 'Messages must be valid JSON.'); return; }
      if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.type !== 'string') {
        error('invalid_message', 'Invalid relay message.'); return;
      }
      if (data.type === 'create') {
        if (!exactKeys(data, ['type'])) { error('invalid_message', 'Unexpected fields.'); return; }
        if (socket.room) { error('already_joined', 'This connection is already paired.'); return; }
        if (rooms.size >= 50) { error('capacity', 'The demo relay is full. Try again later.'); return; }
        let roomCode;
        do { roomCode = Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join(''); }
        while (rooms.has(roomCode));
        const room = { code: roomCode, host: socket, controller: null, state: 'home',
          settings: { gentle: false, difficulty: 'medium' }, created: now };
        rooms.set(roomCode, room);
        socket.room = roomCode; socket.role = 'host';
        clearTimeout(joinTimer);
        send(socket, { type: 'created', room: roomCode, role: 'host' });
        send(socket, { type: 'status', state: 'waiting', role: 'host', message: 'Waiting for your phone camera.' });
        return;
      }
      if (data.type === 'join') {
        if (!exactKeys(data, ['type', 'room']) || typeof data.room !== 'string' || !/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/.test(data.room.toUpperCase())) {
          error('invalid_room', 'Enter the six-character code shown on your TV.'); return;
        }
        if (socket.room) { error('already_joined', 'This connection is already paired.'); return; }
        const room = rooms.get(data.room.toUpperCase());
        if (!room || room.host.readyState !== WebSocket.OPEN) { error('room_missing', 'Room not found. Create a fresh code on the TV.'); return; }
        if (room.controller?.readyState === WebSocket.OPEN) { error('room_full', 'A camera is already connected to this TV.'); return; }
        socket.room = room.code; socket.role = 'controller'; room.controller = socket;
        clearTimeout(joinTimer);
        // Apply the TV's movement interpretation before the controller's
        // join promise resolves or its Start button becomes available.
        send(socket, { type: 'settings', ...room.settings });
        send(socket, { type: 'joined', room: room.code, role: 'controller' });
        send(socket, { type: 'status', state: 'paired', role: 'controller', message: 'Connected to your TV.' });
        send(room.host, { type: 'status', state: 'paired', role: 'host', message: 'Phone camera connected.' });
        send(socket, { type: 'state', state: room.state });
        return;
      }
      const room = rooms.get(socket.room);
      if (!room) { error('not_joined', 'Create or join a room first.'); return; }
      if (data.type === 'settings') {
        if (socket.role !== 'host') { error('not_host', 'Choose session settings on the TV.'); return; }
        if (!exactKeys(data, ['type', 'gentle', 'difficulty']) || typeof data.gentle !== 'boolean' || !DIFFICULTIES.has(data.difficulty)) {
          error('invalid_settings', 'Settings need a low-impact boolean and a supported difficulty.'); return;
        }
        room.settings = { gentle: data.gentle, difficulty: data.difficulty };
        send(room.controller, { type: 'settings', ...room.settings });
        return;
      }
      if (data.type === 'action') {
        if (socket.role !== 'controller') { error('not_controller', 'Only the paired camera can send movement.'); return; }
        const action = validateAction(data);
        if (!action) { error('invalid_action', 'Only supported movement actions and numeric values are accepted.'); return; }
        send(room.host, action);
        return;
      }
      if (data.type === 'command') {
        if (socket.role !== 'controller' || !exactKeys(data, ['type', 'command']) || !COMMANDS.has(data.command)) {
          error('invalid_command', 'Only the paired controller can start, pause or resume the game.'); return;
        }
        send(room.host, { type: 'command', command: data.command });
        return;
      }
      if (data.type === 'state') {
        if (socket.role !== 'host' || !exactKeys(data, ['type', 'state']) || !STATES.has(data.state)) {
          error('invalid_state', 'Only the TV can publish game state.'); return;
        }
        room.state = data.state;
        send(room.controller, { type: 'state', state: room.state });
        return;
      }
      error('invalid_message', 'Only pairing, movement, session settings and game-state messages are accepted.');
    });
    socket.on('close', () => {
      clearTimeout(joinTimer);
      const room = rooms.get(socket.room);
      if (!room) return;
      if (room.host === socket) {
        rooms.delete(room.code);
        send(room.controller, { type: 'status', state: 'disconnected', role: 'controller', message: 'The TV disconnected. Create a new room on the TV.' });
        room.controller?.close(1001, 'TV disconnected');
      } else if (room.controller === socket) {
        room.controller = null;
        send(room.host, { type: 'action', action: 'run', value: 0 });
        send(room.host, { type: 'command', command: 'pause' });
        send(room.host, { type: 'status', state: 'waiting', role: 'host', message: 'Camera disconnected. Reconnect using the same code.' });
      }
    });
  });

  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (!socket.alive) { socket.terminate(); continue; }
      socket.alive = false;
      socket.ping();
    }
  }, 15000);
  heartbeat.unref();

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => { server.off('error', reject); resolve(); });
    });
  } catch (error) { clearInterval(heartbeat); wss.close(); throw error; }
  const actualPort = server.address().port;
  let closing;
  return {
    server, wss, rooms, host, port: actualPort,
    url: `http://${host === '0.0.0.0' ? 'localhost' : host}:${actualPort}`,
    close() {
      if (closing) return closing;
      clearInterval(heartbeat);
      for (const socket of wss.clients) socket.terminate();
      rooms.clear();
      wss.close();
      closing = new Promise(resolve => server.close(resolve));
      server.closeIdleConnections?.();
      return closing;
    },
  };
}

function cliOptions() {
  const args = process.argv.slice(2);
  let host = '0.0.0.0', port = Number(process.env.SKRIEN_PORT || process.env.MOVA_PORT || 4173);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port') port = Number(args[++i]);
    else if (args[i] === '--host') host = args[++i];
    else if (args[i] === '--strictPort') { /* Already strict: listen fails when the port is occupied. */ }
    else throw new Error(`Unknown option: ${args[i]}`);
  }
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Use --host <hostname> --port <1–65535>.');
  return { host, port };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const app = await createSkrienServer(cliOptions());
    console.log(`\nSKRIEN is running at http://localhost:${app.port}`);
    for (const addresses of Object.values(os.networkInterfaces())) {
      for (const address of addresses || []) {
        if (address.family === 'IPv4' && !address.internal) console.log(`TV relay URL: http://${address.address}:${app.port}`);
      }
    }
    console.log('Phone camera: run npm run tunnel for an HTTPS link.\n');
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => app.close().then(() => process.exit(0)));
  } catch (error) {
    console.error(`SKRIEN could not start: ${error.message}`);
    process.exitCode = 1;
  }
}
