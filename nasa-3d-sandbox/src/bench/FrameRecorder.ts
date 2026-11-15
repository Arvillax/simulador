import { SampleBuffer, mean, percentile, sortedCopy } from './stats.ts';

/** Fields read from the engine's per-frame timings object (`SandboxEngine.timings` satisfies it). */
export interface FrameSample {
  readonly frameMs: number;
  readonly cpuMs: number;
  readonly updateMs: number;
  readonly renderMs: number;
  readonly lidarMs: number;
  readonly synthMs: number;
  readonly drawCalls: number;
  readonly triangles: number;
}

export interface FrameSummary {
  frames: number;
  /** Frames with frameMs <= 0 (first frame after a (re)start); not counted anywhere else. */
  skippedRestartFrames: number;
  /** Samples beyond the recorder capacity; non-zero means the window was truncated. */
  droppedSamples: number;
  avgFps: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  /** Percentage of frames longer than 16.67 ms (60 FPS budget). */
  pctOver16ms: number;
  /** Percentage of frames longer than 33.33 ms (30 FPS). */
  pctOver33ms: number;
  /** 1000 / mean of the slowest 1 % of frames (at least one frame). */
  onePercentLowFps: number;
  meanCpuMs: number;
  p95CpuMs: number;
  meanUpdateMs: number;
  meanRenderMs: number;
  meanLidarMs: number;
  meanSynthMs: number;
  maxSynthMs: number;
  /** Values of the last recorded frame. */
  drawCalls: number;
  triangles: number;
}

export const BUDGET_60_MS = 1000 / 60;
export const BUDGET_30_MS = 1000 / 30;

/**
 * Records engine frame timings into preallocated Float64Array buffers. `record` is allocation-free and is meant
 * to run inside an engine frame listener; `summarize` allocates and is called once per benchmark step.
 */
export class FrameRecorder {
  readonly capacity: number;
  private readonly frame: SampleBuffer;
  private readonly cpu: SampleBuffer;
  private readonly update: SampleBuffer;
  private readonly render: SampleBuffer;
  private readonly lidar: SampleBuffer;
  private readonly synth: SampleBuffer;
  private skipped = 0;
  private lastDrawCalls = 0;
  private lastTriangles = 0;

  constructor(capacity = 8192) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this.frame = new SampleBuffer(this.capacity);
    this.cpu = new SampleBuffer(this.capacity);
    this.update = new SampleBuffer(this.capacity);
    this.render = new SampleBuffer(this.capacity);
    this.lidar = new SampleBuffer(this.capacity);
    this.synth = new SampleBuffer(this.capacity);
  }

  get count(): number {
    return this.frame.count;
  }

  reset(): void {
    this.frame.reset();
    this.cpu.reset();
    this.update.reset();
    this.render.reset();
    this.lidar.reset();
    this.synth.reset();
    this.skipped = 0;
    this.lastDrawCalls = 0;
    this.lastTriangles = 0;
  }

  record(t: FrameSample): void {
    if (!(t.frameMs > 0)) {
      this.skipped++;
      return;
    }
    this.frame.push(t.frameMs);
    this.cpu.push(t.cpuMs);
    this.update.push(t.updateMs);
    this.render.push(t.renderMs);
    this.lidar.push(t.lidarMs);
    this.synth.push(t.synthMs);
    this.lastDrawCalls = t.drawCalls;
    this.lastTriangles = t.triangles;
  }

  summarize(): FrameSummary | null {
    const n = this.frame.count;
    if (n === 0) return null;
    const frames = sortedCopy(this.frame.view());
    let sum = 0;
    let over16 = 0;
    let over33 = 0;
    for (let i = 0; i < n; i++) {
      const v = frames[i];
      sum += v;
      if (v > BUDGET_60_MS) over16++;
      if (v > BUDGET_30_MS) over33++;
    }
    const k = Math.max(1, Math.ceil(n / 100));
    let slowSum = 0;
    for (let i = n - k; i < n; i++) slowSum += frames[i];
    const cpuSorted = sortedCopy(this.cpu.view());
    const synth = this.synth.view();
    let maxSynth = 0;
    for (let i = 0; i < synth.length; i++) if (synth[i] > maxSynth) maxSynth = synth[i];
    return {
      frames: n,
      skippedRestartFrames: this.skipped,
      droppedSamples: this.frame.droppedCount,
      avgFps: sum > 0 ? (n * 1000) / sum : 0,
      p50Ms: percentile(frames, 50),
      p95Ms: percentile(frames, 95),
      p99Ms: percentile(frames, 99),
      maxMs: frames[n - 1],
      pctOver16ms: (over16 * 100) / n,
      pctOver33ms: (over33 * 100) / n,
      onePercentLowFps: slowSum > 0 ? (k * 1000) / slowSum : 0,
      meanCpuMs: mean(cpuSorted),
      p95CpuMs: percentile(cpuSorted, 95),
      meanUpdateMs: mean(this.update.view()),
      meanRenderMs: mean(this.render.view()),
      meanLidarMs: mean(this.lidar.view()),
      meanSynthMs: mean(synth),
      maxSynthMs: maxSynth,
      drawCalls: this.lastDrawCalls,
      triangles: this.lastTriangles,
    };
  }
}
