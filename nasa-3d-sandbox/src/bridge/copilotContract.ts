import { bodyFromGravity } from '../sandbox3d/BodyLook.ts';
import type { Body } from '../sandbox3d/BodyLook.ts';
import { clamp, clamp01 } from '../sandbox3d/ScratchMath.ts';

export type SandboxMode = 'ROVER' | 'SUIT_EDS' | 'LIDAR_LANDER' | 'ISRU_DRILL';

export const SANDBOX_MODES: readonly SandboxMode[] = ['ROVER', 'SUIT_EDS', 'LIDAR_LANDER', 'ISRU_DRILL'];

export type CopilotTargetBody = 'MOON' | 'MARS';
export type RoverProfile = 'VIPER' | 'PERSEVERANCE' | 'CURIOSITY';
export type LidarProfile = 'ALHAT' | 'SPLICE' | 'CLPS' | 'M2020';
export type OperationalStatus = 'green' | 'yellow' | 'red';
export type AnalogVarName = 'N1' | 'N2' | 'N3' | 'N4' | 'N5' | 'N6' | 'N7';

export type SimulationAction =
  | 'PULSE_EDS'
  | 'PAUSE'
  | 'RESUME'
  | 'RESET_DUST'
  | 'RETRACT_DRILL_BITE'
  | 'BOOST_DRILL_WOB';

export interface DiurnalRangePercentiles {
  readonly p1: number;
  readonly p50?: number;
  readonly p99: number;
}

export interface AnalogN1N7Payload {
  /** Optional N1..N7 array in Float32Array(7) order: [N1, N2, N3, N4, N5, N6, N7]. */
  readonly n1ToN7?: readonly number[] | Float32Array;
  readonly n1SlopeDeg?: number | null;
  readonly n2RoughnessRmsM?: number | null;
  readonly n3ReliefM?: number | null;
  readonly n4SilicaPct?: number | null;
  readonly n5DiurnalTempK?: number | null;
  readonly n6SolarIllumFrac?: number | null;
  readonly n7SaltationTimeFrac?: number | null;
  readonly albedo?: number | null;
  readonly surfaceTempK?: number | null;
  readonly ndvi?: number | null;
  readonly diurnalPercentiles?: DiurnalRangePercentiles;
  readonly targetBody?: Body | CopilotTargetBody | 'EARTH';
  readonly body?: Body | CopilotTargetBody | 'EARTH';
  readonly roverProfile?: RoverProfile;
  readonly lidarProfile?: LidarProfile;
  readonly sunlit?: boolean;
  readonly seed?: number;
}

export interface WhatIfOverride {
  readonly variable: AnalogVarName;
  readonly newValue: number;
}

export interface SimulationControlDetail {
  readonly mode?: SandboxMode;
  readonly action?: SimulationAction;
  /** Legacy 6-var vector [slope, tri, thermalInertia, albedo, tempK, ndvi] OR 7-var N1..N7 vector. */
  readonly vector?: number[];
  readonly n1ToN7?: number[];
  readonly analog?: AnalogN1N7Payload;
  readonly whatIf?: WhatIfOverride;
  readonly seed?: number;
  readonly gravity?: number;
  readonly body?: Body | CopilotTargetBody | 'EARTH';
  readonly targetBody?: Body | CopilotTargetBody | 'EARTH';
  readonly roverProfile?: RoverProfile;
  readonly lidarProfile?: LidarProfile;
  readonly sunlit?: boolean;
  readonly albedo?: number | null;
  readonly surfaceTempK?: number | null;
  readonly ndvi?: number | null;
  readonly diurnalPercentiles?: DiurnalRangePercentiles;
}

/** Preallocated mutable per-site physical context shared with all 4 solvers (zero per-frame allocations). */
export interface SitePhysicsState {
  body: Body;
  sunlit: boolean;
  roverProfile: RoverProfile;
  lidarProfile: LidarProfile;
  hasN1ToN7: boolean;
  n1SlopeDeg: number;
  n2RoughnessRmsM: number;
  n3ReliefM: number;
  silicaPct: number;
  diurnalTempK: number;
  thermalFinenessIdx: number;
  solarIllumFrac: number;
  saltationTimeFrac: number;
  missingVars: string[];
}

export interface SimTelemetryAlertDetail {
  readonly source: 'nasa-3d-sandbox';
  readonly code: string;
  readonly mode: SandboxMode;
  readonly body: Body;
  readonly severity: 'yellow' | 'red';
  readonly message: string;
  readonly metric: string;
  readonly value: number;
  readonly threshold: number;
  readonly suggestedAction?: SimulationAction;
  readonly timestampMs: number;
}

export const SIMULATION_CONTROL_EVENT = 'nasa:simulation-control';
export const COPILOT_COMMAND_EVENT = 'nasa:copilot-command';
export const SIM_TELEMETRY_ALERT_EVENT = 'nasa:sim-telemetry-alert';

const ROVER_PROFILES: readonly RoverProfile[] = ['VIPER', 'PERSEVERANCE', 'CURIOSITY'];
const LIDAR_PROFILES: readonly LidarProfile[] = ['ALHAT', 'SPLICE', 'CLPS', 'M2020'];
const ANALOG_VARS: readonly AnalogVarName[] = ['N1', 'N2', 'N3', 'N4', 'N5', 'N6', 'N7'];
const ACTIONS: readonly SimulationAction[] = [
  'PULSE_EDS',
  'PAUSE',
  'RESUME',
  'RESET_DUST',
  'RETRACT_DRILL_BITE',
  'BOOST_DRILL_WOB',
];

const DEFAULT_P1_K = 8.0;
const DEFAULT_P99_K = 45.0;
const ROUGHNESS_RMS_SAT_M = 0.35;
const RELIEF_SAT_M = 1.5;
const NEUTRAL_WARM_TEMP_K = 280.0;

export function createSitePhysicsState(): SitePhysicsState {
  return {
    body: 'moon',
    sunlit: true,
    roverProfile: 'VIPER',
    lidarProfile: 'ALHAT',
    hasN1ToN7: false,
    n1SlopeDeg: 16.0,
    n2RoughnessRmsM: Number.NaN,
    n3ReliefM: Number.NaN,
    silicaPct: Number.NaN,
    diurnalTempK: Number.NaN,
    thermalFinenessIdx: Number.NaN,
    solarIllumFrac: Number.NaN,
    saltationTimeFrac: Number.NaN,
    missingVars: [],
  };
}

export function isSandboxMode(value: unknown): value is SandboxMode {
  return typeof value === 'string' && (SANDBOX_MODES as readonly string[]).includes(value);
}

export function isRoverProfile(value: unknown): value is RoverProfile {
  return typeof value === 'string' && (ROVER_PROFILES as readonly string[]).includes(value);
}

export function isLidarProfile(value: unknown): value is LidarProfile {
  return typeof value === 'string' && (LIDAR_PROFILES as readonly string[]).includes(value);
}

export function isAnalogVarName(value: unknown): value is AnalogVarName {
  return typeof value === 'string' && (ANALOG_VARS as readonly string[]).includes(value);
}

export function isSimulationAction(value: unknown): value is SimulationAction {
  return typeof value === 'string' && (ACTIONS as readonly string[]).includes(value);
}

/** Normalizes both lowercase ('moon' | 'mars' | 'earth') and Copilot uppercase ('MOON' | 'MARS'). */
export function normalizeBodyName(raw: unknown): Body | null {
  if (typeof raw !== 'string') return null;
  const lower = raw.trim().toLowerCase();
  if (lower === 'moon' || lower === 'mars' || lower === 'earth') return lower;
  return null;
}

export function resolveTargetBody(rawBody: unknown, gravity: number | undefined, fallback: Body): Body {
  const named = normalizeBodyName(rawBody);
  if (named !== null) return named;
  if (typeof gravity === 'number' && Number.isFinite(gravity)) return bodyFromGravity(gravity);
  return fallback;
}

export function defaultGravityForBody(body: Body): number {
  if (body === 'moon') return 1.62;
  if (body === 'mars') return 3.71;
  return 9.81;
}

export function defaultRoverProfile(body: Body): RoverProfile {
  return body === 'moon' ? 'VIPER' : 'PERSEVERANCE';
}

export function defaultLidarProfile(body: Body): LidarProfile {
  if (body === 'moon') return 'ALHAT';
  if (body === 'mars') return 'M2020';
  return 'CLPS';
}

/** Operational albedo proxy from % SiO2 per docs/spec-n1-n7-physics.md table 2.2 (mafic dark -> felsic bright). */
export function albedoFromSilicaPct(silicaPct: number): number {
  if (!Number.isFinite(silicaPct)) return 0.16;
  if (silicaPct <= 53) return 0.11;
  if (silicaPct <= 65) return 0.16 + ((silicaPct - 53) / 12) * 0.12;
  return clamp(0.30 + ((silicaPct - 65) / 13) * 0.12, 0.05, 0.6);
}

/** Relative N5 (Delta_T) normalization matching Copilot Layer 1 (`p1..p99` percentiles, no fixed 18/30/45 K cutoffs). */
export function computeThermalFineness(deltaTK: number, percentiles?: DiurnalRangePercentiles): number {
  const pLow = percentiles !== undefined && Number.isFinite(percentiles.p1) ? percentiles.p1 : DEFAULT_P1_K;
  const pHigh = percentiles !== undefined && Number.isFinite(percentiles.p99) ? percentiles.p99 : DEFAULT_P99_K;
  return clamp01((deltaTK - pLow) / Math.max(pHigh - pLow, 1e-3));
}

/** Converts local RMS roughness N2 [m] and relief N3 [m] to normalized sandbox TRI [0..1]. */
export function roughnessToTri(n2RmsM: number | null | undefined, n3ReliefM: number | null | undefined): number {
  const rmsPart = typeof n2RmsM === 'number' && Number.isFinite(n2RmsM) ? Math.max(0, n2RmsM) / ROUGHNESS_RMS_SAT_M : 0;
  const reliefPart =
    typeof n3ReliefM === 'number' && Number.isFinite(n3ReliefM) ? Math.max(0, n3ReliefM) / RELIEF_SAT_M : 0;
  return clamp01(Math.max(rmsPart, reliefPart));
}

function finiteOrNaN(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : Number.NaN;
}

/**
 * Translates an N1..N7 Copilot context payload into the 6D visual sandbox vector while preserving exact physical
 * N1..N7 state in `outSite` and explicitly recording any missing/non-finite inputs in `outSite.missingVars`.
 * Missing fields are NEVER coerced to 0 in `missingVars` and never fabricate polar ice or biological anomalies.
 */
export function mapAnalogN1N7ToSandbox6D(
  payload: AnalogN1N7Payload,
  out6D: Float32Array,
  outSite: SitePhysicsState,
): void {
  const arr = payload.n1ToN7;
  const n1 = finiteOrNaN(payload.n1SlopeDeg ?? arr?.[0]);
  const n2 = finiteOrNaN(payload.n2RoughnessRmsM ?? arr?.[1]);
  const n3 = finiteOrNaN(payload.n3ReliefM ?? arr?.[2]);
  const n4 = finiteOrNaN(payload.n4SilicaPct ?? arr?.[3]);
  const n5 = finiteOrNaN(payload.n5DiurnalTempK ?? arr?.[4]);
  const n6 = finiteOrNaN(payload.n6SolarIllumFrac ?? arr?.[5]);
  const n7 = finiteOrNaN(payload.n7SaltationTimeFrac ?? arr?.[6]);

  const body = resolveTargetBody(payload.body ?? payload.targetBody, undefined, outSite.body);
  outSite.body = body;
  outSite.hasN1ToN7 = true;
  outSite.roverProfile = isRoverProfile(payload.roverProfile) ? payload.roverProfile : defaultRoverProfile(body);
  outSite.lidarProfile = isLidarProfile(payload.lidarProfile) ? payload.lidarProfile : defaultLidarProfile(body);
  outSite.n1SlopeDeg = n1;
  outSite.n2RoughnessRmsM = n2;
  outSite.n3ReliefM = n3;
  outSite.silicaPct = n4;
  outSite.diurnalTempK = n5;
  outSite.solarIllumFrac = body === 'moon' ? n6 : Number.NaN;
  outSite.saltationTimeFrac = body === 'mars' ? n7 : Number.NaN;

  const missing = outSite.missingVars;
  missing.length = 0;
  if (!Number.isFinite(n1)) missing.push('N1');
  if (!Number.isFinite(n2)) missing.push('N2');
  if (!Number.isFinite(n3)) missing.push('N3');
  if (!Number.isFinite(n4)) missing.push('N4');
  if (!Number.isFinite(n5)) missing.push('N5');
  if (body === 'moon' && !Number.isFinite(n6)) missing.push('N6');
  if (body === 'mars' && !Number.isFinite(n7)) missing.push('N7');

  const thermalFineness = Number.isFinite(n5) ? computeThermalFineness(n5, payload.diurnalPercentiles) : Number.NaN;
  outSite.thermalFinenessIdx = thermalFineness;

  if (typeof payload.sunlit === 'boolean') {
    outSite.sunlit = payload.sunlit;
  } else if (body === 'moon' && Number.isFinite(n6) && n6 <= 0) {
    outSite.sunlit = false;
  } else {
    outSite.sunlit = true;
  }

  // Write the 6 visual sandbox channels safely without ever recycling stale values on missing data.
  out6D[0] = Number.isFinite(n1) ? clamp(n1, 0, 45) : 0;
  out6D[1] = Number.isFinite(n2) || Number.isFinite(n3) ? roughnessToTri(n2, n3) : 0.25;
  out6D[2] = Number.isFinite(thermalFineness) ? clamp01(1 - thermalFineness) : 0.5;
  out6D[3] =
    typeof payload.albedo === 'number' && Number.isFinite(payload.albedo)
      ? clamp(payload.albedo, 0.05, 0.6)
      : albedoFromSilicaPct(n4);

  if (typeof payload.surfaceTempK === 'number' && Number.isFinite(payload.surfaceTempK)) {
    out6D[4] = clamp(payload.surfaceTempK, 40, 400);
  } else {
    missing.push('surfaceTempK');
    // Keep neutral non-frozen visual temperature so missing data never hallucinates polar ice (< 265 K).
    out6D[4] = NEUTRAL_WARM_TEMP_K;
  }

  // ADR-003: NDVI applies only to terrestrial analogs; force 0 on Moon and Mars to avoid false rover cohesion/LiDAR bio flags.
  out6D[5] =
    body === 'earth' && typeof payload.ndvi === 'number' && Number.isFinite(payload.ndvi)
      ? clamp(payload.ndvi, -0.1, 1.0)
      : 0;
}

/** Applies a single what-if parameter override (N1..N7) onto an existing site snapshot and returns whether valid. */
export function applyWhatIfToSiteState(
  override: WhatIfOverride,
  out6D: Float32Array,
  outSite: SitePhysicsState,
  percentiles?: DiurnalRangePercentiles,
): boolean {
  if (!isAnalogVarName(override.variable) || !Number.isFinite(override.newValue)) return false;
  const v = override.newValue;
  outSite.hasN1ToN7 = true;
  switch (override.variable) {
    case 'N1':
      outSite.n1SlopeDeg = v;
      out6D[0] = clamp(v, 0, 45);
      break;
    case 'N2':
      outSite.n2RoughnessRmsM = Math.max(0, v);
      out6D[1] = roughnessToTri(outSite.n2RoughnessRmsM, outSite.n3ReliefM);
      break;
    case 'N3':
      outSite.n3ReliefM = Math.max(0, v);
      out6D[1] = roughnessToTri(outSite.n2RoughnessRmsM, outSite.n3ReliefM);
      break;
    case 'N4':
      outSite.silicaPct = clamp(v, 0, 100);
      out6D[3] = albedoFromSilicaPct(outSite.silicaPct);
      break;
    case 'N5':
      outSite.diurnalTempK = Math.max(0, v);
      outSite.thermalFinenessIdx = computeThermalFineness(outSite.diurnalTempK, percentiles);
      out6D[2] = clamp01(1 - outSite.thermalFinenessIdx);
      break;
    case 'N6':
      if (outSite.body === 'moon') {
        outSite.solarIllumFrac = clamp01(v);
        outSite.sunlit = outSite.solarIllumFrac > 0;
      }
      break;
    case 'N7':
      if (outSite.body === 'mars') {
        outSite.saltationTimeFrac = clamp01(v);
      }
      break;
  }
  const idx = outSite.missingVars.indexOf(override.variable);
  if (idx >= 0) outSite.missingVars.splice(idx, 1);
  return true;
}

/** Validates an untrusted postMessage payload from parent frame or Copilot UI. */
export function parsePostMessageControl(data: unknown): SimulationControlDetail | null {
  if (typeof data !== 'object' || data === null) return null;
  const record = data as Record<string, unknown>;
  const type = record.type;
  if (type === SIMULATION_CONTROL_EVENT || type === COPILOT_COMMAND_EVENT) {
    const detail = record.detail;
    return typeof detail === 'object' && detail !== null ? (detail as SimulationControlDetail) : null;
  }
  return null;
}
