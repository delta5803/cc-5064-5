// Single source of truth + atomic publish state machine. DOM-free so Node can
// exercise the exact drag/publish/overflow logic the UI uses.
import {
  makeClusterConfig, buildClusterBounds,
} from '../core/clusters.js';
import {
  assignClusters, checkFrameInvariants, defaultOptions, STRATEGY,
} from '../core/assignment.js';
import { createCamera, cameraMatrices } from '../core/camera.js';
import { createNightMarketLights, createOverlapStressLights } from '../core/lights.js';
import { runComparison, sceneBoxes } from '../core/reference.js';
import { computeAdaptiveBoundaries } from '../core/adaptive.js';
import { comparePartitions } from '../core/experiment.js';

export const MAX_LIGHTS = 256;
export const RENDER_W = 1280;
export const RENDER_H = 720;

function now() {
  return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}

// std140-compatible three vec4 arrays per light:
//   LA[slot] = (pos.xyz, range)
//   LB[slot] = (color.rgb, intensity)
//   LC[slot] = (kind, cosInner, cosOuter, 0)
// Block layout is LA[MAX], LB[MAX], LC[MAX] (each vec4 array is tightly packed).
export function packLightBlock(lights, maxLights = MAX_LIGHTS) {
  const data = new Float32Array(maxLights * 12);
  const aOff = 0;
  const bOff = maxLights * 4;
  const cOff = maxLights * 8;
  for (let i = 0; i < lights.length; i++) {
    const l = lights[i];
    data[aOff + i * 4 + 0] = l.pos[0];
    data[aOff + i * 4 + 1] = l.pos[1];
    data[aOff + i * 4 + 2] = l.pos[2];
    data[aOff + i * 4 + 3] = l.range;
    data[bOff + i * 4 + 0] = l.color[0];
    data[bOff + i * 4 + 1] = l.color[1];
    data[bOff + i * 4 + 2] = l.color[2];
    data[bOff + i * 4 + 3] = l.intensity;
    const inner = (l.innerDeg ?? 24) * Math.PI / 180;
    const outer = (l.outerDeg ?? 42) * Math.PI / 180;
    data[cOff + i * 4 + 0] = l.kind === 'spot' ? 1 : 0;
    data[cOff + i * 4 + 1] = Math.cos(inner);
    data[cOff + i * 4 + 2] = Math.cos(outer);
    data[cOff + i * 4 + 3] = 0;
  }
  return data;
}

export class LabStore {
  constructor() {
    this.listeners = new Set();
    this.cam = createCamera();
    this.clusterSettings = { tilePixels: 80, slices: 24 };
    // Depth partition scheme chosen from the UI: 'fixed' (exponential) or
    // 'adaptive' (visible-depth quantiles). Both feed the same shader via the
    // boundary table baked into every published frame's cfg.
    this.partition = 'fixed';
    this.adaptiveInfo = null;
    this.cfg = this._makeCfg();
    this.bounds = buildClusterBounds(this.cfg);

    this.masterMarket = createNightMarketLights(MAX_LIGHTS);
    this.lightCount = 96;
    this.lights = this.masterMarket.slice(0, this.lightCount);
    this.preset = 'market';

    this.options = defaultOptions();
    this.selectedUid = this.lights[0].uid;
    this.hoverClusterId = null;
    this.pinnedClusterId = null;
    this.debugMode = 'lit';
    this.showHandles = true;
    this.showGrid = true;

    this.version = 0;
    this.published = null;
    this.pending = null;
    this.lastCandidate = null;
    this.mats = null;
    this.assignmentMs = 0;
    this.lastError = null;

    this.comparison = null;
    this.partitionComparison = null;
    this.partitionRunning = false;
    this.comparisonRunning = false;

    this.recompute('init');
  }

  _makeCfg() {
    return makeClusterConfig({
      width: RENDER_W,
      height: RENDER_H,
      tilePixels: this.clusterSettings.tilePixels,
      slices: this.clusterSettings.slices,
      near: this.cam.near,
      far: this.cam.far,
      fovyDeg: this.cam.fovyDeg,
      partition: this.partition,
    });
  }

  // Recompute the adaptive depth table for the current camera. Only meaningful
  // when partition === 'adaptive'; returns null otherwise (fixed table is baked
  // into cfg already).
  _refreshAdaptiveTable() {
    if (this.partition !== 'adaptive') { this.adaptiveInfo = null; return; }
    const mats = cameraMatrices(this.cam, this.cfg.aspect);
    const info = computeAdaptiveBoundaries(this.cfg, mats, this.cam, sceneBoxes());
    this.adaptiveInfo = info;
    this.cfg = {
      ...this.cfg,
      boundaries: info.boundaries,
    };
    this.bounds = buildClusterBounds(this.cfg);
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(scope = 'change') {
    for (const fn of this.listeners) {
      try { fn(this, scope); } catch (e) { /* UI listener errors must not break kernel */ }
    }
  }

  selectedLight() {
    return this.lights.find((l) => l.uid === this.selectedUid) || this.lights[0] || null;
  }

  selectLight(uid) {
    this.selectedUid = uid;
    this.emit('select');
  }

  setDebugMode(mode) {
    this.debugMode = mode;
    this.emit('view');
  }

  // ---- scene / lights -----------------------------------------------------

  setLightCount(n) {
    this.lightCount = Math.max(1, Math.min(MAX_LIGHTS, Math.round(n)));
    if (this.preset !== 'market') {
      // Returning to the adjustable real scene.
      this.preset = 'market';
    }
    this.lights = this.masterMarket.slice(0, this.lightCount);
    if (!this.lights.some((l) => l.uid === this.selectedUid)) this.selectedUid = this.lights[0].uid;
    this.recompute('count');
  }

  loadPreset(name) {
    if (name === 'stress') {
      this.preset = 'stress';
      this.lights = createOverlapStressLights();
      this.selectedUid = this.lights[0].uid;
    } else {
      this.preset = 'market';
      // Recreate master so story toggles/drags do not permanently mutilate it.
      this.masterMarket = createNightMarketLights(MAX_LIGHTS);
      this.lights = this.masterMarket.slice(0, this.lightCount);
      this.selectedUid = this.lights[0].uid;
    }
    this.recompute('preset');
  }

  patchLight(uid, patch, reason = 'patch') {
    const l = this.lights.find((x) => x.uid === uid);
    if (!l) return;
    if (patch.pos) l.pos = [...patch.pos];
    if (patch.color) l.color = [...patch.color];
    for (const k of ['name', 'kind', 'intensity', 'range', 'on', 'pinnedGlobal', 'wideHint', 'innerDeg', 'outerDeg', 'dir']) {
      if (k in patch) l[k] = patch[k];
    }
    this.recompute(reason);
  }

  toggleLight(uid, on) {
    const l = this.lights.find((x) => x.uid === uid);
    if (!l) return;
    l.on = typeof on === 'boolean' ? on : !l.on;
    this.recompute('toggle');
  }

  soloLight(uid) {
    for (const l of this.lights) l.on = l.uid === uid;
    this.recompute('solo');
  }

  allLightsOn() {
    for (const l of this.lights) l.on = true;
    this.recompute('all-on');
  }

  turnOffGroup(group) {
    let n = 0;
    for (const l of this.lights) if (l.group === group) { l.on = false; n++; }
    this.recompute('group-off');
    return n;
  }

  // ---- cluster / budget options -------------------------------------------

  setOption(key, value) {
    this.options[key] = value;
    this.recompute('option');
  }

  setStrategy(strategy) {
    this.options.strategy = strategy;
    this.recompute('strategy');
  }

  setClusterSetting(key, value) {
    this.clusterSettings[key] = Math.round(value);
    this.cfg = this._makeCfg();
    this.bounds = buildClusterBounds(this.cfg);
    this._refreshAdaptiveTable();
    this.recompute('cluster-setting');
  }

  setPartition(partition) {
    const p = partition === 'adaptive' ? 'adaptive' : 'fixed';
    if (p === this.partition) return;
    this.partition = p;
    this.cfg = this._makeCfg();
    this.bounds = buildClusterBounds(this.cfg);
    if (p === 'adaptive') this._refreshAdaptiveTable();
    else this.adaptiveInfo = null;
    this.recompute('partition');
  }

  cameraChanged() {
    this.cfg = this._makeCfg();
    this.bounds = buildClusterBounds(this.cfg);
    this._refreshAdaptiveTable();
    this.recompute('camera');
  }

  // ---- the kernel publish step --------------------------------------------

  recompute(reason = 'recompute') {
    this.lastError = null;
    const t0 = now();
    if (this.partition === 'adaptive') this._refreshAdaptiveTable();
    this.mats = cameraMatrices(this.cam, this.cfg.aspect);
    let candidate;
    try {
      candidate = assignClusters(this.cfg, this.bounds, this.mats.view, this.lights, this.options);
    } catch (e) {
      this.lastError = '分配内核异常: ' + (e && e.message ? e.message : String(e));
      this.status = { level: 'bad', text: '分簇灯光异常：' + this.lastError };
      this.emit('error');
      return this.published;
    }
    this.assignmentMs = now() - t0;
    const violations = checkFrameInvariants(candidate, this.lights);
    this.lastCandidate = candidate;

    if (candidate.complete && violations.length === 0) {
      this.version++;
      const frame = {
        version: this.version,
        complete: true,
        reason,
        cfg: { ...this.cfg },
        options: { ...this.options },
        opts: { ...this.options },
        eye: [...this.mats.eye],
        viewMatrix: this.mats.view,
        projMatrix: this.mats.proj,
        viewProj: this.mats.viewProj,
        invViewProj: this.mats.invViewProj,
        headerData: candidate.headerData,
        indexData: candidate.indexData,
        globalOffset: candidate.globalOffset,
        globalSlots: [...candidate.globalSlots],
        stats: { ...candidate.stats },
        decisions: candidate.decisions,
        lightBuffer: packLightBlock(this.lights),
        lightCount: this.lights.length,
        // Immutable-ish snapshot used by the inspector and audit after later edits.
        lightsSnapshot: this.lights.map((l) => ({
          ...l, pos: [...l.pos], color: [...l.color], dir: [...(l.dir || [0, -1, 0])],
        })),
        at: now(),
      };
      this.published = frame;
      this.pending = null;
      this.status = {
        level: 'ok',
        text: `已发布完整灯光帧 v${frame.version} · ${reason} · ${this.assignmentMs.toFixed(1)} ms`,
      };
    } else {
      // DO NOT publish a truncated / over-budget frame. Keep the previous whole
      // published frame and expose the candidate's pending clusters for overlay.
      this.pending = {
        reason: candidate.reason || violations.join('；') || '未知不完整原因',
        violations,
        candidate,
        pendingClusterIds: candidate.pendingClusterIds,
        at: now(),
      };
      this.status = {
        level: 'warn',
        text: `预算不足，保留上个完整版本${this.published ? ` v${this.published.version}` : '（无）'}；待算区域 ${candidate.pendingClusterIds.length} 簇`,
      };
    }
    this.emit('recompute');
    return this.published;
  }

  // ---- reference comparison (also surfaced in the UI) ----------------------

  async runComparison() {
    if (this.comparisonRunning) return;
    this.comparisonRunning = true;
    this.emit('comparison-start');
    await new Promise((r) => setTimeout(r, 30));
    try {
      const result = runComparison({
        width: 320, height: 180, tilePixels: 20, slices: this.clusterSettings.slices,
        cam: this.cam,
        lights: this.lights,
        strategy: this.options.strategy,
        capacity: this.options.capacity,
        globalBudget: this.options.globalBudget,
        totalIndexBudget: this.options.totalIndexBudget,
        wideThresholdClusters: this.options.wideThresholdClusters,
        wideThresholdSlices: this.options.wideThresholdSlices,
      });
      this.comparison = result;
    } catch (e) {
      this.lastError = '参考对比失败: ' + (e && e.message ? e.message : String(e));
    } finally {
      this.comparisonRunning = false;
      this.emit('comparison-done');
    }
    return this.comparison;
  }

  // Fixed-vs-adaptive partition comparison on the CURRENT live light rig. Errors
  // and leaks are surfaced via lastError / status so the UI can display them.
  async runPartitionComparison() {
    if (this.partitionRunning) return this.partitionComparison;
    this.partitionRunning = true;
    this.emit('partition-start');
    await new Promise((r) => setTimeout(r, 20));
    try {
      this.partitionComparison = comparePartitions({
        lights: this.lights,
        cam: this.cam,
        capacity: this.options.capacity,
        globalBudget: this.options.globalBudget,
        totalIndexBudget: this.options.totalIndexBudget,
        strategy: this.options.strategy,
        slices: this.clusterSettings.slices,
      });
      this.lastError = null;
    } catch (e) {
      this.lastError = '分区对比失败: ' + (e && e.message ? e.message : String(e));
      this.status = { level: 'bad', text: this.lastError };
    } finally {
      this.partitionRunning = false;
      this.emit('partition-done');
    }
    return this.partitionComparison;
  }

  // Headless / automation hook: run a drag path and audit every published frame.
  simulateDrag(uid, points) {
    const audit = [];
    for (const p of points) {
      this.patchLight(uid, { pos: p }, 'sim-drag');
      const f = this.published;
      audit.push({
        point: [...p],
        version: f ? f.version : null,
        pending: !!this.pending,
        violations: f ? checkFrameInvariants(f, f.lightsSnapshot) : ['no published frame'],
        snapshotPos: f ? [...f.lightsSnapshot.find((l) => l.uid === uid).pos] : null,
      });
    }
    return audit;
  }
}

export { STRATEGY };
