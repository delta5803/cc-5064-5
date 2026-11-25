// Visual iteration helper: renders larger CPU clustered previews.
//   node scripts/preview.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNightMarketLights } from '../src/core/lights.js';
import { createCamera, cameraMatrices } from '../src/core/camera.js';
import { makeClusterConfig, buildClusterBounds } from '../src/core/clusters.js';
import { assignClusters } from '../src/core/assignment.js';
import { buildNightMarket } from '../src/core/scene.js';
import { renderImage } from '../src/core/shading.js';
import { encodePNG } from './png.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'artifacts');
mkdirSync(OUT, { recursive: true });

function render(name, lights, cam, opts = {}) {
  const width = 960, height = 540;
  const cfg = makeClusterConfig({ width, height, tilePixels: 60, slices: 24, near: cam.near, far: cam.far, fovyDeg: cam.fovyDeg });
  const mats = cameraMatrices(cam, cfg.aspect);
  const bounds = buildClusterBounds(cfg);
  const frame = assignClusters(cfg, bounds, mats.view, lights, { strategy: 'hybrid', capacity: 24, globalBudget: 24, ...opts });
  const res = renderImage({ cfg, camMats: mats, boxes: buildNightMarket(), lights, frame, mode: 'clustered', width, height });
  writeFileSync(path.join(OUT, name), encodePNG(width, height, res.rgba));
  console.log(name, 'maxIter', res.maxIter, 'avg', res.avgIterAll.toFixed(1), 'complete', frame.complete);
}

render('preview-market.png', createNightMarketLights(120), createCamera());

const storyLights = createNightMarketLights(120);
for (const l of storyLights) if (l.group === 'row') l.on = false;
const hero = storyLights[0];
hero.pos = [0, 3.4, 16.2]; // pulled close to camera/near plane
hero.range = 26;
render('preview-story.png', storyLights, createCamera());

const cam2 = createCamera();
cam2.yaw = 0.5; cam2.pitch = 0.12;
render('preview-angle.png', createNightMarketLights(160), cam2);
