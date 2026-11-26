// Visible-depth-adaptive depth partitioning.
//
// The fixed scheme uses exponentially spaced boundaries (uniform in log depth).
// This module instead measures the distribution of VISIBLE surface depths for the
// current camera and places slice boundaries at equal-mass quantiles of that
// distribution, so slice resolution follows where geometry (and therefore light
// queries) actually is. Both the fixed and adaptive schemes are consumed through
// the same cfg.boundaries table, so the exact same shader path shades both.
//
// The histogram is built from coarse primary rays through the static scene, which
// makes it deterministic and cheap enough for the UI and for headless runs.

import { rayForPixel } from './camera.js';
import { rayScene } from './scene.js';
import { vec3 } from './math.js';
import { exponentialBoundaries } from './clusters.js';

export const DEFAULT_SAMPLE_RES = { x: 96, y: 54 };
export const HISTOGRAM_BINS = 128;

// Cast a coarse grid of primary rays and collect positive view depths of hits.
// Sky pixels (misses) contribute nothing to the visible-depth distribution.
export function sampleVisibleDepths(cfg, camMats, cam, boxes, res = DEFAULT_SAMPLE_RES) {
  const rx = Math.max(2, res.x | 0);
  const ry = Math.max(2, res.y | 0);
  const depths = [];
  for (let py = 0; py < ry; py++) {
    for (let px = 0; px < rx; px++) {
      // Sample at the centre of the coarse pixel mapped into full-res space so
      // the field of view matches the real render exactly.
      const fx = ((px + 0.5) / rx) * cfg.width;
      const fy = ((py + 0.5) / ry) * cfg.height;
      const ray = rayForPixel(camMats, cam, cfg, fx, fy, cfg.width, cfg.height);
      const hit = rayScene(ray.orig, ray.dir, boxes);
      if (!hit) continue;
      const P = [
        ray.orig[0] + ray.dir[0] * hit.t,
        ray.orig[1] + ray.dir[1] * hit.t,
        ray.orig[2] + ray.dir[2] * hit.t,
      ];
      const vp = vec3.transformPoint(camMats.view, P);
      const d = -vp[2];
      if (d > cfg.near && d < cfg.far) depths.push(d);
    }
  }
  return depths;
}

// Log-space histogram of visible depths (bin 0 nearest, bin BINS-1 farthest).
export function buildDepthHistogram(cfg, depths, bins = HISTOGRAM_BINS) {
  const counts = new Float64Array(bins);
  const logNear = Math.log(cfg.near);
  const invSpan = 1 / Math.log(cfg.far / cfg.near);
  for (let i = 0; i < depths.length; i++) {
    const d = depths[i];
    let t = (Math.log(d) - logNear) * invSpan;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    let bi = Math.floor(t * bins);
    if (bi >= bins) bi = bins - 1;
    counts[bi] += 1;
  }
  let total = 0;
  for (let i = 0; i < bins; i++) total += counts[i];
  return { counts, total, bins, logNear, logSpan: Math.log(cfg.far / cfg.near) };
}

// Turn a visible-depth histogram into `slices+1` strictly increasing boundaries
// by taking equal-mass quantiles. Empty tail regions collapse toward `far`, and a
// minimum geometric gap keeps the table monotonic in float32.
export function buildAdaptiveBoundaries(cfg, hist, opts = {}) {
  const slices = cfg.slices;
  const bins = hist.bins;
  const { near, far } = cfg;
  const logNear = hist.logNear;
  const logSpan = hist.logSpan;
  const minRatio = opts.minRatio ?? 1.001;

  const out = new Float32Array(slices + 1);
  out[0] = near;
  out[slices] = far;

  if (!hist.total) {
    // No visible geometry: fall back to the fixed exponential table.
    return exponentialBoundaries(near, far, slices);
  }

  // Prefix sums for quantile lookup (lower edge of the bin where cumulative mass
  // first reaches the target fraction).
  const cum = new Float64Array(bins);
  let acc = 0;
  for (let i = 0; i < bins; i++) { acc += hist.counts[i]; cum[i] = acc; }

  const q = new Float64Array(slices + 1);
  q[0] = near;
  q[slices] = far;
  let binCursor = 0;
  for (let k = 1; k < slices; k++) {
    const target = (hist.total * k) / slices;
    while (binCursor < bins - 1 && cum[binCursor] < target) binCursor++;
    const t = binCursor / bins;
    q[k] = Math.exp(logNear + t * logSpan);
  }

  // Forward monotonic pass with a minimum relative gap.
  for (let k = 1; k <= slices; k++) {
    const floor = q[k - 1] * minRatio;
    if (!(q[k] > floor)) q[k] = floor;
  }
  // Clamp back to far with a reverse pass; if forcing overflowed we compress.
  if (q[slices] > far || !(q[slices] > q[slices - 1] * minRatio)) {
    q[slices] = far;
    for (let k = slices - 1; k >= 0; k--) {
      const ceil = q[k + 1] / minRatio;
      if (!(q[k] < ceil)) q[k] = ceil;
    }
    q[0] = Math.max(near, q[0]);
  }
  for (let k = 0; k <= slices; k++) out[k] = q[k];
  out[0] = near;
  out[slices] = far;

  // Guarantee strict increase in float32; if rounding collapses a pair, nudge up.
  for (let k = 1; k <= slices; k++) {
    if (!(out[k] > out[k - 1])) out[k] = out[k - 1] * (1 + 1e-5);
  }
  out[slices] = far;
  if (!(out[slices] > out[slices - 1])) out[slices - 1] = far * (1 - 1e-5);
  return out;
}

// Convenience: sample + histogram + boundaries in one call.
export function computeAdaptiveBoundaries(cfg, camMats, cam, boxes, opts = {}) {
  const res = opts.sampleRes || DEFAULT_SAMPLE_RES;
  const depths = sampleVisibleDepths(cfg, camMats, cam, boxes, res);
  const hist = buildDepthHistogram(cfg, depths, opts.bins ?? HISTOGRAM_BINS);
  const bounds = buildAdaptiveBoundaries(cfg, hist, opts);
  return {
    boundaries: bounds,
    hist,
    sampleCount: depths.length,
    sampleRes: res,
    // Fraction of slices that fall inside the near 25% of log-depth range, a
    // compact way to express "how much resolution the partition moved near".
    nearQuarterSlices: countBelow(bounds, Math.exp(Math.log(cfg.near) + 0.25 * Math.log(cfg.far / cfg.near))),
  };
}

function countBelow(bounds, depth) {
  let n = 0;
  for (let k = 1; k < bounds.length - 1; k++) if (bounds[k] < depth) n++;
  return n;
}
