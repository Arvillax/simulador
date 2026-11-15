import { Group, Vector3 } from 'three';
import type { Body } from '../BodyLook.ts';
import type { SandboxMode } from '../../bridge/copilotContract.ts';
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
/** NASA KSC MISSE-11 Electrodynamic Dust Shield (4 kV square wave @ 10 Hz, 2-4 W HVPS). */
export const EDS_VOLTAGE_KV = 4.0;
export const EDS_VOLTAGE_VPP = 4000;
export const EDS_FREQUENCY_HZ = 10;
export const EDS_POWER_W = 3.0;
/** Obscuration left after an EDS pulse (power back to 98 %). */
export const EDS_RESIDUAL_OBSCURATION = 0.02;
export const EDS_ENERGY_WH_PER_M2 = 0.06;
export const PANEL_AREA_M2 = 0.55;
/** Simulated time scale: one real second advances this many sols. */
export const SUIT_SOLS_PER_SECOND = 5;

const ALERT_POWER = 1;
const ALERT_SOLAR_PSR = 2;
const ALERT_SILICA = 4;
const ALERT_SALTATION = 8;

/** α_dust per sol, scaled by (1 - thermal inertia). */
export function dustRatePerSol(thermalInertia: number): number {
  return PATHFINDER_RATE_PER_DAY * (1 - clamp01(thermalInertia));
}

/** Scales dust deposition on Mars when N7 (saltation time fraction f_Q) is finite. */
export function effectiveDustRatePerSol(thermalInertia: number, body: Body, saltationFrac: number): number {
  const base = dustRatePerSol(thermalInertia);
  if (body === 'mars' && Number.isFinite(saltationFrac)) {
    return base * (1 + 2 * clamp01(saltationFrac));
  }
  return base;
}

/** Instantaneous/cycle solar availability factor from body, sunlit flag, and lunar N6 (I_sol). */
export function solarAvailabilityFactor(body: Body, sunlit: boolean, solarIllumFrac: number): number {
  if (!sunlit) return 0;
  if (body === 'moon' && Number.isFinite(solarIllumFrac)) return clamp01(solarIllumFrac);
  return 1;
}

/** Orthofabric relative abrasion index [0..1] driven by N4 (% SiO2: 6.87 GPa mafic vs 12.2 GPa quartz) + dust looseness. */
export function orthofabricWearIndex(silicaPct: number, thermalInertia: number): number {
  const loose = 1 - clamp01(thermalInertia);
  if (!Number.isFinite(silicaPct)) return clamp01(0.35 * loose);
  const quartzBias = silicaPct <= 53 ? 0.25 : silicaPct <= 65 ? 0.45 + ((silicaPct - 53) / 12) * 0.25 : 0.75 + clamp01((silicaPct - 65) / 15) * 0.25;
  return clamp01(0.75 * quartzBias + 0.25 * loose);
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

  advance(dtSols: number, thermalInertia: number, rateMultiplier = 1): void {
    this.obscuration = Math.min(1, this.obscuration + dustRatePerSol(thermalInertia) * rateMultiplier * dtSols);
    this.sols += dtSols;
    this.solsSinceClean += dtSols;
  }

  /** 4 kV at 10 Hz: obscuration drops to 2 %. Returns the energy of this pulse in Wh. */
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
  wearPct: number;
};

const SUIT_FIELDS: readonly TelemetryField[] = [
  { key: 'sols', label: 'Elapsed', unit: 'sols', digits: 1 },
  { key: 'obscurationPct', label: 'Obscuration', unit: '%', digits: 2 },
  { key: 'panelW', label: 'Panel power', unit: 'W', digits: 1 },
  { key: 'powerPct', label: 'Power', unit: '%', digits: 1 },
  { key: 'edsEnergyWh', label: 'EDS energy', unit: 'Wh', digits: 3 },
  { key: 'pulses', label: 'EDS pulses', unit: '', digits: 0 },
  { key: 'wearPct', label: 'Orthofabric wear', unit: '%', digits: 0 },
];

export class SuitDustSolver implements ModeSolver {
  readonly mode: SandboxMode = 'SUIT_EDS';
  readonly group = new Group();
  readonly focus = new Vector3();
  readonly fields = SUIT_FIELDS;
  readonly note = `Time scale: 1 s = ${SUIT_SOLS_PER_SECOND} sols · EDS ${EDS_VOLTAGE_KV} kV @ ${EDS_FREQUENCY_HZ} Hz (${EDS_POWER_W} W) · panel ${PANEL_AREA_M2} m²`;
  readonly telemetry: SuitTelemetry = {
    sols: 0,
    obscurationPct: 0,
    panelW: 0,
    powerPct: 0,
    edsEnergyWh: 0,
    pulses: 0,
    wearPct: 0,
  };
  readonly dust = new DustAccumulator();
  private readonly ctx: SolverContext;
  private readonly rig: SuitRig;
  private edsFlash = 0;
  private activeAlerts = 0;

  constructor(ctx: SolverContext) {
    this.ctx = ctx;
    this.rig = buildSuit();
    this.group.name = 'mode-suit-eds';
    this.group.add(this.rig.root);
  }

  activate(): void {
    this.activeAlerts = 0;
    this.checkAlerts();
  }

  deactivate(): void {}

  onVectorChanged(): void {
    const ground = sampleHeight(0, 0);
    this.rig.root.position.set(0, ground, 0);
    this.focus.set(0, ground + 1.3, 0);
    this.activeAlerts = 0;
    this.writeTelemetry();
    if (this.group.visible) this.checkAlerts();
  }

  /** EDS pulse; the engine also triggers the particle sweep. */
  pulse(): void {
    this.dust.pulse();
    this.edsFlash = 1;
    this.activeAlerts &= ~ALERT_POWER;
    this.writeTelemetry();
  }

  /** Resets accumulated dust, flash, and joint-seal discoloration (`RESET_DUST` action). */
  resetDust(): void {
    this.dust.reset();
    this.edsFlash = 0;
    this.activeAlerts &= ~ALERT_POWER;
    this.rig.panelMaterial.uniforms.uDustObscuration.value = 0;
    this.rig.panelMaterial.uniforms.uEdsFlash.value = 0;
    this.rig.sealMaterial.color.setRGB(0.72, 0.74, 0.76);
    this.writeTelemetry();
  }

  update(dt: number, t: number): void {
    const site = this.ctx.site;
    const rateMult = site.body === 'mars' && Number.isFinite(site.saltationTimeFrac) ? 1 + 2 * clamp01(site.saltationTimeFrac) : 1;
    this.dust.advance(dt * SUIT_SOLS_PER_SECOND, this.ctx.vector[2], rateMult);
    this.edsFlash = Math.max(0, this.edsFlash - dt * 2.5);
    const o = clamp01(this.dust.obscuration);
    const rig = this.rig;
    rig.panelMaterial.uniforms.uDustObscuration.value = o;
    rig.panelMaterial.uniforms.uEdsFlash.value = this.edsFlash;
    // Joint seal abrasion: clean grey toward regolith tint, amplified by felsic quartz abrasion when N4 is present.
    const wearBoost = orthofabricWearIndex(site.silicaPct, this.ctx.vector[2]) * 0.25;
    const stain = clamp01(o + wearBoost * Math.min(1, this.dust.sols / 20));
    rig.sealMaterial.color.setRGB(0.72 - 0.17 * stain, 0.74 - 0.27 * stain, 0.76 - 0.4 * stain);
    rig.elbow.rotation.z = -0.55 - 0.45 * Math.sin(t * 1.3);
    rig.shoulder.rotation.z = 0.15 + 0.1 * Math.sin(t * 0.65);
    this.writeTelemetry();
    if (this.group.visible) this.checkAlerts();
  }

  private writeTelemetry(): void {
    const d = this.dust;
    const site = this.ctx.site;
    const t = this.telemetry;
    const avail = solarAvailabilityFactor(site.body, site.sunlit, site.solarIllumFrac);
    t.sols = d.sols;
    t.obscurationPct = d.obscuration * 100;
    t.panelW = d.powerW * avail;
    t.powerPct = (t.panelW / PANEL_NOMINAL_W) * 100;
    t.edsEnergyWh = d.edsEnergyWh;
    t.pulses = d.pulses;
    t.wearPct = orthofabricWearIndex(site.silicaPct, this.ctx.vector[2]) * 100;
  }

  private checkAlerts(): void {
    if (!this.group.visible) return;
    const site = this.ctx.site;
    const dfEff = 1 - clamp01(this.dust.obscuration);

    if (dfEff <= 0.25) {
      if ((this.activeAlerts & ALERT_POWER) === 0) {
        this.activeAlerts |= ALERT_POWER;
        this.ctx.emitAlert({
          code: 'SUIT_POWER_CRITICAL',
          mode: 'SUIT_EDS',
          body: site.body,
          severity: 'red',
          message: `Dust transmittance DF_eff=${dfEff.toFixed(2)} <= 0.25: solar mission-end threshold reached.`,
          metric: 'df_eff',
          value: dfEff,
          threshold: 0.25,
          suggestedAction: 'PULSE_EDS',
        });
      }
    } else {
      this.activeAlerts &= ~ALERT_POWER;
    }

    if (site.body === 'moon' && (!site.sunlit || (Number.isFinite(site.solarIllumFrac) && site.solarIllumFrac < 0.15))) {
      if ((this.activeAlerts & ALERT_SOLAR_PSR) === 0) {
        this.activeAlerts |= ALERT_SOLAR_PSR;
        const illum = site.sunlit ? site.solarIllumFrac : 0;
        this.ctx.emitAlert({
          code: 'SUIT_SOLAR_DEFICIT_PSR',
          mode: 'SUIT_EDS',
          body: site.body,
          severity: 'red',
          message: `Lunar solar deficit (I_sol=${Number.isFinite(illum) ? illum.toFixed(2) : '0.00'} < 0.15): sustained EDS requires battery power.`,
          metric: 'n6_solar_illum_frac',
          value: Number.isFinite(illum) ? illum : 0,
          threshold: 0.15,
        });
      }
    } else {
      this.activeAlerts &= ~ALERT_SOLAR_PSR;
    }

    if (Number.isFinite(site.silicaPct) && site.silicaPct > 53) {
      if ((this.activeAlerts & ALERT_SILICA) === 0) {
        this.activeAlerts |= ALERT_SILICA;
        const felsic = site.silicaPct > 65;
        this.ctx.emitAlert({
          code: 'SUIT_SILICA_ABRASION',
          mode: 'SUIT_EDS',
          body: site.body,
          severity: felsic ? 'red' : 'yellow',
          message: `Lithology ${site.silicaPct.toFixed(1)}% SiO2 increases Orthofabric and rotary-seal abrasion (${felsic ? 'felsic/quartz 12.2 GPa' : 'intermediate'}).`,
          metric: 'n4_silica_pct',
          value: site.silicaPct,
          threshold: felsic ? 65 : 53,
        });
      }
    } else {
      this.activeAlerts &= ~ALERT_SILICA;
    }

    if (site.body === 'mars' && Number.isFinite(site.saltationTimeFrac) && site.saltationTimeFrac >= 0.25) {
      if ((this.activeAlerts & ALERT_SALTATION) === 0) {
        this.activeAlerts |= ALERT_SALTATION;
        const severe = site.saltationTimeFrac > 0.5;
        this.ctx.emitAlert({
          code: 'SUIT_MARS_SALTATION',
          mode: 'SUIT_EDS',
          body: site.body,
          severity: severe ? 'red' : 'yellow',
          message: `Mars saltation f_Q=${site.saltationTimeFrac.toFixed(2)} accelerates dust fouling and suit abrasion.`,
          metric: 'n7_saltation_frac',
          value: site.saltationTimeFrac,
          threshold: severe ? 0.5 : 0.25,
          suggestedAction: 'PULSE_EDS',
        });
      }
    } else {
      this.activeAlerts &= ~ALERT_SALTATION;
    }
  }
}
