import { DataTexture, LinearFilter, LinearMipmapLinearFilter, NoColorSpace, RGBAFormat, RepeatWrapping, UnsignedByteType } from 'three';

/** Side of the tiling detail texture in texels. */
export const DETAIL_SIZE = 256;

/** Lattice periods (cells per tile) and weights of the fine relief octaves. */
const RELIEF_OCTAVES: ReadonlyArray<readonly [number, number]> = [
  [8, 0.3],
  [16, 0.26],
  [32, 0.2],
  [64, 0.14],
  [128, 0.1],
];
/** Slow mottling stored in alpha (albedo blotches). */
const MOTTLE_OCTAVES: ReadonlyArray<readonly [number, number]> = [
  [4, 0.55],
  [8, 0.3],
  [16, 0.15],
];

/** Small deterministic PRNG (mulberry32); the texture must be identical on every run. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Adds one octave of periodic value noise (wraps at the tile edge) to `out`. */
function addOctave(out: Float32Array, size: number, period: number, weight: number, rng: () => number): void {
  const lattice = new Float32Array(period * period);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rng();
  const scale = period / size;
  // Cell index pair and smooth weight per texel coordinate; the same table serves rows and columns.
  const cell0 = new Int32Array(size);
  const cell1 = new Int32Array(size);
  const blend = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    const f = i * scale;
    const i0 = Math.floor(f);
    const t = f - i0;
    cell0[i] = i0 % period;
    cell1[i] = (i0 + 1) % period;
    blend[i] = t * t * (3 - 2 * t);
  }
  for (let y = 0; y < size; y++) {
    const row0 = cell0[y] * period;
    const row1 = cell1[y] * period;
    const sy = blend[y];
    const base = y * size;
    for (let x = 0; x < size; x++) {
      const c0 = cell0[x];
      const c1 = cell1[x];
      const sx = blend[x];
      const top = lattice[row0 + c0] + (lattice[row0 + c1] - lattice[row0 + c0]) * sx;
      const bottom = lattice[row1 + c0] + (lattice[row1 + c1] - lattice[row1 + c0]) * sx;
      out[base + x] += weight * (top + (bottom - top) * sy);
    }
  }
}

/**
 * Tiling regolith detail, RGBA8: R = micro-relief height, G and B = its slope along u and v (0.5 = flat),
 * A = slow mottling. Pure (no DOM, no WebGL); runs once at startup.
 */
export function buildDetailData(size = DETAIL_SIZE, seed = 20261114): Uint8Array {
  const rng = mulberry32(seed);
  const height = new Float32Array(size * size);
  const mottle = new Float32Array(size * size);
  for (const [period, weight] of RELIEF_OCTAVES) if (period <= size) addOctave(height, size, period, weight, rng);
  for (const [period, weight] of MOTTLE_OCTAVES) if (period <= size) addOctave(mottle, size, period, weight, rng);

  let maxSlope = 1e-6;
  const slopes = new Float32Array(size * size * 2);
  for (let y = 0; y < size; y++) {
    const up = ((y + size - 1) % size) * size;
    const down = ((y + 1) % size) * size;
    for (let x = 0; x < size; x++) {
      const left = (x + size - 1) % size;
      const right = (x + 1) % size;
      const du = height[y * size + right] - height[y * size + left];
      const dv = height[down + x] - height[up + x];
      const o = (y * size + x) * 2;
      slopes[o] = du;
      slopes[o + 1] = dv;
      maxSlope = Math.max(maxSlope, Math.abs(du), Math.abs(dv));
    }
  }

  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const o = i * 4;
    data[o] = Math.round(255 * Math.min(1, Math.max(0, height[i])));
    data[o + 1] = Math.round(255 * (0.5 + (0.5 * slopes[i * 2]) / maxSlope));
    data[o + 2] = Math.round(255 * (0.5 + (0.5 * slopes[i * 2 + 1]) / maxSlope));
    data[o + 3] = Math.round(255 * Math.min(1, Math.max(0, mottle[i])));
  }
  return data;
}

/** Repeating, mip-mapped detail texture shared by the terrain and the block walls. One per engine. */
export function createDetailTexture(): DataTexture {
  const texture = new DataTexture(buildDetailData(), DETAIL_SIZE, DETAIL_SIZE, RGBAFormat, UnsignedByteType);
  texture.name = 'regolith-detail';
  texture.colorSpace = NoColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}
