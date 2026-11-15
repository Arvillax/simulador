import './style.css';
import * as bridge from './bridge/sandboxDataBridge.ts';
import { SandboxEngine } from './sandbox3d/SandboxEngine.ts';
import { FpsMeter } from './sandbox3d/FpsMeter.ts';
import { parseQualityParam } from './sandbox3d/QualityGovernor.ts';
import { loadOptionalGlb } from './sandbox3d/AssetBuilder.ts';
import { SIMULATED_PRESETS, TelemetryHUD } from './sandbox3d/TelemetryHUD.ts';
import { BenchPanel } from './bench/BenchPanel.ts';
import { createBenchState } from './bench/state.ts';
import type { BenchOptions, BenchReport, BenchState, StartupTimings } from './bench/types.ts';

const moduleStartAtMs = performance.now();

/** Handle exposed for the benchmark harness and for manual inspection from the console. */
export interface SandboxHandle {
  readonly engine: SandboxEngine;
  readonly bridge: typeof bridge;
  readonly fps: FpsMeter;
  readonly hud: TelemetryHUD;
  readonly presets: typeof SIMULATED_PRESETS;
  /** Optional glTF loader (lazy chunks: GLTFLoader + MeshoptDecoder + KTX2Loader). Not called by default. */
  readonly loadOptionalGlb: typeof loadOptionalGlb;
  /** Startup timings (engine construction, start, first frame). */
  readonly startup: StartupTimings;
}

declare global {
  interface Window {
    __sandbox?: SandboxHandle;
    __bench?: BenchState;
    __runBench?: (opts?: BenchOptions) => Promise<BenchReport>;
  }
}

function requireElement<T extends HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (node === null) throw new Error(`Missing element ${selector}`);
  return node;
}

const canvas = requireElement<HTMLCanvasElement>('#sandbox-canvas');
const engineConstruct0 = performance.now();
// The renderer follows the size of the canvas container (#viewport), not the window.
const engine = new SandboxEngine(canvas, { container: requireElement<HTMLElement>('#viewport') });
const engineConstructMs = performance.now() - engineConstruct0;
bridge.registerSandbox(engine);

// ?quality=auto (default) lets the governor step the level; ?quality=0..6 fixes it.
const qualityParam = parseQualityParam(new URLSearchParams(window.location.search).get('quality'));
if (qualityParam === 'auto') {
  engine.quality.setAuto(true);
} else if (qualityParam !== null) {
  engine.quality.setAuto(false);
  engine.quality.setLevel(qualityParam);
}

const fps = new FpsMeter(requireElement<HTMLElement>('#fps-box'));
engine.setFpsMeter(fps);

const hud = new TelemetryHUD(requireElement<HTMLElement>('#hud'), engine);
engine.addFrameListener(hud.frameListener);

// First simulated preset; start() runs the pending synthesis synchronously, then precompiles all shaders.
hud.applyPreset(0);
const engineStart0 = performance.now();
engine.start();
const engineStartMs = performance.now() - engineStart0;
const startSynthMs = engine.synthTimings.totalMs;

const startup: StartupTimings = {
  moduleStartAtMs,
  engineConstructMs,
  engineStartMs,
  startSynthMs,
  compileApproxMs: Math.max(0, engineStartMs - startSynthMs),
  firstFrameAtMs: null,
  firstFrameCpuMs: null,
};

// One-shot listener, registered last so that removing it never skips another listener.
const firstFrameListener = (): void => {
  if (startup.firstFrameAtMs !== null) return;
  startup.firstFrameAtMs = performance.now();
  startup.firstFrameCpuMs = engine.timings.cpuMs;
  window.setTimeout(() => engine.removeFrameListener(firstFrameListener), 0);
};
engine.addFrameListener(firstFrameListener);

window.__sandbox = { engine, bridge, fps, hud, presets: SIMULATED_PRESETS, loadOptionalGlb, startup };

// ------------------------------------------------------------------ Benchmark (runner is a lazy chunk)
const benchState = createBenchState();
window.__bench = benchState;
const benchPanel = new BenchPanel(requireElement<HTMLElement>('#app'), () => {
  runBenchmark().catch(() => undefined);
});

async function runBenchmark(opts?: BenchOptions): Promise<BenchReport> {
  if (benchState.status === 'running') throw new Error('Benchmark already running');
  benchPanel.setRunning(true);
  benchPanel.setStatus('Loading benchmark…');
  try {
    const { runBench } = await import('./bench/BenchRunner.ts');
    const report = await runBench({ engine, bridge, presets: SIMULATED_PRESETS, startup }, benchState, opts, {
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
