// Cluster light assignment + overflow-safe publishing kernel.
//
// Two complete strategies are supported:
//   'global' : wide / overflowing lights move to an independent global table and
//              are removed from every cluster (exclusive, never double counted).
//              Per-cluster lists stay hard-bounded by `capacity`.
//   'spill'  : each cluster keeps a bounded primary list of `capacity`; extra lights
//              for an overflow cluster go into a compact spill/recompute region.
//   'strict' : fixed capacity with no escape hatch. Overflow => incomplete, so the
//              store retains the previous complete frame and marks pending regions.
//
// A candidate is only turned into a published frame when complete AND it passes
// assertFrameInvariants(). Nothing here silently truncates a cluster.

import { vec3 } from './math.js';
import { enumerateLightClusters } from './clusters.js';

export const STRATEGY = {
  HYBRID: 'hybrid',
  GLOBAL: 'global',
  SPILL: 'spill',
  STRICT: 'strict',
};

export function defaultOptions() {
  return {
    capacity: 24,
    strategy: STRATEGY.HYBRID,
    globalBudget: 24,
    totalIndexBudget: 262144, // uint slots for the compact cluster+global index buffer
    wideThresholdClusters: 1600, // footprint size that makes a light "wide"
    wideThresholdSlices: 14, // ...and spanning this many depth slices (compound rule)
    spherePad: 1e-3,
  };
}

function emptyHistogram() {
  // Buckets: 0, 1-4,5-8,9-16,17-24,25-32,33-48,49-64,65+.
  return new Array(9).fill(0);
}
function histBucket(n) {
  if (n === 0) return 0;
  if (n <= 4) return 1;
  if (n <= 8) return 2;
  if (n <= 16) return 3;
  if (n <= 24) return 4;
  if (n <= 32) return 5;
  if (n <= 48) return 6;
  if (n <= 64) return 7;
  return 8;
}

// Decide whether one light is cheaper/safer as an independent wide/global light.
export function decideWide(footprint, light, cfg, opts) {
  const copies = footprint.ids.length;
  const reasons = [];
  let wide = false;
  if (light.pinnedGlobal) { wide = true; reasons.push('手动固定全局'); }
  if (light.wideHint) { reasons.push('标记为宽灯'); if (copies >= 1) wide = true; }
  if (copies >= opts.wideThresholdClusters) {
    wide = true;
    reasons.push(`覆盖 ${copies} 簇 ≥ ${opts.wideThresholdClusters}`);
  }
  if (footprint.sliceCount >= opts.wideThresholdSlices && copies >= opts.wideThresholdClusters / 2) {
    wide = true;
    reasons.push(`跨 ${footprint.sliceCount} 深度层且 ${copies} 簇`);
  }
  return {
    slot: light.slot,
    uid: light.uid,
    name: light.name,
    wide,
    reasons,
    copies,
    globalIndices: 1,
    duplicateBytes: copies * 4,
    globalIndexBytes: 4,
    sliceCount: footprint.sliceCount,
    tileCount: footprint.tileCount,
  };
}

export function assignClusters(cfg, bounds, viewMatrix, lights, optsInput = {}) {
  const opts = { ...defaultOptions(), ...optsInput };
  const K = cfg.clusterCount;
  const N = lights.length;

  const raw = Array.from({ length: K }, () => []);
  const rawCount = new Uint32Array(K);
  /** @type {{ids:number[], sliceCount:number, tileCount:number}[]} */
  const footprints = new Array(N).fill(null);
  const viewCenters = new Array(N).fill(null);
  let onLights = 0;
  let intersectionTests = 0;

  // 1) Conservative footprint for every ON light.
  for (const light of lights) {
    const slot = light.slot;
    if (!light.on) {
      footprints[slot] = { ids: [], sliceCount: 0, tileCount: 0 };
      continue;
    }
    onLights++;
    const center = vec3.transformPoint(viewMatrix, light.pos);
    viewCenters[slot] = center;
    intersectionTests += K;
    const ids = enumerateLightClusters(cfg, bounds, center, light.range);
    const sliceSet = new Set();
    const tileSet = new Set();
    for (const id of ids) {
      raw[id].push(slot);
      rawCount[id]++;
      const tx = id % cfg.cols;
      const q = (id - tx) / cfg.cols;
      const ty = q % cfg.rows;
      const s = (q - ty) / cfg.rows;
      sliceSet.add(s);
      tileSet.add(ty * cfg.cols + tx);
    }
    footprints[slot] = { ids, sliceCount: sliceSet.size, tileCount: tileSet.size };
  }

  // 2) Wide decisions + initial global set.
  const decisions = new Array(N).fill(null);
  const globalSet = new Set();
  const autoWideSlots = [];
  const pinnedSlots = [];
  const demotedWideSlots = [];
  const wideCandidates = [];
  for (const light of lights) {
    if (!light.on) continue;
    const fp = footprints[light.slot];
    const d = decideWide(fp, light, cfg, opts);
    decisions[light.slot] = d;
    if (light.pinnedGlobal) {
      globalSet.add(light.slot);
      pinnedSlots.push(light.slot);
    } else if (d.wide && (opts.strategy === STRATEGY.GLOBAL || opts.strategy === STRATEGY.HYBRID)) {
      wideCandidates.push(light.slot);
    }
  }
  // Widest footprint first gets the scarce global slots.
  wideCandidates.sort((a, b) => footprints[b].ids.length - footprints[a].ids.length);
  if (opts.strategy === STRATEGY.GLOBAL) {
    for (const slot of wideCandidates) { globalSet.add(slot); autoWideSlots.push(slot); }
  } else if (opts.strategy === STRATEGY.HYBRID) {
    const room = Math.max(0, opts.globalBudget - pinnedSlots.length);
    wideCandidates.forEach((slot, i) => {
      if (i < room) { globalSet.add(slot); autoWideSlots.push(slot); }
      else demotedWideSlots.push(slot); // too many wide lights: duplicate locally + spill
    });
  }

  // Local counts after removing globals.
  const localCount = new Int32Array(K);
  for (let id = 0; id < K; id++) localCount[id] = rawCount[id];
  for (const slot of globalSet) {
    for (const id of footprints[slot].ids) localCount[id]--;
  }

  // 3) Strategy-specific overflow resolution.
  const promotedSlots = [];
  let complete = true;
  let reason = null;
  /** @type {number[]} */
  let pendingClusterIds = [];

  const overCapacityClusters = [];
  for (let id = 0; id < K; id++) if (rawCount[id] > opts.capacity) overCapacityClusters.push(id);

  if (opts.strategy === STRATEGY.GLOBAL) {
    if (globalSet.size > opts.globalBudget) {
      complete = false;
      reason = `宽灯/固定全局灯共 ${globalSet.size} 盏，超过全局灯预算 ${opts.globalBudget}`;
      for (let id = 0; id < K; id++) if (localCount[id] > opts.capacity) pendingClusterIds.push(id);
    }
    // Greedily promote the highest-footprint non-global light from any cluster
    // that is still over capacity. Highest footprint resolves the most pressure.
    while (complete) {
      let worst = -1;
      for (let id = 0; id < K; id++) {
        if (localCount[id] > opts.capacity && (worst < 0 || localCount[id] > localCount[worst])) worst = id;
      }
      if (worst < 0) break;
      if (globalSet.size >= opts.globalBudget) {
        complete = false;
        reason = `全局灯预算 ${opts.globalBudget} 不足，仍有簇超过每簇容量 ${opts.capacity}`;
        break;
      }
      let pick = -1;
      let pickScore = -1;
      for (const slot of raw[worst]) {
        if (globalSet.has(slot)) continue;
        const score = footprints[slot].ids.length * 1e6 + lights[slot].range;
        if (score > pickScore) { pickScore = score; pick = slot; }
      }
      if (pick < 0) break;
      globalSet.add(pick);
      promotedSlots.push(pick);
      for (const id of footprints[pick].ids) localCount[id]--;
    }
    if (!complete) {
      for (let id = 0; id < K; id++) if (localCount[id] > opts.capacity) pendingClusterIds.push(id);
    }
  } else if (opts.strategy === STRATEGY.STRICT) {
    for (let id = 0; id < K; id++) {
      // Pinned globals are removed; any remaining over-capacity is a hard fail.
      if (localCount[id] > opts.capacity) pendingClusterIds.push(id);
    }
    if (pendingClusterIds.length) {
      complete = false;
      reason = `固定每簇容量 ${opts.capacity} 被突破：${pendingClusterIds.length} 个簇溢出（严格模式不截断）`;
    }
  }
  // SPILL completeness is decided after measuring compact storage budget.

  // 4) Build compact header + index storage.
  // Header texel: (offset, count, primaryCount, spillCount).
  const headerData = new Uint32Array(K * 4);
  const indices = [];
  const primaryCount = new Uint32Array(K);
  const spillCount = new Uint32Array(K);

  for (let id = 0; id < K; id++) {
    const offset = indices.length;
    const globalsHere = [];
    const locals = [];
    for (const slot of raw[id]) {
      if (globalSet.has(slot)) globalsHere.push(slot);
      else locals.push(slot);
    }
    // Stable ordering: primary first up to capacity, then spill.
    let primary;
    let spill;
    if (opts.strategy === STRATEGY.SPILL || opts.strategy === STRATEGY.HYBRID) {
      primary = locals.slice(0, opts.capacity);
      spill = locals.slice(opts.capacity);
    } else {
      // global / strict: locals are guaranteed <= capacity when complete.
      primary = locals;
      spill = [];
    }
    for (const s of primary) indices.push(s);
    for (const s of spill) indices.push(s);
    primaryCount[id] = primary.length;
    spillCount[id] = spill.length;
    headerData[id * 4 + 0] = offset;
    headerData[id * 4 + 1] = primary.length + spill.length;
    headerData[id * 4 + 2] = primary.length;
    headerData[id * 4 + 3] = spill.length;
    void globalsHere;
  }

  // Append the exclusive global table at the end.
  const globalOffset = indices.length;
  const globalSlots = [...globalSet].sort((a, b) => a - b);
  for (const s of globalSlots) indices.push(s);
  const indexData = new Uint32Array(indices);

  if (indexData.length > opts.totalIndexBudget && complete) {
    complete = false;
    reason = `索引总量 ${indexData.length} 超过总预算 ${opts.totalIndexBudget}`;
    if (!pendingClusterIds.length) pendingClusterIds = overCapacityClusters.slice();
  }
  if ((opts.strategy === STRATEGY.SPILL || opts.strategy === STRATEGY.HYBRID) && globalSlots.length > opts.globalBudget) {
    complete = false;
    reason = `全局灯数量 ${globalSlots.length} 超过全局预算 ${opts.globalBudget}`;
  }
  if (opts.strategy === STRATEGY.HYBRID && pendingClusterIds.length === 0 && !complete) {
    pendingClusterIds = overCapacityClusters.slice();
  }

  // 5) Distribution stats.
  const rawHist = emptyHistogram();
  const storedHist = emptyHistogram();
  let rawTotal = 0;
  let maxRaw = 0;
  let maxStored = 0;
  let storedTotal = 0;
  const rawSorted = [];
  for (let id = 0; id < K; id++) {
    const rc = rawCount[id];
    const sc = headerData[id * 4 + 1];
    rawTotal += rc;
    storedTotal += sc;
    if (rc > maxRaw) maxRaw = rc;
    if (sc > maxStored) maxStored = sc;
    rawHist[histBucket(rc)]++;
    storedHist[histBucket(sc)]++;
    rawSorted.push(rc);
  }
  const spillTotal = spillCount.reduce((a, b) => a + b, 0);
  rawSorted.sort((a, b) => a - b);
  const mean = rawTotal / K;
  const p95 = rawSorted[Math.min(K - 1, Math.floor(K * 0.95))] || 0;

  const stats = {
    clusterCount: K,
    cols: cfg.cols,
    rows: cfg.rows,
    slices: cfg.slices,
    lightCount: lights.length,
    onLights,
    intersectionTests,
    rawTotal,
    storedTotal, // local instances actually looped by clusters
    spillTotal,
    globalCount: globalSlots.length,
    autoWideCount: autoWideSlots.length,
    demotedWideCount: demotedWideSlots.length,
    pinnedCount: pinnedSlots.length,
    promotedCount: promotedSlots.length,
    maxRawOccupancy: maxRaw,
    maxStoredOccupancy: maxStored,
    meanRawOccupancy: mean,
    p95RawOccupancy: p95,
    rawHistogram: rawHist,
    storedHistogram: storedHist,
    overCapacityClusterCount: overCapacityClusters.length,
    pendingClusterCount: pendingClusterIds.length,
    indexSlots: indexData.length,
    indexBytes: indexData.length * 4,
    headerBytes: K * 16,
    actualBufferBytes: indexData.length * 4 + K * 16,
    // Theoretical worst-case bounded table memory.
    worstBoundedBytes: K * opts.capacity * 4 + K * 16 + opts.globalBudget * 4,
    worstPureDuplicationBytes: rawTotal * 4 + K * 16,
    capacity: opts.capacity,
    globalBudget: opts.globalBudget,
    totalIndexBudget: opts.totalIndexBudget,
  };

  return {
    complete,
    reason,
    cfg,
    opts,
    raw,
    rawCount,
    footprints,
    viewCenters,
    decisions,
    globalSlots,
    autoWideSlots,
    demotedWideSlots,
    pinnedSlots,
    promotedSlots,
    headerData,
    indexData,
    globalOffset,
    pendingClusterIds: [...new Set(pendingClusterIds)],
    overCapacityClusters,
    stats,
  };
}

// Validate an immutable published/candidate frame. Returns an array of violation
// strings; empty means safe to publish / use for shading.
export function checkFrameInvariants(frame, lights) {
  const violations = [];
  const K = frame.cfg.clusterCount;
  if (frame.headerData.length !== K * 4) violations.push('header length mismatch');

  const globalSet = new Set(frame.globalSlots);
  if (globalSet.size !== frame.globalSlots.length) violations.push('duplicate global slot');

  for (const g of frame.globalSlots) {
    if (g < 0 || g >= lights.length) violations.push(`global slot ${g} out of range`);
    else if (!lights[g].on) violations.push(`global slot ${g} is off`);
  }

  for (let id = 0; id < K; id++) {
    const offset = frame.headerData[id * 4];
    const count = frame.headerData[id * 4 + 1];
    if (offset + count > frame.indexData.length) {
      violations.push(`cluster ${id} index range exceeds buffer`);
      continue;
    }
    const seen = new Set();
    for (let k = 0; k < count; k++) {
      const slot = frame.indexData[offset + k];
      if (slot < 0 || slot >= lights.length) { violations.push(`cluster ${id} bad slot ${slot}`); continue; }
      if (!lights[slot].on) violations.push(`cluster ${id} references off light ${slot}`);
      if (seen.has(slot)) violations.push(`cluster ${id} duplicates slot ${slot}`);
      if (globalSet.has(slot)) violations.push(`cluster ${id} also contains global slot ${slot} (double use)`);
      seen.add(slot);
    }
    if (frame.opts.strategy === STRATEGY.GLOBAL && frame.complete && count > frame.opts.capacity) {
      violations.push(`complete global frame cluster ${id} exceeds capacity`);
    }
    const primary = frame.headerData[id * 4 + 2];
    if ((frame.opts.strategy === STRATEGY.SPILL || frame.opts.strategy === STRATEGY.HYBRID) &&
        frame.complete && primary > frame.opts.capacity) {
      violations.push(`bounded primary list cluster ${id} exceeds capacity`);
    }
  }

  // Global region actually present in indexData.
  for (let k = 0; k < frame.globalSlots.length; k++) {
    const a = frame.indexData[frame.globalOffset + k];
    if (a !== frame.globalSlots[k]) violations.push('global table content mismatch at ' + k);
  }
  return violations;
}
