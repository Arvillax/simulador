import { describe, expect, it } from 'vitest';
import {
  SEARCH_DIMS,
  SearchKernel,
  TopKHeap,
  generateDataset,
  healpixLandTableEstimate,
} from './searchEngine.ts';
import { VECTOR_RANGES } from '../../bridge/sandboxDataBridge.ts';

const UNIT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [0, 1],
  [0, 1],
  [0, 1],
  [0, 1],
  [0, 1],
];

/** Reference implementation: full sort of every cell by (distance, index). */
function bruteForce(
  values: Float32Array,
  target: readonly number[],
  weights: readonly number[],
  k: number,
): Array<{ index: number; distance: number; valid: number }> {
  const cells = values.length / SEARCH_DIMS;
  const all: Array<{ index: number; distance: number; valid: number }> = [];
  for (let c = 0; c < cells; c++) {
    let num = 0;
    let den = 0;
    let valid = 0;
    for (let d = 0; d < SEARCH_DIMS; d++) {
      const x = values[c * SEARCH_DIMS + d];
      if (Number.isNaN(x)) continue;
      const [min, max] = VECTOR_RANGES[d];
      const diff = (x - target[d]) / (max - min);
      num += weights[d] * diff * diff;
      den += weights[d];
      valid++;
    }
    if (den > 0) all.push({ index: c, distance: Math.sqrt(num / den), valid });
  }
  all.sort((a, b) => a.distance - b.distance || a.index - b.index);
  return all.slice(0, k);
}

describe('generateDataset', () => {
  it('is deterministic for a seed and has about 5 % missing values inside the valid ranges', () => {
    const a = generateDataset(20_000, 42);
    const b = generateDataset(20_000, 42);
    const c = generateDataset(20_000, 43);
    expect(a.length).toBe(20_000 * SEARCH_DIMS);
    expect(new Uint32Array(a.buffer)).toEqual(new Uint32Array(b.buffer));
    expect(new Uint32Array(a.buffer)).not.toEqual(new Uint32Array(c.buffer));
    let nan = 0;
    for (let i = 0; i < a.length; i++) {
      const x = a[i];
      if (Number.isNaN(x)) {
        nan++;
        continue;
      }
      const [min, max] = VECTOR_RANGES[i % SEARCH_DIMS];
      expect(x).toBeGreaterThanOrEqual(min);
      expect(x).toBeLessThanOrEqual(max);
    }
    const fraction = nan / a.length;
    expect(fraction).toBeGreaterThan(0.04);
    expect(fraction).toBeLessThan(0.06);
  }, 30_000);
});

describe('TopKHeap', () => {
  it('keeps the K smallest entries and drains them in ascending order', () => {
    const heap = new TopKHeap(3);
    const dists = [5, 1, 4, 2, 3, 0.5];
    dists.forEach((d, i) => heap.push(d, i, 6));
    const idx = new Int32Array(3);
    const dist = new Float64Array(3);
    const aux = new Uint8Array(3);
    expect(heap.drainSorted(idx, dist, aux)).toBe(3);
    expect(Array.from(dist)).toEqual([0.5, 1, 2]);
    expect(Array.from(idx)).toEqual([5, 1, 3]);
  });

  it('breaks distance ties by the lower cell index', () => {
    const heap = new TopKHeap(2);
    heap.push(1, 9, 6);
    heap.push(1, 3, 6);
    heap.push(1, 7, 6);
    const idx = new Int32Array(2);
    heap.drainSorted(idx, new Float64Array(2), new Uint8Array(2));
    expect(Array.from(idx)).toEqual([3, 7]);
  });
});

describe('SearchKernel', () => {
  it('returns the same top-K as a brute-force sort on a dataset with missing values', () => {
    const values = generateDataset(5_000, 7);
    const target = [12, 0.6, 0.3, 0.2, 250, 0.02];
    const weights = [1, 2, 1, 0.5, 1, 1];
    const kernel = new SearchKernel(values, 50);
    const count = kernel.query(target, weights);
    const expected = bruteForce(values, target, weights, 50);
    expect(count).toBe(50);
    expect(Array.from(kernel.indices.subarray(0, count))).toEqual(expected.map((e) => e.index));
    for (let i = 0; i < count; i++) {
      expect(kernel.distances[i]).toBeCloseTo(expected[i].distance, 9);
      expect(kernel.coverage[i]).toBe(expected[i].valid);
    }
  });

  it('skips missing dimensions, reports lower coverage and excludes cells without data', () => {
    const n = Number.NaN;
    const values = new Float32Array([
      // cell 0: exact match on every dimension
      0.5, 0.5, 0.5, 0.5, 0.5, 0.5,
      // cell 1: dims 0..2 missing, the rest exact -> distance 0 with coverage 3
      n, n, n, 0.5, 0.5, 0.5,
      // cell 2: no data at all -> skipped
      n, n, n, n, n, n,
      // cell 3: off by half the range on dim 0 only
      1.0, 0.5, 0.5, 0.5, 0.5, 0.5,
    ]);
    const kernel = new SearchKernel(values, 10, UNIT_RANGES);
    const count = kernel.query([0.5, 0.5, 0.5, 0.5, 0.5, 0.5], [1, 1, 1, 1, 1, 1]);
    expect(count).toBe(3);
    expect(Array.from(kernel.indices.subarray(0, 3))).toEqual([0, 1, 3]);
    expect(Array.from(kernel.coverage.subarray(0, 3))).toEqual([6, 3, 6]);
    expect(kernel.distances[0]).toBe(0);
    expect(kernel.distances[1]).toBe(0);
    expect(kernel.distances[2]).toBeCloseTo(Math.sqrt(0.25 / 6), 6);
    expect(kernel.cellsWithGaps).toBe(2);
    expect(kernel.cellsSkipped).toBe(1);
  });

  it('returns fewer than K results when the dataset is smaller than K', () => {
    const kernel = new SearchKernel(generateDataset(10, 1, 0), 50);
    expect(kernel.query([10, 0.5, 0.5, 0.3, 200, 0.1], [1, 1, 1, 1, 1, 1])).toBe(10);
  });
});

describe('healpixLandTableEstimate', () => {
  it('sizes the HEALPix level-12 land table', () => {
    const e = healpixLandTableEstimate();
    expect(e.nside).toBe(4096);
    expect(e.npix).toBe(201_326_592);
    expect(e.landFraction).toBeCloseTo(134 / 510, 12);
    expect(e.landCells).toBe(Math.round((201_326_592 * 134) / 510));
    expect(e.valueBytes).toBe(e.landCells * SEARCH_DIMS * 4);
  });
});
