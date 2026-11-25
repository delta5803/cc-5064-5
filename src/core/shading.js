// Shared lighting model + CPU renderer. The GLSL shader mirrors evaluateLight()
// and toneMap() exactly. The CPU path can shade either by brute-force all lights
// (reference) or by the kernel's cluster lists, enabling image/count comparison.

import { clamp, saturate, smoothstep, vec3 } from './math.js';
import { rayScene, lightBulbBox } from './scene.js';
import { tileFromFragCoord, sliceForViewDepth, encodeCluster } from './clusters.js';

export const EXPOSURE = 1.0;

export function prepLight(light) {
  if (light.__preppedFor === light.uid) return light;
  const d = light.dir || [0, -1, 0];
  const n = vec3.normalize(d);
  light.__dir = n;
  const inner = ((light.innerDeg ?? 24) * Math.PI) / 180;
  const outer = ((light.outerDeg ?? 42) * Math.PI) / 180;
  light.__cosInner = Math.cos(inner);
  light.__cosOuter = Math.cos(outer);
  light.__preppedFor = light.uid;
  return light;
}

// Detailed per-light evaluation. Returns zeros with inRange=false when outside.
export function evaluateLight(light, P, N, V) {
  prepLight(light);
  const lx = light.pos[0] - P[0];
  const ly = light.pos[1] - P[1];
  const lz = light.pos[2] - P[2];
  let dist = Math.sqrt(lx * lx + ly * ly + lz * lz);
  const range = light.range;
  if (!(dist < range) || !light.on) {
    return { inRange: false, dist, diffuse: [0, 0, 0], specular: [0, 0, 0], ndl: 0, attenuation: 0, cone: 0 };
  }
  if (dist < 1e-4) dist = 1e-4;
  const L = [lx / dist, ly / dist, lz / dist];
  const ndl = Math.max(0, N[0] * L[0] + N[1] * L[1] + N[2] * L[2]);

  const rr = dist / range;
  let q = 1 - rr * rr * rr * rr;
  q = clamp(q, 0, 1);
  const attenuation = (q * q) / (dist * dist + 3);

  let cone = 1;
  if (light.kind === 'spot') {
    // Light emits along __dir; fragment-to-light is L, so light-to-fragment is -L.
    const theta = light.__dir[0] * -L[0] + light.__dir[1] * -L[1] + light.__dir[2] * -L[2];
    cone = smoothstep(light.__cosOuter, light.__cosInner, theta);
  }

  const intensity = light.intensity * attenuation * cone;
  const radiance = [light.color[0] * intensity, light.color[1] * intensity, light.color[2] * intensity];

  const H = vec3.normalize([L[0] + V[0], L[1] + V[1], L[2] + V[2]]);
  const ndh = Math.max(0, N[0] * H[0] + N[1] * H[1] + N[2] * H[2]);
  const spec = Math.pow(ndh, 42) * 0.35;

  return {
    inRange: true,
    dist,
    ndl,
    attenuation,
    cone,
    radiance,
    diffuse: [radiance[0] * ndl, radiance[1] * ndl, radiance[2] * ndl],
    specular: [radiance[0] * spec, radiance[1] * spec, radiance[2] * spec],
  };
}

export function hemisphere(N) {
  const t = clamp(N[1] * 0.5 + 0.5, 0, 1);
  const ground = [0.045, 0.038, 0.05];
  const sky = [0.13, 0.16, 0.27];
  return [
    ground[0] + (sky[0] - ground[0]) * t,
    ground[1] + (sky[1] - ground[1]) * t,
    ground[2] + (sky[2] - ground[2]) * t,
  ];
}

export function acesFilm(x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0, 1);
}

export function encodeColor(hdr, exposure = EXPOSURE) {
  const r = acesFilm(hdr[0] * exposure);
  const g = acesFilm(hdr[1] * exposure);
  const b = acesFilm(hdr[2] * exposure);
  return [
    Math.round(Math.pow(saturate(r), 1 / 2.2) * 255),
    Math.round(Math.pow(saturate(g), 1 / 2.2) * 255),
    Math.round(Math.pow(saturate(b), 1 / 2.2) * 255),
  ];
}

function hash2(x, y) {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

export function skyColor(dir, px, py) {
  const t = clamp(dir[1] * 0.5 + 0.55, 0, 1);
  let r = 0.012 + 0.02 * (1 - t);
  let g = 0.016 + 0.022 * (1 - t);
  let b = 0.04 + 0.05 * (1 - t);
  // deterministic stars
  if (dir[1] > 0.05) {
    const s = hash2(px, py);
    if (s > 0.9975) {
      const k = (s - 0.9975) / 0.0025;
      r += k * 0.7; g += k * 0.75; b += k * 0.9;
    }
  }
  return [r, g, b];
}

function applyFog(col, dist) {
  const f = smoothstep(30, 95, dist);
  const fog = [0.018, 0.022, 0.04];
  return [
    col[0] * (1 - f) + fog[0] * f,
    col[1] * (1 - f) + fog[1] * f,
    col[2] * (1 - f) + fog[2] * f,
  ];
}

// Resolve the light slots visited for one pixel under a published frame.
export function clusteredSlotsForPixel(frame, cfg, viewMatrix, P, px, pyTop, width, height) {
  const vp = [
    viewMatrix[0] * P[0] + viewMatrix[4] * P[1] + viewMatrix[8] * P[2] + viewMatrix[12],
    viewMatrix[1] * P[0] + viewMatrix[5] * P[1] + viewMatrix[9] * P[2] + viewMatrix[13],
    viewMatrix[2] * P[0] + viewMatrix[6] * P[1] + viewMatrix[10] * P[2] + viewMatrix[14],
  ];
  const d = -vp[2];
  const fx = px + 0.5;
  const fy = height - pyTop - 0.5;
  const { tx, ty } = tileFromFragCoord({ ...cfg, width, height }, fx, fy);
  // NOTE: tile grid counts derive from the RENDER cfg; callers pass a matching cfg
  // whose width/height equal `width/height`. We still recompute cols/rows below.
  const slice = sliceForViewDepth(cfg, d);
  const id = encodeCluster(cfg, tx, ty, slice);
  const offset = frame.headerData[id * 4];
  const count = frame.headerData[id * 4 + 1];
  const locals = [];
  for (let k = 0; k < count; k++) locals.push(frame.indexData[offset + k]);
  const globals = [];
  for (let k = 0; k < frame.globalSlots.length; k++) globals.push(frame.indexData[frame.globalOffset + k]);
  return { id, tx, ty, slice, viewDepth: d, locals, globals, all: locals.concat(globals) };
}

// Render an image. mode: 'reference' | 'clustered'.
export function renderImage(args) {
  const {
    cfg, camMats, boxes: staticBoxes, lights, frame = null,
    mode = 'reference', width, height,
    includeBulbs = true, coverageCheck = false,
  } = args;

  for (const l of lights) prepLight(l);
  const bulbBoxes = includeBulbs ? lights.filter((l) => l.on).map((l) => lightBulbBox(l)) : [];
  const boxes = staticBoxes.concat(bulbBoxes);

  const rgba = new Uint8Array(width * height * 4);
  const iterMap = new Uint32Array(width * height);
  const fullEvalMap = new Uint32Array(width * height);
  let totalIterations = 0;
  let totalFullEvals = 0;
  let shadedPixels = 0;
  let maxIter = 0;
  const coverageMisses = [];
  let coverageMissCount = 0;

  const tanY = Math.tan((cfg.fovyDeg * Math.PI) / 360);

  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const pi = py * width + px;
      const nx = ((px + 0.5) / width) * 2 - 1;
      const ny = 1 - ((py + 0.5) / height) * 2;
      const dxv = nx * tanY * cfg.aspect;
      const dyv = ny * tanY;
      const m = camMats.invView;
      let dx = m[0] * dxv + m[4] * dyv + m[8] * -1;
      let dy = m[1] * dxv + m[5] * dyv + m[9] * -1;
      let dz = m[2] * dxv + m[6] * dyv + m[10] * -1;
      const rl = Math.hypot(dx, dy, dz) || 1;
      const dir = [dx / rl, dy / rl, dz / rl];
      const orig = camMats.eye;

      const hit = rayScene(orig, dir, boxes);
      let hdr;
      let iterations = 0;
      let fullEvals = 0;

      if (!hit) {
        hdr = skyColor(dir, px, py);
      } else {
        shadedPixels++;
        const P = [orig[0] + dir[0] * hit.t, orig[1] + dir[1] * hit.t, orig[2] + dir[2] * hit.t];
        const N = hit.normal;
        const V = [-dir[0], -dir[1], -dir[2]];
        const albedo = hit.box.color;
        const emissive = hit.box.emissive || [0, 0, 0];
        const hemi = hemisphere(N);

        let slots;
        let clusterInfo = null;
        if (mode === 'reference') {
          slots = [];
          for (let i = 0; i < lights.length; i++) if (lights[i].on) slots.push(i);
        } else {
          clusterInfo = clusteredSlotsForPixel(frame, cfg, camMats.view, P, px, py, width, height);
          slots = clusterInfo.all;
        }
        iterations = slots.length;

        let ar = hemi[0] * 0.5, ag = hemi[1] * 0.5, ab = hemi[2] * 0.5;
        let sr = 0, sg = 0, sb = 0;
        for (const slot of slots) {
          const L = lights[slot];
          if (!L || !L.on) continue;
          const e = evaluateLight(L, P, N, V);
          if (!e.inRange) continue;
          fullEvals++;
          ar += e.diffuse[0]; ag += e.diffuse[1]; ab += e.diffuse[2];
          sr += e.specular[0]; sg += e.specular[1]; sb += e.specular[2];
        }

        if (coverageCheck && mode === 'clustered') {
          const selected = new Set(slots);
          for (let i = 0; i < lights.length; i++) {
            const L = lights[i];
            if (!L.on) continue;
            const d = vec3.distance(L.pos, P);
            if (d < L.range && !selected.has(i)) {
              coverageMissCount++;
              if (coverageMisses.length < 8) {
                coverageMisses.push({ px, py, slot: i, name: L.name, dist: d, range: L.range, cluster: clusterInfo && clusterInfo.id });
              }
            }
          }
        }

        let linR = emissive[0] + albedo[0] * ar + sr;
        let linG = emissive[1] + albedo[1] * ag + sg;
        let linB = emissive[2] + albedo[2] * ab + sb;
        [linR, linG, linB] = applyFog([linR, linG, linB], hit.t);
        hdr = [linR, linG, linB];
      }

      const enc = encodeColor(hdr);
      const o = pi * 4;
      rgba[o] = enc[0]; rgba[o + 1] = enc[1]; rgba[o + 2] = enc[2]; rgba[o + 3] = 255;
      iterMap[pi] = iterations;
      fullEvalMap[pi] = fullEvals;
      totalIterations += iterations;
      totalFullEvals += fullEvals;
      if (iterations > maxIter) maxIter = iterations;
    }
  }

  return {
    width, height, rgba, iterMap, fullEvalMap,
    totalIterations, totalFullEvals, shadedPixels,
    maxIter,
    avgIterAll: totalIterations / (width * height),
    avgIterShaded: shadedPixels ? totalIterations / shadedPixels : 0,
    coverageMissCount, coverageMisses,
  };
}

// Per-light contribution breakdown at a world point (inspector panel).
export function contributionsAtPoint({ P, N = [0, 1, 0], V = [0, 0, 1], lights, slots, frame = null }) {
  const list = [];
  const useSlots = slots || (frame ? frame.globalSlots : lights.map((_, i) => i));
  for (const slot of useSlots) {
    const L = lights[slot];
    if (!L) continue;
    const e = evaluateLight(L, P, N, V);
    list.push({
      slot, uid: L.uid, name: L.name, color: L.color, on: L.on, kind: L.kind,
      dist: e.dist, inRange: e.inRange, ndl: e.ndl, attenuation: e.attenuation, cone: e.cone,
      radiance: e.radiance, diffuse: e.diffuse,
    });
  }
  list.sort((a, b) => (b.diffuse[0] + b.diffuse[1] + b.diffuse[2]) - (a.diffuse[0] + a.diffuse[1] + a.diffuse[2]));
  return list;
}
