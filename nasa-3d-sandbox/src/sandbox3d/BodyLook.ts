/**
 * Scene look per world (art direction, "3D look per world"). Pure data and helpers: no DOM, no WebGL, no three
 * objects, so it is importable in Node tests and safe to blend inside the rAF loop without allocating.
 *
 * Every colour is a linear-sRGB triple in 0..1 (the working space of the renderer). Hex literals below are written
 * in sRGB, as a designer reads them, and converted once at module load.
 */

export type Body = 'moon' | 'mars' | 'earth';

export const BODIES: readonly Body[] = ['moon', 'mars', 'earth'];

/** Linear-sRGB colour, components in 0..1. Mutable so blends can write in place. */
export type Rgb = [number, number, number];

export interface BodyLook {
  /** Body accent token of the art direction (sRGB hex). It is not blended: it switches to the target. */
  accent: number;
  /** Backdrop gradient, top of the frame. */
  skyTop: Rgb;
  /** Backdrop gradient at the horizon band (the brightest band on worlds with an atmosphere). */
  skyHorizon: Rgb;
  /** Backdrop gradient, bottom of the frame. */
  skyBottom: Rgb;
  /** Height of the horizon band in the frame, 0 (bottom) to 1 (top). */
  horizonAt: number;
  sunColor: Rgb;
  /** DirectionalLight intensity. 0 means no direct sun (permanently shadowed presets). */
  sunIntensity: number;
  /** Sun elevation above the horizon (degrees). */
  sunElevationDeg: number;
  /** Sun azimuth (degrees), from +x toward +z: the LiDAR solver convention. */
  sunAzimuthDeg: number;
  /** HemisphereLight sky colour (light from above). */
  hemiSky: Rgb;
  /** HemisphereLight ground colour (bounce from below). */
  hemiGround: Rgb;
  hemiIntensity: number;
  /** Tone-mapping exposure. */
  exposure: number;
  hazeColor: Rgb;
  /** Exponential-squared fog density (1/m). 0 means no haze. */
  hazeDensity: number;
  /** Regolith tint pair: hollows and compacted ground. */
  regolithLow: Rgb;
  /** Regolith tint pair: crests and loose dust. */
  regolithHigh: Rgb;
  /** 0 = the regolith pair alone sets the hue; 1 = the hue comes from the surface class (ice, basalt, ochre). */
  surfaceMix: number;
  /** PCF shadow radius in shadow-map texels: 1 is crisp. */
  shadowRadius: number;
}

type ScalarKey =
  | 'horizonAt'
  | 'sunIntensity'
  | 'sunElevationDeg'
  | 'sunAzimuthDeg'
  | 'hemiIntensity'
  | 'exposure'
  | 'hazeDensity'
  | 'surfaceMix'
  | 'shadowRadius';

type RgbKey =
  | 'skyTop'
  | 'skyHorizon'
  | 'skyBottom'
  | 'sunColor'
  | 'hemiSky'
  | 'hemiGround'
  | 'hazeColor'
  | 'regolithLow'
  | 'regolithHigh';

const SCALAR_KEYS: readonly ScalarKey[] = [
  'horizonAt',
  'sunIntensity',
  'sunElevationDeg',
  'sunAzimuthDeg',
  'hemiIntensity',
  'exposure',
  'hazeDensity',
  'surfaceMix',
  'shadowRadius',
];

const RGB_KEYS: readonly RgbKey[] = [
  'skyTop',
  'skyHorizon',
  'skyBottom',
  'sunColor',
  'hemiSky',
  'hemiGround',
  'hazeColor',
  'regolithLow',
  'regolithHigh',
];

/** Number of texels of the vertical backdrop gradient. */
export const BACKDROP_ROWS = 64;

const DEG2RAD = Math.PI / 180;

function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function linearToSrgb(v: number): number {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

/** sRGB hex (0xrrggbb) to a new linear triple. Allocates: module load and tests only. */
export function rgbFromHex(hex: number): Rgb {
  return [srgbToLinear(((hex >> 16) & 255) / 255), srgbToLinear(((hex >> 8) & 255) / 255), srgbToLinear((hex & 255) / 255)];
}

// ---------------------------------------------------------------------------------------------------------------
// The three worlds. Sun azimuths stay on the same side of the block (from -z) so the cut wall facing the hero
// camera is the lit one on every world.
// ---------------------------------------------------------------------------------------------------------------
export const BODY_LOOKS: Readonly<Record<Body, BodyLook>> = {
  // Black sky, hard low polar sun, low fill (only the light bounced by the sunlit ground): crisp and long
  // shadows on neutral grey regolith.
  moon: {
    accent: 0xb8c7d6,
    skyTop: rgbFromHex(0x000000),
    skyHorizon: rgbFromHex(0x0c0d10),
    skyBottom: rgbFromHex(0x040405),
    horizonAt: 0.42,
    sunColor: rgbFromHex(0xfff7ec),
    sunIntensity: 6.8,
    sunElevationDeg: 8, // LiDAR solver sun (SUN_ELEVATION_DEG)
    sunAzimuthDeg: 250, // LiDAR solver sun (SUN_AZIMUTH_DEG)
    hemiSky: rgbFromHex(0x8c98aa),
    hemiGround: rgbFromHex(0x4a4744),
    hemiIntensity: 0.9,
    exposure: 1.0,
    hazeColor: rgbFromHex(0x000000),
    hazeDensity: 0,
    regolithLow: rgbFromHex(0x8a8885),
    regolithHigh: rgbFromHex(0xcfccc6),
    surfaceMix: 0,
    shadowRadius: 1,
  },
  // Tawny sky brighter at the horizon, smaller warm sun, strong sky light, dust haze, ochre-to-rust regolith.
  mars: {
    accent: 0xe08a4f,
    skyTop: rgbFromHex(0x6b4a33),
    skyHorizon: rgbFromHex(0xd6ad82),
    skyBottom: rgbFromHex(0x8a6243),
    horizonAt: 0.46,
    sunColor: rgbFromHex(0xffe6c8),
    sunIntensity: 3.6,
    sunElevationDeg: 34,
    sunAzimuthDeg: 262,
    hemiSky: rgbFromHex(0xdcb088),
    hemiGround: rgbFromHex(0x6a4329),
    hemiIntensity: 1.6,
    exposure: 0.95,
    hazeColor: rgbFromHex(0xcda57c),
    hazeDensity: 0.011,
    regolithLow: rgbFromHex(0x8a4a2a),
    regolithHigh: rgbFromHex(0xdc9c62),
    surfaceMix: 0.12,
    shadowRadius: 2.2,
  },
  // Cold grey-blue sky, medium neutral sun and sky light, light haze; the hue comes from the surface class.
  earth: {
    accent: 0x7fb69a,
    skyTop: rgbFromHex(0x566a7e),
    skyHorizon: rgbFromHex(0xb7c3cc),
    skyBottom: rgbFromHex(0x74828d),
    horizonAt: 0.46,
    sunColor: rgbFromHex(0xfff4e2),
    sunIntensity: 3.4,
    sunElevationDeg: 44,
    sunAzimuthDeg: 240,
    hemiSky: rgbFromHex(0xb6c8da),
    hemiGround: rgbFromHex(0x5a5346),
    hemiIntensity: 1.2,
    exposure: 0.86,
    hazeColor: rgbFromHex(0xb1bcc5),
    hazeDensity: 0.007,
    regolithLow: rgbFromHex(0x7b7468),
    regolithHigh: rgbFromHex(0xcfc6b6),
    surfaceMix: 1,
    shadowRadius: 3,
  },
};

/** A zeroed look with its own arrays, to be used as a blend target. Allocates: call once, outside the loop. */
export function createLook(): BodyLook {
  return {
    accent: 0,
    skyTop: [0, 0, 0],
    skyHorizon: [0, 0, 0],
    skyBottom: [0, 0, 0],
    horizonAt: 0,
    sunColor: [0, 0, 0],
    sunIntensity: 0,
    sunElevationDeg: 0,
    sunAzimuthDeg: 0,
    hemiSky: [0, 0, 0],
    hemiGround: [0, 0, 0],
    hemiIntensity: 0,
    exposure: 0,
    hazeColor: [0, 0, 0],
    hazeDensity: 0,
    regolithLow: [0, 0, 0],
    regolithHigh: [0, 0, 0],
    surfaceMix: 0,
    shadowRadius: 0,
  };
}

/** Blends two looks into `out` in place (no allocation). `out` may be `a` or `b`. */
export function blendLooks(a: BodyLook, b: BodyLook, t: number, out: BodyLook): BodyLook {
  const u = 1 - t;
  for (let k = 0; k < SCALAR_KEYS.length; k++) {
    const key = SCALAR_KEYS[k];
    out[key] = a[key] * u + b[key] * t;
  }
  for (let k = 0; k < RGB_KEYS.length; k++) {
    const key = RGB_KEYS[k];
    const ca = a[key];
    const cb = b[key];
    const co = out[key];
    co[0] = ca[0] * u + cb[0] * t;
    co[1] = ca[1] * u + cb[1] * t;
    co[2] = ca[2] * u + cb[2] * t;
  }
  out.accent = t > 0 ? b.accent : a.accent;
  return out;
}

/** Copies `src` into `out` in place (no allocation). */
export function copyLook(src: BodyLook, out: BodyLook): BodyLook {
  return blendLooks(src, src, 1, out);
}

/** Permanently shadowed variant: no direct sun, dim cold fill, darker sky, more exposure. */
function shadowedVariant(look: BodyLook): BodyLook {
  const out = copyLook(look, createLook());
  const coldSky = rgbFromHex(0x8ea6cc);
  const coldGround = rgbFromHex(0x2a2f3a);
  out.sunIntensity = 0;
  out.hemiIntensity = 0.8;
  out.exposure = look.exposure * 1.7;
  out.hazeDensity = 0;
  for (let i = 0; i < 3; i++) {
    out.hemiSky[i] = coldSky[i];
    out.hemiGround[i] = coldGround[i];
    out.skyTop[i] = look.skyTop[i] * 0.12;
    out.skyHorizon[i] = look.skyHorizon[i] * 0.12;
    out.skyBottom[i] = look.skyBottom[i] * 0.12;
  }
  return out;
}

const SHADOWED_LOOKS: Readonly<Record<Body, BodyLook>> = {
  moon: shadowedVariant(BODY_LOOKS.moon),
  mars: shadowedVariant(BODY_LOOKS.mars),
  earth: shadowedVariant(BODY_LOOKS.earth),
};

/** The shared look of a body. `sunlit = false` selects the variant without direct sun. Never allocates. */
export function lookFor(body: Body, sunlit = true): BodyLook {
  return sunlit ? BODY_LOOKS[body] : SHADOWED_LOOKS[body];
}

export function isBody(value: unknown): value is Body {
  return value === 'moon' || value === 'mars' || value === 'earth';
}

const GRAVITY_TOLERANCE = 0.02;

/** 1.62 m/s² is the Moon, 3.71–3.72 m/s² is Mars, anything else is shown as the Earth analog. */
export function bodyFromGravity(gravity: number): Body {
  if (Math.abs(gravity - 1.62) < GRAVITY_TOLERANCE) return 'moon';
  if (Math.abs(gravity - 3.71) < GRAVITY_TOLERANCE) return 'mars';
  return 'earth';
}

/** Unit vector toward the sun, in the LiDAR solver convention. Writes into `out` (a Vector3 fits). */
export function sunDirection(
  elevationDeg: number,
  azimuthDeg: number,
  out: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  const el = elevationDeg * DEG2RAD;
  const az = azimuthDeg * DEG2RAD;
  const c = Math.cos(el);
  out.x = c * Math.cos(az);
  out.y = Math.sin(el);
  out.z = c * Math.sin(az);
  return out;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Share of the surface-class colour in the low and high tints (below 1 so bright ice never clips to white). */
const SURFACE_LOW = 0.5;
const SURFACE_HIGH = 0.94;
const WALL_GAIN_MIN = 0.3;
const WALL_GAIN_MAX = 0.8;

/**
 * Terrain palette for a look: the regolith pair scaled by a lightness taken from the albedo, mixed with the
 * surface-class colour (`surfaceColor` of TerrainGenerator) by `look.surfaceMix`. Writes `outLow` (hollows) and
 * `outHigh` (crests); no allocation.
 */
export function terrainPalette(
  look: BodyLook,
  surfaceR: number,
  surfaceG: number,
  surfaceB: number,
  albedo: number,
  outLow: Rgb,
  outHigh: Rgb,
): void {
  const lightness = Math.min(1.25, Math.max(0.55, 0.52 + 1.5 * albedo));
  const m = look.surfaceMix;
  const u = 1 - m;
  const low = look.regolithLow;
  const high = look.regolithHigh;
  outLow[0] = clamp01(low[0] * lightness * u + surfaceR * SURFACE_LOW * m);
  outLow[1] = clamp01(low[1] * lightness * u + surfaceG * SURFACE_LOW * m);
  outLow[2] = clamp01(low[2] * lightness * u + surfaceB * SURFACE_LOW * m);
  outHigh[0] = clamp01(high[0] * lightness * u + surfaceR * SURFACE_HIGH * m);
  outHigh[1] = clamp01(high[1] * lightness * u + surfaceG * SURFACE_HIGH * m);
  outHigh[2] = clamp01(high[2] * lightness * u + surfaceB * SURFACE_HIGH * m);
}

/**
 * Albedo factor of the block walls for a sun direction. A low sun grazes the ground but hits a cut face almost
 * head-on, which would burn the strata to white; the factor brings the best-lit wall back to about the
 * brightness of flat ground. Without direct sun the walls take the plain factor.
 */
export function wallGain(sunX: number, sunY: number, sunZ: number, sunIntensity: number): number {
  const flat = Math.max(0.05, sunY);
  const wall = Math.max(Math.abs(sunX), Math.abs(sunZ), flat);
  const lit = Math.min(WALL_GAIN_MAX, Math.max(WALL_GAIN_MIN, (1.4 * flat) / wall));
  const sun = clamp01(sunIntensity / 2);
  return WALL_GAIN_MAX * (1 - sun) + lit * sun;
}

/**
 * Display value (sRGB-encoded, 0..1) of a linear radiance: a soft shoulder, then the sRGB curve. For unlit
 * sprites whose shader skips the renderer's tone mapping and output encoding (the dust batch).
 */
export function displayTone(linear: number): number {
  const mapped = 1 - Math.exp(-Math.max(0, linear));
  return linearToSrgb(mapped);
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/**
 * Writes the vertical backdrop gradient of `look` into an RGBA8 column (`data.length / 4` rows, row 0 at the
 * bottom of the frame), sRGB-encoded. No allocation: the same buffer is rewritten on every world change.
 */
export function writeBackdrop(look: BodyLook, data: Uint8Array): void {
  const rows = data.length >> 2;
  const last = rows - 1;
  const horizon = Math.min(0.999, Math.max(0.001, look.horizonAt));
  const top = look.skyTop;
  const mid = look.skyHorizon;
  const bottom = look.skyBottom;
  for (let i = 0; i < rows; i++) {
    const v = last > 0 ? i / last : 0;
    const o = i << 2;
    if (v <= horizon) {
      const t = smooth(v / horizon);
      for (let c = 0; c < 3; c++) data[o + c] = Math.round(255 * linearToSrgb(bottom[c] * (1 - t) + mid[c] * t));
    } else {
      const t = smooth((v - horizon) / (1 - horizon));
      for (let c = 0; c < 3; c++) data[o + c] = Math.round(255 * linearToSrgb(mid[c] * (1 - t) + top[c] * t));
    }
    data[o + 3] = 255;
  }
}
