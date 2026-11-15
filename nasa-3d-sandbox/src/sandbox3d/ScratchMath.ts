import { Color, Euler, Matrix4, Quaternion, Vector3 } from 'three';

/**
 * Module-level scratch pool for the per-frame loop (zero allocation).
 *
 * Rules:
 * - A scratch object is only valid until the next call that may reuse it. Never store a reference to one.
 * - Each module that needs more than a couple of temporaries should keep its own private scratch objects
 *   allocated at module load, so nested calls never clobber each other.
 */
export const _v1 = new Vector3();
export const _v2 = new Vector3();
export const _v3 = new Vector3();
export const _v4 = new Vector3();
export const _scale = new Vector3();
export const _m1 = new Matrix4();
export const _q1 = new Quaternion();
export const _e1 = new Euler();
export const _c1 = new Color();

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
