import './style.css';
import { mountSandbox } from './mountSandbox.ts';
import type { SandboxMountHandle } from './mountSandbox.ts';
import { BenchPanel } from './bench/BenchPanel.ts';
import { createBenchState } from './bench/state.ts';
import type { BenchOptions, BenchReport, BenchState } from './bench/types.ts';

export { mountSandbox };
export type { MountSandboxOptions, SandboxMountHandle } from './mountSandbox.ts';

/** Handle exposed for the benchmark harness and for manual inspection from the console. */
export type SandboxHandle = SandboxMountHandle;

declare global {
  interface Window {
    __sandbox?: SandboxHandle;
    __bench?: BenchState;
    __runBench?: (opts?: BenchOptions) => Promise<BenchReport>;
    __mountSandbox?: typeof mountSandbox;
  }
}

function requireElement<T extends HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (node === null) throw new Error(`Missing element ${selector}`);
  return node;
}

const app = requireElement<HTMLElement>('#app');
const handle = mountSandbox(app);

window.__sandbox = handle;
window.__mountSandbox = mountSandbox;

// ------------------------------------------------------------------ Benchmark (standalone only; omitted in ?embed=1)
if (!handle.embed) {
  const { engine, bridge, presets, startup } = handle;
  const benchState = createBenchState();
  window.__bench = benchState;
  const benchPanel = new BenchPanel(app, () => {
    runBenchmark().catch(() => undefined);
  });

  async function runBenchmark(opts?: BenchOptions): Promise<BenchReport> {
    if (benchState.status === 'running') throw new Error('Benchmark already running');
    benchPanel.setRunning(true);
    benchPanel.setStatus('Loading benchmark…');
    try {
      const { runBench } = await import('./bench/BenchRunner.ts');
      const report = await runBench({ engine, bridge, presets, startup }, benchState, opts, {
        onProgress: (state, stepLabel, loadLabels) => benchPanel.progress(state, stepLabel, loadLabels),
      });
      benchPanel.showResults(report);
      return report;
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (benchState.status !== 'error') {
        benchState.status = 'error';
        benchState.error = text;
      }
      benchPanel.showError(text);
      throw error;
    } finally {
      benchPanel.setRunning(false);
    }
  }

  window.__runBench = runBenchmark;

  if (new URLSearchParams(window.location.search).get('bench') === '1') {
    // Let the page settle (first frames, deferred shader linking) before the run starts.
    window.setTimeout(() => {
      runBenchmark().catch(() => undefined);
    }, 1000);
  }
}
