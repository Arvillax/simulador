import { Group, Vector3 } from 'three';
import type { SandboxMode } from '../SandboxEngine.ts';
import type { ModeSolver, SolverContext, TelemetryField } from './ModeSolver.ts';
import { STRATA_BOUNDS_M, buildDrill } from '../AssetBuilder.ts';
import type { DrillRig } from '../AssetBuilder.ts';
import { sampleHeight } from '../TerrainGenerator.ts';
import { clamp, clamp01 } from '../ScratchMath.ts';

export const DRY_DENSITY_DEEP = 1800;
export const DRY_DENSITY_DROP = 700;
export const DENSITY_SCALE_M = 0.06;
export const ICE_TEMPERATURE_K = 265;
/** Ice is applied only below this depth (m). */
export const ICE_TOP_DEPTH_M = 0.1;
export const MAX_ICE_WT = 0.3;
export const WOB_N = 85;
export const MSE_MIN = 0.8;
export const MSE_MAX = 25;
export const ROP_MIN = 1.2;
export const ROP_MAX = 120;
export const DRILL_MAX_DEPTH_M = 1.5;
/** Simulated time scale: one real second advances this many simulated seconds (1 s = 20 min). */
export const DRILL_TIME_SCALE = 1200;
const DENSITY_MIN = DRY_DENSITY_DEEP - DRY_DENSITY_DROP;
const DENSITY_MAX = DRY_DENSITY_DEEP * (1 + MAX_ICE_WT);
const AUGER_SPIN_RAD_S = 5;

/** Hayne regolith profile: ρ_dry(z) = 1800 - 700·e^(-z/0.06) kg/m³. */
export function hayneDryDensity(z: number): number {
  return DRY_DENSITY_DEEP - DRY_DENSITY_DROP * Math.exp(-z / DENSITY_SCALE_M);
}

/** Ice weight fraction from surface temperature: 0 at ≥ 265 K, else clamp(0.05 + (265 - T)/200·0.25, 0, 0.30). */
export function iceWeightFraction(tempK: number): number {
  if (tempK >= ICE_TEMPERATURE_K) return 0;
  return clamp(0.05 + ((ICE_TEMPERATURE_K - tempK) / 200) * 0.25, 0, MAX_ICE_WT);
}

/** ρ_icy(z) = ρ_dry(z)·(1 + wt%) below 0.10 m, ρ_dry above. */
export function icyDensity(z: number, tempK: number): number {
  const dry = hayneDryDensity(z);
  return z < ICE_TOP_DEPTH_M ? dry : dry * (1 + iceWeightFraction(tempK));
}

/**
 * Mechanical specific energy (MJ/m³). EMPIRICAL MAPPING, NOT CALIBRATED: a hardness index
 * h = 0.6·(normalised density) + 0.4·(ice wt / 0.30) is mapped log-linearly onto [0.8, 25] MJ/m³,
 * so loose dry surface regolith sits at 0.8 and dense ice-cemented regolith at 25.
 */
export function mechanicalSpecificEnergy(densityKgM3: number, iceWt: number): number {
  const u = clamp01((densityKgM3 - DENSITY_MIN) / (DENSITY_MAX - DENSITY_MIN));
  const h = clamp01(0.6 * u + 0.4 * (iceWt / MAX_ICE_WT));
  return clamp(MSE_MIN * Math.pow(MSE_MAX / MSE_MIN, h), MSE_MIN, MSE_MAX);
}

/** ROP = clamp(120·(0.8/MSE)·(WOB/85), 1.2, 120) cm/h. */
export function rateOfPenetration(mse: number, wob: number = WOB_N): number {
  return clamp(ROP_MAX * (MSE_MIN / mse) * (wob / WOB_N), ROP_MIN, ROP_MAX);
}

export type DrillTelemetry = {
  depthCm: number;
  densityKgM3: number;
  iceWtPct: number;
  mseMJm3: number;
  ropCmH: number;
  simHours: number;
};

const DRILL_FIELDS: readonly TelemetryField[] = [
  { key: 'depthCm', label: 'Depth', unit: 'cm', digits: 1 },
  { key: 'densityKgM3', label: 'Density', unit: 'kg/m³', digits: 0 },
  { key: 'iceWtPct', label: 'Ice', unit: 'wt%', digits: 1 },
  { key: 'mseMJm3', label: 'MSE', unit: 'MJ/m³', digits: 2 },
  { key: 'ropCmH', label: 'ROP', unit: 'cm/h', digits: 1 },
  { key: 'simHours', label: 'Sim time', unit: 'h', digits: 2 },
];

export class IsruDrillSolver implements ModeSolver {
  readonly mode: SandboxMode = 'ISRU_DRILL';
  readonly group = new Group();
  readonly focus = new Vector3();
  readonly fields = DRILL_FIELDS;
  readonly note = `Time scale: 1 s = ${DRILL_TIME_SCALE / 60} min · WOB ${WOB_N} N · MSE mapping is empirical, not calibrated`;
  readonly telemetry: DrillTelemetry = { depthCm: 0, densityKgM3: 0, iceWtPct: 0, mseMJm3: 0, ropCmH: 0, simHours: 0 };
  private readonly ctx: SolverContext;
  private readonly rig: DrillRig;
  private depth = 0;
  private simSeconds = 0;

  constructor(ctx: SolverContext) {
    this.ctx = ctx;
    this.rig = buildDrill();
    this.group.name = 'mode-isru-drill';
    this.group.add(this.rig.root);
  }

  activate(): void {}

  deactivate(): void {}

  onVectorChanged(): void {
    const ground = sampleHeight(0, 0);
    this.rig.root.position.set(0, ground, 0);
    this.focus.set(0, ground + 0.3, 0);
    const tempK = this.ctx.vector[4];
    const ice = iceWeightFraction(tempK);
    const mats = this.rig.strataMaterials;
    for (let i = 0; i < mats.length; i++) {
      const mid = 0.5 * (STRATA_BOUNDS_M[i] + STRATA_BOUNDS_M[i + 1]);
      const dense = clamp01((hayneDryDensity(mid) - DENSITY_MIN) / DRY_DENSITY_DROP);
      const iceHere = mid >= ICE_TOP_DEPTH_M ? ice / MAX_ICE_WT : 0;
      const shade = 0.62 - 0.25 * dense;
      mats[i].color.setRGB(
        shade + (0.85 - shade) * iceHere,
        shade * 0.86 + (0.92 - shade * 0.86) * iceHere,
        shade * 0.7 + (1.0 - shade * 0.7) * iceHere,
      );
    }
    this.sample();
  }

  update(dt: number, t: number): void {
    const simDt = dt * DRILL_TIME_SCALE;
    this.simSeconds += simDt;
    this.sample();
    this.depth += (this.telemetry.ropCmH / 100 / 3600) * simDt;
    if (this.depth >= DRILL_MAX_DEPTH_M) this.depth = 0;

    const mseNorm = (this.telemetry.mseMJm3 - MSE_MIN) / (MSE_MAX - MSE_MIN);
    const rig = this.rig;
    // Percussive vibration, stronger in harder material.
    const vibration = Math.sin(t * 2 * Math.PI * 14) * 0.004 * (0.3 + mseNorm);
    rig.augerPivot.position.y = -this.depth + vibration;
    rig.auger.rotation.y += AUGER_SPIN_RAD_S * dt;
    rig.augerMaterial.uniforms.uDrillHeat.value = mseNorm;
  }

  private sample(): void {
    const tempK = this.ctx.vector[4];
    const z = this.depth;
    const ice = z >= ICE_TOP_DEPTH_M ? iceWeightFraction(tempK) : 0;
    const density = icyDensity(z, tempK);
    const mse = mechanicalSpecificEnergy(density, ice);
    const t = this.telemetry;
    t.depthCm = z * 100;
    t.densityKgM3 = density;
    t.iceWtPct = ice * 100;
    t.mseMJm3 = mse;
    t.ropCmH = rateOfPenetration(mse);
    t.simHours = this.simSeconds / 3600;
  }
}
