import test from 'node:test';
import assert from 'node:assert/strict';
import { CadenceEstimator } from '../web/cadence.js';

function feed(estimator, { from = 0, to, stepMs, amplitude = 0.08, frameMs = 50, weakEvery = 0, noise = () => 0 }) {
  let result = 0;
  for (let t = from; t < to; t += frameMs) {
    const step = Math.floor(t / stepMs);
    const phase = (t % stepMs) / stepMs;
    // A lopsided bounce: a short push-off peak and a long flat contact.
    const scale = weakEvery && step % weakEvery ? 0.35 : 1;
    const bounce = phase < 0.35 ? Math.sin(phase / 0.35 * Math.PI) * amplitude * scale : 0;
    result = estimator.update(t, bounce + noise());
  }
  return result;
}

test('finds the step rate of a lopsided bounce', () => {
  const rate = feed(new CadenceEstimator(), { to: 4000, stepMs: 340 });
  assert.ok(Math.abs(rate - 1000 / 340) < 0.2, `expected about 2.9 steps/s, got ${rate}`);
});

test('a weaker step on one leg does not halve the rate', () => {
  const rate = feed(new CadenceEstimator(), { to: 4000, stepMs: 340, weakEvery: 2 });
  assert.ok(Math.abs(rate - 1000 / 340) < 0.25, `expected about 2.9 steps/s, got ${rate}`);
});

test('works at the 14 Hz production tracking rate', () => {
  const rate = feed(new CadenceEstimator(), { to: 4000, stepMs: 300, frameMs: 71 });
  assert.ok(Math.abs(rate - 1000 / 300) < 0.3, `expected about 3.3 steps/s, got ${rate}`);
});

test('random tracking noise and small sway are not a cadence', () => {
  let seed = 3;
  const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.03;
  assert.equal(feed(new CadenceEstimator(), { to: 4000, stepMs: 340, amplitude: 0, noise }), 0);
  assert.equal(feed(new CadenceEstimator(), { to: 4000, stepMs: 450, amplitude: 0.012 }), 0);
});

test('stopping drops the rate to zero quickly', () => {
  const estimator = new CadenceEstimator();
  feed(estimator, { to: 3000, stepMs: 340 });
  let rate;
  for (let t = 3000; t <= 3800; t += 50) rate = estimator.update(t, 0);
  assert.equal(rate, 0);
});

test('a tracking gap clears old samples', () => {
  const estimator = new CadenceEstimator();
  feed(estimator, { to: 3000, stepMs: 340 });
  estimator.reset();
  assert.equal(estimator.update(3100, 0.05), 0);
});
