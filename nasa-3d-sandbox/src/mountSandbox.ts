import './embed.css';
import * as bridge from './bridge/sandboxDataBridge.ts';
import type { SandboxMode, SimTelemetryAlertDetail, SimulationControlDetail } from './bridge/copilotContract.ts';
import { SandboxEngine } from './sandbox3d/SandboxEngine.ts';
import { FpsMeter } from './sandbox3d/FpsMeter.ts';
import { parseQualityParam } from './sandbox3d/QualityGovernor.ts';
import { loadOptionalGlb } from './sandbox3d/AssetBuilder.ts';
import { SIMULATED_PRESETS, TelemetryHUD } from './sandbox3d/TelemetryHUD.ts';
import type { StartupTimings } from './bench/types.ts';

export interface MountSandboxOptions {
  /** Hide interactive HUD sliders, presets, FPS meter, and benchmark panel; show compact embed bar instead. */
  readonly embed?: boolean;
  /** Restrict/target `window.postMessage` origin when embedded in an iframe. */
  readonly parentOrigin?: string;
  /** Force a quality level ('auto' or 0..6); defaults to `?quality=` URL query param. */
  readonly quality?: 'auto' | number;
  /** Default simulated preset index when `initialControl` is omitted (default 0). */
  readonly presetIndex?: number;
  /** Optional N1..N7 or 6D initial payload applied before starting the engine. */
  readonly initialControl?: SimulationControlDetail;
  /** Render the minimal non-blocking overlay bar in embed mode (default true). */
  readonly showEmbedBar?: boolean;
}

export interface SandboxMountHandle {
  readonly engine: SandboxEngine;
  readonly bridge: typeof bridge;
  readonly fps: FpsMeter | null;
  readonly hud: TelemetryHUD | null;
  readonly presets: typeof SIMULATED_PRESETS;
  readonly loadOptionalGlb: typeof loadOptionalGlb;
  readonly startup: StartupTimings;
  readonly embed: boolean;
  sendControl(detail: SimulationControlDetail): void;
  destroy(): void;
}

const MODE_LABELS: Readonly<Record<SandboxMode, string>> = {
  ROVER: 'Rover',
  SUIT_EDS: 'Suit · EDS',
  LIDAR_LANDER: 'LiDAR lander',
  ISRU_DRILL: 'ISRU drill',
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Mounts the parametric 3D sandbox into an arbitrary container element (`#app` or Copilot's embedded pane).
 * Safe DOM-only assembly (`createElement` + `textContent`); returns a `destroy()` handle for clean unmounting.
 */
export function mountSandbox(container: HTMLElement, options: MountSandboxOptions = {}): SandboxMountHandle {
  const moduleStartAtMs = performance.now();
  const searchParams = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
  const embed = options.embed ?? searchParams?.get('embed') === '1';
  const parentOrigin = options.parentOrigin ?? searchParams?.get('origin') ?? undefined;

  container.classList.add('sandbox-mount');
  container.classList.toggle('is-embed', embed);

  let viewport = container.querySelector<HTMLElement>('#viewport, .viewport');
  let createdViewport = false;
  if (viewport === null) {
    viewport = el('div', 'viewport');
    container.prepend(viewport);
    createdViewport = true;
  }

  let canvas = viewport.querySelector<HTMLCanvasElement>('#sandbox-canvas, .sandbox-canvas');
  if (canvas === null) {
    canvas = el('canvas', 'sandbox-canvas');
    canvas.setAttribute('aria-label', '3D sandbox view');
    viewport.append(canvas);
  }

  const existingHud = container.querySelector<HTMLElement>('#hud, .hud');
  const existingFps = container.querySelector<HTMLElement>('#fps-box, .fps-box');
  let createdHud = false;
  let createdFps = false;

  if (embed) {
    if (existingHud !== null) existingHud.hidden = true;
    if (existingFps !== null) existingFps.hidden = true;
  } else {
    if (existingHud !== null) existingHud.hidden = false;
    if (existingFps !== null) existingFps.hidden = false;
  }

  const engineConstruct0 = performance.now();
  const engine = new SandboxEngine(canvas, { container: viewport });
  const engineConstructMs = performance.now() - engineConstruct0;
  const unregisterBridge = bridge.registerSandbox(engine, parentOrigin);

  const qualitySetting =
    options.quality !== undefined ? options.quality : parseQualityParam(searchParams?.get('quality') ?? null);
  if (qualitySetting === 'auto') {
    engine.quality.setAuto(true);
  } else if (qualitySetting !== null && Number.isFinite(qualitySetting)) {
    engine.quality.setAuto(false);
    engine.quality.setLevel(qualitySetting);
  }

  let fps: FpsMeter | null = null;
  let hud: TelemetryHUD | null = null;
  let hudRoot: HTMLElement | null = null;
  let fpsRoot: HTMLElement | null = null;

  if (!embed) {
    fpsRoot = existingFps;
    if (fpsRoot === null) {
      fpsRoot = el('div', 'fps-box');
      fpsRoot.setAttribute('role', 'status');
      fpsRoot.setAttribute('aria-label', 'Frame rate');
      container.append(fpsRoot);
      createdFps = true;
    }
    fps = new FpsMeter(fpsRoot);
    engine.setFpsMeter(fps);

    hudRoot = existingHud;
    if (hudRoot === null) {
      hudRoot = el('aside', 'hud');
      hudRoot.setAttribute('aria-label', 'Sandbox controls and telemetry');
      container.append(hudRoot);
      createdHud = true;
    }
    hud = new TelemetryHUD(hudRoot, engine);
    engine.addFrameListener(hud.frameListener);
  }

  if (options.initialControl !== undefined) {
    bridge.handleSimulationControl(options.initialControl);
  } else if (hud !== null) {
    hud.applyPreset(options.presetIndex ?? 0);
  } else {
    const preset = SIMULATED_PRESETS[options.presetIndex ?? 0] ?? SIMULATED_PRESETS[0];
    const v = preset.vector;
    bridge.handleSimulationControl({
      body: preset.body,
      gravity: preset.gravity,
      sunlit: preset.sunlit !== false,
      vector: [v[0], v[1], v[2], v[3], v[4], v[5]],
    });
  }

  let embedBar: HTMLElement | null = null;
  let unsubAlert: (() => void) | null = null;
  let embedFrameListener: (() => void) | null = null;
  let onEmbedControlEvent: (() => void) | null = null;

  if (embed && options.showEmbedBar !== false) {
    embedBar = el('div', 'embed-bar');
    embedBar.setAttribute('role', 'status');
    const worldItem = el('span', 'embed-item');
    const worldDot = el('span', 'embed-dot');
    const worldLabel = el('span', 'embed-world');
    worldItem.append(worldDot, worldLabel);
    const modeLabel = el('span', 'embed-mode');
    const simTag = el('span', 'embed-sim-tag', 'Simulated / Parametric 3D');
    const missingBadge = el('span', 'embed-missing');
    missingBadge.hidden = true;
    const alertBadge = el('span', 'embed-alert');
    alertBadge.hidden = true;
    embedBar.append(worldItem, modeLabel, simTag, missingBadge, alertBadge);
    container.append(embedBar);

    let lastVersion = -1;
    let lastMode: SandboxMode | null = null;
    let lastBody = '';
    let lastSunlit: boolean | null = null;
    let shownAlert: SimTelemetryAlertDetail | null = null;

    const renderAlert = (alert: SimTelemetryAlertDetail | null): void => {
      shownAlert = alert;
      if (alert === null) {
        alertBadge.hidden = true;
        alertBadge.textContent = '';
        return;
      }
      alertBadge.hidden = false;
      alertBadge.className = `embed-alert ${alert.severity === 'red' ? 'is-red' : 'is-yellow'}`;
      alertBadge.textContent = `${alert.code}: ${alert.metric}=${Number.isFinite(alert.value) ? alert.value.toFixed(1) : '--'}`;
    };

    const syncEmbedBar = (): void => {
      const ver = bridge.getVectorVersion();
      const mode = engine.getMode();
      const body = engine.getBody();
      const sunlit = engine.isSunlit();
      if (ver === lastVersion && mode === lastMode && body === lastBody && sunlit === lastSunlit) return;

      if (ver !== lastVersion || mode !== lastMode) {
        if (shownAlert !== null && shownAlert.mode !== mode) renderAlert(null);
      }
      lastVersion = ver;
      lastMode = mode;
      lastBody = body;
      lastSunlit = sunlit;

      const worldText = body.toUpperCase();
      worldLabel.textContent = sunlit ? worldText : `${worldText} · PSR`;
      worldDot.className = `embed-dot is-${body}${sunlit ? '' : ' is-psr'}`;
      modeLabel.textContent = MODE_LABELS[mode];

      const missing = bridge.siteState.missingVars;
      if (missing.length > 0) {
        missingBadge.hidden = false;
        missingBadge.textContent = `Missing: ${missing.join(', ')}`;
      } else {
        missingBadge.hidden = true;
        missingBadge.textContent = '';
      }
    };

    syncEmbedBar();
    unsubAlert = bridge.addAlertListener((alert) => renderAlert(alert));
    embedFrameListener = syncEmbedBar;
    engine.addFrameListener(embedFrameListener);
    if (typeof window !== 'undefined') {
      onEmbedControlEvent = syncEmbedBar;
      window.addEventListener(bridge.SIMULATION_CONTROL_EVENT, onEmbedControlEvent);
      window.addEventListener(bridge.COPILOT_COMMAND_EVENT, onEmbedControlEvent);
    }
  }

  const engineStart0 = performance.now();
  engine.start();
  const engineStartMs = performance.now() - engineStart0;
  const startSynthMs = engine.synthTimings.totalMs;

  const startup: StartupTimings = {
    moduleStartAtMs,
    engineConstructMs,
    engineStartMs,
    startSynthMs,
    compileApproxMs: Math.max(0, engineStartMs - startSynthMs),
    firstFrameAtMs: null,
    firstFrameCpuMs: null,
  };

  // One-shot listener, registered last so removing it never skips another listener.
  const firstFrameListener = (): void => {
    if (startup.firstFrameAtMs !== null) return;
    startup.firstFrameAtMs = performance.now();
    startup.firstFrameCpuMs = engine.timings.cpuMs;
    if (typeof window !== 'undefined') {
      window.setTimeout(() => engine.removeFrameListener(firstFrameListener), 0);
    } else {
      engine.removeFrameListener(firstFrameListener);
    }
  };
  engine.addFrameListener(firstFrameListener);

  return {
    engine,
    bridge,
    fps,
    hud,
    presets: SIMULATED_PRESETS,
    loadOptionalGlb,
    startup,
    embed,
    sendControl(detail: SimulationControlDetail): void {
      bridge.handleSimulationControl(detail);
    },
    destroy(): void {
      engine.removeFrameListener(firstFrameListener);
      if (embedFrameListener !== null) engine.removeFrameListener(embedFrameListener);
      if (hud !== null) engine.removeFrameListener(hud.frameListener);
      if (onEmbedControlEvent !== null && typeof window !== 'undefined') {
        window.removeEventListener(bridge.SIMULATION_CONTROL_EVENT, onEmbedControlEvent);
        window.removeEventListener(bridge.COPILOT_COMMAND_EVENT, onEmbedControlEvent);
      }
      unsubAlert?.();
      hud?.dispose();
      unregisterBridge();
      engine.dispose();
      if (embedBar !== null) embedBar.remove();
      if (createdHud && hudRoot !== null) hudRoot.remove();
      if (createdFps && fpsRoot !== null) fpsRoot.remove();
      if (createdViewport && viewport !== null) viewport.remove();
      container.classList.remove('sandbox-mount', 'is-embed');
    },
  };
}
