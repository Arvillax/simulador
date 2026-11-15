import type { LoadGenerator, SearchStats } from '../types.ts';
import { distribution } from '../stats.ts';
import {
  DEFAULT_NAN_FRACTION,
  DEFAULT_TOP_K,
  SEARCH_DIMS,
  SearchKernel,
  generateDataset,
} from './searchEngine.ts';
import type { SearchQueryMessage, SearchWorkerResponse } from './searchEngine.ts';

export type SearchMode = 'main' | 'worker';

export interface SearchLoadOptions {
  mode: SearchMode;
  cells: number;
  /** Query cadence (ms); models slider-driven searches. Default 250. */
  intervalMs?: number;
  seed?: number;
}

const READY_TIMEOUT_MS = 60_000;
const BASE_VECTOR = [16, 0.72, 0.28, 0.14, 255, 0.02];
const WEIGHTS = [1, 1, 1, 1, 1, 1];

/** Slowly varying query vector (a user dragging sliders), written into `out`. */
function queryVector(i: number, out: number[]): void {
  out[0] = BASE_VECTOR[0] + 10 * Math.sin(i * 0.37);
  out[1] = Math.min(1, Math.max(0, BASE_VECTOR[1] + 0.25 * Math.sin(i * 0.21)));
  out[2] = BASE_VECTOR[2];
  out[3] = BASE_VECTOR[3] + 0.05 * Math.sin(i * 0.11);
  out[4] = BASE_VECTOR[4] + 40 * Math.sin(i * 0.13);
  out[5] = BASE_VECTOR[5];
}

/**
 * SIMULATED similarity-search engine load (the planned engine is Rust/Wasm; location undecided).
 * `main`: synchronous query on the main thread every intervalMs.
 * `worker`: dataset and queries inside a Web Worker; a query is posted every intervalMs or as soon as the
 * previous answer returns, whichever is later. Latency is the post → answer round trip.
 */
export class SearchLoad implements LoadGenerator {
  readonly label: string;
  private readonly mode: SearchMode;
  private readonly cells: number;
  private readonly intervalMs: number;
  private readonly seed: number;
  private kernel: SearchKernel | null = null;
  private worker: Worker | null = null;
  private timer = 0;
  private measuring = false;
  private queryIndex = 0;
  private readonly target = new Array<number>(SEARCH_DIMS).fill(0);
  private readonly latencies: number[] = [];
  private readonly computeMs: number[] = [];
  private genMs: number | null = null;
  private bytes: number;
  private inFlight = false;
  private due = false;
  private postedAt = 0;
  private postedMeasuring = false;
  private workerError: string | null = null;

  constructor(options: SearchLoadOptions) {
    this.mode = options.mode;
    this.cells = Math.max(1, Math.floor(options.cells));
    this.intervalMs = options.intervalMs ?? 250;
    this.seed = options.seed ?? 12345;
    this.bytes = this.cells * SEARCH_DIMS * 4;
    this.label = `Simulated search · ${this.mode} · ${this.cells.toLocaleString('en-US')} cells`;
  }

  async start(): Promise<void> {
    if (this.mode === 'main') {
      const t0 = performance.now();
      const values = generateDataset(this.cells, this.seed, DEFAULT_NAN_FRACTION);
      this.kernel = new SearchKernel(values, DEFAULT_TOP_K);
      this.genMs = performance.now() - t0;
      this.bytes = values.byteLength;
      this.timer = window.setInterval(() => this.runMainQuery(), this.intervalMs);
      return;
    }
    const worker = new Worker(new URL('./searchWorker.ts', import.meta.url), { type: 'module' });
    this.worker = worker;
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error('search worker did not become ready')), READY_TIMEOUT_MS);
      worker.onerror = (event) => {
        window.clearTimeout(timeout);
        reject(new Error(`search worker error: ${event.message}`));
      };
      worker.onmessage = (event: MessageEvent<SearchWorkerResponse>) => {
        const msg = event.data;
        if (msg.type === 'ready') {
          window.clearTimeout(timeout);
          this.genMs = msg.genMs;
          this.bytes = msg.bytes;
          resolve();
        } else if (msg.type === 'error') {
          window.clearTimeout(timeout);
          reject(new Error(`search worker: ${msg.message}`));
        }
      };
      worker.postMessage({ type: 'init', cells: this.cells, seed: this.seed, nanFraction: DEFAULT_NAN_FRACTION, k: DEFAULT_TOP_K });
    });
    worker.onmessage = (event: MessageEvent<SearchWorkerResponse>) => this.onWorkerMessage(event.data);
    worker.onerror = (event) => {
      this.workerError = event.message;
    };
    this.timer = window.setInterval(() => this.onWorkerTick(), this.intervalMs);
  }

  beginMeasure(): void {
    this.latencies.length = 0;
    this.computeMs.length = 0;
    this.measuring = true;
  }

  endMeasure(): void {
    this.measuring = false;
  }

  private runMainQuery(): void {
    const kernel = this.kernel;
    if (kernel === null) return;
    queryVector(this.queryIndex++, this.target);
    const t0 = performance.now();
    kernel.query(this.target, WEIGHTS);
    const ms = performance.now() - t0;
    if (this.measuring) this.latencies.push(ms);
  }

  private onWorkerTick(): void {
    if (this.inFlight) {
      this.due = true;
      return;
    }
    this.postQuery();
  }

  private postQuery(): void {
    const worker = this.worker;
    if (worker === null) return;
    queryVector(this.queryIndex, this.target);
    const msg: SearchQueryMessage = { type: 'query', id: this.queryIndex++, target: this.target.slice(), weights: WEIGHTS };
    this.inFlight = true;
    this.postedMeasuring = this.measuring;
    this.postedAt = performance.now();
    worker.postMessage(msg);
  }

  private onWorkerMessage(msg: SearchWorkerResponse): void {
    if (msg.type === 'error') {
      this.workerError = msg.message;
      this.inFlight = false;
      return;
    }
    if (msg.type !== 'result') return;
    const rtt = performance.now() - this.postedAt;
    this.inFlight = false;
    // Count only queries posted and answered inside the measured window.
    if (this.measuring && this.postedMeasuring) {
      this.latencies.push(rtt);
      this.computeMs.push(msg.computeMs);
    }
    if (this.due) {
      this.due = false;
      this.postQuery();
    }
  }

  stats(): SearchStats {
    const d = distribution(this.latencies);
    const c = distribution(this.computeMs);
    return {
      simulated: true,
      mode: this.mode,
      cells: this.cells,
      topK: DEFAULT_TOP_K,
      nanFraction: DEFAULT_NAN_FRACTION,
      datasetMB: this.bytes / 1e6,
      datasetGenMs: this.genMs,
      queries: d.n,
      p50Ms: d.n > 0 ? d.p50 : null,
      p95Ms: d.n > 0 ? d.p95 : null,
      maxMs: d.n > 0 ? d.max : null,
      computeP50Ms: this.mode === 'worker' && c.n > 0 ? c.p50 : null,
    };
  }

  /** Error reported by the worker during the step, if any. */
  get error(): string | null {
    return this.workerError;
  }

  async stop(): Promise<void> {
    if (this.timer !== 0) window.clearInterval(this.timer);
    this.timer = 0;
    this.measuring = false;
    this.worker?.terminate();
    this.worker = null;
    this.kernel = null;
    this.inFlight = false;
    this.due = false;
  }
}
