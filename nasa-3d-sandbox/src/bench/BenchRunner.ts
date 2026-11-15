import type { FrameListener } from '../sandbox3d/SandboxEngine.ts';
import type {
  BenchCallbacks,
  BenchConfig,
  BenchHost,
  BenchOptions,
  BenchReport,
  BenchState,
  LoadGenerator,
  StepResult,
  SynthPhaseStats,
  SynthPresetResult,
} from './types.ts';
import { FrameRecorder } from './FrameRecorder.ts';
import { LongTaskProbe } from './LongTaskProbe.ts';
import { GpuTimer } from './GpuTimer.ts';
import { captureEnvironment, heapMB } from './env.ts';
import { BASE_PRESET, BENCH_STEPS } from './steps.ts';
import type { StepPlan } from './steps.ts';
import { ViewerLoad } from './scenarios/viewerLoad.ts';
import { SearchLoad } from './scenarios/searchLoad.ts';
import { EtlLoad } from './scenarios/etlLoad.ts';
import { healpixLandTableEstimate } from './scenarios/searchEngine.ts';
import { distribution, round } from './stats.ts';

const BENCH_SEED = 1;
const DEFAULTS = { warmupMs: 1500, measureMs: 5000, teardownMs: 500 };
/** Recorder capacity is sized for this frame rate over the measured window. */
const MAX_RATE_HZ = 500;
const SYNTH_RUNS = 40;
const BVH_RUNS = 10;
/** The quality governor makes its first probe after 4 s: give it that long, then pin the level. */
const QUALITY_CALIBRATION_MS = 4000;
const LAST_QUALITY_LEVEL = 6;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Defaults < URL params (?steps= ?warmup= ?measure= ?teardown= ?level=) < explicit options. */
export function resolveConfig(opts: BenchOptions = {}, search = window.location.search): BenchConfig {
  const params = new URLSearchParams(search);
  const num = (key: string, fallback: number): number => {
    const raw = params.get(key);
    const n = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  const urlSteps = params
    .get('steps')
    ?.split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.length > 0);
  const all = BENCH_STEPS.map((s) => s.id);
  const requested = (opts.steps ?? urlSteps ?? all).map((s) => s.toUpperCase());
  const rawLevel = opts.level ?? (params.get('level') === null ? Number.NaN : Number(params.get('level')));
  return {
    steps: all.filter((id) => requested.includes(id)),
    warmupMs: opts.warmupMs ?? num('warmup', DEFAULTS.warmupMs),
    measureMs: Math.max(500, opts.measureMs ?? num('measure', DEFAULTS.measureMs)),
    teardownMs: opts.teardownMs ?? num('teardown', DEFAULTS.teardownMs),
    level: Number.isInteger(rawLevel) && rawLevel >= 0 && rawLevel <= LAST_QUALITY_LEVEL ? rawLevel : null,
  };
}

function phaseStats(values: number[]): SynthPhaseStats {
  const d = distribution(values);
  return { p50Ms: d.n > 0 ? d.p50 : null, p95Ms: d.n > 0 ? d.p95 : null };
}

function emptyResult(plan: StepPlan, host: BenchHost): StepResult {
  return {
    id: plan.id,
    label: plan.label,
    mode: plan.mode,
    preset: host.presets[plan.preset]?.id ?? null,
    sandboxPaused: plan.pauseSandbox === true || plan.kind === 'synth',
    windowMs: null,
    sandbox: null,
    gpu: null,
    viewer: null,
    search: null,
    etl: null,
    synth: null,
    longTasks: null,
    heapMB: null,
    notes: [...(plan.notes ?? [])],
    error: null,
  };
}

function healpixNote(): string {
  const e = healpixLandTableEstimate();
  const gb = (bytes: number): string => (bytes / 1e9).toFixed(2);
  return (
    `HEALPix level ${e.level} land table (computed, not run): Npix = 12·${e.nside}² = ${e.npix.toLocaleString('en-US')}; ` +
    `land fraction ≈ 134/510 = ${e.landFraction.toFixed(3)} → ${e.landCells.toLocaleString('en-US')} cells; ` +
    `6 float32 columns = ${gb(e.valueBytes)} GB; with a uint64 cell index = ${gb(e.valueAndIndexBytes)} GB. ` +
    `The 1M / 5M-cell search datasets are ${((1e6 / e.landCells) * 100).toFixed(1)} % / ${((5e6 / e.landCells) * 100).toFixed(1)} % of it.`
  );
}

interface RunContext {
  readonly host: BenchHost;
  readonly state: BenchState;
  readonly config: BenchConfig;
  readonly recorder: FrameRecorder;
  readonly recordListener: FrameListener;
  readonly probe: LongTaskProbe;
  readonly gpuTimer: GpuTimer | null;
  readonly callbacks: BenchCallbacks;
  stepLabel: string | null;
  loadLabels: string[];
}

function notify(ctx: RunContext, phase: string | null): void {
  ctx.state.phase = phase;
  ctx.callbacks.onProgress?.(ctx.state, ctx.stepLabel, ctx.loadLabels);
}

/**
 * Simulated preset vector, gravity, seed and world through the bridge; then the look and the mode are snapped
 * (no 500 ms world blend, no camera travel), so every step starts from the same picture.
 */
function applyPreset(host: BenchHost, index: number, plan: StepPlan): void {
  const preset = host.presets[index];
  if (preset === undefined) throw new Error(`Unknown preset index ${index}`);
  host.bridge.handleSimulationControl({
    vector: [...preset.vector],
    gravity: preset.gravity,
    seed: BENCH_SEED,
    body: preset.body,
  });
  host.engine.setBody(preset.body, { immediate: true, sunlit: preset.sunlit !== false });
  host.engine.setMode(plan.mode, { instant: true });
}

/** Slider-drag simulation: slowly varying slope / TRI written through the bridge every frame. */
function makeDragListener(host: BenchHost): FrameListener {
  const v = host.presets[BASE_PRESET].vector;
  return (nowMs: number) => {
    const t = nowMs / 1000;
    const tri = Math.min(1, Math.max(0, v[1] + 0.2 * Math.sin(t * 0.53)));
    host.bridge.updateSandboxTerrain(v[0] + 6 * Math.sin(t * 0.8), tri, v[2], v[3], v[4], v[5]);
  };
}

async function runFrameStep(plan: StepPlan, ctx: RunContext): Promise<StepResult> {
  const { host, config, recorder, probe, gpuTimer } = ctx;
  const engine = host.engine;
  const result = emptyResult(plan, host);
  const loads: LoadGenerator[] = [];
  let viewer: ViewerLoad | null = null;
  let search: SearchLoad | null = null;
  let etl: EtlLoad | null = null;
  let dragListener: FrameListener | null = null;
  let recording = false;
  let probing = false;
  let hidden = document.hidden;
  const onVisibility = (): void => {
    if (document.hidden) hidden = true;
  };
  document.addEventListener('visibilitychange', onVisibility);

  try {
    notify(ctx, 'setup');
    engine.resume();
    applyPreset(host, plan.preset, plan);
    engine.synthesizeNow(BENCH_SEED);
    if (plan.viewer !== undefined) loads.push((viewer = new ViewerLoad(plan.viewer)));
    if (plan.search !== undefined) loads.push((search = new SearchLoad(plan.search)));
    if (plan.etl !== undefined) loads.push((etl = new EtlLoad(plan.etl)));
    ctx.loadLabels = loads.map((l) => l.label);
    notify(ctx, 'setup');
    for (const load of loads) await load.start();
    if (plan.pauseSandbox === true) engine.pause();
    if (plan.sliderDrag === true) {
      dragListener = makeDragListener(host);
      engine.addFrameListener(dragListener);
    }

    notify(ctx, 'warmup');
    await sleep(config.warmupMs);

    notify(ctx, 'measure');
    recorder.reset();
    const timeGpu = gpuTimer !== null && plan.pauseSandbox !== true;
    if (timeGpu) {
      gpuTimer.startRecording();
      engine.renderPassHook = gpuTimer;
    }
    const heapStart = heapMB();
    probe.start();
    probing = true;
    for (const load of loads) load.beginMeasure();
    if (plan.pauseSandbox !== true) {
      engine.addFrameListener(ctx.recordListener);
      recording = true;
    }
    const w0 = performance.now();
    await sleep(config.measureMs);
    result.windowMs = performance.now() - w0;
    if (recording) engine.removeFrameListener(ctx.recordListener);
    recording = false;
    for (const load of loads) load.endMeasure();
    result.longTasks = probe.stop();
    probing = false;
    const heapEnd = heapMB();
    result.heapMB = heapStart === null && heapEnd === null ? null : { start: heapStart, end: heapEnd };
    gpuTimer?.stopRecording();

    result.sandbox = plan.pauseSandbox === true ? null : recorder.summarize();
    result.viewer = viewer?.stats() ?? null;
    result.search = search?.stats() ?? null;
    result.etl = etl?.stats() ?? null;
    if (search?.error) result.notes.push(`search worker error: ${search.error}`);
    if (etl?.error) result.notes.push(`ETL worker error: ${etl.error}`);
    if (plan.pauseSandbox !== true && result.sandbox === null) {
      result.notes.push('No sandbox frames were recorded (tab hidden or canvas off screen).');
    }
    if (result.sandbox !== null && result.sandbox.droppedSamples > 0) {
      result.notes.push(`Recorder capacity reached: ${result.sandbox.droppedSamples} frames dropped.`);
    }
  } catch (error) {
    result.error = message(error);
  } finally {
    notify(ctx, 'teardown');
    if (recording) engine.removeFrameListener(ctx.recordListener);
    if (dragListener !== null) engine.removeFrameListener(dragListener);
    if (probing) result.longTasks = probe.stop();
    gpuTimer?.stopRecording();
    for (const load of loads) {
      try {
        await load.stop();
      } catch (error) {
        result.notes.push(`teardown error (${load.label}): ${message(error)}`);
      }
    }
    if (plan.pauseSandbox === true) engine.resume();
    await sleep(config.teardownMs);
    if (gpuTimer !== null && engine.renderPassHook === gpuTimer) {
      // Late query results arrive during teardown frames; collect what is ready.
      gpuTimer.poll();
      if (result.error === null) result.gpu = gpuTimer.summary();
      engine.renderPassHook = null;
    }
    document.removeEventListener('visibilitychange', onVisibility);
    if (hidden) result.notes.push('Tab was hidden during this step: rAF was throttled or paused, results are not valid.');
    ctx.loadLabels = [];
  }
  return result;
}

async function runSynthStep(plan: StepPlan, ctx: RunContext): Promise<StepResult> {
  const { host, config, probe } = ctx;
  const engine = host.engine;
  const result = emptyResult(plan, host);
  notify(ctx, 'synthesis');
  engine.pause();
  const heapStart = heapMB();
  probe.start();
  try {
    const perPreset: SynthPresetResult[] = [];
    for (let p = 0; p < host.presets.length; p++) {
      // Paused: the bridge applies the vector immediately (one synthesis + one still frame).
      applyPreset(host, p, plan);
      const noise: number[] = [];
      const normals: number[] = [];
      const bvh: number[] = [];
      const rocks: number[] = [];
      const total: number[] = [];
      const s = engine.synthTimings;
      for (let i = 0; i < SYNTH_RUNS; i++) {
        engine.synthesizeNow(BENCH_SEED);
        noise.push(s.noiseMs);
        normals.push(s.normalsMs);
        bvh.push(s.bvhMs);
        rocks.push(s.rocksMs);
        total.push(s.totalMs);
        if ((i + 1) % 10 === 0) await sleep(0);
      }
      perPreset.push({
        preset: host.presets[p].id,
        runs: SYNTH_RUNS,
        rockCount: s.rockCount,
        noise: phaseStats(noise),
        normals: phaseStats(normals),
        bvh: phaseStats(bvh),
        rocks: phaseStats(rocks),
        total: phaseStats(total),
      });
      notify(ctx, `synthesis ${p + 1}/${host.presets.length}`);
    }
    applyPreset(host, BASE_PRESET, plan);
    const rebuild: number[] = [];
    for (let i = 0; i < BVH_RUNS; i++) {
      rebuild.push(engine.rebuildTerrainBvhFull());
      await sleep(0);
    }
    const r = phaseStats(rebuild);
    result.synth = {
      perPreset,
      bvhFullRebuild: { preset: host.presets[BASE_PRESET].id, runs: BVH_RUNS, p50Ms: r.p50Ms, p95Ms: r.p95Ms },
    };
  } catch (error) {
    result.error = message(error);
  } finally {
    result.longTasks = probe.stop();
    const heapEnd = heapMB();
    result.heapMB = heapStart === null && heapEnd === null ? null : { start: heapStart, end: heapEnd };
    engine.resume();
    notify(ctx, 'teardown');
    await sleep(config.teardownMs);
  }
  return result;
}

/** Compact rows for console.table and the results overlay. */
export function summaryRows(report: BenchReport): Array<Record<string, string | number | null>> {
  return report.results.map((r) => {
    const s = r.sandbox;
    const synth0 = r.synth?.perPreset[0];
    return {
      id: r.id,
      scenario: r.label,
      fps: round(s?.avgFps, 1),
      p95Ms: round(s?.p95Ms),
      p99Ms: round(s?.p99Ms),
      over16Pct: round(s?.pctOver16ms, 1),
      low1Fps: round(s?.onePercentLowFps, 1),
      cpuMs: round(s?.meanCpuMs),
      gpuMs: round(r.gpu?.meanMs),
      viewerFps: round(r.viewer?.avgFps, 1),
      searchP95Ms: round(r.search?.p95Ms),
      etlMaxMs: round(r.etl?.maxMs),
      loafMaxBlockMs: round(r.longTasks?.loaf?.maxBlockingMs, 1),
      synthP50Ms: round(synth0?.total.p50Ms),
      error: r.error,
    };
  });
}

/**
 * Runs the benchmark steps against the live sandbox and mutates `state` (window.__bench) as it goes.
 * Viewer, search and ETL loads are simulations of the planned modules.
 */
export async function runBench(
  host: BenchHost,
  state: BenchState,
  opts: BenchOptions = {},
  callbacks: BenchCallbacks = {},
): Promise<BenchReport> {
  if (state.status === 'running') throw new Error('Benchmark already running');
  const config = resolveConfig(opts);
  const plans = BENCH_STEPS.filter((s) => config.steps.includes(s.id));
  state.status = 'running';
  state.currentStep = null;
  state.progress = 0;
  state.phase = null;
  state.env = null;
  state.results = [];
  state.error = null;
  state.report = null;

  const engine = host.engine;
  const capacity = Math.max(4096, Math.ceil((config.measureMs / 1000) * MAX_RATE_HZ));
  const recorder = new FrameRecorder(capacity);
  const gpuTimer = GpuTimer.create(engine.renderer.getContext(), capacity);
  const ctx: RunContext = {
    host,
    state,
    config,
    recorder,
    recordListener: () => recorder.record(engine.timings),
    probe: new LongTaskProbe(),
    gpuTimer,
    callbacks,
    stepLabel: null,
    loadLabels: [],
  };
  const startedAt = new Date().toISOString();
  const t0 = performance.now();

  try {
    // Pin the quality level for the whole run, so the scenarios are measured at the same render scale and
    // shadow map. Unlocked again in `finally`, on finish or abort.
    ctx.stepLabel = 'Calibrating quality level';
    notify(ctx, 'quality');
    if (config.level !== null) {
      engine.quality.lock(config.level);
    } else {
      if (engine.quality.getState().auto) {
        engine.resume();
        await sleep(QUALITY_CALIBRATION_MS);
      }
      engine.quality.lock();
    }

    ctx.stepLabel = 'Capturing environment';
    notify(ctx, 'environment');
    const env = await captureEnvironment(engine, host.startup, gpuTimer !== null);
    state.env = env;

    for (let i = 0; i < plans.length; i++) {
      const plan = plans[i];
      state.currentStep = plan.id;
      state.progress = i / plans.length;
      ctx.stepLabel = `${plan.id} (${i + 1}/${plans.length}) · ${plan.label}`;
      const result = plan.kind === 'synth' ? await runSynthStep(plan, ctx) : await runFrameStep(plan, ctx);
      if (plan.search !== undefined) result.notes.push(healpixNote());
      state.results.push(result);
    }

    // Leave the page in the default state (S01: ROVER, base preset).
    applyPreset(host, BASE_PRESET, BENCH_STEPS[0]);
    const notes = [
      'Viewer, search engine and ETL loads are SIMULATIONS of planned modules (the real viewer library, search engine and metrics.json are not used).',
      'MB = 10^6 bytes. Frame times are rAF intervals of the sandbox loop; cpuMs is CPU time inside the sandbox frame callback.',
      `Frame rate is capped by the display refresh (estimated ${round(env.estimatedRefreshHz, 1) ?? 'unknown'} Hz): FPS at the cap hides headroom; compare cpuMs and frame-time percentiles.`,
      'All rAF callbacks of the page run in the same rendering step, so the viewer FPS equals the page frame rate while both loops run.',
      `Build: ${env.build}. Dev builds are unminified and serve modules individually; prefer the production build (npm run build && npm run preview).`,
      `Quality level L${env.qualityLevel} pinned for the run (${config.level !== null ? 'forced with level' : 'calibrated by the governor'}): ` +
        `render scale ${env.renderScale}, shadow map ${env.shadowMapSize === 0 ? 'off' : `${env.shadowMapSize} px`}. ` +
        'Compare runs only at the same level.',
      healpixNote(),
    ];
    if (gpuTimer === null) notes.push('GPU time is null: EXT_disjoint_timer_query_webgl2 is unavailable on the sandbox context.');
    const report: BenchReport = {
      version: 1,
      startedAt,
      finishedAt: new Date().toISOString(),
      totalMs: performance.now() - t0,
      config,
      env,
      results: state.results,
      notes,
    };
    state.report = report;
    state.status = 'done';
    state.progress = 1;
    state.currentStep = null;
    ctx.stepLabel = null;
    notify(ctx, null);
    console.table(summaryRows(report));
    callbacks.onDone?.(report);
    return report;
  } catch (error) {
    state.status = 'error';
    state.error = message(error);
    callbacks.onError?.(state.error);
    throw error;
  } finally {
    engine.quality.unlock();
    engine.renderPassHook = null;
    gpuTimer?.dispose();
    engine.resume();
  }
}
