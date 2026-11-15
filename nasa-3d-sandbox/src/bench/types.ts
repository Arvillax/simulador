import type * as bridgeModule from '../bridge/sandboxDataBridge.ts';
import type { SandboxEngine, SandboxMode } from '../sandbox3d/SandboxEngine.ts';
import type { SimulatedPreset } from '../sandbox3d/TelemetryHUD.ts';
import type { FrameSummary } from './FrameRecorder.ts';
import type { LongTaskReport } from './LongTaskProbe.ts';

/** Startup timings captured in main.ts (ms). */
export interface StartupTimings {
  /** performance.now() when main.ts started evaluating (since navigation start). */
  moduleStartAtMs: number;
  engineConstructMs: number;
  /** engine.start(): pending synthesis + renderer.compile of all mode scenes + setMode. */
  engineStartMs: number;
  /** Synthesis part of engine.start() (synthTimings.totalMs right after start). */
  startSynthMs: number;
  /** engineStartMs − startSynthMs; approximation of renderer.compile. */
  compileApproxMs: number;
  /** performance.now() at the end of the first frame callback (since navigation start); null until it runs. */
  firstFrameAtMs: number | null;
  /** CPU time of the first frame callback (may include deferred shader linking). */
  firstFrameCpuMs: number | null;
}

/** What the benchmark needs from the page. */
export interface BenchHost {
  readonly engine: SandboxEngine;
  readonly bridge: typeof bridgeModule;
  readonly presets: readonly SimulatedPreset[];
  readonly startup: StartupTimings | null;
}

export interface BenchOptions {
  /** Step IDs to run (default: all). Also `?steps=S01,S03`. */
  steps?: string[];
  /** Warm-up per step (ms). Also `?warmup=`. Default 1500. */
  warmupMs?: number;
  /** Measured window per step (ms). Also `?measure=`. Default 5000. */
  measureMs?: number;
  /** Wait after teardown (ms). Also `?teardown=`. Default 500. */
  teardownMs?: number;
  /** Quality ladder level (0..6) forced for the whole run. Also `?level=`. Default: the governor's own level. */
  level?: number;
}

export interface BenchConfig {
  steps: string[];
  warmupMs: number;
  measureMs: number;
  teardownMs: number;
  /** Forced quality level, or null when the governor calibrated it. */
  level: number | null;
}

export interface WebGlInfo {
  version: string | null;
  renderer: string | null;
  vendor: string | null;
  /** True when renderer/vendor came from WEBGL_debug_renderer_info. */
  unmasked: boolean;
}

export interface BenchEnvironment {
  capturedAt: string;
  build: 'dev' | 'production';
  userAgent: string;
  hardwareConcurrency: number | null;
  deviceMemoryGB: number | null;
  devicePixelRatio: number;
  effectivePixelRatio: number;
  /** Quality ladder level pinned for the run (0 = best .. 6), so scenarios stay comparable. */
  qualityLevel: number;
  /** Render scale of that level after the device cap (drawing-buffer pixels per CSS pixel). */
  renderScale: number;
  /** Shadow map side of that level in texels; 0 = shadows off. */
  shadowMapSize: number;
  viewportCss: { width: number; height: number };
  canvasCss: { width: number; height: number };
  drawingBuffer: { width: number; height: number };
  webgl: WebGlInfo;
  gpuTimerAvailable: boolean;
  /** 1000 / median rAF delta over ~1 s with the sandbox paused. */
  estimatedRefreshHz: number | null;
  medianRafMs: number | null;
  longTaskSupported: boolean;
  loafSupported: boolean;
  performanceMemory: boolean;
  crossOriginIsolated: boolean;
  startup: StartupTimings | null;
}

export interface GpuSummary {
  samples: number;
  meanMs: number | null;
  p95Ms: number | null;
  /** Queries discarded because the GPU reported a disjoint event. */
  disjointDiscarded: number;
  /** Frames not timed because every query was still pending. */
  skippedFrames: number;
}

export interface ViewerStats {
  simulated: true;
  variant: 'instanced' | 'naive';
  cells: number;
  recolor: boolean;
  pixelRatio: number;
  drawingBuffer: { width: number; height: number };
  frames: number;
  avgFps: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  /** CPU submit time of the viewer's renderer.render (ms). */
  meanCpuMs: number | null;
  p95CpuMs: number | null;
  /** CPU time to rewrite all instance colours (ms, mean), null without recolor. */
  meanRecolorMs: number | null;
  recolors: number;
  drawCalls: number;
  triangles: number;
  setupMs: number;
}

export interface SearchStats {
  simulated: true;
  mode: 'main' | 'worker';
  cells: number;
  topK: number;
  nanFraction: number;
  /** Decimal MB (10^6 bytes) of the Float32Array dataset. */
  datasetMB: number;
  datasetGenMs: number | null;
  queries: number;
  /** main: synchronous query time; worker: post → answer round trip. */
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  /** worker only: compute time inside the worker. */
  computeP50Ms: number | null;
}

export interface EtlStats {
  simulated: true;
  mode: 'main' | 'worker';
  once: boolean;
  /** Decimal MB (10^6 bytes) of the generated JSON string. */
  sizeMB: number;
  targets: number;
  analogs: number;
  buildMs: number | null;
  parses: number;
  /** Main-thread cost per parse: main = JSON.parse + Map build; worker = event.data access + Map build. */
  p50Ms: number | null;
  maxMs: number | null;
  /** worker only: time spent in the `event.data` getter (lazy structured-clone deserialisation in Chromium). */
  accessP50Ms: number | null;
  /** worker only: worker postMessage call → main handler start. */
  deliveryP50Ms: number | null;
  /** worker only: JSON.parse inside the worker. */
  workerParseP50Ms: number | null;
}

export interface SynthPhaseStats {
  p50Ms: number | null;
  p95Ms: number | null;
}

export interface SynthPresetResult {
  preset: string;
  runs: number;
  rockCount: number;
  noise: SynthPhaseStats;
  normals: SynthPhaseStats;
  bvh: SynthPhaseStats;
  rocks: SynthPhaseStats;
  total: SynthPhaseStats;
}

export interface SynthMicroResult {
  perPreset: SynthPresetResult[];
  bvhFullRebuild: { preset: string; runs: number; p50Ms: number | null; p95Ms: number | null };
}

export interface StepResult {
  id: string;
  label: string;
  mode: SandboxMode | null;
  preset: string | null;
  sandboxPaused: boolean;
  /** Actual measured window (ms). */
  windowMs: number | null;
  sandbox: FrameSummary | null;
  gpu: GpuSummary | null;
  viewer: ViewerStats | null;
  search: SearchStats | null;
  etl: EtlStats | null;
  synth: SynthMicroResult | null;
  longTasks: LongTaskReport | null;
  heapMB: { start: number | null; end: number | null } | null;
  notes: string[];
  error: string | null;
}

export interface BenchReport {
  version: 1;
  startedAt: string;
  finishedAt: string;
  totalMs: number;
  config: BenchConfig;
  env: BenchEnvironment;
  results: StepResult[];
  notes: string[];
}

export type BenchStatus = 'idle' | 'running' | 'done' | 'error';

export interface BenchState {
  status: BenchStatus;
  currentStep: string | null;
  /** 0..1 */
  progress: number;
  /** Phase of the current step: setup / warmup / measure / teardown. */
  phase: string | null;
  env: BenchEnvironment | null;
  results: StepResult[];
  error: string | null;
  report: BenchReport | null;
}

export interface BenchCallbacks {
  onProgress?: (state: BenchState, stepLabel: string | null, loadLabels: string[]) => void;
  onDone?: (report: BenchReport) => void;
  onError?: (message: string) => void;
}

/** A simulated module running next to the sandbox during a step. */
export interface LoadGenerator {
  readonly label: string;
  /** Setup and start running (before warm-up). */
  start(): Promise<void>;
  /** Clears statistics; the measured window starts. */
  beginMeasure(): void;
  /** Freezes statistics; the measured window ends. */
  endMeasure(): void;
  /** Stops and releases everything. Must be safe to call after a failed start. */
  stop(): Promise<void>;
}
