import { RunnerGame } from './game.js';
import { DIFFICULTIES } from './game-logic.js';
import { MotionController, DEFAULT_HZ } from './motion.js';
import { RelayClient } from './relay.js';
import { TrackingPauseGate } from './tracking-pause.js';
import { PoseRecorder } from './pose-recorder.js';

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const isController = params.has('controller');
const nativeBridge = window.SkrienNative || window.MovaNative;
const isTV = params.has('tv') || Boolean(nativeBridge);
// Vega WebView blocks cleartext traffic (net::ERR_CLEARTEXT_NOT_PERMITTED), so its relay must be HTTPS.
const needsSecureRelay = params.get('platform') === 'vega' || nativeBridge?.platform?.() === 'vega-os';
const worlds = { forest: 'Evergreen escape', canyon: 'Golden canyon', neon: 'Afterglow city' };
const storage = {
  get(k, fallback = '') {
    try {
      const current = localStorage.getItem(k);
      if (current !== null) return current;
      // Keep existing device preferences when upgrading the renamed native app.
      if (/^skrien\.(sound|world|difficulty|gentle|relay)$/.test(k)) {
        const previous = localStorage.getItem(k.replace(/^skrien\./, 'mova.'));
        if (previous !== null) { localStorage.setItem(k, previous); return previous; }
      }
      return fallback;
    } catch { return fallback; }
  },
  set(k, v) { try { localStorage.setItem(k, String(v)); } catch {} }
};
let screen = 'home', world = 'forest', difficulty = 'medium', mode = 'keyboard', dialog = null, game, motion;
let generation = 0, soundEnabled = storage.get('skrien.sound') === 'on', cameraReady = false, cameraBusy = false;
let paired = false, lastStats = {}, toastTimer, feedbackTimer, lastCueAction = '', lastCueAlert = '', controllerHostState = 'home';
let lastDialogFocus = null, audioContext = null, wakeLock = null;
const trackingGate = new TrackingPauseGate();
// ?controller&record adds a landmark recorder for tuning movement detection on real players.
const recorder = isController && params.has('record') ? new PoseRecorder() : null;
const RECORD_HZ = 30;
// Set at build time; shown on the controller so a stale page is easy to spot.
const BUILD = typeof __SKRIEN_BUILD__ === 'string' ? __SKRIEN_BUILD__ : 'dev';
let recordTimer = null;
const fmt = n => Math.round(Number(n) || 0).toLocaleString();
const show = (id, visible) => { $(id).hidden = !visible; };
const text = (id, value) => { const s = String(value); if ($(id).textContent !== s) $(id).textContent = s; };
const icon = (id, name) => $(id).querySelector('use').setAttribute('href', '#i-' + name);

function toast(message, duration = 4500) {
  clearTimeout(toastTimer); text('toast', message); $('toast').classList.add('visible');
  toastTimer = setTimeout(() => $('toast').classList.remove('visible'), duration);
}
function tone(frequency = 660, duration = .08, shape = 'sine', volume = .035) {
  if (!soundEnabled) return;
  try {
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return;
    audioContext ||= new AudioCtor();
    audioContext.resume().catch(() => {});
    const oscillator = audioContext.createOscillator(), gain = audioContext.createGain(), now = audioContext.currentTime;
    oscillator.type = shape; oscillator.frequency.setValueAtTime(frequency, now);
    gain.gain.setValueAtTime(volume, now); gain.gain.exponentialRampToValueAtTime(.001, now + duration);
    oscillator.connect(gain); gain.connect(audioContext.destination); oscillator.start(); oscillator.stop(now + duration);
  } catch {}
}
function updateSound() {
  icon('sound-toggle', soundEnabled ? 'sound' : 'mute');
  $('sound-toggle').setAttribute('aria-label', soundEnabled ? 'Turn sound off' : 'Turn sound on');
}
updateSound();

function setScreen(next) {
  screen = next;
  for (const k of ['playing', 'paused', 'finished', 'counting']) document.body.classList.remove(k);
  const bodyClass = { playing: 'playing', paused: 'paused', results: 'finished', countdown: 'counting' }[next];
  if (bodyClass) document.body.classList.add(bodyClass);
  show('home', next === 'home' && !isController);
  show('topbar', next === 'home' || isController);
  show('attract-shade', next === 'home');
  show('hud', ['playing', 'paused'].includes(next));
  show('pause-screen', next === 'paused');
  show('results', next === 'results');
  show('countdown', next === 'countdown');
  if (relay.role === 'host') relay.sendState(next === 'results' ? 'finished' : ['playing', 'paused'].includes(next) ? next : 'home');
}
function updateStats(stats) {
  lastStats = stats;
  text('coins', fmt(stats.coins)); text('score', fmt(stats.score));
  text('combo', '×' + (stats.multiplier || 1)); text('distance', fmt(stats.distance));
  const seconds = Math.max(0, Math.ceil(stats.remaining || 0));
  text('remaining', `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`);
  $('session-progress').style.width = `${Math.min(100, stats.progress * 100)}%`;
  $('energy-fill').style.width = `${Math.max(0, stats.energy)}%`;
  text('energy-label', stats.energy < 45 ? 'KEEP GOING!' : 'YOUR ENERGY');
  const profile = DIFFICULTIES[stats.difficulty] || DIFFICULTIES[difficulty];
  text('hud-difficulty', profile.name.toUpperCase());
  text('phase-label', (stats.phaseLabel || 'Find your rhythm').toUpperCase());
  text('phase-time', stats.phase && stats.phase !== 'steady' ? `${Math.ceil(stats.phaseRemaining || 0)}s` : '');
  $('session-phase').dataset.phase = stats.phase || 'steady';
  const power = mode === 'keyboard' ? 1 : Math.max(0, Math.min(1, stats.runPower || 0));
  const bars = Math.ceil(power * 4);
  for (const [index, bar] of Array.from($('pace-bars').children).entries()) bar.classList.toggle('active', index < bars);
  text('pace-label', mode === 'keyboard' ? 'AUTO PACE' : power < .2 ? 'START MARCHING' : power < .6 ? 'STEADY PACE' : 'STRONG PACE');
}
function actionLabel(action) {
  return ({ jump: $('gentle').checked && mode !== 'keyboard' ? 'KNEE LIFT' : 'JUMP', duck: 'DUCK DOWN', clap: 'CLAP OVERHEAD', left: 'STEP LEFT', right: 'STEP RIGHT', center: 'BACK TO CENTER', run: 'RUN IN PLACE' })[action] || action?.toUpperCase() || '';
}
function moveInstruction(action) {
  const descriptions = {
    jump: $('gentle').checked && mode !== 'keyboard' ? 'Lift one knee high, then lower it.' : 'Jump with both feet, then land.',
    duck: 'Bend your knees. Stay low through the arch.',
    clap: 'Open your hands overhead, then clap once.',
    left: 'Step to your left. Hold the highlighted lane.',
    right: 'Step to your right. Hold the highlighted lane.',
    center: 'Return to the middle lane. Keep moving.'
  };
  if (mode !== 'keyboard') return descriptions[action] || 'Keep moving in place.';
  const keys = isTV ? { jump: 'Press D-pad UP', duck: 'Press D-pad DOWN', clap: 'Press SELECT', left: 'Press D-pad LEFT', right: 'Press D-pad RIGHT', center: 'Use the D-pad to reach the middle lane' }
    : { jump: 'Press ↑ or W', duck: 'Press ↓ or S', clap: 'Press SPACE or ENTER', left: 'Press ← or A', right: 'Press → or D', center: 'Use ← or → to reach the middle lane' };
  return keys[action] || 'Follow the coins and watch for your next move.';
}
function updateCue(cue) {
  const el = $('cue');
  if (!cue) {
    el.classList.remove('urgent'); icon('cue-svg', 'run');
    el.dataset.action = 'run';
    const recovering = ['recovery', 'cooldown'].includes(lastStats.phase), warmingUp = lastStats.phase === 'warmup';
    text('cue-kicker', recovering ? 'EASE YOUR PACE' : warmingUp ? 'START WITH A MARCH' : mode === 'keyboard' ? 'FOLLOW THE COINS' : 'KEEP YOUR FEET MOVING');
    text('cue-label', recovering ? 'EASY MARCH' : mode === 'keyboard' ? 'FOLLOW THE TRAIL' : 'RUN IN PLACE');
    text('cue-description', recovering ? 'Catch your breath. Reset your stance.' : mode === 'keyboard' ? 'Watch here. Move when the prompt says NOW.' : 'Stay in view. Your steps set the pace.');
    text('cue-time', recovering ? 'EASY' : 'GO'); text('cue-clock-label', recovering ? 'RECOVER' : 'YOUR PACE');
    text('cue-next', recovering ? 'RESET YOUR STANCE' : 'GET READY FOR THE NEXT MOVE');
    $('cue-progress').style.width = '0%';
    lastCueAction = ''; lastCueAlert = ''; return;
  }
  const action = cue.action, urgent = cue.seconds <= (cue.actSeconds || .9), cueKey = String(cue.id ?? action);
  icon('cue-svg', action); el.dataset.action = action;
  el.classList.toggle('urgent', urgent);
  text('cue-kicker', urgent ? 'DO THIS MOVE NOW' : 'GET READY');
  text('cue-label', actionLabel(action));
  text('cue-description', moveInstruction(action));
  text('cue-time', urgent ? 'NOW' : Math.ceil(cue.seconds));
  text('cue-clock-label', urgent ? 'LET’S MOVE' : 'SECONDS');
  text('cue-next', cue.nextAction ? `THEN · ${actionLabel(cue.nextAction)}` : 'THEN · KEEP MOVING');
  $('cue-progress').style.width = `${Math.min(100, Math.max(0, 1 - cue.seconds / (cue.leadSeconds || 3.35)) * 100)}%`;
  if (cueKey !== lastCueAction) { text('live-status', `Get ready: ${actionLabel(action)}. ${moveInstruction(action)}`); lastCueAction = cueKey; }
  if (urgent && lastCueAlert !== cueKey) { text('live-status', `${actionLabel(action)}, now.`); tone(780, .11); lastCueAlert = cueKey; }
}
function feedback(event) {
  if (event.kind === 'coin') { tone(920, .055, 'sine', .018); return; }
  clearTimeout(feedbackTimer); text('feedback', event.text);
  $('feedback').className = 'feedback visible ' + event.kind;
  feedbackTimer = setTimeout(() => $('feedback').classList.remove('visible'), 1200);
  tone(event.kind === 'miss' ? 190 : 680, .14, event.kind === 'miss' ? 'triangle' : 'sine');
}
function worldChanged(name) {
  text('hud-world', worlds[name].toUpperCase());
}
function finished(stats) {
  updateStats(stats); setScreen('results');
  text('final-score', fmt(stats.score)); text('final-coins', fmt(stats.coins)); text('final-distance', fmt(stats.distance) + ' m');
  text('results-mode', `${(DIFFICULTIES[stats.difficulty] || DIFFICULTIES[difficulty]).name.toUpperCase()} · SESSION COMPLETE`);
  text('results-moves', `${fmt(stats.successes)} of ${fmt(stats.successes + stats.misses)} moves cleared. ${$('gentle').checked ? 'Low-impact' : 'Your'} adventure, your pace.`);
  const key = `skrien.best.v3.${stats.difficulty || difficulty}.${Math.round(stats.duration || 90)}.${$('gentle').checked ? 'gentle' : 'standard'}`, previous = Number(storage.get(key, '0'));
  if (stats.score > previous) { storage.set(key, stats.score); text('personal-best', '✦ A new personal best. That’s your kind of progress.'); }
  else text('personal-best', `Best for this session: ${fmt(previous)} points · Longest streak: ${fmt(stats.bestCombo)}`);
  $('play-again').focus(); tone(880, .25);
}
function ensureGame() {
  if (game) return true;
  try {
    game = new RunnerGame($('world'), { onStats: updateStats, onCue: updateCue, onFeedback: feedback, onFinish: finished, onWorldChange: worldChanged, onPause: () => { if (screen === 'playing') pause('Your adventure is paused.'); } });
    return true;
  } catch (error) {
    show('world-fallback', true); console.error('SKRIEN renderer failed:', error); return false;
  }
}

async function begin() {
  if (isController) { relay.sendCommand('start'); return; }
  if (!ensureGame()) return;
  if (screen === 'countdown') return;
  if (mode === 'camera' && !cameraReady) { openCamera(); return; }
  if (mode === 'phone' && !paired) { openPair(); return; }
  const current = ++generation;
  closeDialog(); game.stop(); game.setWorld(world);
  setScreen('countdown');
  text('countdown-mode', `${DIFFICULTIES[difficulty].name.toUpperCase()} · GET READY TO MOVE`);
  text('countdown-tip', difficulty === 'workout' ? 'Stay in motion for the whole run. Follow each top-center prompt.' : 'Watch the top-center prompt. Move when it says NOW.');
  text('input-label', mode === 'camera' ? 'CAMERA · PROCESSED ON DEVICE' : mode === 'phone' ? 'CAMERA CONTROLLER CONNECTED' : isTV ? 'TV REMOTE' : 'KEYBOARD / REMOTE');
  text('game-hint', mode === 'keyboard' ? isTV ? 'D-PAD MOVE / JUMP / DUCK · SELECT CLAP · BACK PAUSE' : '← → MOVE   ↑ JUMP   ↓ DUCK   SPACE CLAP   P PAUSE' : 'RUN · JUMP · DUCK · STEP · CLAP OVERHEAD');
  for (let n = 3; n > 0; n--) {
    if (generation !== current) return;
    text('countdown-number', n); tone(440 + n * 70, .1);
    await new Promise(resolve => setTimeout(resolve, 800));
  }
  if (generation !== current) return;
  if ((mode === 'phone' && !paired) || (mode === 'camera' && !motion?.state.active)) { home(); toast('Reconnect your camera before starting.'); return; }
  text('countdown-number', 'GO'); tone(880, .16);
  game.start({ world, difficulty, duration: Number($('duration').value), mode, gentle: $('gentle').checked });
  setScreen('playing');
  document.activeElement?.blur?.();
}
function pause(reason = 'Your adventure will be right here.') {
  if (screen === 'countdown') { home(); return; }
  if (screen !== 'playing') return;
  text('pause-reason', reason); setScreen('paused'); game?.pause(); $('resume').focus();
}
function resume() {
  if (screen !== 'paused') return;
  if (mode === 'phone' && !paired) { toast('Reconnect your camera controller before resuming.'); return; }
  if (mode === 'camera' && (!cameraReady || !motion?.state.active)) { toast('Your camera is disconnected. Set it up again from the trail menu.'); return; }
  setScreen('playing'); game?.resume(); document.activeElement?.blur?.();
}
function home() {
  generation++; closeDialog(); game?.stop(); game?.setWorld(world); setScreen('home');
  $('play-now').focus(); $('feedback').classList.remove('visible');
}
function selectWorld(name) {
  world = name;
  for (const el of document.querySelectorAll('[data-world]')) { const active = el.dataset.world === world; el.classList.toggle('selected', active); el.setAttribute('aria-pressed', String(active)); }
  text('scene-name', worlds[name]); document.querySelector('.scene-coordinate').textContent = `0${Object.keys(worlds).indexOf(name) + 1} / 03`;
  game?.setWorld(name); storage.set('skrien.world', name);
}
function selectDifficulty(name) {
  difficulty = Object.prototype.hasOwnProperty.call(DIFFICULTIES, name) ? name : 'medium';
  for (const el of document.querySelectorAll('[data-difficulty]')) {
    const active = el.dataset.difficulty === difficulty;
    el.classList.toggle('selected', active); el.setAttribute('aria-pressed', String(active));
  }
  text('difficulty-summary', DIFFICULTIES[difficulty].description);
  storage.set('skrien.difficulty', difficulty);
  publishSettings();
}
function publishSettings() {
  if (relay.role === 'host') relay.sendSettings({ gentle: $('gentle').checked, difficulty });
}

function openDialog(id) {
  if (screen === 'playing') pause();
  lastDialogFocus = document.activeElement;
  if (dialog && dialog !== id) $(dialog).hidden = true;
  dialog = id; show('dialog-backdrop', true); show(id, true);
  setTimeout(() => $(id).querySelector('button:not([data-close]),input,select,button')?.focus(), 40);
}
function closeDialog() {
  const wasCamera = dialog === 'camera-dialog';
  if (dialog) $(dialog).hidden = true;
  dialog = null; show('dialog-backdrop', false);
  if (wasCamera && motion?.state.active) {
    $('tracking-slot').appendChild($('camera-rig')); show('tracking-dock', true);
  } else if (wasCamera && cameraBusy) { stopCamera(false); }
  lastDialogFocus?.focus?.();
}
function cameraStatus(status) {
  if (isController) text('stage-pace', status.state === 'tracking' && status.cadence ? `${status.cadence} steps/min` : '—');
  text('camera-status', status.message); text('tracking-caption', status.state === 'lost' ? 'STEP BACK INTO VIEW' : status.calibrated ? 'MOVEMENT CONNECTED' : 'CAMERA ON · CALIBRATE');
  $('camera-dot').style.background = status.state === 'error' || status.state === 'lost' ? '#e77e54' : '#76a15b';
  $('calibration-progress').style.width = `${Math.max(0, Math.min(1, status.progress || 0)) * 100}%`;
  show('body-guide', !status.active);
  if (status.state === 'error') { cameraReady = false; show('enable-camera', true); show('calibrate', false); show('start-camera-run', false); }
  const decision = trackingGate.update(status.state, performance.now(), isController ? controllerHostState : mode === 'camera' ? screen : 'home');
  if (decision === 'pause') {
    if (isController) relay.sendCommand('pause');
    else pause(status.state === 'error' ? 'The camera disconnected. Your run is safe here.' : 'Step back into view. Your run continues when the camera sees you.');
  } else if (decision === 'resume') {
    if (isController) relay.sendCommand('resume');
    else resume();
  }
}
function showMove(label) { text('last-move', label); text('stage-move', label); }
// Phones lock after ~30 s without a touch, which would stop the camera mid-run.
async function keepAwake(on) {
  if (!on) { const lock = wakeLock; wakeLock = null; await lock?.release().catch(() => {}); return; }
  if (wakeLock || !navigator.wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch { toast('Turn off auto-lock so your screen stays on during the run.', 6000); }
}
function stageCommand() { return controllerHostState === 'playing' ? 'pause' : controllerHostState === 'paused' ? 'resume' : 'start'; }
function updateStageToggle() {
  const command = stageCommand();
  text('stage-toggle', command === 'pause' ? 'Pause' : command === 'resume' ? 'Resume' : 'Start TV adventure');
  $('stage-toggle').classList.toggle('is-pause', command === 'pause');
}
function updateRecordButton() {
  text('stage-record', recorder?.recording ? `■ Stop and save · ${recorder.elapsedSeconds} s` : '● Record moves');
}
function saveRecording() {
  clearInterval(recordTimer); recordTimer = null;
  motion?.setInferenceRate(DEFAULT_HZ);
  const data = recorder.stop();
  updateRecordButton();
  if (!data?.frames.length) { toast('Nothing was recorded. Keep your whole body in view and try again.'); return; }
  data.meta.baselineAtEnd = motion?.logic.baseline ?? null;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
  link.download = `skrien-moves-${stamp}.json`;
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 10000);
  toast(`Saved ${data.frames.length} frames. Send the file to tune movement detection.`, 6000);
}
function toggleRecording() {
  if (!recorder || !motion?.state.active) return;
  if (recorder.recording) { saveRecording(); return; }
  motion.setInferenceRate(RECORD_HZ);
  recorder.start({
    startedAt: new Date().toISOString(), build: BUILD, userAgent: navigator.userAgent, inferenceHz: RECORD_HZ,
    gentle: $('gentle').checked, difficulty, baseline: motion.logic.baseline,
    video: { width: $('camera-video').videoWidth, height: $('camera-video').videoHeight },
  });
  updateRecordButton();
  // The recorder stops itself at its length limit; save as soon as it does.
  recordTimer = setInterval(() => { if (recorder.recording) updateRecordButton(); else saveRecording(); }, 500);
}
function getMotion() {
  if (!motion) motion = new MotionController({ video: $('camera-video'), canvas: $('pose-canvas'), onStatus: cameraStatus,
    onLandmarks: (landmarks, info) => recorder?.addFrame(info.now ?? performance.now(), landmarks, info.aspect),
    onAction: (action, payload) => {
      recorder?.addAction(performance.now(), action, payload);
      if (isController) {
        relay.sendAction(action, payload);
        if (action !== 'run' && action !== 'lane') showMove(({ jump: 'Jump ↑', duck: 'Duck ↓', clap: 'Overhead clap ✦' })[action] || action);
        if (action === 'lane') showMove(payload.value < 0 ? 'Move left ←' : payload.value > 0 ? 'Move right →' : 'Center lane');
      } else if (mode === 'camera') game?.input(action, payload);
    }
  });
  motion.setGentle($('gentle').checked); return motion;
}
function openCamera() {
  if (isController && controllerHostState === 'playing') relay.sendCommand('pause');
  if (isTV) { toast('Use your laptop or phone camera as the controller for this TV.'); openPair(); return; }
  $('camera-slot').appendChild($('camera-rig')); show('tracking-dock', false);
  show('enable-camera', !motion?.state.active); show('calibrate', Boolean(motion?.state.active)); show('start-camera-run', cameraReady);
  openDialog('camera-dialog');
}
async function enableCamera() {
  if (cameraBusy) return;
  cameraBusy = true; $('enable-camera').disabled = true; text('enable-camera', 'Starting camera…');
  try {
    await getMotion().start();
    if (motion.state.active) { show('enable-camera', false); show('calibrate', true); $('calibrate').focus(); keepAwake(true); }
  } catch (error) { toast(error.message, 6500); }
  finally { cameraBusy = false; $('enable-camera').disabled = false; text('enable-camera', 'Enable camera'); }
}
async function calibrate() {
  if (isController && controllerHostState === 'playing') relay.sendCommand('pause');
  cameraReady = false; $('calibrate').disabled = true; show('start-camera-run', false);
  try {
    await getMotion().calibrate(); cameraReady = true;
    show('start-camera-run', true); text('start-camera-run', isController ? controllerHostState === 'paused' ? 'Camera ready. Resume TV run ↗' : 'Camera ready. Start TV run ↗' : 'Ready. Let’s move ↗'); $('start-camera-run').focus();
    text('calibrate', 'Recalibrate'); tone(880, .18);
  } catch (error) { if (dialog === 'camera-dialog') toast(error.message, 5500); }
  finally { $('calibrate').disabled = false; }
}
function stopCamera(notify = true) {
  if (recorder?.recording) saveRecording();
  motion?.stop(); cameraReady = false; cameraBusy = false; show('tracking-dock', false); keepAwake(false);
  $('camera-slot').appendChild($('camera-rig'));
  if (mode === 'camera') { if (screen === 'playing') pause('Camera turned off. Choose Back to trails to start a run with keyboard controls.'); if (screen !== 'paused') mode = 'keyboard'; }
  if (isController) { relay.sendAction('run', { value: 0 }); relay.sendCommand('pause'); }
  if (notify) toast('Camera is off.');
}

const defaultRelay = storage.get('skrien.relay') || params.get('relay') || ((location.protocol === 'http:' || location.protocol === 'https:') && location.hostname !== 'appassets.androidplatform.net' && !isTV ? location.origin : '');
const relay = new RelayClient({
  onStatus(status) {
    const isPhone = status.role === 'controller';
    const id = isPhone ? 'controller-status' : 'pair-status';
    text(id, status.message); $(id).classList.toggle('error', status.state === 'error');
    if (status.state === 'paired') {
      paired = true;
      if (isPhone) { show('controller-connected', true); text('controller-status', 'Paired. Set up your camera, or check the connection with touch controls.'); }
      else { mode = 'phone'; publishSettings(); show('start-paired-run', true); text('play-note', 'Camera controller connected. Your movement sets the pace.'); tone(880, .12); }
    } else if (['waiting', 'disconnected', 'error'].includes(status.state)) {
      paired = false; show('start-paired-run', false);
      if (isPhone) show('controller-connected', false);
      if (['playing', 'countdown'].includes(screen) && mode === 'phone') pause('Camera controller disconnected. Reconnect it to keep moving.');
    }
  },
  onEvent(event) {
    if (event.type === 'action') { if (mode === 'phone') game?.input(event.action, { value: event.value }); }
    else if (event.type === 'settings' && isController) {
      $('gentle').checked = event.gentle;
      if ($('controller-gentle')) $('controller-gentle').checked = event.gentle;
      motion?.setGentle(event.gentle);
      selectDifficulty(event.difficulty);
      text('controller-session', `${DIFFICULTIES[difficulty].name} · ${event.gentle ? 'Low-impact knee raises' : 'Two-foot jumps'} · Set on your TV`);
    }
    else if (event.type === 'command') {
      if (event.command === 'start' && !['playing', 'countdown'].includes(screen)) { mode = 'phone'; begin(); }
      else if (event.command === 'pause') pause('Paused from your camera controller.');
      else if (event.command === 'resume' && screen === 'paused') resume();
    } else if (event.type === 'state' && isController) {
      controllerHostState = event.state;
      updateStageToggle();
      text('controller-start', event.state === 'playing' ? 'Adventure running on TV' : event.state === 'finished' ? 'Start another adventure ↗' : 'Start TV adventure ↗');
      $('controller-start').disabled = event.state === 'playing';
      text('controller-pause', event.state === 'paused' ? 'Resume TV adventure' : 'Pause TV adventure');
    }
  }
});
$('relay-url').value = defaultRelay;
if (needsSecureRelay) $('relay-url').placeholder = 'https://your-tunnel.trycloudflare.com';
$('controller-relay-input').value = params.get('relay') || ((location.hostname !== 'appassets.androidplatform.net' && /^https?:$/.test(location.protocol)) ? location.origin : defaultRelay);
function openPair() {
  if (!isTV && motion?.state.active) stopCamera(false);
  openDialog('pair-dialog');
  if (!relay.room && $('relay-url').value && /^https?:/.test(location.protocol) && !isTV) createRoom();
}
async function createRoom() {
  if (needsSecureRelay && !/^(?:https|wss):\/\//i.test($('relay-url').value.trim())) {
    text('pair-status', 'This TV only connects to HTTPS relays. Run npm run tunnel on your computer and enter its https:// address.');
    $('pair-status').classList.add('error');
    return;
  }
  $('create-room').disabled = true; show('pair-code-wrap', false);
  try {
    const result = await relay.create($('relay-url').value);
    publishSettings();
    storage.set('skrien.relay', result.url); text('pair-code', result.room);
    const url = `${result.url}/?controller=${encodeURIComponent(result.room)}`;
    $('controller-link').href = url; show('pair-code-wrap', true);
    // A TV cannot open links, so it shows the address to type on the phone instead.
    if (isTV) text('controller-link', url.replace(/^https?:\/\//, ''));
    show('copy-controller-link', !isTV);
    text('pair-status', isTV ? 'On your phone, open the address above and allow the camera.' : 'Open the controller link on your camera device and enter this code.');
  } catch (error) { if (error.name !== 'AbortError') toast(error.message, 7000); }
  finally { $('create-room').disabled = false; }
}
async function joinRoom() {
  $('join-room').disabled = true;
  try {
    await relay.join($('controller-relay-input').value, $('controller-code-input').value);
    tone(880, .12);
  } catch (error) { if (error.name !== 'AbortError') { text('controller-status', error.message); $('controller-status').classList.add('error'); } }
  finally { $('join-room').disabled = false; }
}

// Menus work with a physical D-pad as well as pointer, keyboard and touch.
function focusableElements() {
  const container = dialog ? $(dialog) : screen === 'paused' ? $('pause-screen') : screen === 'results' ? $('results') : isController ? $('controller-screen') : document.body;
  return Array.from(container.querySelectorAll('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),summary')).filter(el => {
    const rect = el.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && !el.closest('[hidden]');
  });
}
function moveFocus(key) {
  const items = focusableElements();
  if (!items.length) return;
  const active = document.activeElement;
  if (!items.includes(active)) { (dialog ? items.find(x => !x.hasAttribute('data-close')) : $('play-now'))?.focus(); return; }
  const a = active.getBoundingClientRect(), x = a.left + a.width / 2, y = a.top + a.height / 2;
  const horizontal = key === 'ArrowLeft' || key === 'ArrowRight', sign = key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 1;
  const candidates = items.filter(el => el !== active).map(el => {
    const r = el.getBoundingClientRect(), dx = r.left + r.width / 2 - x, dy = r.top + r.height / 2 - y;
    const main = (horizontal ? dx : dy) * sign, cross = Math.abs(horizontal ? dy : dx);
    return { el, main, weight: main + cross * 2.8 };
  }).filter(v => v.main > 5).sort((a, b) => a.weight - b.weight);
  if (candidates.length) candidates[0].el.focus();
}
function handleKey(key, fromNative = false) {
  const active = document.activeElement;
  if (fromNative && key === 'Enter' && active?.tagName === 'SELECT') {
    active.selectedIndex = (active.selectedIndex + 1) % active.options.length;
    active.dispatchEvent(new Event('change', { bubbles: true })); return true;
  }
  if (dialog) {
    if (key === 'Escape' || key === 'BrowserBack') { closeDialog(); return true; }
    if (fromNative && key === 'Enter' && active?.tagName === 'INPUT' && active.type !== 'checkbox') {
      active.focus(); nativeBridge?.showKeyboard?.(); return true;
    }
    if (!fromNative && ['INPUT', 'SELECT', 'TEXTAREA'].includes(active?.tagName)) return false;
    if (key.startsWith('Arrow')) { moveFocus(key); return true; }
    if (key === 'Enter' || key === ' ') { active?.click?.(); return true; }
    return false;
  }
  if (screen === 'countdown') { if (key === 'Escape') home(); return true; }
  if (screen === 'playing') {
    const action = { ArrowLeft: 'left', a: 'left', A: 'left', ArrowRight: 'right', d: 'right', D: 'right', ArrowUp: 'jump', w: 'jump', W: 'jump', ArrowDown: 'duck', s: 'duck', S: 'duck', ' ': 'clap', Enter: 'clap' }[key];
    if (action) { game?.input(action); return true; }
    if (['Escape', 'p', 'P', 'MediaPlayPause', 'ContextMenu', 'BrowserBack'].includes(key)) { pause(); return true; }
    return false;
  }
  if (screen === 'paused' && ['Escape', 'p', 'P', 'MediaPlayPause', 'BrowserBack'].includes(key)) { resume(); return true; }
  if (key === 'Escape' || key === 'BrowserBack') { if (screen !== 'home') home(); return true; }
  if (!fromNative && ['INPUT', 'SELECT', 'TEXTAREA'].includes(active?.tagName)) return false;
  if (key.startsWith('Arrow')) { moveFocus(key); return true; }
  if (key === 'Enter' || key === ' ') {
    if (active && active !== document.body && focusableElements().includes(active)) active.click();
    else if (!isController) begin();
    return true;
  }
  return false;
}
window.SKRIEN = { handleKey: key => handleKey(key, true), pause: () => pause('Your adventure is paused.'), getState: () => ({ screen, mode, world, difficulty, stats: lastStats }) };
// Compatibility with already-installed 0.1/0.2 native wrappers.
window.MOVA = window.SKRIEN;
document.addEventListener('keydown', event => {
  if (event.repeat && [' ', 'Enter', 'ArrowUp', 'w', 'W'].includes(event.key)) return;
  if (event.key === 'Tab' && dialog) {
    const items = focusableElements(), first = items[0], last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) { last?.focus(); event.preventDefault(); }
    else if (!event.shiftKey && document.activeElement === last) { first?.focus(); event.preventDefault(); }
    return;
  }
  if (handleKey(event.key)) event.preventDefault();
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && motion?.state.active) keepAwake(true);
  if (document.hidden) {
    if (screen === 'playing') pause('Your adventure is paused while this screen is away.');
    if (isController && motion?.state.active) { relay.sendAction('run', { value: 0 }); relay.sendCommand('pause'); }
  }
});
window.addEventListener('pagehide', () => { motion?.stop(); relay.close(); });

$('play-now').onclick = () => { if (mode !== 'phone' || !paired) mode = cameraReady && motion?.state.active ? 'camera' : 'keyboard'; begin(); };
$('connect-camera').onclick = openCamera;
$('enable-camera').onclick = enableCamera;
$('calibrate').onclick = calibrate;
$('start-camera-run').onclick = () => {
  if (!cameraReady) return;
  closeDialog();
  if (isController) { relay.sendCommand(controllerHostState === 'paused' ? 'resume' : 'start'); toast('Camera ready. Move into your TV adventure.'); }
  else { mode = 'camera'; begin(); }
};
$('camera-off').onclick = () => stopCamera();
$('pause').onclick = () => pause(); $('resume').onclick = resume;
$('restart').onclick = begin; $('play-again').onclick = begin;
$('back-home').onclick = home; $('results-home').onclick = home;
$('how-to').onclick = () => openDialog('help-dialog');
$('pair-device').onclick = openPair; $('create-room').onclick = createRoom;
$('start-paired-run').onclick = () => { mode = 'phone'; begin(); };
$('copy-controller-link').onclick = async () => {
  try { await navigator.clipboard.writeText($('controller-link').href); toast('Controller link copied.'); }
  catch { toast('Open the controller link above, or enter the pairing code on your laptop.'); }
};
$('sound-toggle').onclick = () => { soundEnabled = !soundEnabled; storage.set('skrien.sound', soundEnabled ? 'on' : 'off'); updateSound(); tone(); };
$('fullscreen').onclick = async () => {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen(); else toast('Use your browser’s fullscreen control.'); }
  catch { toast('Fullscreen is unavailable here. Open the game in its own browser tab.'); }
};
$('gentle').onchange = () => { motion?.setGentle($('gentle').checked); storage.set('skrien.gentle', $('gentle').checked ? 'yes' : 'no'); publishSettings(); };
for (const el of document.querySelectorAll('[data-world]')) el.onclick = () => selectWorld(el.dataset.world);
for (const el of document.querySelectorAll('[data-difficulty]')) el.onclick = () => selectDifficulty(el.dataset.difficulty);
for (const el of document.querySelectorAll('[data-close]')) el.onclick = closeDialog;
$('dialog-backdrop').onclick = closeDialog;
document.querySelector('.brand').onclick = event => { if (!isController) { event.preventDefault(); home(); } };
$('join-room').onclick = joinRoom;
$('controller-camera').onclick = openCamera;
$('controller-start').onclick = () => relay.sendCommand('start');
$('controller-pause').onclick = () => relay.sendCommand(controllerHostState === 'paused' ? 'resume' : 'pause');
$('stage-toggle').onclick = () => relay.sendCommand(stageCommand());
$('stage-setup').onclick = openCamera;
$('stage-record').onclick = toggleRecording;
show('stage-record', Boolean(recorder));
text('stage-build', `build ${BUILD}`);
for (const el of document.querySelectorAll('[data-action]')) el.onclick = () => {
  const action = el.dataset.action;
  relay.sendAction(action, { value: 1 }); showMove('Touch: ' + action);
  if (action === 'run') {
    let ticks = 0;
    const timer = setInterval(() => { relay.sendAction('run', { value: 1 }); if (++ticks >= 15) { clearInterval(timer); relay.sendAction('run', { value: 0 }); } }, 100);
  }
};
$('controller-code-input').addEventListener('input', event => { event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6); });
$('controller-code-input').addEventListener('keydown', event => { if (event.key === 'Enter') joinRoom(); });
$('relay-url').addEventListener('keydown', event => { if (event.key === 'Enter') createRoom(); });

$('gentle').checked = storage.get('skrien.gentle') === 'yes';
selectDifficulty(storage.get('skrien.difficulty', 'medium'));
if (isController) {
  document.body.classList.add('is-controller'); show('home', false); show('controller-screen', true);
  const gentleChoice = document.createElement('label'); gentleChoice.className = 'gentle-label'; gentleChoice.style.cssText = 'border:0;padding:10px 0 20px;font-size:12px';
  gentleChoice.innerHTML = '<input type="checkbox" id="controller-gentle" disabled><span class="switch"></span> Low-impact knee raises · Set on your TV';
  $('controller-connected').insertBefore(gentleChoice, $('controller-camera'));
  $('controller-gentle').checked = $('gentle').checked;
  $('controller-code-input').value = (params.get('controller') || '').toUpperCase();
  if ($('controller-code-input').value.length === 6) joinRoom();
} else {
  ensureGame();
  const rememberedWorld = storage.get('skrien.world', 'forest'); selectWorld(worlds[rememberedWorld] ? rememberedWorld : 'forest');
  if (isTV) { text('play-note', 'Use the D-pad to move · Select to play · Back to pause'); text('connect-camera', 'Pair your camera'); $('play-now').focus(); }
}
