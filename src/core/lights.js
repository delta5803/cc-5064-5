// Light construction + the procedural night-market population.
// `slot` is the stable integer index used inside a published frame / UBO.

import { LAYOUT, mulberry32 } from './scene.js';

let uidSeq = 1;
export function resetUid() { uidSeq = 1; }

export function makeLight(p = {}) {
  const kind = p.kind === 'spot' ? 'spot' : 'point';
  return {
    uid: p.uid ?? uidSeq++,
    slot: p.slot ?? 0,
    name: p.name ?? '灯',
    kind,
    pos: p.pos ? [...p.pos] : [0, 4, 0],
    color: p.color ? [...p.color] : [1, 0.8, 0.55],
    intensity: p.intensity ?? 26,
    range: p.range ?? 14,
    on: p.on !== false,
    pinnedGlobal: !!p.pinnedGlobal, // user forces the independent wide table
    wideHint: !!p.wideHint,
    innerDeg: p.innerDeg ?? 24,
    outerDeg: p.outerDeg ?? 42,
    // Spot emits along +? We aim spots downward by default.
    dir: p.dir ? [...p.dir] : [0, -1, 0],
    group: p.group ?? 'misc',
  };
}

const WARM = [1.0, 0.78, 0.5];
const TUNGSTEN = [1.0, 0.66, 0.34];
const RED = [1.0, 0.28, 0.16];
const TEAL = [0.25, 0.85, 0.95];
const MAGENTA = [1.0, 0.35, 0.75];
const GOLD = [1.0, 0.85, 0.45];

// The hero lights always exist (first slots). `count` additionally populates
// seeded street/stall lights so the slider controls REAL lights and REAL loops.
export function createNightMarketLights(count = 96) {
  resetUid();
  /** @type {ReturnType<typeof makeLight>[]} */
  const lights = [];

  // 0: the street-spanning giant warm light from the story.
  lights.push(makeLight({
    name: '横街巨灯', group: 'hero', pos: [0, 6.4, -8], color: [1.0, 0.86, 0.66],
    intensity: 46, range: 30, wideHint: true,
  }));
  // 1-3: hero colored wash lights.
  lights.push(makeLight({
    name: '左侧青蓝光', group: 'hero', kind: 'spot', pos: [-4.6, 5.6, 2], color: TEAL,
    intensity: 58, range: 26, innerDeg: 28, outerDeg: 52, dir: [0.25, -1, -0.25],
  }));
  lights.push(makeLight({
    name: '右侧品红光', group: 'hero', kind: 'spot', pos: [4.6, 5.6, -4], color: MAGENTA,
    intensity: 52, range: 24, innerDeg: 26, outerDeg: 50, dir: [-0.25, -1, 0.15],
  }));
  lights.push(makeLight({
    name: '摊头暖射灯', group: 'hero', kind: 'spot', pos: [0, 6.8, -18], color: GOLD,
    intensity: 46, range: 22, innerDeg: 22, outerDeg: 46, dir: [0, -1, 0.2],
  }));

  // The "row of glimmers" down the middle of the street (the lights that get
  // switched off in the reproduction). 18 bulbs.
  const ROW_N = 18;
  for (let i = 0; i < ROW_N; i++) {
    const t = i / (ROW_N - 1);
    const z = 12 + (-38 - 12) * t;
    lights.push(makeLight({
      name: `街排微光 ${i + 1}`, group: 'row',
      pos: [0, 5.3 + Math.sin(i * 0.9) * 0.25, z],
      color: i % 3 === 0 ? RED : TUNGSTEN,
      intensity: 5, range: 7.5,
    }));
  }

  // Stall lamps (one per stall side).
  LAYOUT.stallZs.forEach((z, i) => {
    for (const side of [-1, 1]) {
      lights.push(makeLight({
        name: `摊位灯 ${side < 0 ? '左' : '右'}#${i + 1}`, group: 'stall',
        pos: [side * (LAYOUT.stallX - 1.1), 2.55, z],
        color: i % 2 ? RED : WARM,
        intensity: 11, range: 9,
      }));
    }
  });

  // Extra seeded lights to reach the requested count.
  const rng = mulberry32(1337);
  const palette = [WARM, TUNGSTEN, RED, TEAL, GOLD, MAGENTA];
  let guard = 0;
  while (lights.length < count && guard < count * 4) {
    guard++;
    const roll = rng();
    let pos;
    let range;
    let intensity;
    if (roll < 0.55) {
      // Around a random stall.
      const z = LAYOUT.stallZs[Math.floor(rng() * LAYOUT.stallZs.length)];
      const side = rng() < 0.5 ? -1 : 1;
      pos = [
        side * (LAYOUT.stallX - 0.5 - rng() * 2.2),
        1.6 + rng() * 2.4,
        z + (rng() - 0.5) * 2.4,
      ];
      range = 6 + rng() * 7;
      intensity = 6 + rng() * 11;
    } else if (roll < 0.9) {
      // Along the street / strings.
      const z = 14 - rng() * 56;
      pos = [(rng() - 0.5) * 8.5, 3.4 + rng() * 2.6, z];
      range = 6 + rng() * 9;
      intensity = 5 + rng() * 10;
    } else {
      // Dense overlapping knot near the foreground (stress for capacity).
      pos = [2.5 + (rng() - 0.5) * 2.2, 2.2 + rng() * 2.2, 4 + (rng() - 0.5) * 2.4];
      range = 5 + rng() * 5;
      intensity = 7 + rng() * 9;
    }
    lights.push(makeLight({
      name: `增补灯 ${lights.length + 1}`,
      group: roll < 0.2 ? 'knot' : 'extra',
      pos, color: palette[Math.floor(rng() * palette.length)],
      intensity, range,
    }));
  }

  // Assign slots = array index for the baseline population.
  lights.forEach((l, i) => { l.slot = i; });
  return lights.slice(0, count);
}

// A deliberately adversarial population used by headless tests / presets:
// many co-located lights plus one enormous light that crosses depth slices.
export function createOverlapStressLights() {
  resetUid();
  const lights = [];
  lights.push(makeLight({
    name: '遮天巨灯', group: 'hero', pos: [0, 5, 2], color: [1, 0.9, 0.75],
    intensity: 120, range: 60, wideHint: true,
  }));
  const rng = mulberry32(4242);
  for (let i = 0; i < 64; i++) {
    lights.push(makeLight({
      name: `重叠灯 ${i + 1}`,
      pos: [1.5 + (rng() - 0.5) * 1.6, 2 + rng() * 2.2, 3 + (rng() - 0.5) * 1.6],
      color: [0.6 + rng() * 0.4, 0.5 + rng() * 0.4, 0.4 + rng() * 0.4],
      intensity: 14 + rng() * 20, range: 7 + rng() * 6,
    }));
  }
  for (let i = 0; i < 24; i++) {
    lights.push(makeLight({
      name: `近裁面灯 ${i + 1}`,
      pos: [(rng() - 0.5) * 6, 2 + rng() * 4, 12 + rng() * 5],
      color: [0.4 + rng() * 0.6, 0.5 + rng() * 0.5, 1],
      intensity: 12 + rng() * 18, range: 8 + rng() * 10,
    }));
  }
  lights.forEach((l, i) => { l.slot = i; });
  return lights;
}
