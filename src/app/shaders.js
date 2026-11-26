// WebGL2 (GLSL ES 3.00) shaders. The fragment cluster/depth logic is a line-by-line
// mirror of src/core/clusters.js, and the BRDF mirrors src/core/shading.js.

export const FULLSCREEN_VERT = `#version 300 es
precision highp float;
const vec2 V[3] = vec2[3](vec2(-1.0,-1.0), vec2(3.0,-1.0), vec2(-1.0,3.0));
void main(){ gl_Position = vec4(V[gl_VertexID], 0.0, 1.0); }
`;

export const SCENE_VERT = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPosition;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec3 aColor;
layout(location=3) in vec3 aEmissive;
uniform mat4 uViewProj;
out vec3 vWorldPos;
out vec3 vNormal;
out vec3 vColor;
out vec3 vEmissive;
void main(){
  vWorldPos = aPosition;
  vNormal = aNormal;
  vColor = aColor;
  vEmissive = aEmissive;
  gl_Position = uViewProj * vec4(aPosition, 1.0);
}
`;

export const SCENE_FRAG = `#version 300 es
precision highp float;
precision highp int;

in vec3 vWorldPos;
in vec3 vNormal;
in vec3 vColor;
in vec3 vEmissive;

uniform vec3  uCamPos;
uniform float uNear;
uniform float uFar;
uniform int   uSlices;
uniform int   uCols;
uniform int   uRows;
uniform float uTile;
uniform int   uIndexWidth;
uniform uint  uGlobalOffset;
uniform uint  uGlobalCount;
uniform int   uDebugMode; // 0 lit,1 occupancy heat,2 slice bands,3 cluster hash,4 linear depth
// Depth boundary table, identical to cfg.boundaries in clusters.js. Fixed scheme
// = exponential values; adaptive scheme = visible-depth quantiles. Same shader.
uniform float uBoundaries[41];

uniform highp usampler2D uHeaderTex;
uniform highp usampler2D uIndexTex;
uniform highp usampler2D uLightTex;

out vec4 outColor;

// ---- must match clusters.js ----
float viewDepthFromDepth01(float d01){
  float z = d01 * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / ((uFar + uNear) - z * (uFar - uNear));
}
int sliceForViewDepth(float d){
  if (!(d > uNear)) return 0;
  if (d >= uFar) return uSlices - 1;
  // Binary search the (strictly increasing) boundary table.
  int lo = 0;
  int hi = uSlices;
  for (int it = 0; it < 8; it++) {
    if (lo >= hi) break;
    int mid = (lo + hi) >> 1;
    if (uBoundaries[mid + 1] <= d) lo = mid + 1;
    else hi = mid;
  }
  return clamp(lo, 0, uSlices - 1);
}

vec3 aces(vec3 x){
  return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14), 0.0, 1.0);
}
vec3 encode(vec3 hdr){
  return pow(aces(max(hdr, vec3(0.0)) * 1.0), vec3(1.0/2.2));
}
vec3 heatColor(float t){
  t = clamp(t, 0.0, 1.0);
  vec3 c = mix(vec3(0.05,0.15,0.55), vec3(0.1,0.85,0.9), smoothstep(0.0,0.45,t));
  c = mix(c, vec3(1.0,0.85,0.2), smoothstep(0.45,0.75,t));
  c = mix(c, vec3(0.95,0.12,0.1), smoothstep(0.75,1.0,t));
  return c;
}
vec3 sliceColor(int s){
  float h = fract(float(s) * 0.61803398875);
  vec3 k = abs(fract(h + vec3(0.0, 0.6667, 0.3333)) * 6.0 - 3.0);
  return clamp(k - 1.0, 0.0, 1.0) * 0.8 + 0.2;
}

struct LC { vec3 diff; vec3 spec; };

LC evalLight(int slot, vec3 P, vec3 N, vec3 V){
  LC r; r.diff = vec3(0.0); r.spec = vec3(0.0);
  vec4 t0 = uintBitsToFloat(texelFetch(uLightTex, ivec2(0, slot), 0));
  vec4 t1 = uintBitsToFloat(texelFetch(uLightTex, ivec2(1, slot), 0));
  vec4 t2 = uintBitsToFloat(texelFetch(uLightTex, ivec2(2, slot), 0));
  vec4 t3 = uintBitsToFloat(texelFetch(uLightTex, ivec2(3, slot), 0));
  vec3 Lv = t0.xyz - P;
  float dist = length(Lv);
  float range = t0.w;
  if (dist >= range) return r;
  vec3 L = Lv / max(dist, 1e-4);
  float ndl = max(dot(N, L), 0.0);
  float q = 1.0 - pow(clamp(dist / range, 0.0, 1.0), 4.0);
  float att = (q*q) / (dist*dist + 3.0);
  float cone = 1.0;
  if (t2.w > 0.5) {
    float theta = dot(normalize(t2.xyz), -L);
    cone = smoothstep(t3.y, t3.x, theta); // cosOuter, cosInner
  }
  vec3 radiance = t1.rgb * t1.w * att * cone;
  vec3 H = normalize(L + V);
  float spec = pow(max(dot(N, H), 0.0), 42.0) * 0.35;
  r.diff = radiance * ndl;
  r.spec = radiance * spec;
  return r;
}

uint fetchIndex(uint linear){
  int w = uIndexWidth;
  ivec2 c = ivec2(int(linear % uint(w)), int(linear / uint(w)));
  return texelFetch(uIndexTex, c, 0).r;
}

void main(){
  vec3 N = normalize(vNormal);
  vec3 V = normalize(uCamPos - vWorldPos);

  float vd = viewDepthFromDepth01(gl_FragCoord.z);
  int tx = clamp(int(floor(gl_FragCoord.x / uTile)), 0, uCols - 1);
  int ty = clamp(int(floor(gl_FragCoord.y / uTile)), 0, uRows - 1);
  int s  = sliceForViewDepth(vd);
  int cid = (s * uRows + ty) * uCols + tx;

  uvec4 hdr4 = texelFetch(uHeaderTex, ivec2(tx, s * uRows + ty), 0);
  uint off = hdr4.r;
  uint cnt = hdr4.g;
  uint total = cnt + uGlobalCount;

  // Debug raster modes.
  if (uDebugMode == 1) { outColor = vec4(encode(heatColor(float(total) / 40.0) * 1.4), 1.0); return; }
  if (uDebugMode == 2) {
    float band = fract((log(vd / uNear) / log(uFar / uNear)) * float(uSlices));
    vec3 c = sliceColor(s) * (0.55 + 0.45 * band);
    outColor = vec4(pow(c, vec3(1.0/2.2)), 1.0); return;
  }
  if (uDebugMode == 3) {
    float h = fract(sin(float(cid) * 12.9898) * 43758.5453);
    outColor = vec4(pow(vec3(h, fract(h*1.7), fract(h*2.3)), vec3(1.0/2.2)), 1.0); return;
  }
  if (uDebugMode == 4) {
    float d = clamp(vd / 60.0, 0.0, 1.0);
    // Show the CORRECT exponential slice mapping as bands over linear depth.
    outColor = vec4(encode(vec3(d) * (0.4 + 0.6 * float(s) / float(uSlices))), 1.0); return;
  }

  vec3 hemi = mix(vec3(0.045,0.038,0.05), vec3(0.13,0.16,0.27), clamp(N.y*0.5+0.5,0.0,1.0));
  vec3 amb = hemi * 0.5;
  vec3 diffAcc = vec3(0.0);
  vec3 specAcc = vec3(0.0);

  for (uint k = 0u; k < cnt; k++){
    int slot = int(fetchIndex(off + k));
    LC e = evalLight(slot, vWorldPos, N, V);
    diffAcc += e.diff; specAcc += e.spec;
  }
  for (uint k = 0u; k < uGlobalCount; k++){
    int slot = int(fetchIndex(uGlobalOffset + k));
    LC e = evalLight(slot, vWorldPos, N, V);
    diffAcc += e.diff; specAcc += e.spec;
  }

  vec3 lin = vEmissive + vColor * (amb + diffAcc) + specAcc;
  float fog = smoothstep(30.0, 95.0, length(uCamPos - vWorldPos));
  lin = mix(lin, vec3(0.018,0.022,0.04), fog);
  outColor = vec4(encode(lin), 1.0);
}
`;

export const BULB_VERT = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPosition;
layout(location=1) in vec3 aNormal;
uniform mat4 uViewProj;
uniform mat4 uModel;
out vec3 vN;
out vec3 vW;
void main(){
  vec4 w = uModel * vec4(aPosition,1.0);
  vW = w.xyz;
  vN = mat3(uModel) * aNormal;
  gl_Position = uViewProj * w;
}
`;
export const BULB_FRAG = `#version 300 es
precision highp float;
in vec3 vN; in vec3 vW;
uniform vec3 uColor;
uniform vec3 uCamPos;
out vec4 outColor;
vec3 aces(vec3 x){ return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14),0.0,1.0); }
void main(){
  vec3 N = normalize(vN);
  vec3 V = normalize(uCamPos - vW);
  float rim = pow(1.0 - max(dot(N,V),0.0), 2.0);
  vec3 hdr = uColor * (2.2 + rim * 2.5);
  outColor = vec4(pow(aces(hdr), vec3(1.0/2.2)), 1.0);
}
`;

export const GLOW_VERT = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aColor;
layout(location=2) in float aSize;
uniform mat4 uView;
uniform mat4 uViewProj;
uniform float uHeight;
out vec3 vColor;
void main(){
  vec4 mv = uView * vec4(aPos,1.0);
  gl_Position = uViewProj * vec4(aPos,1.0);
  float d = max(0.1, -mv.z);
  gl_PointSize = clamp(aSize * uHeight * 0.14 / d, 2.0, 160.0);
  vColor = aColor;
}
`;
export const GLOW_FRAG = `#version 300 es
precision highp float;
in vec3 vColor;
out vec4 outColor;
void main(){
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(p,p);
  if (r2 > 1.0) discard;
  float a = pow(1.0 - r2, 2.2) * 0.5;
  outColor = vec4(vColor * 1.6, a);
}
`;
