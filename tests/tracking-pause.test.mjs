import test from 'node:test';
import assert from 'node:assert/strict';
import { TrackingPauseGate, LOST_GRACE_MS } from '../web/tracking-pause.js';

test('brief tracking loss does not pause the run', () => {
  const gate = new TrackingPauseGate();
  assert.equal(gate.update('lost', 0, 'playing'), null);
  assert.equal(gate.update('lost', LOST_GRACE_MS - 1, 'playing'), null);
  assert.equal(gate.update('tracking', LOST_GRACE_MS, 'playing'), null);
  assert.equal(gate.update('lost', LOST_GRACE_MS + 100, 'playing'), null);
});

test('sustained tracking loss pauses once', () => {
  const gate = new TrackingPauseGate();
  gate.update('lost', 0, 'playing');
  assert.equal(gate.update('lost', LOST_GRACE_MS, 'playing'), 'pause');
  assert.equal(gate.update('lost', LOST_GRACE_MS + 250, 'playing'), null, 'repeated status updates must not resend pause');
  assert.equal(gate.update('lost', LOST_GRACE_MS + 500, 'paused'), null);
});

test('returning to view resumes a pause caused by tracking loss', () => {
  const gate = new TrackingPauseGate();
  gate.update('lost', 0, 'playing');
  gate.update('lost', LOST_GRACE_MS, 'playing');
  assert.equal(gate.update('tracking', LOST_GRACE_MS + 900, 'paused'), 'resume');
  assert.equal(gate.update('tracking', LOST_GRACE_MS + 1000, 'paused'), null, 'resume is sent once');
});

test('a manual pause is never resumed automatically', () => {
  const gate = new TrackingPauseGate();
  assert.equal(gate.update('tracking', 0, 'paused'), null);
  gate.update('lost', 100, 'paused');
  assert.equal(gate.update('tracking', 5000, 'paused'), null);
});

test('the TV state arriving late does not count as a manual resume', () => {
  const gate = new TrackingPauseGate();
  gate.update('lost', 0, 'playing');
  assert.equal(gate.update('lost', LOST_GRACE_MS, 'playing'), 'pause');
  // The relay has not delivered the paused state yet.
  assert.equal(gate.update('lost', LOST_GRACE_MS + 220, 'playing'), null);
  assert.equal(gate.update('lost', LOST_GRACE_MS + 440, 'paused'), null);
  assert.equal(gate.update('tracking', LOST_GRACE_MS + 900, 'paused'), 'resume');
});

test('resuming on the TV while still out of view restarts the grace period', () => {
  const gate = new TrackingPauseGate();
  gate.update('lost', 0, 'playing');
  gate.update('lost', LOST_GRACE_MS, 'playing');
  gate.update('lost', LOST_GRACE_MS + 300, 'paused');
  // The player presses resume on the TV but is still out of frame.
  const resumedAt = LOST_GRACE_MS + 2000;
  assert.equal(gate.update('lost', resumedAt, 'playing'), null);
  assert.equal(gate.update('lost', resumedAt + LOST_GRACE_MS - 1, 'playing'), null);
  assert.equal(gate.update('lost', resumedAt + LOST_GRACE_MS, 'playing'), 'pause');
});

test('time spent paused does not count toward the grace period', () => {
  const gate = new TrackingPauseGate();
  gate.update('lost', 0, 'playing');
  gate.update('lost', 500, 'paused');
  gate.update('lost', 5000, 'paused');
  assert.equal(gate.update('lost', 6000, 'playing'), null);
  assert.equal(gate.update('lost', 6000 + LOST_GRACE_MS, 'playing'), 'pause');
});

test('a pause the TV never applied can be sent again', () => {
  const gate = new TrackingPauseGate();
  gate.update('lost', 0, 'playing');
  assert.equal(gate.update('lost', LOST_GRACE_MS, 'playing'), 'pause');
  assert.equal(gate.update('lost', LOST_GRACE_MS + 1000, 'playing'), null);
  assert.equal(gate.update('lost', LOST_GRACE_MS + 10000, 'playing'), 'pause');
});

test('leaving the run clears a pending automatic resume', () => {
  const gate = new TrackingPauseGate();
  gate.update('lost', 0, 'playing');
  gate.update('lost', LOST_GRACE_MS, 'playing');
  gate.update('lost', LOST_GRACE_MS + 100, 'home');
  assert.equal(gate.update('tracking', LOST_GRACE_MS + 200, 'paused'), null);
});

test('camera errors pause immediately without an automatic resume', () => {
  const gate = new TrackingPauseGate();
  assert.equal(gate.update('error', 0, 'playing'), 'pause');
  assert.equal(gate.update('tracking', 100, 'paused'), null);
});
