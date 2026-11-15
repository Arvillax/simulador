import { describe, expect, it } from 'vitest';
import {
  MSE_MAX,
  MSE_MIN,
  ROP_MAX,
  ROP_MIN,
  hayneDryDensity,
  iceWeightFraction,
  icyDensity,
  mechanicalSpecificEnergy,
  rateOfPenetration,
} from './IsruDrillSolver.ts';

describe('Hayne density profile', () => {
  it('starts at 1100 kg/m3 and approaches 1800 kg/m3 at 1.5 m', () => {
    expect(hayneDryDensity(0)).toBe(1100);
    expect(hayneDryDensity(1.5)).toBeCloseTo(1800, 5);
  });

  it('adds ice below 265 K and only below 0.10 m', () => {
    for (const tempK of [45, 150, 220, 255, 264]) {
      for (const z of [0.12, 0.4, 1.0, 1.5]) {
        expect(icyDensity(z, tempK)).toBeGreaterThan(hayneDryDensity(z));
      }
      expect(icyDensity(0.05, tempK)).toBe(hayneDryDensity(0.05));
    }
    for (const tempK of [265, 300, 400]) {
      for (const z of [0, 0.12, 0.8, 1.5]) {
        expect(icyDensity(z, tempK)).toBe(hayneDryDensity(z));
      }
    }
  });

  it('maps temperature to ice weight fraction within [0, 0.30]', () => {
    expect(iceWeightFraction(300)).toBe(0);
    expect(iceWeightFraction(265)).toBe(0);
    expect(iceWeightFraction(255)).toBeCloseTo(0.0625, 12);
    expect(iceWeightFraction(45)).toBe(0.3);
  });
});

describe('MSE and ROP', () => {
  it('keeps MSE in [0.8, 25] MJ/m3 and ROP in [1.2, 120] cm/h', () => {
    for (let tempK = 40; tempK <= 400; tempK += 20) {
      for (let z = 0; z <= 1.5; z += 0.05) {
        const ice = z >= 0.1 ? iceWeightFraction(tempK) : 0;
        const mse = mechanicalSpecificEnergy(icyDensity(z, tempK), ice);
        expect(mse).toBeGreaterThanOrEqual(MSE_MIN);
        expect(mse).toBeLessThanOrEqual(MSE_MAX);
        const rop = rateOfPenetration(mse);
        expect(rop).toBeGreaterThanOrEqual(ROP_MIN);
        expect(rop).toBeLessThanOrEqual(ROP_MAX);
      }
    }
  });

  it('drills slower through denser, icier material', () => {
    const loose = mechanicalSpecificEnergy(hayneDryDensity(0), 0);
    const icy = mechanicalSpecificEnergy(icyDensity(1.2, 45), iceWeightFraction(45));
    expect(icy).toBeGreaterThan(loose);
    expect(rateOfPenetration(icy)).toBeLessThan(rateOfPenetration(loose));
  });
});
