import { describe, expect, it } from 'vitest';
import { METRICS_DIMENSIONS, buildMetricsJson } from './metricsGenerator.ts';
import type { MetricsFile } from './metricsGenerator.ts';

describe('buildMetricsJson', () => {
  for (const mb of [0.5, 2, 8]) {
    it(`hits a ${mb} MB target within ±10 %`, () => {
      const target = mb * 1_000_000;
      const out = buildMetricsJson(target, 3);
      expect(out.bytes).toBe(out.json.length);
      expect(new TextEncoder().encode(out.json).length).toBe(out.bytes);
      expect(Math.abs(out.bytes - target) / target).toBeLessThanOrEqual(0.1);
    });
  }

  it('follows the metrics.json contract shape (ADR-007): 9 Moon + 12 Mars targets with per-dimension detail', () => {
    const out = buildMetricsJson(300_000, 5);
    const file = JSON.parse(out.json) as MetricsFile;
    expect(file.contract.simulated).toBe(true);
    expect(file.contract.healpix_level).toBe(12);
    expect(file.dimensions.map((d) => d.id)).toEqual(METRICS_DIMENSIONS.map((d) => d.id));
    expect(file.targets.filter((t) => t.body === 'moon')).toHaveLength(9);
    expect(file.targets.filter((t) => t.body === 'mars')).toHaveLength(12);
    expect(Array.isArray(file.limits)).toBe(true);
    let analogs = 0;
    for (const t of file.targets) {
      expect(t.analogs.length).toBeGreaterThan(0);
      for (const a of t.analogs) {
        analogs++;
        for (const d of METRICS_DIMENSIONS) {
          const cell = a.dims[d.id];
          expect(cell).toBeDefined();
          expect(['match', 'differs', 'no_data']).toContain(cell.label);
          expect(cell.source.column).toBe(d.id);
          if (cell.label === 'no_data') {
            expect(cell.value).toBeNull();
            expect(cell.diff).toBeNull();
          } else {
            expect(typeof cell.value).toBe('number');
            expect(typeof cell.diff).toBe('number');
          }
        }
        expect(a.coverage.compared + a.coverage.missing.length).toBe(METRICS_DIMENSIONS.length);
      }
    }
    expect(analogs).toBe(out.analogs);
    expect(out.targets).toBe(21);
  });

  it('is deterministic for a seed', () => {
    expect(buildMetricsJson(100_000, 9).json).toBe(buildMetricsJson(100_000, 9).json);
    expect(buildMetricsJson(100_000, 9).json).not.toBe(buildMetricsJson(100_000, 10).json);
  });
});
