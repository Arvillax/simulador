import { describe, expect, it } from 'vitest';
import {
  AP_TRANSITION,
  APOLLO11_LUNAR_RUN_SPEED,
  APOLLO16_RUN_METABOLIC_MAX_W,
  APOLLO16_RUN_METABOLIC_MIN_W,
  CREW_BODY_MASS_KG,
  G_EARTH,
  G_MARS,
  G_MOON,
  SUIT_MASS_A7LB_WET_KG,
  apolloNumber,
  createGaitInputs,
  createGaitState,
  createPuffParams,
  footfallPuff,
  froudeNumber,
  humanMassFraction,
  slipMargin,
  solveGait,
} from './GaitModel.ts';
import type { GaitInputs, GaitState } from './GaitModel.ts';

const LEG = 0.92;

function solve(overrides: Partial<GaitInputs>): GaitState {
  return solveGait(createGaitInputs({ legLength: LEG, roughness: 0.3, ...overrides }), createGaitState());
}

describe('dimensionless numbers', () => {
  it('computes Fr = v^2 / (g L) and Ap = Fr / M', () => {
    expect(froudeNumber(1, 9.81, 1)).toBeCloseTo(1 / 9.81, 12);
    expect(froudeNumber(0.89, G_MOON, LEG)).toBeCloseTo((0.89 * 0.89) / (G_MOON * LEG), 12);
    expect(apolloNumber(0.36, 0.5)).toBeCloseTo(0.72, 12);
  });

  it('uses the human share of the transported mass as M', () => {
    const m = humanMassFraction(CREW_BODY_MASS_KG, SUIT_MASS_A7LB_WET_KG);
    expect(m).toBeCloseTo(CREW_BODY_MASS_KG / (CREW_BODY_MASS_KG + SUIT_MASS_A7LB_WET_KG), 12);
    expect(SUIT_MASS_A7LB_WET_KG).toBe(96);
  });

  it('reports Fr and Ap consistent with its own speed', () => {
    for (const g of [G_MOON, G_MARS, G_EARTH]) {
      const s = solve({ gravity: g });
      const m = humanMassFraction(CREW_BODY_MASS_KG, SUIT_MASS_A7LB_WET_KG);
      expect(s.froude).toBeCloseTo((s.speed * s.speed) / (g * LEG), 9);
      expect(s.apollo).toBeCloseTo(s.froude / m, 9);
    }
  });
});

describe('gait choice', () => {
  it('lopes on the Moon and walks on Earth with the same inputs', () => {
    const moon = solve({ gravity: G_MOON });
    const earth = solve({ gravity: G_EARTH });
    expect(moon.gait).toBe('lope');
    expect(earth.gait).toBe('walk');
    expect(moon.apollo).toBeGreaterThanOrEqual(AP_TRANSITION);
    expect(earth.apollo).toBeLessThan(AP_TRANSITION);
  });

  it('walks on Mars, with a slower cadence and a longer stride than on Earth', () => {
    const mars = solve({ gravity: G_MARS });
    const earth = solve({ gravity: G_EARTH });
    expect(mars.gait).toBe('walk');
    expect(mars.cadence).toBeLessThan(earth.cadence);
    expect(mars.strideLength).toBeGreaterThan(earth.strideLength);
  });

  it('gives the bouncing gait a flight phase and the walk none', () => {
    const moon = solve({ gravity: G_MOON });
    const earth = solve({ gravity: G_EARTH });
    expect(moon.flightTime).toBeGreaterThan(0.1);
    expect(moon.dutyFactor).toBeLessThan(0.5);
    expect(earth.flightTime).toBe(0);
    expect(earth.dutyFactor).toBeGreaterThan(0.5);
  });

  it('never picks run automatically, but runs when forced', () => {
    for (const g of [0.3, G_MOON, G_MARS, G_EARTH, 20]) expect(solve({ gravity: g }).gait).not.toBe('run');
    const run = solve({ gravity: G_MOON, forceGait: 'run' });
    expect(run.gait).toBe('run');
    expect(run.flightTime).toBeGreaterThan(0);
  });

  it('drops a slowed lope back to a walk below the Apollo-number transition', () => {
    const steep = solve({ gravity: G_MOON, slopeDeg: 25 });
    expect(steep.stopped).toBe(false);
    expect(steep.gait).toBe('walk');
    expect(steep.apollo).toBeLessThan(AP_TRANSITION);
  });
});

describe('speed scaling', () => {
  it('scales close to sqrt(g) between bodies on flat ground for the same gait', () => {
    const ratio = Math.sqrt(G_EARTH / G_MOON);
    const walkMoon = solve({ gravity: G_MOON, forceGait: 'walk' });
    const walkEarth = solve({ gravity: G_EARTH, forceGait: 'walk' });
    const r = walkEarth.speed / walkMoon.speed / ratio;
    expect(r).toBeGreaterThan(0.9);
    expect(r).toBeLessThan(1.1);
    const lopeMoon = solve({ gravity: G_MOON, forceGait: 'lope' });
    const lopeEarth = solve({ gravity: G_EARTH, forceGait: 'lope' });
    expect(lopeEarth.speed / lopeMoon.speed).toBeCloseTo(ratio, 9);
  });

  it('lopes at the Apollo 11 speed on flat, smooth lunar ground', () => {
    const s = solve({ gravity: G_MOON, roughness: 0 });
    expect(s.speed).toBeCloseTo(APOLLO11_LUNAR_RUN_SPEED, 6);
  });

  it('slows down with slope (both ways) and with roughness', () => {
    const flat = solve({ gravity: G_EARTH, roughness: 0 });
    const up = solve({ gravity: G_EARTH, roughness: 0, slopeDeg: 10 });
    const down = solve({ gravity: G_EARTH, roughness: 0, slopeDeg: -10 });
    const rough = solve({ gravity: G_EARTH, roughness: 1 });
    expect(up.speed).toBeLessThan(flat.speed);
    expect(down.speed).toBeLessThan(flat.speed);
    expect(up.speed).toBeCloseTo(down.speed, 9);
    expect(rough.speed).toBeLessThan(flat.speed);
  });

  it('keeps cadence and stride consistent with speed', () => {
    const s = solve({ gravity: G_MARS });
    // Two steps per stride.
    expect((s.cadence / 120) * s.strideLength).toBeCloseTo(s.speed, 9);
    expect(s.strideFrequency * s.strideLength).toBeCloseTo(s.speed, 9);
  });
});

describe('slip limit', () => {
  it('has a positive margin on flat ground that shrinks with |slope|', () => {
    expect(slipMargin(0, 0.6)).toBeGreaterThan(0.5);
    expect(slipMargin(15, 0.6)).toBeLessThan(slipMargin(5, 0.6));
    expect(slipMargin(-15, 0.6)).toBeCloseTo(slipMargin(15, 0.6), 12);
  });

  it('stops the walker beyond the slip margin', () => {
    const s = solve({ gravity: G_MOON, slopeDeg: 35 });
    expect(s.slipMargin).toBeLessThanOrEqual(0);
    expect(s.stopped).toBe(true);
    expect(s.gait).toBe('stand');
    expect(s.speed).toBe(0);
    expect(s.cadence).toBe(0);
  });
});

describe('metabolic estimate', () => {
  it('lands in the Apollo 16 suited running range for the lunar lope', () => {
    const s = solve({ gravity: G_MOON });
    expect(s.metabolicW).toBeGreaterThanOrEqual(APOLLO16_RUN_METABOLIC_MIN_W);
    expect(s.metabolicW).toBeLessThanOrEqual(APOLLO16_RUN_METABOLIC_MAX_W);
  });

  it('costs more uphill than on the flat', () => {
    const flat = solve({ gravity: G_MARS, roughness: 0 });
    const up = solve({ gravity: G_MARS, roughness: 0, slopeDeg: 8 });
    expect(up.metabolicW / up.speed).toBeGreaterThan(flat.metabolicW / flat.speed);
  });
});

describe('determinism and allocation', () => {
  it('returns identical results for identical inputs and writes into the given object', () => {
    const inputs = createGaitInputs({ gravity: G_MARS, legLength: LEG, slopeDeg: 4.2, roughness: 0.45 });
    const a = createGaitState();
    const b = createGaitState();
    expect(solveGait(inputs, a)).toBe(a);
    solveGait(inputs, b);
    expect(b).toEqual(a);
    solveGait(inputs, a);
    expect(a).toEqual(b);
  });
});

describe('footfall dust puff', () => {
  it('throws dust farther in low gravity and with speed', () => {
    const moon = footfallPuff(0.8, G_MOON, createPuffParams());
    const earth = footfallPuff(0.8, G_EARTH, createPuffParams());
    expect(moon.range).toBeGreaterThan(earth.range);
    expect(moon.count).toBeGreaterThan(earth.count);
    expect(moon.life).toBeGreaterThan(earth.life);
    const slow = footfallPuff(0.2, G_MOON, createPuffParams());
    expect(slow.range).toBeLessThan(moon.range);
    expect(footfallPuff(0, G_MOON, createPuffParams()).count).toBeGreaterThanOrEqual(0);
  });
});
