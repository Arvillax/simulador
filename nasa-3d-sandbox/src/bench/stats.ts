/**
 * Small statistics helpers shared by the benchmark. Pure (no DOM), unit-testable.
 * Percentiles use the nearest-rank definition on an ascending array.
 */

/** Fixed-capacity sample buffer. `push` never allocates; samples past capacity are counted and dropped. */
export class SampleBuffer {
  readonly capacity: number;
  private readonly buf: Float64Array;
  private size = 0;
  private dropped = 0;

  constructor(capacity: number) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this.buf = new Float64Array(this.capacity);
  }

  get count(): number {
    return this.size;
  }

  get droppedCount(): number {
    return this.dropped;
  }

  push(value: number): void {
    if (this.size < this.capacity) {
      this.buf[this.size++] = value;
    } else {
      this.dropped++;
    }
  }

  reset(): void {
    this.size = 0;
    this.dropped = 0;
  }

  /** View over the valid samples (no copy). */
  view(): Float64Array {
    return this.buf.subarray(0, this.size);
  }
}

/** Nearest-rank percentile of an ascending array; NaN when empty. */
export function percentile(sortedAsc: ArrayLike<number>, p: number): number {
  const n = sortedAsc.length;
  if (n === 0) return Number.NaN;
  const rank = Math.ceil((p / 100) * n);
  const i = rank <= 0 ? 0 : rank > n ? n - 1 : rank - 1;
  return sortedAsc[i];
}

export function sortedCopy(values: ArrayLike<number>): Float64Array {
  const out = Float64Array.from(values);
  out.sort();
  return out;
}

export function mean(values: ArrayLike<number>): number {
  const n = values.length;
  if (n === 0) return Number.NaN;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += values[i];
  return sum / n;
}

export interface Distribution {
  n: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export function distribution(values: ArrayLike<number>): Distribution {
  const sorted = sortedCopy(values);
  const n = sorted.length;
  return {
    n,
    mean: mean(sorted),
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: n > 0 ? sorted[n - 1] : Number.NaN,
  };
}

/** Rounds for display / JSON output; keeps null and non-finite values as null. */
export function round(value: number | null | undefined, digits = 2): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
