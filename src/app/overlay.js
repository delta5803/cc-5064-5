// 2D overlay: tile grid, per-slice occupancy, pending-region hatch, light handles.
// Draws in the frame's 1280x720 pixel space; CSS scales the canvas.
import { decodeCluster, tileDomRect } from '../core/clusters.js';
import { projectWorld } from '../core/math.js';

export class Overlay {
  constructor() {
    this.hoverTile = null; // {tx,ty}
    this.pinnedId = null;
    this.hoverUid = null;
    this.inspectSlice = 10;
    this.showCounts = true;
  }

  draw(ctx, store) {
    const frame = store.published;
    const cfg = store.cfg;
    ctx.clearRect(0, 0, cfg.width, cfg.height);
    if (!frame) return;

    if (store.showGrid) this._grid(ctx, cfg);

    // Occupancy numbers for the inspected depth slice of the PUBLISHED frame.
    if (this.showCounts && store.debugMode === 'lit') {
      this._sliceCounts(ctx, frame, this.inspectSlice);
    }

    // Pending (un-computable) region from the candidate, screen tiles union.
    if (store.pending) this._pending(ctx, store);

    // Hovered tile.
    if (this.hoverTile) {
      const r = tileDomRect(cfg, this.hoverTile.tx, this.hoverTile.ty);
      ctx.strokeStyle = 'rgba(120,220,255,0.9)';
      ctx.lineWidth = 2;
      ctx.strokeRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
    }
    // Pinned cluster rectangle.
    if (this.pinnedId != null) {
      const d = decodeCluster(cfg, this.pinnedId);
      const r = tileDomRect(cfg, d.tx, d.ty);
      ctx.fillStyle = 'rgba(255,220,90,0.12)';
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.strokeStyle = 'rgba(255,214,64,0.95)';
      ctx.lineWidth = 3;
      ctx.strokeRect(r.x + 1.5, r.y + 1.5, r.w - 3, r.h - 3);
      ctx.fillStyle = '#ffd640';
      ctx.font = 'bold 12px ui-monospace, monospace';
      ctx.fillText(`s${d.s}`, r.x + 5, r.y + 14);
    }

    if (store.showHandles) this._handles(ctx, frame, store.selectedUid);
  }

  _grid(ctx, cfg) {
    const T = cfg.tilePixels;
    ctx.strokeStyle = 'rgba(150,190,255,0.16)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= cfg.width; x += T) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, cfg.height); }
    for (let y = 0; y <= cfg.height; y += T) { ctx.moveTo(0, y + 0.5); ctx.lineTo(cfg.width, y + 0.5); }
    ctx.stroke();
  }

  _sliceCounts(ctx, frame, slice) {
    const cfg = frame.cfg;
    const cap = frame.options?.capacity ?? 24;
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    for (let ty = 0; ty < cfg.rows; ty++) {
      for (let tx = 0; tx < cfg.cols; tx++) {
        const id = (slice * cfg.rows + ty) * cfg.cols + tx;
        const count = frame.headerData[id * 4 + 1] + frame.globalSlots.length;
        if (count <= 0) continue;
        const r = tileDomRect(cfg, tx, ty);
        const t = Math.min(1, count / 40);
        ctx.fillStyle = `rgba(${Math.floor(80 + 175 * t)},${Math.floor(220 - 160 * t)},${Math.floor(255 - 220 * t)},0.10)`;
        ctx.fillRect(r.x + 2, r.y + 2, r.w - 4, r.h - 4);
        ctx.fillStyle = count > cap ? '#ff8a6b' : 'rgba(225,238,255,0.78)';
        ctx.fillText(String(count), r.x + 5, r.y + 4);
      }
    }
  }

  _pending(ctx, store) {
    const cfg = store.cfg;
    const set = new Set();
    for (const id of store.pending.pendingClusterIds) {
      const d = decodeCluster(cfg, id);
      set.add(d.ty * cfg.cols + d.tx);
    }
    let i = 0;
    for (const key of set) {
      const tx = key % cfg.cols;
      const ty = (key - tx) / cfg.cols;
      const r = tileDomRect(cfg, tx, ty);
      ctx.fillStyle = 'rgba(255,150,40,0.10)';
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.save();
      ctx.beginPath();
      ctx.rect(r.x, r.y, r.w, r.h);
      ctx.clip();
      ctx.strokeStyle = 'rgba(255,176,64,0.42)';
      ctx.lineWidth = 2;
      const step = 12;
      const off = (performance.now() / 40) % step;
      ctx.beginPath();
      for (let k = -r.h; k < r.w + r.h; k += step) {
        ctx.moveTo(r.x + k + off, r.y);
        ctx.lineTo(r.x + k - r.h + off, r.y + r.h);
      }
      ctx.stroke();
      ctx.restore();
      ctx.strokeStyle = 'rgba(255,176,64,0.9)';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
      i++;
    }
  }

  _handles(ctx, frame, selectedUid) {
    const cfg = frame.cfg;
    for (const l of frame.lightsSnapshot) {
      if (!l.on) continue;
      const p = projectWorld(l.pos, frame.viewProj, cfg.width, cfg.height);
      if (!p.visible) continue;
      const selected = l.uid === selectedUid;
      const radius = selected ? 11 : (l.group === 'hero' ? 8 : 6);
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius + 3, 0, Math.PI * 2);
      ctx.strokeStyle = selected ? 'rgba(255,224,90,0.95)' : 'rgba(255,255,255,0.55)';
      ctx.lineWidth = selected ? 2.5 : 1.4;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.6, 0, Math.PI * 2);
      ctx.fillStyle = `rgb(${Math.floor(l.color[0]*255)},${Math.floor(l.color[1]*255)},${Math.floor(l.color[2]*255)})`;
      ctx.fill();
      if (selected) {
        ctx.fillStyle = '#ffe05a';
        ctx.font = 'bold 12px system-ui, sans-serif';
        ctx.fillText(l.name, p.x + 14, p.y - 12);
      }
    }
  }

  // Hit test a DOM-space point (already mapped to cfg pixels) against handles.
  hitHandle(frame, x, y) {
    if (!frame) return null;
    let best = null;
    let bestD = 18 * 18;
    for (const l of frame.lightsSnapshot) {
      if (!l.on) continue;
      const p = projectWorld(l.pos, frame.viewProj, frame.cfg.width, frame.cfg.height);
      if (!p.visible) continue;
      const d = (p.x - x) ** 2 + (p.y - y) ** 2;
      if (d < bestD) { bestD = d; best = l.uid; }
    }
    return best;
  }
}
