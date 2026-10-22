/** How long the player may be out of view before the run pauses. */
export const LOST_GRACE_MS = 1500;
/** How long to wait for the TV to confirm a pause before trying again. */
const PAUSE_ACK_MS = 3000;

/**
 * Turns camera tracking status into pause and resume decisions.
 * Brief tracking gaps (a foot leaving the frame mid-jump) are ignored, and a
 * run paused because the player left the frame resumes when they return.
 * Manual pauses are never resumed automatically.
 */
export class TrackingPauseGate {
  constructor({ graceMs = LOST_GRACE_MS, ackMs = PAUSE_ACK_MS } = {}) {
    this.graceMs = graceMs;
    this.ackMs = ackMs;
    this._lostSince = null;
    this._pausedAt = null;
    this._pausedByGate = false;
  }

  /**
   * @param {string} tracking Camera status state: 'tracking', 'lost', 'error', ...
   * @param {number} now Milliseconds.
   * @param {string} run Run state: 'playing', 'paused', 'home' or 'finished'.
   * @returns {'pause'|'resume'|null}
   */
  update(tracking, now, run) {
    if (run !== 'playing' && run !== 'paused') {
      this._pausedByGate = false;
      this._pausedAt = null;
    } else if (run === 'paused') {
      this._pausedAt = null;
    } else if (this._pausedAt !== null) {
      // Still playing after our pause: either the TV state is late or the pause was lost.
      if (now - this._pausedAt < this.ackMs) return null;
      this._pausedAt = null;
      this._pausedByGate = false;
      if (this._lostSince !== null) this._lostSince = now - this.graceMs;
    } else if (this._pausedByGate) {
      // The player resumed on the TV themselves.
      this._pausedByGate = false;
    }

    if (tracking === 'error') {
      this._lostSince = null;
      this._pausedByGate = false;
      return run === 'playing' ? 'pause' : null;
    }
    if (tracking === 'lost') {
      // The grace period only counts time spent running.
      if (run !== 'playing') { this._lostSince = null; return null; }
      this._lostSince ??= now;
      if (now - this._lostSince < this.graceMs) return null;
      this._pausedByGate = true;
      this._pausedAt = now;
      return 'pause';
    }
    this._lostSince = null;
    if (tracking === 'tracking' && this._pausedByGate && run === 'paused') {
      this._pausedByGate = false;
      return 'resume';
    }
    return null;
  }
}
