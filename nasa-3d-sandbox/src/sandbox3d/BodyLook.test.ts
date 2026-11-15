import { describe, expect, it } from 'vitest';
import {
  BACKDROP_ROWS,
  BODIES,
  BODY_LOOKS,
  blendLooks,
  bodyFromGravity,
  copyLook,
  createLook,
  displayTone,
  isBody,
  lookFor,
  sunDirection,
  terrainPalette,
  wallGain,
  writeBackdrop,
} from './BodyLook.ts';
import type { BodyLook, Rgb } from './BodyLook.ts';
import { SUN_AZIMUTH_DEG, SUN_ELEVATION_DEG } from './solvers/LidarBvhSolver.ts';

function rgbFields(look: BodyLook): Rgb[] {
  return [
    look.skyTop,
    look.skyHorizon,
    look.skyBottom,
    look.sunColor,
    look.hemiSky,
    look.hemiGround,
    look.hazeColor,
    look.regolithLow,
    look.regolithHigh,
  ];
}

describe('bodyFromGravity', () => {
  it('maps the three surface gravities, anything else is the Earth analog', () => {
    expect(bodyFromGravity(1.62)).toBe('moon');
    expect(bodyFromGravity(3.71)).toBe('mars');
    expect(bodyFromGravity(3.72)).toBe('mars');
    expect(bodyFromGravity(9.81)).toBe('earth');
    expect(bodyFromGravity(5)).toBe('earth');
    expect(bodyFromGravity(0.1)).toBe('earth');
    expect(bodyFromGravity(Number.NaN)).toBe('earth');
  });
});

describe('isBody', () => {
  it('accepts only the three body names', () => {
    expect(isBody('moon')).toBe(true);
    expect(isBody('mars')).toBe(true);
    expect(isBody('earth')).toBe(true);
    expect(isBody('MOON')).toBe(false);
    expect(isBody(undefined)).toBe(false);
    expect(isBody(1.62)).toBe(false);
  });
});

describe('BODY_LOOKS', () => {
  it('carries the art-direction accent tokens', () => {
    expect(BODY_LOOKS.moon.accent).toBe(0xb8c7d6);
    expect(BODY_LOOKS.mars.accent).toBe(0xe08a4f);
    expect(BODY_LOOKS.earth.accent).toBe(0x7fb69a);
  });

  it('is physically motivated: no lunar haze, the lowest sun and the weakest fill on the Moon', () => {
    const { moon, mars, earth } = BODY_LOOKS;
    expect(moon.hazeDensity).toBe(0);
    expect(mars.hazeDensity).toBeGreaterThan(0);
    expect(earth.hazeDensity).toBeGreaterThan(0);
    expect(moon.sunElevationDeg).toBeLessThan(mars.sunElevationDeg);
    expect(moon.sunElevationDeg).toBeLessThan(earth.sunElevationDeg);
    expect(moon.hemiIntensity).toBeLessThan(earth.hemiIntensity);
    expect(earth.hemiIntensity).toBeLessThan(mars.hemiIntensity);
    expect(moon.shadowRadius).toBeLessThan(mars.shadowRadius);
    expect(mars.shadowRadius).toBeLessThan(earth.shadowRadius);
  });

  it('uses the LiDAR sun vector for the lunar sun', () => {
    expect(BODY_LOOKS.moon.sunElevationDeg).toBe(SUN_ELEVATION_DEG);
    expect(BODY_LOOKS.moon.sunAzimuthDeg).toBe(SUN_AZIMUTH_DEG);
  });

  it('has finite, usable values for every body', () => {
    for (const body of BODIES) {
      const look = BODY_LOOKS[body];
      expect(look.exposure).toBeGreaterThan(0);
      expect(look.sunIntensity).toBeGreaterThan(0);
      for (const c of rgbFields(look)) {
        expect(c).toHaveLength(3);
        for (const v of c) {
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});

describe('lookFor', () => {
  it('returns the shared sunlit look by default', () => {
    for (const body of BODIES) expect(lookFor(body)).toBe(BODY_LOOKS[body]);
  });

  it('returns a variant without direct sun for permanently shadowed presets', () => {
    const shadowed = lookFor('moon', false);
    expect(shadowed).not.toBe(BODY_LOOKS.moon);
    expect(shadowed.sunIntensity).toBe(0);
    expect(shadowed.hemiIntensity).toBeGreaterThan(0);
    expect(shadowed.accent).toBe(BODY_LOOKS.moon.accent);
    expect(lookFor('moon', false)).toBe(shadowed);
  });
});

describe('blendLooks', () => {
  it('returns a at t = 0 and b at t = 1', () => {
    const out = createLook();
    blendLooks(BODY_LOOKS.moon, BODY_LOOKS.mars, 0, out);
    expect(out).toEqual(BODY_LOOKS.moon);
    blendLooks(BODY_LOOKS.moon, BODY_LOOKS.mars, 1, out);
    expect(out).toEqual(BODY_LOOKS.mars);
  });

  it('interpolates scalars and colours linearly and switches the accent to the target', () => {
    const a = BODY_LOOKS.moon;
    const b = BODY_LOOKS.earth;
    const out = createLook();
    blendLooks(a, b, 0.25, out);
    expect(out.exposure).toBeCloseTo(a.exposure + (b.exposure - a.exposure) * 0.25, 6);
    expect(out.sunElevationDeg).toBeCloseTo(a.sunElevationDeg + (b.sunElevationDeg - a.sunElevationDeg) * 0.25, 6);
    for (let i = 0; i < 3; i++) {
      expect(out.skyHorizon[i]).toBeCloseTo(a.skyHorizon[i] + (b.skyHorizon[i] - a.skyHorizon[i]) * 0.25, 6);
      expect(out.regolithHigh[i]).toBeCloseTo(a.regolithHigh[i] + (b.regolithHigh[i] - a.regolithHigh[i]) * 0.25, 6);
    }
    expect(out.accent).toBe(b.accent);
  });

  it('writes in place: the output keeps its arrays and the inputs are untouched', () => {
    const out = createLook();
    const arrays = rgbFields(out);
    const moonBefore = copyLook(BODY_LOOKS.moon, createLook());
    const marsBefore = copyLook(BODY_LOOKS.mars, createLook());
    const returned = blendLooks(BODY_LOOKS.moon, BODY_LOOKS.mars, 0.6, out);
    expect(returned).toBe(out);
    rgbFields(out).forEach((arr, i) => expect(arr).toBe(arrays[i]));
    expect(BODY_LOOKS.moon).toEqual(moonBefore);
    expect(BODY_LOOKS.mars).toEqual(marsBefore);
  });

  it('supports the output aliasing the first input', () => {
    const from = copyLook(BODY_LOOKS.moon, createLook());
    blendLooks(from, BODY_LOOKS.mars, 0.5, from);
    expect(from.hemiIntensity).toBeCloseTo((BODY_LOOKS.moon.hemiIntensity + BODY_LOOKS.mars.hemiIntensity) / 2, 6);
  });
});

describe('sunDirection', () => {
  it('uses the LiDAR convention: elevation above the horizon, azimuth from +x toward +z', () => {
    const out = { x: 0, y: 0, z: 0 };
    sunDirection(8, 250, out);
    const el = (8 * Math.PI) / 180;
    const az = (250 * Math.PI) / 180;
    expect(out.x).toBeCloseTo(Math.cos(el) * Math.cos(az), 9);
    expect(out.y).toBeCloseTo(Math.sin(el), 9);
    expect(out.z).toBeCloseTo(Math.cos(el) * Math.sin(az), 9);
    expect(Math.hypot(out.x, out.y, out.z)).toBeCloseTo(1, 9);
  });
});

describe('terrainPalette', () => {
  const low: Rgb = [0, 0, 0];
  const high: Rgb = [0, 0, 0];
  const luma = (c: Rgb): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

  it('keeps the Moon neutral whatever the surface class hue, lighter with albedo', () => {
    terrainPalette(BODY_LOOKS.moon, 0.55, 0.32, 0.18, 0.14, low, high);
    const ochreHigh: Rgb = [high[0], high[1], high[2]];
    terrainPalette(BODY_LOOKS.moon, 0.82, 0.87, 0.93, 0.14, low, high);
    expect(high).toEqual(ochreHigh);
    expect(Math.max(...high) - Math.min(...high)).toBeLessThan(0.06);
    const dark = luma(high);
    terrainPalette(BODY_LOOKS.moon, 0.82, 0.87, 0.93, 0.4, low, high);
    expect(luma(high)).toBeGreaterThan(dark);
  });

  it('takes the Earth-analog hue from the surface class', () => {
    terrainPalette(BODY_LOOKS.earth, 0.55, 0.32, 0.18, 0.3, low, high);
    expect(high[0]).toBeGreaterThan(high[2]);
    terrainPalette(BODY_LOOKS.earth, 0.82, 0.87, 0.93, 0.3, low, high);
    expect(high[2]).toBeGreaterThan(high[0]);
  });

  it('always makes the high tint brighter than the low tint and stays within 0..1', () => {
    for (const body of BODIES) {
      for (const albedo of [0.05, 0.14, 0.3, 0.6]) {
        terrainPalette(BODY_LOOKS[body], 0.3, 0.3, 0.32, albedo, low, high);
        expect(luma(high)).toBeGreaterThan(luma(low));
        for (const v of [...low, ...high]) {
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});

describe('displayTone', () => {
  it('maps 0 to 0, grows monotonically and never reaches 1', () => {
    expect(displayTone(0)).toBe(0);
    expect(displayTone(-1)).toBe(0);
    let previous = 0;
    for (const v of [0.05, 0.2, 0.5, 1, 2, 8]) {
      const d = displayTone(v);
      expect(d).toBeGreaterThan(previous);
      expect(d).toBeLessThan(1);
      previous = d;
    }
  });
});

describe('wallGain', () => {
  it('dims the walls under a low sun and leaves them alone under a high sun or without sun', () => {
    const low = { x: 0, y: 0, z: 0 };
    const high = { x: 0, y: 0, z: 0 };
    sunDirection(8, 250, low);
    sunDirection(44, 240, high);
    const lowGain = wallGain(low.x, low.y, low.z, 6.8);
    const highGain = wallGain(high.x, high.y, high.z, 3.4);
    expect(lowGain).toBeCloseTo(0.3, 6);
    expect(highGain).toBeCloseTo(0.8, 6);
    expect(wallGain(low.x, low.y, low.z, 0)).toBeCloseTo(0.8, 6);
    // Best-lit wall and flat ground end up within a factor of two of each other.
    const wallLit = lowGain * Math.max(Math.abs(low.x), Math.abs(low.z));
    expect(wallLit / low.y).toBeGreaterThan(1);
    expect(wallLit / low.y).toBeLessThan(2.2);
  });
});

describe('writeBackdrop', () => {
  it('fills an RGBA column from the bottom colour to the top colour through the horizon', () => {
    const data = new Uint8Array(BACKDROP_ROWS * 4);
    const look = BODY_LOOKS.mars;
    writeBackdrop(look, data);
    const srgb = (v: number): number => Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055));
    const row = (i: number): number[] => [data[i * 4], data[i * 4 + 1], data[i * 4 + 2], data[i * 4 + 3]];
    expect(row(0)).toEqual([...look.skyBottom.map(srgb), 255]);
    expect(row(BACKDROP_ROWS - 1)).toEqual([...look.skyTop.map(srgb), 255]);
    const horizonRow = Math.round(look.horizonAt * (BACKDROP_ROWS - 1));
    const horizon = row(horizonRow);
    look.skyHorizon.map(srgb).forEach((v, i) => expect(Math.abs(horizon[i] - v)).toBeLessThanOrEqual(2));
  });
});
