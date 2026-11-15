import {
  AdditiveBlending,
  Color,
  DataTexture,
  DataUtils,
  EquirectangularReflectionMapping,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  MeshBasicMaterial,
  MeshStandardMaterial,
  NoColorSpace,
  PMREMGenerator,
  RGBAFormat,
  RepeatWrapping,
  SRGBColorSpace,
  UnsignedByteType,
  Vector3,
} from 'three';
import type { Material, WebGLCubeRenderTarget, WebGLRenderer } from 'three';
import { lookFor, sunDirection } from './BodyLook.ts';
import type { Body } from './BodyLook.ts';

// ---------------------------------------------------------------------------------------------------------------
// Shared hardware material kit (art direction, "Hardware material kit"): one set of materials for the rover, the
// suit, the lander and the drill, so the four read as one programme. Every texture is generated here, once.
// All kit materials use vertex colours, so one material (one draw call) can carry several tints of a finish.
// ---------------------------------------------------------------------------------------------------------------

/** The one marking colour (sRGB). Applied as a vertex colour on white paint or beta cloth. */
export const MARKING_ORANGE = 0xe0661f;

/** Crinkle tiles per metre on foil parts (pass as uvDensity to HardwareGeometry.part). */
export const MLI_UV_DENSITY = 1.3;

export interface HardwareKit {
  /** Multi-layer insulation: gold-coloured metal foil with a crinkle normal map. */
  readonly mli: MeshStandardMaterial;
  /** White thermal paint (dielectric). */
  readonly paint: MeshStandardMaterial;
  /** Anodised dark aluminium (structure, suspension, housings). */
  readonly darkAluminium: MeshStandardMaterial;
  /** Bare machined aluminium (wheels, struts). */
  readonly wheelAluminium: MeshStandardMaterial;
  /** Solar cells behind cover glass, procedural cell grid. */
  readonly solarCell: MeshStandardMaterial;
  /** Gold-coated visor glass. */
  readonly visor: MeshStandardMaterial;
  /** Off-white beta cloth (suit soft goods, blankets). */
  readonly betaCloth: MeshStandardMaterial;
  /** Emissive lamp face. */
  readonly lamp: MeshStandardMaterial;
  /** Fake light pool on the ground (additive decal); hidden while the site has direct sun. */
  readonly lampPool: MeshBasicMaterial;
}

// ---------------------------------------------------------------------------------------------------------------
// Pure texture generators (DOM-free, deterministic; unit tested).
// ---------------------------------------------------------------------------------------------------------------

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

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/**
 * Tileable tangent-space normal map of crumpled foil, RGBA8 (size x size). The height field is a sum of ridged,
 * wrapped value-noise octaves, so creases are sharp folds; normals come from wrapped central differences and the
 * steepest texel is limited to a 56° tilt.
 */
export function crinkleNormalData(size: number, seed: number): Uint8Array {
  const rand = mulberry32(seed);
  const height = new Float32Array(size * size);
  const octaves: readonly (readonly [number, number])[] = [
    [4, 1],
    [8, 0.55],
    [16, 0.3],
  ];
  for (const [cells, amp] of octaves) {
    const lattice = new Float32Array(cells * cells);
    for (let i = 0; i < lattice.length; i++) lattice[i] = rand() * 2 - 1;
    for (let y = 0; y < size; y++) {
      const fy = (y / size) * cells;
      const iy = Math.floor(fy);
      const ty = smooth(fy - iy);
      const y0 = iy % cells;
      const y1 = (iy + 1) % cells;
      for (let x = 0; x < size; x++) {
        const fx = (x / size) * cells;
        const ix = Math.floor(fx);
        const tx = smooth(fx - ix);
        const x0 = ix % cells;
        const x1 = (ix + 1) % cells;
        const top = lattice[y0 * cells + x0] * (1 - tx) + lattice[y0 * cells + x1] * tx;
        const bottom = lattice[y1 * cells + x0] * (1 - tx) + lattice[y1 * cells + x1] * tx;
        const v = top * (1 - ty) + bottom * ty;
        height[y * size + x] += amp * (1 - Math.abs(v)); // ridged: folds where the noise crosses zero
      }
    }
  }
  const dx = new Float32Array(size * size);
  const dy = new Float32Array(size * size);
  let maxSlope = 1e-6;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const gx = height[y * size + ((x + 1) % size)] - height[y * size + ((x + size - 1) % size)];
      const gy = height[((y + 1) % size) * size + x] - height[((y + size - 1) % size) * size + x];
      dx[i] = gx;
      dy[i] = gy;
      maxSlope = Math.max(maxSlope, Math.hypot(gx, gy));
    }
  }
  const gain = 1.5 / maxSlope; // steepest texel: slope 1.5, i.e. z = 0.55
  const out = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const nx = -dx[i] * gain;
    const ny = -dy[i] * gain;
    const inv = 1 / Math.hypot(nx, ny, 1);
    out[i * 4] = Math.round((nx * inv * 0.5 + 0.5) * 255);
    out[i * 4 + 1] = Math.round((ny * inv * 0.5 + 0.5) * 255);
    out[i * 4 + 2] = Math.round((inv * 0.5 + 0.5) * 255);
    out[i * 4 + 3] = 255;
  }
  return out;
}

/**
 * Solar array tile, sRGB RGBA8 (size x size): 4 x 4 dark blue cells with a faint vertical sheen, separated by
 * light interconnect gaps on the tile edges.
 */
export function solarCellData(size: number): Uint8Array {
  const cell = size / 4;
  const line = Math.max(1, Math.round(size / 64));
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = x % cell;
      const cy = y % cell;
      const o = (y * size + x) * 4;
      if (cx < line || cy < line) {
        out[o] = 178;
        out[o + 1] = 184;
        out[o + 2] = 192;
      } else {
        const sheen = 1 - Math.abs(cy / cell - 0.5) * 2; // brighter mid-cell
        out[o] = 14 + Math.round(6 * sheen);
        out[o + 1] = 26 + Math.round(10 * sheen);
        out[o + 2] = 58 + Math.round(22 * sheen);
      }
      out[o + 3] = 255;
    }
  }
  return out;
}

/** Soft radial falloff for the lamp pool, RGBA8: (1 - smoothstep(d))², white premultiplied by the falloff. */
export function poolFalloffData(size: number): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = ((x + 0.5) / size) * 2 - 1;
      const v = ((y + 0.5) / size) * 2 - 1;
      const d = Math.min(1, Math.hypot(u, v));
      const a = Math.pow(1 - smooth(d), 2);
      const o = (y * size + x) * 4;
      out[o] = out[o + 1] = out[o + 2] = Math.round(a * 255);
      out[o + 3] = 255;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// The kit (created on first use, shared by every asset).
// ---------------------------------------------------------------------------------------------------------------

function dataTexture(data: Uint8Array, size: number, srgb: boolean, repeat: boolean): DataTexture {
  const texture = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  texture.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  if (repeat) {
    texture.wrapS = RepeatWrapping;
    texture.wrapT = RepeatWrapping;
  }
  texture.needsUpdate = true;
  return texture;
}

function standard(name: string, color: number, roughness: number, metalness: number): MeshStandardMaterial {
  const material = new MeshStandardMaterial({ color, roughness, metalness, vertexColors: true });
  material.name = `kit-${name}`;
  return material;
}

/** Lamp emission with and without direct sun (linear multiplier of the emissive colour). */
const LAMP_SUNLIT = 1.6;
const LAMP_DARK = 5.5;

let kit: HardwareKit | null = null;
/** Metal and glass materials that receive the hardware environment map (never the terrain). */
const envMaterials = new Set<MeshStandardMaterial>();
const envIntensity = new Map<MeshStandardMaterial, number>();

export function getHardwareKit(): HardwareKit {
  if (kit !== null) return kit;
  const crinkle = dataTexture(crinkleNormalData(128, 20261114), 128, false, true);
  // Foil parts use world-scaled UVs (HardwareGeometry uvDensity), so the map is not repeated here.
  const cells = dataTexture(solarCellData(64), 64, true, true);
  cells.repeat.set(4, 4);
  cells.anisotropy = 4;
  const pool = dataTexture(poolFalloffData(64), 64, false, false);

  const mli = standard('mli', 0xd4a446, 0.3, 0.95);
  mli.normalMap = crinkle;
  mli.normalScale.set(0.45, 0.45);
  const paint = standard('paint', 0xe9e6df, 0.58, 0);
  const darkAluminium = standard('dark-aluminium', 0x2b2e33, 0.42, 0.7);
  const wheelAluminium = standard('wheel-aluminium', 0xb4b8bd, 0.34, 1);
  const solarCell = standard('solar-cell', 0xffffff, 0.22, 0.25);
  solarCell.map = cells;
  const visor = standard('visor', 0xd9a23a, 0.1, 1);
  const betaCloth = standard('beta-cloth', 0xe6e1d5, 0.86, 0);
  const lamp = standard('lamp', 0x1a1a1a, 0.3, 0);
  lamp.emissive = new Color(0xfff0d6);
  lamp.emissiveIntensity = LAMP_SUNLIT;
  const lampPool = new MeshBasicMaterial({
    color: 0xffd9a6,
    map: pool,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  lampPool.name = 'kit-lamp-pool';
  lampPool.visible = false; // sunlit by default

  kit = { mli, paint, darkAluminium, wheelAluminium, solarCell, visor, betaCloth, lamp, lampPool };
  registerEnvMaterial(mli, 0.8);
  registerEnvMaterial(darkAluminium, 0.7);
  registerEnvMaterial(wheelAluminium, 0.9);
  registerEnvMaterial(solarCell, 1);
  registerEnvMaterial(visor, 1);
  return kit;
}

/** True when the material belongs to the shared kit. */
export function isKitMaterial(material: Material): boolean {
  const k = getHardwareKit();
  return Object.values(k).includes(material);
}

// ---------------------------------------------------------------------------------------------------------------
// Hardware environment map: a tiny procedural equirectangular sky/ground from the world look, prefiltered with
// PMREM and assigned through `material.envMap` to metal and glass only. `scene.environment` is never set.
// ---------------------------------------------------------------------------------------------------------------
const ENV_W = 128;
const ENV_H = 64;
const SUN_DISC_COS = Math.cos((6 * Math.PI) / 180);
let envData: Uint16Array | null = null;
let envSource: DataTexture | null = null;
let pmrem: PMREMGenerator | null = null;
let envTarget: WebGLCubeRenderTarget | null = null;
const _sun = new Vector3();

/** Adds a metal or glass material to the environment-mapped set (assigned at once if the map exists). */
export function registerEnvMaterial(material: MeshStandardMaterial, intensity = 1): void {
  envMaterials.add(material);
  envIntensity.set(material, intensity);
  material.envMapIntensity = intensity;
  if (envTarget !== null) material.envMap = envTarget.texture;
}

/**
 * Writes the linear HDR radiance of the hardware environment (RGBA, ENV_W x ENV_H) for a world: its sky above the
 * horizon, its sunlit (or unlit) regolith below, and the sun disc. Pure; exported for tests and reuse.
 */
export function writeEnvironment(body: Body, sunlit: boolean, out: Float32Array): Float32Array {
  const look = lookFor(body, sunlit);
  sunDirection(look.sunElevationDeg, look.sunAzimuthDeg, _sun);
  const sunUp = Math.max(_sun.y, 0.15);
  const groundLight = (look.sunIntensity * sunUp + 0.7 * look.hemiIntensity) / Math.PI;
  const skyLight = 0.45 * look.hemiIntensity;
  for (let j = 0; j < ENV_H; j++) {
    const elevation = ((j + 0.5) / ENV_H - 0.5) * Math.PI;
    const cosE = Math.cos(elevation);
    const sinE = Math.sin(elevation);
    for (let i = 0; i < ENV_W; i++) {
      const azimuth = ((i + 0.5) / ENV_W - 0.5) * Math.PI * 2;
      const dx = cosE * Math.cos(azimuth);
      const dz = cosE * Math.sin(azimuth);
      const o = (j * ENV_W + i) * 4;
      let r: number;
      let g: number;
      let b: number;
      if (sinE >= 0) {
        const t = smooth(Math.min(1, sinE / 0.6));
        r = (look.skyHorizon[0] * (1 - t) + look.skyTop[0] * t) * skyLight;
        g = (look.skyHorizon[1] * (1 - t) + look.skyTop[1] * t) * skyLight;
        b = (look.skyHorizon[2] * (1 - t) + look.skyTop[2] * t) * skyLight;
        const toSun = dx * _sun.x + sinE * _sun.y + dz * _sun.z;
        if (look.sunIntensity > 0 && toSun > SUN_DISC_COS) {
          const k = look.sunIntensity * 4;
          r += look.sunColor[0] * k;
          g += look.sunColor[1] * k;
          b += look.sunColor[2] * k;
        }
      } else {
        // Regolith seen from the hardware: brighter toward the horizon where it faces the low sun.
        const fade = 0.7 + 0.3 * smooth(Math.min(1, 1 + sinE / 0.5));
        r = look.regolithHigh[0] * groundLight * fade;
        g = look.regolithHigh[1] * groundLight * fade;
        b = look.regolithHigh[2] * groundLight * fade;
      }
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = 1;
    }
  }
  return out;
}

/**
 * (Re)builds the hardware environment for a world and assigns it to the kit's metal and glass. Call once with the
 * renderer before the first compile, then on every world change (outside the frame loop: it renders a PMREM).
 * The render target is reused, so later calls swap no texture and compile no program.
 */
export function applyHardwareEnvironment(renderer: WebGLRenderer, body: Body, sunlit: boolean): void {
  getHardwareKit();
  if (envData === null) envData = new Uint16Array(ENV_W * ENV_H * 4);
  const linear = writeEnvironment(body, sunlit, new Float32Array(ENV_W * ENV_H * 4));
  for (let i = 0; i < linear.length; i++) envData[i] = DataUtils.toHalfFloat(linear[i]);
  if (envSource === null) {
    envSource = new DataTexture(envData, ENV_W, ENV_H, RGBAFormat, HalfFloatType);
    envSource.mapping = EquirectangularReflectionMapping;
    envSource.colorSpace = NoColorSpace;
    envSource.magFilter = LinearFilter;
    envSource.minFilter = LinearFilter;
    envSource.generateMipmaps = false;
  }
  envSource.needsUpdate = true;
  if (pmrem === null) pmrem = new PMREMGenerator(renderer);
  envTarget = pmrem.fromEquirectangular(envSource, envTarget);
  for (const material of envMaterials) {
    if (material.envMap !== envTarget.texture) {
      material.envMap = envTarget.texture;
      material.needsUpdate = true;
    }
    material.envMapIntensity = envIntensity.get(material) ?? 1;
  }
}

/** Lamps carry the hardware where there is no direct sun: brighter emission and the ground pools on. */
export function setHardwareSunlit(sunlit: boolean): void {
  const k = getHardwareKit();
  k.lamp.emissiveIntensity = sunlit ? LAMP_SUNLIT : LAMP_DARK;
  k.lampPool.visible = !sunlit;
}
