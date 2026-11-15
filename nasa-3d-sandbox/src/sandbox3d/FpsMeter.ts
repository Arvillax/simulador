import type { FrameTimings } from './SandboxEngine.ts';

const TOP_K_CAPACITY = 16;

/**
 * Frame-time statistics over a preallocated Float64Array ring buffer. Pure (no DOM), unit-testable.
 * Windows are expressed in milliseconds of accumulated frame time, newest frames first.
 */
export class FrameStats {
  readonly capacity: number;
  private readonly buf: Float64Array;
  private readonly topK = new Float64Array(TOP_K_CAPACITY);
  private head = 0;
  private size = 0;

  constructor(capacity = 600) {
    this.capacity = capacity;
    this.buf = new Float64Array(capacity);
  }

  get count(): number {
    return this.size;
  }

  push(frameMs: number): void {
    this.buf[this.head] = frameMs;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) this.size++;
  }

  /** Frame time `age` frames ago (0 = newest). */
  at(age: number): number {
    let i = this.head - 1 - age;
    if (i < 0) i += this.capacity;
    return this.buf[i];
  }

  /** Number of newest frames whose accumulated time first reaches `windowMs` (or all frames). */
  framesInWindow(windowMs: number): number {
    let sum = 0;
    let n = 0;
    while (n < this.size && sum < windowMs) {
      sum += this.at(n);
      n++;
    }
    return n;
  }

  /** Average FPS over the last ~windowMs. */
  avgFps(windowMs = 500): number {
    const n = this.framesInWindow(windowMs);
    let sum = 0;
    for (let i = 0; i < n; i++) sum += this.at(i);
    return sum > 0 ? (n * 1000) / sum : 0;
  }

  meanMs(windowMs = 500): number {
    const n = this.framesInWindow(windowMs);
    let sum = 0;
    for (let i = 0; i < n; i++) sum += this.at(i);
    return n > 0 ? sum / n : 0;
  }

  /** 1 % low: 1000 / mean of the slowest 1 % of frames (at least one) in the last ~windowMs. */
  onePercentLowFps(windowMs = 2000): number {
    const n = this.framesInWindow(windowMs);
    if (n === 0) return 0;
    const k = Math.min(TOP_K_CAPACITY, Math.max(1, Math.ceil(n / 100)));
    const top = this.topK;
    let filled = 0;
    for (let i = 0; i < n; i++) {
      const v = this.at(i);
      if (filled < k) {
        let j = filled++;
        while (j > 0 && top[j - 1] < v) {
          top[j] = top[j - 1];
          j--;
        }
        top[j] = v;
      } else if (v > top[k - 1]) {
        let j = k - 1;
        while (j > 0 && top[j - 1] < v) {
          top[j] = top[j - 1];
          j--;
        }
        top[j] = v;
      }
    }
    let sum = 0;
    for (let i = 0; i < k; i++) sum += top[i];
    return sum > 0 ? (k * 1000) / sum : 0;
  }

  worstMs(windowMs = 2000): number {
    const n = this.framesInWindow(windowMs);
    let worst = 0;
    for (let i = 0; i < n; i++) {
      const v = this.at(i);
      if (v > worst) worst = v;
    }
    return worst;
  }
}

const DOM_INTERVAL_MS = 250; // 4 Hz
const SPARK_FRAMES = 120;
const SPARK_MAX_MS = 50;
const BUDGET_MS = 1000 / 60;

/**
 * Small fixed FPS box (top-right). Frame times are pushed every frame; DOM text and the sparkline are
 * refreshed at 4 Hz only.
 */
export class FpsMeter {
  readonly stats = new FrameStats(600);
  private readonly fpsEl: HTMLElement;
  private readonly frameEl: HTMLElement;
  private readonly lowEl: HTMLElement;
  private readonly worstEl: HTMLElement;
  private readonly drawsEl: HTMLElement;
  private readonly trisEl: HTMLElement;
  private readonly spark: HTMLCanvasElement;
  private readonly sparkCtx: CanvasRenderingContext2D | null;
  private lastDomMs = -Infinity;
  private drawCalls = 0;
  private triangles = 0;

  constructor(root: HTMLElement) {
    root.classList.add('fps-box');
    root.replaceChildren();
    const main = document.createElement('div');
    main.className = 'fps-main';
    this.fpsEl = document.createElement('span');
    this.fpsEl.className = 'fps-value';
    this.fpsEl.textContent = '--';
    const fpsUnit = document.createElement('span');
    fpsUnit.className = 'fps-unit';
    fpsUnit.textContent = 'FPS';
    main.append(this.fpsEl, fpsUnit);

    this.frameEl = document.createElement('span');
    this.lowEl = document.createElement('span');
    this.worstEl = document.createElement('span');
    this.drawsEl = document.createElement('span');
    this.trisEl = document.createElement('span');
    const rows: Array<[string, HTMLElement, string]> = [
      ['Frame', this.frameEl, 'ms'],
      ['1% low', this.lowEl, 'FPS'],
      ['Worst 2 s', this.worstEl, 'ms'],
      ['Draw calls', this.drawsEl, ''],
      ['Triangles', this.trisEl, ''],
    ];
    const list = document.createElement('dl');
    list.className = 'fps-rows';
    for (const [label, valueEl, unit] of rows) {
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      valueEl.textContent = '--';
      dd.append(valueEl);
      if (unit) dd.append(` ${unit}`);
      list.append(dt, dd);
    }

    this.spark = document.createElement('canvas');
    this.spark.className = 'fps-spark';
    this.spark.width = SPARK_FRAMES * 2;
    this.spark.height = 64;
    this.spark.setAttribute('aria-label', 'Frame time of the last 120 frames, line at 16.7 ms');
    this.sparkCtx = this.spark.getContext('2d');

    root.append(main, list, this.spark);
  }

  /** Called by the engine every frame after render. Allocation-free except the 4 Hz DOM refresh. */
  tick(timings: FrameTimings, nowMs: number): void {
    this.stats.push(timings.frameMs);
    this.drawCalls = timings.drawCalls;
    this.triangles = timings.triangles;
    if (nowMs - this.lastDomMs >= DOM_INTERVAL_MS) {
      this.lastDomMs = nowMs;
      this.refresh();
    }
  }

  private refresh(): void {
    const s = this.stats;
    this.fpsEl.textContent = s.avgFps(500).toFixed(0);
    this.frameEl.textContent = s.meanMs(500).toFixed(2);
    this.lowEl.textContent = s.onePercentLowFps(2000).toFixed(0);
    this.worstEl.textContent = s.worstMs(2000).toFixed(1);
    this.drawsEl.textContent = String(this.drawCalls);
    this.trisEl.textContent = this.triangles.toLocaleString('en-US');
    this.drawSpark();
  }

  private drawSpark(): void {
    const ctx = this.sparkCtx;
    if (ctx === null) return;
    const w = this.spark.width;
    const h = this.spark.height;
    ctx.clearRect(0, 0, w, h);
    const budgetY = h - (BUDGET_MS / SPARK_MAX_MS) * h;
    ctx.strokeStyle = 'rgba(255, 196, 0, 0.75)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, budgetY);
    ctx.lineTo(w, budgetY);
    ctx.stroke();

    const n = Math.min(SPARK_FRAMES, this.stats.count);
    if (n < 2) return;
    const step = w / (SPARK_FRAMES - 1);
    ctx.strokeStyle = '#5fe3a1';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const ms = this.stats.at(n - 1 - i);
      const y = h - (Math.min(ms, SPARK_MAX_MS) / SPARK_MAX_MS) * h;
      const x = (SPARK_FRAMES - n + i) * step;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}
