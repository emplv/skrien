const STATES = new Set(['playing', 'paused', 'home', 'finished']);
const ACTIONS = new Set(['left', 'right', 'jump', 'duck', 'clap', 'run', 'lane']);
const DIFFICULTIES = new Set(['easy', 'medium', 'workout']);

function relayAddress(input) {
  let value = String(input || globalThis.location?.origin || '').trim();
  if (!/^(?:https?|wss?):\/\//i.test(value)) value = 'http://' + value;
  let url;
  try { url = new URL(value); } catch { throw new Error('Enter a relay URL such as http://192.168.1.20:4173.'); }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new Error('Use an HTTP or HTTPS relay URL without a username or password.');
  }
  const secure = url.protocol === 'https:' || url.protocol === 'wss:';
  return { url: `${secure ? 'https:' : 'http:'}//${url.host}`, socket: `${secure ? 'wss:' : 'ws:'}//${url.host}/relay` };
}

export class RelayClient {
  constructor({ onStatus = () => {}, onEvent = () => {} } = {}) {
    this.onStatus = onStatus;
    this.onEvent = onEvent;
    this.room = null;
    this.url = null;
    this.role = null;
    this._socket = null;
    this._generation = 0;
    this._pending = null;
    this._timer = null;
    this._connected = false;
  }

  async create(url) { return this._connect(url, null); }

  async join(url, room) {
    const code = String(room || '').trim().toUpperCase();
    if (!/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/.test(code)) throw new Error('Enter the six-character room code shown on your TV.');
    return this._connect(url, code);
  }

  _status(state, message) {
    this.onStatus({ state, message, role: this.role, room: this.room, url: this.url });
  }

  async _connect(input, room) {
    const address = relayAddress(input);
    this._close(true);
    const generation = ++this._generation;
    this.url = address.url;
    this.room = room;
    this.role = room ? 'controller' : 'host';
    this._status('connecting', 'Connecting to your TV relay…');
    return new Promise((resolve, reject) => {
      this._pending = { resolve, reject };
      const fail = message => {
        if (generation !== this._generation) return;
        clearTimeout(this._timer);
        const pending = this._pending;
        this._pending = null;
        this._status('error', message);
        pending?.reject(new Error(message));
      };
      let socket;
      try { socket = new WebSocket(address.socket); }
      catch {
        fail('Could not open this relay. Use an HTTPS relay from an HTTPS page, or the local relay URL in the Fire TV app.');
        return;
      }
      this._socket = socket;
      this._timer = setTimeout(() => {
        fail('The relay is not responding. Start the downloaded project with npm start, then enter its local or HTTPS tunnel URL.');
        socket.close();
      }, 10000);
      socket.addEventListener('open', () => {
        if (generation !== this._generation) { socket.close(); return; }
        socket.send(JSON.stringify(room ? { type: 'join', room } : { type: 'create' }));
      });
      socket.addEventListener('message', event => {
        if (generation !== this._generation || typeof event.data !== 'string') return;
        let data;
        try { data = JSON.parse(event.data); } catch { return; }
        if (!data || typeof data !== 'object') return;
        if (data.type === 'created' || data.type === 'joined') {
          if (typeof data.room !== 'string' || !/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/.test(data.room)) return;
          clearTimeout(this._timer);
          this.room = data.room;
          this._connected = true;
          const pending = this._pending;
          this._pending = null;
          this._status(data.type === 'created' ? 'waiting' : 'paired', data.type === 'created' ? 'Waiting for your phone camera.' : 'Connected to your TV.');
          pending?.resolve({ room: this.room, url: this.url });
          return;
        }
        if (data.type === 'error') {
          const message = typeof data.message === 'string' ? data.message : 'The relay rejected the request.';
          const wasPending = Boolean(this._pending);
          fail(message);
          if (wasPending) socket.close();
          return;
        }
        if (data.type === 'status' && ['waiting', 'paired', 'disconnected', 'error'].includes(data.state)) {
          this._status(data.state, String(data.message || data.state));
          return;
        }
        if (data.type === 'action' && ACTIONS.has(data.action) && Number.isFinite(data.value)) {
          this.onEvent({ type: 'action', action: data.action, value: data.value });
        } else if (data.type === 'command' && ['start', 'pause', 'resume'].includes(data.command)) {
          this.onEvent({ type: 'command', command: data.command });
        } else if (data.type === 'state' && STATES.has(data.state)) {
          this.onEvent({ type: 'state', state: data.state });
        } else if (data.type === 'settings' && this.role === 'controller' && typeof data.gentle === 'boolean' && DIFFICULTIES.has(data.difficulty)) {
          this.onEvent({ type: 'settings', gentle: data.gentle, difficulty: data.difficulty });
        }
      });
      socket.addEventListener('error', () => {
        fail('Cannot reach the relay. Start npm start on your computer and use its relay URL. For a phone camera, use the HTTPS tunnel URL.');
      });
      socket.addEventListener('close', () => {
        if (generation !== this._generation) return;
        clearTimeout(this._timer);
        const wasPending = Boolean(this._pending);
        if (wasPending) fail('Connection closed before pairing. Check the relay URL and create a fresh room.');
        else if (this._connected) this._status('disconnected', 'Relay disconnected. Reconnect to continue.');
        this._connected = false;
        this._socket = null;
      });
    });
  }

  _send(message) {
    if (!this._connected || this._socket?.readyState !== WebSocket.OPEN) return false;
    if (this._socket.bufferedAmount > 32000) return false;
    this._socket.send(JSON.stringify(message));
    return true;
  }

  sendAction(action, { value } = {}) {
    if (this.role !== 'controller' || !ACTIONS.has(action)) return false;
    if (action === 'run' && (!Number.isFinite(value) || value < 0 || value > 1)) return false;
    if (action === 'lane' && (!Number.isInteger(value) || value < -1 || value > 1)) return false;
    return this._send({ type: 'action', action, value: action === 'run' || action === 'lane' ? value : 1 });
  }

  sendCommand(command) {
    if (this.role !== 'controller' || !['start', 'pause', 'resume'].includes(command)) return false;
    return this._send({ type: 'command', command });
  }

  sendState(state) {
    if (this.role !== 'host' || !STATES.has(state)) return false;
    return this._send({ type: 'state', state });
  }

  sendSettings({ gentle, difficulty } = {}) {
    if (this.role !== 'host' || typeof gentle !== 'boolean' || !DIFFICULTIES.has(difficulty)) return false;
    return this._send({ type: 'settings', gentle, difficulty });
  }

  _close(silent) {
    ++this._generation;
    clearTimeout(this._timer);
    const pending = this._pending;
    this._pending = null;
    if (pending) {
      const error = new Error('Pairing cancelled.');
      error.name = 'AbortError';
      pending.reject(error);
    }
    this._connected = false;
    const socket = this._socket;
    this._socket = null;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, 'Client disconnected');
    if (!silent) this._status('disconnected', 'Disconnected from the TV relay.');
    this.room = null;
  }

  close() { this._close(false); }
}
