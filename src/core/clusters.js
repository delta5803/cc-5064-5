// Cluster grid + depth conventions.
//
// COORDINATE CONTRACT (must match shaders/light upload exactly):
//  * World space: right handed, Y up.
//  * View space : camera looks down -Z. Visible geometry has zView in [-far,-near],
//                 and positive forward depth is `d = -zView`.
//  * Depth buffer is the standard OpenGL perspective depth in [0,1] (NON-LINEAR in d).
//                 Therefore a raw depth value must NEVER be multiplied by slice count
//                 directly. We first reconstruct linear view depth with the inverse
//                 perspective formula, then map that depth to an exponential slice.
//  * Tiles use a BOTTOM-LEFT origin so they line up with gl_FragCoord.xy / tilePixels.
//                 DOM/canvas coordinates are top-left and are flipped by domToTile().
//  * Cluster id  : id = ((slice * rows + tileY) * cols + tileX).

import { clamp } from './math.js';

// Upper bound of depth slices supported by the shader's uniform boundary table.
export const MAX_SLICES = 40;

// The fixed partition: exponentially spaced boundaries, boundary(0)=near,
// boundary(slices)=far. This is the original scheme and the default table.
export function exponentialBoundaries(near, far, slices) {
  const b = new Float32Array(slices + 1);
  for (let k = 0; k <= slices; k++) b[k] = near * Math.pow(far / near, k / slices);
  b[0] = near;
  b[slices] = far;
  return b;
}

export function makeClusterConfig(opts = {}) {
  const width = opts.width ?? 1280;
  const height = opts.height ?? 720;
  const tilePixels = opts.tilePixels ?? 80;
  const slices = clamp(Math.round(opts.slices ?? 24), 1, MAX_SLICES);
  const near = opts.near ?? 0.1;
  const far = opts.far ?? 140;
  const fovyDeg = opts.fovyDeg ?? 60;
  const cols = Math.max(1, Math.ceil(width / tilePixels));
  const rows = Math.max(1, Math.ceil(height / tilePixels));
  const partition = opts.partition === 'adaptive' ? 'adaptive' : 'fixed';
  let boundaries;
  if (opts.boundaries) {
    if (opts.boundaries.length !== slices + 1) {
      throw new Error(`boundaries length ${opts.boundaries.length} != slices+1 (${slices + 1})`);
    }
    boundaries = Float32Array.from(opts.boundaries);
    boundaries[0] = near;
    boundaries[slices] = far;
  } else {
    boundaries = exponentialBoundaries(near, far, slices);
  }
  return {
    width,
    height,
    tilePixels,
    slices,
    near,
    far,
    fovyDeg,
    fovyRad: (fovyDeg * Math.PI) / 180,
    aspect: width / height,
    cols,
    rows,
    clusterCount: cols * rows * slices,
    partition,
    // Depth boundary table shared by the CPU kernel AND the shader. The fixed
    // scheme fills this with exponential values; the adaptive scheme fills it
    // with visible-depth quantiles. Everything downstream consumes this table,
    // so both schemes run through the SAME shader path.
    boundaries,
  };
}

// Depth boundary for slice k (k = 0..slices) from the active table.
export function depthBoundary(cfg, k) {
  if (cfg.boundaries) return cfg.boundaries[clamp(k | 0, 0, cfg.slices)];
  return cfg.near * Math.pow(cfg.far / cfg.near, k / cfg.slices);
}

// Inverse of the mat4.perspective() used here. Converts hardware depth [0,1]
// (gl_FragCoord.z) to positive view-space depth d = -zView.
//
// Derivation for the OpenGL perspective matrix:
//   zNdc = (far+near)/(far-near) - 2*far*near / ((far-near)*d)
//   d    = 2*near*far / ((far+near) - zNdc*(far-near))
export function depth01ToViewDepth(cfg, depth01) {
  const zNdc = depth01 * 2 - 1;
  const num = 2 * cfg.near * cfg.far;
  const den = cfg.far + cfg.near - zNdc * (cfg.far - cfg.near);
  return num / den;
}

// Forward counterpart: positive view depth -> hardware depth [0,1].
export function viewDepthToDepth01(cfg, d) {
  const zNdc =
    (cfg.far + cfg.near) / (cfg.far - cfg.near) -
    (2 * cfg.far * cfg.near) / ((cfg.far - cfg.near) * d);
  return zNdc * 0.5 + 0.5;
}

// Map a positive view depth to a slice index using the active boundary table.
// Depths closer than near go to slice 0; depths at/beyond far go to the last slice.
// Binary search keeps adaptive (non-uniform) tables correct and cheap.
export function sliceForViewDepth(cfg, d) {
  if (!(d > cfg.near)) return 0; // also handles d <= 0 / NaN defensively
  if (d >= cfg.far) return cfg.slices - 1;
  const b = cfg.boundaries;
  if (!b) {
    const t = (Math.log(d / cfg.near) / Math.log(cfg.far / cfg.near)) * cfg.slices;
    return clamp(Math.floor(t), 0, cfg.slices - 1);
  }
  // Find the last boundary <= d: boundaries are strictly increasing.
  let lo = 0;
  let hi = cfg.slices;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (b[mid + 1] <= d) lo = mid + 1;
    else hi = mid;
  }
  return clamp(lo, 0, cfg.slices - 1);
}

// WRONG on purpose reference: indexing slices with the non-linear depth value.
// Exported so tests/UI can demonstrate why it must not be used.
export function wrongLinearSliceFromDepth01(cfg, depth01) {
  return clamp(Math.floor(depth01 * cfg.slices), 0, cfg.slices - 1);
}

export function encodeCluster(cfg, tx, ty, s) {
  return (s * cfg.rows + ty) * cfg.cols + tx;
}

export function decodeCluster(cfg, id) {
  const tx = id % cfg.cols;
  const q = (id - tx) / cfg.cols;
  const ty = q % cfg.rows;
  const s = (q - ty) / cfg.rows;
  return { tx, ty, s, id };
}

// gl_FragCoord.xy (bottom-left origin) -> tile coords.
export function tileFromFragCoord(cfg, fx, fy) {
  const tx = clamp(Math.floor(fx / cfg.tilePixels), 0, cfg.cols - 1);
  const ty = clamp(Math.floor(fy / cfg.tilePixels), 0, cfg.rows - 1);
  return { tx, ty };
}

// DOM / canvas pointer coordinates (top-left origin, in cfg.width/height pixels)
// -> bottom-left tile coords.
export function domToTile(cfg, pxFromLeft, pyFromTop) {
  const tx = clamp(Math.floor(pxFromLeft / cfg.tilePixels), 0, cfg.cols - 1);
  const fy = cfg.height - pyFromTop;
  const ty = clamp(Math.floor(fy / cfg.tilePixels), 0, cfg.rows - 1);
  return { tx, ty };
}

// DOM rectangle (in cfg pixel space, top-left origin) of a bottom-left tile.
export function tileDomRect(cfg, tx, ty) {
  const T = cfg.tilePixels;
  const bottom = ty * T;
  const top = Math.min((ty + 1) * T, cfg.height);
  return { x: tx * T, y: cfg.height - top, w: Math.min(T, cfg.width - tx * T), h: top - bottom };
}

// Build conservative view-space AABBs for every cluster.
// Flat arrays: min[3*id+0..2], max[3*id+0..2].
export function buildClusterBounds(cfg) {
  const K = cfg.clusterCount;
  const mn = new Float64Array(K * 3);
  const mx = new Float64Array(K * 3);
  const tanY = Math.tan(cfg.fovyRad / 2);
  const tanX = tanY * cfg.aspect;
  const T = cfg.tilePixels;

  for (let s = 0; s < cfg.slices; s++) {
    const dNear = depthBoundary(cfg, s);
    const dFar = depthBoundary(cfg, s + 1);
    for (let ty = 0; ty < cfg.rows; ty++) {
      // bottom-left origin pixel edges in Y.
      const ybNdc0 = (2 * (ty * T)) / cfg.height - 1;
      const ybNdc1 = (2 * Math.min((ty + 1) * T, cfg.height)) / cfg.height - 1;
      for (let tx = 0; tx < cfg.cols; tx++) {
        const xNdc0 = (2 * (tx * T)) / cfg.width - 1;
        const xNdc1 = (2 * Math.min((tx + 1) * T, cfg.width)) / cfg.width - 1;
        const id = encodeCluster(cfg, tx, ty, s);

        let minx = Infinity, miny = Infinity, minz = Infinity;
        let maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
        for (const d of [dNear, dFar]) {
          for (const nx of [xNdc0, xNdc1]) {
            for (const ny of [ybNdc0, ybNdc1]) {
              const x = nx * d * tanX;
              const y = ny * d * tanY;
              const z = -d;
              if (x < minx) minx = x; if (x > maxx) maxx = x;
              if (y < miny) miny = y; if (y > maxy) maxy = y;
              if (z < minz) minz = z; if (z > maxz) maxz = z;
            }
          }
        }
        mn[id * 3] = minx; mn[id * 3 + 1] = miny; mn[id * 3 + 2] = minz;
        mx[id * 3] = maxx; mx[id * 3 + 1] = maxy; mx[id * 3 + 2] = maxz;
      }
    }
  }
  return { min: mn, max: mx };
}

// Conservative sphere-vs-AABB test. A small radius padding makes the inclusion
// robust to float rounding. The AABB itself already over-approximates the
// frustum cell, so this test can only over-assign, never miss a light.
export function sphereTouchesAABB(center, radius, bmin, bmax, id, pad = 1e-3) {
  const r = radius + pad;
  const cx = center[0], cy = center[1], cz = center[2];
  const i3 = id * 3;
  const dx = Math.max(bmin[i3] - cx, 0, cx - bmax[i3]);
  const dy = Math.max(bmin[i3 + 1] - cy, 0, cy - bmax[i3 + 1]);
  const dz = Math.max(bmin[i3 + 2] - cz, 0, cz - bmax[i3 + 2]);
  return dx * dx + dy * dy + dz * dz <= r * r;
}

// Enumerate every cluster touched by a view-space sphere.
export function enumerateLightClusters(cfg, bounds, viewCenter, radius) {
  const ids = [];
  for (let id = 0; id < cfg.clusterCount; id++) {
    if (sphereTouchesAABB(viewCenter, radius, bounds.min, bounds.max, id)) ids.push(id);
  }
  return ids;
}

// Cheap analytic slice span for a view sphere, useful for stats / early reject.
export function sphereSliceSpan(cfg, viewCenter, radius) {
  const d = -viewCenter[2];
  const d0 = Math.max(cfg.near, d - radius);
  const d1 = Math.max(cfg.near, d + radius);
  return {
    s0: sliceForViewDepth(cfg, d0),
    s1: sliceForViewDepth(cfg, d1),
  };
}
