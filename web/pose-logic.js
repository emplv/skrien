/**
 * Camera-independent movement interpretation. Coordinates are MediaPipe's
 * normalized, unmirrored image landmarks (x rightwards, y downwards).
 * This module deliberately has no DOM, camera, network or model dependency.
 */
import { CadenceEstimator } from './cadence.js';

export const POSE_POINTS = Object.freeze({
  nose: 0, leftShoulder: 11, rightShoulder: 12,
  leftElbow: 13, rightElbow: 14, leftWrist: 15, rightWrist: 16,
  leftHip: 23, rightHip: 24, leftKnee: 25, rightKnee: 26,
  leftAnkle: 27, rightAnkle: 28,
});

const CORE = [11, 12, 23, 24, 25, 26, 27, 28];
/** Step rates (steps per second) mapped to the slowest and the full running pace. */
const RUN_CADENCE = Object.freeze({ min: 0.9, full: 3.4 });
/**
 * A light jog seen from the front moves the knees apart by only ~0.05-0.1 torso
 * lengths, so steps are counted from a lightly smoothed knee/ankle signal that
 * is centred on the player's own stance.
 */
const STEP = Object.freeze({ threshold: 0.03, smoothMs: 60, centerMs: 1500 });
/**
 * Steps per second from recent step times. With three or more, use the median
 * interval and treat a roughly doubled gap as a missed beat, so one weak step
 * does not halve the pace.
 */
function stepRate(times) {
  if (times.length < 2) return 0;
  if (times.length === 2) return 1000 / Math.max(350, times[1] - times[0]);
  const intervals = times.slice(1).map((t, i) => t - times[i]);
  const typical = median(intervals);
  return 1000 / Math.max(180, median(intervals.map(gap => gap / Math.max(1, Math.round(gap / typical)))));
}
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const median = values => {
  const v = values.slice().sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
const pointConfidence = p => p && Number.isFinite(p.x) && Number.isFinite(p.y)
  ? Math.min(p.visibility ?? 1, p.presence ?? 1) : 0;

export function poseFeatures(landmarks, aspect = 4 / 3) {
  if (!landmarks || landmarks.length < 29) return null;
  const p = landmarks;
  const confidence = Math.min(...CORE.map(i => pointConfidence(p[i])));
  if (confidence < 0.5) return null;
  const hipX = (p[23].x + p[24].x) / 2;
  const hipY = (p[23].y + p[24].y) / 2;
  const shoulderY = (p[11].y + p[12].y) / 2;
  const shoulderWidth = Math.abs(p[11].x - p[12].x);
  const torso = Math.hypot(((p[11].x + p[12].x) / 2 - hipX) * aspect, shoulderY - hipY);
  const framed = CORE.every(i => p[i].x > 0.015 && p[i].x < 0.985 && p[i].y > 0.015 && p[i].y < 0.985);
  if (!framed || torso < 0.065 || shoulderWidth < 0.035) return null;
  return {
    hipX, hipY, shoulderY, shoulderWidth, torso, confidence, aspect,
    leftKneeY: p[25].y, rightKneeY: p[26].y,
    leftAnkleY: p[27].y, rightAnkleY: p[28].y,
    noseY: p[0]?.y ?? shoulderY - torso * 0.35,
    wristsVisible: pointConfidence(p[15]) > 0.5 && pointConfidence(p[16]) > 0.5,
    leftWristX: p[15]?.x ?? 0, leftWristY: p[15]?.y ?? 1,
    rightWristX: p[16]?.x ?? 0, rightWristY: p[16]?.y ?? 1,
  };
}

/** Returns a median neutral stance only when calibration contains stable data. */
export function buildCalibration(samples) {
  const valid = samples.filter(Boolean);
  if (valid.length < 12) return null;
  const keys = ['hipX', 'hipY', 'shoulderY', 'shoulderWidth', 'torso', 'leftKneeY', 'rightKneeY', 'leftAnkleY', 'rightAnkleY', 'aspect'];
  const result = Object.fromEntries(keys.map(k => [k, median(valid.map(s => s[k]))]));
  const hipDeviation = median(valid.map(s => Math.abs(s.hipY - result.hipY)));
  const xDeviation = median(valid.map(s => Math.abs(s.hipX - result.hipX)));
  const shoulderDeviation = median(valid.map(s => Math.abs(s.shoulderY - result.shoulderY)));
  if (hipDeviation > result.torso * 0.065 || shoulderDeviation > result.torso * 0.065 || xDeviation > result.shoulderWidth * 0.12) return null;
  return result;
}

export class PoseInterpreter {
  constructor({ onAction = () => {}, gentle = false, mirrored = true } = {}) {
    this.onAction = onAction;
    this.gentle = gentle;
    this.mirrored = mirrored;
    this.baseline = null;
    this.bounce = new CadenceEstimator();
    this.reset();
  }

  reset() {
    this.lane = 0;
    this.jumpLatched = false;
    this.jumpArmed = true;
    this.jumpFrames = 0;
    this.jumpBegan = null;
    this.groundFrames = 0;
    this.groundBegan = null;
    this.duckFrames = 0;
    this.duckLatched = false;
    this.clapLatched = false;
    this.clapAnchor = null;
    this.kneeLatched = false;
    this.lastJump = -Infinity;
    this.lastDuck = -Infinity;
    this.lastClap = -Infinity;
    this.lastStep = -Infinity;
    this.lastStepLeg = 0;
    this.stepTimes = [];
    this.stepSmooth = 0;
    this.stepCenter = 0;
    this.bounce.reset();
    this.runPower = 0;
    this.lastRunEmit = -Infinity;
    this.lastRunSent = 0;
    this.lastLaneEmit = -Infinity;
    this.lastFrame = -Infinity;
  }

  calibrate(samples) {
    const baseline = buildCalibration(samples);
    if (!baseline) return false;
    this.setBaseline(baseline);
    return true;
  }

  setBaseline(baseline) {
    this.baseline = { ...baseline };
    this.reset();
    this.onAction('lane', { value: 0 });
    this.onAction('run', { value: 0 });
  }

  setGentle(value) { this.gentle = Boolean(value); }

  lost(now) {
    if (this.runPower !== 0 || this.lastRunSent !== 0) {
      this.onAction('run', { value: 0 });
      this.lastRunEmit = now;
    }
    this.runPower = this.lastRunSent = 0;
    this.stepTimes = [];
    this.lastStep = -Infinity;
    this.lastStepLeg = 0;
    this.bounce.reset();
    this.jumpArmed = false;
    this.jumpFrames = this.groundFrames = this.duckFrames = 0;
    this.jumpBegan = this.groundBegan = null;
    this.clapAnchor = null;
  }

  update(landmarks, now, aspect = 4 / 3) {
    const f = poseFeatures(landmarks, aspect);
    if (!f) { this.lost(now); return { valid: false, message: 'Step back until your shoulders, hips, knees and feet are visible.' }; }
    if (!this.baseline) return { valid: true, calibrated: false, features: f };
    const b = this.baseline;
    if (!Number.isFinite(now) || now <= this.lastFrame) return { valid: true, calibrated: true, features: f };
    const elapsed = now - this.lastFrame;
    const continuous = elapsed <= 250;
    this.lastFrame = now;

    // Mirrored front-camera coordinates: moving to the player's right moves
    // their raw image centre left, but should move the character right.
    const horizontal = (f.hipX - b.hipX) / b.shoulderWidth * (this.mirrored ? -1 : 1);
    let lane = this.lane;
    if (horizontal > 0.6) lane = 1;
    else if (horizontal < -0.6) lane = -1;
    else if (Math.abs(horizontal) < 0.32) lane = 0;
    if (lane !== this.lane || (Number.isFinite(this.lastLaneEmit) && now - this.lastLaneEmit > 650)) {
      this.lane = lane;
      this.onAction('lane', { value: lane });
      this.lastLaneEmit = now;
    }
    if (!Number.isFinite(this.lastLaneEmit)) this.lastLaneEmit = now;

    const hipRise = (b.hipY - f.hipY) / b.torso;
    const shoulderDrop = (f.shoulderY - b.shoulderY) / b.torso;
    const leftFootRise = (b.leftAnkleY - f.leftAnkleY) / b.torso;
    const rightFootRise = (b.rightAnkleY - f.rightAnkleY) / b.torso;
    const kneeDifference = ((f.rightKneeY - f.leftKneeY) - (b.rightKneeY - b.leftKneeY)) / b.torso;
    const ankleDifference = ((f.rightAnkleY - f.leftAnkleY) - (b.rightAnkleY - b.leftAnkleY)) / b.torso;
    const footDrop = -(leftFootRise + rightFootRise) / 2;
    // Lower the hips AND shoulders relative to planted feet. Translating the
    // whole image, nodding the head or folding only the neck is not a Duck.
    const duckPose = hipRise < -0.19 && -hipRise - footDrop > 0.18 && shoulderDrop - footDrop > 0.25;
    this.duckFrames = duckPose ? continuous ? this.duckFrames + 1 : 1 : 0;
    const isDuck = duckPose && this.duckFrames >= 2;
    let discreteAction = null;
    if (isDuck && (now - this.lastDuck > 450 || !this.duckLatched)) {
      discreteAction = { action: 'duck', value: 1 };
      this.lastDuck = now;
    }
    if (isDuck) this.duckLatched = true;
    else if (hipRise > -0.1 && shoulderDrop < 0.14) this.duckLatched = false;

    // Running can briefly put both feet in the air. Its asymmetric stride
    // should remain Run: a Jump needs a symmetric takeoff on consecutive
    // observations. The next Jump arms once the hips are back down; players
    // land straight into a stride, so the feet need not both be planted.
    const symmetricLegs = Math.abs(kneeDifference) < 0.24 && Math.abs(ankleDifference) < 0.22;
    const airborne = hipRise > 0.17 && leftFootRise > 0.09 && rightFootRise > 0.09 && symmetricLegs;
    const landed = hipRise < 0.1;
    if (landed) {
      if (!continuous || !this.groundFrames) { this.groundFrames = 0; this.groundBegan = now; }
      this.groundFrames++;
      if (this.groundFrames >= 2 && now - this.groundBegan >= 45) {
        this.jumpLatched = false;
        this.jumpArmed = true;
      }
    } else { this.groundFrames = 0; this.groundBegan = null; }
    if (airborne) {
      if (!continuous || !this.jumpFrames) { this.jumpFrames = 0; this.jumpBegan = now; }
      this.jumpFrames++;
    } else { this.jumpFrames = 0; this.jumpBegan = null; }
    if (airborne && this.jumpArmed && !this.jumpLatched && this.jumpFrames >= 2 && now - this.jumpBegan >= 45 && now - this.lastJump > 750) {
      discreteAction = { action: 'jump', value: 1 };
      this.lastJump = now;
      this.jumpLatched = true;
      this.jumpArmed = false;
    }

    // Optional low-impact control: a deliberate high knee triggers Jump.
    // Resolve it before Clap, so one frame never awards two different moves.
    const highKnee = Math.max(b.leftKneeY - f.leftKneeY, b.rightKneeY - f.rightKneeY) / b.torso;
    const gentleKnee = this.gentle && highKnee > 0.4 && Math.abs(hipRise) < 0.16;
    if (gentleKnee && !this.kneeLatched && now - this.lastJump > 950 && !duckPose && !discreteAction) {
      discreteAction = { action: 'jump', value: 1, gentle: true };
      this.lastJump = now;
      this.kneeLatched = true;
    }
    if (highKnee < 0.17) this.kneeLatched = false;

    // A clap is a fresh two-hand approach while overhead. Opening the hands
    // arms it; merely holding / lifting joined hands does not. Measure wrist
    // travel relative to the body so sideways movement cannot fake a clap.
    const wristDistance = Math.hypot((f.leftWristX - f.rightWristX) * f.aspect, f.leftWristY - f.rightWristY);
    const aboveHead = f.wristsVisible
      && Math.max(f.leftWristY, f.rightWristY) < f.noseY - b.torso * 0.025
      && Math.max(f.leftWristY, f.rightWristY) < f.shoulderY - b.torso * 0.35;
    const closeHands = wristDistance < b.shoulderWidth * f.aspect * 0.52;
    const wideHands = wristDistance > b.shoulderWidth * f.aspect * 0.85;
    const wristPositions = {
      lx: (f.leftWristX - f.hipX) * f.aspect, ly: f.leftWristY - f.shoulderY,
      rx: (f.rightWristX - f.hipX) * f.aspect, ry: f.rightWristY - f.shoulderY,
    };
    if (!aboveHead) {
      this.clapAnchor = null;
      this.clapLatched = false;
    } else if (wideHands) {
      this.clapAnchor = { ...wristPositions, time: now };
      this.clapLatched = false;
    } else if (closeHands && !this.clapLatched) {
      const anchor = this.clapAnchor;
      const requiredTravel = b.shoulderWidth * f.aspect * 0.08;
      const leftTravel = anchor ? Math.hypot(wristPositions.lx - anchor.lx, wristPositions.ly - anchor.ly) : 0;
      const rightTravel = anchor ? Math.hypot(wristPositions.rx - anchor.rx, wristPositions.ry - anchor.ry) : 0;
      const freshApproach = anchor && now - anchor.time < 1200 && leftTravel > requiredTravel && rightTravel > requiredTravel;
      // Landing rearm can remain latched while a player immediately jogs.
      // Only a current takeoff/flight or its short transition window blocks
      // Clap; the separate re-jump latch must not disable later arm actions.
      const jumpInProgress = airborne || now - this.lastJump < 450;
      if (freshApproach && now - this.lastClap > 850 && !duckPose && !this.duckLatched && !jumpInProgress && !gentleKnee && !discreteAction) {
        discreteAction = { action: 'clap', value: 1 };
        this.lastClap = now;
      }
      this.clapLatched = true;
      this.clapAnchor = null;
    }

    if (discreteAction) {
      const { action, ...payload } = discreteAction;
      this.onAction(action, payload);
    }

    const stepSignal = kneeDifference + ankleDifference * 0.45;
    if (continuous) {
      this.stepSmooth += (stepSignal - this.stepSmooth) * (1 - Math.exp(-elapsed / STEP.smoothMs));
      this.stepCenter += (this.stepSmooth - this.stepCenter) * (1 - Math.exp(-elapsed / STEP.centerMs));
    } else this.stepSmooth = stepSignal;
    const centered = this.stepSmooth - this.stepCenter;
    const leg = centered > STEP.threshold ? 1 : centered < -STEP.threshold ? -1 : 0;
    if (!isDuck && !airborne && leg && leg !== this.lastStepLeg && now - this.lastStep > 160) {
      this.lastStepLeg = leg;
      this.lastStep = now;
      this.stepTimes.push(now);
      this.stepTimes = this.stepTimes.filter(t => now - t < 2400).slice(-8);
    }
    this.stepTimes = this.stepTimes.filter(t => now - t < 2400);

    // Seen from the front, running knees travel toward the camera and barely
    // change height, but the torso bounces once per step. Its rhythm is measured
    // in current torso lengths, so moving nearer or farther does not matter.
    const bounceRate = this.bounce.update(now, (f.hipY + f.shoulderY) / 2 / f.torso);
    const stepAge = now - this.lastStep;
    const kneeRate = stepAge < 1250 ? stepRate(this.stepTimes) : 0;
    const cadence = Math.max(kneeRate, bounceRate);
    let targetRun = 0;
    if (bounceRate || (stepAge < 1250 && this.stepTimes.length)) {
      // Steps per second: an easy jog (~2) is a partial pace, a sprint (~3.4+) is full speed.
      // Knee steps alone hold the pace through a missed step or two, then fade it out.
      const fade = bounceRate ? 1 : clamp((1250 - stepAge) / 550, 0, 1);
      targetRun = clamp((cadence - RUN_CADENCE.min) / (RUN_CADENCE.full - RUN_CADENCE.min), 0.2, 1) * fade;
    }
    if (isDuck || airborne) targetRun = Math.max(targetRun, this.runPower * 0.92);
    this.runPower += (targetRun - this.runPower) * 0.42;
    if (stepAge > 1400 && !bounceRate) this.runPower = 0;
    if (now - this.lastRunEmit >= 220 && (Math.abs(this.runPower - this.lastRunSent) > 0.025 || now - this.lastRunEmit > 650)) {
      const value = Math.round(clamp(this.runPower, 0, 1) * 100) / 100;
      this.onAction('run', { value });
      this.lastRunSent = value;
      this.lastRunEmit = now;
    }

    return { valid: true, calibrated: true, features: f, lane: this.lane, run: this.runPower, cadence: Math.round(cadence * 60), duck: this.duckLatched, airborne, confidence: f.confidence };
  }
}
