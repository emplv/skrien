/**
 * Records pose landmarks and detected moves from a real session so movement
 * detection can be tuned and regression-tested. Stores numbers only: no video
 * frames or images ever enter the recording.
 */
const round = value => Number.isFinite(value) ? Math.round(value * 1e4) / 1e4 : null;

export class PoseRecorder {
  constructor({ maxSeconds = 120 } = {}) {
    this.maxMs = maxSeconds * 1000;
    this.recording = false;
    this._data = null;
    this._startedAt = null;
    this._lastAt = null;
  }

  start(meta = {}) {
    this.recording = true;
    this._data = { version: 1, meta: { ...meta }, frames: [], actions: [] };
    this._startedAt = null;
    this._lastAt = null;
  }

  get elapsedSeconds() {
    return this._startedAt === null ? 0 : Math.floor((this._lastAt - this._startedAt) / 1000);
  }

  /** @param {Array<{x:number,y:number,z:number,visibility?:number,presence?:number}>|null} landmarks */
  addFrame(now, landmarks, aspect) {
    if (!this.recording) return;
    this._startedAt ??= now;
    const t = Math.round(now - this._startedAt);
    if (t > this.maxMs) { this.recording = false; return; }
    this._lastAt = now;
    this._data.frames.push({
      t,
      aspect: round(aspect),
      points: landmarks ? landmarks.map(p => [round(p.x), round(p.y), round(p.z), round(p.visibility ?? 1), round(p.presence ?? 1)]) : null,
    });
  }

  addAction(now, action, payload = {}) {
    if (!this.recording || this._startedAt === null) return;
    this._data.actions.push({ t: Math.round(now - this._startedAt), action, ...payload });
  }

  stop() {
    this.recording = false;
    const data = this._data;
    this._data = null;
    return data;
  }
}
