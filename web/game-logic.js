/** Deterministic gameplay: no DOM, renderer, network, or wall-clock dependencies. */
export const LANE_WIDTH = 2.45;
export const WORLDS = ['forest', 'canyon', 'neon'];
export const ACTION_LABELS = {
  jump: 'JUMP', duck: 'DUCK', clap: 'CLAP OVERHEAD', left: 'MOVE LEFT',
  right: 'MOVE RIGHT', center: 'BACK TO CENTER', run: 'RUN IN PLACE'
};
export const DIFFICULTIES = Object.freeze({
  easy: Object.freeze({
    id: 'easy', name: 'Easy', description: 'A gentler pace. One clear move at a time.',
    speed: 14.5, walkSpeed: 2.7, warmupSpeed: 7.5, recoverySpeed: 7, cooldownSpeed: 6.5,
    gaps: [7.2, 6.8, 7.6], leadSeconds: 4.2, actSeconds: 1,
    pattern: ['left', 'clap', 'center', 'jump', 'right', 'duck', 'center', 'clap'],
    phases: [['warmup', .08], ['steady', .84], ['cooldown', .08]],
  }),
  medium: Object.freeze({
    id: 'medium', name: 'Medium', description: 'Find your rhythm with a balanced mix of moves.',
    speed: 19.5, walkSpeed: 3, warmupSpeed: 9, recoverySpeed: 8, cooldownSpeed: 7,
    gaps: [4.8, 4.5, 5.1], leadSeconds: 3.65, actSeconds: .9,
    pattern: ['jump', 'left', 'duck', 'clap', 'center', 'jump', 'right', 'duck', 'center', 'clap'],
    phases: [['warmup', .08], ['steady', .4], ['recovery', .08], ['steady', .36], ['cooldown', .08]],
  }),
  workout: Object.freeze({
    id: 'workout', name: 'Workout', description: 'Continuous fast movement. No scheduled slowdowns or breaks.',
    speed: 26, walkSpeed: 3.4, warmupSpeed: 10, recoverySpeed: 9, cooldownSpeed: 7.5,
    gaps: [3, 2.8, 3.25, 2.85, 3.15], leadSeconds: 3.2, actSeconds: .85,
    pattern: ['left', 'jump', 'center', 'duck', 'right', 'clap', 'center', 'jump', 'left', 'duck', 'center', 'clap', 'right', 'jump', 'center', 'duck'],
    phases: [['work', 1]],
  }),
});
function profileFor(id) {
  return Object.prototype.hasOwnProperty.call(DIFFICULTIES, id) ? DIFFICULTIES[id] : DIFFICULTIES.medium;
}
const laneFor = action => action === 'left' ? -1 : action === 'right' ? 1 : 0;
const isLaneAction = action => action === 'left' || action === 'right' || action === 'center';
export function createPhasePlan(difficulty = 'medium', duration = 90) {
  const profile = profileFor(difficulty), result = [];
  const workCount = profile.phases.filter(([id]) => id === 'work').length;
  let start = 0, work = 0;
  profile.phases.forEach(([id, fraction], index) => {
    const end = index === profile.phases.length - 1 ? duration : start + duration * fraction;
    const label = id === 'warmup' ? 'Warm up' : id === 'cooldown' ? 'Cool down' :
      id === 'recovery' ? 'Active recovery' : id === 'work' ?
        (workCount === 1 ? 'Continuous workout' : `Work interval ${++work}/${workCount}`) : 'Steady pace';
    const speed = id === 'warmup' ? profile.warmupSpeed : id === 'recovery' ? profile.recoverySpeed :
      id === 'cooldown' ? profile.cooldownSpeed : profile.speed;
    result.push({ id, index, label, start, end, speed, gates: id === 'steady' || id === 'work' });
    start = end;
  });
  return result;
}
/** Static templates also provide the attract-mode scene. Live runs schedule these safely ahead. */
export function makeCourse(length = 2000, { difficulty = 'medium' } = {}) {
  const profile = profileFor(difficulty), events = [], coins = [];
  let lane = 0, previous = 0, index = 0;
  for (let distance = profile.speed * (profile.leadSeconds + .2); distance < length;) {
    const action = profile.pattern[index % profile.pattern.length];
    const targetLane = isLaneAction(action) ? laneFor(action) : lane;
    events.push({ id: index, distance, action, kind: isLaneAction(action) ? 'lane' : action,
      targetLane, judged: false, success: false, cancelled: false });
    for (let d = previous + 9; d < distance - 3; d += 5.7) {
      coins.push({ distance: d, lane: isLaneAction(action) && d > distance - 30 ? targetLane : lane, claimed: false, passed: false });
    }
    previous = distance; lane = targetLane;
    distance += profile.speed * profile.gaps[index++ % profile.gaps.length];
  }
  return { events, coins };
}
export class RunSession {
  constructor(options = {}) { this.reset(options); }
  reset({ duration = 90, mode = 'keyboard', gentle = false, world = 'forest', difficulty = 'medium', preview = false } = {}) {
    this.duration = Math.max(15, Number(duration) || 90);
    this.mode = mode; this.gentle = gentle; this.world = WORLDS.includes(world) ? world : 'forest';
    this.profile = profileFor(difficulty); this.difficulty = this.profile.id; this.preview = preview;
    this.phasePlan = createPhasePlan(this.difficulty, this.duration); this.phaseIndex = 0;
    this.time = 0; this.distance = 0; this.score = 0; this.coins = 0; this.combo = 0;
    this.bestCombo = 0; this.energy = 100; this.lane = 0;
    // The pre-run countdown is the preparation time for Workout. Keyboard
    // sessions start at work pace; body controls still follow actual cadence.
    this.speed = this.difficulty === 'workout' && mode === 'keyboard' ? this.profile.speed : 0;
    this.runTarget = mode === 'keyboard' ? 1 : 0; this.runPower = this.runTarget;
    this.lastRun = 0; this.lastActions = { jump: -100, duck: -100, clap: -100 };
    this.lastDuckSignal = -100; this.lastClapSignal = -100;
    this.jumpStarted = -100; this.duckUntil = -100; this.clapUntil = -100;
    this.magnetUntil = -100; this.finished = false; this.paused = false;
    this.successes = 0; this.misses = 0; this.pending = [];
    this.actionSerial = 0; this.armedAction = null; this.spawnCursor = 0; this.routeLane = 0; this.lastScheduled = null;
    this.momentum = null;
    const course = makeCourse(Math.max(2200, this.duration * this.profile.speed * 1.5), { difficulty: this.difficulty });
    this.events = course.events; this.coinsList = course.coins;
    if (!preview) {
      this.events.forEach(event => { event.distance = Infinity; });
      this.coinsList.forEach(coin => { coin.lane = 0; });
    }
    return this;
  }
  get phaseInfo() {
    return this.phasePlan.find(phase => this.time < phase.end - 1e-9) || this.phasePlan[this.phasePlan.length - 1];
  }
  input(action, { value } = {}) {
    if (this.finished || this.paused) return;
    if (action === 'run') {
      this.runTarget = Math.max(0, Math.min(1, Number(value) || 0)); this.lastRun = this.time; return;
    }
    let fresh = false, recordedAction = action;
    if (action === 'left' || action === 'right' || action === 'lane') {
      const previous = this.lane;
      this.lane = action === 'left' ? Math.max(-1, this.lane - 1) : action === 'right' ? Math.min(1, this.lane + 1) :
        Math.max(-1, Math.min(1, Math.round(Number(value) || 0)));
      fresh = previous !== this.lane;
      recordedAction = this.lane < 0 ? 'left' : this.lane > 0 ? 'right' : 'center';
    } else if (action === 'jump') {
      if (this.time - this.jumpStarted > .82) {
        fresh = true; this.jumpStarted = this.time; this.lastActions.jump = this.time;
        this.duckUntil = this.clapUntil = -100;
      }
    } else if (action === 'duck') {
      // Camera sends a 450ms heartbeat while crouching. It extends the pose,
      // but only a new crouch (after release) creates a fresh scoring action.
      fresh = this.time - this.lastDuckSignal > .7;
      this.lastDuckSignal = this.time; this.lastActions.duck = this.time; this.duckUntil = this.time + 1.05;
      this.jumpStarted = this.clapUntil = -100;
    } else if (action === 'clap') {
      fresh = this.time - this.lastClapSignal > .55;
      this.lastClapSignal = this.time;
      if (fresh) {
        this.lastActions.clap = this.time; this.clapUntil = this.time + 1.05;
        this.jumpStarted = this.duckUntil = -100; this.magnetUntil = this.time + 1.5;
      }
    }
    if (!fresh) return;
    const cue = this.cue;
    // Each physical action belongs to one displayed gate. A mismatching body
    // gesture supersedes the earlier one; old timestamps cannot clear a new gate.
    // A sideways correction during a full-width body gate does not cancel that pose.
    if (isLaneAction(recordedAction) && cue && !isLaneAction(cue.action)) return;
    this.armedAction = cue ? { serial: ++this.actionSerial, eventId: cue.id, action: recordedAction,
      time: this.time, lane: this.lane, consumed: false } : null;
    if (!isLaneAction(recordedAction)) {
      // A player naturally stops jogging to jump, crouch, or clap. Preserve
      // approach momentum through this one correctly timed gate so its ETA
      // does not expand beyond the pose window while cadence falls to zero.
      const onTime = cue && recordedAction === cue.action && cue.seconds <= this.profile.actSeconds + .05;
      this.momentum = onTime ? { eventId: cue.id, speed: this.speed, until: this.time + cue.seconds + .16 } : null;
    }
  }
  get jumpHeight() {
    const t = (this.time - this.jumpStarted) / (this.gentle ? 1.4 : 1.14);
    return t >= 0 && t <= 1 ? Math.sin(t * Math.PI) * 2.35 : 0;
  }
  get ducking() { return this.time < this.duckUntil; }
  get clapping() { return this.time < this.clapUntil; }
  get multiplier() { return Math.min(5, 1 + Math.floor(this.combo / 12)); }
  get cue() {
    if (this.finished || (!this.preview && !this.phaseInfo.gates)) return null;
    const upcoming = this.events.filter(event => !event.judged && Number.isFinite(event.distance));
    const event = upcoming[0]; if (!event) return null;
    const seconds = (event.distance - this.distance) / Math.max(.1, this.speed);
    if (seconds > this.profile.leadSeconds) return null;
    const next = upcoming[1];
    return { id: event.id, action: event.action, label: ACTION_LABELS[event.action],
      seconds: Math.max(0, seconds), leadSeconds: this.profile.leadSeconds, actSeconds: this.profile.actSeconds,
      targetLane: event.targetLane, nextAction: next ? next.action : null,
      nextTargetLane: next ? next.targetLane : null,
      nextSeconds: next ? Math.max(0, (next.distance - this.distance) / Math.max(.1, this.speed)) : null };
  }
  get stats() {
    const phase = this.phaseInfo;
    return { score: this.score, coins: this.coins, combo: this.combo, bestCombo: this.bestCombo,
      distance: Math.floor(this.distance), energy: Math.round(this.energy),
      progress: Math.min(1, this.time / this.duration), remaining: Math.max(0, this.duration - this.time),
      speed: this.speed, successes: this.successes, misses: this.misses, multiplier: this.multiplier,
      duration: this.duration, elapsed: this.time, mode: this.mode, difficulty: this.difficulty,
      phase: phase.id, phaseLabel: phase.label, phaseRemaining: Math.max(0, phase.end - this.time), runPower: this.runPower };
  }
  updatePhase() {
    const phase = this.phaseInfo;
    if (phase.index !== this.phaseIndex) {
      this.phaseIndex = phase.index; this.lastScheduled = null; this.armedAction = null; this.momentum = null;
      if (!phase.gates) {
        // Slowing or stopping may leave a queued obstacle behind schedule.
        // Retire it without a penalty so recovery is genuinely open track.
        this.events.forEach(event => {
          if (!event.judged && Number.isFinite(event.distance)) {
            event.judged = event.cancelled = true; event.retiredAt = this.time;
          }
        });
        this.routeLane = this.lane;
        this.refreshCoinLanes();
      }
    }
    return phase;
  }
  scheduleGates(phase) {
    if (!phase.gates) return;
    let active = this.events.filter(event => !event.judged && Number.isFinite(event.distance)).length;
    let changed = false;
    while (active < 2 && this.spawnCursor < this.events.length) {
      const event = this.events[this.spawnCursor];
      if (event.kind === 'lane' && event.targetLane === this.routeLane) {
        event.judged = event.cancelled = true; this.spawnCursor++; continue;
      }
      const gap = this.profile.gaps[Math.max(0, event.id - 1) % this.profile.gaps.length];
      const distance = this.lastScheduled ? this.lastScheduled.distance + this.profile.speed * gap :
        this.distance + this.profile.speed * (this.profile.leadSeconds + .2);
      const nominalArrival = this.time + (distance - this.distance) / Math.max(this.speed, this.profile.speed * .55);
      if (nominalArrival > phase.end - .65) break;
      event.distance = distance; event.phase = phase.id; event.phaseIndex = phase.index; event.scheduledAt = this.time;
      if (event.kind !== 'lane') event.targetLane = this.routeLane;
      this.routeLane = event.targetLane; this.lastScheduled = event;
      this.spawnCursor++; active++; changed = true;
    }
    if (changed) this.refreshCoinLanes();
  }
  refreshCoinLanes() {
    const turns = this.events.filter(event => event.kind === 'lane' && Number.isFinite(event.distance) && !event.cancelled);
    for (const coin of this.coinsList) {
      if (coin.passed) continue;
      let lane = 0;
      for (const turn of turns) {
        if (coin.distance < turn.distance - Math.min(30, this.profile.speed * 2)) break;
        lane = turn.targetLane;
      }
      coin.lane = lane;
    }
  }
  judge(event) {
    const token = this.armedAction;
    const age = token ? this.time - token.time : Infinity;
    const fresh = Boolean(token && !token.consumed && token.eventId === event.id && token.action === event.action);
    event.judged = true;
    // Lane gates are position objectives: a player who already moved to the
    // correct lane must not be asked to leave it and move back for a token.
    // Body gates require a distinct, matching action bound to this gate.
    event.success = event.kind === 'lane' ? this.lane === event.targetLane : fresh && (
      event.action === 'jump' ? this.jumpHeight > .16 && age <= (this.gentle ? 1.45 : 1.2) :
      event.action === 'duck' ? this.ducking && age <= 1.2 : this.clapping && age <= 1.05);
    if (token && token.eventId === event.id) token.consumed = true;
    if (this.momentum && this.momentum.eventId === event.id) this.momentum = null;
    if (event.success) {
      this.successes++; this.combo += 5; this.bestCombo = Math.max(this.bestCombo, this.combo);
      this.score += 100 * this.multiplier; this.energy = Math.min(100, this.energy + 7);
      if (event.action === 'clap') this.magnetUntil = this.time + 3;
      this.pending.push({ kind: 'success', text: event.action === 'clap' ? 'COIN MAGNET!' : ['NICE MOVE!', 'KEEP IT GOING!', 'PERFECT!'][this.successes % 3], action: event.action, eventId: event.id });
    } else {
      this.misses++; this.combo = 0; this.energy = Math.max(12, this.energy - 14);
      this.pending.push({ kind: 'miss', text: 'KEEP MOVING · YOU’VE GOT THIS', action: event.action, eventId: event.id });
    }
  }
  step(dt) {
    if (this.paused || this.finished || !Number.isFinite(dt) || dt <= 0) return;
    dt = Math.min(dt, .1, this.duration - this.time);
    this.time = Math.min(this.duration, this.time + dt);
    const phase = this.updatePhase();
    const desired = this.mode === 'keyboard' ? 1 : this.time - this.lastRun > 1.2 ? 0 : this.runTarget;
    this.runPower += (desired - this.runPower) * (1 - Math.exp(-dt * 4));
    let targetSpeed = this.profile.walkSpeed + this.runPower * (phase.speed - this.profile.walkSpeed);
    if (this.momentum) {
      const gate = this.events[this.momentum.eventId];
      if (this.time > this.momentum.until || !gate || gate.judged) this.momentum = null;
      else targetSpeed = Math.max(targetSpeed, this.momentum.speed);
    }
    this.speed += (targetSpeed - this.speed) * (1 - Math.exp(-dt * 5));
    this.distance += this.speed * dt;
    this.scheduleGates(phase);
    for (const coin of this.coinsList) {
      if (coin.passed) continue;
      if (coin.distance > this.distance + .6) break;
      coin.passed = true;
      if (coin.lane === this.lane || this.time < this.magnetUntil) {
        coin.claimed = true; this.coins++; this.combo++; this.bestCombo = Math.max(this.bestCombo, this.combo);
        const points = 10 * this.multiplier; this.score += points;
        this.pending.push({ kind: 'coin', text: `+${points}`, lane: coin.lane, distance: coin.distance });
      }
    }
    for (const event of this.events) if (!event.judged && event.distance <= this.distance) this.judge(event);
    if (this.time >= this.duration) this.finished = true;
  }
  drainEvents() { return this.pending.splice(0); }
}
