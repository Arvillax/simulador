import type { EtlStats, LoadGenerator } from '../types.ts';
import { distribution } from '../stats.ts';
import { buildMetricsJson } from './metricsGenerator.ts';
import type { MetricsFile, MetricsTarget } from './metricsGenerator.ts';
import type { EtlWorkerResponse } from './etlWorker.ts';

export type EtlMode = 'main' | 'worker';

export interface EtlLoadOptions {
  mode: EtlMode;
  /** Decimal MB (10^6 bytes). */
  sizeMB: number;
  /** Parse once at the start of the measured window instead of every intervalMs. */
  once?: boolean;
  /** Default 1000. */
  intervalMs?: number;
  seed?: number;
}

const READY_TIMEOUT_MS = 60_000;

function indexTargets(file: MetricsFile): Map<string, MetricsTarget> {
  const map = new Map<string, MetricsTarget>();
  for (const t of file.targets) map.set(t.id, t);
  return map;
}

/**
 * SIMULATED ETL-derived file load (`metrics.json`, ADR-007 shape, synthetic values). The JSON text is generated
 * before the measured window. `main`: JSON.parse + Map by target id on the main thread. `worker`: the worker
 * parses and posts the object back; the main thread pays the structured-clone deserialisation + Map build.
 */
export class EtlLoad implements LoadGenerator {
  readonly label: string;
  private readonly mode: EtlMode;
  private readonly targetBytes: number;
  private readonly once: boolean;
  private readonly intervalMs: number;
  private readonly seed: number;
  private json: string | null = null;
  private worker: Worker | null = null;
  private timer = 0;
  private startTimer = 0;
  private measuring = false;
  private nextId = 0;
  private inFlight = false;
  private due = false;
  private postedMeasuring = false;
  private bytes = 0;
  private targets = 0;
  private analogs = 0;
  private buildMs: number | null = null;
  private readonly costMs: number[] = [];
  private readonly accessMs: number[] = [];
  private readonly deliveryMs: number[] = [];
  private readonly workerParseMs: number[] = [];
  /** Latest index, kept alive like an application store would. */
  private latest: Map<string, MetricsTarget> | null = null;
  private workerError: string | null = null;

  constructor(options: EtlLoadOptions) {
    this.mode = options.mode;
    this.targetBytes = Math.round(options.sizeMB * 1e6);
    this.once = options.once === true;
    this.intervalMs = options.intervalMs ?? 1000;
    this.seed = options.seed ?? 7;
    this.label = `Simulated metrics.json · ${options.sizeMB} MB · ${this.mode} parse${this.once ? ' (once)' : ' every 1 s'}`;
  }

  async start(): Promise<void> {
    if (this.mode === 'main') {
      const t0 = performance.now();
      const out = buildMetricsJson(this.targetBytes, this.seed);
      this.buildMs = performance.now() - t0;
      this.json = out.json;
      this.bytes = out.bytes;
      this.targets = out.targets;
      this.analogs = out.analogs;
      return;
    }
    const worker = new Worker(new URL('./etlWorker.ts', import.meta.url), { type: 'module' });
    this.worker = worker;
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error('ETL worker did not become ready')), READY_TIMEOUT_MS);
      worker.onerror = (event) => {
        window.clearTimeout(timeout);
        reject(new Error(`ETL worker error: ${event.message}`));
      };
      worker.onmessage = (event: MessageEvent<EtlWorkerResponse>) => {
        const msg = event.data;
        if (msg.type === 'ready') {
          window.clearTimeout(timeout);
          this.buildMs = msg.buildMs;
          this.bytes = msg.bytes;
          this.targets = msg.targets;
          this.analogs = msg.analogs;
          resolve();
        } else if (msg.type === 'error') {
          window.clearTimeout(timeout);
          reject(new Error(`ETL worker: ${msg.message}`));
        }
      };
      worker.postMessage({ type: 'build', bytes: this.targetBytes, seed: this.seed });
    });
    worker.onmessage = (event: MessageEvent<EtlWorkerResponse>) => this.onWorkerMessage(event);
    worker.onerror = (event) => {
      this.workerError = event.message;
    };
  }

  beginMeasure(): void {
    this.costMs.length = 0;
    this.accessMs.length = 0;
    this.deliveryMs.length = 0;
    this.workerParseMs.length = 0;
    this.measuring = true;
    // First parse right after the window opens (inside it), then periodically unless `once`.
    this.startTimer = window.setTimeout(() => this.tick(), 0);
    if (!this.once) this.timer = window.setInterval(() => this.tick(), this.intervalMs);
  }

  endMeasure(): void {
    this.measuring = false;
    this.clearTimers();
  }

  private clearTimers(): void {
    if (this.startTimer !== 0) window.clearTimeout(this.startTimer);
    if (this.timer !== 0) window.clearInterval(this.timer);
    this.startTimer = 0;
    this.timer = 0;
  }

  private tick(): void {
    if (!this.measuring) return;
    if (this.mode === 'main') {
      this.parseOnMain();
      return;
    }
    if (this.inFlight) {
      this.due = true;
      return;
    }
    this.requestWorkerParse();
  }

  private parseOnMain(): void {
    const json = this.json;
    if (json === null) return;
    const t0 = performance.now();
    const file = JSON.parse(json) as MetricsFile;
    this.latest = indexTargets(file);
    this.costMs.push(performance.now() - t0);
  }

  private requestWorkerParse(): void {
    const worker = this.worker;
    if (worker === null) return;
    this.inFlight = true;
    this.postedMeasuring = this.measuring;
    worker.postMessage({ type: 'parse', id: this.nextId++ });
  }

  private onWorkerMessage(event: MessageEvent<EtlWorkerResponse>): void {
    const t0 = performance.now();
    const receivedAbs = performance.timeOrigin + t0;
    // Chromium deserialises the structured clone lazily, on the first `data` access.
    const msg = event.data;
    const t1 = performance.now();
    if (msg.type === 'error') {
      this.workerError = msg.message;
      this.inFlight = false;
      return;
    }
    if (msg.type !== 'parsed') return;
    this.latest = indexTargets(msg.payload);
    const t2 = performance.now();
    this.inFlight = false;
    // Count only parses requested and received inside the measured window.
    if (this.postedMeasuring && this.measuring) {
      this.accessMs.push(t1 - t0);
      this.costMs.push(t2 - t0);
      this.deliveryMs.push(receivedAbs - msg.sentAbs);
      this.workerParseMs.push(msg.parseMs);
    }
    if (this.due && this.measuring) {
      this.due = false;
      this.requestWorkerParse();
    }
  }

  stats(): EtlStats {
    const cost = distribution(this.costMs);
    const access = distribution(this.accessMs);
    const delivery = distribution(this.deliveryMs);
    const wparse = distribution(this.workerParseMs);
    const worker = this.mode === 'worker';
    return {
      simulated: true,
      mode: this.mode,
      once: this.once,
      sizeMB: this.bytes / 1e6,
      targets: this.targets,
      analogs: this.analogs,
      buildMs: this.buildMs,
      parses: cost.n,
      p50Ms: cost.n > 0 ? cost.p50 : null,
      maxMs: cost.n > 0 ? cost.max : null,
      accessP50Ms: worker && access.n > 0 ? access.p50 : null,
      deliveryP50Ms: worker && delivery.n > 0 ? delivery.p50 : null,
      workerParseP50Ms: worker && wparse.n > 0 ? wparse.p50 : null,
    };
  }

  get error(): string | null {
    return this.workerError;
  }

  /** Number of indexed targets in the latest parse (keeps the result observable). */
  get indexedTargets(): number {
    return this.latest?.size ?? 0;
  }

  async stop(): Promise<void> {
    this.measuring = false;
    this.clearTimers();
    this.worker?.terminate();
    this.worker = null;
    this.json = null;
    this.latest = null;
    this.inFlight = false;
    this.due = false;
  }
}
