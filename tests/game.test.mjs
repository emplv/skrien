import test from 'node:test';
import assert from 'node:assert/strict';
import { RunSession, makeCourse, createPhasePlan, DIFFICULTIES, WORLDS } from '../web/game-logic.js';
import { RunnerGame } from '../web/game.js';

const laneAction = action => ['left', 'right', 'center'].includes(action);
function advance(session, seconds, controller = () => {}, observe = () => {}) {
  for (let frame = 0; frame < Math.ceil(seconds * 60); frame++) {
    controller(session, frame); session.step(1 / 60); observe(session);
  }
  return session;
}
function perfectController({ effort = null } = {}) {
  const completedInputs = new Set();
  return session => {
    if (effort !== null) session.input('run', { value: effort });
    const cue = session.cue;
    if (!cue || cue.seconds > Math.min(.65, cue.actSeconds) || completedInputs.has(cue.id)) return;
    completedInputs.add(cue.id);
    session.input(laneAction(cue.action) ? 'lane' : cue.action, { value: cue.targetLane });
  };
}
function completeRun(difficulty, duration = 90, mode = 'keyboard') {
  const history = [], phases = [], seenPhases = new Set();
  const session = advance(new RunSession({ difficulty, duration, mode }), duration + 1,
    perfectController({ effort: mode === 'keyboard' ? null : 1 }), s => {
      if (!seenPhases.has(s.phaseInfo.index)) { seenPhases.add(s.phaseInfo.index); phases.push(s.stats.phase); }
      for (const event of s.drainEvents()) if (event.kind === 'success' || event.kind === 'miss') history.push({ ...event, time: s.time });
    });
  return { session, history, phases };
}

for (const difficulty of Object.keys(DIFFICULTIES)) {
  test(`${difficulty}: complete 60/90/180-second runs are clearable from displayed cues`, () => {
    for (const duration of [60, 90, 180]) {
      const { session, history } = completeRun(difficulty, duration);
      assert.equal(session.finished, true);
      assert.equal(session.misses, 0, `${difficulty}/${duration}s must have no impossible or mismatched gates`);
      assert.ok(session.successes > 4);
      assert.ok(session.coins > 50);
      assert.equal(session.stats.remaining, 0);
      assert.equal(session.stats.progress, 1);
      assert.deepEqual(new Set(history.map(event => event.action)), new Set(['jump', 'left', 'duck', 'clap', 'right', 'center']));
    }
  });
  test(`${difficulty}: a full-effort camera run also clears every presented gate`, () => {
    const { session } = completeRun(difficulty, 90, 'camera');
    assert.equal(session.misses, 0);
    assert.ok(session.successes >= 8);
    assert.ok(session.stats.runPower > .99);
  });
}

test('Default and unknown profiles resolve to Medium', () => {
  assert.equal(new RunSession().difficulty, 'medium');
  assert.equal(new RunSession({ difficulty: 'invalid' }).difficulty, 'medium');
  assert.equal(new RunSession({ difficulty: '__proto__' }).difficulty, 'medium');
});

test('Difficulty tiers increase actual distance, gate count, and action density', () => {
  const runs = Object.keys(DIFFICULTIES).map(id => completeRun(id));
  assert.ok(runs[2].session.successes >= 28, 'Workout keeps presenting moves throughout a 90-second run.');
  for (let i = 1; i < runs.length; i++) {
    assert.ok(runs[i].session.distance > runs[i - 1].session.distance * 1.15);
    assert.ok(runs[i].session.successes > runs[i - 1].session.successes);
  }
  for (const run of runs) {
    const gaps = run.history.slice(1).map((gate, index) => gate.time - run.history[index].time);
    assert.ok(Math.min(...gaps) >= Math.min(...run.session.profile.gaps) - .03);
  }
  assert.notDeepEqual(runs[0].history.slice(0, 6).map(e => e.action), runs[1].history.slice(0, 6).map(e => e.action));
  assert.notDeepEqual(runs[1].history.slice(0, 6).map(e => e.action), runs[2].history.slice(0, 6).map(e => e.action));
});

test('Workout stays at continuous work pace for the entire 60/90/180-second session', () => {
  for (const duration of [60, 90, 180]) {
    const session = new RunSession({ difficulty: 'workout', duration });
    const initialSpeed = session.speed;
    assert.equal(initialSpeed, DIFFICULTIES.workout.speed);
    advance(session, duration + 1, perfectController(), s => {
      assert.equal(s.stats.difficulty, 'workout');
      assert.equal(s.stats.phase, 'work');
      assert.equal(s.stats.phaseLabel, 'Continuous workout');
      assert.equal(s.stats.phaseRemaining, s.stats.remaining);
      assert.equal(s.stats.speed, initialSpeed, 'No warmup, recovery, cooldown, or miss changes Workout pace.');
    });
    assert.equal(session.finished, true);
    assert.equal(session.events.some(event => Number.isFinite(event.retiredAt)), false);
    assert.equal(session.misses, 0);
    assert.equal(session.phasePlan.length, 1);
    assert.equal(createPhasePlan('workout', duration)[0].end, duration);
  }
});

test('A 60-second Workout presents all moves promptly and keeps them coming to the finish', () => {
  const { history } = completeRun('workout', 60);
  assert.ok(history[0].time < 3.5, 'The first sidestep arrives immediately after its readable countdown.');
  assert.deepEqual(new Set(history.filter(event => event.time < 19).map(event => event.action)),
    new Set(['left', 'right', 'center', 'jump', 'duck', 'clap']));
  assert.ok(history[history.length - 1].time > 57, 'There is no final cooldown stretch.');
  assert.ok(history.length >= 19);
});

test('Easy and Medium retain their preparation and recovery phases', () => {
  assert.deepEqual(completeRun('easy').phases, ['warmup', 'steady', 'cooldown']);
  assert.deepEqual(completeRun('medium').phases, ['warmup', 'steady', 'recovery', 'steady', 'cooldown']);
  const session = new RunSession({ difficulty: 'medium' });
  const speeds = {};
  advance(session, 90, () => {}, s => {
    if (s.time - s.phaseInfo.start > 2 && speeds[s.phaseInfo.index] === undefined) speeds[s.phaseInfo.index] = s.speed;
  });
  assert.ok(speeds[1] > speeds[0] * 1.5);
  assert.ok(speeds[2] < speeds[1] * .6);
  assert.ok(speeds[3] > speeds[2] * 1.7);
  assert.ok(speeds[4] < speeds[3] * .51);
});

test('Cue metadata gives a stable identity, truthful countdown, and distinct next move', () => {
  const session = new RunSession({ difficulty: 'workout' });
  let checked = false;
  advance(session, 11, () => {}, s => {
    const cue = s.cue;
    if (!cue) return;
    checked = true;
    const event = s.events.find(item => item.id === cue.id);
    assert.ok(Math.abs(cue.seconds - (event.distance - s.distance) / s.speed) < 1e-7);
    assert.equal(cue.leadSeconds, DIFFICULTIES.workout.leadSeconds);
    assert.equal(cue.actSeconds, DIFFICULTIES.workout.actSeconds);
    assert.ok(cue.seconds <= cue.leadSeconds);
    assert.ok(cue.actSeconds > 0 && cue.actSeconds < cue.leadSeconds);
    if (cue.nextAction) assert.notEqual(cue.nextAction, cue.action);
  });
  assert.equal(checked, true);
});

test('Workout action spacing leaves time to finish one movement before the next', () => {
  const { session, history } = completeRun('workout', 180);
  for (let index = 1; index < history.length; index++) {
    const previous = history[index - 1], next = history[index];
    assert.ok(next.time - previous.time >= 2.77, 'Every gate has at least a complete jump/duck cycle between it and the previous gate.');
    assert.notEqual(next.action, previous.action);
  }
  const laneGates = session.events.filter(event => event.success && event.kind === 'lane');
  let previousLane = 0;
  for (const event of laneGates) {
    assert.equal(Math.abs(event.targetLane - previousLane), 1, 'A prompted sidestep never requires crossing two lanes at once.');
    previousLane = event.targetLane;
  }
});

test('Ignoring obstacles costs energy and resets the streak without ending the run', () => {
  const session = advance(new RunSession(), 18);
  assert.ok(session.misses >= 1); assert.ok(session.energy < 100);
  assert.ok(session.pending.some(event => event.kind === 'miss'));
  assert.ok(session.bestCombo > session.combo);
  assert.equal(session.finished, false);
});

test('A jump made in the warmup does not satisfy a future jump gate', () => {
  const session = new RunSession(); session.input('jump'); advance(session, 13);
  const jump = session.events.find(event => event.action === 'jump' && Number.isFinite(event.distance));
  assert.equal(jump.judged, true); assert.equal(jump.success, false);
});

test('Changing from the correct jump to a duck before the gate cannot clear the jump', () => {
  const session = new RunSession(); let jumped = false, ducked = false;
  advance(session, 13, s => {
    const cue = s.cue;
    if (!cue || cue.action !== 'jump') return;
    if (cue.seconds < .8 && !jumped) { s.input('jump'); jumped = true; }
    if (cue.seconds < .3 && !ducked) { s.input('duck'); ducked = true; }
  });
  assert.ok(jumped && ducked);
  assert.equal(session.events[0].success, false);
});

test('A fresh clap cannot be mistaken for a jump', () => {
  const session = new RunSession(); let clapped = false;
  advance(session, 13, s => {
    const cue = s.cue;
    if (cue && cue.action === 'jump' && cue.seconds < .6 && !clapped) { s.input('clap'); clapped = true; }
  });
  assert.equal(clapped, true); assert.equal(session.events[0].success, false);
});

test('One successful jump action cannot clear another jump gate', () => {
  const session = new RunSession(); let jumped = false;
  advance(session, 42, s => {
    const cue = s.cue;
    if (!jumped && cue && cue.action === 'jump' && cue.seconds < .65) { s.input('jump'); jumped = true; }
  });
  const jumps = session.events.filter(event => event.action === 'jump' && event.judged && !event.cancelled);
  assert.ok(jumps.length >= 2); assert.equal(jumps[0].success, true); assert.equal(jumps[1].success, false);
});

test('A continuously held duck heartbeat scores once, not at every subsequent duck gate', () => {
  const session = new RunSession(); let began = false, nextHeartbeat = Infinity;
  advance(session, 90, s => {
    const cue = s.cue;
    if (!began && cue && cue.action === 'duck' && cue.seconds < .65) { began = true; nextHeartbeat = s.time; }
    if (s.time >= nextHeartbeat) { s.input('duck'); nextHeartbeat = s.time + .45; }
  });
  const ducks = session.events.filter(event => event.action === 'duck' && event.judged && !event.cancelled);
  assert.ok(ducks.length >= 2); assert.equal(ducks.filter(event => event.success).length, 1);
});

test('A player already in the prompted lane clears the gate without an unnecessary extra sidestep', () => {
  const session = new RunSession({ difficulty: 'easy' }); session.input('left');
  advance(session, 14, s => s.input('lane', { value: -1 }));
  assert.equal(session.events[0].judged, true); assert.equal(session.events[0].success, true);
});

test('Holding one lane still cannot clear all the alternating lane objectives', () => {
  const session = new RunSession({ difficulty: 'easy' }); session.input('left');
  advance(session, 90, s => s.input('lane', { value: -1 }));
  const laneGates = session.events.filter(event => event.kind === 'lane' && event.judged && !event.cancelled);
  assert.ok(laneGates.some(event => event.success));
  assert.ok(laneGates.some(event => !event.success));
});

test('Low-impact knee lifts have a usable longer virtual-jump window', () => {
  const sessions = [new RunSession(), new RunSession({ gentle: true })];
  for (const session of sessions) {
    let lifted = false;
    advance(session, 13, s => {
      const cue = s.cue;
      if (cue && cue.action === 'jump' && cue.seconds < 1.25 && !lifted) { s.input('jump'); lifted = true; }
    });
  }
  assert.equal(sessions[0].events[0].success, false);
  assert.equal(sessions[1].events[0].success, true);
});

for (const difficulty of Object.keys(DIFFICULTIES)) {
  test(`${difficulty}: stopping jogging for jump/duck/clap preserves the gate timing, including 130ms sensor delay`, () => {
    for (const targetAction of ['jump', 'duck', 'clap']) for (const sensorDelay of [0, .13]) {
      const session = new RunSession({ difficulty, mode: 'camera' }), handled = new Set();
      let targetId = null, gestureDue = Infinity, dropUntil = -1;
      for (let frame = 0; frame < 5400; frame++) {
        session.input('run', { value: session.time < dropUntil ? 0 : 1 });
        const cue = session.cue;
        if (cue && targetId === null && cue.action === targetAction && cue.seconds <= cue.actSeconds) {
          targetId = cue.id; dropUntil = session.time + 1; gestureDue = session.time + sensorDelay;
          // Jogging stops when the physical move begins, before a delayed
          // camera inference result reports which body gesture occurred.
          session.input('run', { value: 0 });
        }
        if (targetId !== null && session.time >= gestureDue && !handled.has(targetId)) {
          session.input(targetAction); handled.add(targetId);
        } else if (cue && cue.id !== targetId && cue.seconds <= .65 && !handled.has(cue.id)) {
          session.input(laneAction(cue.action) ? 'lane' : cue.action, { value: cue.targetLane }); handled.add(cue.id);
        }
        session.step(1 / 60);
        if (targetId !== null && session.events[targetId].judged) break;
      }
      assert.notEqual(targetId, null);
      assert.equal(session.events[targetId].cancelled, false);
      assert.equal(session.events[targetId].success, true, `${targetAction}, inference delay ${sensorDelay}s`);
      assert.equal(session.momentum, null, 'Momentum ends when this particular gate is crossed.');
      const crossingSpeed = session.speed;
      advance(session, 1.8, s => s.input('run', { value: 0 }));
      assert.ok(session.speed < crossingSpeed * .55, 'Cadence controls speed again after the gate.');
      const walkingSpeed = session.speed;
      advance(session, 1.2, s => s.input('run', { value: 1 }));
      assert.ok(session.speed > walkingSpeed * 1.6, 'Resuming jogging accelerates normally.');
    }
  });
}

test('A too-early camera jump gets no momentum hold and cannot clear its later gate', () => {
  const session = new RunSession({ mode: 'camera' });
  let acted = false, dropUntil = -1;
  advance(session, 16, s => {
    s.input('run', { value: s.time < dropUntil ? 0 : 1 });
    const cue = s.cue;
    if (!acted && cue && cue.action === 'jump' && cue.seconds < 2) {
      acted = true; s.input('jump'); dropUntil = s.time + 1;
      assert.equal(s.momentum, null);
    }
  });
  assert.ok(acted); assert.equal(session.events[0].success, false);
});

test('A mismatched camera gesture never receives the intended gate momentum hold', () => {
  const session = new RunSession({ mode: 'camera' }); let acted = false;
  advance(session, 14, s => {
    s.input('run', { value: 1 });
    const cue = s.cue;
    if (!acted && cue && cue.action === 'jump' && cue.seconds <= cue.actSeconds) {
      acted = true; s.input('duck'); assert.equal(s.momentum, null);
    }
  });
  assert.ok(acted); assert.equal(session.events[0].success, false);
});

test('Camera running intensity materially controls forward movement in every tier', () => {
  for (const difficulty of Object.keys(DIFFICULTIES)) {
    const idle = advance(new RunSession({ mode: 'camera', difficulty }), 90);
    const running = advance(new RunSession({ mode: 'camera', difficulty }), 90, s => s.input('run', { value: 1 }));
    assert.ok(running.distance > idle.distance * 3);
    assert.ok(idle.distance > 0);
  }
});

test('Stopping the pose signal returns to walking pace instead of retaining stale effort', () => {
  const session = new RunSession({ mode: 'phone' });
  advance(session, 12, s => s.input('run', { value: 1 })); const speed = session.speed;
  advance(session, 4); assert.ok(session.speed < speed / 2);
});

test('A stopped player never receives delayed obstacles during recovery', () => {
  const session = new RunSession({ difficulty: 'medium', mode: 'camera' });
  let checkedRecovery = false;
  advance(session, 90, s => s.input('run', { value: s.time < 20 ? 1 : 0 }), s => {
    if (s.stats.phase === 'recovery' || s.stats.phase === 'cooldown') {
      checkedRecovery = true;
      assert.equal(s.cue, null);
      assert.equal(s.events.filter(event => !event.judged && Number.isFinite(event.distance)).length, 0);
    }
  });
  assert.ok(checkedRecovery);
  assert.ok(session.events.some(event => event.cancelled && Number.isFinite(event.retiredAt)));
});

test('Cancelling an unperformed turn restores the route to the actual lane for recovery', () => {
  const session = new RunSession({ difficulty: 'medium', mode: 'camera' });
  let checked = false;
  advance(session, 45, s => s.input('run', { value: s.time < 35 ? 1 : 0 }), s => {
    if (s.stats.phase !== 'recovery') return;
    checked = true;
    assert.equal(s.routeLane, s.lane);
    assert.equal(s.lane, 0);
    assert.equal(s.events.filter(event => !event.judged && Number.isFinite(event.distance)).length, 0);
  });
  assert.ok(checked);
  assert.ok(session.events.some(event => event.kind === 'lane' && event.cancelled && Number.isFinite(event.retiredAt)));
});

test('Pause freezes interval time, movement, cues, and fresh-input state', () => {
  const session = advance(new RunSession(), 10);
  const before = session.stats, cue = session.cue, events = JSON.stringify(session.events);
  session.paused = true; session.input('right'); session.input('jump'); advance(session, 12);
  assert.deepEqual(session.stats, before); assert.deepEqual(session.cue, cue);
  assert.equal(JSON.stringify(session.events), events); assert.equal(session.lane, 0);
  session.paused = false; advance(session, 1);
  assert.ok(session.time > before.elapsed); assert.ok(session.distance > before.distance);
});

test('Finishing is terminal and remaining session/phase times cannot be negative', () => {
  const session = advance(new RunSession({ duration: 15 }), 16), final = session.stats;
  session.input('clap'); session.input('left'); advance(session, 30);
  assert.deepEqual(session.stats, final); assert.equal(session.time, 15);
  assert.equal(session.stats.remaining, 0); assert.equal(session.stats.phaseRemaining, 0);
});

test('Absolute and relative lane inputs remain inside the track', () => {
  const session = new RunSession();
  session.input('lane', { value: 20 }); assert.equal(session.lane, 1);
  session.input('right'); assert.equal(session.lane, 1);
  session.input('left'); assert.equal(session.lane, 0);
  session.input('left'); session.input('left'); assert.equal(session.lane, -1);
  session.input('lane', { value: 0 }); assert.equal(session.lane, 0);
});

test('A clap briefly attracts coins from the adjacent lane', () => {
  const normal = new RunSession(), magnet = new RunSession();
  normal.input('left'); magnet.input('left'); magnet.input('clap');
  advance(normal, 1.4); advance(magnet, 1.4);
  assert.equal(normal.coins, 0); assert.ok(magnet.coins > 0);
});

test('Suspended frames cannot teleport the runner through unseen obstacles', () => {
  const session = new RunSession(); session.step(60);
  assert.ok(session.time <= .1); assert.ok(session.distance < 2);
  session.step(-1); session.step(NaN); assert.ok(Number.isFinite(session.distance));
});

test('Course templates are deterministic, profile-specific, and have valid lanes', () => {
  for (const difficulty of Object.keys(DIFFICULTIES)) {
    const first = makeCourse(1000, { difficulty });
    assert.deepEqual(first, makeCourse(1000, { difficulty }));
    assert.ok(first.coins.every(coin => [-1, 0, 1].includes(coin.lane)));
    assert.ok(first.events.every((event, index) => index === 0 || event.distance > first.events[index - 1].distance));
  }
});

test('Actual renderer frames preserve the selected trail through every session length and difficulty', () => {
  // Run the real start, frame, setWorld, stop, and state code without a GPU.
  // Geometry animation is outside this regression; world changes, palette
  // changes, callbacks, and live gameplay are exercised rather than mocked.
  const position = () => ({ x: 0, y: 0, z: 0, set(x, y, z) { Object.assign(this, { x, y, z }); } });
  const color = () => ({ value: 0, set(value) { this.value = value; } });
  const material = () => ({ color: color(), emissive: color() });
  const noop = () => {};
  const previousRAF = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = () => 1;
  try {
    for (const world of WORLDS) for (const difficulty of Object.keys(DIFFICULTIES)) for (const duration of [60, 90, 180]) {
      const changes = [], finishes = [];
      const mode = duration === 60 ? 'keyboard' : duration === 90 ? 'camera' : 'phone';
      const game = Object.assign(Object.create(RunnerGame.prototype), {
        session: new RunSession(), status: 'attract', world: 'forest', visualTime: 0, attractDistance: 0,
        lastFrame: 0, lastReport: -1, hitFlash: 0, scene: {},
        callbacks: { onWorldChange: name => changes.push(name), onFinish: stats => finishes.push(stats) },
        worlds: Object.fromEntries(WORLDS.map(name => [name, { visible: false }])),
        segments: Object.fromEntries(WORLDS.map(name => [name, [{ position: position() }, { position: position() }]])),
        camera: { position: position(), lookAt: noop }, renderer: { render: noop },
        runner: { position: position() }, clouds: { rotation: { y: 0 } },
        skyMaterial: { uniforms: { top: { value: color() }, bottom: { value: color() } } },
        light: { color: color() }, sun: { material: material() }, sunHalo: { material: material() },
        makeObstacles: noop, updateRunner: noop, updateCourse: noop, updateParticles: noop, burst: noop,
      });
      for (const name of ['roadMaterial', 'edgeMaterial', 'groundMaterial', 'waterMaterial', 'mountainMaterial']) game[name] = material();
      for (const name of ['laneDashes', 'roadTiles', 'ripples', 'motes']) game[name] = { position: position() };
      game.start({ world, difficulty, duration, mode });
      const startedAt = game.lastFrame, initialSky = game.skyMaterial.uniforms.top.value.value;
      const controller = perfectController({ effort: mode === 'keyboard' ? null : 1 });
      for (let frame = 1; frame <= duration * 20 + 2; frame++) {
        controller(game.session);
        game.frame(startedAt + frame * 50);
        assert.equal(game.state.world, world, `${world}/${difficulty}/${duration}s changed trails during playback`);
        assert.equal(game.state.difficulty, difficulty);
        assert.equal(game.skyMaterial.uniforms.top.value.value, initialSky);
      }
      assert.equal(game.status, 'finished');
      assert.equal(finishes.length, 1);
      assert.deepEqual(changes, [world], 'Only selecting the trail at start should emit a world change.');
      for (const name of WORLDS) assert.equal(game.worlds[name].visible, name === world);
      game.stop();
      assert.equal(game.world, world);
      assert.equal(game.session.world, world, 'Returning to the menu preserves the current trail.');
      const nextWorld = WORLDS[(WORLDS.indexOf(world) + 1) % WORLDS.length];
      game.start({ world: nextWorld, difficulty, duration });
      assert.equal(game.state.world, nextWorld, 'A new explicit trail choice still takes effect.');
      assert.deepEqual(changes, [world, nextWorld]);
    }
  } finally {
    if (previousRAF === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = previousRAF;
  }
});
