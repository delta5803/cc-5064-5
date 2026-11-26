// WebGL2 clustered forward renderer. It renders exactly ONE published frame
// snapshot: cluster header/index/light textures are replaced wholesale whenever
// frame.version changes, so old wide-table and new local copies can never mix.

import { SCENE_VERT, SCENE_FRAG, BULB_VERT, BULB_FRAG, GLOW_VERT, GLOW_FRAG } from './shaders.js';
import { buildSceneMesh, buildCube, composeModel } from './geometry.js';
import { buildNightMarket } from '../core/scene.js';
import { MAX_LIGHTS } from '../app/store.js';

const INDEX_W = 1024;
const INDEX_H = 256; // 262144 uint slots max

function compileShader(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error('Shader compile: ' + log);
  }
  return sh;
}
function makeProgram(gl, vsSrc, fsSrc) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
  const p = gl.createProgram();
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Program link: ' + gl.getProgramInfoLog(p));
  gl.deleteShader(vs); gl.deleteShader(fs);
  return p;
}

export class WebGLClusteredRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: true });
    if (!gl) throw new Error('当前浏览器/环境不支持 WebGL2。可使用下方“CPU 参考对比”查看同样的分簇结果。');
    this.gl = gl;
    this.ok = true;
    this.lastVersion = -1;
    this.drawCalls = 0;

    this.sceneProg = makeProgram(gl, SCENE_VERT, SCENE_FRAG);
    this.bulbProg = makeProgram(gl, BULB_VERT, BULB_FRAG);
    this.glowProg = makeProgram(gl, GLOW_VERT, GLOW_FRAG);

    this._initScene();
    this._initCube();
    this._initGlow();
    this._initTextures();
    this._cacheUniforms();

    gl.clearColor(0.01, 0.012, 0.03, 1);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.CULL_FACE);
  }

  _initScene() {
    const gl = this.gl;
    const mesh = buildSceneMesh(buildNightMarket());
    this.sceneVertexCount = mesh.vertexCount;
    this.sceneVAO = gl.createVertexArray();
    gl.bindVertexArray(this.sceneVAO);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.data, gl.STATIC_DRAW);
    const S = mesh.strideBytes;
    // locations match layout(location=n)
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, S, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, S, 3 * 4);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 3, gl.FLOAT, false, S, 6 * 4);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 3, gl.FLOAT, false, S, 9 * 4);
    gl.bindVertexArray(null);
  }

  _initCube() {
    const gl = this.gl;
    const data = buildCube();
    this.cubeVAO = gl.createVertexArray();
    gl.bindVertexArray(this.cubeVAO);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    this.cubeVerts = data.length / 6;
    gl.bindVertexArray(null);
  }

  _initGlow() {
    const gl = this.gl;
    this.glowVAO = gl.createVertexArray();
    gl.bindVertexArray(this.glowVAO);
    this.glowVBO = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.glowVBO);
    const stride = 7 * 4;
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 3 * 4);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, 6 * 4);
    gl.bindVertexArray(null);
    this.glowData = new Float32Array(MAX_LIGHTS * 7);
  }

  _initTextures() {
    const gl = this.gl;
    function intTex(internal, format, w, h) {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, gl.UNSIGNED_INT, null);
      return t;
    }
    this.headerTex = intTex.call(null, gl.RGBA32UI, gl.RGBA_INTEGER, 16, 216); // reallocated on frame
    this.indexTex = intTex(gl.R32UI, gl.RED_INTEGER, INDEX_W, INDEX_H);
    this.indexPixels = new Uint32Array(INDEX_W * INDEX_H);
    this.lightTex = intTex(gl.RGBA32UI, gl.RGBA_INTEGER, 4, MAX_LIGHTS);
    this.lightBuffer = new ArrayBuffer(MAX_LIGHTS * 16 * 4);
    this.lightF32 = new Float32Array(this.lightBuffer);
    this.lightU32 = new Uint32Array(this.lightBuffer);
  }

  _u(prog, name) { return this.gl.getUniformLocation(prog, name); }

  _cacheUniforms() {
    const gl = this.gl;
    this.U = {
      scene: {
        viewProj: this._u(this.sceneProg, 'uViewProj'),
        camPos: this._u(this.sceneProg, 'uCamPos'),
        near: this._u(this.sceneProg, 'uNear'), far: this._u(this.sceneProg, 'uFar'),
        slices: this._u(this.sceneProg, 'uSlices'), cols: this._u(this.sceneProg, 'uCols'), rows: this._u(this.sceneProg, 'uRows'),
        tile: this._u(this.sceneProg, 'uTile'), indexWidth: this._u(this.sceneProg, 'uIndexWidth'),
        globalOffset: this._u(this.sceneProg, 'uGlobalOffset'), globalCount: this._u(this.sceneProg, 'uGlobalCount'),
        debugMode: this._u(this.sceneProg, 'uDebugMode'),
        boundaries: this._u(this.sceneProg, 'uBoundaries'),
        headerTex: this._u(this.sceneProg, 'uHeaderTex'), indexTex: this._u(this.sceneProg, 'uIndexTex'), lightTex: this._u(this.sceneProg, 'uLightTex'),
      },
      bulb: {
        viewProj: this._u(this.bulbProg, 'uViewProj'), model: this._u(this.bulbProg, 'uModel'),
        color: this._u(this.bulbProg, 'uColor'), camPos: this._u(this.bulbProg, 'uCamPos'),
      },
      glow: {
        view: this._u(this.glowProg, 'uView'), viewProj: this._u(this.glowProg, 'uViewProj'), height: this._u(this.glowProg, 'uHeight'),
      },
    };
  }

  _uploadFrame(frame) {
    const gl = this.gl;
    const cfg = frame.cfg;

    // Header texture size depends on grid; (re)allocate exact each publish.
    gl.bindTexture(gl.TEXTURE_2D, this.headerTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32UI, cfg.cols, cfg.rows * cfg.slices, 0,
      gl.RGBA_INTEGER, gl.UNSIGNED_INT, frame.headerData);

    // Index table (padded to fixed width).
    this.indexPixels.fill(0);
    this.indexPixels.set(frame.indexData);
    gl.bindTexture(gl.TEXTURE_2D, this.indexTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32UI, INDEX_W, INDEX_H, 0,
      gl.RED_INTEGER, gl.UNSIGNED_INT, this.indexPixels);

    // Light table: 4 RGBA uint texels per light; write floats through an aliased view.
    this.lightF32.fill(0);
    const lights = frame.lightsSnapshot;
    for (let i = 0; i < lights.length; i++) {
      const l = lights[i];
      const b = i * 16;
      this.lightF32[b + 0] = l.pos[0]; this.lightF32[b + 1] = l.pos[1]; this.lightF32[b + 2] = l.pos[2]; this.lightF32[b + 3] = l.range;
      this.lightF32[b + 4] = l.color[0]; this.lightF32[b + 5] = l.color[1]; this.lightF32[b + 6] = l.color[2]; this.lightF32[b + 7] = l.intensity;
      const dir = l.dir || [0, -1, 0];
      this.lightF32[b + 8] = dir[0]; this.lightF32[b + 9] = dir[1]; this.lightF32[b + 10] = dir[2];
      this.lightF32[b + 11] = l.kind === 'spot' ? 1 : 0;
      this.lightF32[b + 12] = Math.cos((l.innerDeg ?? 24) * Math.PI / 180);
      this.lightF32[b + 13] = Math.cos((l.outerDeg ?? 42) * Math.PI / 180);
    }
    gl.bindTexture(gl.TEXTURE_2D, this.lightTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32UI, 4, MAX_LIGHTS, 0,
      gl.RGBA_INTEGER, gl.UNSIGNED_INT, this.lightU32);

    this.lastVersion = frame.version;
  }

  render(frame, debugMode = 0) {
    const gl = this.gl;
    if (!frame) return;
    if (frame.version !== this.lastVersion) this._uploadFrame(frame);
    this.drawCalls = 0;

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const cfg = frame.cfg;
    const U = this.U.scene;
    gl.useProgram(this.sceneProg);
    gl.uniformMatrix4fv(U.viewProj, false, frame.viewProj);
    gl.uniform3fv(U.camPos, frame.eye);
    gl.uniform1f(U.near, cfg.near);
    gl.uniform1f(U.far, cfg.far);
    gl.uniform1i(U.slices, cfg.slices);
    gl.uniform1i(U.cols, cfg.cols);
    gl.uniform1i(U.rows, cfg.rows);
    gl.uniform1f(U.tile, cfg.tilePixels);
    gl.uniform1i(U.indexWidth, INDEX_W);
    gl.uniform1ui(U.globalOffset, frame.globalOffset);
    gl.uniform1ui(U.globalCount, frame.globalSlots.length);
    gl.uniform1i(U.debugMode, debugMode | 0);
    // Upload the depth boundary table (same values the CPU kernel used to assign
    // lights into this frame). Fixed and adaptive partitions both arrive here.
    if (!this.boundaryScratch) this.boundaryScratch = new Float32Array(41);
    this.boundaryScratch.fill(0);
    this.boundaryScratch.set(cfg.boundaries);
    gl.uniform1fv(U.boundaries, this.boundaryScratch);

    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.headerTex); gl.uniform1i(U.headerTex, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.indexTex); gl.uniform1i(U.indexTex, 1);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.lightTex); gl.uniform1i(U.lightTex, 2);

    gl.bindVertexArray(this.sceneVAO);
    gl.drawArrays(gl.TRIANGLES, 0, this.sceneVertexCount);
    this.drawCalls++;

    this._renderBulbs(frame, debugMode);
    this._renderGlow(frame, debugMode);
    gl.bindVertexArray(null);
  }

  _renderBulbs(frame, debugMode) {
    if (debugMode !== 0) return;
    const gl = this.gl;
    const U = this.U.bulb;
    gl.useProgram(this.bulbProg);
    gl.uniformMatrix4fv(U.viewProj, false, frame.viewProj);
    gl.uniform3fv(U.camPos, frame.eye);
    gl.bindVertexArray(this.cubeVAO);
    for (const l of frame.lightsSnapshot) {
      if (!l.on) continue;
      const r = l.uid === this.selectedUid ? 0.26 : (l.group === 'hero' ? 0.24 : 0.15);
      gl.uniformMatrix4fv(U.model, false, composeModel(l.pos, [r, r, r]));
      gl.uniform3fv(U.color, l.color);
      gl.drawArrays(gl.TRIANGLES, 0, this.cubeVerts);
      this.drawCalls++;
    }
  }

  _renderGlow(frame, debugMode) {
    if (debugMode !== 0) return;
    const gl = this.gl;
    let n = 0;
    const d = this.glowData;
    for (const l of frame.lightsSnapshot) {
      if (!l.on) continue;
      const o = n * 7;
      d[o] = l.pos[0]; d[o + 1] = l.pos[1]; d[o + 2] = l.pos[2];
      d[o + 3] = l.color[0]; d[o + 4] = l.color[1]; d[o + 5] = l.color[2];
      d[o + 6] = 1.1 + l.range * 0.16 + Math.min(l.intensity, 60) * 0.02;
      n++;
    }
    if (!n) return;
    gl.useProgram(this.glowProg);
    gl.uniformMatrix4fv(this.U.glow.view, false, frame.viewMatrix);
    gl.uniformMatrix4fv(this.U.glow.viewProj, false, frame.viewProj);
    gl.uniform1f(this.U.glow.height, this.canvas.height);
    gl.bindVertexArray(this.glowVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.glowVBO);
    gl.bufferData(gl.ARRAY_BUFFER, d.subarray(0, n * 7), gl.DYNAMIC_DRAW);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.depthMask(false);
    gl.drawArrays(gl.POINTS, 0, n);
    this.drawCalls++;
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }
}
