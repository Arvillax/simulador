/**
 * Motion timing shared by the scene (art direction, "Motion"). Pure and allocation-free: safe inside the rAF loop
 * and importable in Node tests.
 */

/** Mode switch: the camera travels to the new framing in this time. */
export const CAMERA_TRAVEL_MS = 550;
/** World change: sky, light, exposure and terrain tint blend over this time. */
export const LOOK_BLEND_MS = 500;

const NEWTON_STEPS = 8;
const BISECTION_STEPS = 40;
const EPSILON = 1e-10;

/** One coordinate of a cubic Bezier with P0 = 0 and P3 = 1, at curve parameter s. */
function bezier(a1: number, a2: number, s: number): number {
  const c = 3 * a1;
  const b = 3 * (a2 - a1) - c;
  const a = 1 - c - b;
  return ((a * s + b) * s + c) * s;
}

function bezierSlope(a1: number, a2: number, s: number): number {
  const c = 3 * a1;
  const b = 3 * (a2 - a1) - c;
  const a = 1 - c - b;
  return (3 * a * s + 2 * b) * s + c;
}

/**
 * CSS `cubic-bezier(x1, y1, x2, y2)` evaluated in code: returns the eased progress for linear progress `t`.
 * Newton-Raphson on x(s) = t with a bisection fallback where the slope is too flat. `t` is clamped to 0..1.
 */
export function cubicBezierEase(t: number, x1: number, y1: number, x2: number, y2: number): number {
  if (!(t > 0)) return 0;
  if (t >= 1) return 1;
  let s = t;
  let solved = false;
  for (let i = 0; i < NEWTON_STEPS; i++) {
    const error = bezier(x1, x2, s) - t;
    if (Math.abs(error) < EPSILON) {
      solved = true;
      break;
    }
    const slope = bezierSlope(x1, x2, s);
    if (Math.abs(slope) < 1e-6) break;
    s -= error / slope;
  }
  if (!solved || s < 0 || s > 1) {
    let lo = 0;
    let hi = 1;
    s = t;
    for (let i = 0; i < BISECTION_STEPS; i++) {
      const x = bezier(x1, x2, s);
      if (Math.abs(x - t) < EPSILON) break;
      if (x < t) lo = s;
      else hi = s;
      s = 0.5 * (lo + hi);
    }
  }
  return bezier(y1, y2, s);
}

/** `--ease-in-out: cubic-bezier(0.77, 0, 0.175, 1)`: camera travel and world blends. */
export function easeInOut(t: number): number {
  return cubicBezierEase(t, 0.77, 0, 0.175, 1);
}
