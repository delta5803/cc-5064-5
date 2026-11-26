// Fixed vs visible-depth-adaptive depth partition experiment.
//
// This is the executable core of the "light clustering experiment": it builds two
// adversarial light populations (a uniform field and a dense near-face knot), runs
// BOTH depth partitions through the SAME assignment kernel and the SAME shading
// reference, and reports lighting error + list volume + query cost. Nothing here
// drops a light to save work: coverage is measured against the all-light reference
// on every run, so "we reduced the load by leaking lights" is detectable.
//
// Everything is deterministic, so the numbers written by scripts/experiment.mjs
// are reproducible by re-running it.

import { makeClusterConfig, buildClusterBounds, decodeCluster, depthBoundary } from './clusters.js';
import { cameraMatrices } from './camera.js';
import { assignClusters, checkFrameInvariants } from './assignment.js';
import { buildNightMarket, mulberry32 } from './scene.js';
import { renderImage } from './shading.js';
import { computeAdaptiveBoundaries } from './adaptive.js';
import { makeLight } from './lights.js';

let SCENE = null;
function scene() {
  if (!SCENE) SCENE = buildNightMarket();
  return SCENE;
}

// A uniform field: lights spread evenly in log-depth over the whole street so the
// raw per-cluster occupancy is as even across depth as the geometry allows.
export function buildUniformLights(count = 96) {
  const rng = mulberry32(2026);
  const lights = [];
  for (let i = 0; i < count; i++) {
    const t = (i + 0.5) / count;
    const z = 16 - t * (16 + 52); // 16 near camera down to -52
    const side = i % 2 === 0 ? -1 : 1;
    lights.push(makeLight({
      name: `均匀灯 ${i + 1}`,
      group: 'uniform',
      pos: [side * (3 + rng() * 4), 3.2 + rng() * 2.4, z],
      color: [0.7 + rng() * 0.3, 0.6 + rng() * 0.3, 0.45 + rng() * 0.5],
      intensity: 16 + rng() * 12,
      range: 9 + rng() * 5,
    }));
  }
  lights.forEach((l, i) => { l.slot = i; });
  return lights;
}

// A dense near-face knot: most lights are co-located in a few metres in front of
// the camera (small view depth), with a light sprinkling farther down the street.
// This is the workload where visible-depth quantiles may or may not help, because
// the knot covers screen area but sits in one narrow depth band.
export function buildNearKnotLights(count = 96, knotFraction = 0.75) {
  const rng = mulberry32(777);
  const lights = [];
  const knotCount = Math.round(count * knotFraction);
  for (let i = 0; i < knotCount; i++) {
    lights.push(makeLight({
      name: `近面灯团 ${i + 1}`,
      group: 'knot',
      pos: [(rng() - 0.5) * 5.5, 1.6 + rng() * 3.0, 12.5 + rng() * 5.5],
      color: [0.5 + rng() * 0.5, 0.45 + rng() * 0.5, 0.5 + rng() * 0.5],
      intensity: 14 + rng() * 18,
      range: 6 + rng() * 7,
    }));
  }
  for (let i = knotCount; i < count; i++) {
    const t = (i - knotCount + 0.5) / (count - knotCount);
    lights.push(makeLight({
      name: `远处补灯 ${i + 1}`,
      group: 'far',
      pos: [(rng() - 0.5) * 8, 3.2 + rng() * 2.5, 8 - t * 46],
      color: [0.55 + rng() * 0.4, 0.5 + rng() * 0.4, 0.5 + rng() * 0.4],
      intensity: 8 + rng() * 10,
      range: 7 + rng() * 7,
    }));
  }
  lights.forEach((l, i) => { l.slot = i; });
  return lights;
}

// Build a cfg for one partition. Adaptive samples visible depth once per camera.
export function makeExperimentCfg(base, partition, camMats, cam) {
  if (partition !== 'adaptive') {
    return { cfg: makeClusterConfig({ ...base, partition: 'fixed' }), adaptive: null };
  }
  const cfg0 = makeClusterConfig({ ...base, partition: 'adaptive' });
  const info = computeAdaptiveBoundaries(cfg0, camMats, cam, scene());
  return {
    cfg: { ...cfg0, boundaries: info.boundaries },
    adaptive: info,
  };
}

// The first cluster (lowest id) whose raw candidate count exceeds its capacity.
export function firstOverCapacity(candidate, capArr) {
  const K = candidate.cfg.clusterCount;
  const cap = (id) => (capArr ? capArr[id] : candidate.opts.capacity);
  for (let id = 0; id < K; id++) {
    if (candidate.rawCount[id] > cap(id)) {
      const d = decodeCluster(candidate.cfg, id);
      return {
        id,
        tx: d.tx,
        ty: d.ty,
        slice: d.s,
        rawCount: candidate.rawCount[id],
        capacity: cap(id),
        depth0: depthBoundary(candidate.cfg, d.s),
        depth1: depthBoundary(candidate.cfg, d.s + 1),
      };
    }
  }
  return null;
}

// Per-slice list-length and query-cost summary: how many lights a cluster in each
// slice must iterate, and how much of that is "empty region" (zero-light) work.
export function perSliceSummary(candidate) {
  const cfg = candidate.cfg;
  const out = new Array(cfg.slices);
  const K = cfg.clusterCount;
  const tilesPerSlice = cfg.cols * cfg.rows;
  for (let s = 0; s < cfg.slices; s++) {
    let sumStored = 0;
    let maxStored = 0;
    let empty = 0;
    let over = 0;
    for (let ty = 0; ty < cfg.rows; ty++) {
      for (let tx = 0; tx < cfg.cols; tx++) {
        const id = (s * cfg.rows + ty) * cfg.cols + tx;
        const stored = candidate.headerData[id * 4 + 1];
        const raw = candidate.rawCount[id];
        sumStored += stored;
        if (stored > maxStored) maxStored = stored;
        if (stored === 0) empty++;
        if (raw > candidate.opts.capacity) over++;
      }
    }
    out[s] = {
      slice: s,
      depth0: depthBoundary(cfg, s),
      depth1: depthBoundary(cfg, s + 1),
      meanStored: sumStored / tilesPerSlice,
      maxStored,
      emptyTiles: empty,
      tiles: tilesPerSlice,
      overCapacityTiles: over,
    };
  }
  return out;
}

function assertNoLeak(label, cmpMetrics) {
  if (cmpMetrics.coverageMissCount !== 0) {
    throw new Error(`${label}: ${cmpMetrics.coverageMissCount} coverage misses — experiment refuses to count a leaky run`);
  }
}

// NEGATIVE CONTROL ONLY. Build a frame that keeps only each cluster's primary
// local list and drops spill + the global table, i.e. the classic "cap the list
// and let lights go missing" shortcut. Rendering this against the all-light
// reference quantifies the lighting error that shortcut introduces, which is
// exactly what the accepted partitions are NOT allowed to do. Never published.
export function truncateToPrimary(frame) {
  const K = frame.cfg.clusterCount;
  const headerData = new Uint32Array(frame.headerData);
  const indices = [];
  for (let id = 0; id < K; id++) {
    const off = frame.headerData[id * 4];
    const primary = frame.headerData[id * 4 + 2];
    const newOff = indices.length;
    for (let k = 0; k < primary; k++) indices.push(frame.indexData[off + k]);
    headerData[id * 4] = newOff;
    headerData[id * 4 + 1] = primary;
    headerData[id * 4 + 2] = primary;
    headerData[id * 4 + 3] = 0;
  }
  const globalOffset = indices.length;
  return {
    ...frame,
    headerData,
    indexData: new Uint32Array(indices),
    globalOffset,
    globalSlots: [],
  };
}

// Lighting-error-only measurement for the truncation control (no query-cost claim).
export function measureTruncationError({ lights, cam, partition, capacity, globalBudget, slices = 24 }) {
  const width = 320, height = 180;
  const base = { width, height, tilePixels: 20, slices, near: cam.near, far: cam.far, fovyDeg: cam.fovyDeg };
  const mats = cameraMatrices(cam, width / height);
  const { cfg } = makeExperimentCfg(base, partition, mats, cam);
  const bounds = buildClusterBounds(cfg);
  const candidate = assignClusters(cfg, bounds, mats.view, lights, {
    strategy: 'hybrid', capacity, globalBudget,
  });
  const truncated = truncateToPrimary(candidate);
  const common = { cfg, camMats: mats, boxes: scene(), lights, width, height };
  const ref = renderImage({ ...common, mode: 'reference' });
  const clu = renderImage({ ...common, mode: 'clustered', frame: truncated, coverageCheck: true });
  let sumSq = 0, maxAbs = 0, samples = 0, mismatch = 0;
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    let pixMax = 0;
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(ref.rgba[o + c] - clu.rgba[o + c]);
      if (d > maxAbs) maxAbs = d;
      if (d > pixMax) pixMax = d;
      sumSq += d * d; samples++;
    }
    if (pixMax > 3) mismatch++;
  }
  const mse = sumSq / samples;
  return {
    psnr: mse < 1e-8 ? Infinity : 10 * Math.log10((255 * 255) / mse),
    maxAbs,
    mismatchPixels: mismatch,
    coverageMissCount: clu.coverageMissCount,
  };
}

// Render reference + clustered for one (scenario, partition) and compute the
// lighting error metrics. Returns everything the report/doc needs.
export function runOne({
  lights, cam, partition, capacity = 16, globalBudget = 32,
  totalIndexBudget = 262144, strategy = 'hybrid',
  width = 320, height = 180, tilePixels = 20, slices = 24,
}) {
  const base = {
    width, height, tilePixels, slices,
    near: cam.near, far: cam.far, fovyDeg: cam.fovyDeg,
  };
  const mats = cameraMatrices(cam, width / height);
  const { cfg, adaptive } = makeExperimentCfg(base, partition, mats, cam);
  const bounds = buildClusterBounds(cfg);

  const candidate = assignClusters(cfg, bounds, mats.view, lights, {
    strategy, capacity, globalBudget, totalIndexBudget,
  });
  const violations = checkFrameInvariants(candidate, lights);
  if (violations.length) throw new Error(`${partition}: frame invariants broken: ${violations.slice(0, 3).join('; ')}`);

  // Lighting error / query cost from the shared shading path.
  const common = { cfg, camMats: mats, boxes: scene(), lights, width, height };
  const ref = renderImage({ ...common, mode: 'reference' });
  const clu = renderImage({
    ...common, mode: 'clustered', frame: candidate, coverageCheck: true,
  });

  let sumSq = 0, sumAbs = 0, maxAbs = 0, samples = 0, mismatch = 0;
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    let pixMax = 0;
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(ref.rgba[o + c] - clu.rgba[o + c]);
      if (d > maxAbs) maxAbs = d;
      if (d > pixMax) pixMax = d;
      sumAbs += d; sumSq += d * d; samples++;
    }
    if (pixMax > 3) mismatch++;
  }
  const mse = sumSq / samples;
  const psnr = mse < 1e-8 ? Infinity : 10 * Math.log10((255 * 255) / mse);

  const metrics = {
    psnr,
    mse,
    maxAbs,
    meanAbs: sumAbs / samples,
    mismatchPixels: mismatch,
    totalPixels: width * height,
    coverageMissCount: clu.coverageMissCount,
    referenceIterations: ref.totalIterations,
    clusteredIterations: clu.totalIterations,
    referenceAvgPerPixel: ref.avgIterAll,
    clusteredAvgPerPixel: clu.avgIterAll,
    clusteredAvgPerShaded: clu.avgIterShaded,
    clusteredMaxPerPixel: clu.maxIter,
    speedup: ref.totalIterations / Math.max(1, clu.totalIterations),
  };
  assertNoLeak(`${partition}`, metrics);

  return {
    partition,
    cfg,
    adaptive,
    candidate,
    metrics,
    stats: candidate.stats,
    complete: candidate.complete,
    reason: candidate.reason,
    firstOverCapacity: firstOverCapacity(candidate),
    perSlice: perSliceSummary(candidate),
  };
}

export function runScenario(scenarioName, lights, cam, opts = {}) {
  const fixed = runOne({ lights, cam, partition: 'fixed', ...opts });
  const adaptive = runOne({ lights, cam, partition: 'adaptive', ...opts });
  return { scenario: scenarioName, fixed, adaptive, opts };
}

// Smallest total index budget at which a partition still publishes a complete,
// leak-free frame under the fixed capacity/global budget. Reported as a bound so
// the doc can say "adaptive needs >= X slots, fixed needs >= Y slots" rather than
// just observing one budget. Returns null if even the max budget is incomplete.
export function findMinIndexBudget({ lights, cam, partition, capacity, globalBudget, strategy = 'hybrid', slices = 24, hi = 262144 }) {
  const width = 320, height = 180;
  const base = { width, height, tilePixels: 20, slices, near: cam.near, far: cam.far, fovyDeg: cam.fovyDeg };
  const mats = cameraMatrices(cam, width / height);
  const { cfg } = makeExperimentCfg(base, partition, mats, cam);
  const bounds = buildClusterBounds(cfg);

  const fits = (budget) => {
    const c = assignClusters(cfg, bounds, mats.view, lights, {
      strategy, capacity, globalBudget, totalIndexBudget: budget,
    });
    return c.complete;
  };
  const full = assignClusters(cfg, bounds, mats.view, lights, {
    strategy, capacity, globalBudget, totalIndexBudget: hi,
  });
  if (!full.complete) return { minBudget: null, actualSlots: full.stats.indexSlots, impossible: full.reason };
  // Binary search the smallest budget that still completes.
  let lo = 0, high = full.stats.indexSlots;
  while (lo < high) {
    const mid = (lo + high) >> 1;
    if (fits(mid)) high = mid; else lo = mid + 1;
  }
  return { minBudget: lo, actualSlots: full.stats.indexSlots, impossible: null };
}

// Compare the boundary tables themselves so the doc can show where resolution
// moved. Returns, for each partition, the depth at each slice boundary.
export function boundaryComparison(cam, opts = {}) {
  const width = opts.width ?? 320, height = opts.height ?? 180, slices = opts.slices ?? 24;
  const base = { width, height, tilePixels: 20, slices, near: cam.near, far: cam.far, fovyDeg: cam.fovyDeg };
  const mats = cameraMatrices(cam, width / height);
  const fixedCfg = makeClusterConfig({ ...base, partition: 'fixed' });
  const { cfg: adaptiveCfg, adaptive } = makeExperimentCfg(base, 'adaptive', mats, cam);
  return {
    fixed: Array.from(fixedCfg.boundaries),
    adaptive: Array.from(adaptiveCfg.boundaries),
    adaptiveSampleCount: adaptive ? adaptive.sampleCount : 0,
  };
}

// Live UI comparison: render the all-light reference ONCE, then both partitions
// against it, so the browser panel can report error + list volume + query cost
// for the current editable light rig. Uses the same kernel and shading as
// everything else. Throws if either partition leaks.
export function comparePartitions({
  lights, cam, capacity = 24, globalBudget = 24, totalIndexBudget = 262144,
  strategy = 'hybrid', width = 320, height = 180, tilePixels = 20, slices = 24,
}) {
  const base = { width, height, tilePixels, slices, near: cam.near, far: cam.far, fovyDeg: cam.fovyDeg };
  const mats = cameraMatrices(cam, width / height);
  const common = { camMats: mats, boxes: scene(), lights, width, height };
  const ref = renderImage({ ...common, cfg: makeClusterConfig({ ...base, partition: 'fixed' }), mode: 'reference' });

  const run = (partition) => {
    const { cfg } = makeExperimentCfg(base, partition, mats, cam);
    const bounds = buildClusterBounds(cfg);
    const candidate = assignClusters(cfg, bounds, mats.view, lights, {
      strategy, capacity, globalBudget, totalIndexBudget,
    });
    const violations = checkFrameInvariants(candidate, lights);
    if (violations.length) throw new Error(`${partition} 帧校验失败: ${violations[0]}`);
    const clu = renderImage({ ...common, cfg, mode: 'clustered', frame: candidate, coverageCheck: true });
    let sumSq = 0, maxAbs = 0, samples = 0, mismatch = 0;
    for (let i = 0; i < width * height; i++) {
      const o = i * 4;
      let pixMax = 0;
      for (let c = 0; c < 3; c++) {
        const d = Math.abs(ref.rgba[o + c] - clu.rgba[o + c]);
        if (d > maxAbs) maxAbs = d;
        if (d > pixMax) pixMax = d;
        sumSq += d * d; samples++;
      }
      if (pixMax > 3) mismatch++;
    }
    const mse = sumSq / samples;
    const metrics = {
      psnr: mse < 1e-8 ? Infinity : 10 * Math.log10((255 * 255) / mse),
      maxAbs, mismatchPixels: mismatch,
      coverageMissCount: clu.coverageMissCount,
      referenceIterations: ref.totalIterations,
      clusteredIterations: clu.totalIterations,
      clusteredAvgPerPixel: clu.avgIterAll,
      clusteredMaxPerPixel: clu.maxIter,
      speedup: ref.totalIterations / Math.max(1, clu.totalIterations),
    };
    if (metrics.coverageMissCount !== 0) {
      throw new Error(`${partition} 漏光 ${metrics.coverageMissCount} 次，拒绝计入实验`);
    }
    return {
      partition, complete: candidate.complete, reason: candidate.reason,
      metrics, stats: candidate.stats,
      firstOverCapacity: firstOverCapacity(candidate),
      perSlice: perSliceSummary(candidate),
      boundaries: Array.from(cfg.boundaries),
      rgba: clu.rgba,
    };
  };

  const fixed = run('fixed');
  const adaptive = run('adaptive');

  // Difference between the two partitions' actual shaded pixels (not vs reference).
  const diff = new Uint8Array(width * height * 4);
  let diffMax = 0;
  let diffPix = 0;
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    let pixMax = 0;
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(fixed.rgba[o + c] - adaptive.rgba[o + c]);
      if (d > pixMax) pixMax = d;
    }
    if (pixMax > diffMax) diffMax = pixMax;
    if (pixMax > 3) diffPix++;
    const amp = Math.min(255, pixMax * 6);
    diff[o] = amp; diff[o + 1] = Math.floor(amp * 0.35); diff[o + 2] = Math.floor(amp * 0.9); diff[o + 3] = 255;
  }

  return {
    width, height, refIterations: ref.totalIterations,
    fixed, adaptive, diff, partitionDiffMax: diffMax, partitionDiffPixels: diffPix,
  };
}
