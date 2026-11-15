declare module 'fast-2d-poisson-disk-sampling' {
  export interface FastPoissonDiskSamplingOptions {
    /** Size of the sampled rectangle [width, height]. */
    shape: [number, number];
    /** Minimum distance between points. Fixed at construction time. */
    radius?: number;
    minDistance?: number;
    /** Attempts per active point (default 30). */
    tries?: number;
  }

  export default class FastPoissonDiskSampling {
    constructor(options: FastPoissonDiskSamplingOptions, rng?: (() => number) | null);
    readonly radius: number;
    /** Fills the whole area and returns every sample point as [x, y]. */
    fill(): number[][];
    next(): number[] | null;
    addRandomPoint(): number[];
    addPoint(point: number[]): number[] | null;
    getAllPoints(): number[][];
    /** Clears the cache grid and the sample list (the grid buffer is reused). */
    reset(): void;
  }
}
