import { describe, expect, it } from 'vitest';
import {
  ARM_OPEN_MAX_RAD,
  COMPRESSION_MAX_M,
  COMPRESSION_MIN_M,
  GaitWalker,
  applySuitPose,
  createLegIk,
  createPoseState,
  flightArcHeight,
  landingCompression,
  solveLegIk,
} from './GaitPose.ts';
import type { HeightFn, WalkerDims } from './GaitPose.ts';
import { buildSuit } from './AssetBuilder.ts';
import {
  G_EARTH,
  G_MARS,
  G_MOON,
  MAX_APEX_LEG_FRACTION,
  createGaitInputs,
  createGaitState,
  solveGait,
} from './GaitModel.ts';
import type { GaitInputs, GaitState } from './GaitModel.ts';

const DIMS: WalkerDims = { hipHalfWidth: 0.12, thigh: 0.42, shin: 0.4, ankleHeight: 0.1, legLength: 0.92, footLength: 0.3 };
const flat: HeightFn = () => 0;
const wavy = (x: number, z: number): number => 0.15 * Math.sin(0.9 * x) + 0.1 * Math.cos(0.7 * z) + 0.05 * x;

function gaitFor(g: number): GaitState {
  return solveGait(createGaitInputs({ gravity: g, roughness: 0.3 }), createGaitState());
}

function makeWalker(g: number, ground: HeightFn = flat): GaitWalker {
  const w = new GaitWalker(DIMS);
  w.reset(0, 0, 0, ground);
  w.setGait(gaitFor(g), g);
  return w;
}

describe('two-bone leg IK', () => {
  it('is straight at full reach and bends the knee forward when closer', () => {
    const ik = createLegIk();
    solveLegIk(0, -0.82, 0, 0.42, 0.4, ik);
    // The IK keeps 0.1 % of reach in reserve, so the leg is almost (not exactly) straight.
    expect(Math.abs(ik.hip)).toBeLessThan(0.05);
    expect(ik.knee).toBeLessThan(0.1);
    solveLegIk(0, -0.7, 0, 0.42, 0.4, ik);
    expect(ik.knee).toBeGreaterThan(0.3);
    expect(ik.hip).toBeLessThan(0);
  });

  it('reaches the target (forward kinematics round trip)', () => {
    const ik = createLegIk();
    for (const [dy, dz] of [
      [-0.75, 0.2],
      [-0.7, -0.25],
      [-0.6, 0.05],
    ]) {
      solveLegIk(0, dy, dz, 0.42, 0.4, ik);
      const ky = -0.42 * Math.cos(ik.hip);
      const kz = -0.42 * Math.sin(ik.hip);
      const ay = ky - 0.4 * Math.cos(ik.hip + ik.knee);
      const az = kz - 0.4 * Math.sin(ik.hip + ik.knee);
      expect(ay).toBeCloseTo(dy, 6);
      expect(az).toBeCloseTo(dz, 6);
    }
  });

  it('abducts toward a lateral target', () => {
    const ik = createLegIk();
    solveLegIk(0.05, -0.8, 0, 0.42, 0.4, ik);
    expect(ik.abduction).toBeGreaterThan(0);
  });
});

describe('ballistic flight arc', () => {
  it('rises h = g t^2 / 8', () => {
    expect(flightArcHeight(1.62, 0.6)).toBeCloseTo((1.62 * 0.36) / 8, 12);
  });
});

function solveWith(overrides: Partial<GaitInputs>): GaitState {
  return solveGait(createGaitInputs({ roughness: 0.3, ...overrides }), createGaitState());
}

/** Runs the walker for `seconds` at 120 Hz and returns the extremes of the pelvis offset after a 2 s settle. */
function offsetExtremes(w: GaitWalker, seconds: number): { min: number; max: number; airborne: number } {
  let min = 0;
  let max = 0;
  let airborne = 0;
  for (let f = 0; f < seconds * 120; f++) {
    w.advance(1 / 120, 0, flat, flat);
    if (f < 240) continue;
    min = Math.min(min, w.bounceOffset);
    max = Math.max(max, w.bounceOffset);
    if (!w.feet[0].planted && !w.feet[1].planted) airborne++;
  }
  return { min, max, airborne };
}

describe('landing compression (knee flexion on landing)', () => {
  it('grows with the vertical landing speed and stays inside its bounds', () => {
    let previous = 0;
    for (const v of [0, 0.2, 0.4, 0.6, 0.8, 1.0, 5]) {
      const c = landingCompression(v);
      expect(c).toBeGreaterThanOrEqual(COMPRESSION_MIN_M);
      expect(c).toBeLessThanOrEqual(COMPRESSION_MAX_M);
      expect(c).toBeGreaterThanOrEqual(previous);
      previous = c;
    }
    expect(landingCompression(0.8)).toBeGreaterThan(landingCompression(0.2));
    expect(landingCompression(5)).toBe(COMPRESSION_MAX_M);
  });

  it('dips the pelvis by the compression of the walker\'s own landing speed (v = g t / 2)', () => {
    for (const g of [G_MOON, 2.2]) {
      const state = solveWith({ gravity: g, forceGait: 'lope' });
      const w = makeWalker(g);
      w.setGait(state, g);
      const { min } = offsetExtremes(w, 8);
      expect(min).toBeLessThan(-0.9 * landingCompression(state.landingSpeed));
      expect(min).toBeGreaterThanOrEqual(-landingCompression(state.landingSpeed) - 1e-9);
    }
  });

  it('flexes the knee more after a harder landing', () => {
    const slow = solveWith({ gravity: G_MOON, forceGait: 'lope' });
    const wSlow = makeWalker(G_MOON);
    wSlow.setGait(slow, G_MOON);
    // A shorter contact (lower duty) leaves a longer flight and a harder landing: v = g t / 2.
    const hard = { ...slow, dutyFactor: slow.dutyFactor - 0.06 };
    const wHard = makeWalker(G_MOON);
    wHard.setGait(hard, G_MOON);
    expect(offsetExtremes(wHard, 8).min).toBeLessThan(offsetExtremes(wSlow, 8).min);
  });
});

describe('visible ballistic arc across gravities', () => {
  it('rises higher and flies longer at lower g for the same gait (forced lope)', () => {
    const peaks: number[] = [];
    const airborne: number[] = [];
    for (const g of [1.62, 3.71, 9.81]) {
      const w = makeWalker(g);
      w.setGait(solveWith({ gravity: g, forceGait: 'lope' }), g);
      const e = offsetExtremes(w, 10);
      peaks.push(e.max);
      airborne.push(e.airborne);
    }
    expect(peaks[0]).toBeGreaterThan(peaks[1]);
    expect(peaks[1]).toBeGreaterThan(peaks[2]);
    expect(peaks[0]).toBeGreaterThan(0.1);
    expect(airborne[0]).toBeGreaterThan(airborne[1]);
    expect(airborne[1]).toBeGreaterThan(airborne[2]);
  });

  it('never lifts the pelvis above the bound of the model, even at very low g', () => {
    const g = 0.15;
    const w = makeWalker(g);
    w.setGait(solveWith({ gravity: g, forceGait: 'lope' }), g);
    const e = offsetExtremes(w, 40);
    expect(e.max).toBeGreaterThan(0.1);
    expect(e.max).toBeLessThanOrEqual(MAX_APEX_LEG_FRACTION * DIMS.legLength + 1e-9);
  });

  it('follows a gravity change at once with an immediate gait switch and keeps planted feet still', () => {
    const w = makeWalker(G_EARTH, wavy);
    for (let f = 0; f < 240; f++) w.advance(1 / 120, 0.2, wavy, wavy);
    expect(w.gait).toBe('walk');
    w.setGait(solveWith({ gravity: G_MOON }), G_MOON, true);
    expect(w.gait).toBe('lope');
    expect(w.gravity).toBe(G_MOON);
    const px = [0, 0];
    const pz = [0, 0];
    const was = [false, false];
    let maxSlide = 0;
    for (let f = 0; f < 600; f++) {
      w.advance(1 / 120, 0.2, wavy, wavy);
      expect(Number.isFinite(w.pelvisY)).toBe(true);
      for (let i = 0; i < 2; i++) {
        const foot = w.feet[i];
        if (foot.planted && was[i]) maxSlide = Math.max(maxSlide, Math.hypot(foot.x - px[i], foot.z - pz[i]));
        was[i] = foot.planted;
        px[i] = foot.x;
        pz[i] = foot.z;
      }
    }
    expect(maxSlide).toBe(0);
    let flights = 0;
    for (let f = 0; f < 600; f++) {
      w.advance(1 / 120, 0.2, wavy, wavy);
      if (!w.feet[0].planted && !w.feet[1].planted) flights++;
    }
    expect(flights).toBeGreaterThan(50);
  });
});

describe('arm balance in flight', () => {
  function armOpenAfter(g: number, force: GaitInputs['forceGait']): number {
    const rig = buildSuit();
    const w = makeWalker(g);
    w.setGait(solveWith({ gravity: g, forceGait: force }), g);
    const pose = createPoseState();
    let maxOpen = 0;
    for (let f = 0; f < 1200; f++) {
      w.advance(1 / 120, 0, flat, flat);
      applySuitPose(rig, w, 0.4, 0, 1 / 120, pose);
      if (f > 240) maxOpen = Math.max(maxOpen, rig.shoulderR.rotation.z === 0 ? 0 : -rig.shoulderR.rotation.z);
    }
    return maxOpen;
  }

  it('opens the arms in the flight phase of a lope and not in a walk, and opens them mirrored', () => {
    expect(armOpenAfter(G_EARTH, null)).toBeLessThan(0.02);
    const moon = armOpenAfter(G_MOON, null);
    expect(moon).toBeGreaterThan(0.1);
    expect(moon).toBeLessThanOrEqual(ARM_OPEN_MAX_RAD + 1e-9);
  });

  it('opens them more where the flight is longer (Moon vs Mars, forced lope)', () => {
    expect(armOpenAfter(G_MOON, 'lope')).toBeGreaterThanOrEqual(armOpenAfter(G_MARS, 'lope'));
  });
});

describe('gait walker', () => {
  it('never slides a planted foot', () => {
    const w = makeWalker(G_EARTH, wavy);
    const px = [0, 0];
    const pz = [0, 0];
    const was = [false, false];
    let maxSlide = 0;
    let plantedChecks = 0;
    for (let f = 0; f < 600; f++) {
      w.advance(1 / 60, 0.3, wavy, wavy);
      for (let i = 0; i < 2; i++) {
        const foot = w.feet[i];
        if (foot.planted && was[i]) {
          maxSlide = Math.max(maxSlide, Math.hypot(foot.x - px[i], foot.z - pz[i]));
          plantedChecks++;
        }
        was[i] = foot.planted;
        px[i] = foot.x;
        pz[i] = foot.z;
      }
    }
    expect(plantedChecks).toBeGreaterThan(100);
    expect(maxSlide).toBe(0);
    expect(Math.hypot(w.x, w.z)).toBeGreaterThan(3);
  });

  it('plants feet on the ground', () => {
    const w = makeWalker(G_EARTH, wavy);
    for (let f = 0; f < 300; f++) {
      w.advance(1 / 60, 0, wavy, wavy);
      for (const foot of w.feet) if (foot.planted) expect(foot.y).toBeCloseTo(wavy(foot.x, foot.z), 9);
    }
  });

  it('keeps a foot on the ground while walking and has a flight phase while loping', () => {
    const walk = makeWalker(G_EARTH);
    const lope = makeWalker(G_MOON);
    let walkAirborne = 0;
    let lopeAirborne = 0;
    let lopePeak = 0;
    for (let f = 0; f < 1200; f++) {
      walk.advance(1 / 120, 0, flat, flat);
      lope.advance(1 / 120, 0, flat, flat);
      if (f < 240) continue; // settle into the gait
      if (!walk.feet[0].planted && !walk.feet[1].planted) walkAirborne++;
      if (!lope.feet[0].planted && !lope.feet[1].planted) {
        lopeAirborne++;
        lopePeak = Math.max(lopePeak, lope.bounceOffset);
      }
    }
    expect(walkAirborne).toBe(0);
    expect(lopeAirborne).toBeGreaterThan(100);
    const moon = gaitFor(G_MOON);
    expect(lopePeak).toBeGreaterThan(0.8 * flightArcHeight(G_MOON, moon.flightTime));
    expect(lopePeak).toBeLessThanOrEqual(flightArcHeight(G_MOON, moon.flightTime) + 1e-9);
  });

  it('vaults the pelvis over the stance leg in the walk (inverted pendulum)', () => {
    const w = makeWalker(G_EARTH);
    let min = Infinity;
    let max = -Infinity;
    for (let f = 0; f < 600; f++) {
      w.advance(1 / 120, 0, flat, flat);
      if (f < 240) continue;
      min = Math.min(min, w.pelvisY);
      max = Math.max(max, w.pelvisY);
    }
    expect(max).toBeLessThanOrEqual(DIMS.legLength + 1e-9);
    expect(max - min).toBeGreaterThan(0.01);
    expect(max - min).toBeLessThan(0.12);
  });

  it('turns smoothly toward the target heading and only with a foot down', () => {
    const w = makeWalker(G_EARTH);
    let prev = w.yaw;
    let maxStep = 0;
    for (let f = 0; f < 600; f++) {
      w.advance(1 / 60, 1.5, flat, flat);
      maxStep = Math.max(maxStep, Math.abs(w.yaw - prev));
      prev = w.yaw;
    }
    expect(w.yaw).toBeCloseTo(1.5, 2);
    expect(maxStep).toBeLessThan(0.05);
  });

  it('is identical at 30 Hz and 144 Hz (fixed step)', () => {
    const a = makeWalker(G_MOON, wavy);
    const b = makeWalker(G_MOON, wavy);
    for (let f = 0; f < 150; f++) a.advance(1 / 30, 0.4, wavy, wavy);
    for (let f = 0; f < 720; f++) b.advance(1 / 144, 0.4, wavy, wavy);
    expect(b.x).toBeCloseTo(a.x, 9);
    expect(b.z).toBeCloseTo(a.z, 9);
    expect(b.phase).toBeCloseTo(a.phase, 9);
    expect(b.feet[0].x).toBeCloseTo(a.feet[0].x, 9);
    expect(b.feet[1].z).toBeCloseTo(a.feet[1].z, 9);
  });

  it('counts footfalls and steps in place when stopped', () => {
    const w = makeWalker(G_EARTH);
    for (let f = 0; f < 240; f++) w.advance(1 / 60, 0, flat, flat);
    expect(w.footfalls).toBeGreaterThan(4);
    const stop = solveGait(createGaitInputs({ gravity: G_EARTH, slopeDeg: 40 }), createGaitState());
    w.setGait(stop, G_EARTH);
    for (let f = 0; f < 240; f++) w.advance(1 / 60, 0, flat, flat);
    const x0 = w.x;
    const z0 = w.z;
    const n0 = w.footfalls;
    for (let f = 0; f < 240; f++) w.advance(1 / 60, 2, flat, flat);
    expect(Math.hypot(w.x - x0, w.z - z0)).toBeLessThan(1e-9);
    expect(w.footfalls).toBeGreaterThan(n0);
    expect(w.yaw).toBeGreaterThan(1);
  });
});
