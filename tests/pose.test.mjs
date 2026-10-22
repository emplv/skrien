import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PoseInterpreter, poseFeatures, buildCalibration } from '../web/pose-logic.js';

function standing() {
  const p = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.25, z: 0, visibility: 0.99, presence: 0.99 }));
  const coords = {
    0: [0.5, 0.2], 11: [0.41, 0.32], 12: [0.59, 0.32],
    13: [0.39, 0.43], 14: [0.61, 0.43], 15: [0.38, 0.54], 16: [0.62, 0.54],
    23: [0.45, 0.58], 24: [0.55, 0.58], 25: [0.45, 0.75], 26: [0.55, 0.75],
    27: [0.45, 0.93], 28: [0.55, 0.93], 29: [0.45, 0.94], 30: [0.55, 0.94],
    31: [0.43, 0.95], 32: [0.57, 0.95],
  };
  for (const [i, xy] of Object.entries(coords)) { p[i].x = xy[0]; p[i].y = xy[1]; }
  return p;
}
function move(p, dx = 0, dy = 0) { return p.map(v => ({ ...v, x: v.x + dx, y: v.y + dy })); }
function rig(gentle = false, neutral = standing()) {
  const events = [];
  const logic = new PoseInterpreter({ gentle, onAction: (action, payload) => events.push({ action, ...payload }) });
  const samples = Array.from({ length: 42 }, () => poseFeatures(neutral));
  assert.equal(logic.calibrate(samples), true);
  events.length = 0;
  return { logic, events, count: action => events.filter(e => e.action === action).length };
}

test('calibration requires enough stable, visible full-body observations', () => {
  assert.equal(buildCalibration([poseFeatures(standing())]), null);
  assert.ok(buildCalibration(Array.from({ length: 20 }, () => poseFeatures(standing()))));
  const moving = Array.from({ length: 36 }, (_, i) => poseFeatures(move(standing(), i % 2 ? 0.06 : -0.06)));
  assert.equal(buildCalibration(moving), null);
  const cropped = standing(); cropped[27].y = 1.03;
  assert.equal(poseFeatures(cropped), null);
  const uncertain = standing(); uncertain[25].visibility = 0.2;
  assert.equal(poseFeatures(uncertain), null);
  const malformed = standing(); malformed[24] = null;
  assert.equal(poseFeatures(malformed), null);
});

test('standing, small tracking jitter and arm movement do not create running or jumps', () => {
  const { logic, events, count } = rig();
  for (let i = 0; i < 120; i++) {
    const p = move(standing(), Math.sin(i) * 0.003, Math.cos(i) * 0.004);
    p[15].y += Math.sin(i * 0.3) * 0.1;
    p[16].y += Math.cos(i * 0.3) * 0.1;
    logic.update(p, i * 72);
  }
  assert.equal(count('jump'), 0);
  assert.equal(count('duck'), 0);
  assert.equal(count('clap'), 0);
  assert.ok(events.filter(e => e.action === 'run').every(e => e.value === 0));
});

test('sidesteps follow the mirrored preview, use absolute lanes and return to centre', () => {
  const { logic, events } = rig();
  logic.update(standing(), 0);
  logic.update(move(standing(), -0.13), 100);
  logic.update(move(standing(), -0.12), 200);
  logic.update(standing(), 300);
  logic.update(move(standing(), 0.13), 400);
  logic.update(move(standing(), 0.08), 500);
  logic.update(standing(), 600);
  assert.deepEqual(events.filter(e => e.action === 'lane').map(e => e.value), [1, 0, -1, 0]);
});

test('holding a sidestep periodically restores lane after a game countdown or restart', () => {
  const { logic, events } = rig();
  logic.update(move(standing(), -0.13), 0);
  events.length = 0; // Simulate the game becoming ready after initial input.
  for (let t = 100; t <= 1500; t += 100) logic.update(move(standing(), -0.13), t);
  assert.ok(events.filter(e => e.action === 'lane').length >= 2);
  assert.ok(events.filter(e => e.action === 'lane').every(e => e.value === 1));
});

test('jumps require hip rise plus both feet, fire once in air and rearm on landing', () => {
  const { logic, count } = rig();
  const raised = move(standing(), 0, -0.075);
  logic.update(standing(), 0);
  logic.update(raised, 100);
  logic.update(raised, 300);
  logic.update(raised, 1100);
  assert.equal(count('jump'), 1);
  logic.update(standing(), 1200);
  logic.update(standing(), 1300);
  logic.update(raised, 1400);
  logic.update(raised, 1472);
  assert.equal(count('jump'), 2);
  logic.update(standing(), 1700);
  const oneFoot = move(standing(), 0, -0.06);
  oneFoot[28].y = 0.93;
  logic.update(oneFoot, 2500);
  assert.equal(count('jump'), 2);
});

test('a held crouch renews Duck without being mistaken for a jump', () => {
  const { logic, count } = rig();
  const crouched = standing();
  for (const i of [0,11,12,13,14,15,16]) crouched[i].y += 0.11;
  for (const i of [23,24]) crouched[i].y += 0.07;
  logic.update(standing(), 0);
  for (let t = 100; t < 1800; t += 100) logic.update(crouched, t);
  assert.ok(count('duck') >= 3 && count('duck') <= 4);
  assert.equal(count('jump'), 0);
  const before = count('duck');
  for (let t = 1900; t < 3000; t += 100) logic.update(standing(), t);
  assert.equal(count('duck'), before);
});

test('clapping at chest level or merely raising arms is insufficient; overhead contact triggers once', () => {
  const { logic, count } = rig();
  const clap = standing();
  clap[15].x = 0.495; clap[16].x = 0.505;
  clap[15].y = clap[16].y = 0.45;
  logic.update(clap, 0);
  assert.equal(count('clap'), 0);
  const raisedWide = standing();
  raisedWide[15].y = raisedWide[16].y = 0.1;
  logic.update(raisedWide, 100);
  assert.equal(count('clap'), 0);
  clap[15].y = clap[16].y = 0.1;
  logic.update(clap, 200);
  logic.update(clap, 1400);
  assert.equal(count('clap'), 1);
  logic.update(raisedWide, 1500);
  logic.update(clap, 1700);
  assert.equal(count('clap'), 2);
});

test('alternating steps build pace and stopping decays it to zero', () => {
  const { logic, events, count } = rig();
  for (let step = 0; step < 10; step++) {
    const p = standing();
    const knee = step % 2 ? 26 : 25;
    const ankle = step % 2 ? 28 : 27;
    p[knee].y -= 0.065;
    p[ankle].y -= 0.05;
    for (let frame = 0; frame < 5; frame++) logic.update(p, step * 360 + frame * 72);
  }
  const running = events.filter(e => e.action === 'run').map(e => e.value);
  assert.ok(Math.max(...running) > 0.65, 'Alternating steps should produce useful forward speed');
  assert.equal(count('jump'), 0, 'Ordinary jogging should not jump');
  for (let t = 3600; t <= 5500; t += 80) logic.update(standing(), t);
  assert.equal(events.filter(e => e.action === 'run').at(-1).value, 0);
});

function jogAt(stepMs, steps = 14) {
  const { logic, events } = rig();
  let state;
  for (let step = 0; step < steps; step++) {
    const p = standing();
    p[step % 2 ? 26 : 25].y -= 0.065;
    p[step % 2 ? 28 : 27].y -= 0.05;
    for (let t = 0; t < stepMs; t += 70) state = logic.update(p, step * stepMs + t);
  }
  return { state, peak: Math.max(...events.filter(e => e.action === 'run').map(e => e.value)) };
}

test('running pace follows step rate instead of maxing out at a jog', () => {
  const easyJog = jogAt(500), jog = jogAt(360), sprint = jogAt(260);
  assert.ok(easyJog.peak < 0.6, `2 steps/s should be a partial pace, got ${easyJog.peak}`);
  assert.ok(jog.peak > easyJog.peak + 0.15 && jog.peak < 0.9, `2.8 steps/s should sit between, got ${jog.peak}`);
  assert.ok(sprint.peak > 0.95, `3.8 steps/s should reach full pace, got ${sprint.peak}`);
});

test('the interpreter reports the measured step rate in steps per minute', () => {
  const { state } = jogAt(360);
  assert.ok(Math.abs(state.cadence - 167) < 12, `expected about 167 steps/min, got ${state.cadence}`);
  assert.equal(jogAt(360, 0).state, undefined);
});

test('holding up one leg cannot produce sustained running', () => {
  const { logic, events } = rig();
  const oneLeg = standing(); oneLeg[25].y -= 0.085; oneLeg[27].y -= 0.08;
  for (let t = 0; t <= 3000; t += 80) logic.update(oneLeg, t);
  assert.equal(events.filter(e => e.action === 'run').at(-1).value, 0);
});

test('losing the body clears pace rather than keeping stale movement', () => {
  const { logic, events } = rig();
  for (let i = 0; i < 8; i++) {
    const p = standing(); p[i % 2 ? 26 : 25].y -= 0.09;
    logic.update(p, i * 300);
  }
  assert.ok(events.filter(e => e.action === 'run').at(-1).value > 0);
  logic.update(null, 2500);
  assert.equal(events.at(-1).action, 'run');
  assert.equal(events.at(-1).value, 0);
});

test('gentle mode accepts a deliberate high knee, regular mode does not', () => {
  const normal = rig(false), gentle = rig(true);
  const knee = standing(); knee[25].y -= 0.13; knee[27].y -= 0.16;
  normal.logic.update(knee, 0);
  gentle.logic.update(knee, 0);
  gentle.logic.update(knee, 1600);
  assert.equal(normal.count('jump'), 0);
  assert.equal(gentle.count('jump'), 1);
  gentle.logic.update(standing(), 1700);
  gentle.logic.update(knee, 1900);
  assert.equal(gentle.count('jump'), 2);
});

test('vigorous running with airborne stride phases and body bounce stays Run rather than Jump', () => {
  const { logic, events, count } = rig();
  logic.update(standing(), 0);
  for (let frame = 0; frame < 90; frame++) {
    const p = move(standing(), 0, -0.055);
    const phase = frame % 6;
    // Two airborne strides, each followed by one brief symmetric crossover.
    if (phase < 2) { p[25].y -= 0.12; p[27].y -= 0.09; }
    else if (phase > 2 && phase < 5) { p[26].y -= 0.12; p[28].y -= 0.09; }
    logic.update(p, 70 + frame * 72);
  }
  assert.equal(count('jump'), 0);
  assert.equal(count('duck'), 0);
  assert.equal(count('clap'), 0);
  assert.ok(Math.max(...events.filter(e => e.action === 'run').map(e => e.value)) > 0.65);
});

test('a single jump-shaped tracking spike does not trigger Jump', () => {
  const { logic, count } = rig();
  logic.update(standing(), 0);
  logic.update(move(standing(), 0, -0.075), 72);
  logic.update(standing(), 144);
  logic.update(standing(), 216);
  logic.update(move(standing(), 0, -0.075), 1000);
  logic.update(standing(), 1072);
  assert.equal(count('jump'), 0);
});

test('one long flight is one jump; landing into a stride rearms the next', () => {
  const { logic, count } = rig();
  const raised = move(standing(), 0, -0.075);
  logic.update(standing(), 0);
  logic.update(raised, 72); logic.update(raised, 144);
  assert.equal(count('jump'), 1);
  for (let t = 216; t <= 1200; t += 72) logic.update(raised, t);
  assert.equal(count('jump'), 1, 'Staying in the air must not repeat Jump');
  // Players land straight into their next stride, so one foot is already lifting.
  const oneFootLanded = standing(); oneFootLanded[28].y -= 0.06;
  logic.update(oneFootLanded, 1300); logic.update(oneFootLanded, 1372);
  logic.update(raised, 1444); logic.update(raised, 1516);
  assert.equal(count('jump'), 2);
});

test('shoulder-only bending and shifting the full image downward are not Duck', () => {
  const { logic, count } = rig();
  const bend = standing(); bend[11].y += 0.11; bend[12].y += 0.11; bend[0].y += 0.11;
  for (let t = 0; t <= 1000; t += 72) logic.update(bend, t);
  assert.equal(count('duck'), 0);
  const neutral = standing(); neutral[27].y = neutral[28].y = 0.84;
  const shifted = rig(false, neutral);
  for (let t = 0; t <= 1000; t += 72) shifted.logic.update(move(neutral, 0, 0.07), t);
  assert.equal(shifted.count('duck'), 0, 'A camera/image offset does not lower the torso relative to the feet');
});

function overhead(p = standing(), joined = false) {
  p[15].y = p[16].y = p[0].y - 0.1;
  p[15].x = joined ? 0.495 : 0.38;
  p[16].x = joined ? 0.505 : 0.62;
  return p;
}

test('held joined hands and lifting joined hands overhead do not count as a fresh clap', () => {
  const { logic, count } = rig();
  for (let t = 0; t <= 1200; t += 72) logic.update(overhead(standing(), true), t);
  assert.equal(count('clap'), 0);
  const low = overhead(standing(), true); low[15].y = low[16].y = 0.5;
  logic.update(low, 1400);
  logic.update(overhead(standing(), true), 1472);
  assert.equal(count('clap'), 0);
  logic.update(overhead(), 1700);
  logic.update(overhead(standing(), true), 1772);
  assert.equal(count('clap'), 1);
});

test('claps require both wrists overhead and both hands approaching, not a one-hand sweep', () => {
  const { logic, count } = rig();
  const oneRaised = overhead(); oneRaised[16].y = 0.54;
  logic.update(oneRaised, 0);
  const open = overhead(); open[15].x = 0.5; open[16].x = 0.7;
  const sweep = overhead(standing(), true); sweep[15].x = 0.5;
  logic.update(open, 100);
  logic.update(sweep, 172);
  assert.equal(count('clap'), 0);
  logic.update(overhead(), 1000);
  logic.update(overhead(standing(), true), 1072);
  assert.equal(count('clap'), 1);
});

test('lowering and raising still-joined hands does not rearm a previous clap', () => {
  const { logic, count } = rig();
  logic.update(overhead(), 0); logic.update(overhead(standing(), true), 72);
  assert.equal(count('clap'), 1);
  const low = overhead(standing(), true); low[15].y = low[16].y = 0.5;
  logic.update(low, 1000); logic.update(overhead(standing(), true), 1072);
  assert.equal(count('clap'), 1);
  logic.update(overhead(), 1200); logic.update(overhead(standing(), true), 1272);
  assert.equal(count('clap'), 2);
});

test('a jumping overhead clap emits Jump only and does not queue a delayed Clap on landing', () => {
  const { logic, count } = rig();
  logic.update(standing(), 0); logic.update(overhead(), 70);
  logic.update(overhead(move(standing(), 0, -0.075)), 140);
  logic.update(overhead(move(standing(), 0, -0.075), true), 210);
  assert.equal(count('jump'), 1);
  assert.equal(count('clap'), 0);
  logic.update(overhead(standing(), true), 350);
  logic.update(overhead(standing(), true), 420);
  assert.equal(count('clap'), 0);
  logic.update(overhead(), 1000); logic.update(overhead(standing(), true), 1072);
  assert.equal(count('clap'), 1);
});

test('a crouching overhead clap emits Duck only', () => {
  const { logic, count } = rig();
  const crouch = standing();
  for (const i of [0,11,12,13,14]) crouch[i].y += 0.11;
  for (const i of [23,24]) crouch[i].y += 0.07;
  logic.update(overhead(), 0);
  logic.update(overhead(structuredClone(crouch)), 72);
  logic.update(overhead(structuredClone(crouch), true), 144);
  assert.equal(count('duck'), 1);
  assert.equal(count('jump'), 0);
  assert.equal(count('clap'), 0);
});

test('gentle high-knee jump and overhead contact in one frame emit only Jump', () => {
  const { logic, count } = rig(true);
  logic.update(overhead(), 0);
  const knee = standing(); knee[25].y -= 0.13; knee[27].y -= 0.16;
  logic.update(overhead(knee, true), 72);
  assert.equal(count('jump'), 1);
  assert.equal(count('clap'), 0);
});

test('lost tracking clears unfinished clap/takeoff evidence until a fresh approach and landing', () => {
  const { logic, count } = rig();
  logic.update(overhead(), 0);
  logic.update(null, 72);
  logic.update(overhead(standing(), true), 144);
  assert.equal(count('clap'), 0);
  const raised = move(standing(), 0, -0.075);
  logic.update(raised, 216); logic.update(raised, 288);
  assert.equal(count('jump'), 0);
  logic.update(standing(), 360); logic.update(standing(), 432);
  logic.update(raised, 504); logic.update(raised, 576);
  assert.equal(count('jump'), 1);
});

test('clap and the next jump both work after jumping straight into running', () => {
  const { logic, count } = rig();
  const raised = move(standing(), 0, -0.075);
  logic.update(standing(), 0);
  logic.update(raised, 72); logic.update(raised, 144);
  assert.equal(count('jump'), 1);
  const landing = standing(); landing[28].y -= 0.055;
  logic.update(landing, 360); logic.update(landing, 432);
  const stride = frame => {
    const p = standing(), right = Math.floor(frame / 4) % 2;
    p[right ? 26 : 25].y -= 0.065;
    p[right ? 28 : 27].y -= 0.05;
    return p;
  };
  for (let frame = 0; frame < 29; frame++) logic.update(stride(frame), 576 + frame * 72);
  logic.update(overhead(stride(29)), 2664);
  logic.update(overhead(stride(30), true), 2736);
  assert.equal(count('clap'), 1, 'A stale landing latch must not disable clapping while running');
  // Jumping again straight out of the run works without standing still first.
  logic.update(raised, 3000); logic.update(raised, 3072);
  assert.equal(count('jump'), 2);
});

// Short slices of a real recording (landmark numbers only, no video).
const realMoves = JSON.parse(readFileSync(new URL('./fixtures/real-moves.json', import.meta.url), 'utf8'));
function replayReal({ baseline, frames }, minGapMs = 0) {
  const events = [];
  const logic = new PoseInterpreter({ onAction: (action, payload) => events.push({ action, ...payload }) });
  logic.setBaseline(baseline);
  events.length = 0;
  let previous = -Infinity, state;
  const states = [];
  for (const frame of frames) {
    if (frame.t - previous < minGapMs) continue;
    previous = frame.t;
    // Fixtures keep only the landmarks movement detection reads; the rest are null.
    const landmarks = frame.points && frame.points.map(p => p && { x: p[0], y: p[1], z: p[2], visibility: p[3], presence: p[4] });
    state = logic.update(landmarks, frame.t + 1, frame.aspect);
    states.push({ t: frame.t, run: state.run ?? 0, cadence: state.cadence ?? 0 });
  }
  const count = action => events.filter(e => e.action === action).length;
  return { events, state, states, count, peakRun: Math.max(0, ...events.filter(e => e.action === 'run').map(e => e.value)) };
}
function settledPace(states, afterMs = 1500) {
  const runs = states.filter(s => s.t > afterMs).map(s => s.run).sort((a, b) => a - b);
  return { median: runs[Math.floor(runs.length / 2)], dropouts: runs.filter(r => r < 0.4).length / runs.length };
}

test('a real light jog seen from the front is detected as running', () => {
  for (const minGap of [0, 1000 / 14 - 2]) {
    const { state, count, peakRun } = replayReal(realMoves.jog, minGap);
    assert.ok(peakRun > 0.8, `jog should reach near full pace, got ${peakRun} at ${minGap ? 14 : 20} Hz`);
    assert.ok(state.cadence > 170 && state.cadence < 230, `expected about 200 steps/min, got ${state.cadence}`);
    assert.equal(count('jump'), 0);
    assert.equal(count('duck'), 0);
  }
});

test('a real two-foot jump from standing fires exactly one Jump', () => {
  const { count } = replayReal(realMoves.jump);
  assert.equal(count('jump'), 1);
});

test('independent knee and ankle tracking noise does not create running', () => {
  const { logic, events } = rig();
  let seed = 7;
  const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.008;
  for (let i = 0; i < 120; i++) {
    const p = standing();
    for (const index of [25, 26, 27, 28]) p[index].y += noise();
    logic.update(p, i * 50);
  }
  assert.ok(events.filter(e => e.action === 'run').every(e => e.value === 0));
});

test('a real mid-pace run seen from the front holds a strong, steady pace', () => {
  for (const minGap of [0, 1000 / 14 - 2]) {
    const { median, dropouts } = settledPace(replayReal(realMoves.midPace, minGap).states);
    assert.ok(median > 0.65, `mid pace median ${median.toFixed(2)} at ${minGap ? 14 : 20} Hz`);
    assert.ok(dropouts < 0.1, `pace dropped below 0.4 in ${(dropouts * 100).toFixed(0)}% of frames at ${minGap ? 14 : 20} Hz`);
  }
});

test('a real sprint in place reaches full pace', () => {
  for (const minGap of [0, 1000 / 14 - 2]) {
    const { median } = settledPace(replayReal(realMoves.sprint, minGap).states);
    assert.ok(median > 0.85, `sprint median ${median.toFixed(2)} at ${minGap ? 14 : 20} Hz`);
  }
});

test('running that shows only as a body bounce still builds pace', () => {
  const { logic, events } = rig();
  for (let t = 0; t < 4000; t += 50) logic.update(move(standing(), 0, Math.sin(2 * Math.PI * t / 320) * 0.02), t);
  const peak = Math.max(...events.filter(e => e.action === 'run').map(e => e.value));
  assert.ok(peak > 0.8, `bounce at ~3 steps/s should be a strong pace, got ${peak}`);
});
