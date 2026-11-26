// UI wiring: owns the LabStore, WebGL renderer, 2D overlay, pointer interaction,
// inspectors, stats and the headless/test hook. The clustered kernel drives all
// controls; nothing here shades lights with a hidden full loop.
import { LabStore } from './store.js';
import { WebGLClusteredRenderer } from './webglRenderer.js';
import { Overlay } from './overlay.js';
import { rayForPixel } from '../core/camera.js';
import { vec3, projectWorld } from '../core/math.js';
import { domToTile, decodeCluster, depthBoundary, sliceForViewDepth } from '../core/clusters.js';
import { sceneBoxes } from '../core/reference.js';
import { rayScene } from '../core/scene.js';
import { contributionsAtPoint } from '../core/shading.js';

const $ = (id) => document.getElementById(id);
const fmtInt = (n) => Math.round(n).toLocaleString('en-US');
const fmt1 = (n) => (Math.round(n * 10) / 10).toFixed(1);
function fmtBytes(n) {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + ' MiB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KiB';
  return n + ' B';
}
function rgbToHex(c) {
  return '#' + c.map((x) => {
    const v = Math.max(0, Math.min(255, Math.round(x * 255)));
    return v.toString(16).padStart(2, '0');
  }).join('');
}
function hexToRgb(h) {
  const n = parseInt(h.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const store = new LabStore();
window.__store = store;

// ---------------------------------------------------------------- renderer --
let renderer = null;
let glError = null;
try {
  renderer = new WebGLClusteredRenderer($('gl-canvas'));
} catch (e) {
  glError = e && e.message ? e.message : String(e);
  const fb = $('webgl-fallback');
  fb.classList.remove('hidden');
  fb.textContent = 'WebGL2 初始化失败：' + glError + '。右侧内核/检查器与下方 CPU 参考对比仍可使用。';
  (window.__bootErrors || (window.__bootErrors = [])).push(glError);
}

const overlay = new Overlay();
overlay.inspectSlice = 10;
const octx = $('overlay').getContext('2d');

const probe = { P: null, N: [0, 1, 0] };
let allocCountCache = { version: -1, counts: null, global: null };

// ------------------------------------------------------------- coordinate ----
function eventToCfg(e) {
  const c = $('overlay');
  const r = c.getBoundingClientRect();
  return {
    x: ((e.clientX - r.left) / r.width) * store.cfg.width,
    y: ((e.clientY - r.top) / r.height) * store.cfg.height,
    clientX: e.clientX, clientY: e.clientY, rect: r,
  };
}

function rayAtCfg(x, y) {
  return rayForPixel(store.mats, store.cam, store.cfg, Math.floor(x), Math.floor(y),
    store.cfg.width, store.cfg.height);
}

// ------------------------------------------------------------- pointer ops --
const gesture = {
  mode: null, uid: null, pointerId: null,
  startX: 0, startY: 0, lastX: 0, lastY: 0, moved: 0,
  nextPos: null, planeN: null,
};

function lightDragPosition(x, y) {
  const l = store.lights.find((q) => q.uid === gesture.uid);
  if (!l) return null;
  const ray = rayAtCfg(x, y);
  const n = vec3.normalize(vec3.sub(store.mats.eye, l.pos));
  const denom = vec3.dot(ray.dir, n);
  if (Math.abs(denom) < 1e-5) return null;
  const t = vec3.dot(vec3.sub(l.pos, ray.orig), n) / denom;
  if (!isFinite(t) || t <= 0) return null;
  const P = [
    ray.orig[0] + ray.dir[0] * t,
    ray.orig[1] + ray.dir[1] * t,
    ray.orig[2] + ray.dir[2] * t,
  ];
  P[0] = Math.max(-22, Math.min(22, P[0]));
  P[1] = Math.max(0.35, Math.min(15, P[1]));
  P[2] = Math.max(-48, Math.min(24, P[2]));
  return P;
}

function pickClusterAt(x, y) {
  const tile = domToTile(store.cfg, x, y);
  const ray = rayAtCfg(x, y);
  const hit = rayScene(ray.orig, ray.dir, sceneBoxes());
  let slice = overlay.inspectSlice;
  if (hit) {
    const P = [
      ray.orig[0] + ray.dir[0] * hit.t,
      ray.orig[1] + ray.dir[1] * hit.t,
      ray.orig[2] + ray.dir[2] * hit.t,
    ];
    const viewP = vec3.transformPoint(store.mats.view, P);
    slice = sliceForViewDepth(store.cfg, -viewP[2]);
    probe.P = P;
    probe.N = hit.normal ? [...hit.normal] : [0, 1, 0];
  } else {
    probe.P = null;
  }
  overlay.inspectSlice = slice;
  $('slice-range').value = String(slice);
  $('slice-val').textContent = String(slice);
  const id = (slice * store.cfg.rows + tile.ty) * store.cfg.cols + tile.tx;
  overlay.pinnedId = id;
  refreshInspector(true);
}

const canvas = $('overlay');
canvas.addEventListener('pointerdown', (e) => {
  const p = eventToCfg(e);
  try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic pointer in tests */ }
  gesture.pointerId = e.pointerId;
  gesture.startX = gesture.lastX = e.clientX;
  gesture.startY = gesture.lastY = e.clientY;
  gesture.moved = 0;
  const uid = overlay.hitHandle(store.published, p.x, p.y);
  if (uid != null) {
    gesture.mode = 'light';
    gesture.uid = uid;
    store.selectLight(uid);
    canvas.style.cursor = 'grabbing';
  } else {
    gesture.mode = 'orbit';
    gesture.uid = null;
    canvas.style.cursor = 'move';
  }
});

canvas.addEventListener('pointermove', (e) => {
  const p = eventToCfg(e);
  if (!gesture.mode) {
    // Hover feedback only.
    overlay.hoverTile = domToTile(store.cfg, p.x, p.y);
    overlay.hoverUid = overlay.hitHandle(store.published, p.x, p.y);
    canvas.style.cursor = overlay.hoverUid != null ? 'grab' : 'crosshair';
    return;
  }
  const dx = e.clientX - gesture.lastX;
  const dy = e.clientY - gesture.lastY;
  gesture.moved += Math.abs(dx) + Math.abs(dy);
  gesture.lastX = e.clientX;
  gesture.lastY = e.clientY;
  if (gesture.mode === 'orbit') {
    orbitCamera(dx, dy);
  } else if (gesture.mode === 'light') {
    gesture.nextPos = lightDragPosition(p.x, p.y);
  }
});

function endPointer(e) {
  if (!gesture.mode) return;
  try { canvas.releasePointerCapture(gesture.pointerId); } catch { /* noop */ }
  if (gesture.mode === 'light' && gesture.nextPos) {
    store.patchLight(gesture.uid, { pos: gesture.nextPos }, 'drag-end');
  }
  if (gesture.mode === 'orbit' && gesture.moved < 6) {
    const p = eventToCfg(e);
    pickClusterAt(p.x, p.y);
  }
  gesture.mode = null;
  gesture.uid = null;
  gesture.nextPos = null;
  canvas.style.cursor = 'crosshair';
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const factor = Math.exp(Math.sign(e.deltaY) * 0.08);
  store.cam.distance = Math.max(3, Math.min(95, store.cam.distance * factor));
  store.cameraChanged();
}, { passive: false });

function orbitCamera(dxPx, dyPx) {
  const s = 0.005;
  store.cam.yaw -= dxPx * s;
  store.cam.pitch = Math.max(-0.15, Math.min(1.45, store.cam.pitch + dyPx * s));
  store.cameraChanged();
}

// Scripted / headless handle location in client coordinates.
function handleClientXY(uid) {
  const l = store.published.lightsSnapshot.find((q) => q.uid === uid);
  if (!l) return null;
  const p = projectWorld(l.pos, store.published.viewProj, store.cfg.width, store.cfg.height);
  const r = canvas.getBoundingClientRect();
  return { x: r.left + (p.x / store.cfg.width) * r.width, y: r.top + (p.y / store.cfg.height) * r.height, visible: p.visible };
}

// ------------------------------------------------------------- frame slots --
function getClusterView(frame, id) {
  const o = id * 4;
  const offset = frame.headerData[o];
  const count = frame.headerData[o + 1];
  const primary = frame.headerData[o + 2];
  const spill = frame.headerData[o + 3];
  const local = [];
  for (let k = 0; k < count; k++) local.push(frame.indexData[offset + k]);
  const globals = [];
  for (let k = 0; k < frame.globalSlots.length; k++) {
    globals.push(frame.indexData[frame.globalOffset + k]);
  }
  return { offset, count, primary, spill, local, localPrimary: local.slice(0, primary), localSpill: local.slice(primary), globals };
}

function getAllocationCounts(frame) {
  if (allocCountCache.version === frame.version) return allocCountCache;
  const counts = new Map();
  for (let id = 0; id < store.cfg.clusterCount; id++) {
    const v = getClusterView(frame, id);
    for (const s of v.local) counts.set(s, (counts.get(s) || 0) + 1);
  }
  allocCountCache = { version: frame.version, counts, global: new Set(frame.globalSlots) };
  return allocCountCache;
}

// ------------------------------------------------------------- status/HUD ---
function refreshStatus() {
  const st = store.status || { level: 'ok', text: '' };
  const pill = $('status-pill');
  pill.classList.remove('ok', 'warn', 'bad');
  pill.classList.add(st.level === 'ok' ? 'ok' : st.level);
  $('status-text').textContent = st.text;
  $('pending-banner').classList.toggle('hidden', !store.pending);
  if (store.pending) {
    $('pending-banner-text').textContent =
      `${store.pending.reason} · ${store.pending.pendingClusterIds.length} 个簇等待重算`;
  }
  const f = store.published;
  $('hud-version').textContent = f ? 'v' + f.version : '–';
  $('hud-state').textContent = store.pending ? '保留旧帧 / 待算' : '完整';
  $('hud-state').style.color = store.pending ? 'var(--warn)' : 'var(--ok)';
  $('hud-assign-ms').textContent = fmt1(store.assignmentMs) + ' ms';
  $('hud-draws').textContent = renderer ? String(renderer.drawCalls) : 'GL 不可用';
  $('hud-strategy').textContent = store.options.strategy + ' · C=' + store.options.capacity +
    ' · G=' + store.options.globalBudget +
    ' · ' + (store.cfg.partition === 'adaptive' ? '自适应深度' : '固定深度');
}

// ------------------------------------------------------------- stats panel --
const HIST_LABELS = ['0', '1-4', '5-8', '9-16', '17-24', '25-32', '33-48', '49-64', '65+'];
function statCard(k, v, cls = '') {
  return `<div class="stat ${cls}"><span class="k">${k}</span><span class="v">${v}</span></div>`;
}

function refreshStats() {
  const f = store.published;
  if (!f) return;
  const s = f.stats;
  const cmp = store.comparison;
  const leak = cmp ? cmp.metrics.coverageMissCount : null;
  const K = store.cfg.clusterCount;
  const n = store.lights.length;
  // Theoretical naive bound: every light index duplicated into every cluster.
  const pureWorstBytes = K * n * 4 + K * 16;
  const cards = [
    statCard('开启 / 实际灯光', `${fmtInt(s.onLights)} / ${n}`),
    statCard('簇总数 (瓦×深)', fmtInt(K)),
    statCard('保守求交测试', fmtInt(s.intersectionTests)),
    statCard('原始灯-簇复制实例', fmtInt(s.rawTotal)),
    statCard('簇内索引实例', fmtInt(s.storedTotal)),
    statCard('溢出实例', fmtInt(s.spillTotal), s.spillTotal > 0 ? 'warn' : 'ok'),
    statCard('全局宽灯', `${s.globalCount}（自动 ${s.autoWideCount} / 固定 ${s.pinnedCount}）`),
    statCard('超容量原始簇', fmtInt(s.overCapacityClusterCount), s.overCapacityClusterCount > 0 ? 'warn' : 'ok'),
    statCard('待算簇', fmtInt(s.pendingClusterCount), s.pendingClusterCount > 0 ? 'bad' : 'ok'),
    statCard('最大原始 / 已存', `${s.maxRawOccupancy} / ${s.maxStoredOccupancy}`, s.maxRawOccupancy > s.capacity ? 'warn' : ''),
    statCard('平均 / P95 原始', `${s.meanRawOccupancy.toFixed(1)} / ${s.p95RawOccupancy}`),
    statCard('索引槽 / 实际显存', `${fmtInt(s.indexSlots)} · ${fmtBytes(s.actualBufferBytes)}`),
    statCard('深度分区', store.cfg.partition === 'adaptive'
      ? `自适应 · 采样 ${fmtInt(store.adaptiveInfo?.sampleCount || 0)} 点`
      : '固定指数切分', store.cfg.partition === 'adaptive' ? '' : 'ok'),
    statCard('主表硬上界 C×K', fmtBytes(s.worstBoundedBytes), 'ok'),
    statCard(`纯复制理论最坏 ${n}×K`, fmtBytes(pureWorstBytes), pureWorstBytes > s.worstBoundedBytes ? 'warn' : ''),
    statCard('漏光（覆盖缺失）', leak == null ? '运行对比测量' : fmtInt(leak), leak === 0 ? 'ok' : 'bad'),
    statCard('溢出/索引总预算', fmtInt(s.totalIndexBudget) + ' 槽'),
  ];
  $('stat-grid').innerHTML = cards.join('');
  drawHistogram(s.rawHistogram, s.capacity);
  refreshGlobalList(f);
}

function drawHistogram(hist, capacity) {
  const cv = $('hist-canvas');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = cv.clientWidth || 340;
  const H = 120;
  if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const max = Math.max(1, ...hist);
  const padL = 26, padB = 18, padT = 8, padR = 6;
  const bw = (W - padL - padR) / hist.length;
  ctx.font = '9.5px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let i = 0; i < hist.length; i++) {
    const h = (H - padB - padT) * (hist[i] / max);
    const x = padL + i * bw + 2;
    const y = H - padB - h;
    // Highlight buckets that can contain counts above capacity.
    const over = i >= 5 || (i === 4 && capacity < 24);
    ctx.fillStyle = hist[i] === 0 ? '#222a47' : over ? '#e08a3c' : '#3f8fd6';
    ctx.fillRect(x, y, bw - 4, h);
    ctx.fillStyle = '#8fa0d0';
    ctx.fillText(HIST_LABELS[i], x + (bw - 4) / 2, H - padB + 4);
    if (hist[i] > 0) {
      ctx.fillStyle = '#dfe8ff';
      ctx.fillText(String(hist[i]), x + (bw - 4) / 2, Math.max(0, y - 11));
    }
  }
  ctx.strokeStyle = 'rgba(255,209,102,.7)';
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  // Approximate capacity marker on the matching bucket boundary.
  const capBucket = capacity <= 4 ? 1 : capacity <= 8 ? 2 : capacity <= 16 ? 3 : capacity <= 24 ? 4 : capacity <= 32 ? 5 : capacity <= 48 ? 6 : capacity <= 64 ? 7 : 8;
  const mx = padL + capBucket * bw + 1;
  ctx.moveTo(mx, padT); ctx.lineTo(mx, H - padB);
  ctx.stroke();
  ctx.setLineDash([]);
}

function refreshGlobalList(frame) {
  $('global-count-badge').textContent = `${frame.globalSlots.length} / ${store.options.globalBudget}`;
  const sel = store.selectedLight();
  const decision = frame.decisions.find((d) => d && d.uid === store.selectedUid) || frame.decisions.find(Boolean);
  let html = '';
  if (decision) {
    html += `<div class="cluster-info" style="flex-basis:100%">宽灯决策 · ${decision.name}
判定宽灯：${decision.wide ? '是（' + (decision.reasons || []).join('，') + '）' : '否'}
覆盖 ${decision.sliceCount} 深度层 / ${fmtInt(decision.tileCount)} 瓦片 → 约 ${fmtInt(decision.copies)} 个簇副本
纯复制索引 ${fmtInt(decision.copies)}×4B = ${fmtBytes(decision.duplicateBytes)}；独立全局仅 ${fmtInt(decision.globalIndexBytes)}
当前处置：${frame.globalSlots.some((s) => frame.lightsSnapshot[s]?.uid === decision.uid) ? '独立全局宽灯表（1 个唯一条目，绝不与局部副本并存）' : '局部有界主表 + 溢出（未占全局槽）'}</div>`;
  }
  for (const slot of frame.globalSlots) {
    const l = frame.lightsSnapshot[slot];
    if (!l) continue;
    html += `<span class="chip" data-action="select" data-uid="${l.uid}" style="cursor:pointer">
      <span class="dotc" style="background:${rgbToHex(l.color)}"></span>${l.name}</span>`;
  }
  if (frame.globalSlots.length === 0) html += '<span class="tip">当前没有全局灯；调小簇容量或点击“预算不足演练”观察提升/溢出。</span>';
  $('global-list').innerHTML = html;
  void sel;
}

// ------------------------------------------------------------- inspector ----
let lastInspectorSig = '';
let inspectedSlots = null;
let lastInspectorIdentity = '';
function refreshInspector(force = false) {
  const f = store.published;
  if (!f || overlay.pinnedId == null) { lastInspectorSig = ''; inspectedSlots = null; lastInspectorIdentity = ''; return; }
  const id = overlay.pinnedId;
  const identity = [
    id, overlay.inspectSlice,
    probe.P ? probe.P.map((v) => v.toFixed(2)).join(',') : '-',
  ].join('|');
  const sig = f.version + '|' + identity;
  if (!force && sig === lastInspectorSig) return;
  lastInspectorSig = sig;

  const d = decodeCluster(store.cfg, id);
  const b0 = depthBoundary(store.cfg, d.s);
  const b1 = depthBoundary(store.cfg, d.s + 1);
  const view = getClusterView(f, id);
  // Adopt a fresh slot set only when the inspected cluster/point changes — not on
  // a toggle republish — so a switched-off source stays as an "off" row and can
  // be switched back on for source verification.
  if (force || identity !== lastInspectorIdentity || !inspectedSlots) {
    inspectedSlots = [...new Set([...view.local, ...view.globals])];
    lastInspectorIdentity = identity;
  }
  const raw = store.lastCandidate?.rawCount ? store.lastCandidate.rawCount[id] : '–';
  const over = raw > store.options.capacity;
  const pending = (store.pending?.pendingClusterIds || []).includes(id);

  $('cluster-info').textContent =
    `cluster id=${id}  tile(x=${d.tx}, y=${d.ty} 左下原点)  slice=${d.s}  分区=${store.cfg.partition === 'adaptive' ? '自适应(可见深分位)' : '固定(指数)'}\n` +
    `视深区间 ${b0.toFixed(2)}m … ${b1.toFixed(2)}m（${store.cfg.partition === 'adaptive' ? '可见深度分位数边界' : '指数边界'}，非线性硬件深度逆投影后取片）\n` +
    `原始候选=${raw}  容量C=${store.options.capacity}  ` +
    `主表=${view.primary}  溢出=${view.spill}  另加全局=${view.globals.length}\n` +
    `header(offset=${view.offset}, count=${view.count})` +
    (over ? `\n⚠ 原始 ${raw} > C：${store.options.strategy === 'strict' ? '严格策略 → 该簇待算，不发布截断帧' : '已由全局/溢出完整容纳'}` : '') +
    (pending ? '\n⛔ 当前为待算簇：画面保留上个完整帧的斜纹区域' : '');

  // Cluster light chips (local primary/spill + globals).
  const chip = (slot, kind) => {
    const l = f.lightsSnapshot[slot];
    if (!l) return '';
    return `<span class="chip ${kind === 'spill' ? '' : ''}" style="${kind === 'spill' ? 'border-color:#8a5a20' : ''}">
      <span class="dotc" style="background:${rgbToHex(l.color)};${l.on ? '' : 'opacity:.3'}"></span>
      <span data-action="select" data-uid="${l.uid}" style="cursor:pointer">${l.name}</span>
      <span class="tag ${kind === 'global' ? 'global' : kind === 'spill' ? '' : 'local'}">${kind === 'global' ? '全局' : kind === 'spill' ? '溢出' : '主表'}</span>
      <button data-action="solo" data-uid="${l.uid}" title="仅看此灯">独</button>
      <button data-action="toggle" data-uid="${l.uid}" title="关/开">${l.on ? '关' : '开'}</button>
    </span>`;
  };
  let chips = view.localPrimary.map((s) => chip(s, 'primary')).join('');
  chips += view.localSpill.map((s) => chip(s, 'spill')).join('');
  chips += view.globals.map((s) => chip(s, 'global')).join('');
  if (!chips) chips = '<span class="tip">该簇没有候选灯。</span>';
  $('cluster-light-list').innerHTML = chips;

  // Point contributions.
  const box = $('contrib-list');
  if (!probe.P) {
    box.innerHTML = '<span class="tip">点击场景表面后，这里按真实 BRDF 列出该点每盏相关灯的贡献。</span>';
    return;
  }
  const V = vec3.normalize(vec3.sub(store.mats.eye, probe.P));
  const contribs = contributionsAtPoint({
    P: probe.P, N: probe.N, V,
    lights: store.lights, slots: inspectedSlots,
  });
  const maxC = Math.max(1e-5, ...contribs.map((c) => c.diffuse[0] + c.diffuse[1] + c.diffuse[2]));
  box.innerHTML = contribs.map((c) => {
    const mag = c.diffuse[0] + c.diffuse[1] + c.diffuse[2];
    const pct = Math.round((mag / maxC) * 100);
    return `<div class="contrib-row ${c.on ? '' : 'off'}">
      <span class="dotc" style="width:9px;height:9px;border-radius:50%;background:${rgbToHex(c.color)}"></span>
      <span class="nm" data-action="select" data-uid="${c.uid}" style="cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
        ${c.name} · d=${c.dist.toFixed(1)}m${c.inRange ? '' : '（超范围）'}</span>
      <span class="v" style="font-family:var(--mono)">${mag.toFixed(3)}</span>
      <span class="acts">
        <button class="btn tiny" data-action="solo" data-uid="${c.uid}">独</button>
        <button class="btn tiny" data-action="toggle" data-uid="${c.uid}">${c.on ? '关' : '开'}</button>
      </span>
      <span class="bar"><i style="width:${pct}%"></i></span>
    </div>`;
  }).join('') || '<span class="tip">无灯贡献。</span>';
}

// ------------------------------------------------------------- light table --
let builtToken = -1;
function lightToken() {
  return store.preset + ':' + store.lightCount + ':' + store.lights.length + ':' +
    (store.preset === 'stress' ? 's' : 'm');
}
function buildLightRowsIfNeeded() {
  const token = lightToken();
  if (token === builtToken) return;
  builtToken = token;
  $('light-rows').innerHTML = store.lights.map((l) => `
    <div class="light-row" data-row-uid="${l.uid}">
      <input type="checkbox" data-action="row-check" data-uid="${l.uid}" ${l.on ? 'checked' : ''} />
      <span class="nm" data-action="select" data-uid="${l.uid}" title="${l.name}">${l.name}</span>
      <span class="tag" data-tag-uid="${l.uid}">–</span>
      <button class="btn tiny" data-action="solo" data-uid="${l.uid}">独</button>
    </div>`).join('');
}

function refreshLightRowsMeta() {
  buildLightRowsIfNeeded();
  const f = store.published;
  if (!f) return;
  const alloc = getAllocationCounts(f);
  const globalSet = alloc.global;
  for (const l of store.lights) {
    const row = document.querySelector(`[data-row-uid="${l.uid}"]`);
    if (!row) continue;
    row.classList.toggle('selected', l.uid === store.selectedUid);
    const cb = row.querySelector('input');
    if (document.activeElement !== cb) cb.checked = l.on;
    const tag = row.querySelector(`[data-tag-uid="${l.uid}"]`);
    const slot = store.lights.indexOf(l);
    if (!l.on) { tag.textContent = '关'; tag.className = 'tag off'; }
    else if (globalSet.has(slot)) { tag.textContent = '全局'; tag.className = 'tag global'; }
    else {
      const n = alloc.counts.get(slot) || 0;
      tag.textContent = n > 0 ? `局部×${n}` : '未入簇';
      tag.className = 'tag local';
    }
  }
}

// ------------------------------------------------------------- selected ed --
function syncSelectedPanel() {
  const l = store.selectedLight();
  if (!l) return;
  $('sel-title').textContent = l.name;
  // Reflect kernel/external (drag, story, solo) changes, but never overwrite the
  // exact field the user is currently typing/dragging.
  const assign = (id, value, prop = 'value') => {
    const el = $(id);
    if (document.activeElement !== el) el[prop] = value;
  };
  assign('sel-on', !!l.on, 'checked');
  assign('sel-pin-global', !!l.pinnedGlobal, 'checked');
  assign('sel-kind', l.kind === 'spot' ? 'spot' : 'point');
  assign('sel-intensity', String(l.intensity));
  assign('sel-range', String(l.range));
  assign('sel-color', rgbToHex(l.color));
  assign('sel-x', l.pos[0].toFixed(2));
  assign('sel-y', l.pos[1].toFixed(2));
  assign('sel-z', l.pos[2].toFixed(2));
  $('sel-intensity-val').textContent = fmt1(l.intensity);
  $('sel-range-val').textContent = fmt1(l.range) + ' m';
}

function bindSelectedPanel() {
  const uid = () => store.selectedUid;
  $('sel-on').addEventListener('change', (e) => store.toggleLight(uid(), e.target.checked));
  $('sel-solo').addEventListener('click', () => store.soloLight(uid()));
  $('sel-pin-global').addEventListener('change', (e) =>
    store.patchLight(uid(), { pinnedGlobal: e.target.checked }));
  $('sel-kind').addEventListener('change', (e) =>
    store.patchLight(uid(), { kind: e.target.value }));
  $('sel-intensity').addEventListener('input', (e) =>
    store.patchLight(uid(), { intensity: Number(e.target.value) }));
  $('sel-range').addEventListener('input', (e) =>
    store.patchLight(uid(), { range: Number(e.target.value) }));
  $('sel-color').addEventListener('input', (e) =>
    store.patchLight(uid(), { color: hexToRgb(e.target.value) }));
  for (const axis of ['x', 'y', 'z']) {
    $('sel-' + axis).addEventListener('input', (e) => {
      const l = store.selectedLight();
      if (!l) return;
      const pos = [...l.pos];
      const idx = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
      pos[idx] = Number(e.target.value);
      store.patchLight(l.uid, { pos });
    });
  }
}

// ------------------------------------------- delegated list/table actions ---
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  const uid = Number(el.dataset.uid);
  if (!Number.isFinite(uid)) return;
  if (action === 'select') {
    store.selectLight(uid);
    syncSelectedPanel(true);
    refreshInspector();
  } else if (action === 'solo') {
    store.soloLight(uid);
  } else if (action === 'toggle') {
    const l = store.lights.find((q) => q.uid === uid);
    store.toggleLight(uid, l ? !l.on : undefined);
  }
});
document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-action="row-check"]');
  if (!el) return;
  store.toggleLight(Number(el.dataset.uid), el.checked);
});

// ------------------------------------------------------------- controls -----
function bindControls() {
  $('light-count').addEventListener('input', (e) => {
    const n = Number(e.target.value);
    $('light-count-val').textContent = String(n);
    store.setLightCount(n);
  });
  $('preset-market').addEventListener('click', () => {
    store.loadPreset('market');
    $('light-count').value = String(store.lightCount);
    $('light-count-val').textContent = String(store.lightCount);
    builtToken = -1;
  });
  $('preset-stress').addEventListener('click', () => {
    store.loadPreset('stress');
    builtToken = -1;
  });
  $('btn-all-on').addEventListener('click', () => store.allLightsOn());

  $('strategy').addEventListener('change', (e) => store.setStrategy(e.target.value));
  const bindNum = (id, valId, key, fmt = (v) => String(v), opt = true) => {
    $(id).addEventListener('input', (e) => {
      const v = Number(e.target.value);
      if (valId) $(valId).textContent = fmt(v);
      if (opt) store.setOption(key, v);
    });
  };
  bindNum('cap-range', 'cap-val', 'capacity');
  bindNum('global-range', 'global-val', 'globalBudget');
  bindNum('index-range', 'index-val', 'totalIndexBudget', fmtInt);
  bindNum('wide-range', 'wide-val', 'wideThresholdClusters', fmtInt);
  $('tile-range').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    $('tile-val').textContent = String(v);
    overlay.pinnedId = null;
    store.setClusterSetting('tilePixels', v);
  });
  $('slices-range').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    $('slices-val').textContent = String(v);
    $('slice-range').max = String(v - 1);
    overlay.inspectSlice = Math.min(overlay.inspectSlice, v - 1);
    $('slice-range').value = String(overlay.inspectSlice);
    store.setClusterSetting('slices', v);
  });

  $('debug-mode').addEventListener('change', (e) => {
    store.setDebugMode(e.target.value === 'lit' ? 'lit' : Number(e.target.value));
  });
  $('partition-mode').addEventListener('change', (e) => {
    store.setPartition(e.target.value);
    overlay.pinnedId = null;
    refreshInspector(true);
  });
  $('slice-range').addEventListener('input', (e) => {
    overlay.inspectSlice = Number(e.target.value);
    $('slice-val').textContent = e.target.value;
    refreshInspector();
  });
  $('toggle-grid').addEventListener('change', (e) => { store.showGrid = e.target.checked; });
  $('toggle-handles').addEventListener('change', (e) => { store.showHandles = e.target.checked; });

  const cams = {
    street: { eye: [0, 7.2, 19], target: [0, 2.4, -12] },
    elevated: { eye: [0, 17, 27], target: [0, 1, -14] },
    foreground: { eye: [0, 5.2, 12.5], target: [0, 2.2, -2] },
    orbit: null,
  };
  function applyCam(key) {
    const c = store.cam;
    if (key === 'orbit') {
      c.target = [0, 2.2, -12]; c.yaw = 0.72; c.pitch = 0.2; c.distance = 34;
    } else {
      const preset = cams[key] || cams.street;
      c.eye = [...preset.eye];
      c.target = [...preset.target];
      // Derive orbit spherical from explicit eye/target.
      const d = vec3.sub(c.eye, c.target);
      c.distance = Math.hypot(d[0], d[1], d[2]);
      c.pitch = Math.asin(Math.max(-1, Math.min(1, d[1] / c.distance)));
      c.yaw = Math.atan2(-d[0], -d[2]);
    }
    store.cameraChanged();
  }
  $('cam-preset').addEventListener('change', (e) => applyCam(e.target.value));
  $('cam-reset').addEventListener('click', () => {
    $('cam-preset').value = 'street';
    applyCam('street');
  });

  $('btn-compare').addEventListener('click', runComparisonAndRender);
  $('btn-compare-2').addEventListener('click', runComparisonAndRender);
  $('btn-partition-compare').addEventListener('click', runPartitionComparisonAndRender);

  $('btn-help').addEventListener('click', () => $('help-modal').classList.remove('hidden'));
  $('help-close').addEventListener('click', () => $('help-modal').classList.add('hidden'));
  $('help-modal').addEventListener('click', (e) => {
    if (e.target === $('help-modal')) $('help-modal').classList.add('hidden');
  });

  $('btn-story').addEventListener('click', () => { playStory().catch((e) => window.__bootErrors.push('story:' + e.message)); });
  $('btn-budget-drill').addEventListener('click', () => { budgetDrill(); });
}

// ------------------------------------------------------------- comparison ---
function putPixels(canvas, rgba, w, h) {
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(w, h);
  img.data.set(rgba);
  ctx.putImageData(img, 0, 0);
}

async function runPartitionComparisonAndRender() {
  $('partition-status').textContent = '计算中（全灯参考 + 两种分区）…';
  $('btn-partition-compare').disabled = true;
  try {
    const r = await store.runPartitionComparison();
    if (!r) {
      $('partition-status').textContent = store.lastError || '对照失败';
      $('partition-metrics').textContent = store.lastError || '对照失败（详见状态栏）';
      return;
    }
    putPixels($('pcf-fixed'), r.fixed.rgba, r.width, r.height);
    putPixels($('pcf-adaptive'), r.adaptive.rgba, r.width, r.height);
    putPixels($('pcf-diff'), r.diff, r.width, r.height);
    drawPartitionSliceChart(r.fixed.perSlice, r.adaptive.perSlice);
    const fmtM = (m) => `${Number.isFinite(m.psnr) ? m.psnr.toFixed(2) + ' dB' : '∞（与全灯参考一致）'}  ` +
      `最大差 ${m.maxAbs}  差异像素 ${m.mismatchPixels}  漏光 ${m.coverageMissCount}`;
    const line = (label, d) => `${label}：${fmtM(d.metrics)}\n` +
      `    每像素灯数 均值 ${d.metrics.clusteredAvgPerPixel.toFixed(2)} 峰值 ${d.metrics.clusteredMaxPerPixel}  → 加速 ${d.metrics.speedup.toFixed(2)}×\n` +
      `    索引槽 ${d.stats.indexSlots}（${fmtBytes(d.stats.actualBufferBytes)}）最大簇存 ${d.stats.maxStoredOccupancy} 全局宽灯 ${d.stats.globalCount}` +
      (d.firstOverCapacity ? `\n    最先超容量簇 tile(${d.firstOverCapacity.tx},${d.firstOverCapacity.ty}) s${d.firstOverCapacity.slice} 原始 ${d.firstOverCapacity.rawCount}/${d.firstOverCapacity.capacity}` : '');
    $('partition-metrics').textContent =
      `当前灯群 ${store.lights.length} 盏 · 容量 C=${store.options.capacity} · 全局 G=${store.options.globalBudget}\n` +
      line('固定', r.fixed) + '\n' + line('自适应', r.adaptive) +
      `\n两分区逐像素差异 最大 ${r.partitionDiffMax} · 差异像素 ${r.partitionDiffPixels}（应接近 0：两者均对齐全灯参考）；` +
      `索引 ${r.fixed.stats.indexSlots} vs ${r.adaptive.stats.indexSlots} 槽`;
    const leaks = r.fixed.metrics.coverageMissCount + r.adaptive.metrics.coverageMissCount;
    $('partition-status').textContent = leaks === 0
      ? `完成：两分区均零漏光；索引 ${r.fixed.stats.indexSlots} vs ${r.adaptive.stats.indexSlots} 槽`
      : `⚠ 检测到 ${leaks} 次漏光（不应发生）`;
  } finally {
    $('btn-partition-compare').disabled = false;
  }
}

function drawPartitionSliceChart(fixedSlices, adaptiveSlices) {
  const cv = $('partition-slice-chart');
  if (!cv) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = cv.clientWidth || 640;
  const H = 180;
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const n = fixedSlices.length;
  const padL = 34, padR = 10, padT = 12, padB = 22;
  const maxV = Math.max(1, ...fixedSlices.map((s) => s.meanStored), ...adaptiveSlices.map((s) => s.meanStored));
  const bw = (W - padL - padR) / n;
  ctx.font = '9px ui-monospace, monospace';
  ctx.textBaseline = 'top';
  for (let s = 0; s < n; s++) {
    const x = padL + s * bw;
    const fh = (H - padT - padB) * (fixedSlices[s].meanStored / maxV);
    const ah = (H - padT - padB) * (adaptiveSlices[s].meanStored / maxV);
    ctx.fillStyle = '#3f8fd6';
    ctx.fillRect(x + 1, H - padB - fh, bw * 0.45, fh);
    ctx.fillStyle = '#ffd166';
    ctx.fillRect(x + bw * 0.5, H - padB - ah, bw * 0.45, ah);
    if (s % 4 === 0) {
      ctx.fillStyle = '#8fa0d0';
      ctx.fillText(String(s), x + 1, H - padB + 4);
    }
  }
  ctx.fillStyle = '#3f8fd6'; ctx.fillText('固定', padL, 0);
  ctx.fillStyle = '#ffd166'; ctx.fillText('自适应', padL + 40, 0);
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.beginPath(); ctx.moveTo(padL, H - padB + 0.5); ctx.lineTo(W - padR, H - padB + 0.5); ctx.stroke();
}

async function runComparisonAndRender() {
  $('compare-status').textContent = '计算中（CPU 全灯参考 + 分簇）…';
  $('btn-compare').disabled = true;
  $('btn-compare-2').disabled = true;
  try {
    const r = await store.runComparison();
    if (!r) { $('compare-status').textContent = '对比失败'; return; }
    putPixels($('cmp-ref'), r.ref.rgba, r.width, r.height);
    putPixels($('cmp-clu'), r.clu.rgba, r.width, r.height);
    putPixels($('cmp-diff'), r.diff, r.width, r.height);
    const m = r.metrics;
    $('compare-metrics').textContent =
`PSNR ${Number.isFinite(m.psnr) ? m.psnr.toFixed(2) + ' dB' : '∞（逐像素完全一致）'}   MSE ${m.mse.toExponential(2)}   最大差 ${m.maxAbs}
差异像素(>3) ${m.mismatchPixels}/${m.totalPixels}   覆盖漏光 ${m.coverageMissCount}
光照计算次数  参考 ${fmtInt(m.referenceIterations)}  →  分簇 ${fmtInt(m.clusteredIterations)}   加速 ${m.speedup.toFixed(2)}×
每像素循环灯数 参考上限 ${m.referenceMaxPerPixel}  分簇峰值 ${m.clusteredMaxPerPixel}（均值 ${m.clusteredAvgPerPixel.toFixed(2)}）
BRDF 求值     参考 ${fmtInt(m.refFullEvals)}  分簇 ${fmtInt(m.cluFullEvals)}`;
    $('compare-status').textContent = '完成：' +
      (m.coverageMissCount === 0 && m.maxAbs === 0 ? '图像完全一致，零漏光' : `最大差 ${m.maxAbs}，漏光 ${m.coverageMissCount}`);
    refreshStats();
  } finally {
    $('btn-compare').disabled = false;
    $('btn-compare-2').disabled = false;
  }
}

// ------------------------------------------------------------- narratives ---
let storyRun = 0;
function tween(duration, onStep) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    function frame(t) {
      const k = Math.min(1, (t - t0) / duration);
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      onStep(e, k);
      if (k < 1) requestAnimationFrame(frame); else resolve();
    }
    requestAnimationFrame(frame);
  });
}

async function playStory() {
  const run = ++storyRun;
  // Repeatable baseline: fresh market, comfortable-but-meaningful capacity.
  store.loadPreset('market');
  $('light-count').value = '128'; $('light-count-val').textContent = '128';
  store.setLightCount(128);
  $('strategy').value = 'hybrid'; store.setStrategy('hybrid');
  $('cap-range').value = '18'; $('cap-val').textContent = '18'; store.setOption('capacity', 18);
  builtToken = -1;

  // 1) The whole weak street row is switched off.
  store.turnOffGroup('row');
  await tween(350, () => {});
  if (run !== storyRun) return;

  // 2) Pull the street-spanning giant light close to the near plane.
  const hero = store.lights[0];
  store.selectLight(hero.uid);
  const from = [...hero.pos];
  const to = [0, 5.0, 15.6];
  await tween(1700, (e) => {
    if (run !== storyRun) return;
    store.patchLight(hero.uid, {
      pos: [from[0] + (to[0] - from[0]) * e, from[1] + (to[1] - from[1]) * e, from[2] + (to[2] - from[2]) * e],
    }, 'story-drag');
  });
  if (run !== storyRun) return;

  // 3) Pin the worst (max raw occupancy) cluster so the overflow is visible.
  let bestId = 0, bestRaw = -1;
  const raw = store.lastCandidate.rawCount;
  for (let id = 0; id < raw.length; id++) if (raw[id] > bestRaw) { bestRaw = raw[id]; bestId = id; }
  const dd = decodeCluster(store.cfg, bestId);
  overlay.pinnedId = bestId;
  overlay.inspectSlice = dd.s;
  $('slice-range').max = String(store.cfg.slices - 1);
  $('slice-range').value = String(dd.s);
  $('slice-val').textContent = String(dd.s);
  refreshInspector(true);
}

function budgetDrill() {
  // Deliberately impossible strict budget: kernel must refuse to publish and
  // keep the last complete frame while exposing pending clusters.
  storyRun++;
  $('strategy').value = 'strict';
  store.setStrategy('strict');
  $('cap-range').value = '8'; $('cap-val').textContent = '8';
  store.setOption('capacity', 8);
  // Drive the giant close so many foreground clusters overflow.
  const hero = store.lights[0];
  if (hero) store.patchLight(hero.uid, { pos: [0, 5.0, 15.6] });
  let bestId = 0, bestRaw = -1;
  const raw = store.lastCandidate?.rawCount;
  if (raw) for (let id = 0; id < raw.length; id++) if (raw[id] > bestRaw) { bestRaw = raw[id]; bestId = id; }
  if (raw) {
    const dd = decodeCluster(store.cfg, bestId);
    overlay.pinnedId = bestId; overlay.inspectSlice = dd.s;
    $('slice-range').value = String(dd.s); $('slice-val').textContent = String(dd.s);
  }
  refreshInspector(true);
}

// ------------------------------------------------------------- main loop ----
let lastT = performance.now();
let fpsEma = 60;
let drawMsEma = 0;
let hudAccum = 0;
window.__ticks = 0;

function frameLoop(t) {
  requestAnimationFrame(frameLoop); // always keep the loop alive
  window.__ticks++;
  const dt = Math.max(1, t - lastT);
  lastT = t;
  fpsEma = fpsEma * 0.92 + (1000 / dt) * 0.08;

  // Coalesce drag/orbit work to at most one kernel recompute per frame.
  try {
    if (gesture.mode === 'light' && gesture.nextPos) {
      const pos = gesture.nextPos;
      gesture.nextPos = null;
      store.patchLight(gesture.uid, { pos }, 'drag');
    }
  } catch (e) { reportPanelError('gesture', e); }

  const t0 = performance.now();
  let glErrorNow = null;
  if (renderer && store.published) {
    try {
      renderer.selectedUid = store.selectedUid;
      const mode = $('debug-mode').value === 'lit' ? 0 : Number($('debug-mode').value);
      renderer.render(store.published, mode);
    } catch (e) {
      glErrorNow = e && e.message ? e.message : String(e);
      window.__bootErrors.push('render:' + glErrorNow);
    }
  }
  if (renderer) drawMsEma = drawMsEma * 0.9 + (performance.now() - t0) * 0.1;
  if (glErrorNow && !renderer.__errorShown) {
    renderer.__errorShown = true;
    const fb = $('webgl-fallback');
    fb.classList.remove('hidden');
    fb.textContent = '渲染错误：' + glErrorNow;
  }

  try { overlay.draw(octx, store); } catch (e) { window.__bootErrors.push('overlay:' + e.message); }

  hudAccum += dt;
  if (hudAccum > 250) {
    hudAccum = 0;
    $('hud-fps').textContent = fpsEma.toFixed(0) + ' fps';
    $('hud-frame-ms').textContent = drawMsEma.toFixed(2) + ' ms';
  }
}

function reportPanelError(where, e) {
  window.__panelErrors = window.__panelErrors || [];
  const msg = where + ': ' + ((e && e.stack) ? e.stack : String(e));
  if (!window.__panelErrors.some((m) => m.startsWith(where + ':') && m.includes(String(e.message || e)))) {
    window.__panelErrors.push(msg);
    console.error('[' + where + ']', e);
  }
}

// DOM panels refresh on a timer independent of rAF so headless rAF throttling
// can never freeze the controls/inspector/status feedback.
function refreshDomPanels() {
  try { refreshStatus(); } catch (e) { reportPanelError('status', e); }
  try {
    buildLightRowsIfNeeded();
    refreshStats();
    refreshInspector(false);
    refreshLightRowsMeta();
    syncSelectedPanel(false);
  } catch (e) { reportPanelError('panel', e); }
}

store.subscribe(() => { /* timer + rAF pull latest state */ });

bindControls();
syncSelectedPanel(true);
refreshStatus();
buildLightRowsIfNeeded();
refreshDomPanels();
setInterval(refreshDomPanels, 160);
requestAnimationFrame(frameLoop);

// Headless / automation + debugging hook.
window.__clusterLab = {
  store,
  get renderer() { return renderer; },
  overlay,
  runComparison: runComparisonAndRender,
  runPartitionComparison: runPartitionComparisonAndRender,
  playStory,
  budgetDrill,
  setPartition(p) {
    store.setPartition(p);
    $('partition-mode').value = p;
    overlay.pinnedId = null;
    refreshInspector(true);
  },
  pickClusterAtClient(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    pickClusterAt(((clientX - r.left) / r.width) * store.cfg.width,
      ((clientY - r.top) / r.height) * store.cfg.height);
  },
  handleClientXY,
  clusterView: (id) => getClusterView(store.published, id),
  async pointerDragUid(uid, toClientX, toClientY, steps = 12) {
    const from = handleClientXY(uid);
    if (!from) throw new Error('handle not visible for uid ' + uid);
    canvas.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, pointerId: 1, clientX: from.x, clientY: from.y,
    }));
    for (let i = 1; i <= steps; i++) {
      const x = from.x + (toClientX - from.x) * (i / steps);
      const y = from.y + (toClientY - from.y) * (i / steps);
      canvas.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true, pointerId: 1, clientX: x, clientY: y,
      }));
      await new Promise((r) => setTimeout(r, 24));
    }
    canvas.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true, pointerId: 1, clientX: toClientX, clientY: toClientY,
    }));
  },
};
window.__labReady = true;
document.documentElement.dataset.labReady = '1';
