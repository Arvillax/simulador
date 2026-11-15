import type { RenderPassHook } from '../sandbox3d/SandboxEngine.ts';
import type { GpuSummary } from './types.ts';
import { SampleBuffer, mean, percentile, sortedCopy } from './stats.ts';

interface TimerQueryExt {
  readonly TIME_ELAPSED_EXT: number;
  readonly GPU_DISJOINT_EXT: number;
}

const POOL_SIZE = 8;

/**
 * GPU time of the sandbox render pass via EXT_disjoint_timer_query_webgl2 (TIME_ELAPSED queries).
 * Results arrive a few frames late; a fixed pool of queries is polled each frame. Allocation-free per frame.
 */
export class GpuTimer implements RenderPassHook {
  private readonly gl: WebGL2RenderingContext;
  private readonly ext: TimerQueryExt;
  private readonly pool: WebGLQuery[];
  /** FIFO of pending query slots (indices into pool). */
  private readonly pending = new Int32Array(POOL_SIZE);
  private readonly free = new Int32Array(POOL_SIZE);
  private readonly samples: SampleBuffer;
  private pendingHead = 0;
  private pendingCount = 0;
  private freeCount = POOL_SIZE;
  private active = -1;
  private recording = false;
  private disjoint = 0;
  private skipped = 0;

  private constructor(gl: WebGL2RenderingContext, ext: TimerQueryExt, capacity: number) {
    this.gl = gl;
    this.ext = ext;
    this.pool = [];
    for (let i = 0; i < POOL_SIZE; i++) {
      this.pool.push(gl.createQuery());
      this.free[i] = i;
    }
    this.samples = new SampleBuffer(capacity);
  }

  /** null when the context is not WebGL2 or the extension is unavailable. */
  static create(context: WebGLRenderingContext | WebGL2RenderingContext, capacity = 8192): GpuTimer | null {
    if (typeof WebGL2RenderingContext === 'undefined' || !(context instanceof WebGL2RenderingContext)) return null;
    const ext = context.getExtension('EXT_disjoint_timer_query_webgl2') as TimerQueryExt | null;
    if (ext === null) return null;
    return new GpuTimer(context, ext, capacity);
  }

  /** Starts timing new frames (clears previous samples). */
  startRecording(): void {
    this.samples.reset();
    this.disjoint = 0;
    this.skipped = 0;
    this.recording = true;
  }

  /** Stops issuing new queries; pending ones are still collected by poll(). */
  stopRecording(): void {
    this.recording = false;
  }

  beforeRender(): void {
    this.poll();
    if (!this.recording || this.active >= 0) return;
    if (this.freeCount === 0) {
      this.skipped++;
      return;
    }
    const slot = this.free[--this.freeCount];
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, this.pool[slot]);
    this.active = slot;
  }

  afterRender(): void {
    if (this.active < 0) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending[(this.pendingHead + this.pendingCount) % POOL_SIZE] = this.active;
    this.pendingCount++;
    this.active = -1;
  }

  /** Collects finished queries in issue order. */
  poll(): void {
    const gl = this.gl;
    if (this.pendingCount === 0) return;
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT) as boolean;
    while (this.pendingCount > 0) {
      const slot = this.pending[this.pendingHead];
      const query = this.pool[slot];
      if (!disjoint) {
        const available = gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE) as boolean;
        if (!available) break;
        const ns = gl.getQueryParameter(query, gl.QUERY_RESULT) as number;
        this.samples.push(ns / 1e6);
      } else {
        this.disjoint++;
      }
      this.pendingHead = (this.pendingHead + 1) % POOL_SIZE;
      this.pendingCount--;
      this.free[this.freeCount++] = slot;
    }
  }

  summary(): GpuSummary {
    const sorted = sortedCopy(this.samples.view());
    const n = sorted.length;
    return {
      samples: n,
      meanMs: n > 0 ? mean(sorted) : null,
      p95Ms: n > 0 ? percentile(sorted, 95) : null,
      disjointDiscarded: this.disjoint,
      skippedFrames: this.skipped,
    };
  }

  dispose(): void {
    if (this.active >= 0) {
      this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
      this.active = -1;
    }
    for (const q of this.pool) this.gl.deleteQuery(q);
    this.pool.length = 0;
    this.pendingCount = 0;
    this.freeCount = 0;
  }
}
