import { FilesetResolver, PoseLandmarker } from './vendor/vision_bundle.mjs';
import { PoseInterpreter, poseFeatures, buildCalibration } from './pose-logic.js';

// All inference assets are shipped with the demo. Camera frames never leave
// this browser; the phone controller sends only interpreted game actions.
const MODEL = './models/pose_landmarker_lite.task';
const WASM = './vendor/wasm';
const CONNECTIONS = [[11,12],[11,13],[13,15],[12,14],[14,16],[11,23],[12,24],[23,24],[23,25],[25,27],[24,26],[26,28],[27,29],[29,31],[28,30],[30,32]];
const C = { mint: '#b5f557', aqua: '#69e0cf', muted: '#647b73' };
// 20 Hz resolves running rhythm and short jumps; phones sustain it with the lite model.
export const DEFAULT_HZ = 20;

function cameraError(error) {
  if (error?.name === 'NotAllowedError' || error?.name === 'PermissionDeniedError') return 'Camera access was declined. Allow camera access in your browser, then try again.';
  if (error?.name === 'NotFoundError' || error?.name === 'DevicesNotFoundError') return 'No camera found. Use your phone camera or play with the keyboard.';
  if (error?.name === 'NotReadableError' || error?.name === 'TrackStartError') return 'The camera is busy. Close other camera apps and try again.';
  if (error?.name === 'OverconstrainedError') return 'This camera could not use the requested settings. Try another browser or camera.';
  if (error?.name === 'SecurityError') return 'Camera access requires HTTPS or localhost. Open the secure controller link.';
  return error?.message || 'Motion tracking could not start. Try the keyboard or reconnect your camera.';
}

export class MotionController {
  constructor({ video, canvas, onAction = () => {}, onStatus = () => {}, onLandmarks = () => {} } = {}) {
    if (!video) throw new Error('MotionController requires a video element.');
    this.video = video;
    this.canvas = canvas;
    this.onStatus = onStatus;
    this.onLandmarks = onLandmarks;
    this.logic = new PoseInterpreter({ onAction });
    this._status = { state: 'idle', message: 'Camera is off.', calibrated: false, progress: 0 };
    this._active = false;
    this._session = 0;
    this._lastInfer = -Infinity;
    this._lastVideoTime = -1;
    this._lastStatusTime = 0;
    this._lastGood = 0;
    this._lastDecodedAt = 0;
    this._raf = 0;
    this._stream = null;
    this._landmarker = null;
    this._calibration = null;
    this._startPromise = null;
    this.inferenceHz = DEFAULT_HZ;
    this._frame = this._frame.bind(this);
  }

  get state() {
    return { ...this._status, active: this._active, calibrated: Boolean(this.logic.baseline), gentle: this.logic.gentle };
  }

  setGentle(value) { this.logic.setGentle(value); }

  /** Pose inferences per second; higher captures fast moves at the cost of battery and heat. */
  setInferenceRate(hz) { this.inferenceHz = Math.max(5, Math.min(60, Number(hz) || DEFAULT_HZ)); }

  _statusUpdate(state, message, extra = {}, force = false) {
    const now = performance.now();
    if (!force && this._status.state === state && this._status.message === message && now - this._lastStatusTime < 220) return;
    this._status = { state, message, calibrated: Boolean(this.logic.baseline), progress: 0, ...extra };
    this._lastStatusTime = now;
    this.onStatus(this.state);
  }

  async start() {
    if (this._active) return this.state;
    if (this._startPromise) return this._startPromise;
    const session = ++this._session;
    this._startPromise = this._start(session);
    try { return await this._startPromise; }
    finally { if (session === this._session) this._startPromise = null; }
  }

  async _start(session) {
    this._statusUpdate('loading', 'Starting your camera…', {}, true);
    let stream;
    let detector;
    try {
      if (!globalThis.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        throw new Error('Camera access requires HTTPS or localhost. Use the secure phone link, or open the demo on localhost.');
      }
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 30 } },
      });
      if (session !== this._session) { stream.getTracks().forEach(t => t.stop()); return this.state; }
      this._stream = stream;
      this.video.muted = true;
      this.video.autoplay = true;
      this.video.playsInline = true;
      this.video.setAttribute('playsinline', '');
      // The landmarks remain unmirrored. Mirror only the visible preview and
      // drawing, and reverse horizontal controls once in PoseInterpreter.
      this.video.style.transform = 'scaleX(-1)';
      this.video.srcObject = stream;
      await this.video.play();
      if (session !== this._session) { stream.getTracks().forEach(t => t.stop()); return this.state; }
      this._statusUpdate('loading', 'Loading motion tracking. Your camera stays on this device.', {}, true);
      const wasmURL = new URL(WASM, document.baseURI).href;
      const modelURL = new URL(MODEL, document.baseURI).href;
      const fileset = await FilesetResolver.forVisionTasks(wasmURL);
      if (session !== this._session) return this.state;
      const options = {
        baseOptions: { modelAssetPath: modelURL, delegate: 'GPU' },
        runningMode: 'VIDEO', numPoses: 1,
        minPoseDetectionConfidence: 0.55, minPosePresenceConfidence: 0.55,
        minTrackingConfidence: 0.55, outputSegmentationMasks: false,
      };
      try {
        detector = await PoseLandmarker.createFromOptions(fileset, options);
      } catch (gpuError) {
        if (session !== this._session) return this.state;
        this._statusUpdate('loading', 'Preparing motion tracking for this device…', {}, true);
        detector = await PoseLandmarker.createFromOptions(fileset, {
          ...options, baseOptions: { modelAssetPath: modelURL, delegate: 'CPU' },
        });
      }
      if (session !== this._session) { detector.close(); return this.state; }
      this._landmarker = detector;
      this._active = true;
      this.logic.baseline = null;
      this.logic.reset();
      this._lastInfer = -Infinity;
      this._lastVideoTime = -1;
      this._lastGood = performance.now();
      this._lastDecodedAt = this._lastGood;
      for (const track of stream.getVideoTracks()) {
        track.addEventListener('ended', () => {
          if (session !== this._session || !this._active) return;
          this.stop();
          this._statusUpdate('error', 'The camera disconnected. Reconnect it to continue with motion controls.', {}, true);
        }, { once: true });
      }
      this._statusUpdate('ready', 'Camera ready. Stand back so your whole body is visible, then calibrate.', {}, true);
      this._raf = requestAnimationFrame(this._frame);
      return this.state;
    } catch (error) {
      stream?.getTracks().forEach(t => t.stop());
      detector?.close();
      if (session !== this._session) return this.state;
      this._stream = null;
      this._landmarker = null;
      this._active = false;
      this.video.srcObject = null;
      const message = cameraError(error);
      this._statusUpdate('error', message, {}, true);
      const wrapped = new Error(message);
      wrapped.cause = error;
      throw wrapped;
    }
  }

  calibrate() {
    if (!this._active) return Promise.reject(new Error('Start the camera before calibrating.'));
    if (this._calibration) return this._calibration.promise;
    this.logic.lost(performance.now());
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    this._calibration = { promise, resolve, reject, samples: [], began: null, deadline: performance.now() + 25000 };
    this._statusUpdate('calibrating', 'Stand tall and still with your feet visible. Hold for 3 seconds.', { progress: 0, seconds: 3 }, true);
    return promise;
  }

  _calibrateFrame(features, now) {
    const c = this._calibration;
    if (!c) return;
    if (now > c.deadline) {
      this._calibration = null;
      const message = 'Calibration timed out. Put the camera at waist height, step back until your feet are visible, then try again.';
      this._statusUpdate('ready', message, {}, true);
      c.reject(new Error(message));
      return;
    }
    if (!features) {
      c.samples = [];
      c.began = null;
      this._statusUpdate('calibrating', 'Step back until your shoulders, knees and both feet are visible.', { progress: 0, seconds: 3 });
      return;
    }
    if (c.began === null) c.began = now;
    c.samples.push(features);
    const progress = Math.min(1, (now - c.began) / 3000);
    this._statusUpdate('calibrating', 'Stand tall and still. Hold your centre position.', { progress, seconds: Math.ceil(3 * (1 - progress)), confidence: features.confidence });
    if (progress < 1 || c.samples.length < 12) return;
    const baseline = buildCalibration(c.samples);
    if (!baseline) {
      c.samples = [];
      c.began = now;
      this._statusUpdate('calibrating', 'Almost there — keep still for 3 seconds.', { progress: 0, seconds: 3 }, true);
      return;
    }
    this.logic.setBaseline(baseline);
    this._calibration = null;
    this._statusUpdate('tracking', 'Ready! March to run. Step sideways, jump, duck and clap overhead.', { progress: 1, confidence: features.confidence }, true);
    c.resolve(this.state);
  }

  _frame(now) {
    if (!this._active) return;
    this._raf = requestAnimationFrame(this._frame);
    // Pose inference is synchronous in the browser API. Cap it so the game and
    // UI retain time to render; slower devices simply run below the cap.
    if (now - this._lastInfer < 1000 / this.inferenceHz) return;
    if (this.video.readyState < 2 || this.video.currentTime === this._lastVideoTime) {
      if (now - this._lastDecodedAt > 1500) {
        this.logic.lost(now);
        if (this._calibration) this._calibrateFrame(null, now);
        else this._statusUpdate('lost', 'Waiting for camera frames. Bring this tab back into view.');
      }
      return;
    }
    this._lastInfer = now;
    this._lastVideoTime = this.video.currentTime;
    this._lastDecodedAt = now;
    let result;
    try {
      result = this._landmarker.detectForVideo(this.video, now);
      const landmarks = result.landmarks?.[0] || null;
      const aspect = (this.video.videoWidth || 640) / (this.video.videoHeight || 480);
      const features = poseFeatures(landmarks, aspect);
      this._draw(landmarks, Boolean(features));
      this.onLandmarks(landmarks, { valid: Boolean(features), confidence: features?.confidence ?? 0, now, aspect });
      if (features) this._lastGood = now;
      if (this._calibration) {
        this._calibrateFrame(features, now);
      } else if (this.logic.baseline) {
        const state = this.logic.update(landmarks, now, aspect);
        if (state.valid) {
          this._statusUpdate('tracking', 'Motion tracking active', { confidence: state.confidence, run: state.run, lane: state.lane, cadence: state.cadence });
        } else if (now - this._lastGood > 350) {
          this._statusUpdate('lost', 'Step back into view. Keep both feet and shoulders in frame.', { confidence: 0 });
        }
      } else if (now - this._lastGood > 500) {
        this._statusUpdate('ready', 'Step back until your whole body is visible, then calibrate.');
      }
    } catch (error) {
      const pending = this._calibration;
      this._calibration = null;
      pending?.reject(new Error('Motion tracking stopped during calibration. Please reconnect the camera.'));
      this.stop();
      this._statusUpdate('error', 'Motion tracking stopped. Reconnect your camera or use keyboard controls.', { detail: error?.message }, true);
    } finally {
      result?.close?.();
    }
  }

  _draw(landmarks, valid) {
    if (!this.canvas) return;
    const width = this.video.videoWidth || 640;
    const height = this.video.videoHeight || 480;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    if (!landmarks) return;
    ctx.save();
    ctx.translate(width, 0);
    ctx.scale(-1, 1);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(2.5, width / 200);
    ctx.strokeStyle = valid ? C.mint : C.muted;
    ctx.fillStyle = valid ? C.aqua : C.muted;
    for (const [a, b] of CONNECTIONS) {
      const p = landmarks[a], q = landmarks[b];
      if (!p || !q || (p.visibility ?? 0) < 0.45 || (q.visibility ?? 0) < 0.45) continue;
      ctx.beginPath();
      ctx.moveTo(p.x * width, p.y * height);
      ctx.lineTo(q.x * width, q.y * height);
      ctx.stroke();
    }
    for (const i of [11,12,13,14,15,16,23,24,25,26,27,28]) {
      const p = landmarks[i];
      if (!p || (p.visibility ?? 0) < 0.45) continue;
      ctx.beginPath();
      ctx.arc(p.x * width, p.y * height, Math.max(3.5, width / 125), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  stop() {
    ++this._session;
    this._active = false;
    this._startPromise = null;
    cancelAnimationFrame(this._raf);
    this._raf = 0;
    this._stream?.getTracks().forEach(track => track.stop());
    this._stream = null;
    this.video.pause();
    this.video.srcObject = null;
    this._landmarker?.close();
    this._landmarker = null;
    this.logic.lost(performance.now());
    this.logic.baseline = null;
    const pending = this._calibration;
    this._calibration = null;
    if (pending) {
      const error = new Error('Calibration cancelled.');
      error.name = 'AbortError';
      pending.reject(error);
    }
    const ctx = this.canvas?.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.onLandmarks(null, { valid: false, confidence: 0 });
    this._statusUpdate('idle', 'Camera is off.', {}, true);
  }
}
