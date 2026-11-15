import { BufferAttribute, BufferGeometry, Color, CylinderGeometry, Euler, Matrix4, Quaternion, Vector3 } from 'three';
import type { Mesh, Object3D } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// ---------------------------------------------------------------------------------------------------------------
// Build-time geometry helpers for the procedural hardware. Every part is baked into a non-indexed geometry with the
// same four attributes (position, normal, uv, color), so parts of one material merge into one mesh (one draw call).
// Nothing here runs inside the frame loop.
// ---------------------------------------------------------------------------------------------------------------

export type Vec3 = readonly [number, number, number];

export interface PartOptions {
  /** Translation (applied last). */
  readonly at?: Vec3;
  /** XYZ Euler rotation in radians (applied after the scale). */
  readonly rot?: Vec3;
  /** Uniform or per-axis positive scale (applied first). */
  readonly scale?: Vec3 | number;
  /** sRGB vertex colour; default white (the material colour shows unchanged). */
  readonly color?: number;
  /** Faceted normals (one normal per triangle). */
  readonly flat?: boolean;
  /**
   * Box-projected UVs in world units after the transform: texture tiles per metre, projected along each
   * vertex's dominant normal axis. For flat-faced parts (boxes, plates), so a texture is never stretched.
   */
  readonly uvDensity?: number;
}

const _m = new Matrix4();
const _q = new Quaternion();
const _e = new Euler();
const _p = new Vector3();
const _s = new Vector3();
const _a = new Vector3();
const _b = new Vector3();
const _c = new Color();
const UP = new Vector3(0, 1, 0);

function bake(source: BufferGeometry, matrix: Matrix4, color: number, flat: boolean, uvDensity = 0): BufferGeometry {
  const g = source.index !== null ? source.toNonIndexed() : source.clone();
  source.dispose();
  for (const name of Object.keys(g.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
  }
  g.morphAttributes = {};
  g.clearGroups();
  const count = g.attributes.position.count;
  if (g.attributes.uv === undefined) g.setAttribute('uv', new BufferAttribute(new Float32Array(count * 2), 2));
  if (g.attributes.normal === undefined) g.computeVertexNormals();
  g.applyMatrix4(matrix);
  if (flat) g.computeVertexNormals(); // non-indexed: per-face normals
  if (uvDensity > 0) projectUvs(g, uvDensity);
  _c.setHex(color);
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = _c.r;
    colors[i * 3 + 1] = _c.g;
    colors[i * 3 + 2] = _c.b;
  }
  g.setAttribute('color', new BufferAttribute(colors, 3));
  return g;
}

/** Box projection of the UVs along each vertex's dominant normal axis, density tiles per metre. */
function projectUvs(g: BufferGeometry, density: number): void {
  const p = g.attributes.position;
  const n = g.attributes.normal;
  const uv = g.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    const ax = Math.abs(n.getX(i));
    const ay = Math.abs(n.getY(i));
    const az = Math.abs(n.getZ(i));
    if (ax >= ay && ax >= az) uv.setXY(i, p.getZ(i) * density, p.getY(i) * density);
    else if (ay >= az) uv.setXY(i, p.getX(i) * density, p.getZ(i) * density);
    else uv.setXY(i, p.getX(i) * density, p.getY(i) * density);
  }
  uv.needsUpdate = true;
}

/** Bakes a primitive into a mergeable part (non-indexed, position/normal/uv/color), placed by `options`. */
export function part(source: BufferGeometry, options: PartOptions = {}): BufferGeometry {
  const at = options.at ?? [0, 0, 0];
  const rot = options.rot ?? [0, 0, 0];
  const scale = options.scale ?? 1;
  _p.set(at[0], at[1], at[2]);
  _q.setFromEuler(_e.set(rot[0], rot[1], rot[2]));
  if (typeof scale === 'number') _s.setScalar(scale);
  else _s.set(scale[0], scale[1], scale[2]);
  _m.compose(_p, _q, _s);
  return bake(source, _m, options.color ?? 0xffffff, options.flat === true, options.uvDensity ?? 0);
}

/** Capped round tube from `a` to `b`. */
export function tube(a: Vec3, b: Vec3, radius: number, radialSegments = 8, color = 0xffffff): BufferGeometry {
  _a.set(a[0], a[1], a[2]);
  _b.set(b[0], b[1], b[2]);
  const dir = _b.sub(_a);
  const length = dir.length();
  const geometry = new CylinderGeometry(radius, radius, length, radialSegments, 1, false);
  _q.setFromUnitVectors(UP, dir.normalize());
  _p.set(a[0] + b[0], a[1] + b[1], a[2] + b[2]).multiplyScalar(0.5);
  _m.compose(_p, _q, _s.setScalar(1));
  return bake(geometry, _m, color, false);
}

/** Merges baked parts into one geometry (one mesh, one draw call per material). The inputs are disposed. */
export function mergeParts(parts: readonly BufferGeometry[]): BufferGeometry {
  const merged = mergeGeometries(parts as BufferGeometry[], false);
  if (merged === null) throw new Error('mergeParts: parts have different attributes');
  for (const p of parts) p.dispose();
  merged.computeBoundingSphere();
  return merged;
}

/** Triangles of a geometry, or of every mesh under an object. */
export function triangleCount(target: BufferGeometry | Object3D): number {
  if ((target as BufferGeometry).isBufferGeometry === true) {
    const g = target as BufferGeometry;
    return (g.index !== null ? g.index.count : g.attributes.position.count) / 3;
  }
  let total = 0;
  (target as Object3D).traverse((object) => {
    const mesh = object as Mesh;
    if (mesh.isMesh === true) total += triangleCount(mesh.geometry);
  });
  return total;
}

export interface HelixArrays {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly uvs: Float32Array;
}

/**
 * Helicoid screw flight about +y: the band between radii `inner` and `outer`, climbing `pitch` per turn from `y0`,
 * `turns` turns of `perTurn` segments, two triangles per segment, non-indexed. The analytic normal of
 * P(r, θ) = (r cosθ, y0 + kθ, r sinθ), k = pitch / 2π, is ∂P/∂θ × ∂P/∂r = (k sinθ, r, -k cosθ): it faces up, and
 * the triangles are wound so their face normal agrees with it. The material should be double-sided.
 */
export function helixFlight(
  inner: number,
  outer: number,
  pitch: number,
  turns: number,
  perTurn: number,
  y0: number,
): HelixArrays {
  const segments = turns * perTurn;
  const positions = new Float32Array(segments * 18);
  const normals = new Float32Array(segments * 18);
  const uvs = new Float32Array(segments * 12);
  const k = pitch / (2 * Math.PI);
  let p = 0;
  let u = 0;
  const vertex = (r: number, j: number): void => {
    const theta = (2 * Math.PI * j) / perTurn;
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    positions[p] = r * c;
    positions[p + 1] = y0 + pitch * (j / perTurn);
    positions[p + 2] = r * s;
    const inv = 1 / Math.hypot(k * s, r, k * c);
    normals[p] = k * s * inv;
    normals[p + 1] = r * inv;
    normals[p + 2] = -k * c * inv;
    p += 3;
    uvs[u] = (r - inner) / (outer - inner);
    uvs[u + 1] = j / perTurn;
    u += 2;
  };
  for (let j = 0; j < segments; j++) {
    vertex(inner, j);
    vertex(inner, j + 1);
    vertex(outer, j);
    vertex(inner, j + 1);
    vertex(outer, j + 1);
    vertex(outer, j);
  }
  return { positions, normals, uvs };
}

/** The helix flight as a mergeable part (white vertex colour). */
export function helixGeometry(
  inner: number,
  outer: number,
  pitch: number,
  turns: number,
  perTurn: number,
  y0: number,
): BufferGeometry {
  const arrays = helixFlight(inner, outer, pitch, turns, perTurn, y0);
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(arrays.positions, 3));
  g.setAttribute('normal', new BufferAttribute(arrays.normals, 3));
  g.setAttribute('uv', new BufferAttribute(arrays.uvs, 2));
  return part(g);
}
