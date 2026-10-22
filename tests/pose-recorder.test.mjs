import test from 'node:test';
import assert from 'node:assert/strict';
import { PoseRecorder } from '../web/pose-recorder.js';

const pose = () => Array.from({ length: 33 }, (_, i) => ({ x: 0.123456 + i / 100, y: 0.5, z: -0.0123456, visibility: 0.987654, presence: 0.9 }));

test('records landmarks relative to the first frame, rounded and without video', () => {
  const recorder = new PoseRecorder();
  recorder.start({ gentle: false });
  recorder.addFrame(1000, pose(), 0.75);
  recorder.addFrame(1050.4, null, 0.75);
  recorder.addAction(1060, 'jump', { value: 1 });
  const data = recorder.stop();
  assert.equal(data.frames.length, 2);
  assert.deepEqual(data.frames[0].points[0], [0.1235, 0.5, -0.0123, 0.9877, 0.9]);
  assert.equal(data.frames[0].t, 0);
  assert.equal(data.frames[1].t, 50);
  assert.equal(data.frames[1].points, null, 'Frames without a detected body are kept as gaps');
  assert.deepEqual(data.actions, [{ t: 60, action: 'jump', value: 1 }]);
  assert.equal(data.meta.gentle, false);
  assert.ok(!JSON.stringify(data).includes('image'), 'Only landmark numbers are stored');
});

test('ignores input while stopped and stops itself at the length limit', () => {
  const recorder = new PoseRecorder({ maxSeconds: 1 });
  recorder.addFrame(0, pose(), 1);
  assert.equal(recorder.recording, false);
  recorder.start({});
  recorder.addFrame(0, pose(), 1);
  recorder.addFrame(999, pose(), 1);
  recorder.addFrame(1001, pose(), 1);
  assert.equal(recorder.recording, false);
  assert.equal(recorder.stop().frames.length, 2);
});

test('reports elapsed seconds while recording', () => {
  const recorder = new PoseRecorder();
  recorder.start({});
  assert.equal(recorder.elapsedSeconds, 0);
  recorder.addFrame(500, pose(), 1);
  recorder.addFrame(3600, pose(), 1);
  assert.equal(recorder.elapsedSeconds, 3);
});
