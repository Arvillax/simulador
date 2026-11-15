import { defineConfig } from 'vite';

export default defineConfig({
  // Module workers (searchWorker.ts, etlWorker.ts) import shared code; emit them as ES modules.
  worker: { format: 'es' },
});
