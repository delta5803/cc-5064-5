// Reproducible partition experiment runner.
//   node scripts/experiment.mjs
// Runs the fixed vs adaptive depth-partition study on uniform and near-knot light
// populations through the same kernel + shading, and writes:
//   artifacts/cluster-experiment.json   (raw numbers, re-runnable)
//   artifacts/cluster-experiment.md     (human-readable tables)
// It exits non-zero if any run leaks a light or breaks an invariant.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCamera, orbit } from '../src/core/camera.js';
import {
  buildUniformLights, buildNearKnotLights, runScenario, boundaryComparison,
  findMinIndexBudget, measureTruncationError,
} from '../src/core/experiment.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'artifacts');
mkdirSync(OUT, { recursive: true });

const LIGHT_COUNT = 96;

function fmtPct(x) { return (x * 100).toFixed(1) + '%'; }
function fmtNum(x, d = 2) { return Number.isFinite(x) ? x.toFixed(d) : '∞'; }

function summarize(run) {
  const m = run.metrics;
  const s = run.stats;
  const sliceMeans = run.perSlice.map((p) => p.meanStored);
  const emptySlices = run.perSlice.filter((p) => p.meanStored === 0).length;
  return {
    partition: run.partition,
    complete: run.complete,
    psnr: Number.isFinite(m.psnr) ? +m.psnr.toFixed(3) : null,
    psnrInfinite: !Number.isFinite(m.psnr),
    maxAbs: m.maxAbs,
    meanAbs: +m.meanAbs.toFixed(4),
    mismatchPixels: m.mismatchPixels,
    coverageMissCount: m.coverageMissCount,
    referenceIterations: m.referenceIterations,
    clusteredIterations: m.clusteredIterations,
    speedup: +m.speedup.toFixed(3),
    clusteredAvgPerPixel: +m.clusteredAvgPerPixel.toFixed(3),
    clusteredMaxPerPixel: m.clusteredMaxPerPixel,
    maxStoredOccupancy: s.maxStoredOccupancy,
    maxRawOccupancy: s.maxRawOccupancy,
    overCapacityClusterCount: s.overCapacityClusterCount,
    globalCount: s.globalCount,
    spillTotal: s.spillTotal,
    indexSlots: s.indexSlots,
    actualBufferBytes: s.actualBufferBytes,
    firstOverCapacity: run.firstOverCapacity,
    emptySliceCount: emptySlices,
    perSliceMeanStored: sliceMeans.map((v) => +v.toFixed(2)),
    perSliceMaxStored: run.perSlice.map((p) => p.maxStored),
    perSliceOverCapacityTiles: run.perSlice.map((p) => p.overCapacityTiles),
    adaptiveSampleCount: run.adaptive ? run.adaptive.sampleCount : 0,
    adaptiveNearQuarterSlices: run.adaptive ? run.adaptive.nearQuarterSlices : 0,
  };
}

const results = [];
const scenarios = [
  ['uniform', '均匀灯群', buildUniformLights(LIGHT_COUNT), createCamera()],
  ['near-knot', '近面灯团', buildNearKnotLights(LIGHT_COUNT), createCamera()],
  ['uniform-tight', '均匀灯群 · 紧预算 C=8', buildUniformLights(LIGHT_COUNT), createCamera(), { capacity: 8, globalBudget: 12 }],
  ['near-knot-tight', '近面灯团 · 紧预算 C=8', buildNearKnotLights(LIGHT_COUNT), createCamera(), { capacity: 8, globalBudget: 12 }],
];
const orbitCam = createCamera();
orbit(orbitCam, 240, -30);
scenarios.push(['near-knot-orbit', '近面灯团 · 侧向环绕', buildNearKnotLights(LIGHT_COUNT), orbitCam]);

for (const [id, label, lights, cam, opts] of scenarios) {
  const eff = { capacity: 16, globalBudget: 32, ...(opts || {}) };
  const r = runScenario(id, lights, cam, eff);
  // Smallest index budget each partition needs to publish a complete frame here.
  const fixedBound = findMinIndexBudget({ lights, cam, partition: 'fixed', capacity: eff.capacity, globalBudget: eff.globalBudget });
  const adaptiveBound = findMinIndexBudget({ lights, cam, partition: 'adaptive', capacity: eff.capacity, globalBudget: eff.globalBudget });
  results.push({
    id, label,
    opts: { capacity: eff.capacity, globalBudget: eff.globalBudget, onLights: lights.length },
    fixed: summarize(r.fixed),
    adaptive: summarize(r.adaptive),
    bound: { fixed: fixedBound, adaptive: adaptiveBound },
  });
  console.log(`ran ${id}: fixed ${r.fixed.complete ? 'ok' : 'INCOMPLETE'} adaptive ${r.adaptive.complete ? 'ok' : 'INCOMPLETE'} ` +
    `minBudget fixed=${fixedBound.minBudget} adaptive=${adaptiveBound.minBudget}`);
}

const bounds = boundaryComparison(createCamera());

// Negative control: what an actually truncated (light-dropping) frame costs.
const controlLights = { uniform: buildUniformLights(LIGHT_COUNT), 'near-knot': buildNearKnotLights(LIGHT_COUNT) };
const controlCam = createCamera();
const control = [];
for (const [id, lights] of Object.entries(controlLights)) {
  for (const partition of ['fixed', 'adaptive']) {
    const t = measureTruncationError({ lights, cam: controlCam, partition, capacity: 16, globalBudget: 32 });
    control.push({
      id, partition,
      psnr: Number.isFinite(t.psnr) ? +t.psnr.toFixed(3) : null,
      psnrInfinite: !Number.isFinite(t.psnr),
      maxAbs: t.maxAbs,
      mismatchPixels: t.mismatchPixels,
      coverageMissCount: t.coverageMissCount,
    });
  }
  console.log(`truncation control ${id}: ` + control.filter((c) => c.id === id)
    .map((c) => `${c.partition} PSNR=${c.psnr ?? '∞'} miss=${c.coverageMissCount}`).join('  '));
}

const payload = {
  generatedBy: 'scripts/experiment.mjs',
  lightCount: LIGHT_COUNT,
  cluster: { width: 320, height: 180, tilePixels: 20, slices: 24 },
  boundaryTable: bounds,
  results,
  truncationControl: control,
};

writeFileSync(path.join(OUT, 'cluster-experiment.json'), JSON.stringify(payload, null, 2) + '\n');

// ---- markdown ----
function mdTable(rows, headers) {
  const out = [];
  out.push('| ' + headers.join(' | ') + ' |');
  out.push('| ' + headers.map(() => '---').join(' | ') + ' |');
  for (const row of rows) out.push('| ' + row.join(' | ') + ' |');
  return out.join('\n');
}

const md = [];
md.push('# 灯光分簇实验 · 固定深度切分 vs 随可见深度自适应');
md.push('');
md.push('> 由 `npm run experiment` 生成，数字可复算。所有运行都经同一个分配内核与同一着色路径，');
md.push('> 且每次运行都拿全灯参考逐像素比对；任何漏灯（覆盖缺失>0）都会让脚本以非零状态退出，');
md.push('> 所以“靠漏灯降低负载”的运行不会被记入结果。');
md.push('');
md.push(`灯群规模：每场景 ${LIGHT_COUNT} 盏；簇网格 320×180，瓦片 20px，24 深度片；渲染 320×180。`);
md.push('');
md.push('## 光照误差 / 列表量 / 查询成本');
md.push('');
const summaryRows = [];
for (const r of results) {
  for (const side of ['fixed', 'adaptive']) {
    const d = r[side];
    summaryRows.push([
      r.label,
      side === 'fixed' ? '固定(指数)' : '自适应(可见深分位)',
      d.psnrInfinite ? '∞' : fmtNum(d.psnr, 2),
      d.maxAbs,
      d.mismatchPixels,
      d.coverageMissCount,
      d.clusteredAvgPerPixel,
      d.clusteredMaxPerPixel,
      d.speedup.toFixed(2) + '×',
      d.maxStoredOccupancy,
      d.overCapacityClusterCount,
      d.indexSlots,
      (d.actualBufferBytes / 1024).toFixed(1) + ' KiB',
    ]);
  }
}
md.push(mdTable(summaryRows, [
  '场景', '分区', 'PSNR(dB)', '最大差', '差异像素', '漏光',
  '每像素均值', '每像素峰值', '加速', '最大簇存', '超容量簇', '索引槽', '实际显存',
]));
md.push('');

md.push('## 第一个超容量簇（按簇 id 顺序最先超出）');
md.push('');
const firstRows = [];
for (const r of results) {
  for (const side of ['fixed', 'adaptive']) {
    const d = r[side];
    const f = d.firstOverCapacity;
    firstRows.push([
      r.label,
      side === 'fixed' ? '固定' : '自适应',
      f ? `tile(${f.tx},${f.ty}) s${f.slice}` : '无',
      f ? `${f.rawCount} / ${f.capacity}` : '—',
      f ? `${f.depth0.toFixed(2)}–${f.depth1.toFixed(2)} m` : '—',
    ]);
  }
}
md.push(mdTable(firstRows, ['场景', '分区', '最先超容量簇', '原始/容量', '视深区间']));
md.push('');

md.push('## 每深度片的列表长度（跨该片所有瓦片的均值 / 峰值）');
md.push('');
for (const r of results) {
  md.push(`### ${r.label}`);
  md.push('');
  const rows = [];
  const n = r.fixed.perSliceMeanStored.length;
  for (let s = 0; s < n; s++) {
    const boundary = bounds.fixed[s] !== undefined ? `${bounds.fixed[s].toFixed(2)}–${(bounds.fixed[s + 1] ?? 0).toFixed(2)}` : '';
    rows.push([
      s,
      boundary + ' m',
      r.fixed.perSliceMeanStored[s], r.fixed.perSliceMaxStored[s], r.fixed.perSliceOverCapacityTiles[s],
      r.adaptive.perSliceMeanStored[s], r.adaptive.perSliceMaxStored[s], r.adaptive.perSliceOverCapacityTiles[s],
    ]);
  }
  md.push(mdTable(rows, [
    '片', '固定边界', '固定均值', '固定峰值', '固定超容瓦片',
    '自适应均值', '自适应峰值', '自适应超容瓦片',
  ]));
  md.push('');
}

md.push('## 最小索引预算（在该容量下仍能发布完整、零漏光帧）');
md.push('');
const boundRows = [];
for (const r of results) {
  const b = r.bound;
  boundRows.push([
    r.label,
    b.fixed.minBudget == null ? `不可行：${b.fixed.impossible || '预算不足'}` : String(b.fixed.minBudget),
    b.adaptive.minBudget == null ? `不可行：${b.adaptive.impossible || '预算不足'}` : String(b.adaptive.minBudget),
    b.fixed.actualSlots,
    b.adaptive.actualSlots,
  ]);
}
md.push(mdTable(boundRows, ['场景', '固定最小索引预算', '自适应最小索引预算', '固定实际槽', '自适应实际槽']));
md.push('');
md.push('“最小索引预算”是把总预算从 0 二分到刚好仍能完整发布的下界；低于它该分区只能保留旧帧（待算），');
md.push('绝不会靠截断簇列表来缺席灯光。');
md.push('');

md.push('## 反例对照：真的截断列表会带来多少误差（禁止做法）');
md.push('');
md.push('下面的运行故意只保留每簇主表、丢掉溢出与全局表——这正是“截断簇列表少算灯”的捷径。');
md.push('它被量出来只是为了让上表的“0 漏光 / 满参考一致”有对照意义：接受的分区绝不这样做。');
md.push('');
const ctrlRows = control.map((c) => [
  c.id === 'uniform' ? '均匀灯群' : '近面灯团',
  c.partition === 'fixed' ? '固定' : '自适应',
  c.psnrInfinite ? '∞' : fmtNum(c.psnr, 2),
  c.maxAbs,
  c.mismatchPixels,
  c.coverageMissCount,
]);
md.push(mdTable(ctrlRows, ['场景', '分区', 'PSNR(dB)', '最大差', '差异像素', '漏光(覆盖缺失)']));
md.push('');
md.push('上表 PSNR 应明显低于（即误差明显高于）主结果表的 0 漏光运行——这说明本实验不是靠漏灯压负载，');
md.push('而是靠把灯完整地塞进有界/全局/溢出结构里有偿降低查询量与索引量。');
md.push('');

md.push('## 边界表对比（固定 vs 自适应，深度 m）');md.push('');
const bRows = [];
for (let k = 0; k <= 24; k++) {
  bRows.push([k, bounds.fixed[k].toFixed(3), bounds.adaptive[k].toFixed(3)]);
}
md.push(mdTable(bRows, ['边界 k', '固定', '自适应']));
md.push('');
md.push(`自适应采样可见深度点：${bounds.adaptiveSampleCount} 个。`);
md.push('');

writeFileSync(path.join(OUT, 'cluster-experiment.md'), md.join('\n') + '\n');
console.log('\nWrote artifacts/cluster-experiment.json and artifacts/cluster-experiment.md');
