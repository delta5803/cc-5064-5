// Builds non-indexed triangle arrays for the baked scene and a unit cube for bulbs.

export function buildSceneMesh(boxes) {
  const verts = [];
  const floatsPerVertex = 12; // pos3 n3 color3 emissive3

  function vertex(p, n, color, emissive) {
    verts.push(p[0], p[1], p[2], n[0], n[1], n[2], color[0], color[1], color[2], emissive[0], emissive[1], emissive[2]);
  }
  function quad(corners, n, color, emissive) {
    // corners: 4 in order; emit two triangles (0,1,2),(0,2,3)
    const order = [0, 1, 2, 0, 2, 3];
    for (const i of order) vertex(corners[i], n, color, emissive);
  }

  for (const b of boxes) {
    const [x0, y0, z0] = b.min;
    const [x1, y1, z1] = b.max;
    const c = b.color;
    const e = b.emissive || [0, 0, 0];
    quad([[x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1]], [0,0,1], c, e);       // +z
    quad([[x1,y0,z0],[x0,y0,z0],[x0,y1,z0],[x1,y1,z0]], [0,0,-1], c, e);      // -z
    quad([[x1,y0,z1],[x1,y0,z0],[x1,y1,z0],[x1,y1,z1]], [1,0,0], c, e);      // +x
    quad([[x0,y0,z0],[x0,y0,z1],[x0,y1,z1],[x0,y1,z0]], [-1,0,0], c, e);      // -x
    quad([[x0,y1,z1],[x1,y1,z1],[x1,y1,z0],[x0,y1,z0]], [0,1,0], c, e);       // +y
    quad([[x0,y0,z0],[x1,y0,z0],[x1,y0,z1],[x0,y0,z1]], [0,-1,0], c, e);      // -y
  }

  return {
    data: new Float32Array(verts),
    vertexCount: verts.length / floatsPerVertex,
    strideBytes: floatsPerVertex * 4,
    floatsPerVertex,
  };
}

// Unit-ish cube from -1..1 used with a model matrix that scales to half extents.
export function buildCube() {
  const p = [];
  function face(a,b,c,d,n){
    const v=[a,b,c,a,c,d];
    for(const q of v) p.push(...q, ...n);
  }
  face([-1,-1, 1],[ 1,-1, 1],[ 1, 1, 1],[-1, 1, 1],[0,0,1]);
  face([ 1,-1,-1],[-1,-1,-1],[-1, 1,-1],[ 1, 1,-1],[0,0,-1]);
  face([ 1,-1, 1],[ 1,-1,-1],[ 1, 1,-1],[ 1, 1, 1],[1,0,0]);
  face([-1,-1,-1],[-1,-1, 1],[-1, 1, 1],[-1, 1,-1],[-1,0,0]);
  face([-1, 1, 1],[ 1, 1, 1],[ 1, 1,-1],[-1, 1,-1],[0,1,0]);
  face([-1,-1,-1],[ 1,-1,-1],[ 1,-1, 1],[-1,-1, 1],[0,-1,0]);
  return new Float32Array(p); // pos3 normal3
}

export function composeModel(pos, half) {
  // Column-major mat4 = translation * scale.
  const [hx, hy, hz] = half;
  return new Float32Array([
    hx,0,0,0,
    0,hy,0,0,
    0,0,hz,0,
    pos[0],pos[1],pos[2],1,
  ]);
}
