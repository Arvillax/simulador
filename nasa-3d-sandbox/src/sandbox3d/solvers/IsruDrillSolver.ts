import { Group, Vector3 } from 'three';
import type { Body } from '../BodyLook.ts';
import type { SandboxMode } from '../../bridge/copilotContract.ts';
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
export const WOB_N = 100;
export const TRIDENT_WOB_BOOST_N = 200;
export const TRIDENT_STALL_TORQUE_NM = 16.0;
export const TRIDENT_MAX_POWER_W = 200;
export const TRIDENT_BITE_STEP_M = 0.1;
export const TRIDENT_RPM = 100;
export const TRIDENT_PERC_POWER_W = 24;
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
const RETRACT_SPEED_MS = 0.45;

const ALERT_STALL = 1;
const ALERT_POWER = 2;
const ALERT_HEAD_COLD = 4;
const ALERT_MARS_MELT = 8;

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

/** Lithology hardness factor from N4 (% SiO2: <=53% mafic ~6.87 GPa vs >65% felsic quartz 12.2 GPa). */
export function silicaLithologyFactor(silicaPct: number): number {
  if (!Number.isFinite(silicaPct) || silicaPct <= 53) return 1.0;
  if (silicaPct <= 65) return 1.0 + ((silicaPct - 53) / 12) * 0.45;
  return 1.45 + clamp01((silicaPct - 65) / 13) * 0.45;
}

/**
 * Mechanical specific energy (MJ/m³). EMPIRICAL MAPPING scaled by lithology (% SiO2) and ice hardness:
 * loose dry surface regolith starts near 0.8 MJ/m³, dense icy/felsic material scales up toward 25 MJ/m³.
 */
export function mechanicalSpecificEnergy(densityKgM3: number, iceWt: number, silicaPct = Number.NaN): number {
  const u = clamp01((densityKgM3 - DENSITY_MIN) / (DENSITY_MAX - DENSITY_MIN));
  const litho = (silicaLithologyFactor(silicaPct) - 1.0) * 0.35;
  const h = clamp01(0.55 * u + 0.35 * (iceWt / MAX_ICE_WT) + litho);
  return clamp(MSE_MIN * Math.pow(MSE_MAX / MSE_MIN, h), MSE_MIN, MSE_MAX);
}

/** ROP = clamp(120·(0.8/MSE)·(WOB/100), 1.2, 120) cm/h. */
export function rateOfPenetration(mse: number, wob: number = WOB_N): number {
  return clamp(ROP_MAX * (MSE_MIN / mse) * (wob / WOB_N), ROP_MIN, ROP_MAX);
}

/** TRIDENT rotary bit torque [N*m] from WOB, depth, ice saturation, and N4 silica abrasiveness. */
export function drillTorqueNm(wobN: number, depthM: number, densityKgM3: number, iceWt: number, silicaPct: number): number {
  const densRatio = densityKgM3 / DRY_DENSITY_DEEP;
  const litho = silicaLithologyFactor(silicaPct);
  const base = 0.032 * wobN * litho;
  const augerDrag = (2.8 + 7.5 * (iceWt / MAX_ICE_WT)) * clamp01(depthM / 1.2) * densRatio * litho;
  return base + augerDrag;
}

/** Total TRIDENT electrical/mechanical power [W] = rotary + percussive. */
export function drillTotalPowerW(torqueNm: number, stalled = false): number {
  const rotary = ((2 * Math.PI * TRIDENT_RPM) / 60) * torqueNm;
  return rotary + (stalled ? 0 : TRIDENT_PERC_POWER_W);
}

/** Body-specific thermal cutoff check (Mars Icebreaker melts > 0 °C; Moon TRIDENT cools via 0.10 m bites). */
export function isDrillBitThermalCutoff(body: Body, bitTempC: number): boolean {
  return body === 'mars' && bitTempC > 0;
}

export type DrillTelemetry = {
  depthCm: number;
  densityKgM3: number;
  iceWtPct: number;
  mseMJm3: number;
  ropCmH: number;
  torqueNm: number;
  powerW: number;
  wobN: number;
  bitTempC: number;
  bites: number;
  simHours: number;
};

const DRILL_FIELDS: readonly TelemetryField[] = [
  { key: 'depthCm', label: 'Depth', unit: 'cm', digits: 1 },
  { key: 'densityKgM3', label: 'Density', unit: 'kg/m³', digits: 0 },
  { key: 'iceWtPct', label: 'Ice', unit: 'wt%', digits: 1 },
  { key: 'mseMJm3', label: 'MSE', unit: 'MJ/m³', digits: 2 },
  { key: 'ropCmH', label: 'ROP', unit: 'cm/h', digits: 1 },
  { key: 'torqueNm', label: 'Bit torque', unit: 'N·m', digits: 1 },
  { key: 'powerW', label: 'Total power', unit: 'W', digits: 0 },
  { key: 'wobN', label: 'WOB', unit: 'N', digits: 0 },
  { key: 'bitTempC', label: 'Bit temp', unit: '°C', digits: 1 },
  { key: 'bites', label: '0.10m bites', unit: '', digits: 0 },
  { key: 'simHours', label: 'Sim time', unit: 'h', digits: 2 },
];

type DrillPhase = 'DRILLING' | 'RETRACTING' | 'PLUNGING' | 'STALLED';

export class IsruDrillSolver implements ModeSolver {
  readonly mode: SandboxMode = 'ISRU_DRILL';
  readonly group = new Group();
  readonly focus = new Vector3();
  readonly fields = DRILL_FIELDS;
  readonly note = `TRIDENT ${WOB_N}/${TRIDENT_WOB_BOOST_N} N WOB · 0.10 m bite retraction · stall ≥ ${TRIDENT_STALL_TORQUE_NM} N·m / ${TRIDENT_MAX_POWER_W} W`;
  readonly telemetry: DrillTelemetry = {
    depthCm: 0,
    densityKgM3: 0,
    iceWtPct: 0,
    mseMJm3: 0,
    ropCmH: 0,
    torqueNm: 0,
    powerW: 0,
    wobN: WOB_N,
    bitTempC: 0,
    bites: 0,
    simHours: 0,
  };
  private readonly ctx: SolverContext;
  private readonly rig: DrillRig;
  private depth = 0;
  private visualDepth = 0;
  private nextBiteM = TRIDENT_BITE_STEP_M;
  private biteCount = 0;
  private wobN = WOB_N;
  private biteHeatC = 0;
  private phase: DrillPhase = 'DRILLING';
  private simSeconds = 0;
  private activeAlerts = 0;

  constructor(ctx: SolverContext) {
    this.ctx = ctx;
    this.rig = buildDrill();
    this.group.name = 'mode-isru-drill';
    this.group.add(this.rig.root);
  }

  activate(): void {
    this.activeAlerts = 0;
    this.sample();
    this.checkAlerts();
  }

  deactivate(): void {}

  /** Triggers immediate 0.10 m bite retraction to clear cuttings, cool the bit, and recover from stall. */
  retractBite(): void {
    this.wobN = WOB_N;
    this.phase = 'RETRACTING';
    this.biteCount++;
    this.activeAlerts &= ~(ALERT_STALL | ALERT_POWER | ALERT_MARS_MELT);
    this.sample();
  }

  /** Toggles TRIDENT Weight-on-Bit between nominal 100 N and boost 200 N (`BOOST_DRILL_WOB`). */
  boostWob(): void {
    this.wobN = this.wobN < TRIDENT_WOB_BOOST_N ? TRIDENT_WOB_BOOST_N : WOB_N;
    this.sample();
    if (this.group.visible) this.checkAlerts();
  }

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
    this.activeAlerts = 0;
    if (this.phase === 'STALLED') this.phase = 'DRILLING';
    this.sample();
    if (this.group.visible) this.checkAlerts();
  }

  update(dt: number, t: number): void {
    const simDt = dt * DRILL_TIME_SCALE;
    this.simSeconds += simDt;
    this.sample();

    const tel = this.telemetry;
    const site = this.ctx.site;
    const torqueStall = tel.torqueNm >= TRIDENT_STALL_TORQUE_NM;
    const powerStall = tel.powerW >= TRIDENT_MAX_POWER_W;
    const thermalMeltCutoff = isDrillBitThermalCutoff(site.body, tel.bitTempC);

    if (this.phase === 'RETRACTING') {
      this.visualDepth = Math.max(Math.max(0, this.depth - 0.18), this.visualDepth - RETRACT_SPEED_MS * dt);
      this.biteHeatC = Math.max(0, this.biteHeatC - 18 * dt);
      if (this.visualDepth <= Math.max(0, this.depth - 0.16)) {
        this.biteHeatC = 0;
        this.phase = 'PLUNGING';
      }
    } else if (this.phase === 'PLUNGING') {
      this.visualDepth = Math.min(this.depth, this.visualDepth + RETRACT_SPEED_MS * dt);
      if (this.visualDepth >= this.depth - 1e-4) {
        this.visualDepth = this.depth;
        this.phase = torqueStall || powerStall || thermalMeltCutoff ? 'STALLED' : 'DRILLING';
      }
    } else if (torqueStall || powerStall || thermalMeltCutoff) {
      this.phase = 'STALLED';
      this.telemetry.ropCmH = 0;
    } else {
      this.phase = 'DRILLING';
      this.depth += (tel.ropCmH / 100 / 3600) * simDt;
      this.visualDepth = this.depth;
      this.biteHeatC = Math.min(45, this.biteHeatC + 0.35 * (tel.powerW / 100) * dt);

      if (this.depth >= DRILL_MAX_DEPTH_M) {
        this.depth = 0;
        this.visualDepth = 0;
        this.nextBiteM = TRIDENT_BITE_STEP_M;
        this.biteHeatC = 0;
      } else if (this.depth >= this.nextBiteM) {
        this.nextBiteM += TRIDENT_BITE_STEP_M;
        this.biteCount++;
        this.phase = 'RETRACTING';
      }
    }

    if (this.group.visible) this.checkAlerts();

    const mseNorm = (tel.mseMJm3 - MSE_MIN) / (MSE_MAX - MSE_MIN);
    const rig = this.rig;
    const isStopped = this.phase === 'STALLED';
    // Percussive vibration stops on stall; otherwise scales with rock hardness.
    const vibration = isStopped ? 0 : Math.sin(t * 2 * Math.PI * 14) * 0.004 * (0.3 + mseNorm);
    rig.augerPivot.position.y = -this.visualDepth + vibration;
    if (!isStopped) rig.auger.rotation.y += AUGER_SPIN_RAD_S * dt;
    rig.augerMaterial.uniforms.uDrillHeat.value = isStopped ? 1 : clamp01(mseNorm * 0.8 + this.biteHeatC / 60);
  }

  private sample(): void {
    const tempK = this.ctx.vector[4];
    const silicaPct = this.ctx.site.silicaPct;
    const z = this.depth;
    const ice = z >= ICE_TOP_DEPTH_M ? iceWeightFraction(tempK) : 0;
    const density = icyDensity(z, tempK);
    const mse = mechanicalSpecificEnergy(density, ice, silicaPct);
    const torque = drillTorqueNm(this.wobN, z, density, ice, silicaPct);
    const stalled = torque >= TRIDENT_STALL_TORQUE_NM;
    const power = drillTotalPowerW(torque, stalled);
    const bitTempC = tempK - 273.15 + this.biteHeatC;

    const t = this.telemetry;
    t.depthCm = z * 100;
    t.densityKgM3 = density;
    t.iceWtPct = ice * 100;
    t.mseMJm3 = mse;
    t.ropCmH = stalled || power >= TRIDENT_MAX_POWER_W ? 0 : rateOfPenetration(mse, this.wobN);
    t.torqueNm = torque;
    t.powerW = power;
    t.wobN = this.wobN;
    t.bitTempC = bitTempC;
    t.bites = this.biteCount;
    t.simHours = this.simSeconds / 3600;
  }

  private checkAlerts(): void {
    if (!this.group.visible) return;
    const site = this.ctx.site;
    const t = this.telemetry;
    const tempK = this.ctx.vector[4];

    if (t.torqueNm >= TRIDENT_STALL_TORQUE_NM) {
      if ((this.activeAlerts & ALERT_STALL) === 0) {
        this.activeAlerts |= ALERT_STALL;
        this.ctx.emitAlert({
          code: 'DRILL_TORQUE_STALL',
          mode: 'ISRU_DRILL',
          body: site.body,
          severity: 'red',
          message: `TRIDENT bit stall: torque ${t.torqueNm.toFixed(1)} N·m >= ${TRIDENT_STALL_TORQUE_NM} N·m limit.`,
          metric: 'torque_nm',
          value: t.torqueNm,
          threshold: TRIDENT_STALL_TORQUE_NM,
          suggestedAction: 'RETRACT_DRILL_BITE',
        });
      }
    } else {
      this.activeAlerts &= ~ALERT_STALL;
    }

    if (t.powerW >= TRIDENT_MAX_POWER_W) {
      if ((this.activeAlerts & ALERT_POWER) === 0) {
        this.activeAlerts |= ALERT_POWER;
        this.ctx.emitAlert({
          code: 'DRILL_POWER_LIMIT',
          mode: 'ISRU_DRILL',
          body: site.body,
          severity: 'red',
          message: `TRIDENT total power ${t.powerW.toFixed(0)} W >= ${TRIDENT_MAX_POWER_W} W max limit.`,
          metric: 'power_w',
          value: t.powerW,
          threshold: TRIDENT_MAX_POWER_W,
          suggestedAction: 'RETRACT_DRILL_BITE',
        });
      }
    } else {
      this.activeAlerts &= ~ALERT_POWER;
    }

    // Moon PSR cold soak: percussive gearbox grease Braycote 601EF inhibits percussion < 0 °C (< 200 K surface soak risk).
    if (site.body === 'moon' && tempK < 200) {
      if ((this.activeAlerts & ALERT_HEAD_COLD) === 0) {
        this.activeAlerts |= ALERT_HEAD_COLD;
        this.ctx.emitAlert({
          code: 'DRILL_HEAD_TEMP_COLD',
          mode: 'ISRU_DRILL',
          body: site.body,
          severity: 'yellow',
          message: `Cryogenic lunar site (${tempK.toFixed(0)} K): preheat percussion head > 0 °C (Braycote 601EF) and continue 0.10 m bites.`,
          metric: 'surface_temp_k',
          value: tempK,
          threshold: 200,
        });
      }
    } else {
      this.activeAlerts &= ~ALERT_HEAD_COLD;
    }

    if (isDrillBitThermalCutoff(site.body, t.bitTempC)) {
      if ((this.activeAlerts & ALERT_MARS_MELT) === 0) {
        this.activeAlerts |= ALERT_MARS_MELT;
        this.ctx.emitAlert({
          code: 'DRILL_MARS_MELT_CUTOFF',
          mode: 'ISRU_DRILL',
          body: site.body,
          severity: 'red',
          message: `Mars Icebreaker thermal cutoff: bit temp ${t.bitTempC.toFixed(1)} °C > 0 °C prevents sublimation/melting.`,
          metric: 'bit_temp_c',
          value: t.bitTempC,
          threshold: 0,
          suggestedAction: 'RETRACT_DRILL_BITE',
        });
      }
    } else {
      this.activeAlerts &= ~ALERT_MARS_MELT;
    }
  }
}
