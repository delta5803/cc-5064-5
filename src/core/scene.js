// Night-market geometry. One authored source feeds BOTH the GPU mesh builder
// and the CPU ray/reference renderer, so comparisons use the same surfaces.

export const LAYOUT = {
  streetHalfWidth: 5,
  zNear: 16,
  zFar: -46,
  stallX: 7.4,
  stallZs: [8, 3, -2, -7, -12, -17, -22, -27, -32, -37],
  camera: { eye: [0, 7.2, 19], target: [0, 2.4, -12], fovyDeg: 60, near: 0.1, far: 160 },
};

let boxSeq = 0;
function box(min, max, color, opts = {}) {
  return {
    id: `b${boxSeq++}`,
    min,
    max,
    color,
    emissive: opts.emissive || [0, 0, 0],
    roughness: opts.roughness ?? 0.85,
    name: opts.name || '',
  };
}

// Build static geometry only. Movable light bulbs are generated separately so
// they follow the lights.
export function buildNightMarket() {
  boxSeq = 0;
  const boxes = [];
  const H = LAYOUT.streetHalfWidth;

  // Ground (top at y=0).
  boxes.push(box([-70, -1.0, -90], [70, 0.0, 45], [0.16, 0.15, 0.17], { roughness: 1, name: 'ground' }));
  // Asphalt street strip (top y=0.02).
  boxes.push(box([-H, 0.0, -50], [H, 0.02, 22], [0.10, 0.105, 0.12], { roughness: 0.95, name: 'street' }));
  // Center dashed lane markings.
  for (let z = 14; z > -46; z -= 6) {
    boxes.push(box([-0.12, 0.021, z - 1.6], [0.12, 0.03, z + 1.6], [0.55, 0.45, 0.2], { roughness: 0.6 }));
  }
  // Curbs / sidewalks.
  boxes.push(box([-H - 1.6, 0.0, -50], [-H, 0.18, 22], [0.28, 0.27, 0.3], { name: 'sidewalkL' }));
  boxes.push(box([H, 0.0, -50], [H + 1.6, 0.18, 22], [0.28, 0.27, 0.3], { name: 'sidewalkR' }));

  // Stalls on both sides.
  const canopyColors = [
    [0.55, 0.12, 0.16], [0.12, 0.35, 0.5], [0.5, 0.32, 0.08],
    [0.2, 0.42, 0.28], [0.42, 0.16, 0.42], [0.5, 0.2, 0.1],
  ];
  LAYOUT.stallZs.forEach((z, i) => {
    for (const side of [-1, 1]) {
      const x = side * LAYOUT.stallX;
      const c = canopyColors[(i + (side > 0 ? 2 : 0)) % canopyColors.length];
      // Counter.
      boxes.push(box([x - 1.7, 0.18, z - 1.1], [x + 1.7, 1.05, z + 1.1], [0.36, 0.24, 0.15], { roughness: 0.8 }));
      // Counter top cloth.
      boxes.push(box([x - 1.8, 1.05, z - 1.2], [x + 1.8, 1.18, z + 1.2], c, { roughness: 0.9 }));
      // Four posts.
      for (const dx of [-1.65, 1.65]) {
        for (const dz of [-1.05, 1.05]) {
          boxes.push(box([x + dx - 0.07, 0.18, z + dz - 0.07], [x + dx + 0.07, 3.0, z + dz + 0.07], [0.22, 0.16, 0.1]));
        }
      }
      // Striped canopy (thin slab).
      boxes.push(box([x - 2.0, 2.95, z - 1.4], [x + 2.0, 3.18, z + 1.4], c, { roughness: 0.95 }));
      // Back wall.
      boxes.push(box([x - 1.9, 0.18, z - 1.35], [x + 1.9, 2.9, z - 1.2], [0.2, 0.16, 0.14]));
      // Hanging sign / lantern block (emissive paper lantern geometry).
      const lanternColor = i % 2 ? [1.0, 0.35, 0.12] : [1.0, 0.75, 0.3];
      boxes.push(
        box([x - (side < 0 ? -1.2 : 1.2) - 0.28, 2.35, z - 0.28],
            [x - (side < 0 ? -1.2 : 1.2) + 0.28, 2.9, z + 0.28],
            [0.5, 0.2, 0.1], { emissive: lanternColor.map((v) => v * 1.6), name: 'lantern' })
      );
      // Crates / goods.
      boxes.push(box([x - 1.2, 1.18, z + 0.2], [x - 0.4, 1.6, z + 0.9], [0.45, 0.3, 0.12]));
      boxes.push(box([x + 0.3, 1.18, z - 0.8], [x + 1.1, 1.55, z - 0.1], [0.3, 0.4, 0.2]));
    }
  });

  // Distant building blocks framing the street.
  const rng = mulberry32(7);
  for (let i = 0; i < 16; i++) {
    const side = i % 2 ? 1 : -1;
    const z = 14 - Math.floor(i / 2) * 9 - rng() * 3;
    const w = 5 + rng() * 4;
    const h = 7 + rng() * 12;
    const x = side * (13 + rng() * 6);
    const col = 0.12 + rng() * 0.06;
    boxes.push(box([x - w / 2, 0, z - 3], [x + w / 2, h, z + 3], [col, col * 0.95, col * 1.15], { roughness: 1 }));
  }
  // Far gate / arch across the street at z=-40.
  boxes.push(box([-5.4, 0, -41], [-4.6, 8, -39.4], [0.3, 0.12, 0.12]));
  boxes.push(box([4.6, 0, -41], [5.4, 8, -39.4], [0.3, 0.12, 0.12]));
  boxes.push(box([-5.4, 7.2, -41], [5.4, 8.2, -39.4], [0.42, 0.16, 0.14], { emissive: [0.5, 0.12, 0.05] }));

  return boxes;
}

// Small emissive cube representing a movable light bulb.
export function lightBulbBox(light, radius = 0.15) {
  const p = light.pos;
  const r = light.bulbSize || radius;
  const e = light.on ? light.color.map((c) => c * 1.25) : [0.05, 0.05, 0.06];
  return {
    min: [p[0] - r, p[1] - r, p[2] - r],
    max: [p[0] + r, p[1] + r, p[2] + r],
    color: light.on ? light.color : [0.2, 0.2, 0.22],
    emissive: e,
    roughness: 0.4,
    bulb: true,
  };
}

// Slab ray vs AABB. Returns {t, normal} of nearest entry with t>=0, or null.
export function rayBoxIntersect(orig, dir, b) {
  let tmin = -Infinity;
  let tmax = Infinity;
  let axis = -1;
  let sign = 0;
  for (let i = 0; i < 3; i++) {
    const o = orig[i], d = dir[i];
    const lo = b.min[i], hi = b.max[i];
    if (Math.abs(d) < 1e-9) {
      if (o < lo || o > hi) return null;
    } else {
      let t1 = (lo - o) / d;
      let t2 = (hi - o) / d;
      let s = -1;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; s = 1; }
      if (t1 > tmin) { tmin = t1; axis = i; sign = s; }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }
  }
  if (tmax < 0) return null;
  let t = tmin;
  if (t < 0) { // origin inside box: use exit? treat as hit at tmax with outward flipped normal
    t = tmax;
    if (t < 0) return null;
    // find exit axis normal
    let best = -Infinity;
    for (let i = 0; i < 3; i++) {
      const d = dir[i];
      if (Math.abs(d) < 1e-9) continue;
      const plane = d > 0 ? b.max[i] : b.min[i];
      const tt = (plane - orig[i]) / d;
      if (tt > best && tt <= t + 1e-4) { best = tt; axis = i; sign = d > 0 ? 1 : -1; }
    }
    const n = [0, 0, 0];
    n[axis] = sign;
    return { t, normal: n, inside: true };
  }
  const n = [0, 0, 0];
  n[axis] = sign;
  return { t, normal: n };
}

// Intersect ray against a list of boxes; nearest hit.
export function rayScene(orig, dir, boxes) {
  let best = null;
  for (let i = 0; i < boxes.length; i++) {
    const h = rayBoxIntersect(orig, dir, boxes[i]);
    if (h && (!best || h.t < best.t)) best = { ...h, box: boxes[i], index: i };
  }
  return best;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
