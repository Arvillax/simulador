import { describe, expect, it } from 'vitest';
import {
  NOISE_AMPLITUDE_M,
  NOISE_OCTAVE_WEIGHT_SUM,
  classifySurface,
  configureHeightField,
  sampleHeight,
} from './TerrainGenerator.ts';

const PROBES: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [1.3, -2.7],
  [-8, 9.5],
  [9.9, 9.9],
  [-9.9, -4.2],
  [4.4, 0.1],
];

describe('sampleHeight', () => {
  it('is deterministic for a given seed and differs between seeds', () => {
    configureHeightField(42, 16, 0.72);
    const first = PROBES.map(([x, z]) => sampleHeight(x, z));

    configureHeightField(7, 16, 0.72);
    const other = PROBES.map(([x, z]) => sampleHeight(x, z));

    configureHeightField(42, 16, 0.72);
    const again = PROBES.map(([x, z]) => sampleHeight(x, z));

    expect(again).toEqual(first);
    expect(other).not.toEqual(first);
  });

  it('equals x * tan(slope) when TRI = 0', () => {
    for (const slopeDeg of [0, 5, 16, 30, 45]) {
      configureHeightField(3, slopeDeg, 0);
      for (const [x, z] of PROBES) {
        expect(sampleHeight(x, z)).toBeCloseTo(x * Math.tan((slopeDeg * Math.PI) / 180), 12);
      }
    }
  });

  it('keeps the noise part within 1.2 * TRI * 1.75', () => {
    for (const tri of [0.25, 0.5, 1]) {
      configureHeightField(99, 12, tri);
      const bound = NOISE_AMPLITUDE_M * tri * NOISE_OCTAVE_WEIGHT_SUM + 1e-9;
      const slopeTerm = Math.tan((12 * Math.PI) / 180);
      let maxAbs = 0;
      for (let x = -10; x <= 10; x += 0.37) {
        for (let z = -10; z <= 10; z += 0.41) {
          const noisePart = sampleHeight(x, z) - x * slopeTerm;
          maxAbs = Math.max(maxAbs, Math.abs(noisePart));
        }
      }
      expect(maxAbs).toBeLessThanOrEqual(bound);
      expect(maxAbs).toBeGreaterThan(0);
    }
  });
});

describe('classifySurface', () => {
  it('returns ICE below 260 K regardless of albedo (temperature wins)', () => {
    expect(classifySurface(0.1, 255)).toBe('ICE');
    expect(classifySurface(0.4, 45)).toBe('ICE');
  });

  it('returns BASALT for low albedo and OCHRE for intermediate albedo when warm', () => {
    expect(classifySurface(0.1, 300)).toBe('BASALT');
    expect(classifySurface(0.16, 300)).toBe('BASALT');
    expect(classifySurface(0.3, 300)).toBe('OCHRE');
  });
});
