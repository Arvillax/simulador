import type { BenchState } from './types.ts';

/** Initial `window.__bench` object; the runner mutates it in place. */
export function createBenchState(): BenchState {
  return {
    status: 'idle',
    currentStep: null,
    progress: 0,
    phase: null,
    env: null,
    results: [],
    error: null,
    report: null,
  };
}
