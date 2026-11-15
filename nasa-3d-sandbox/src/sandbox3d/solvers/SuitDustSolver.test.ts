import { describe, expect, it } from 'vitest';
import { Mesh } from 'three';
import {
  DustAccumulator,
  EDS_ENERGY_WH_PER_M2,
  EDS_FREQUENCY_HZ,
  EDS_POWER_W,
  EDS_VOLTAGE_KV,
  PANEL_AREA_M2,
  PANEL_NOMINAL_W,
  SUIT_FIELDS,
  SuitDustSolver,
  dustRatePerSol,
  effectiveDustRatePerSol,
  orthofabricWearIndex,
  solarAvailabilityFactor,
} from './SuitDustSolver.ts';
import { GAIT_NAMES } from '../GaitModel.ts';
import type { SolverContext } from './ModeSolver.ts';
import { createSitePhysicsState } from '../../bridge/copilotContract.ts';

describe('suit telemetry fields', () => {
  it('keeps the EDS and panel cards and adds the gait cards', () => {
    const keys = SUIT_FIELDS.map((f) => f.key);
    expect(keys.slice(0, 6)).toEqual(['sols', 'obscurationPct', 'panelW', 'powerPct', 'edsEnergyWh', 'pulses']);
    for (const k of ['gaitCode', 'speed', 'cadence', 'stride', 'froude', 'apollo', 'slipMarginPct', 'metabolicW']) {
      expect(keys).toContain(k);
    }
  });

  it('marks the gait values that rest on unverified constants', () => {
    for (const f of SUIT_FIELDS) {
      if (['speed', 'cadence', 'stride', 'froude', 'apollo', 'slipMarginPct', 'metabolicW'].includes(f.key)) {
        expect(f.label).toContain('est.');
      }
    }
  });
});

describe('gait card shows the gait by name', () => {
  it('maps the numeric code to the gait names through the field text', () => {
    const field = SUIT_FIELDS.find((f) => f.key === 'gaitCode');
    expect(field).toBeDefined();
    expect(field?.text).toEqual(GAIT_NAMES);
    expect(field?.text?.[1]).toBe('walk');
    expect(field?.text?.[2]).toBe('lope');
    expect(field?.label).not.toContain('0 stand');
  });
});

describe('gravity change re-evaluates the gait at once', () => {
  function makeSolver(gravity: number): { solver: SuitDustSolver; physics: { gravity: number } } {
    const physics = { gravity };
    const ctx: SolverContext = {
      vector: new Float32Array([0, 0.72, 0.28, 0.14, 255, 0.02]),
      physics,
      terrainMesh: new Mesh(),
      timings: {} as SolverContext['timings'],
      site: createSitePhysicsState(),
      emitAlert: () => {},
    };
    const solver = new SuitDustSolver(ctx);
    solver.setSiteSeed(7);
    solver.onVectorChanged();
    return { solver, physics };
  }

  it('drops the held gait: walk on Earth, lope on the Moon in the very next update', () => {
    const { solver, physics } = makeSolver(9.81);
    for (let i = 0; i < 240; i++) solver.update(1 / 60, i / 60);
    expect(solver.controller.state.gait).toBe('walk');
    expect(solver.walker.gait).toBe('walk');
    physics.gravity = 1.62;
    solver.update(1 / 60, 4);
    expect(solver.controller.state.gait).toBe('lope');
    expect(solver.walker.gait).toBe('lope');
    expect(solver.telemetry.gaitCode).toBe(2);
    expect(solver.telemetry.apexHeight).toBeGreaterThan(0);
    physics.gravity = 9.81;
    solver.update(1 / 60, 4.1);
    expect(solver.controller.state.gait).toBe('walk');
    expect(solver.walker.gait).toBe('walk');
    expect(solver.telemetry.apexHeight).toBe(0);
  });

  it('keeps hysteresis for noise at a constant g (no re-evaluation without a change)', () => {
    const { solver } = makeSolver(1.62);
    for (let i = 0; i < 120; i++) solver.update(1 / 60, i / 60);
    const before = solver.controller.state.gait;
    for (let i = 0; i < 120; i++) solver.update(1 / 60, 2 + i / 60);
    expect(solver.controller.state.gait).toBe(before);
  });
});

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
