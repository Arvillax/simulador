import type { SandboxEngine, SandboxMode } from './SandboxEngine.ts';
import { SANDBOX_MODES } from './SandboxEngine.ts';
import { bodyFromGravity } from './BodyLook.ts';
import type { Body } from './BodyLook.ts';
import {
  SIMULATION_CONTROL_EVENT,
  VECTOR_RANGES,
  etlVector,
  getSiteSeed,
  getVectorVersion,
  handleSimulationControl,
  updateSandboxTerrain,
} from '../bridge/sandboxDataBridge.ts';

export interface SimulatedPreset {
  readonly id: string;
  readonly label: string;
  /** [slope, tri, thermalInertia, albedo, tempK, ndvi]. */
  readonly vector: readonly [number, number, number, number, number, number];
  readonly gravity: number;
  /** World whose look (sky, sun, fill, regolith hue) the scene takes. */
  readonly body: Body;
  /** False for permanently shadowed sites: no direct sun, dim cold fill, shadows off. Default true. */
  readonly sunlit?: boolean;
}

/** Simulated values for testing the sandbox. They are NOT taken from any dataset. */
export const SIMULATED_PRESETS: readonly SimulatedPreset[] = [
  { id: 'moon-ridge', label: 'Moon · south-pole ridge', vector: [16, 0.72, 0.28, 0.14, 255, 0.0], gravity: 1.62, body: 'moon' },
  { id: 'moon-psr', label: 'Moon · shadowed crater floor', vector: [6, 0.35, 0.1, 0.12, 45, 0.0], gravity: 1.62, body: 'moon', sunlit: false },
  { id: 'mars-jezero', label: 'Mars · Jezero delta', vector: [8, 0.45, 0.35, 0.22, 220, 0.0], gravity: 3.71, body: 'mars' },
  { id: 'mars-meridiani', label: 'Mars · Meridiani plains', vector: [2, 0.15, 0.4, 0.18, 230, 0.0], gravity: 3.71, body: 'mars' },
  { id: 'earth-atacama', label: 'Earth · Atacama', vector: [5, 0.3, 0.55, 0.3, 300, 0.03], gravity: 9.81, body: 'earth' },
  { id: 'earth-svalbard', label: 'Earth · Svalbard permafrost', vector: [12, 0.55, 0.6, 0.4, 258, 0.04], gravity: 9.81, body: 'earth' },
  { id: 'earth-lanzarote', label: 'Earth · Lanzarote basalt', vector: [9, 0.8, 0.75, 0.1, 295, 0.06], gravity: 9.81, body: 'earth' },
  { id: 'earth-devon', label: 'Earth · Devon Island', vector: [10, 0.5, 0.65, 0.2, 255, 0.02], gravity: 9.81, body: 'earth' },
  { id: 'stress', label: 'Stress · worst case', vector: [45, 1.0, 0.0, 0.05, 400, 0.2], gravity: 9.81, body: 'earth' },
];

const GRAVITY_OPTIONS: ReadonlyArray<readonly [string, number]> = [
  ['Moon · 1.62 m/s²', 1.62],
  ['Mars · 3.71 m/s²', 3.71],
  ['Earth · 9.81 m/s²', 9.81],
];

const MODE_LABELS: Record<SandboxMode, string> = {
  ROVER: 'Rover',
  SUIT_EDS: 'Suit · EDS',
  LIDAR_LANDER: 'LiDAR lander',
  ISRU_DRILL: 'ISRU drill',
};

interface SliderSpec {
  readonly label: string;
  readonly unit: string;
  readonly step: number;
  readonly digits: number;
}

const SLIDERS: readonly SliderSpec[] = [
  { label: 'Slope', unit: '°', step: 0.5, digits: 1 },
  { label: 'Roughness (TRI)', unit: '', step: 0.01, digits: 2 },
  { label: 'Thermal inertia', unit: '', step: 0.01, digits: 2 },
  { label: 'Albedo', unit: '', step: 0.01, digits: 2 },
  { label: 'Surface temperature', unit: 'K', step: 1, digits: 0 },
  { label: 'NDVI', unit: '', step: 0.01, digits: 2 },
];

const HUD_INTERVAL_MS = 200; // 5 Hz

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

interface ModePanel {
  readonly root: HTMLElement;
  readonly values: HTMLElement[];
}

/**
 * Overlay panel: mode selector, EDS pulse, pause/resume, simulated presets, the six vector sliders, seed, gravity,
 * live telemetry cards (refreshed at 5 Hz) and the latest synthesis timings.
 */
export class TelemetryHUD {
  /** Bound once; register with engine.addFrameListener. */
  readonly frameListener: (nowMs: number) => void;
  private readonly engine: SandboxEngine;
  private readonly modeButtons = new Map<SandboxMode, HTMLButtonElement>();
  private readonly panels = new Map<SandboxMode, ModePanel>();
  private readonly sliders: HTMLInputElement[] = [];
  private readonly sliderOutputs: HTMLOutputElement[] = [];
  private readonly seedInput: HTMLInputElement;
  private readonly gravitySelect: HTMLSelectElement;
  private readonly presetSelect: HTMLSelectElement;
  private readonly pauseButton: HTMLButtonElement;
  private readonly synthLine: HTMLElement;
  private readonly noteLine: HTMLElement;
  private lastRefreshMs = -Infinity;
  private shownMode: SandboxMode | null = null;
  private shownVersion = -1;

  constructor(root: HTMLElement, engine: SandboxEngine) {
    this.engine = engine;
    root.classList.add('hud');
    root.replaceChildren();

    const header = el('header', 'hud-header');
    header.append(el('h1', 'hud-title', 'NASA 3D Sandbox'), el('p', 'hud-subtitle', 'Parametric digital twin · one canvas, four modes'));

    // Modes
    const modeSection = el('section', 'hud-section');
    modeSection.append(el('h2', 'hud-heading', 'Mode'));
    const modeGrid = el('div', 'hud-mode-grid');
    for (const mode of SANDBOX_MODES) {
      const button = el('button', 'hud-button hud-mode', MODE_LABELS[mode]);
      button.type = 'button';
      button.addEventListener('click', () => {
        handleSimulationControl({ mode });
        this.syncMode();
      });
      this.modeButtons.set(mode, button);
      modeGrid.append(button);
    }
    modeSection.append(modeGrid);

    const actions = el('div', 'hud-actions');
    const edsButton = el('button', 'hud-button hud-accent', 'EDS pulse');
    edsButton.type = 'button';
    edsButton.addEventListener('click', () => handleSimulationControl({ action: 'PULSE_EDS' }));
    this.pauseButton = el('button', 'hud-button', 'Pause');
    this.pauseButton.type = 'button';
    this.pauseButton.addEventListener('click', () => {
      handleSimulationControl({ action: this.engine.isPaused() ? 'RESUME' : 'PAUSE' });
      this.syncPause();
    });
    actions.append(edsButton, this.pauseButton);
    modeSection.append(actions);

    // Inputs
    const inputSection = el('section', 'hud-section');
    inputSection.append(el('h2', 'hud-heading', 'Site vector'));
    inputSection.append(el('p', 'hud-sim-note', 'Simulated values — not from datasets'));
    const presetLabel = el('label', 'hud-field');
    presetLabel.append(el('span', 'hud-field-label', 'Preset'));
    this.presetSelect = el('select', 'hud-select');
    this.presetSelect.append(new Option('Custom', ''));
    SIMULATED_PRESETS.forEach((p, i) => this.presetSelect.append(new Option(p.label, String(i))));
    this.presetSelect.addEventListener('change', () => {
      const index = Number(this.presetSelect.value);
      if (this.presetSelect.value !== '' && Number.isInteger(index)) this.applyPreset(index);
    });
    presetLabel.append(this.presetSelect);
    inputSection.append(presetLabel);

    SLIDERS.forEach((spec, i) => {
      const [min, max] = VECTOR_RANGES[i];
      const field = el('label', 'hud-slider');
      const head = el('span', 'hud-slider-head');
      const output = el('output', 'hud-slider-value');
      head.append(el('span', 'hud-field-label', spec.label), output);
      const input = el('input', 'hud-range');
      input.type = 'range';
      input.min = String(min);
      input.max = String(max);
      input.step = String(spec.step);
      input.value = String(etlVector[i]);
      input.addEventListener('input', () => {
        this.presetSelect.value = '';
        this.writeSliderLabel(i);
        this.pushVector();
      });
      field.append(head, input);
      inputSection.append(field);
      this.sliders.push(input);
      this.sliderOutputs.push(output);
    });

    const row = el('div', 'hud-row');
    const seedLabel = el('label', 'hud-field');
    seedLabel.append(el('span', 'hud-field-label', 'Site seed'));
    this.seedInput = el('input', 'hud-number');
    this.seedInput.type = 'number';
    this.seedInput.step = '1';
    this.seedInput.value = String(getSiteSeed());
    this.seedInput.addEventListener('change', () => {
      this.presetSelect.value = '';
      this.pushVector();
    });
    seedLabel.append(this.seedInput);
    const gravityLabel = el('label', 'hud-field');
    gravityLabel.append(el('span', 'hud-field-label', 'Gravity'));
    this.gravitySelect = el('select', 'hud-select');
    for (const [label, g] of GRAVITY_OPTIONS) this.gravitySelect.append(new Option(label, String(g)));
    this.gravitySelect.addEventListener('change', () => {
      this.presetSelect.value = '';
      const g = Number(this.gravitySelect.value);
      // The bridge switches the look with the gravity but resets "sunlit"; keep what the current preset says.
      const sunlit = this.engine.isSunlit();
      handleSimulationControl({ gravity: g });
      this.engine.setBody(bodyFromGravity(g), { sunlit });
    });
    gravityLabel.append(this.gravitySelect);
    row.append(seedLabel, gravityLabel);
    inputSection.append(row);

    // Telemetry
    const telemetrySection = el('section', 'hud-section');
    telemetrySection.append(el('h2', 'hud-heading', 'Telemetry'));
    for (const mode of SANDBOX_MODES) {
      const solver = engine.solvers[mode];
      const grid = el('div', 'hud-cards');
      const values: HTMLElement[] = [];
      for (const f of solver.fields) {
        const card = el('div', 'hud-card');
        const value = el('span', 'hud-card-value', '--');
        const valueRow = el('span', 'hud-card-row');
        valueRow.append(value);
        if (f.unit) valueRow.append(el('span', 'hud-card-unit', f.unit));
        card.append(el('span', 'hud-card-label', f.label), valueRow);
        grid.append(card);
        values.push(value);
      }
      grid.hidden = true;
      telemetrySection.append(grid);
      this.panels.set(mode, { root: grid, values });
    }
    this.noteLine = el('p', 'hud-note');
    this.synthLine = el('p', 'hud-synth');
    telemetrySection.append(this.noteLine, this.synthLine);

    root.append(header, modeSection, inputSection, telemetrySection);

    this.frameListener = (nowMs: number) => this.onFrame(nowMs);
    // External control events may change mode or pause state while no frame runs.
    window.addEventListener(SIMULATION_CONTROL_EVENT, () => {
      this.syncMode();
      this.syncPause();
    });
    this.syncFromVector();
    this.syncMode();
  }

  /** Applies a simulated preset (vector + gravity) through the bridge. */
  applyPreset(index: number): void {
    const preset = SIMULATED_PRESETS[index];
    if (preset === undefined) return;
    this.presetSelect.value = String(index);
    this.gravitySelect.value = String(preset.gravity);
    const v = preset.vector;
    handleSimulationControl({ gravity: preset.gravity });
    this.engine.setBody(preset.body, { sunlit: preset.sunlit !== false });
    updateSandboxTerrain(v[0], v[1], v[2], v[3], v[4], v[5], Number(this.seedInput.value) || getSiteSeed());
    this.syncFromVector();
  }

  private pushVector(): void {
    const s = this.sliders;
    const seed = Math.trunc(Number(this.seedInput.value));
    updateSandboxTerrain(
      Number(s[0].value),
      Number(s[1].value),
      Number(s[2].value),
      Number(s[3].value),
      Number(s[4].value),
      Number(s[5].value),
      Number.isFinite(seed) ? seed : getSiteSeed(),
    );
  }

  private writeSliderLabel(i: number): void {
    const spec = SLIDERS[i];
    const value = Number(this.sliders[i].value).toFixed(spec.digits);
    this.sliderOutputs[i].textContent = spec.unit ? `${value} ${spec.unit}` : value;
  }

  private syncFromVector(): void {
    this.shownVersion = getVectorVersion();
    for (let i = 0; i < this.sliders.length; i++) {
      this.sliders[i].value = String(etlVector[i]);
      this.writeSliderLabel(i);
    }
    if (document.activeElement !== this.seedInput) this.seedInput.value = String(getSiteSeed());
    const g = this.engine.getGravity();
    const options = this.gravitySelect.options;
    for (let i = 0; i < options.length; i++) {
      if (Math.abs(Number(options[i].value) - g) < 1e-6) this.gravitySelect.selectedIndex = i;
    }
  }

  private syncMode(): void {
    const mode = this.engine.getMode();
    if (mode === this.shownMode) return;
    this.shownMode = mode;
    for (const [m, button] of this.modeButtons) {
      button.classList.toggle('is-active', m === mode);
      button.setAttribute('aria-pressed', String(m === mode));
    }
    for (const [m, panel] of this.panels) panel.root.hidden = m !== mode;
    this.noteLine.textContent = this.engine.solvers[mode].note;
  }

  private syncPause(): void {
    this.pauseButton.textContent = this.engine.isPaused() ? 'Resume' : 'Pause';
  }

  /** Text updates at 5 Hz; the early return keeps the other frames allocation-free. */
  private onFrame(nowMs: number): void {
    if (nowMs - this.lastRefreshMs < HUD_INTERVAL_MS) return;
    this.lastRefreshMs = nowMs;
    if (getVectorVersion() !== this.shownVersion) this.syncFromVector();
    this.syncMode();
    this.syncPause();
    const mode = this.engine.getMode();
    const solver = this.engine.solvers[mode];
    const panel = this.panels.get(mode);
    if (panel !== undefined) {
      const telemetry = solver.telemetry;
      const fields = solver.fields;
      for (let i = 0; i < fields.length; i++) {
        const field = fields[i];
        const value = telemetry[field.key];
        panel.values[i].textContent = field.text !== undefined ? (field.text[Math.round(value)] ?? '--') : value.toFixed(field.digits);
      }
    }
    const s = this.engine.synthTimings;
    this.synthLine.textContent =
      `Last synthesis ${s.totalMs.toFixed(2)} ms · noise ${s.noiseMs.toFixed(2)} · normals ${s.normalsMs.toFixed(2)}` +
      ` · BVH ${s.bvhMs.toFixed(2)} · rocks ${s.rocksMs.toFixed(2)} (${s.rockCount} rocks)`;
  }
}
