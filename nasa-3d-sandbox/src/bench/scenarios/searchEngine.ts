import { VECTOR_RANGES } from '../../bridge/sandboxDataBridge.ts';
import { mulberry32 } from '../prng.ts';

/**
 * SIMULATED similarity search kernel (stand-in for the planned Rust/Wasm engine). Pure, no DOM; shared by the
 * main-thread load and the Web Worker. A cell is a row of SEARCH_DIMS float32 values; NaN means missing data.
 */

export const SEARCH_DIMS = 6;
export const DEFAULT_TOP_K = 50;
export const DEFAULT_NAN_FRACTION = 0.05;

export type Ranges = ReadonlyArray<readonly [number, number]>;

/** Deterministic synthetic dataset: Float32Array(cells × SEARCH_DIMS), values inside `ranges`, ~nanFraction NaN. */
export function generateDataset(
  cells: number,
  seed: number,
  nanFraction = DEFAULT_NAN_FRACTION,
  ranges: Ranges = VECTOR_RANGES,
): Float32Array {
  const out = new Float32Array(cells * SEARCH_DIMS);
  const rand = mulberry32(seed);
  const mins = new Float64Array(SEARCH_DIMS);
  const spans = new Float64Array(SEARCH_DIMS);
  for (let d = 0; d < SEARCH_DIMS; d++) {
    const span = ranges[d][1] - ranges[d][0];
    // Slightly inside the range so float32 rounding never leaves it.
    mins[d] = ranges[d][0] + span * 1e-6;
    spans[d] = span * (1 - 2e-6);
  }
  for (let i = 0; i < out.length; i++) {
    const d = i % SEARCH_DIMS;
    const missing = rand() < nanFraction;
    const u = rand();
    out[i] = missing ? Number.NaN : mins[d] + u * spans[d];
  }
  return out;
}

/** Fixed-size max-heap that keeps the K best (smallest distance, then lowest index) entries. No allocation. */
export class TopKHeap {
  readonly capacity: number;
  private readonly dist: Float64Array;
  private readonly idx: Int32Array;
  private readonly aux: Uint8Array;
  private size = 0;

  constructor(capacity: number) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this.dist = new Float64Array(this.capacity);
    this.idx = new Int32Array(this.capacity);
    this.aux = new Uint8Array(this.capacity);
  }

  get count(): number {
    return this.size;
  }

  reset(): void {
    this.size = 0;
  }

  /** True when entry a ranks worse than entry b. */
  private worse(da: number, ia: number, db: number, ib: number): boolean {
    return da > db || (da === db && ia > ib);
  }

  push(distance: number, index: number, auxValue: number): void {
    const dist = this.dist;
    const idx = this.idx;
    const aux = this.aux;
    if (this.size < this.capacity) {
      let i = this.size++;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (!this.worse(distance, index, dist[p], idx[p])) break;
        dist[i] = dist[p];
        idx[i] = idx[p];
        aux[i] = aux[p];
        i = p;
      }
      dist[i] = distance;
      idx[i] = index;
      aux[i] = auxValue;
      return;
    }
    if (!this.worse(dist[0], idx[0], distance, index)) return;
    this.siftDown(distance, index, auxValue, this.size);
  }

  /** Places (d, i, a) at the root and sifts it down within the first `n` entries. */
  private siftDown(d: number, ix: number, a: number, n: number): void {
    const dist = this.dist;
    const idx = this.idx;
    const aux = this.aux;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      if (l >= n) break;
      const r = l + 1;
      let c = l;
      if (r < n && this.worse(dist[r], idx[r], dist[l], idx[l])) c = r;
      if (!this.worse(dist[c], idx[c], d, ix)) break;
      dist[i] = dist[c];
      idx[i] = idx[c];
      aux[i] = aux[c];
      i = c;
    }
    dist[i] = d;
    idx[i] = ix;
    aux[i] = a;
  }

  /** Writes the entries in ascending order into the outputs and empties the heap. Returns the count. */
  drainSorted(outIdx: Int32Array, outDist: Float64Array, outAux: Uint8Array): number {
    const n = this.size;
    for (let end = n - 1; end >= 0; end--) {
      outIdx[end] = this.idx[0];
      outDist[end] = this.dist[0];
      outAux[end] = this.aux[0];
      if (end > 0) this.siftDown(this.dist[end], this.idx[end], this.aux[end], end);
    }
    this.size = 0;
    return n;
  }
}

/**
 * Weighted, range-normalised Euclidean distance over the non-missing dimensions, followed by a top-K selection.
 * distance = sqrt( Σ w_d ((x_d − q_d) / range_d)² / Σ w_d ), sums over dimensions where x_d is not NaN.
 * Cells with no comparable dimension are skipped. Result buffers are reused across queries.
 */
export class SearchKernel {
  readonly cells: number;
  readonly k: number;
  readonly indices: Int32Array;
  readonly distances: Float64Array;
  /** Number of compared (non-missing) dimensions per result. */
  readonly coverage: Uint8Array;
  /** Last query: cells with at least one missing dimension. */
  cellsWithGaps = 0;
  /** Last query: cells skipped because no dimension could be compared. */
  cellsSkipped = 0;
  private readonly values: Float32Array;
  private readonly heap: TopKHeap;
  private readonly invRange2: Float64Array;

  constructor(values: Float32Array, k = DEFAULT_TOP_K, ranges: Ranges = VECTOR_RANGES) {
    this.values = values;
    this.cells = Math.floor(values.length / SEARCH_DIMS);
    this.k = k;
    this.heap = new TopKHeap(k);
    this.indices = new Int32Array(k);
    this.distances = new Float64Array(k);
    this.coverage = new Uint8Array(k);
    this.invRange2 = new Float64Array(SEARCH_DIMS);
    for (let d = 0; d < SEARCH_DIMS; d++) {
      const span = ranges[d][1] - ranges[d][0];
      this.invRange2[d] = 1 / (span * span);
    }
  }

  /** Runs one query; results are in indices/distances/coverage[0..count). Returns count. */
  query(target: ArrayLike<number>, weights: ArrayLike<number>): number {
    const v = this.values;
    const heap = this.heap;
    const q0 = target[0], q1 = target[1], q2 = target[2], q3 = target[3], q4 = target[4], q5 = target[5];
    const w0 = weights[0], w1 = weights[1], w2 = weights[2], w3 = weights[3], w4 = weights[4], w5 = weights[5];
    const r = this.invRange2;
    const a0 = w0 * r[0], a1 = w1 * r[1], a2 = w2 * r[2], a3 = w3 * r[3], a4 = w4 * r[4], a5 = w5 * r[5];
    let gaps = 0;
    let skipped = 0;
    heap.reset();
    for (let c = 0, o = 0; c < this.cells; c++, o += SEARCH_DIMS) {
      let num = 0;
      let den = 0;
      let valid = 0;
      let x = v[o];
      if (x === x) { const e = x - q0; num += a0 * e * e; den += w0; valid++; }
      x = v[o + 1];
      if (x === x) { const e = x - q1; num += a1 * e * e; den += w1; valid++; }
      x = v[o + 2];
      if (x === x) { const e = x - q2; num += a2 * e * e; den += w2; valid++; }
      x = v[o + 3];
      if (x === x) { const e = x - q3; num += a3 * e * e; den += w3; valid++; }
      x = v[o + 4];
      if (x === x) { const e = x - q4; num += a4 * e * e; den += w4; valid++; }
      x = v[o + 5];
      if (x === x) { const e = x - q5; num += a5 * e * e; den += w5; valid++; }
      if (valid < SEARCH_DIMS) gaps++;
      if (!(den > 0)) {
        skipped++;
        continue;
      }
      heap.push(Math.sqrt(num / den), c, valid);
    }
    this.cellsWithGaps = gaps;
    this.cellsSkipped = skipped;
    return heap.drainSorted(this.indices, this.distances, this.coverage);
  }
}

export interface HealpixLandEstimate {
  level: number;
  nside: number;
  npix: number;
  landFraction: number;
  landCells: number;
  /** Bytes for SEARCH_DIMS float32 columns. */
  valueBytes: number;
  /** Bytes when a uint64 HEALPix index is stored next to the values. */
  valueAndIndexBytes: number;
}

/** Size of the full HEALPix land table (computed, not run). Land without Antarctica ≈ 134 of 510 million km². */
export function healpixLandTableEstimate(level = 12, landKm2 = 134e6, earthKm2 = 510e6): HealpixLandEstimate {
  const nside = 2 ** level;
  const npix = 12 * nside * nside;
  const landFraction = landKm2 / earthKm2;
  const landCells = Math.round(npix * landFraction);
  return {
    level,
    nside,
    npix,
    landFraction,
    landCells,
    valueBytes: landCells * SEARCH_DIMS * 4,
    valueAndIndexBytes: landCells * (SEARCH_DIMS * 4 + 8),
  };
}

/** Messages between searchLoad.ts and searchWorker.ts. */
export interface SearchInitMessage {
  type: 'init';
  cells: number;
  seed: number;
  nanFraction: number;
  k: number;
}

export interface SearchQueryMessage {
  type: 'query';
  id: number;
  target: number[];
  weights: number[];
}

export type SearchWorkerRequest = SearchInitMessage | SearchQueryMessage;

export interface SearchReadyMessage {
  type: 'ready';
  genMs: number;
  bytes: number;
}

export interface SearchResultMessage {
  type: 'result';
  id: number;
  computeMs: number;
  count: number;
  top: Int32Array;
}

export interface SearchErrorMessage {
  type: 'error';
  message: string;
}

export type SearchWorkerResponse = SearchReadyMessage | SearchResultMessage | SearchErrorMessage;
