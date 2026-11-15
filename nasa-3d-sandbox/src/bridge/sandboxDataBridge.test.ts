import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Body } from '../sandbox3d/BodyLook.ts';
import type { SandboxMode, SimTelemetryAlertDetail } from './copilotContract.ts';
import {
  COPILOT_COMMAND_EVENT,
  SIMULATION_CONTROL_EVENT,
  SIM_TELEMETRY_ALERT_EVENT,
  addAlertListener,
  emitTelemetryAlert,
  etlVector,
  getTelemetrySnapshot,
  handleSimulationControl,
  registerSandbox,
  siteState,
  unregisterSandbox,
  updateSandboxTerrain,
} from './sandboxDataBridge.ts';
import type { ControllableSandboxEngine } from './sandboxDataBridge.ts';

interface FakeEngineState {
  mode: SandboxMode;
  body: Body;
  sunlit: boolean;
  gravity: number;
  paused: boolean;
  lastSynthSeed: number | null;
  synthCount: number;
  counts: {
    pulseEds: number;
    resetDust: number;
    retractDrillBite: number;
    boostDrillWob: number;
  };
  engine: ControllableSandboxEngine;
}

function createFakeEngine(initialBody: Body = 'moon'): FakeEngineState {
  const state: FakeEngineState = {
    mode: 'ROVER',
    body: initialBody,
    sunlit: true,
    gravity: initialBody === 'moon' ? 1.62 : initialBody === 'mars' ? 3.71 : 9.81,
    paused: false,
    lastSynthSeed: null,
    synthCount: 0,
    counts: {
      pulseEds: 0,
      resetDust: 0,
      retractDrillBite: 0,
      boostDrillWob: 0,
    },
    engine: undefined as unknown as ControllableSandboxEngine,
  };

  state.engine = {
    solvers: {
      ROVER: { telemetry: { slopeDeg: 16, slipPct: 12, tractionMarginPct: 45, sinkageMm: 18, speedMs: 0.1 } },
      SUIT_EDS: { telemetry: { obscurationPct: 4, panelW: 245, sols: 12 } },
      LIDAR_LANDER: { telemetry: { safePct: 88, hazardPct: 12, opticalBlindPct: 0 } },
      ISRU_DRILL: { telemetry: { depthCm: 22, torqueNm: 6.5, powerW: 92, wobN: 100 } },
    },
    requestSynthesis(seed: number) {
      state.lastSynthSeed = seed;
      state.synthCount++;
    },
    getGravity() {
      return state.gravity;
    },
    setGravity(g: number) {
      state.gravity = g;
    },
    getBody() {
      return state.body;
    },
    isSunlit() {
      return state.sunlit;
    },
    setBody(body: Body, options?: { sunlit?: boolean }) {
      state.body = body;
      if (options?.sunlit !== undefined) state.sunlit = options.sunlit;
    },
    getMode() {
      return state.mode;
    },
    setMode(mode: SandboxMode) {
      state.mode = mode;
    },
    pulseEds() {
      state.counts.pulseEds++;
    },
    resetDust() {
      state.counts.resetDust++;
    },
    retractDrillBite() {
      state.counts.retractDrillBite++;
    },
    boostDrillWob() {
      state.counts.boostDrillWob++;
    },
    pause() {
      state.paused = true;
    },
    resume() {
      state.paused = false;
    },
  };
  return state;
}

describe('sandboxDataBridge', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    unregisterSandbox();
    updateSandboxTerrain(16, 0.72, 0.28, 0.14, 255, 0.02, 1);
  });

  afterEach(() => {
    unregisterSandbox();
    vi.unstubAllGlobals();
  });

  it('maps 7-var N1..N7 vector and Mars gravity / profiles cleanly', () => {
    const fake = createFakeEngine('moon');
    registerSandbox(fake.engine);

    handleSimulationControl({
      mode: 'LIDAR_LANDER',
      targetBody: 'MARS',
      lidarProfile: 'M2020',
      roverProfile: 'PERSEVERANCE',
      vector: [12.5, 0.175, 0.6, 59, 32, Number.NaN, 0.35],
      surfaceTempK: 225,
      ndvi: 0.4, // must be forced to 0 on Mars per ADR-003
      seed: 42,
    });

    expect(fake.mode).toBe('LIDAR_LANDER');
    expect(fake.body).toBe('mars');
    expect(fake.gravity).toBeCloseTo(3.71, 2);
    expect(fake.lastSynthSeed).toBe(42);
    expect(siteState.hasN1ToN7).toBe(true);
    expect(siteState.lidarProfile).toBe('M2020');
    expect(siteState.roverProfile).toBe('PERSEVERANCE');
    expect(siteState.silicaPct).toBe(59);
    expect(siteState.saltationTimeFrac).toBe(0.35);
    expect(siteState.missingVars).toEqual([]);
    expect(etlVector[0]).toBeCloseTo(12.5, 5);
    expect(etlVector[1]).toBeCloseTo(0.5, 5); // 0.175 / 0.35
    expect(etlVector[4]).toBeCloseTo(225, 5);
    expect(etlVector[5]).toBe(0);
  });

  it('derives Mars when only gravity=3.72 is provided with n1ToN7 and records missing fields neutrally', () => {
    const fake = createFakeEngine('moon');
    registerSandbox(fake.engine);

    handleSimulationControl({
      gravity: 3.72,
      n1ToN7: [8, 0.05, 0.2, 50, 20, 0, Number.NaN], // N7 missing, surfaceTempK missing
    });

    expect(fake.body).toBe('mars');
    expect(fake.gravity).toBeCloseTo(3.72, 2);
    expect(siteState.missingVars).toEqual(['N7', 'surfaceTempK']);
    // Neutral non-frozen fallback so missing temperature never fabricates permafrost ice (< 265 K)
    expect(etlVector[4]).toBe(280);
  });

  it('applies what-if overrides (including Moon N6=0 PSR darkness) and resets stale N1..N7 on 6D updates', () => {
    const fake = createFakeEngine('moon');
    registerSandbox(fake.engine);

    handleSimulationControl({
      analog: {
        body: 'moon',
        n1SlopeDeg: 5,
        n2RoughnessRmsM: 0.08,
        n3ReliefM: 0.2,
        n4SilicaPct: 68,
        n5DiurnalTempK: 35,
        n6SolarIllumFrac: 0.8,
        surfaceTempK: 130,
      },
    });
    expect(fake.sunlit).toBe(true);

    // Override N6 to 0 => permanently shadowed crater floor (PSR)
    handleSimulationControl({ whatIf: { variable: 'N6', newValue: 0 } });
    expect(siteState.solarIllumFrac).toBe(0);
    expect(siteState.sunlit).toBe(false);
    expect(fake.sunlit).toBe(false);

    // Returning to legacy 6D vector must clear stale N4 silica & N6/N7
    handleSimulationControl({ vector: [10, 0.3, 0.5, 0.2, 250, 0.01] });
    expect(siteState.hasN1ToN7).toBe(false);
    expect(Number.isNaN(siteState.silicaPct)).toBe(true);
    expect(siteState.missingVars).toEqual([]);
  });

  it('routes Copilot remediation actions and pause/resume to the engine', () => {
    const fake = createFakeEngine('moon');
    registerSandbox(fake.engine);

    handleSimulationControl({ action: 'PULSE_EDS' });
    handleSimulationControl({ action: 'RESET_DUST' });
    handleSimulationControl({ action: 'RETRACT_DRILL_BITE' });
    handleSimulationControl({ action: 'BOOST_DRILL_WOB' });
    handleSimulationControl({ action: 'PAUSE' });
    expect(fake.paused).toBe(true);
    handleSimulationControl({ action: 'RESUME' });
    expect(fake.paused).toBe(false);

    expect(fake.counts).toEqual({
      pulseEds: 1,
      resetDust: 1,
      retractDrillBite: 1,
      boostDrillWob: 1,
    });
  });

  it('deduplicates threshold alerts by cooldown, dispatches CustomEvent + postMessage, and validates incoming origin', () => {
    const listeners = new Map<string, Array<(ev: unknown) => void>>();
    const dispatched: Array<{ type: string; detail: SimTelemetryAlertDetail }> = [];
    const posted: Array<{ data: unknown; origin: string }> = [];

    class FakeCustomEvent<T = unknown> {
      readonly type: string;
      readonly detail: T;
      constructor(type: string, init?: { detail?: T }) {
        this.type = type;
        this.detail = init?.detail as T;
      }
    }

    const fakeParent = {
      postMessage(data: unknown, origin: string) {
        posted.push({ data, origin });
      },
    };

    const fakeWindow = {
      parent: fakeParent,
      addEventListener(type: string, fn: (ev: unknown) => void) {
        const list = listeners.get(type) ?? [];
        list.push(fn);
        listeners.set(type, list);
      },
      removeEventListener(type: string, fn: (ev: unknown) => void) {
        const list = listeners.get(type) ?? [];
        const idx = list.indexOf(fn);
        if (idx >= 0) list.splice(idx, 1);
      },
      dispatchEvent(ev: FakeCustomEvent<SimTelemetryAlertDetail>) {
        dispatched.push({ type: ev.type, detail: ev.detail });
        return true;
      },
    };

    vi.stubGlobal('CustomEvent', FakeCustomEvent);
    vi.stubGlobal('window', fakeWindow);

    const fake = createFakeEngine('moon');
    const seenBySubscriber: SimTelemetryAlertDetail[] = [];
    const unsub = addAlertListener((a) => seenBySubscriber.push(a));
    registerSandbox(fake.engine, 'https://copilot.nasa.test');

    const emitted1 = emitTelemetryAlert(
      {
        code: 'DRILL_TORQUE_STALL',
        mode: 'ISRU_DRILL',
        body: 'moon',
        severity: 'red',
        message: 'Stall reached',
        metric: 'torque_nm',
        value: 16.4,
        threshold: 16.0,
        suggestedAction: 'RETRACT_DRILL_BITE',
      },
      1000,
    );
    // Same code+severity inside 1500 ms cooldown must be suppressed
    const emitted2 = emitTelemetryAlert(
      {
        code: 'DRILL_TORQUE_STALL',
        mode: 'ISRU_DRILL',
        body: 'moon',
        severity: 'red',
        message: 'Stall reached',
        metric: 'torque_nm',
        value: 16.6,
        threshold: 16.0,
        suggestedAction: 'RETRACT_DRILL_BITE',
      },
      1800,
    );
    // After cooldown expires, it emits again
    const emitted3 = emitTelemetryAlert(
      {
        code: 'DRILL_TORQUE_STALL',
        mode: 'ISRU_DRILL',
        body: 'moon',
        severity: 'red',
        message: 'Stall reached',
        metric: 'torque_nm',
        value: 16.8,
        threshold: 16.0,
        suggestedAction: 'RETRACT_DRILL_BITE',
      },
      2600,
    );

    expect(emitted1).toBe(true);
    expect(emitted2).toBe(false);
    expect(emitted3).toBe(true);
    expect(seenBySubscriber).toHaveLength(2);
    expect(dispatched.filter((d) => d.type === SIM_TELEMETRY_ALERT_EVENT)).toHaveLength(2);
    expect(posted).toHaveLength(2);
    expect(posted[0].origin).toBe('https://copilot.nasa.test');

    // Incoming postMessage from untrusted origin must be ignored; trusted origin must be applied
    const msgListeners = listeners.get('message') ?? [];
    expect(msgListeners).toHaveLength(1);
    msgListeners[0]({
      origin: 'https://evil.example',
      source: fakeParent,
      data: { type: COPILOT_COMMAND_EVENT, detail: { mode: 'ISRU_DRILL' } },
    });
    expect(fake.mode).toBe('ROVER');

    msgListeners[0]({
      origin: 'https://copilot.nasa.test',
      source: fakeParent,
      data: { type: COPILOT_COMMAND_EVENT, detail: { mode: 'ISRU_DRILL', action: 'RETRACT_DRILL_BITE' } },
    });
    expect(fake.mode).toBe('ISRU_DRILL');
    expect(fake.counts.retractDrillBite).toBe(1);

    const snap = getTelemetrySnapshot();
    expect(snap?.mode).toBe('ISRU_DRILL');
    expect(snap?.lastAlert?.code).toBe('DRILL_TORQUE_STALL');

    unsub();
    unregisterSandbox();
    expect(listeners.get(SIMULATION_CONTROL_EVENT) ?? []).toHaveLength(0);
    expect(listeners.get(COPILOT_COMMAND_EVENT) ?? []).toHaveLength(0);
    expect(listeners.get('message') ?? []).toHaveLength(0);
  });
});
