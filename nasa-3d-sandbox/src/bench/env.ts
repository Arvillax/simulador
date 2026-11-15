import type { SandboxEngine } from '../sandbox3d/SandboxEngine.ts';
import type { BenchEnvironment, StartupTimings, WebGlInfo } from './types.ts';
import { longTaskSupport } from './LongTaskProbe.ts';
import { percentile, sortedCopy } from './stats.ts';

type NavigatorWithMemory = Navigator & { deviceMemory?: number };
type PerformanceWithMemory = Performance & { memory?: { usedJSHeapSize: number } };

/** Used JS heap in decimal MB (Chromium only, quantised unless precise memory info is enabled). */
export function heapMB(): number | null {
  const mem = (performance as PerformanceWithMemory).memory;
  return mem === undefined ? null : mem.usedJSHeapSize / 1e6;
}

function webglInfo(gl: WebGLRenderingContext | WebGL2RenderingContext): WebGlInfo {
  const version = gl.getParameter(gl.VERSION) as string | null;
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  if (debug !== null) {
    return {
      version,
      renderer: gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) as string | null,
      vendor: gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) as string | null,
      unmasked: true,
    };
  }
  return {
    version,
    renderer: gl.getParameter(gl.RENDERER) as string | null,
    vendor: gl.getParameter(gl.VENDOR) as string | null,
    unmasked: false,
  };
}

/** Median rAF interval over `durationMs` (no other rAF work should run meanwhile). */
export function measureRafInterval(durationMs = 1000): Promise<number | null> {
  return new Promise((resolve) => {
    const deltas: number[] = [];
    let first = -1;
    let last = -1;
    const step = (now: number): void => {
      if (first < 0) first = now;
      if (last >= 0) deltas.push(now - last);
      last = now;
      if (now - first < durationMs) requestAnimationFrame(step);
      else resolve(deltas.length > 0 ? percentile(sortedCopy(deltas), 50) : null);
    };
    requestAnimationFrame(step);
  });
}

export async function captureEnvironment(
  engine: SandboxEngine,
  startup: StartupTimings | null,
  gpuTimerAvailable: boolean,
): Promise<BenchEnvironment> {
  // Pause the sandbox so the rAF cadence reflects the display, not the sandbox frame cost.
  const wasPaused = engine.isPaused();
  if (!wasPaused) engine.pause();
  const medianRafMs = await measureRafInterval(1000);
  if (!wasPaused) engine.resume();

  const renderer = engine.renderer;
  const gl = renderer.getContext();
  const canvas = renderer.domElement;
  const nav = navigator as NavigatorWithMemory;
  const support = longTaskSupport();
  const quality = engine.quality.getState();
  return {
    capturedAt: new Date().toISOString(),
    build: import.meta.env.DEV ? 'dev' : 'production',
    userAgent: nav.userAgent,
    hardwareConcurrency: nav.hardwareConcurrency ?? null,
    deviceMemoryGB: nav.deviceMemory ?? null,
    devicePixelRatio: window.devicePixelRatio,
    effectivePixelRatio: renderer.getPixelRatio(),
    qualityLevel: quality.level,
    renderScale: quality.renderScale,
    shadowMapSize: quality.shadowMapSize,
    viewportCss: { width: window.innerWidth, height: window.innerHeight },
    canvasCss: { width: canvas.clientWidth, height: canvas.clientHeight },
    drawingBuffer: { width: gl.drawingBufferWidth, height: gl.drawingBufferHeight },
    webgl: webglInfo(gl),
    gpuTimerAvailable,
    estimatedRefreshHz: medianRafMs !== null && medianRafMs > 0 ? 1000 / medianRafMs : null,
    medianRafMs,
    longTaskSupported: support.longtask,
    loafSupported: support.loaf,
    performanceMemory: heapMB() !== null,
    crossOriginIsolated: window.crossOriginIsolated === true,
    startup: startup === null ? null : { ...startup },
  };
}
