import { describe, expect, it } from 'vitest';
import {
  CONTACT_LENGTH,
  ROVER_MASS,
  SLIP_MAX,
  WHEEL_COUNT,
  WHEEL_WIDTH,
  createSoil,
  createSuspensionPose,
  createWheelSolution,
  soilFromVector,
  solveRockerBogie,
  solveWheel,
  staticSinkage,
} from './RoverSolver.ts';

const DEG = Math.PI / 180;

function wheelLoad(gravity: number): number {
  return (ROVER_MASS * gravity) / WHEEL_COUNT;
}

describe('Bekker static sinkage', () => {
  it('decreases as thermal inertia increases', () => {
    const soil = createSoil();
    const pressure = wheelLoad(1.62) / (WHEEL_WIDTH * CONTACT_LENGTH);
    let previous = Number.POSITIVE_INFINITY;
    for (const ti of [0, 0.25, 0.5, 0.75, 1]) {
      soilFromVector(ti, 0, soil);
      const z0 = staticSinkage(pressure, WHEEL_WIDTH, soil);
      expect(z0).toBeGreaterThan(0);
      expect(z0).toBeLessThan(previous);
      previous = z0;
    }
  });
});

describe('wheel slip solver', () => {
  it('keeps slip within [0, 0.95] for every slope and gravity', () => {
    const soil = createSoil();
    const out = createWheelSolution();
    for (const ti of [0, 0.5, 1]) {
      soilFromVector(ti, 0.02, soil);
      for (const g of [1.62, 3.71, 9.81]) {
        for (let slope = 0; slope <= 45; slope += 2.5) {
          solveWheel(slope * DEG, wheelLoad(g), soil, out);
          expect(out.slip).toBeGreaterThanOrEqual(0);
          expect(out.slip).toBeLessThanOrEqual(SLIP_MAX);
        }
      }
    }
  });

  it('increases slip with slope', () => {
    const soil = createSoil();
    const out = createWheelSolution();
    soilFromVector(0.28, 0, soil);
    let previous = -1;
    for (let slope = 0; slope <= 45; slope += 5) {
      solveWheel(slope * DEG, wheelLoad(1.62), soil, out);
      expect(out.slip).toBeGreaterThanOrEqual(previous);
      previous = out.slip;
    }
    solveWheel(5 * DEG, wheelLoad(1.62), soil, out);
    const gentle = out.slip;
    solveWheel(20 * DEG, wheelLoad(1.62), soil, out);
    expect(out.slip).toBeGreaterThan(gentle);
  });

  it('never reports a total sinkage below the static sinkage', () => {
    const soil = createSoil();
    const out = createWheelSolution();
    for (const ti of [0, 0.3, 0.7, 1]) {
      soilFromVector(ti, 0, soil);
      for (let slope = 0; slope <= 45; slope += 9) {
        solveWheel(slope * DEG, wheelLoad(3.71), soil, out);
        expect(out.zTotal).toBeGreaterThanOrEqual(out.z0);
      }
    }
  });

  it('saturates slip at 0.95 on the stress case', () => {
    const soil = createSoil();
    const out = createWheelSolution();
    soilFromVector(0, 0.2, soil);
    solveWheel(45 * DEG, wheelLoad(9.81), soil, out);
    expect(out.slip).toBe(SLIP_MAX);
    expect(out.drawbarN).toBeLessThan(0);
  });
});

describe('rocker-bogie kinematics', () => {
  it('gives zero pitch and roll on flat ground', () => {
    const pose = solveRockerBogie(0.25, 0.25, 0.25, 0.25, 0.25, 0.25, createSuspensionPose());
    expect(pose.pitch).toBeCloseTo(0, 12);
    expect(pose.roll).toBeCloseTo(0, 12);
    expect(pose.bogieL).toBeCloseTo(0, 12);
  });

  it('pitches nose up when the front wheels are higher and rolls toward the low side', () => {
    const pose = createSuspensionPose();
    solveRockerBogie(0.5, 0.25, 0.25, 0.5, 0.25, 0.25, pose);
    expect(pose.pitch).toBeGreaterThan(0);
    solveRockerBogie(0.4, 0.4, 0.4, 0.25, 0.25, 0.25, pose);
    expect(pose.roll).toBeGreaterThan(0);
  });
});
