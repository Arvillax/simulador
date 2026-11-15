import { bodyFromGravity } from '../sandbox3d/BodyLook.ts';
import type { Body } from '../sandbox3d/BodyLook.ts';
import {
  COPILOT_COMMAND_EVENT,
  SANDBOX_MODES,
  SIMULATION_CONTROL_EVENT,
  SIM_TELEMETRY_ALERT_EVENT,
  applyWhatIfToSiteState,
  createSitePhysicsState,
  defaultGravityForBody,
  defaultLidarProfile,
  defaultRoverProfile,
  isAnalogVarName,
  isLidarProfile,
  isRoverProfile,
  isSandboxMode,
  isSimulationAction,
  mapAnalogN1N7ToSandbox6D,
  normalizeBodyName,
  parsePostMessageControl,
  resolveTargetBody,
} from './copilotContract.ts';
import type {
  AnalogN1N7Payload,
  AnalogVarName,
  CopilotTargetBody,
  DiurnalRangePercentiles,
  LidarProfile,
  OperationalStatus,
  RoverProfile,
  SandboxMode,
  SimTelemetryAlertDetail,
  SimulationAction,
  SimulationControlDetail,
  SitePhysicsState,
  WhatIfOverride,
} from './copilotContract.ts';

export {
  COPILOT_COMMAND_EVENT,
  SANDBOX_MODES,
  SIMULATION_CONTROL_EVENT,
  SIM_TELEMETRY_ALERT_EVENT,
  applyWhatIfToSiteState,
  createSitePhysicsState,
  defaultGravityForBody,
  defaultLidarProfile,
  defaultRoverProfile,
  isAnalogVarName,
  isLidarProfile,
  isRoverProfile,
  isSandboxMode,
  isSimulationAction,
  mapAnalogN1N7ToSandbox6D,
  normalizeBodyName,
  parsePostMessageControl,
  resolveTargetBody,
};
export type {
  AnalogN1N7Payload,
  AnalogVarName,
  CopilotTargetBody,
  DiurnalRangePercentiles,
  LidarProfile,
  OperationalStatus,
  RoverProfile,
  SandboxMode,
  SimTelemetryAlertDetail,
  SimulationAction,
  SimulationControlDetail,
  SitePhysicsState,
  WhatIfOverride,
};

/** Minimal engine control surface used by the data bridge (satisfied by `SandboxEngine` and test fakes). */
export interface ControllableSandboxEngine {
  readonly solvers?: Readonly<Record<SandboxMode, { readonly telemetry: Readonly<Record<string, number>> }>>;
  requestSynthesis(seed: number): void;
  getGravity(): number;
  setGravity(g: number): void;
  getBody(): Body;
  isSunlit(): boolean;
  setBody(body: Body, options?: { sunlit?: boolean; immediate?: boolean }): void;
  getMode(): SandboxMode;
  setMode(mode: SandboxMode, options?: { instant?: boolean }): void;
  pulseEds(): void;
  resetDust(): void;
  retractDrillBite(): void;
  boostDrillWob(): void;
  pause(): void;
  resume(): void;
}

export interface SolverAlertInput {
  readonly code: string;
  readonly mode: SandboxMode;
  readonly body: Body;
  readonly severity: 'yellow' | 'red';
  readonly message: string;
  readonly metric: string;
  readonly value: number;
  readonly threshold: number;
  readonly suggestedAction?: SimulationAction;
}

export interface TelemetrySnapshot {
  readonly mode: SandboxMode;
  readonly body: Body;
  readonly sunlit: boolean;
  readonly gravity: number;
  readonly seed: number;
  readonly roverProfile: RoverProfile;
  readonly lidarProfile: LidarProfile;
  readonly hasN1ToN7: boolean;
  readonly missingVars: readonly string[];
  readonly vector: readonly [number, number, number, number, number, number];
  readonly telemetry: Readonly<Record<string, number>>;
  readonly lastAlert: SimTelemetryAlertDetail | null;
}

export type AlertListener = (alert: SimTelemetryAlertDetail) => void;

/**
 * Static 6-variable input vector shared with the sandbox. Mutated in place only.
 */
export const etlVector = new Float32Array([16.0, 0.72, 0.28, 0.14, 255.0, 0.02]);
// [0]: slope_deg (0° to 45°)
// [1]: roughness_tri (0.0 to 1.0)
// [2]: thermal_inertia (0.0 = loose fine dust, 1.0 = consolidated rock)
// [3]: albedo_mineral (0.05 to 0.60; low = ilmenite-rich basalt, FeTiO3)
// [4]: surface_temp_k (40 K to 400 K; < 265 K indicates permafrost / ice)
// [5]: ndvi (-0.1 to 1.0; < 0.05 indicates planetary-analog purity; 0 off Earth)

/** Preallocated N1..N7 physical site state shared across all 4 solvers without frame allocations. */
export const siteState: SitePhysicsState = createSitePhysicsState();

export const DEFAULT_SITE_SEED = 1;

/** Valid [min, max] per 6D vector index. */
export const VECTOR_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0, 45],
  [0, 1],
  [0, 1],
  [0.05, 0.6],
  [40, 400],
  [-0.1, 1.0],
];

const ALERT_COOLDOWN_MS = 1500;

let engineRef: ControllableSandboxEngine | null = null;
let siteSeed = DEFAULT_SITE_SEED;
let vectorVersion = 0;
let listenerInstalled = false;
let parentTargetOrigin = '*';
let lastAlert: SimTelemetryAlertDetail | null = null;
const alertCooldowns = new Map<string, number>();
const alertListeners: AlertListener[] = [];

function clampInto(index: number, value: number): number {
  if (!Number.isFinite(value)) return etlVector[index];
  const [min, max] = VECTOR_RANGES[index];
  return value < min ? min : value > max ? max : value;
}

export function getSiteSeed(): number {
  return siteSeed;
}

/** Increments on every vector, N1..N7, or seed write; lets HUD and embed bar resync controls. */
export function getVectorVersion(): number {
  return vectorVersion;
}

/** Configures the allowed/target origin for iframe `window.postMessage` transport (default `'*'`). */
export function setBridgeParentOrigin(origin: string): void {
  parentTargetOrigin = origin.trim() || '*';
}

export function getLastTelemetryAlert(): SimTelemetryAlertDetail | null {
  return lastAlert;
}

export function addAlertListener(fn: AlertListener): () => void {
  alertListeners.push(fn);
  return () => {
    const idx = alertListeners.indexOf(fn);
    if (idx >= 0) alertListeners.splice(idx, 1);
  };
}

/** Resets N2..N7 fields when operating from legacy 6D sliders/presets so stale N1..N7 lithology never leaks. */
function clearN1ToN7Overrides(): void {
  siteState.hasN1ToN7 = false;
  siteState.n1SlopeDeg = etlVector[0];
  siteState.n2RoughnessRmsM = Number.NaN;
  siteState.n3ReliefM = Number.NaN;
  siteState.silicaPct = Number.NaN;
  siteState.diurnalTempK = Number.NaN;
  siteState.thermalFinenessIdx = Number.NaN;
  siteState.solarIllumFrac = Number.NaN;
  siteState.saltationTimeFrac = Number.NaN;
  siteState.missingVars.length = 0;
}

/**
 * Emits a deduplicated threshold alert to same-window listeners (`nasa:sim-telemetry-alert`) and parent iframe.
 * Cooldown prevents identical code+severity pairs from flooding on consecutive frames.
 */
export function emitTelemetryAlert(input: SolverAlertInput, nowMs: number = Date.now()): boolean {
  const key = `${input.code}:${input.severity}`;
  const prevMs = alertCooldowns.get(key);
  if (prevMs !== undefined && nowMs - prevMs < ALERT_COOLDOWN_MS) return false;
  alertCooldowns.set(key, nowMs);

  const detail: SimTelemetryAlertDetail = {
    source: 'nasa-3d-sandbox',
    code: input.code,
    mode: input.mode,
    body: input.body,
    severity: input.severity,
    message: input.message,
    metric: input.metric,
    value: input.value,
    threshold: input.threshold,
    suggestedAction: input.suggestedAction,
    timestampMs: nowMs,
  };
  lastAlert = detail;

  for (let i = 0; i < alertListeners.length; i++) alertListeners[i](detail);

  if (typeof window !== 'undefined') {
    if (typeof CustomEvent === 'function') {
      window.dispatchEvent(new CustomEvent<SimTelemetryAlertDetail>(SIM_TELEMETRY_ALERT_EVENT, { detail }));
    }
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: SIM_TELEMETRY_ALERT_EVENT, detail }, parentTargetOrigin);
    }
  }
  return true;
}

/**
 * Legacy 6D setter used by standalone HUD sliders, presets, and benchmarks.
 * Clamps inputs, writes `etlVector` in place, clears stale N2..N7 fields, and requests terrain synthesis.
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
  clearN1ToN7Overrides();
  if (Number.isFinite(seed)) siteSeed = Math.trunc(seed);
  vectorVersion++;
  alertCooldowns.clear();
  engineRef?.requestSynthesis(siteSeed);
}

/**
 * Applies a full N1..N7 Copilot context payload onto `siteState` and `etlVector` while preserving missing-var honesty.
 */
export function applyAnalogContext(payload: AnalogN1N7Payload, seed: number = siteSeed): void {
  const prevBody = siteState.body;
  mapAnalogN1N7ToSandbox6D(payload, etlVector, siteState);
  const targetSeed = payload.seed ?? seed;
  if (Number.isFinite(targetSeed)) siteSeed = Math.trunc(targetSeed);
  vectorVersion++;
  alertCooldowns.clear();

  if (engineRef !== null) {
    if (siteState.body !== prevBody || siteState.body !== engineRef.getBody()) {
      engineRef.setGravity(defaultGravityForBody(siteState.body));
    }
    engineRef.setBody(siteState.body, { sunlit: siteState.sunlit });
    engineRef.requestSynthesis(siteSeed);
  }
}

function buildAnalogPayloadFromDetail(detail: SimulationControlDetail, resolvedSeed: number): AnalogN1N7Payload {
  const a = detail.analog;
  const sevenVector = Array.isArray(detail.vector) && detail.vector.length === 7 ? detail.vector : undefined;
  const fallbackBody =
    a?.body ??
    a?.targetBody ??
    detail.body ??
    detail.targetBody ??
    (typeof detail.gravity === 'number' && Number.isFinite(detail.gravity) ? bodyFromGravity(detail.gravity) : undefined);

  return {
    n1ToN7: a?.n1ToN7 ?? detail.n1ToN7 ?? sevenVector,
    n1SlopeDeg: a?.n1SlopeDeg,
    n2RoughnessRmsM: a?.n2RoughnessRmsM,
    n3ReliefM: a?.n3ReliefM,
    n4SilicaPct: a?.n4SilicaPct,
    n5DiurnalTempK: a?.n5DiurnalTempK,
    n6SolarIllumFrac: a?.n6SolarIllumFrac,
    n7SaltationTimeFrac: a?.n7SaltationTimeFrac,
    albedo: a?.albedo ?? detail.albedo,
    surfaceTempK: a?.surfaceTempK ?? detail.surfaceTempK,
    ndvi: a?.ndvi ?? detail.ndvi,
    diurnalPercentiles: a?.diurnalPercentiles ?? detail.diurnalPercentiles,
    body: fallbackBody,
    targetBody: a?.targetBody ?? detail.targetBody,
    roverProfile: a?.roverProfile ?? detail.roverProfile,
    lidarProfile: a?.lidarProfile ?? detail.lidarProfile,
    sunlit: a?.sunlit ?? detail.sunlit,
    seed: a?.seed ?? resolvedSeed,
  };
}

/** Applies one control message from `nasa:simulation-control`, `nasa:copilot-command`, or `window.postMessage`. */
export function handleSimulationControl(detail: SimulationControlDetail | null | undefined): void {
  const engine = engineRef;
  if (detail === null || detail === undefined || engine === null) return;

  const seed = typeof detail.seed === 'number' && Number.isFinite(detail.seed) ? Math.trunc(detail.seed) : siteSeed;
  const hasAnalog =
    detail.analog !== undefined ||
    detail.n1ToN7 !== undefined ||
    (Array.isArray(detail.vector) && detail.vector.length === 7);

  let synthesized = false;
  if (hasAnalog) {
    applyAnalogContext(buildAnalogPayloadFromDetail(detail, seed), seed);
    if (typeof detail.gravity === 'number' && Number.isFinite(detail.gravity)) {
      engine.setGravity(detail.gravity);
    }
    synthesized = true;
  } else {
    const prevBody = engine.getBody();
    const prevSunlit = engine.isSunlit();
    const prevRover = siteState.roverProfile;
    const prevLidar = siteState.lidarProfile;
    const gravityBefore = engine.getGravity();

    if (typeof detail.gravity === 'number' && Number.isFinite(detail.gravity)) {
      engine.setGravity(detail.gravity);
    }
    const namedBody = normalizeBodyName(detail.body ?? detail.targetBody);
    let nextBody = prevBody;
    if (namedBody !== null) nextBody = namedBody;
    else if (engine.getGravity() !== gravityBefore) nextBody = bodyFromGravity(engine.getGravity());

    const bodyChanged = nextBody !== prevBody;
    siteState.body = nextBody;
    if (isRoverProfile(detail.roverProfile)) siteState.roverProfile = detail.roverProfile;
    else if (bodyChanged) siteState.roverProfile = defaultRoverProfile(nextBody);

    if (isLidarProfile(detail.lidarProfile)) siteState.lidarProfile = detail.lidarProfile;
    else if (bodyChanged) siteState.lidarProfile = defaultLidarProfile(nextBody);

    const nextSunlit = typeof detail.sunlit === 'boolean' ? detail.sunlit : prevSunlit;
    siteState.sunlit = nextSunlit;
    engine.setBody(nextBody, { sunlit: nextSunlit });

    if (Array.isArray(detail.vector) && detail.vector.length >= 6) {
      const v = detail.vector;
      updateSandboxTerrain(v[0], v[1], v[2], v[3], v[4], v[5], seed);
      synthesized = true;
    } else if (seed !== siteSeed) {
      siteSeed = seed;
      vectorVersion++;
      alertCooldowns.clear();
      engine.requestSynthesis(siteSeed);
      synthesized = true;
    }

    if (detail.whatIf !== undefined) {
      if (applyWhatIfToSiteState(detail.whatIf, etlVector, siteState, detail.diurnalPercentiles)) {
        vectorVersion++;
        alertCooldowns.clear();
        engine.setBody(siteState.body, { sunlit: siteState.sunlit });
        engine.requestSynthesis(siteSeed);
        synthesized = true;
      }
    }

    if (
      !synthesized &&
      (nextSunlit !== prevSunlit ||
        nextBody !== prevBody ||
        siteState.roverProfile !== prevRover ||
        siteState.lidarProfile !== prevLidar)
    ) {
      vectorVersion++;
      alertCooldowns.clear();
      engine.requestSynthesis(siteSeed);
    }
  }

  if (isSandboxMode(detail.mode)) engine.setMode(detail.mode);

  switch (detail.action) {
    case 'PULSE_EDS':
      engine.pulseEds();
      break;
    case 'RESET_DUST':
      engine.resetDust();
      break;
    case 'RETRACT_DRILL_BITE':
      engine.retractDrillBite();
      break;
    case 'BOOST_DRILL_WOB':
      engine.boostDrillWob();
      break;
    case 'PAUSE':
      engine.pause();
      break;
    case 'RESUME':
      engine.resume();
      break;
  }
}

/** Returns a diagnostic snapshot of the current bridge state and active mode telemetry for Copilot / tests. */
export function getTelemetrySnapshot(): TelemetrySnapshot | null {
  if (engineRef === null) return null;
  const mode = engineRef.getMode();
  const solverTel = engineRef.solvers?.[mode]?.telemetry ?? {};
  return {
    mode,
    body: engineRef.getBody(),
    sunlit: engineRef.isSunlit(),
    gravity: engineRef.getGravity(),
    seed: siteSeed,
    roverProfile: siteState.roverProfile,
    lidarProfile: siteState.lidarProfile,
    hasN1ToN7: siteState.hasN1ToN7,
    missingVars: [...siteState.missingVars],
    vector: [etlVector[0], etlVector[1], etlVector[2], etlVector[3], etlVector[4], etlVector[5]],
    telemetry: { ...solverTel },
    lastAlert,
  };
}

function onSimulationControl(event: Event): void {
  handleSimulationControl((event as CustomEvent<SimulationControlDetail>).detail);
}

function onWindowMessage(event: MessageEvent): void {
  if (typeof window !== 'undefined' && event.source === window) return;
  if (parentTargetOrigin !== '*' && event.origin !== parentTargetOrigin) return;
  const parsed = parsePostMessageControl(event.data);
  if (parsed !== null) handleSimulationControl(parsed);
}

/** Connects the bridge to the engine and installs `CustomEvent` + `postMessage` listeners (idempotent). */
export function registerSandbox(engine: ControllableSandboxEngine, parentOrigin?: string): () => void {
  engineRef = engine;
  alertCooldowns.clear();
  lastAlert = null;
  if (typeof parentOrigin === 'string') setBridgeParentOrigin(parentOrigin);
  siteState.body = engine.getBody();
  siteState.sunlit = engine.isSunlit();
  siteState.roverProfile = defaultRoverProfile(siteState.body);
  siteState.lidarProfile = defaultLidarProfile(siteState.body);

  if (!listenerInstalled && typeof window !== 'undefined') {
    window.addEventListener(SIMULATION_CONTROL_EVENT, onSimulationControl);
    window.addEventListener(COPILOT_COMMAND_EVENT, onSimulationControl);
    window.addEventListener('message', onWindowMessage);
    listenerInstalled = true;
  }
  return unregisterSandbox;
}

/** Detaches listeners installed by `registerSandbox` and clears the active engine reference. */
export function unregisterSandbox(): void {
  engineRef = null;
  alertCooldowns.clear();
  if (listenerInstalled && typeof window !== 'undefined') {
    window.removeEventListener(SIMULATION_CONTROL_EVENT, onSimulationControl);
    window.removeEventListener(COPILOT_COMMAND_EVENT, onSimulationControl);
    window.removeEventListener('message', onWindowMessage);
    listenerInstalled = false;
  }
}
