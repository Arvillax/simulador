import { describe, expect, it } from 'vitest';
import { CAMERA_TRAVEL_MS, LOOK_BLEND_MS, cubicBezierEase, easeInOut } from './Easing.ts';

/** Independent reference: bisection on the curve parameter, then evaluate y. */
function reference(t: number, x1: number, y1: number, x2: number, y2: number): number {
  const bez = (a1: number, a2: number, s: number): number => 3 * a1 * s * (1 - s) ** 2 + 3 * a2 * s * s * (1 - s) + s ** 3;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (bez(x1, x2, mid) < t) lo = mid;
    else hi = mid;
  }
  return bez(y1, y2, (lo + hi) / 2);
}

describe('cubicBezierEase', () => {
  it('hits the end points exactly and clamps outside 0..1', () => {
    expect(cubicBezierEase(0, 0.77, 0, 0.175, 1)).toBe(0);
    expect(cubicBezierEase(1, 0.77, 0, 0.175, 1)).toBe(1);
    expect(cubicBezierEase(-0.4, 0.77, 0, 0.175, 1)).toBe(0);
    expect(cubicBezierEase(1.7, 0.77, 0, 0.175, 1)).toBe(1);
  });

  it('is the identity for the linear curve', () => {
    for (let t = 0; t <= 1; t += 0.05) expect(cubicBezierEase(t, 0, 0, 1, 1)).toBeCloseTo(t, 9);
  });

  it('matches a bisection reference for the art-direction curves', () => {
    const curves: ReadonlyArray<readonly [number, number, number, number]> = [
      [0.77, 0, 0.175, 1], // --ease-in-out
      [0.23, 1, 0.32, 1], // --ease-out
    ];
    for (const [x1, y1, x2, y2] of curves) {
      for (let t = 0.01; t < 1; t += 0.01) {
        expect(cubicBezierEase(t, x1, y1, x2, y2)).toBeCloseTo(reference(t, x1, y1, x2, y2), 6);
      }
    }
  });

  it('is monotonic for the in-out curve, slow at both ends', () => {
    let previous = 0;
    for (let t = 0; t <= 1.0001; t += 0.004) {
      const y = easeInOut(t);
      expect(y).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = y;
    }
    expect(easeInOut(0.2)).toBeLessThan(0.05);
    expect(easeInOut(0.8)).toBeGreaterThan(0.95);
  });
});

describe('motion durations', () => {
  it('follow the art direction', () => {
    expect(CAMERA_TRAVEL_MS).toBe(550);
    expect(LOOK_BLEND_MS).toBe(500);
  });
});
