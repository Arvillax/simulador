import type { SandboxEngine, SandboxMode } from '../sandbox3d/SandboxEngine.ts';
import { bodyFromGravity, isBody } from '../sandbox3d/BodyLook.ts';
import type { Body } from '../sandbox3d/BodyLook.ts';

/**
 * Static 6-variable input vector shared with the sandbox. Mutated in place only.
 */
export const etlVector = new Float32Array([16.0, 0.72, 0.28, 0.14, 255.0, 0.02]);
// [0]: slope_deg (0° to 45°)
// [1]: roughness_tri (0.0 to 1.0)
// [2]: thermal_inertia (0.0 = loose fine dust, 1.0 = consolidated rock)
// [3]: albedo_mineral (0.05 to 0.60; low = ilmenite-rich basalt, FeTiO3)
// [4]: surface_temp_k (40 K to 400 K; < 265 K indicates permafrost / ice)
// [5]: ndvi (-0.1 to 1.0; < 0.05 indicates planetary-analog purity)

export const DEFAULT_SITE_SEED = 1;

/** Valid [min, max] per vector index. */
export const VECTOR_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0, 45],
  [0, 1],
  [0, 1],
  [0.05, 0.6],
  [40, 400],
  [-0.1, 1.0],
];

export type SimulationAction = 'PULSE_EDS' | 'PAUSE' | 'RESUME';

export interface SimulationControlDetail {
  mode?: SandboxMode;
  action?: SimulationAction;
  /** [slope, tri, thermalInertia, albedo, tempK, ndvi]. */
  vector?: number[];
  seed?: number;
  /** Surface gravity in m/s^2. */
  gravity?: number;
  /**
   * World whose look the scene shows ('moon' | 'mars' | 'earth'). Appearance only. When a message changes the
   * gravity without naming a body, the body is derived from the gravity (1.62 Moon, 3.71 Mars, else Earth).
   */
  body?: Body;
}

export const SIMULATION_CONTROL_EVENT = 'nasa:simulation-control';

const MODES: readonly SandboxMode[] = ['ROVER', 'SUIT_EDS', 'LIDAR_LANDER', 'ISRU_DRILL'];

let engineRef: SandboxEngine | null = null;
let siteSeed = DEFAULT_SITE_SEED;
let vectorVersion = 0;
let listenerInstalled = false;

function clampInto(index: number, value: number): number {
  if (!Number.isFinite(value)) return etlVector[index];
  const [min, max] = VECTOR_RANGES[index];
  return value < min ? min : value > max ? max : value;
}

export function isSandboxMode(value: unknown): value is SandboxMode {
  return typeof value === 'string' && (MODES as readonly string[]).includes(value);
}

export function getSiteSeed(): number {
  return siteSeed;
}

/** Increments on every vector or seed write; lets the HUD resync its controls. */
export function getVectorVersion(): number {
  return vectorVersion;
}

/**
 * Clamps the inputs to their valid ranges, writes etlVector in place and asks the engine to re-synthesise.
 * Synthesis is coalesced to at most once per frame by the engine.
 */
export function updateSandboxTerrain(
  slope: number,
  tri: number,
  thermalInertia: number,
  albedo: number,
  tempK: number,
  ndvi: number,
  seed: number = siteSeed,
): void {
  etlVector[0] = clampInto(0, slope);
  etlVector[1] = clampInto(1, tri);
  etlVector[2] = clampInto(2, thermalInertia);
  etlVector[3] = clampInto(3, albedo);
  etlVector[4] = clampInto(4, tempK);
  etlVector[5] = clampInto(5, ndvi);
  if (Number.isFinite(seed)) siteSeed = Math.trunc(seed);
  vectorVersion++;
  engineRef?.requestSynthesis(siteSeed);
}

/** Applies one control message (same shape as the `nasa:simulation-control` CustomEvent detail). */
export function handleSimulationControl(detail: SimulationControlDetail | null | undefined): void {
  const engine = engineRef;
  if (detail === null || detail === undefined || engine === null) return;
  const gravityBefore = engine.getGravity();
  if (typeof detail.gravity === 'number') engine.setGravity(detail.gravity);
  if (isBody(detail.body)) engine.setBody(detail.body);
  else if (engine.getGravity() !== gravityBefore) engine.setBody(bodyFromGravity(engine.getGravity()));
  const seed = typeof detail.seed === 'number' && Number.isFinite(detail.seed) ? detail.seed : siteSeed;
  if (Array.isArray(detail.vector) && detail.vector.length >= 6) {
    const v = detail.vector;
    updateSandboxTerrain(v[0], v[1], v[2], v[3], v[4], v[5], seed);
  } else if (seed !== siteSeed) {
    updateSandboxTerrain(etlVector[0], etlVector[1], etlVector[2], etlVector[3], etlVector[4], etlVector[5], seed);
  }
  if (isSandboxMode(detail.mode)) engine.setMode(detail.mode);
  if (detail.action === 'PULSE_EDS') engine.pulseEds();
  else if (detail.action === 'PAUSE') engine.pause();
  else if (detail.action === 'RESUME') engine.resume();
}

function onSimulationControl(event: Event): void {
  handleSimulationControl((event as CustomEvent<SimulationControlDetail>).detail);
}

/** Connects the bridge to the engine and installs the global `nasa:simulation-control` listener (once). */
export function registerSandbox(engine: SandboxEngine): void {
  engineRef = engine;
  if (!listenerInstalled && typeof window !== 'undefined') {
    window.addEventListener(SIMULATION_CONTROL_EVENT, onSimulationControl);
    listenerInstalled = true;
  }
}
