import { describe, expect, it } from 'vitest';
import {
  COPILOT_COMMAND_EVENT,
  SIMULATION_CONTROL_EVENT,
  albedoFromSilicaPct,
  applyWhatIfToSiteState,
  computeThermalFineness,
  createSitePhysicsState,
  mapAnalogN1N7ToSandbox6D,
  parsePostMessageControl,
  resolveTargetBody,
} from './copilotContract.ts';

describe('copilotContract N1..N7 translation', () => {
  it('maps a lunar PSR N1..N7 cell accurately, suppresses NDVI leakage, and detects PSR sunlit=false', () => {
    const out6 = new Float32Array(6);
    const site = createSitePhysicsState();
    mapAnalogN1N7ToSandbox6D(
      {
        n1ToN7: [4.2, 0.04, 0.15, 45.6, 12.0, 0.0, Number.NaN],
        surfaceTempK: 48,
        ndvi: 0.45,
        targetBody: 'MOON',
      },
      out6,
      site,
    );

    expect(site.body).toBe('moon');
    expect(site.roverProfile).toBe('VIPER');
    expect(site.lidarProfile).toBe('ALHAT');
    expect(site.sunlit).toBe(false);
    expect(site.missingVars).toEqual([]);
    expect(out6[0]).toBeCloseTo(4.2, 5);
    expect(out6[3]).toBeCloseTo(albedoFromSilicaPct(45.6), 5);
    expect(out6[4]).toBe(48);
    expect(out6[5]).toBe(0); // NDVI zeroed off Earth per ADR-003
  });

  it('tracks missing/NaN inputs in missingVars and does not fake permafrost when surfaceTempK is null', () => {
    const out6 = new Float32Array(6);
    const site = createSitePhysicsState();
    mapAnalogN1N7ToSandbox6D(
      {
        n1SlopeDeg: 22,
        n2RoughnessRmsM: Number.NaN,
        n3ReliefM: 0.35,
        n4SilicaPct: 68,
        n5DiurnalTempK: 34,
        n6SolarIllumFrac: 0.8,
        n7SaltationTimeFrac: null,
        surfaceTempK: null,
        targetBody: 'MARS',
      },
      out6,
      site,
    );

    expect(site.body).toBe('mars');
    expect(site.roverProfile).toBe('PERSEVERANCE');
    expect(site.lidarProfile).toBe('M2020');
    // N6 is lunar-only and must not be reported missing on Mars; N2, N7, and surfaceTempK are missing.
    expect(site.missingVars).toEqual(['N2', 'N7', 'surfaceTempK']);
    expect(out6[4]).toBeGreaterThanOrEqual(265);
  });

  it('computes thermal fineness from manifest percentiles rather than fixed cutoffs', () => {
    // Mauna Kea (~25 K) stays moderate inside [8, 45] K instead of collapsing to binary step
    const mid = computeThermalFineness(25, { p1: 8, p50: 24, p99: 45 });
    expect(mid).toBeGreaterThan(0.4);
    expect(mid).toBeLessThan(0.5);
  });

  it('supports what-if N1..N7 overrides cleanly without leaving variable in missingVars', () => {
    const out6 = new Float32Array(6);
    const site = createSitePhysicsState();
    mapAnalogN1N7ToSandbox6D(
      { n1SlopeDeg: 10, n2RoughnessRmsM: 0.05, n3ReliefM: 0.2, n4SilicaPct: 50, n5DiurnalTempK: 20, targetBody: 'MOON' },
      out6,
      site,
    );
    expect(site.missingVars).toContain('N6');

    const applied = applyWhatIfToSiteState({ variable: 'N6', newValue: 0 }, out6, site);
    expect(applied).toBe(true);
    expect(site.solarIllumFrac).toBe(0);
    expect(site.sunlit).toBe(false);
    expect(site.missingVars).not.toContain('N6');
  });

  it('normalizes Mars gravities 3.71 and 3.72 identically when body is not supplied', () => {
    expect(resolveTargetBody(undefined, 3.72, 'earth')).toBe('mars');
    expect(resolveTargetBody(undefined, 3.71, 'earth')).toBe('mars');
    expect(resolveTargetBody('MARS', 9.81, 'earth')).toBe('mars');
  });

  it('parses only structured postMessage control envelopes', () => {
    expect(parsePostMessageControl({ type: SIMULATION_CONTROL_EVENT, detail: { mode: 'ROVER' } })).toEqual({
      mode: 'ROVER',
    });
    expect(parsePostMessageControl({ type: COPILOT_COMMAND_EVENT, detail: { action: 'PULSE_EDS' } })).toEqual({
      action: 'PULSE_EDS',
    });
    expect(parsePostMessageControl({ type: 'other', detail: { mode: 'ROVER' } })).toBeNull();
    expect(parsePostMessageControl(null)).toBeNull();
  });
});
