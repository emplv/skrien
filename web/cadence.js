/**
 * Step rate from the rhythm of a body signal (for example torso height), found
 * by autocorrelation over a short window. Rhythm survives weak or lopsided
 * steps that a peak counter misses, while random tracking noise has none.
 */
const WINDOW_MS = 2400;
const GRID_MS = 50;
const MIN_LAG = 4;   // 200 ms per step (5 steps/s)
const MAX_LAG = 16;  // 800 ms per step (1.25 steps/s)
const MIN_STRENGTH = 0.3;
// A weaker step on one leg makes the two-step period correlate best, so the
// shortest period that is at least half as strong wins.
const HARMONIC_RATIO = 0.5;
const MIN_SD = 0.015;
const RECENT_MS = 700;
const RECENT_SD = 0.01;
const MAX_GAP_MS = 300;

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

function detrend(values) {
  const n = values.length;
  const meanX = (n - 1) / 2;
  const meanY = values.reduce((sum, v) => sum + v, 0) / n;
  let numerator = 0, denominator = 0;
  values.forEach((v, i) => { numerator += (i - meanX) * (v - meanY); denominator += (i - meanX) ** 2; });
  const slope = denominator ? numerator / denominator : 0;
  return values.map((v, i) => v - meanY - slope * (i - meanX));
}

const deviation = values => Math.sqrt(values.reduce((sum, v) => sum + v * v, 0) / values.length);

function correlation(z, lag) {
  let product = 0, early = 0, late = 0;
  for (let i = lag; i < z.length; i++) {
    product += z[i] * z[i - lag];
    late += z[i] * z[i];
    early += z[i - lag] * z[i - lag];
  }
  return early && late ? product / Math.sqrt(early * late) : 0;
}

export class CadenceEstimator {
  constructor() { this.reset(); }

  reset() {
    this.samples = [];
    this.rate = 0;
  }

  /** Adds a sample and returns the current step rate in steps per second (0 when not stepping). */
  update(t, value) {
    if (!Number.isFinite(t) || !Number.isFinite(value)) return this.rate;
    const last = this.samples[this.samples.length - 1];
    if (last && t <= last.t) return this.rate;
    if (last && t - last.t > MAX_GAP_MS) this.samples = [];
    this.samples.push({ t, value });
    while (t - this.samples[0].t > WINDOW_MS) this.samples.shift();
    this.rate = this._estimate(t);
    return this.rate;
  }

  _grid(now) {
    const samples = this.samples, grid = [];
    let j = 0;
    for (let t = samples[0].t; t <= now; t += GRID_MS) {
      while (j < samples.length - 2 && samples[j + 1].t < t) j++;
      const a = samples[j], b = samples[j + 1] ?? a;
      const k = b.t === a.t ? 0 : clamp((t - a.t) / (b.t - a.t), 0, 1);
      grid.push(a.value + (b.value - a.value) * k);
    }
    return grid;
  }

  _estimate(now) {
    if (this.samples.length < 8 || now - this.samples[0].t < 1200) return 0;
    const z = detrend(this._grid(now));
    if (deviation(z) < MIN_SD) return 0;
    if (deviation(detrend(z.slice(-Math.round(RECENT_MS / GRID_MS)))) < RECENT_SD) return 0;
    const maxLag = Math.min(MAX_LAG + 1, z.length - 6);
    const r = [];
    for (let lag = 0; lag <= maxLag; lag++) r[lag] = lag < MIN_LAG - 1 ? 0 : correlation(z, lag);
    const peaks = [];
    for (let lag = MIN_LAG; lag < maxLag; lag++) {
      if (r[lag] >= r[lag - 1] && r[lag] >= r[lag + 1] && r[lag] >= MIN_STRENGTH) peaks.push(lag);
    }
    if (!peaks.length) return 0;
    const strongest = Math.max(...peaks.map(lag => r[lag]));
    const lag = peaks.find(candidate => r[candidate] >= strongest * HARMONIC_RATIO);
    const curvature = r[lag - 1] - 2 * r[lag] + r[lag + 1];
    const offset = curvature ? clamp(0.5 * (r[lag - 1] - r[lag + 1]) / curvature, -0.5, 0.5) : 0;
    return 1000 / ((lag + offset) * GRID_MS);
  }
}
