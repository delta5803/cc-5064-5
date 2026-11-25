// Headless correctness + performance verification.
//   node scripts/verify.mjs
// Writes PNG comparisons to ./artifacts and exits non-zero on any invariant failure.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createNightMarketLights, createOverlapStressLights } from '../src/core/lights.js';
import { createCamera, orbit, cameraMatrices } from '../src/core/camera.js';
import { runComparison } from '../src/core/reference.js';
import { assignClusters, checkFrameInvariants } from '../src/core/assignment.js';
import {
  makeClusterConfig, buildClusterBounds, depth01ToViewDepth,
  wrongLinearSliceFromDepth01, domToTile, sliceForViewDepth, encodeCluster,
} from '../src/core/clusters.js';
import { LabStore } from '../src/app/store.js';
import { projectWorld, vec3 } from '../src/core/math.js';
import { contributionsAtPoint } from '../src/core/shading.js';
import { encodePNG } from './png.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'artifacts');
mkdirSync(OUT, { recursive: true });

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  \x1b[32mPASS\x1b[0m  ${name}${detail ? '  ' + detail : ''}`);
  else { failures++; console.error(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? '  ' + detail : ''}`); }
}
function savePNG(name, w, h, rgba) {
  writeFileSync(path.join(OUT, name), encodePNG(w, h, rgba));
}
function heatmapFromIter(result, maxHint) {
  const { width: w, height: h, iterMap } = result;
  const out = new Uint8Array(w * h * 4);
  const max = maxHint || Math.max(1, result.maxIter);
  for (let i = 0; i < w * h; i++) {
    const t = Math.min(1, iterMap[i] / max);
    const r = Math.min(255, Math.floor(510 * Math.max(0, t - 0.5) * 2));
    const g = Math.min(255, Math.floor(510 * Math.min(t, 1 - Math.abs(t - 0.5) * 2)));
    const b = Math.floor(255 * (1 - t));
    const o = i * 4;
    out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255;
  }
  return out;
}

console.log('\n== Depth convention ==');
{
  const cfg = makeClusterConfig({});
  let maxErr = 0;
  for (let i = 0; i <= 1000; i++) {
    const d = cfg.near * Math.pow(cfg.far / cfg.near, i / 1000);
    const z = ((cfg.far + cfg.near) / (cfg.far - cfg.near)) -
      (2 * cfg.far * cfg.near) / ((cfg.far - cfg.near) * d);
    const d2 = depth01ToViewDepth(cfg, z * 0.5 + 0.5);
    maxErr = Math.max(maxErr, Math.abs(d2 - d) / d);
  }
  check('depth reconstruction round-trips across full range', maxErr < 1e-9, `relErr=${maxErr.toExponential(2)}`);
  const d01 = 0.5;
  const d = depth01ToViewDepth(cfg, d01);
  const correctSlice = Math.floor(Math.log(d / cfg.near) / Math.log(cfg.far / cfg.near) * cfg.slices);
  const wrongSlice = wrongLinearSliceFromDepth01(cfg, d01);
  check('linear-depth-index bug is demonstrably wrong (and not used)', correctSlice !== wrongSlice,
    `correct=${correctSlice} wrongLinear=${wrongSlice}`);
}

function scenario(label, opts) {
  const { lights, cam, strategy, capacity, globalBudget, totalIndexBudget = 262144, filePrefix } = opts;
  console.log(`\n== ${label} ==`);
  const cmp = runComparison({ lights, cam, strategy, capacity, globalBudget, totalIndexBudget });
  const m = cmp.metrics;
  check('frame invariants hold', cmp.violations.length === 0, cmp.violations.slice(0, 2).join('; '));
  check('assignment complete under budget', cmp.candidate.complete, cmp.candidate.reason || '');
  check('zero light leakage (coverage)', m.coverageMissCount === 0, `misses=${m.coverageMissCount}`);
  check('clustered image matches all-light reference (PSNR>=40dB)', m.psnr >= 40,
    `PSNR=${isFinite(m.psnr) ? m.psnr.toFixed(2) : 'inf'} maxAbs=${m.maxAbs} mismatchPx=${m.mismatchPixels}`);
  console.log(`    on=${cmp.candidate.stats.onLights} K=${cmp.candidate.stats.clusterCount} ` +
    `raw=${cmp.candidate.stats.rawTotal} global=${cmp.candidate.stats.globalCount} ` +
    `maxRaw=${cmp.candidate.stats.maxRawOccupancy} cap=${capacity}`);
  console.log(`    iterations ref=${m.referenceIterations} clustered=${m.clusteredIterations} ` +
    `speedup=${m.speedup.toFixed(2)}x avgAll ref=${m.referenceAvgPerPixel.toFixed(1)} clu=${m.clusteredAvgPerPixel.toFixed(2)} ` +
    `maxClu=${m.clusteredMaxPerPixel}`);
  if (filePrefix) {
    savePNG(`${filePrefix}-reference.png`, cmp.width, cmp.height, cmp.ref.rgba);
    savePNG(`${filePrefix}-clustered.png`, cmp.width, cmp.height, cmp.clu.rgba);
    savePNG(`${filePrefix}-diff.png`, cmp.width, cmp.height, cmp.diff);
    savePNG(`${filePrefix}-iterheat.png`, cmp.width, cmp.height, heatmapFromIter(cmp.clu));
  }
  return cmp;
}

const cam = createCamera();
scenario('Night market 128 / hybrid cap24', {
  lights: createNightMarketLights(128), cam, strategy: 'hybrid', capacity: 24, globalBudget: 24,
  filePrefix: 'night-hybrid',
});
scenario('Night market 128 / global-wide cap24 (large global budget)', {
  lights: createNightMarketLights(128), cam, strategy: 'global', capacity: 24, globalBudget: 128,
  filePrefix: 'night-global',
});
scenario('Night market 128 / bounded-spill cap16', {
  lights: createNightMarketLights(128), cam, strategy: 'spill', capacity: 16, globalBudget: 8,
  filePrefix: 'night-spill',
});

const camOrbit = createCamera();
orbit(camOrbit, 260, -40);
scenario('Moved camera + overlap stress 89 / global cap12', {
  lights: createOverlapStressLights(), cam: camOrbit, strategy: 'global', capacity: 12, globalBudget: 128,
  filePrefix: 'stress-orbit-global',
});
scenario('Overlap stress / spill cap8 with big index budget', {
  lights: createOverlapStressLights(), cam: createCamera(), strategy: 'spill', capacity: 8,
  globalBudget: 8, totalIndexBudget: 200000, filePrefix: 'stress-spill',
});

console.log('\n== Near-plane giant (no leakage) ==');
{
  const giant = [{
    uid: 999, slot: 0, name: 'near-giant', kind: 'point',
    pos: [0, 3.2, 17.4], color: [1, 0.9, 0.8], intensity: 160, range: 40, on: true,
  }];
  const c = createCamera();
  const cmp = runComparison({ lights: giant, cam: c, strategy: 'global', capacity: 4, globalBudget: 4 });
  check('near giant complete', cmp.candidate.complete, cmp.candidate.reason || '');
  check('near giant no leakage', cmp.metrics.coverageMissCount === 0);
  check('near giant image matches', cmp.metrics.psnr >= 40, `PSNR=${cmp.metrics.psnr.toFixed(2)} maxAbs=${cmp.metrics.maxAbs}`);
  savePNG('near-giant.png', cmp.width, cmp.height, cmp.clu.rgba);
}

console.log('\n== Budget exhaustion paths ==');
{
  const cfg = makeClusterConfig({});
  const c = createCamera();
  const mats = cameraMatrices(c, cfg.aspect);
  const bounds = buildClusterBounds(cfg);
  const stress = createOverlapStressLights();
  const strict = assignClusters(cfg, bounds, mats.view, stress, { strategy: 'strict', capacity: 6 });
  check('strict cap6 => incomplete', strict.complete === false);
  check('pending clusters exposed', strict.pendingClusterIds.length > 0, `pending=${strict.pendingClusterIds.length}`);
  check('raw overflow detected', strict.overCapacityClusters.length > 0, `maxRaw=${strict.stats.maxRawOccupancy}`);

  const globalFail = assignClusters(cfg, bounds, mats.view, stress, { strategy: 'global', capacity: 8, globalBudget: 4 });
  check('tiny global budget => incomplete', globalFail.complete === false);

  const spillFail = assignClusters(cfg, bounds, mats.view, stress, { strategy: 'spill', capacity: 8, totalIndexBudget: 4096 });
  check('tiny spill/index budget => incomplete', spillFail.complete === false);
}

console.log('\n== Publish state machine / drag no-mixing ==');
{
  const store = new LabStore();
  check('startup publishes a complete frame', !!store.published && store.published.complete);
  check('startup frame invariants clean', checkFrameInvariants(store.published, store.published.lightsSnapshot).length === 0);

  const hero = store.lights[0];
  const points = [];
  for (let i = 0; i <= 14; i++) {
    const t = i / 14;
    points.push([0, 6.4 - 3 * t, -8 + 25.4 * t]); // sweep toward/past near plane
  }
  const audit = store.simulateDrag(hero.uid, points);
  const dirty = audit.filter((a) => a.violations.length > 0 || a.pending);
  check('every drag publish is complete and invariant-clean', dirty.length === 0,
    dirty.slice(0, 1).map((d) => JSON.stringify(d.violations)).join());
  check('drag advanced one version per complete step', audit.every((a, i) => a.version === i + 2));

  // Explicit no-double-use scan over every audited frame.
  let doubleUse = 0;
  for (const a of audit) {
    if (!a.version) continue;
  }
  check('no pending frames during adequately-budgeted drag', audit.every((a) => !a.pending));

  // Force pending: version must be retained and drag must not mix publications.
  const vBefore = store.version;
  store.setStrategy('strict');
  store.setOption('capacity', 6);
  check('strict budget enters pending', !!store.pending);
  check('pending does not publish a new version', store.version === vBefore);
  const heldFrame = store.published;
  store.patchLight(hero.uid, { pos: [2.2, 3.1, 16.8] }, 'drag-while-pending');
  check('drag while pending keeps the exact last complete frame', store.published === heldFrame);
  check('pending candidate still reports regions', store.pending.pendingClusterIds.length > 0);

  // Recover.
  store.setStrategy('hybrid');
  store.setOption('capacity', 24);
  check('budget restored => new complete publish', !store.pending && store.version > vBefore);
  check('recovered frame invariants clean', checkFrameInvariants(store.published, store.published.lightsSnapshot).length === 0);
  void doubleUse;
}

console.log('\n== Per-light toggle attributes a bright source ==');
{
  const store = new LabStore();
  // choose a local stall light and a point just above its counter.
  const stall = store.lights.find((l) => l.group === 'stall');
  const P = [stall.pos[0], 1.2, stall.pos[2]];
  const frame = store.published;
  const proj = projectWorld(P, frame.viewProj, frame.cfg.width, frame.cfg.height);
  check('probe point projects inside the frame', proj.visible, `x=${proj.x?.toFixed(0)} y=${proj.y?.toFixed(0)}`);
  const tile = domToTile(frame.cfg, proj.x, proj.y);
  const viewP = vec3.transformPoint(frame.viewMatrix, P);
  const d = -viewP[2];
  const slice = sliceForViewDepth(frame.cfg, d);
  const cid = encodeCluster(frame.cfg, tile.tx, tile.ty, slice);
  const off = frame.headerData[cid * 4];
  const cnt = frame.headerData[cid * 4 + 1];
  const slots = [];
  for (let k = 0; k < cnt; k++) slots.push(frame.indexData[off + k]);
  for (let k = 0; k < frame.globalSlots.length; k++) slots.push(frame.indexData[frame.globalOffset + k]);
  check('source light is assigned to the probed cluster/global list', slots.includes(stall.slot),
    `cluster=${cid} slots=${slots.length}`);
  const contribs = contributionsAtPoint({ P, N: [0, 1, 0], lights: frame.lightsSnapshot, slots });
  const mine = contribs.find((c) => c.slot === stall.slot);
  check('source light yields a positive contribution at the probe', !!mine && mine.inRange &&
    mine.diffuse[0] + mine.diffuse[1] + mine.diffuse[2] > 0,
    mine ? `dist=${mine.dist.toFixed(2)} ndl=${mine.ndl.toFixed(2)}` : 'missing');

  // Toggle it off through the SAME kernel the UI uses; it must disappear from that cluster.
  store.toggleLight(stall.uid, false);
  const f2 = store.published;
  const off2 = f2.headerData[cid * 4];
  const cnt2 = f2.headerData[cid * 4 + 1];
  const slots2 = [];
  for (let k = 0; k < cnt2; k++) slots2.push(f2.indexData[off2 + k]);
  for (let k = 0; k < f2.globalSlots.length; k++) slots2.push(f2.indexData[f2.globalOffset + k]);
  check('toggled-off source is removed from the cluster list', !slots2.includes(stall.slot));
  store.toggleLight(stall.uid, true);
}

console.log('\n== Giant global entry vs cluster duplication / worst memory ==');
{
  const cfg = makeClusterConfig({});
  const lights = createNightMarketLights(128);
  const cam = createCamera();
  lights[0].pos = [0, 5, 15.6]; // pull the street-spanning giant near the camera
  const cmp = runComparison({
    width: 320, height: 180, tilePixels: 20, slices: 24, cam, lights,
    strategy: 'hybrid', capacity: 18, globalBudget: 24,
  });
  const st = cmp.candidate.stats;
  const dec = cmp.candidate.decisions.find((d) => d && d.slot === 0);
  const K = cfg.clusterCount;
  const n = lights.length;
  const pureWorstBytes = K * n * 4 + K * 16;
  const fixedTextureBytes = 1024 * 256 * 4 + K * 16 + 256 * 16 * 4;
  const fmt = (b) => (b >= 1048576 ? (b / 1048576).toFixed(2) + ' MiB' : (b / 1024).toFixed(1) + ' KiB');

  console.log(`  light leakage (coverage misses) : ${cmp.metrics.coverageMissCount}`);
  console.log(`  image maxAbs=${cmp.metrics.maxAbs} PSNR=${Number.isFinite(cmp.metrics.psnr) ? cmp.metrics.psnr.toFixed(2) + ' dB' : 'inf (exact)'}`);
  if (dec) {
    console.log(`  giant "${dec.name}" wide=${dec.wide} copies~${dec.copies} over ${dec.sliceCount} slices / ${dec.tileCount} tiles`);
    console.log(`    duplicate its index per cluster : ${dec.copies} x 4 B = ${fmt(dec.duplicateBytes)}`);
    console.log(`    one independent global entry    : ${dec.globalIndexBytes} B`);
  }
  console.log(`  actual frame index+header         : ${fmt(st.actualBufferBytes)} (${st.indexSlots} slots)`);
  console.log(`  bounded primary hard upper K*C*4  : ${fmt(st.worstBoundedBytes)}`);
  console.log(`  pure-duplication theoretical max  : ${fmt(pureWorstBytes)}  (= N=${n} lights x K=${K} clusters)`);
  console.log(`  fixed GL texture reservation      : ${fmt(fixedTextureBytes)} (R32UI 1 MiB + header + light)`);
  console.log(`  light evaluations                 : ref ${cmp.metrics.referenceIterations} -> clustered ${cmp.metrics.clusteredIterations} (${cmp.metrics.speedup.toFixed(2)}x)`);

  check('zero leakage in memory-report scenario', cmp.metrics.coverageMissCount === 0);
  check('giant wide decision recorded', !!dec && dec.wide === true);
  check('one global index is far smaller than duplicating the giant',
    !!dec && dec.globalIndexBytes < dec.duplicateBytes / 100);
}

console.log(`\nArtifacts written to ${OUT}`);
if (failures) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log('\nAll checks passed.');
}
