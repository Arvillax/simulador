/// SIMULATED similarity engine running inside a dedicated Web Worker (module worker).
import { SearchKernel, generateDataset } from './searchEngine.ts';
import type { SearchWorkerRequest, SearchWorkerResponse } from './searchEngine.ts';

/** Minimal typing of the dedicated worker scope (the project's tsconfig only loads the DOM lib). */
interface WorkerScope {
  postMessage(message: SearchWorkerResponse, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<SearchWorkerRequest>) => void): void;
}

const scope = self as unknown as WorkerScope;
let kernel: SearchKernel | null = null;

scope.addEventListener('message', (event) => {
  const msg = event.data;
  try {
    if (msg.type === 'init') {
      const t0 = performance.now();
      const values = generateDataset(msg.cells, msg.seed, msg.nanFraction);
      kernel = new SearchKernel(values, msg.k);
      scope.postMessage({ type: 'ready', genMs: performance.now() - t0, bytes: values.byteLength });
    } else if (msg.type === 'query') {
      if (kernel === null) throw new Error('query before init');
      const t0 = performance.now();
      const count = kernel.query(msg.target, msg.weights);
      const computeMs = performance.now() - t0;
      const top = kernel.indices.slice(0, count);
      scope.postMessage({ type: 'result', id: msg.id, computeMs, count, top }, [top.buffer]);
    }
  } catch (error) {
    scope.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
});
