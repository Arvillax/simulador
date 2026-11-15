import { Group, Vector3 } from 'three';
import type { SandboxMode } from '../SandboxEngine.ts';
import type { ModeSolver, SolverContext, TelemetryField } from './ModeSolver.ts';
import { buildSuit } from '../AssetBuilder.ts';
import type { SuitRig } from '../AssetBuilder.ts';
import { sampleHeight } from '../TerrainGenerator.ts';
import { clamp01 } from '../ScratchMath.ts';

export const PANEL_VOLTAGE_V = 32;
export const PANEL_RESISTANCE_OHM = 4;
/** V^2 / R. */
export const PANEL_NOMINAL_W = (PANEL_VOLTAGE_V * PANEL_VOLTAGE_V) / PANEL_RESISTANCE_OHM;
/** Mars Pathfinder dust obscuration rate, 0.28-0.29 %/day (fraction per day). */
export const PATHFINDER_RATE_PER_DAY = 0.00285;
export const EDS_VOLTAGE_VPP = 1200;
export const EDS_FREQUENCY_HZ = 100;
/** Obscuration left after an EDS pulse (power back to 98 %). */
export const EDS_RESIDUAL_OBSCURATION = 0.02;
export const EDS_ENERGY_WH_PER_M2 = 0.06;
export const PANEL_AREA_M2 = 0.55;
/** Simulated time scale: one real second advances this many sols. */
export const SUIT_SOLS_PER_SECOND = 5;

/** α_dust per sol, scaled by (1 - thermal inertia). */
export function dustRatePerSol(thermalInertia: number): number {
  return PATHFINDER_RATE_PER_DAY * (1 - clamp01(thermalInertia));
}

/** P = V^2/R · (1 - obscuration), floored at 0. */
export function panelPowerW(obscuration: number): number {
  return Math.max(0, PANEL_NOMINAL_W * (1 - obscuration));
}

/**
 * Linear dust accumulation: obscuration(t) = o_clean + α·t, so P(t) = V^2/R·(1 - α·t) right after a clean panel.
 */
export class DustAccumulator {
  obscuration = 0;
  sols = 0;
  solsSinceClean = 0;
  pulses = 0;
  edsEnergyWh = 0;

  get powerW(): number {
    return panelPowerW(this.obscuration);
  }

  advance(dtSols: number, thermalInertia: number): void {
    this.obscuration = Math.min(1, this.obscuration + dustRatePerSol(thermalInertia) * dtSols);
    this.sols += dtSols;
    this.solsSinceClean += dtSols;
  }

  /** 1200 Vpp at 100 Hz: obscuration drops to 2 %. Returns the energy of this pulse in Wh. */
  pulse(): number {
    this.obscuration = Math.min(this.obscuration, EDS_RESIDUAL_OBSCURATION);
    this.solsSinceClean = 0;
    this.pulses++;
    const energy = EDS_ENERGY_WH_PER_M2 * PANEL_AREA_M2;
    this.edsEnergyWh += energy;
    return energy;
  }

  reset(): void {
    this.obscuration = 0;
    this.sols = 0;
    this.solsSinceClean = 0;
    this.pulses = 0;
    this.edsEnergyWh = 0;
  }
}

export type SuitTelemetry = {
  sols: number;
  obscurationPct: number;
  panelW: number;
  powerPct: number;
  edsEnergyWh: number;
  pulses: number;
};

const SUIT_FIELDS: readonly TelemetryField[] = [
  { key: 'sols', label: 'Elapsed', unit: 'sols', digits: 1 },
  { key: 'obscurationPct', label: 'Obscuration', unit: '%', digits: 2 },
  { key: 'panelW', label: 'Panel power', unit: 'W', digits: 1 },
  { key: 'powerPct', label: 'Power', unit: '%', digits: 1 },
  { key: 'edsEnergyWh', label: 'EDS energy', unit: 'Wh', digits: 3 },
  { key: 'pulses', label: 'EDS pulses', unit: '', digits: 0 },
];

export class SuitDustSolver implements ModeSolver {
  readonly mode: SandboxMode = 'SUIT_EDS';
  readonly group = new Group();
  readonly focus = new Vector3();
  readonly fields = SUIT_FIELDS;
  readonly note = `Time scale: 1 s = ${SUIT_SOLS_PER_SECOND} sols · EDS ${EDS_VOLTAGE_VPP} Vpp @ ${EDS_FREQUENCY_HZ} Hz · panel ${PANEL_AREA_M2} m²`;
  readonly telemetry: SuitTelemetry = { sols: 0, obscurationPct: 0, panelW: 0, powerPct: 0, edsEnergyWh: 0, pulses: 0 };
  readonly dust = new DustAccumulator();
  private readonly ctx: SolverContext;
  private readonly rig: SuitRig;
  private edsFlash = 0;

  constructor(ctx: SolverContext) {
    this.ctx = ctx;
    this.rig = buildSuit();
    this.group.name = 'mode-suit-eds';
    this.group.add(this.rig.root);
  }

  activate(): void {}

  deactivate(): void {}

  onVectorChanged(): void {
    const ground = sampleHeight(0, 0);
    this.rig.root.position.set(0, ground, 0);
    this.focus.set(0, ground + 1.3, 0);
    this.writeTelemetry();
  }

  /** EDS pulse; the engine also triggers the particle sweep. */
  pulse(): void {
    this.dust.pulse();
    this.edsFlash = 1;
    this.writeTelemetry();
  }

  update(dt: number, t: number): void {
    this.dust.advance(dt * SUIT_SOLS_PER_SECOND, this.ctx.vector[2]);
    this.edsFlash = Math.max(0, this.edsFlash - dt * 2.5);
    const o = clamp01(this.dust.obscuration);
    const rig = this.rig;
    rig.panelMaterial.uniforms.uDustObscuration.value = o;
    rig.panelMaterial.uniforms.uEdsFlash.value = this.edsFlash;
    // Joint seal abrasion: clean grey toward regolith tint.
    rig.sealMaterial.color.setRGB(0.72 - 0.17 * o, 0.74 - 0.27 * o, 0.76 - 0.4 * o);
    rig.elbow.rotation.z = -0.55 - 0.45 * Math.sin(t * 1.3);
    rig.shoulder.rotation.z = 0.15 + 0.1 * Math.sin(t * 0.65);
    this.writeTelemetry();
  }

  private writeTelemetry(): void {
    const d = this.dust;
    const t = this.telemetry;
    t.sols = d.sols;
    t.obscurationPct = d.obscuration * 100;
    t.panelW = d.powerW;
    t.powerPct = (d.powerW / PANEL_NOMINAL_W) * 100;
    t.edsEnergyWh = d.edsEnergyWh;
    t.pulses = d.pulses;
  }
}
