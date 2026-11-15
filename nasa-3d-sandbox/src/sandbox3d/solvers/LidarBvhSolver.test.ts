import { describe, expect, it } from 'vitest';
import { classifyLidarHit, lidarLimitsForProfile } from './LidarBvhSolver.ts';

describe('LidarBvhSolver ALHAT / CLPS hazard thresholds', () => {
  it('enforces strict ALHAT rejection at >= 5 deg while CLPS tolerates 5..9.9 deg as CAUTION', () => {
    const alhat = lidarLimitsForProfile('ALHAT');
    const clps = lidarLimitsForProfile('CLPS');

    expect(classifyLidarHit(4.9, false, false, false, alhat.redMinDeg, alhat.greenMaxDeg)).toBe('SAFE');
    expect(classifyLidarHit(5.0, false, false, false, alhat.redMinDeg, alhat.greenMaxDeg)).toBe('HAZARD');

    expect(classifyLidarHit(4.9, false, false, false, clps.redMinDeg, clps.greenMaxDeg)).toBe('SAFE');
    expect(classifyLidarHit(6.5, false, false, false, clps.redMinDeg, clps.greenMaxDeg)).toBe('CAUTION');
    expect(classifyLidarHit(10.0, false, false, false, clps.redMinDeg, clps.greenMaxDeg)).toBe('HAZARD');
  });

  it('gives rocks >= hazard threshold priority over safe/caution slopes', () => {
    expect(classifyLidarHit(1.0, true, false, false, 5, 5, false)).toBe('HAZARD');
    expect(classifyLidarHit(1.0, false, false, false, 5, 5, true)).toBe('CAUTION');
  });
});
