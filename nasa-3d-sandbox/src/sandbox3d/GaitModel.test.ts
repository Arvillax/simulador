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
  GAIT_NAMES,
  SUIT_MASS_A7LB_WET_KG,
  TRANSITION_G_EXPONENT,
  apolloNumber,
  createGaitInputs,
  createGaitState,
  createPuffParams,
  footfallPuff,
  froudeNumber,
  humanMassFraction,
  slipMargin,
  solveGait,
  transitionApollo,
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

  it('walks on Mars (extrapolation, not verified), slower and with a visibly longer stride than on Earth', () => {
    const mars = solve({ gravity: G_MARS });
    const earth = solve({ gravity: G_EARTH });
    expect(mars.gait).toBe('walk');
    expect(mars.cadence).toBeLessThan(0.75 * earth.cadence);
    expect(mars.strideLength).toBeGreaterThan(1.07 * earth.strideLength);
    expect(mars.speed).toBeLessThan(0.8 * earth.speed);
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
  it('scales with sqrt(g) times the low-gravity Froude rise between bodies on flat ground', () => {
    // v = sqrt(Fr(g) · g · L) and the comfortable Fr of every gait rises as g^-k (the walk-run transition does).
    const expected = Math.pow(G_EARTH / G_MOON, (1 - TRANSITION_G_EXPONENT) / 2);
    const walkMoon = solve({ gravity: G_MOON, forceGait: 'walk' });
    const walkEarth = solve({ gravity: G_EARTH, forceGait: 'walk' });
    expect(walkEarth.speed / walkMoon.speed).toBeCloseTo(expected, 6);
    const lopeMoon = solve({ gravity: G_MOON, forceGait: 'lope' });
    const lopeEarth = solve({ gravity: G_EARTH, forceGait: 'lope' });
    expect(lopeEarth.speed / lopeMoon.speed).toBeCloseTo(expected, 6);
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

const SWEEP_G = [1.62, 2.5, 3.71, 6, 9.81] as const;
/** Default site vector of the sandbox: roughness 0.72, flat along the heading. */
const DEFAULT_SITE = { roughness: 0.72, slopeDeg: 0 };

function decreasing(values: readonly number[], strict: boolean): boolean {
  for (let i = 1; i < values.length; i++) {
    if (strict ? values[i] >= values[i - 1] : values[i] > values[i - 1] + 1e-12) return false;
  }
  return true;
}

describe('gravity sweep (T10)', () => {
  it('picks lope at the Moon and walk at Mars and Earth on the default site', () => {
    expect(solve({ ...DEFAULT_SITE, gravity: 1.62 }).gait).toBe('lope');
    // Mars is an extrapolation (not verified): the cost model puts the walk/lope crossover below 3.71 m/s².
    expect(solve({ ...DEFAULT_SITE, gravity: 3.71 }).gait).toBe('walk');
    expect(solve({ ...DEFAULT_SITE, gravity: 9.81 }).gait).toBe('walk');
  });

  it('lengthens flight, apex and stride and slows the cadence as g drops (automatic gait)', () => {
    const s = SWEEP_G.map((g) => solve({ ...DEFAULT_SITE, gravity: g }));
    expect(decreasing(s.map((x) => x.flightTime), false)).toBe(true);
    expect(decreasing(s.map((x) => x.apexHeight), false)).toBe(true);
    expect(decreasing(s.map((x) => x.strideLength), true)).toBe(true);
    // Cadence follows the pendulum time inside a gait (the walk points); the gait switch itself steps it.
    expect(decreasing(s.slice(1).map((x) => -x.cadence), true)).toBe(true);
    expect(s[0].cadence).toBeLessThan(s[4].cadence);
    expect(s[0].flightTime).toBeGreaterThan(0.5);
    expect(s[0].apexHeight).toBeGreaterThan(0.1);
    expect(s[4].flightTime).toBe(0);
    expect(s[4].apexHeight).toBe(0);
  });

  it('keeps the same ordering for a forced lope (bouncing gait at every g)', () => {
    const s = SWEEP_G.map((g) => solve({ ...DEFAULT_SITE, gravity: g, forceGait: 'lope' }));
    expect(decreasing(s.map((x) => x.flightTime), true)).toBe(true);
    expect(decreasing(s.map((x) => x.apexHeight), true)).toBe(true);
    expect(decreasing(s.map((x) => x.strideLength), true)).toBe(true);
    expect(decreasing(s.map((x) => -x.cadence), true)).toBe(true);
    // Duty factor per foot grows with g (shorter flight share).
    expect(decreasing(s.map((x) => -x.dutyFactor), true)).toBe(true);
  });

  it('swings slower at low g: swing time follows the pendulum time sqrt(L/g)', () => {
    const swing = SWEEP_G.map((g) => {
      const s = solve({ ...DEFAULT_SITE, gravity: g });
      return (1 - s.dutyFactor) / s.strideFrequency;
    });
    expect(decreasing(swing.slice().reverse().map((x) => -x), true)).toBe(true);
    // Between Mars and Earth (both walking) the swing time ratio is close to sqrt(g ratio).
    expect(swing[2] / swing[4]).toBeGreaterThan(0.85 * Math.sqrt(G_EARTH / G_MARS));
    expect(swing[2] / swing[4]).toBeLessThan(1.15 * Math.sqrt(G_EARTH / G_MARS));
  });

  it('reports the ballistic apex h = g t^2 / 8 and landing speed v = g t / 2', () => {
    const s = solve({ ...DEFAULT_SITE, gravity: G_MOON });
    expect(s.apexHeight).toBeCloseTo((G_MOON * s.flightTime * s.flightTime) / 8, 9);
    expect(s.landingSpeed).toBeCloseTo((G_MOON * s.flightTime) / 2, 9);
    expect(solve({ ...DEFAULT_SITE, gravity: G_EARTH }).landingSpeed).toBe(0);
  });

  it('lets the Moon lope fly visibly: both feet off the ground for a large share of the stride', () => {
    const s = solve({ ...DEFAULT_SITE, gravity: G_MOON });
    expect(1 - 2 * s.dutyFactor).toBeGreaterThan(0.35);
  });
});

describe('transition scaling with gravity (T10.3)', () => {
  it('equals the verified suited lunar Ap* at lunar g and falls as g rises', () => {
    expect(transitionApollo(G_MOON)).toBeCloseTo(AP_TRANSITION, 12);
    const values = SWEEP_G.map((g) => transitionApollo(g));
    expect(decreasing(values, true)).toBe(true);
  });

  it('rescales the unsuited anchors: Fr* = 0.5 at 1 g and 0.9 at lunar g (Kram 1997, Carr & McGee 2009)', () => {
    const suitFactor = transitionApollo(G_EARTH) / AP_TRANSITION;
    expect(suitFactor).toBeCloseTo(0.5 / 0.9, 9);
    expect(TRANSITION_G_EXPONENT).toBeCloseTo(Math.log(0.9 / 0.5) / Math.log(G_EARTH / G_MOON), 12);
  });

  it('keeps the Moon default at the Apollo 11 speed anchor, about 0.83 m/s on the default site', () => {
    const s = solve({ ...DEFAULT_SITE, gravity: G_MOON });
    expect(s.gait).toBe('lope');
    expect(s.speed).toBeGreaterThan(0.8);
    expect(s.speed).toBeLessThan(0.86);
  });

  it('makes the comfortable bouncing speed depend on g, not on one lunar anchor', () => {
    const moon = solve({ gravity: G_MOON, roughness: 0, forceGait: 'lope' });
    const mars = solve({ gravity: G_MARS, roughness: 0, forceGait: 'lope' });
    const sqrtOnly = moon.speed * Math.sqrt(G_MARS / G_MOON);
    // Froude rises toward low g, so the speed grows slower than sqrt(g) when g rises.
    expect(mars.speed).toBeLessThan(sqrtOnly);
    expect(mars.froude).toBeLessThan(moon.froude);
  });

  it('changes gait only once across a fine g sweep and moves continuously inside a gait', () => {
    let previous = 'stand' as GaitState['gait'];
    let prevSpeed = 0;
    let prevStride = 0;
    let changes = 0;
    let lastG = 0;
    for (let g = 1.0; g <= 12; g += 0.01) {
      const s = solveGait(createGaitInputs({ gravity: g, legLength: LEG, ...DEFAULT_SITE, previousGait: previous }), createGaitState());
      if (prevSpeed > 0 && s.gait === previous) {
        expect(Math.abs(s.speed - prevSpeed) / prevSpeed).toBeLessThan(0.02);
        expect(Math.abs(s.strideLength - prevStride) / prevStride).toBeLessThan(0.02);
      } else if (prevSpeed > 0) {
        changes++;
        lastG = g;
      }
      previous = s.gait;
      prevSpeed = s.speed;
      prevStride = s.strideLength;
    }
    expect(changes).toBe(1);
    expect(lastG).toBeGreaterThan(1.62);
    expect(lastG).toBeLessThan(3.71);
  });

  it('names every gait for the HUD, indexed by GAIT_CODE', () => {
    expect(GAIT_NAMES).toEqual(['stand', 'walk', 'lope', 'run']);
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

  it('throws farther, longer-lived and more motes at low g with the speed the gait model gives', () => {
    const puffs = SWEEP_G.map((g) => footfallPuff(solve({ ...DEFAULT_SITE, gravity: g }).speed, g, createPuffParams()));
    expect(decreasing(puffs.map((p) => p.range), true)).toBe(true);
    expect(decreasing(puffs.map((p) => p.life), false)).toBe(true);
    expect(decreasing(puffs.map((p) => p.count), false)).toBe(true);
    // Slower at low g: the kick speed follows the walker speed, which falls with g (lope included).
    expect(puffs[0].kickSpeed).toBeLessThan(puffs[4].kickSpeed);
    // Ballistic range v²/g: the Moon throws dust several times farther than Earth.
    expect(puffs[0].range / puffs[4].range).toBeGreaterThan(3);
  });
});
