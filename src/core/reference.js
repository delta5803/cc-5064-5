// High-level brute-force-reference vs clustered comparison.
// Usable both in the browser (returns RGBA buffers) and in Node verification.

import { makeClusterConfig, buildClusterBounds } from './clusters.js';
import { cameraMatrices } from './camera.js';
import { assignClusters, checkFrameInvariants } from './assignment.js';
import { buildNightMarket } from './scene.js';
import { renderImage } from './shading.js';

let SCENE_BOXES = null;
export function sceneBoxes() {
  if (!SCENE_BOXES) SCENE_BOXES = buildNightMarket();
  return SCENE_BOXES;
}

export function runComparison(args = {}) {
  const {
    width = 400,
    height = 225,
    tilePixels = 25,
    slices = 24,
    cam,
    lights,
    strategy = 'global',
    capacity = 24,
    globalBudget = 48,
    totalIndexBudget = 65536,
    wideThresholdClusters = 220,
    wideThresholdSlices = 10,
    checkCoverage = true,
  } = args;

  const cfg = makeClusterConfig({
    width, height, tilePixels, slices,
    near: cam.near, far: cam.far, fovyDeg: cam.fovyDeg,
  });
  const mats = cameraMatrices(cam, cfg.aspect);
  const bounds = buildClusterBounds(cfg);
  const candidate = assignClusters(cfg, bounds, mats.view, lights, {
    capacity, strategy, globalBudget, totalIndexBudget,
    wideThresholdClusters, wideThresholdSlices,
  });
  const violations = checkFrameInvariants(candidate, lights);

  const common = {
    cfg, camMats: mats, boxes: sceneBoxes(), lights,
    width, height,
  };
  const ref = renderImage({ ...common, mode: 'reference' });
  const clu = renderImage({
    ...common, mode: 'clustered', frame: candidate,
    coverageCheck: checkCoverage,
  });

  // Difference image + metrics on encoded LDR pixels.
  const diff = new Uint8Array(width * height * 4);
  let sumSq = 0;
  let maxAbs = 0;
  let sumAbs = 0;
  let samples = 0;
  let mismatchPixels = 0;
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    let pixMax = 0;
    for (let c = 0; c < 3; c++) {
      const a = ref.rgba[o + c];
      const b = clu.rgba[o + c];
      const d = Math.abs(a - b);
      if (d > maxAbs) maxAbs = d;
      if (d > pixMax) pixMax = d;
      sumAbs += d;
      sumSq += d * d;
      samples++;
    }
    if (pixMax > 3) mismatchPixels++;
    const amp = Math.min(255, pixMax * 6);
    diff[o] = amp; diff[o + 1] = Math.floor(amp * 0.35); diff[o + 2] = Math.floor(amp * 0.9); diff[o + 3] = 255;
  }
  const mse = sumSq / samples;
  const psnr = mse < 1e-8 ? Infinity : 10 * Math.log10((255 * 255) / mse);
  const meanAbs = sumAbs / samples;

  return {
    width, height, cfg, candidate, violations, mats,
    ref, clu, diff,
    metrics: {
      psnr, mse, maxAbs, meanAbs, mismatchPixels,
      totalPixels: width * height,
      coverageMissCount: clu.coverageMissCount,
      coverageMisses: clu.coverageMisses,
      referenceIterations: ref.totalIterations,
      clusteredIterations: clu.totalIterations,
      referenceAvgPerPixel: ref.avgIterAll,
      clusteredAvgPerPixel: clu.avgIterAll,
      speedup: ref.totalIterations / Math.max(1, clu.totalIterations),
      referenceMaxPerPixel: lights.filter((l) => l.on).length,
      clusteredMaxPerPixel: clu.maxIter,
      refFullEvals: ref.totalFullEvals,
      cluFullEvals: clu.totalFullEvals,
    },
  };
}
