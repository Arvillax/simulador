import { Group, Vector3 } from 'three';
import type { Body } from '../BodyLook.ts';
import type { OperationalStatus, RoverProfile, SandboxMode } from '../../bridge/copilotContract.ts';
import type { ModeSolver, SolverContext, TelemetryField } from './ModeSolver.ts';
import {
  ARM_INSET,
  BOGIE_PIVOT_X,
  H_OFFSET,
  L_BOGIE,
  L_ROCKER,
  ROCKER_PIVOT_X,
  TRACK_WIDTH,
  WHEEL_FRONT_X,
  WHEEL_MID_X,
  WHEEL_RADIUS,
  WHEEL_REAR_X,
  WHEEL_WIDTH,
  buildRover,
} from '../AssetBuilder.ts';
import type { RoverRig } from '../AssetBuilder.ts';
import { sampleHeight } from '../TerrainGenerator.ts';
import { rockReliefAt } from '../RockFieldInstancer.ts';
import { DEG2RAD, RAD2DEG, clamp01, lerp } from '../ScratchMath.ts';

export { WHEEL_RADIUS, WHEEL_WIDTH };

/** Contact patch length l (m). */
export const CONTACT_LENGTH = 0.1;
export const ROVER_MASS = 900;
export const WHEEL_COUNT = 6;
/** Bekker cohesive modulus k_c (N/m^(n+1)). */
export const KC = 1.4e3;
/** Janosi-Hanamoto shear deformation modulus K (m). */
export const SHEAR_K = 0.018;
export const COHESION_BASE_PA = 170;
export const COHESION_NDVI_PA = 3000;
export const SLIP_MAX = 0.95;
/** Commanded wheel angular speed (rad/s). */
export const WHEEL_OMEGA = 2.0;
const BISECTION_STEPS = 32;
const LANE_Z = 1.5;
const LANE_X_MIN = -8.5;
const LANE_X_MAX = 8.5;

// ---------------------------------------------------------------------------------------------------------------
// Pure terramechanics (Bekker-Wong pressure-sinkage, Janosi-Hanamoto shear). No allocation: callers own `out`.
// ---------------------------------------------------------------------------------------------------------------
export type SoilParams = {
  /** Sinkage exponent n. */
  n: number;
  kc: number;
  kphi: number;
  phiRad: number;
  K: number;
  /** Cohesion c (Pa). */
  c: number;
};

export function createSoil(): SoilParams {
  return { n: 1, kc: KC, kphi: 8.2e5, phiRad: 30 * DEG2RAD, K: SHEAR_K, c: COHESION_BASE_PA };
}

/** Soil parameters from thermal inertia (0 = loose fine dust, 1 = consolidated) and NDVI (biocrust cohesion). */
export function soilFromVector(thermalInertia: number, ndvi: number, out: SoilParams): SoilParams {
  const t = clamp01(thermalInertia);
  out.n = lerp(1.1, 0.7, t);
  out.kc = KC;
  out.kphi = lerp(8.2e5, 5.0e6, t);
  out.phiRad = lerp(30, 40, t) * DEG2RAD;
  out.K = SHEAR_K;
  out.c = COHESION_BASE_PA + COHESION_NDVI_PA * Math.max(0, ndvi);
  return out;
}

/** z0 = (p / (k_c / b + k_phi))^(1/n). */
export function staticSinkage(pressurePa: number, b: number, soil: SoilParams): number {
  return Math.pow(pressurePa / (soil.kc / b + soil.kphi), 1 / soil.n);
}

/** R_c = b (k_c / b + k_phi) z0^(n+1) / (n + 1). */
export function compactionResistance(b: number, z0: number, soil: SoilParams): number {
  return (b * (soil.kc / b + soil.kphi) * Math.pow(z0, soil.n + 1)) / (soil.n + 1);
}

/**
 * Thrust of one wheel: b ∫_0^l τ(j(x)) dx with τ(j) = (c + σ tanφ)(1 - e^(-j/K)) and j = s·x over the patch,
 * i.e. T = b·l·(c + σ tanφ)·[1 - K/(s l)·(1 - e^(-s l / K))].
 */
export function janosiThrust(slip: number, sigma: number, b: number, l: number, soil: SoilParams): number {
  const tauMax = soil.c + sigma * Math.tan(soil.phiRad);
  const x = (slip * l) / soil.K;
  const shape = x < 1e-6 ? 0.5 * x : 1 - (1 - Math.exp(-x)) / x;
  return b * l * tauMax * shape;
}

export type WheelSolution = {
  pressurePa: number;
  z0: number;
  slip: number;
  zTotal: number;
  thrustN: number;
  compactionN: number;
  gradeN: number;
  /** T - R_c - W sinθ at the solved slip (≈ 0 at steady state, negative when the wheel cannot climb). */
  drawbarN: number;
  /** T(s_max) - R_c - W sinθ: traction left before saturating slip. */
  reserveN: number;
};

export function createWheelSolution(): WheelSolution {
  return { pressurePa: 0, z0: 0, slip: 0, zTotal: 0, thrustN: 0, compactionN: 0, gradeN: 0, drawbarN: 0, reserveN: 0 };
}

/**
 * Steady-state wheel solution on a slope: finds slip s ∈ [0, 0.95] such that T(s) = W sinθ + R_c with a
 * fixed-iteration bisection, then applies slip-sinkage z_total = z0 (1 + 5 s^1.4).
 * The normal pressure uses the slope-normal load W cosθ over the b·l patch.
 */
export function solveWheel(slopeRad: number, wheelLoadN: number, soil: SoilParams, out: WheelSolution): WheelSolution {
  const b = WHEEL_WIDTH;
  const l = CONTACT_LENGTH;
  const pressure = (wheelLoadN * Math.cos(slopeRad)) / (b * l);
  const z0 = staticSinkage(pressure, b, soil);
  const rc = compactionResistance(b, z0, soil);
  const grade = wheelLoadN * Math.sin(slopeRad);
  const required = rc + grade;
  const thrustMax = janosiThrust(SLIP_MAX, pressure, b, l, soil);
  let slip: number;
  if (required <= 0) {
    slip = 0;
  } else if (thrustMax <= required) {
    slip = SLIP_MAX;
  } else {
    let lo = 0;
    let hi = SLIP_MAX;
    for (let i = 0; i < BISECTION_STEPS; i++) {
      const mid = 0.5 * (lo + hi);
      if (janosiThrust(mid, pressure, b, l, soil) < required) lo = mid;
      else hi = mid;
    }
    slip = 0.5 * (lo + hi);
  }
  const thrust = janosiThrust(slip, pressure, b, l, soil);
  out.pressurePa = pressure;
  out.z0 = z0;
  out.slip = slip;
  out.zTotal = z0 * (1 + 5 * Math.pow(slip, 1.4));
  out.thrustN = thrust;
  out.compactionN = rc;
  out.gradeN = grade;
  out.drawbarN = thrust - rc - grade;
  out.reserveN = thrustMax - rc - grade;
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Pure rocker-bogie kinematics (spring-less).
// ---------------------------------------------------------------------------------------------------------------
export type SuspensionPose = {
  bogieL: number;
  bogieR: number;
  rockerL: number;
  rockerR: number;
  /** Bogie pivot heights. */
  pivotL: number;
  pivotR: number;
  pitch: number;
  roll: number;
};

export function createSuspensionPose(): SuspensionPose {
  return { bogieL: 0, bogieR: 0, rockerL: 0, rockerR: 0, pivotL: 0, pivotR: 0, pitch: 0, roll: 0 };
}

/** Rocker angle on flat ground: atan2(-h_offset, L_rocker). Removed from the chassis pitch. */
export const ROCKER_REST_ANGLE = Math.atan2(-H_OFFSET, L_ROCKER);

/**
 * θ_bogie = atan2(y_M - y_R, L_bogie); y_pivot = (y_M + y_R)/2 + h_offset; θ_rocker = atan2(y_F - y_pivot, L_rocker);
 * pitch = (θ_rocker,L + θ_rocker,R)/2 - θ_rest; roll = atan2(ȳ_L - ȳ_R, W_track).
 * Inputs are wheel-hub heights (FL, ML, RL, FR, MR, RR).
 */
export function solveRockerBogie(
  yFL: number,
  yML: number,
  yRL: number,
  yFR: number,
  yMR: number,
  yRR: number,
  out: SuspensionPose,
): SuspensionPose {
  out.bogieL = Math.atan2(yML - yRL, L_BOGIE);
  out.bogieR = Math.atan2(yMR - yRR, L_BOGIE);
  out.pivotL = 0.5 * (yML + yRL) + H_OFFSET;
  out.pivotR = 0.5 * (yMR + yRR) + H_OFFSET;
  out.rockerL = Math.atan2(yFL - out.pivotL, L_ROCKER);
  out.rockerR = Math.atan2(yFR - out.pivotR, L_ROCKER);
  out.pitch = 0.5 * (out.rockerL + out.rockerR) - ROCKER_REST_ANGLE;
  const yL = (yFL + yML + yRL) / 3;
  const yR = (yFR + yMR + yRR) / 3;
  out.roll = Math.atan2(yL - yR, TRACK_WIDTH);
  return out;
}

export interface RoverLimits {
  readonly slopeGreenMaxDeg: number;
  readonly slopeYellowMaxDeg: number;
  readonly hazardRedM: number;
  readonly slipRed: number;
}

const VIPER_LIMITS: RoverLimits = { slopeGreenMaxDeg: 10, slopeYellowMaxDeg: 15, hazardRedM: 0.2, slipRed: 0.6 };
const CURIOSITY_LIMITS: RoverLimits = { slopeGreenMaxDeg: 20, slopeYellowMaxDeg: 30, hazardRedM: 0.5, slipRed: 0.6 };
const PERSEVERANCE_LIMITS: RoverLimits = { slopeGreenMaxDeg: 20, slopeYellowMaxDeg: 30, hazardRedM: 0.525, slipRed: 0.6 };

export function roverLimitsForProfile(profile: RoverProfile): RoverLimits {
  if (profile === 'VIPER') return VIPER_LIMITS;
  if (profile === 'CURIOSITY') return CURIOSITY_LIMITS;
  return PERSEVERANCE_LIMITS;
}

export function evaluateRoverEnvelope(
  profile: RoverProfile,
  body: Body,
  slopeDeg: number,
  slip: number,
  obstacleM = 0,
): OperationalStatus {
  const limits = roverLimitsForProfile(profile);
  if (slopeDeg > limits.slopeYellowMaxDeg || slip >= limits.slipRed || obstacleM > limits.hazardRedM) return 'red';
  if (slopeDeg > limits.slopeGreenMaxDeg) return 'yellow';
  if (body === 'moon' && slip > 0.2) return 'yellow';
  if (body !== 'moon' && slip >= 0.4) return 'yellow';
  return 'green';
}

const ALERT_SLOPE = 1;
const ALERT_SLIP = 2;
const ALERT_LUNAR_1_6G = 4;
const ALERT_OBSTACLE = 8;

// ---------------------------------------------------------------------------------------------------------------
// Solver
// ---------------------------------------------------------------------------------------------------------------
/** Wheel layout: FL, ML, RL, FR, MR, RR. Forward is +x, left is -z. */
const WHEEL_X = new Float64Array([WHEEL_FRONT_X, WHEEL_MID_X, WHEEL_REAR_X, WHEEL_FRONT_X, WHEEL_MID_X, WHEEL_REAR_X]);
const HALF_TRACK = TRACK_WIDTH / 2;
const WHEEL_Z = new Float64Array([-HALF_TRACK, -HALF_TRACK, -HALF_TRACK, HALF_TRACK, HALF_TRACK, HALF_TRACK]);

export type RoverTelemetry = {
  pitchDeg: number;
  rollDeg: number;
  slipPct: number;
  sinkageCm: number;
  drawbarN: number;
  speedMps: number;
  reserveN: number;
  gravity: number;
  slopeLimitDeg: number;
};

const ROVER_FIELDS: readonly TelemetryField[] = [
  { key: 'pitchDeg', label: 'Pitch', unit: '°', digits: 1 },
  { key: 'rollDeg', label: 'Roll', unit: '°', digits: 1 },
  { key: 'slipPct', label: 'Slip', unit: '%', digits: 1 },
  { key: 'sinkageCm', label: 'Sinkage', unit: 'cm', digits: 2 },
  { key: 'drawbarN', label: 'Drawbar pull', unit: 'N', digits: 1 },
  { key: 'speedMps', label: 'Ground speed', unit: 'm/s', digits: 3 },
  { key: 'reserveN', label: 'Traction reserve', unit: 'N', digits: 0 },
  { key: 'gravity', label: 'Gravity', unit: 'm/s²', digits: 2 },
  { key: 'slopeLimitDeg', label: 'Slope limit', unit: '°', digits: 0 },
];

export class RoverSolver implements ModeSolver {
  readonly mode: SandboxMode = 'ROVER';
  readonly group = new Group();
  readonly focus = new Vector3();
  readonly fields = ROVER_FIELDS;
  readonly note = 'Bekker-Wong / Janosi-Hanamoto · VIPER (15° Moon) / Perseverance (30° Mars) · slip stall ≥ 60%';
  readonly telemetry: RoverTelemetry = {
    pitchDeg: 0,
    rollDeg: 0,
    slipPct: 0,
    sinkageCm: 0,
    drawbarN: 0,
    speedMps: 0,
    reserveN: 0,
    gravity: 0,
    slopeLimitDeg: 15,
  };
  private readonly ctx: SolverContext;
  private readonly rig: RoverRig;
  private readonly soil = createSoil();
  private readonly wheel = createWheelSolution();
  private readonly pose = createSuspensionPose();
  private readonly hubY = new Float64Array(6);
  private x = -6;
  private spin = 0;
  private activeAlerts = 0;

  constructor(ctx: SolverContext) {
    this.ctx = ctx;
    this.rig = buildRover();
    this.group.name = 'mode-rover';
    this.group.add(this.rig.root);
  }

  activate(): void {
    this.activeAlerts = 0;
    this.checkAlerts(0, false);
  }

  deactivate(): void {}

  onVectorChanged(): void {
    const effectiveNdvi = this.ctx.site.body === 'earth' ? this.ctx.vector[5] : 0;
    soilFromVector(this.ctx.vector[2], effectiveNdvi, this.soil);
    this.activeAlerts = 0;
    this.placeRig(0, true);
  }

  update(dt: number, _t: number): void {
    const w = this.wheel;
    const speed = WHEEL_RADIUS * WHEEL_OMEGA * (1 - w.slip);
    this.x += speed * dt;
    if (this.x > LANE_X_MAX) this.x = LANE_X_MIN;
    this.spin -= WHEEL_OMEGA * dt;
    this.placeRig(speed, true);
  }

  private placeRig(speed: number, emitAlerts: boolean): void {
    const v = this.ctx.vector;
    const gravity = this.ctx.physics.gravity;
    solveWheel(v[0] * DEG2RAD, (ROVER_MASS * gravity) / WHEEL_COUNT, this.soil, this.wheel);
    const sink = this.wheel.zTotal;
    const rig = this.rig;
    const hub = this.hubY;
    let maxRockRelief = 0;
    for (let i = 0; i < 6; i++) {
      const wx = this.x + WHEEL_X[i];
      const wz = LANE_Z + WHEEL_Z[i];
      const rockH = rockReliefAt(wx, wz);
      if (rockH > maxRockRelief) maxRockRelief = rockH;
      hub[i] = sampleHeight(wx, wz) + rockH + WHEEL_RADIUS - sink;
      const wheel = rig.wheels[i];
      wheel.position.set(WHEEL_X[i], hub[i], WHEEL_Z[i]);
      wheel.rotation.z = this.spin;
    }
    const pose = solveRockerBogie(hub[0], hub[1], hub[2], hub[3], hub[4], hub[5], this.pose);

    for (let side = 0; side < 2; side++) {
      const base = side * 3;
      const armZ = side === 0 ? -(HALF_TRACK - ARM_INSET) : HALF_TRACK - ARM_INSET;
      const pivotY = side === 0 ? pose.pivotL : pose.pivotR;
      const bogie = rig.bogies[side];
      bogie.position.set(BOGIE_PIVOT_X, 0.5 * (hub[base + 1] + hub[base + 2]), armZ);
      bogie.rotation.z = side === 0 ? pose.bogieL : pose.bogieR;

      const rocker = rig.rockers[side];
      const dy = hub[base] - pivotY;
      rocker.position.set(0.5 * (WHEEL_FRONT_X + BOGIE_PIVOT_X), 0.5 * (hub[base] + pivotY), armZ);
      rocker.rotation.z = side === 0 ? pose.rockerL : pose.rockerR;
      rig.rockerBeams[side].scale.x = Math.sqrt(L_ROCKER * L_ROCKER + dy * dy);
    }

    // Chassis rides on the two rocker main pivots, interpolated along each rocker beam.
    const k = (ROCKER_PIVOT_X - BOGIE_PIVOT_X) / L_ROCKER;
    const mainL = pose.pivotL + k * (hub[0] - pose.pivotL);
    const mainR = pose.pivotR + k * (hub[3] - pose.pivotR);
    rig.chassis.position.set(0.05, 0.5 * (mainL + mainR) + 0.16, 0);
    rig.chassis.rotation.set(pose.roll, 0, pose.pitch);

    rig.root.position.set(this.x, 0, LANE_Z);
    this.focus.set(this.x, 0.5 * (mainL + mainR), LANE_Z);

    const limits = roverLimitsForProfile(this.ctx.site.roverProfile);
    const t = this.telemetry;
    t.pitchDeg = pose.pitch * RAD2DEG;
    t.rollDeg = pose.roll * RAD2DEG;
    t.slipPct = this.wheel.slip * 100;
    t.sinkageCm = sink * 100;
    t.drawbarN = this.wheel.drawbarN * WHEEL_COUNT;
    t.reserveN = this.wheel.reserveN * WHEEL_COUNT;
    t.speedMps = speed;
    t.gravity = gravity;
    t.slopeLimitDeg = limits.slopeYellowMaxDeg;

    if (emitAlerts) this.checkAlerts(maxRockRelief, true);
  }

  private checkAlerts(maxRockRelief: number, onlyWhenActive: boolean): void {
    if (onlyWhenActive && !this.group.visible) return;
    const site = this.ctx.site;
    const limits = roverLimitsForProfile(site.roverProfile);
    const slope = this.ctx.vector[0];
    const slip = this.wheel.slip;

    if (slope > limits.slopeYellowMaxDeg) {
      if ((this.activeAlerts & ALERT_SLOPE) === 0) {
        this.activeAlerts |= ALERT_SLOPE;
        this.ctx.emitAlert({
          code: 'ROVER_SLOPE_EXCEEDED',
          mode: 'ROVER',
          body: site.body,
          severity: 'red',
          message: `Slope ${slope.toFixed(1)}° exceeds ${site.roverProfile} limit (${limits.slopeYellowMaxDeg}°).`,
          metric: 'slope_deg',
          value: slope,
          threshold: limits.slopeYellowMaxDeg,
        });
      }
    } else {
      this.activeAlerts &= ~ALERT_SLOPE;
    }

    if (slip >= limits.slipRed) {
      if ((this.activeAlerts & ALERT_SLIP) === 0) {
        this.activeAlerts |= ALERT_SLIP;
        this.ctx.emitAlert({
          code: 'ROVER_SLIP_CRITICAL',
          mode: 'ROVER',
          body: site.body,
          severity: 'red',
          message: `Wheel slip ${(slip * 100).toFixed(1)}% reached VO halt threshold (≥ ${(limits.slipRed * 100).toFixed(0)}%).`,
          metric: 'wheel_slip',
          value: slip,
          threshold: limits.slipRed,
        });
      }
    } else {
      this.activeAlerts &= ~ALERT_SLIP;
    }

    if (site.body === 'moon' && slip > 0.2 && slip < limits.slipRed) {
      if ((this.activeAlerts & ALERT_LUNAR_1_6G) === 0) {
        this.activeAlerts |= ALERT_LUNAR_1_6G;
        this.ctx.emitAlert({
          code: 'ROVER_LUNAR_1_6G_CAUTION',
          mode: 'ROVER',
          body: site.body,
          severity: 'yellow',
          message: `Lunar 1/6 g warning: slip ${(slip * 100).toFixed(1)}% > 20%; real 1/6 g drawbar pull can drop ≥ 20% with ≤ 40% more sinkage.`,
          metric: 'wheel_slip',
          value: slip,
          threshold: 0.2,
        });
      }
    } else {
      this.activeAlerts &= ~ALERT_LUNAR_1_6G;
    }

    if (maxRockRelief > limits.hazardRedM) {
      if ((this.activeAlerts & ALERT_OBSTACLE) === 0) {
        this.activeAlerts |= ALERT_OBSTACLE;
        this.ctx.emitAlert({
          code: 'ROVER_OBSTACLE_EXCEEDED',
          mode: 'ROVER',
          body: site.body,
          severity: 'red',
          message: `Rock clearance ${maxRockRelief.toFixed(2)} m exceeds ${site.roverProfile} hazard threshold (${limits.hazardRedM.toFixed(2)} m).`,
          metric: 'rock_relief_m',
          value: maxRockRelief,
          threshold: limits.hazardRedM,
        });
      }
    } else {
      this.activeAlerts &= ~ALERT_OBSTACLE;
    }
  }
}
