import { describe, expect, it } from 'vitest';
import {
  DustAccumulator,
  EDS_ENERGY_WH_PER_M2,
  EDS_FREQUENCY_HZ,
  EDS_POWER_W,
  EDS_VOLTAGE_KV,
  PANEL_AREA_M2,
  PANEL_NOMINAL_W,
  dustRatePerSol,
  effectiveDustRatePerSol,
  orthofabricWearIndex,
  solarAvailabilityFactor,
} from './SuitDustSolver.ts';

describe('dust obscuration model', () => {
  it('uses V^2 / R = 256 W as nominal panel power', () => {
    expect(PANEL_NOMINAL_W).toBe(256);
    expect(new DustAccumulator().powerW).toBe(256);
  });

  it('scales the Pathfinder rate by (1 - thermal inertia)', () => {
    expect(dustRatePerSol(0)).toBeCloseTo(0.00285, 12);
    expect(dustRatePerSol(1)).toBe(0);
    expect(dustRatePerSol(0.28)).toBeCloseTo(0.00285 * 0.72, 12);
  });

  it('lowers panel power over time and floors it at 0', () => {
    const acc = new DustAccumulator();
    acc.advance(20, 0.28);
    const p1 = acc.powerW;
    acc.advance(20, 0.28);
    const p2 = acc.powerW;
    expect(p1).toBeLessThan(PANEL_NOMINAL_W);
    expect(p2).toBeLessThan(p1);
    acc.advance(100000, 0);
    expect(acc.powerW).toBe(0);
    expect(acc.obscuration).toBe(1);
  });

  it('returns to 98 % power after an EDS pulse and books its energy', () => {
    const acc = new DustAccumulator();
    acc.advance(80, 0.1);
    expect(acc.powerW).toBeLessThan(0.9 * PANEL_NOMINAL_W);
    const energy = acc.pulse();
    expect(acc.powerW).toBeCloseTo(0.98 * PANEL_NOMINAL_W, 9);
    expect(energy).toBeCloseTo(EDS_ENERGY_WH_PER_M2 * PANEL_AREA_M2, 12);
    expect(acc.pulses).toBe(1);
    expect(acc.edsEnergyWh).toBeCloseTo(energy, 12);
  });

  it('uses verified NASA 4 kV / 10 Hz / 3 W EDS rating and supports PSR + silica + Mars saltation scaling', () => {
    expect(EDS_VOLTAGE_KV).toBe(4.0);
    expect(EDS_FREQUENCY_HZ).toBe(10);
    expect(EDS_POWER_W).toBe(3.0);
    expect(effectiveDustRatePerSol(0.5, 'mars', 0.5)).toBeGreaterThan(dustRatePerSol(0.5));
    expect(solarAvailabilityFactor('moon', true, 0)).toBe(0);
    expect(solarAvailabilityFactor('moon', false, 1)).toBe(0);
    expect(orthofabricWearIndex(70, 0.2)).toBeGreaterThan(orthofabricWearIndex(45, 0.2));
  });
});
