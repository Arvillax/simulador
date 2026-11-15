import { Color, DynamicDrawUsage, Mesh, PlaneGeometry } from 'three';
import type { BufferAttribute, MeshLambertMaterial, Texture } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { createNoise2D } from 'simplex-noise';
import type { NoiseFunction2D } from 'simplex-noise';
import alea from 'alea';
import type { SynthTimings } from './SandboxEngine.ts';
import type { Rgb } from './BodyLook.ts';
import { createDetailTexture } from './DetailTexture.ts';
import { createTerrainMaterial } from './TerrainMaterial.ts';
import type { TerrainUniforms } from './TerrainMaterial.ts';
import { DEG2RAD } from './ScratchMath.ts';

/** Plot side length in metres (20 x 20 m). */
export const PLOT_SIZE = 20;
export const PLOT_HALF = PLOT_SIZE / 2;
/** 127 segments per side -> 128 x 128 = 16,384 vertices. */
export const TERRAIN_SEGMENTS = 127;
/** A_max in metres. */
export const NOISE_AMPLITUDE_M = 1.2;
/** f0 in 1/m. */
export const NOISE_BASE_FREQUENCY = 0.18;
/** Sum of the octave weights 2^-k for k = 0..2. */
export const NOISE_OCTAVE_WEIGHT_SUM = 1.75;

export const ICE_TEMPERATURE_K = 260;
export const BASALT_ALBEDO_MAX = 0.16;

export type SurfaceClass = 'ICE' | 'BASALT' | 'OCHRE';

// Height-field state shared by the mesh synthesis and sampleHeight(). Mutated only by configureHeightField().
let noise2D: NoiseFunction2D = createNoise2D(alea(0));
let noiseSeed = Number.NaN;
let offsetX = 0;
let offsetZ = 0;
let slopeTan = 0;
let amplitude = 0;

/**
 * Configures the analytic height field y(x, z). The simplex permutation table is rebuilt only when the seed
 * changes; slope and roughness changes are O(1).
 */
export function configureHeightField(seed: number, slopeDeg: number, tri: number): void {
  if (seed !== noiseSeed) {
    const rng = alea(seed);
    noise2D = createNoise2D(rng);
    // Offsets s_x, s_z come from the same seeded stream, after the permutation table.
    offsetX = rng() * 512 - 256;
    offsetZ = rng() * 512 - 256;
    noiseSeed = seed;
  }
  slopeTan = Math.tan(slopeDeg * DEG2RAD);
  amplitude = NOISE_AMPLITUDE_M * tri;
}

/** Σ_{k=0..2} 2^-k · simplex(2^k f0 x + s_x, 2^k f0 z + s_z), bounded by ±1.75. */
export function sampleNoise(x: number, z: number): number {
  const f = NOISE_BASE_FREQUENCY;
  return (
    noise2D(f * x + offsetX, f * z + offsetZ) +
    0.5 * noise2D(2 * f * x + offsetX, 2 * f * z + offsetZ) +
    0.25 * noise2D(4 * f * x + offsetX, 4 * f * z + offsetZ)
  );
}

/** Exact ground elevation used by the mesh: y = x·tan(slope) + A_max·TRI·noise(x, z). O(1). */
export function sampleHeight(x: number, z: number): number {
  return x * slopeTan + amplitude * sampleNoise(x, z);
}

export function classifySurface(albedo: number, tempK: number): SurfaceClass {
  if (tempK < ICE_TEMPERATURE_K) return 'ICE';
  if (albedo <= BASALT_ALBEDO_MAX) return 'BASALT';
  return 'OCHRE';
}

/** Writes the ground colour for a surface class into `out` (no allocation). */
export function surfaceColor(surface: SurfaceClass, albedo: number, out: Color): Color {
  const light = Math.min(1, 0.6 + albedo);
  if (surface === 'ICE') return out.setRGB(0.82 * light + 0.1, 0.87 * light + 0.1, 0.93 * light + 0.07);
  if (surface === 'BASALT') return out.setRGB(0.16 + albedo * 0.6, 0.16 + albedo * 0.6, 0.17 + albedo * 0.6);
  return out.setRGB(0.55 * light, 0.32 * light, 0.18 * light);
}

/** Darkening of the low tint on steep faces. */
const STEEP_TINT_FACTOR = 0.72;

/**
 * 128 x 128 terrain mesh deformed in place on the CPU. The BVH is built once and refitted afterwards.
 * Colour comes from the shader (slope, height, tiling detail texture): synthesis writes no per-vertex colour.
 */
export class TerrainGenerator {
  readonly geometry: PlaneGeometry;
  readonly material: MeshLambertMaterial;
  readonly mesh: Mesh<PlaneGeometry, MeshLambertMaterial>;
  /** Tiling detail texture, shared with the block walls. */
  readonly detailTexture: Texture;
  readonly uniforms: TerrainUniforms;
  surfaceClass: SurfaceClass = 'BASALT';
  /** `surfaceColor` of the current surface class and albedo (linear). Input of the palette, not shown directly. */
  readonly surfaceTint = new Color(0.3, 0.3, 0.31);
  /** Albedo of the last synthesis. */
  albedo = 0.14;
  private readonly positionAttr: BufferAttribute;
  private readonly positions: Float32Array;
  private bvh: MeshBVH | null = null;

  constructor(detailTexture: Texture = createDetailTexture()) {
    this.geometry = new PlaneGeometry(PLOT_SIZE, PLOT_SIZE, TERRAIN_SEGMENTS, TERRAIN_SEGMENTS);
    this.geometry.rotateX(-Math.PI / 2);
    this.positionAttr = this.geometry.getAttribute('position') as BufferAttribute;
    this.positionAttr.setUsage(DynamicDrawUsage);
    (this.geometry.getAttribute('normal') as BufferAttribute).setUsage(DynamicDrawUsage);
    this.positions = this.positionAttr.array as Float32Array;
    this.detailTexture = detailTexture;
    const { material, uniforms } = createTerrainMaterial(detailTexture);
    this.material = material;
    this.uniforms = uniforms;
    this.mesh = new Mesh(this.geometry, this.material);
    this.mesh.name = 'terrain';
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();
  }

  get boundsTree(): MeshBVH | null {
    return this.bvh;
  }

  /** Vertex positions (x, y, z per vertex, row-major from -z to +z). Read-only for callers. */
  get positionArray(): Float32Array {
    return this.positions;
  }

  /** Lowest terrain elevation of the last synthesis (from the geometry bounding box). */
  get minY(): number {
    return this.geometry.boundingBox?.min.y ?? 0;
  }

  /** Highest terrain elevation of the last synthesis. */
  get maxY(): number {
    return this.geometry.boundingBox?.max.y ?? 0;
  }

  /** Writes the palette of the current body look into the shader uniforms (no allocation). */
  setPalette(low: Rgb, high: Rgb): void {
    const u = this.uniforms;
    u.uTintLow.value.setRGB(low[0], low[1], low[2]);
    u.uTintHigh.value.setRGB(high[0], high[1], high[2]);
    u.uTintSteep.value.setRGB(low[0] * STEEP_TINT_FACTOR, low[1] * STEEP_TINT_FACTOR, low[2] * STEEP_TINT_FACTOR);
  }

  /** Deforms the mesh in place and fills noiseMs / normalsMs / bvhMs of `timings`. */
  synthesize(
    seed: number,
    slopeDeg: number,
    tri: number,
    albedo: number,
    tempK: number,
    timings: SynthTimings,
  ): void {
    const t0 = performance.now();
    configureHeightField(seed, slopeDeg, tri);
    const pos = this.positions;
    const f = NOISE_BASE_FREQUENCY;
    const f2 = 2 * f;
    const f4 = 4 * f;
    const sx = offsetX;
    const sz = offsetZ;
    const tanS = slopeTan;
    const amp = amplitude;
    const noise = noise2D;
    for (let i = 0; i < pos.length; i += 3) {
      const x = pos[i];
      const z = pos[i + 2];
      pos[i + 1] =
        x * tanS +
        amp *
          (noise(f * x + sx, f * z + sz) +
            0.5 * noise(f2 * x + sx, f2 * z + sz) +
            0.25 * noise(f4 * x + sx, f4 * z + sz));
    }
    this.positionAttr.needsUpdate = true;
    this.uniforms.uRelief.value.set(tanS, 1 / (amp * NOISE_OCTAVE_WEIGHT_SUM + 0.05));
    const t1 = performance.now();
    timings.noiseMs = t1 - t0;

    this.geometry.computeVertexNormals();
    const t2 = performance.now();
    timings.normalsMs = t2 - t1;

    this.geometry.computeBoundingBox();
    this.geometry.computeBoundingSphere();
    if (this.bvh === null) {
      this.buildBvh();
    } else {
      this.bvh.refit();
    }
    timings.bvhMs = performance.now() - t2;

    this.applySurface(albedo, tempK);
  }

  /** Full MeshBVH rebuild (for benchmarking against refit). Returns elapsed ms. */
  rebuildBvhFull(): number {
    const t0 = performance.now();
    this.buildBvh();
    return performance.now() - t0;
  }

  private buildBvh(): void {
    this.bvh = new MeshBVH(this.geometry);
    this.geometry.boundsTree = this.bvh;
  }

  private applySurface(albedo: number, tempK: number): void {
    this.surfaceClass = classifySurface(albedo, tempK);
    this.albedo = albedo;
    surfaceColor(this.surfaceClass, albedo, this.surfaceTint);
  }
}
