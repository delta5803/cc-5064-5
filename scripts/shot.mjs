// Headless-browser validation + screenshots of the real UI.
//   node scripts/shot.mjs
// Boots serve.mjs on a test port, drives Chromium (SwiftShader WebGL2),
// exercises story / budget-pending / debug modes / comparison / real drag /
// per-light toggle, and fails on uncaught page or shader/link errors.
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'artifacts');
mkdirSync(OUT, { recursive: true });
const PORT = Number(process.env.SHOT_PORT) || 5199;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'serve.mjs'), String(PORT)], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let url = `http://localhost:${PORT}/`;
    const timer = setTimeout(() => reject(new Error('server start timeout')), 8000);
    child.stdout.on('data', (buf) => {
      const m = String(buf).match(/Interface\s*:\s*(http:\/\/localhost:\d+\/)/);
      if (m) { clearTimeout(timer); url = m[1]; resolve({ child, url }); }
    });
    child.stderr.on('data', (b) => process.stderr.write('[serve] ' + b));
    child.on('exit', (code) => { if (code && code !== 0) reject(new Error('serve exited ' + code)); });
  });
}

const hardErrors = [];
const consoleErrors = [];
const badResponses = [];

async function setRange(page, id, value) {
  await page.$eval(id, (el, v) => {
    el.value = String(v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

async function main() {
  const { child, url } = await startServer();
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      protocolTimeout: 120000,
      env: (() => {
        const extraLibs = [
          '/tmp/chromelibs/lib',
          '/tmp/chromelibs/usr/lib/aarch64-linux-gnu',
          '/tmp/chromelibs/lib/aarch64-linux-gnu',
        ].filter((p) => existsSync(p));
        if (!extraLibs.length) return process.env;
        return { ...process.env, LD_LIBRARY_PATH: [...extraLibs, process.env.LD_LIBRARY_PATH || ''].join(':') };
      })(),
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu-sandbox',
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--ignore-gpu-blocklist',
        '--window-size=1680,1050',
      ],
      defaultViewport: { width: 1680, height: 1050, deviceScaleFactor: 1 },
    });
    const page = await browser.newPage();

    page.on('pageerror', (e) => hardErrors.push('pageerror: ' + (e.stack || e.message)));
    page.on('console', (msg) => {
      const text = msg.text();
      if (msg.type() === 'error') {
        consoleErrors.push(text);
        if (/Shader compile|Program link|Uncaught|Failed to fetch dynamically imported module|is not a function|Cannot read propert/i.test(text)) {
          hardErrors.push('console.error: ' + text);
        }
      }
    });
    page.on('response', (res) => {
      const u = res.url();
      if (res.status() >= 400 && /\/src\/|main\.js|serve\.mjs/.test(u)) {
        badResponses.push(res.status() + ' ' + u);
      }
    });

    console.log('→ loading', url);
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 });
    await page.waitForFunction('window.__labReady === true', { timeout: 30000 });
    await sleep(1800); // let first frames + 140ms panels populate

    const bootErrors = await page.evaluate(() => window.__bootErrors || []);
    if (bootErrors.length) hardErrors.push(...bootErrors.map((e) => 'boot: ' + e));

    const glInfo = await page.evaluate(() => {
      const r = window.__clusterLab?.renderer;
      if (!r) return { ok: false };
      const gl = r.gl;
      // Sample the framebuffer for a rough non-black / variance signal.
      const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
      const px = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let sum = 0, sum2 = 0, n = 0, nonBg = 0;
      for (let i = 0; i < px.length; i += 4 * 997) { // sparse sample
        const lum = (px[i] + px[i + 1] + px[i + 2]) / 3;
        sum += lum; sum2 += lum * lum; n++;
        if (lum > 24) nonBg++;
      }
      return {
        ok: true,
        version: gl.getParameter(gl.VERSION),
        renderer: gl.getParameter(gl.RENDERER),
        drawCalls: r.drawCalls,
        mean: sum / n,
        variance: sum2 / n - (sum / n) ** 2,
        brightFraction: nonBg / n,
        hudVersion: document.querySelector('#hud-version').textContent,
        status: document.querySelector('#status-text').textContent,
        panelErrors: window.__panelErrors || [],
      };
    });
    console.log('GL info:', JSON.stringify(glInfo, null, 0));
    if (!glInfo.ok) hardErrors.push('WebGL renderer did not initialize in browser');
    if (glInfo.panelErrors?.length) hardErrors.push(...glInfo.panelErrors.map((e) => 'panel: ' + String(e).slice(0, 300)));
    else if (glInfo.variance < 4 || glInfo.brightFraction < 0.01) {
      hardErrors.push(`frame looks blank: mean=${glInfo.mean?.toFixed(1)} variance=${glInfo.variance?.toFixed(1)} bright=${glInfo.brightFraction?.toFixed(3)}`);
    }

    await page.screenshot({ path: path.join(OUT, 'ui-01-overview.png') });
    const stage = await page.$('#stage');
    await stage.screenshot({ path: path.join(OUT, 'ui-02-lit-stage.png') });

    // ---- Story: row off + giant pulled close -----------------------------
    console.log('→ play story');
    await page.click('#btn-story');
    await sleep(4200);
    const storyState = await page.evaluate(() => ({
      pending: !!window.__store.pending,
      version: window.__store.version,
      status: document.querySelector('#status-text').textContent,
      pinned: window.__clusterLab.overlay.pinnedId,
      clusterInfo: document.querySelector('#cluster-info').textContent.slice(0, 260),
    }));
    console.log('story:', JSON.stringify(storyState));
    await page.screenshot({ path: path.join(OUT, 'ui-03-story.png') });
    await stage.screenshot({ path: path.join(OUT, 'ui-04-story-stage.png') });

    // Stats / histogram / wide-light memory decision card.
    await page.evaluate(() => document.querySelector('#stats-card')?.scrollIntoView({ block: 'start' }));
    await sleep(350);
    const statsOk = await page.evaluate(() => ({
      cards: document.querySelectorAll('#stat-grid .stat').length,
      decision: /宽灯决策/.test(document.querySelector('#global-list')?.textContent || ''),
      globals: document.querySelectorAll('#global-list .chip').length,
    }));
    console.log('stats card:', JSON.stringify(statsOk));
    if (statsOk.cards < 12) hardErrors.push('stats grid did not populate');
    if (!statsOk.decision) hardErrors.push('wide-light memory decision not rendered');
    await page.screenshot({ path: path.join(OUT, 'ui-14-stats.png') });
    await page.evaluate(() => document.querySelector('.inspector')?.scrollIntoView({ block: 'start' }));

    // ---- Budget drill: strict cap 8 must retain the old complete frame --
    console.log('→ budget drill');
    await page.click('#btn-budget-drill');
    await sleep(700);
    const pendingState = await page.evaluate(() => ({
      pending: !!window.__store.pending,
      pendingClusters: window.__store.pending?.pendingClusterIds?.length || 0,
      bannerVisible: !document.querySelector('#pending-banner').classList.contains('hidden'),
      strategy: window.__store.options.strategy,
      cap: window.__store.options.capacity,
    }));
    console.log('pending:', JSON.stringify(pendingState));
    if (!pendingState.pending || pendingState.pendingClusters === 0) {
      hardErrors.push('budget drill did not produce pending clusters');
    }
    if (!pendingState.bannerVisible) hardErrors.push('pending banner not shown');
    await stage.screenshot({ path: path.join(OUT, 'ui-05-pending.png') });

    // ---- Recover with hybrid, then debug raster modes --------------------
    await page.select('#strategy', 'hybrid');
    await setRange(page, '#cap-range', 24);
    await sleep(600);
    const recovered = await page.evaluate(() => !window.__store.pending);
    if (!recovered) hardErrors.push('hybrid/cap24 did not recover a complete frame');

    await page.select('#debug-mode', '1');
    await sleep(500);
    await stage.screenshot({ path: path.join(OUT, 'ui-06-heat.png') });
    await page.select('#debug-mode', '2');
    await sleep(400);
    await stage.screenshot({ path: path.join(OUT, 'ui-07-depth-bands.png') });
    await page.select('#debug-mode', '4');
    await sleep(300);
    await stage.screenshot({ path: path.join(OUT, 'ui-08-linear-depth-debug.png') });
    await page.select('#debug-mode', 'lit');
    await sleep(300);

    // ---- Real pointer drag of a visible hero handle -----------------------
    const before = await page.evaluate(() => {
      const lab = window.__clusterLab;
      const tryUid = (uid) => {
        const xy = lab.handleClientXY(uid);
        const l = window.__store.lights.find((q) => q.uid === uid);
        return xy && xy.visible && l ? { uid, pos: [...l.pos], version: window.__store.version, xy } : null;
      };
      const sel = tryUid(window.__store.selectedUid);
      if (sel) return sel;
      for (const l of window.__store.lights) {
        if (l.group === 'hero') { const hit = tryUid(l.uid); if (hit) return hit; }
      }
      for (const l of window.__store.lights) { const hit = tryUid(l.uid); if (hit) return hit; }
      return null;
    });
    if (!before) hardErrors.push('no projectable light handle for drag');
    else {
      const r = await page.$eval('#overlay', (c) => {
        const b = c.getBoundingClientRect();
        return { left: b.left, top: b.top, w: b.width, h: b.height };
      });
      const tx = r.left + r.w * 0.62;
      const ty = r.top + r.h * 0.42;
      await page.mouse.move(before.xy.x, before.xy.y);
      await sleep(60);
      await page.mouse.down();
      for (let i = 1; i <= 14; i++) {
        await page.mouse.move(
          before.xy.x + (tx - before.xy.x) * (i / 14),
          before.xy.y + (ty - before.xy.y) * (i / 14),
        );
        await sleep(28);
      }
      await page.mouse.up();
      await sleep(400);
      const after = await page.evaluate((uid) => {
        const l = window.__store.lights.find((q) => q.uid === uid);
        return { pos: [...l.pos], version: window.__store.version, pending: !!window.__store.pending };
      }, before.uid);
      console.log('drag before/after:', JSON.stringify(before.pos), '→', JSON.stringify(after.pos), 'v', before.version, '→', after.version);
      if (after.version <= before.version) hardErrors.push('drag did not publish a new frame version');
      if (Math.hypot(...after.pos.map((v, i) => v - before.pos[i])) < 0.5) {
        hardErrors.push('real pointer drag did not move the light meaningfully');
      }
      await stage.screenshot({ path: path.join(OUT, 'ui-09-after-drag.png') });
    }

    // ---- Cluster pick + per-light toggle attribution ---------------------
    await page.evaluate(() => {
      const c = document.querySelector('#overlay').getBoundingClientRect();
      window.__clusterLab.pickClusterAtClient(c.left + c.width * 0.32, c.top + c.height * 0.82);
    });
    await sleep(350);
    const inspector = await page.evaluate(() => ({
      rows: document.querySelectorAll('#contrib-list .contrib-row').length,
      chips: document.querySelectorAll('#cluster-light-list .chip').length,
      info: document.querySelector('#cluster-info').textContent.slice(0, 200),
    }));
    console.log('inspector:', JSON.stringify(inspector));
    if (inspector.chips === 0) hardErrors.push('cluster inspector lists no lights for picked surface');
    await page.evaluate(() => document.querySelector('.inspector')?.scrollIntoView({ block: 'start' }));
    await sleep(200);
    await page.screenshot({ path: path.join(OUT, 'ui-10-inspector.png') });

    const hasToggle = await page.$('#contrib-list [data-action="toggle"]');
    if (hasToggle) {
      const name = await page.$eval('#contrib-list .contrib-row [data-action="select"]', (e) => e.textContent.trim());
      const uid = await page.$eval('#contrib-list .contrib-row:first-child [data-action="toggle"]', (e) => Number(e.dataset.uid));
      await page.click('#contrib-list .contrib-row:first-child [data-action="toggle"]');
      // The kernel must flip the light off immediately...
      await page.waitForFunction((u) => window.__store.lights.find((l) => l.uid === u)?.on === false,
        { timeout: 5000 }, uid);
      // ...and the independent panel timer must reflect the off row.
      let offRows = 0;
      try {
        await page.waitForFunction(() => document.querySelectorAll('#contrib-list .contrib-row.off').length >= 1,
          { timeout: 5000 });
        offRows = await page.evaluate(() => document.querySelectorAll('#contrib-list .contrib-row.off').length);
      } catch { offRows = await page.evaluate(() => document.querySelectorAll('#contrib-list .contrib-row.off').length); }
      const toggled = await page.evaluate(() => ({
        offRows: document.querySelectorAll('#contrib-list .contrib-row.off').length,
        storeStatus: window.__store.status.text,
        ticks: window.__ticks,
      }));
      console.log('toggled off source:', name, JSON.stringify(toggled));
      if (toggled.offRows < 1) hardErrors.push('toggled light did not get an off contribution row');
      await page.screenshot({ path: path.join(OUT, 'ui-11-after-source-off.png') });
      // Switch it back on via the same row button to prove reversibility.
      await page.click('#contrib-list .contrib-row.off [data-action="toggle"]');
      await page.waitForFunction((u) => window.__store.lights.find((l) => l.uid === u)?.on === true,
        { timeout: 5000 }, uid);
    } else {
      hardErrors.push('no contribution toggle button found');
    }

    // ---- Reference comparison --------------------------------------------
    console.log('→ run comparison');
    await page.evaluate(() => window.__clusterLab.runComparison());
    await sleep(300);
    const metrics = await page.$eval('#compare-metrics', (e) => e.textContent);
    console.log('metrics:\n' + metrics);
    if (!/完全一致|PSNR/.test(metrics)) hardErrors.push('comparison did not produce metrics');
    const cmpPanel = await page.$('.compare-panel');
    await cmpPanel.screenshot({ path: path.join(OUT, 'ui-12-compare.png') });

    // ---- Depth partition: fixed vs adaptive through the same shader -------
    console.log('→ adaptive partition + live comparison');
    // Switch the live kernel to adaptive; it must still publish a complete frame.
    await page.select('#partition-mode', 'adaptive');
    await sleep(500);
    const adaptiveState = await page.evaluate(() => {
      const s = window.__store;
      const f = s.published;
      return {
        partition: s.partition,
        cfgPartition: s.cfg.partition,
        boundaries: Array.from(s.cfg.boundaries).slice(0, 4).map((v) => +v.toFixed(2)),
        hasInfo: !!s.adaptiveInfo && s.adaptiveInfo.sampleCount > 0,
        version: s.version,
        pending: !!s.pending,
        hud: document.querySelector('#hud-strategy').textContent,
      };
    });
    console.log('adaptive:', JSON.stringify(adaptiveState));
    if (adaptiveState.cfgPartition !== 'adaptive') hardErrors.push('adaptive partition not applied to cfg');
    if (!adaptiveState.hasInfo) hardErrors.push('adaptive depth sampling produced no samples');
    if (adaptiveState.pending) hardErrors.push('adaptive partition failed to publish a complete frame');
    await stage.screenshot({ path: path.join(OUT, 'ui-15-adaptive-stage.png') });

    // Cluster inspector must reflect the adaptive partitioning scheme.
    await page.evaluate(() => {
      const c = document.querySelector('#overlay').getBoundingClientRect();
      window.__clusterLab.pickClusterAtClient(c.left + c.width * 0.5, c.top + c.height * 0.8);
    });
    await sleep(350);
    const adaptiveInspector = await page.$eval('#cluster-info', (e) => e.textContent);
    if (!/分区=自适应/.test(adaptiveInspector)) hardErrors.push('inspector did not report adaptive partition');

    // Run the live fixed-vs-adaptive comparison panel (same kernel + shading).
    await page.evaluate(() => document.querySelector('#partition-panel')?.scrollIntoView({ block: 'start' }));
    await page.click('#btn-partition-compare');
    await page.waitForFunction(() => {
      const t = document.querySelector('#partition-status')?.textContent || '';
      return /完成|失败|漏光/.test(t);
    }, { timeout: 60000 });
    await sleep(300);
    const partitionState = await page.evaluate(() => {
      const pm = document.querySelector('#partition-metrics')?.textContent || '';
      const ps = document.querySelector('#partition-status')?.textContent || '';
      // Are the comparison canvases actually painted (non-uniform)?
      const sample = (id) => {
        const cv = document.getElementById(id);
        const ctx = cv.getContext('2d');
        const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
        let sum = 0, sum2 = 0, n = 0;
        for (let i = 0; i < d.length; i += 4 * 137) { sum += d[i]; sum2 += d[i] * d[i]; n++; }
        const mean = sum / n;
        return { mean, variance: sum2 / n - mean * mean };
      };
      return {
        status: ps, metrics: pm.slice(0, 400),
        fixed: sample('pcf-fixed'), adaptive: sample('pcf-adaptive'), diff: sample('pcf-diff'),
        error: window.__store.lastError || '',
      };
    });
    console.log('partition:', JSON.stringify(partitionState));
    if (!/完成/.test(partitionState.status)) hardErrors.push('partition comparison did not report success: ' + partitionState.status);
    if (/检测到/.test(partitionState.status)) hardErrors.push('partition comparison reported light leakage: ' + partitionState.status);
    if (partitionState.fixed.variance < 4) hardErrors.push('fixed partition image looks blank');
    if (partitionState.adaptive.variance < 4) hardErrors.push('adaptive partition image looks blank');
    if (!/固定|自适应/.test(partitionState.metrics)) hardErrors.push('partition metrics did not list both schemes');
    if (partitionState.error) hardErrors.push('partition comparison error: ' + partitionState.error);
    await page.screenshot({ path: path.join(OUT, 'ui-16-partition-compare.png') });

    // Move a light while in adaptive mode: the lit image and per-cluster light
    // list must both come from the real recomputed kernel.
    const adaptiveDrag = await page.evaluate(async () => {
      const lab = window.__clusterLab;
      const uid = window.__store.selectedUid;
      const before = lab.handleClientXY(uid);
      const l0 = window.__store.lights.find((q) => q.uid === uid);
      if (!before || !l0) return { skipped: true };
      const v0 = window.__store.version;
      lab.store.patchLight(uid, { pos: [l0.pos[0] + 1.5, l0.pos[1], l0.pos[2] - 1.5] }, 'shot-adaptive-move');
      await new Promise((r) => setTimeout(r, 120));
      const f = window.__store.published;
      return {
        skipped: false, v0, v1: f.version, partition: f.cfg.partition,
        pending: !!window.__store.pending,
        boundaries: Array.from(f.cfg.boundaries).slice(0, 3).map((x) => +x.toFixed(2)),
      };
    });
    console.log('adaptive move:', JSON.stringify(adaptiveDrag));
    if (!adaptiveDrag.skipped) {
      if (adaptiveDrag.v1 <= adaptiveDrag.v0) hardErrors.push('adaptive light move did not publish a new frame');
      if (adaptiveDrag.pending) hardErrors.push('adaptive light move left the frame pending');
      if (adaptiveDrag.partition !== 'adaptive') hardErrors.push('adaptive move republished under the wrong partition');
    }

    // Restore the fixed partition for the remaining checks.
    await page.select('#partition-mode', 'fixed');
    await sleep(300);

    // ---- Help modal -------------------------------------------------------
    await page.click('#btn-help');
    await sleep(200);
    await page.screenshot({ path: path.join(OUT, 'ui-13-help.png') });
    await page.click('#help-close');

    // ---- Light count slider drives the real kernel ------------------------
    await setRange(page, '#light-count', 40);
    await page.waitForFunction(() => document.querySelectorAll('#light-rows .light-row').length === 40,
      { timeout: 5000 });
    const countState = await page.evaluate(() => ({
      lights: window.__store.lights.length,
      rows: document.querySelectorAll('#light-rows .light-row').length,
      onLightsStat: document.querySelector('#stat-grid .stat .v')?.textContent,
    }));
    console.log('count=40:', JSON.stringify(countState));
    if (countState.lights !== 40 || countState.rows !== 40) hardErrors.push('light count slider did not drive real light/row count');

    console.log('\nConsole errors (' + consoleErrors.length + '):');
    for (const e of consoleErrors.slice(0, 20)) console.log('  •', e.slice(0, 300));
    const finalPanelErrors = await page.evaluate(() => window.__panelErrors || []);
    if (finalPanelErrors.length) hardErrors.push(...finalPanelErrors.map((e) => 'panel-final: ' + String(e).slice(0, 300)));
    if (badResponses.length) {
      console.log('Bad script responses:', badResponses);
      hardErrors.push(...badResponses);
    }
  } finally {
    if (browser) await browser.close();
    child.kill('SIGTERM');
  }

  if (hardErrors.length) {
    console.error('\nSHOT CHECK FAILED:');
    for (const e of hardErrors) console.error('  ✗', String(e).slice(0, 600));
    process.exit(1);
  }
  console.log('\nAll browser checks passed. Screenshots written to artifacts/ui-*.png');
}

main().catch((e) => { console.error(e); process.exit(1); });
