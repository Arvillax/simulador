/// SIMULATED ETL file handling inside a Web Worker: the worker owns the metrics.json text, parses it on request
/// and posts the parsed object back (the structured-clone deserialisation then runs on the main thread).
import { buildMetricsJson } from './metricsGenerator.ts';
import type { MetricsFile } from './metricsGenerator.ts';

export interface EtlBuildMessage {
  type: 'build';
  bytes: number;
  seed: number;
}

export interface EtlParseMessage {
  type: 'parse';
  id: number;
}

export type EtlWorkerRequest = EtlBuildMessage | EtlParseMessage;

export interface EtlReadyMessage {
  type: 'ready';
  buildMs: number;
  bytes: number;
  targets: number;
  analogs: number;
}

export interface EtlParsedMessage {
  type: 'parsed';
  id: number;
  parseMs: number;
  /** performance.timeOrigin + performance.now() in the worker right before postMessage. */
  sentAbs: number;
  payload: MetricsFile;
}

export interface EtlErrorMessage {
  type: 'error';
  message: string;
}

export type EtlWorkerResponse = EtlReadyMessage | EtlParsedMessage | EtlErrorMessage;

interface WorkerScope {
  postMessage(message: EtlWorkerResponse): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<EtlWorkerRequest>) => void): void;
}

const scope = self as unknown as WorkerScope;
let json: string | null = null;

scope.addEventListener('message', (event) => {
  const msg = event.data;
  try {
    if (msg.type === 'build') {
      const t0 = performance.now();
      const out = buildMetricsJson(msg.bytes, msg.seed);
      json = out.json;
      scope.postMessage({
        type: 'ready',
        buildMs: performance.now() - t0,
        bytes: out.bytes,
        targets: out.targets,
        analogs: out.analogs,
      });
    } else if (msg.type === 'parse') {
      if (json === null) throw new Error('parse before build');
      const t0 = performance.now();
      const payload = JSON.parse(json) as MetricsFile;
      const parseMs = performance.now() - t0;
      scope.postMessage({ type: 'parsed', id: msg.id, parseMs, sentAbs: performance.timeOrigin + performance.now(), payload });
    }
  } catch (error) {
    scope.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
});
