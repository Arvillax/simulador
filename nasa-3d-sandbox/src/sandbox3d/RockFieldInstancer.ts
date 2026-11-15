import { BufferAttribute, DynamicDrawUsage, InstancedMesh, MeshLambertMaterial, OctahedronGeometry } from 'three';
import FastPoissonDiskSampling from 'fast-2d-poisson-disk-sampling';
import alea from 'alea';
import { PLOT_HALF, PLOT_SIZE, sampleHeight } from './TerrainGenerator.ts';
import type { SurfaceClass } from './TerrainGenerator.ts';
import { _c1, _e1, _m1, _q1, _scale, _v1, clamp01, lerp } from './ScratchMath.ts';

export const MAX_ROCKS = 1000;
/** Collider layout per rock: [x, yGround, z, radius]. */
export const ROCK_STRIDE = 4;
export const rockColliders = new Float32Array(MAX_ROCKS * ROCK_STRIDE);
/** Live rock count (mutated in place). */
export const rockState = { count: 0 };
/** Rocks are flattened vertically; the relief above the ground is scaled by this factor. */
export const ROCK_VERTICAL_SCALE = 0.75;
/** Must stay below the 1 m grid cell so a 3 x 3 neighbourhood query is exhaustive. */
export const ROCK_MAX_RADIUS = 0.6;

const GRID_RES = PLOT_SIZE; // 1 m cells
const GRID_CELLS = GRID_RES * GRID_RES;
const cellStart = new Int32Array(GRID_CELLS + 1);
const cellCursor = new Int32Array(GRID_CELLS);
const cellItems = new Int32Array(MAX_ROCKS);

type AleaPrng = ReturnType<typeof alea>;
type AleaState = [number, number, number, number];

export function poissonRadiusForTri(tri: number): number {
  return lerp(4.0, 0.6, clamp01(tri));
}

export function targetRockCount(tri: number): number {
  return Math.floor(MAX_ROCKS * clamp01(tri));
}

function cellCoord(v: number): number {
  const c = Math.floor(v + PLOT_HALF);
  return c < 0 ? 0 : c >= GRID_RES ? GRID_RES - 1 : c;
}

/** Counting-sort rebuild of the uniform grid (1 m cells) from the first `count` colliders. */
export function rebuildRockGrid(count: number): void {
  cellStart.fill(0);
  for (let i = 0; i < count; i++) {
    const o = i * ROCK_STRIDE;
    cellStart[cellCoord(rockColliders[o]) * GRID_RES + cellCoord(rockColliders[o + 2]) + 1]++;
  }
  for (let c = 0; c < GRID_CELLS; c++) {
    cellStart[c + 1] += cellStart[c];
    cellCursor[c] = cellStart[c];
  }
  for (let i = 0; i < count; i++) {
    const o = i * ROCK_STRIDE;
    const cell = cellCoord(rockColliders[o]) * GRID_RES + cellCoord(rockColliders[o + 2]);
    cellItems[cellCursor[cell]++] = i;
  }
  rockState.count = count;
}

/** Height of the rock surface above the local ground at (x, z), 0 when no rock covers the point. */
export function rockReliefAt(x: number, z: number): number {
  const cx = cellCoord(x);
  const cz = cellCoord(z);
  let best = 0;
  for (let ix = cx - 1; ix <= cx + 1; ix++) {
    if (ix < 0 || ix >= GRID_RES) continue;
    for (let iz = cz - 1; iz <= cz + 1; iz++) {
      if (iz < 0 || iz >= GRID_RES) continue;
      const cell = ix * GRID_RES + iz;
      for (let k = cellStart[cell]; k < cellStart[cell + 1]; k++) {
        const o = cellItems[k] * ROCK_STRIDE;
        const dx = x - rockColliders[o];
        const dz = z - rockColliders[o + 2];
        const r = rockColliders[o + 3];
        const d2 = dx * dx + dz * dz;
        if (d2 < r * r) {
          const h = ROCK_VERTICAL_SCALE * Math.sqrt(r * r - d2);
          if (h > best) best = h;
        }
      }
    }
  }
  return best;
}

/** Index of the first rock whose footprint (radius + margin) contains (x, z), or -1. */
export function findRockNear(x: number, z: number, margin: number): number {
  const cx = cellCoord(x);
  const cz = cellCoord(z);
  for (let ix = cx - 1; ix <= cx + 1; ix++) {
    if (ix < 0 || ix >= GRID_RES) continue;
    for (let iz = cz - 1; iz <= cz + 1; iz++) {
      if (iz < 0 || iz >= GRID_RES) continue;
      const cell = ix * GRID_RES + iz;
      for (let k = cellStart[cell]; k < cellStart[cell + 1]; k++) {
        const idx = cellItems[k];
        const o = idx * ROCK_STRIDE;
        const dx = x - rockColliders[o];
        const dz = z - rockColliders[o + 2];
        const rr = rockColliders[o + 3] + margin;
        if (dx * dx + dz * dz < rr * rr) return idx;
      }
    }
  }
  return -1;
}

/** Deterministic value in [0, 1) from an integer key. */
function hash01(key: number): number {
  const h = Math.sin(key * 12.9898 + 4.1414) * 43758.5453;
  return h - Math.floor(h);
}

/**
 * Low-poly boulder: a subdivided octahedron (32 flat faces, so 1000 rocks stay within the triangle budget with
 * the shadow pass) pushed in and out per corner, with a flattened crown. The jitter is keyed by the quantised
 * corner position, so the faces that share a corner move together and the mesh stays watertight. A vertex
 * colour darkens the base where the rock meets the ground.
 */
function buildRockGeometry(): OctahedronGeometry {
  const geo = new OctahedronGeometry(1, 1);
  const pos = geo.getAttribute('position') as BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const key = Math.round(x * 100) * 73 + Math.round(y * 100) * 179 + Math.round(z * 100) * 283;
    const k = 0.62 + 0.46 * hash01(key);
    let py = y * k;
    if (py > 0.7) py = 0.7 + (py - 0.7) * 0.6;
    pos.setXYZ(i, x * k * 1.06, py, z * k * 0.94);
    const shade = 0.6 + 0.4 * clamp01((py + 0.1) / 0.55);
    colors[i * 3] = shade;
    colors[i * 3 + 1] = shade;
    colors[i * 3 + 2] = shade;
  }
  geo.setAttribute('color', new BufferAttribute(colors, 3));
  geo.computeVertexNormals(); // non-indexed: one flat normal per face, no derivative-based flat shading needed
  return geo;
}

/**
 * One InstancedMesh (one draw call, plus one in the shadow pass) with up to 1000 rocks distributed by
 * Poisson-disk sampling.
 */
export class RockFieldInstancer {
  readonly mesh: InstancedMesh;
  readonly material: MeshLambertMaterial;
  private pds: FastPoissonDiskSampling | null = null;
  private pdsRadius = Number.NaN;
  private rng: AleaPrng = alea(0);
  private rngState: AleaState = [0, 0, 0, 0];
  private rngSeed = Number.NaN;
  /** Stable RNG entry point handed to the sampler once; it always reads the current seeded stream. */
  private readonly rngProxy: () => number;

  constructor() {
    this.material = new MeshLambertMaterial({ color: 0x4a4a4e, vertexColors: true });
    this.mesh = new InstancedMesh(buildRockGeometry(), this.material, MAX_ROCKS);
    this.mesh.name = 'rock-field';
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false; // the whole plot is always framed; avoids recomputing instance bounds
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    // Per-instance colour jitter keyed by the instance index: written once here, so regeneration costs nothing
    // and the seeded placement stream is not touched.
    for (let i = 0; i < MAX_ROCKS; i++) {
      const value = 0.74 + 0.36 * hash01(i * 2 + 1);
      const warmth = (hash01(i * 2 + 2) - 0.5) * 0.1;
      this.mesh.setColorAt(i, _c1.setRGB(value * (1 + warmth), value, value * (1 - warmth)));
    }
    this.rngProxy = () => this.rng();
  }

  /** Base tint from the terrain palette (the engine passes it slightly darker than the ground). */
  setTint(r: number, g: number, b: number): void {
    this.material.color.setRGB(r, g, b);
  }

  /** Regenerates the field for (seed, TRI). Allocation here happens only on vector change. Returns the count. */
  regenerate(seed: number, tri: number): number {
    const radius = poissonRadiusForTri(tri);
    if (seed !== this.rngSeed) {
      this.rng = alea(seed, 'rocks');
      this.rngState = this.rng.exportState();
      this.rngSeed = seed;
    } else {
      this.rng.importState(this.rngState);
    }
    if (this.pds === null || radius !== this.pdsRadius) {
      // The sampler's radius is fixed at construction, so a new radius needs a new instance.
      this.pds = new FastPoissonDiskSampling({ shape: [PLOT_SIZE, PLOT_SIZE], radius, tries: 20 }, this.rngProxy);
      this.pdsRadius = radius;
    } else {
      this.pds.reset();
    }
    const points = this.pds.fill();
    const count = Math.min(targetRockCount(tri), points.length);
    const rng = this.rng;
    for (let i = 0; i < count; i++) {
      // Even stride over the generation order keeps a sparse subset spread over the whole plot.
      const p = points[count === points.length ? i : Math.floor((i * points.length) / count)];
      const x = p[0] - PLOT_HALF;
      const z = p[1] - PLOT_HALF;
      const r = Math.min(ROCK_MAX_RADIUS, radius * (0.1 + 0.12 * rng()));
      const y = sampleHeight(x, z);
      const o = i * ROCK_STRIDE;
      rockColliders[o] = x;
      rockColliders[o + 1] = y;
      rockColliders[o + 2] = z;
      rockColliders[o + 3] = r;
      _e1.set((rng() - 0.5) * 0.6, rng() * Math.PI * 2, (rng() - 0.5) * 0.6);
      _q1.setFromEuler(_e1);
      _scale.set(r * (0.85 + 0.3 * rng()), r * ROCK_VERTICAL_SCALE, r * (0.85 + 0.3 * rng()));
      _v1.set(x, y, z);
      _m1.compose(_v1, _q1, _scale);
      this.mesh.setMatrixAt(i, _m1);
    }
    this.mesh.count = count;
    this.mesh.instanceMatrix.needsUpdate = true;
    rebuildRockGrid(count);
    return count;
  }

  applySurface(surface: SurfaceClass): void {
    if (surface === 'ICE') this.material.color.setRGB(0.55, 0.57, 0.6);
    else if (surface === 'BASALT') this.material.color.setRGB(0.22, 0.22, 0.24);
    else this.material.color.setRGB(0.42, 0.26, 0.17);
  }
}
