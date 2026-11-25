// Orbit camera with a consistent OpenGL-style perspective (-Z forward).
import { mat4, vec3, clamp } from './math.js';
import { LAYOUT } from './scene.js';

export function createCamera(initial = {}) {
  const base = LAYOUT.camera;
  const eye = initial.eye || base.eye;
  const target = initial.target || base.target;
  const o = vec3.sub(eye, target);
  const distance = vec3.length(o);
  const pitch = Math.asin(clamp(o[1] / distance, -1, 1));
  const yaw = Math.atan2(o[0], o[2]);
  return {
    target: [...target],
    yaw,
    pitch,
    distance,
    fovyDeg: initial.fovyDeg ?? base.fovyDeg,
    near: initial.near ?? base.near,
    far: initial.far ?? base.far,
  };
}

export function cameraEye(cam) {
  const cp = Math.cos(cam.pitch);
  return [
    cam.target[0] + cp * Math.sin(cam.yaw) * cam.distance,
    cam.target[1] + Math.sin(cam.pitch) * cam.distance,
    cam.target[2] + cp * Math.cos(cam.yaw) * cam.distance,
  ];
}

export function orbit(cam, dxPx, dyPx) {
  const k = 0.005;
  cam.yaw -= dxPx * k;
  cam.pitch = clamp(cam.pitch + dyPx * k, -0.15, 1.45);
}

export function zoom(cam, deltaY) {
  cam.distance = clamp(cam.distance * Math.exp(deltaY * 0.0012), 3, 90);
}

export function setView(cam, { eye, target }) {
  if (target) cam.target = [...target];
  const e = eye || cameraEye(cam);
  const o = vec3.sub(e, cam.target);
  cam.distance = clamp(vec3.length(o), 3, 120);
  cam.pitch = Math.asin(clamp(o[1] / cam.distance, -1, 1));
  cam.yaw = Math.atan2(o[0], o[2]);
}

export function cameraMatrices(cam, aspect) {
  const eye = cameraEye(cam);
  const view = mat4.lookAt(eye, cam.target, [0, 1, 0]);
  const proj = mat4.perspective((cam.fovyDeg * Math.PI) / 180, aspect, cam.near, cam.far);
  const viewProj = mat4.multiply(proj, view);
  const invView = mat4.invert(view);
  const invViewProj = mat4.invert(viewProj);
  return { eye, view, proj, viewProj, invView, invViewProj };
}

// World-space primary ray through a top-left pixel center.
export function rayForPixel(camMats, cam, cfg, px, pyTop, width, height) {
  const nx = ((px + 0.5) / width) * 2 - 1;
  const ny = 1 - ((pyTop + 0.5) / height) * 2;
  const tanY = Math.tan((cam.fovyDeg * Math.PI) / 360); // tan(fovy/2)
  const dxv = nx * tanY * (width / height);
  const dyv = ny * tanY;
  const dzv = -1;
  const m = camMats.invView;
  let dx = m[0] * dxv + m[4] * dyv + m[8] * dzv;
  let dy = m[1] * dxv + m[5] * dyv + m[9] * dzv;
  let dz = m[2] * dxv + m[6] * dyv + m[10] * dzv;
  const l = Math.hypot(dx, dy, dz) || 1;
  dx /= l; dy /= l; dz /= l;
  return { orig: camMats.eye, dir: [dx, dy, dz] };
}
