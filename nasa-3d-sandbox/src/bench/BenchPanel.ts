import type { BenchReport, BenchState, StepResult } from './types.ts';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function fmt(value: number | null | undefined, digits = 1): string {
  return value === null || value === undefined || !Number.isFinite(value) ? '—' : value.toFixed(digits);
}

interface Column {
  readonly header: string;
  readonly title: string;
  readonly cell: (r: StepResult) => string;
}

const COLUMNS: readonly Column[] = [
  { header: 'ID', title: 'Step', cell: (r) => r.id },
  { header: 'Scenario', title: 'Scenario (loads are simulations)', cell: (r) => r.label },
  { header: 'FPS', title: 'Sandbox average FPS', cell: (r) => fmt(r.sandbox?.avgFps) },
  { header: 'p95', title: 'Sandbox frame time p95 (ms)', cell: (r) => fmt(r.sandbox?.p95Ms) },
  { header: 'p99', title: 'Sandbox frame time p99 (ms)', cell: (r) => fmt(r.sandbox?.p99Ms) },
  { header: '>16.7', title: '% of frames over 16.7 ms', cell: (r) => fmt(r.sandbox?.pctOver16ms) },
  { header: '1% low', title: '1 % low FPS', cell: (r) => fmt(r.sandbox?.onePercentLowFps) },
  { header: 'CPU', title: 'Sandbox CPU ms per frame (mean)', cell: (r) => fmt(r.sandbox?.meanCpuMs, 2) },
  { header: 'GPU', title: 'Sandbox render pass GPU ms (mean)', cell: (r) => fmt(r.gpu?.meanMs, 2) },
  { header: 'Viewer FPS', title: 'Simulated viewer FPS', cell: (r) => fmt(r.viewer?.avgFps) },
  { header: 'Search p95', title: 'Simulated search latency p95 (ms)', cell: (r) => fmt(r.search?.p95Ms) },
  { header: 'ETL max', title: 'Simulated metrics.json main-thread cost, max (ms)', cell: (r) => fmt(r.etl?.maxMs) },
  { header: 'LoAF max', title: 'Long animation frame, max blocking duration (ms)', cell: (r) => fmt(r.longTasks?.loaf?.maxBlockingMs) },
  {
    header: 'Notes',
    title: 'Synthesis summary, errors',
    cell: (r) => {
      if (r.error !== null) return `error: ${r.error}`;
      if (r.synth !== null) {
        const totals = r.synth.perPreset.map((p) => p.total.p50Ms ?? Number.NaN);
        const min = Math.min(...totals);
        const max = Math.max(...totals);
        return `synthesis p50 ${fmt(min, 2)}–${fmt(max, 2)} ms · full BVH p50 ${fmt(r.synth.bvhFullRebuild.p50Ms, 2)} ms`;
      }
      return r.notes.some((n) => n.startsWith('Tab was hidden')) ? 'tab hidden: invalid' : '';
    },
  },
];

/** "Run benchmark" button, progress line, and the results overlay with Copy JSON. No three.js dependency. */
export class BenchPanel {
  private readonly root: HTMLElement;
  private readonly button: HTMLButtonElement;
  private readonly status: HTMLElement;
  private overlay: HTMLElement | null = null;

  constructor(parent: HTMLElement, onRun: () => void) {
    this.root = el('div', 'bench-panel');
    this.root.setAttribute('aria-label', 'Benchmark');
    this.button = el('button', 'hud-button bench-button', 'Run benchmark');
    this.button.type = 'button';
    this.button.addEventListener('click', onRun);
    this.status = el('p', 'bench-status', 'Loads in the benchmark are simulations.');
    this.status.setAttribute('role', 'status');
    this.root.append(this.button, this.status);
    parent.append(this.root);
  }

  setRunning(running: boolean): void {
    this.button.disabled = running;
    this.button.textContent = running ? 'Benchmark running…' : 'Run benchmark';
    if (running) this.closeOverlay();
  }

  setStatus(text: string): void {
    this.status.textContent = text;
  }

  progress(state: BenchState, stepLabel: string | null, loadLabels: readonly string[]): void {
    const pct = Math.round(state.progress * 100);
    const parts = [`${pct} %`];
    if (stepLabel !== null) parts.push(stepLabel);
    if (state.phase !== null) parts.push(state.phase);
    let text = parts.join(' · ');
    if (loadLabels.length > 0) text += `\n${loadLabels.join('\n')}`;
    this.status.textContent = text;
  }

  showError(text: string): void {
    this.status.textContent = `Benchmark error: ${text}`;
  }

  showResults(report: BenchReport): void {
    this.closeOverlay();
    const json = JSON.stringify(report, null, 2);
    const overlay = el('section', 'bench-overlay');
    overlay.setAttribute('aria-label', 'Benchmark results');

    const head = el('header', 'bench-overlay-head');
    head.append(el('h2', 'bench-overlay-title', 'Benchmark results'));
    const actions = el('div', 'bench-overlay-actions');
    const copy = el('button', 'hud-button', 'Copy JSON');
    copy.type = 'button';
    const close = el('button', 'hud-button', 'Close');
    close.type = 'button';
    actions.append(copy, close);
    head.append(actions);

    const env = report.env;
    const meta = el(
      'p',
      'bench-overlay-meta',
      `${env.webgl.renderer ?? 'unknown GPU'} · ${env.hardwareConcurrency ?? '?'} threads · DPR ${env.devicePixelRatio} ` +
        `(effective ${env.effectivePixelRatio}) · canvas ${env.drawingBuffer.width}×${env.drawingBuffer.height} · ` +
        `display ≈ ${fmt(env.estimatedRefreshHz, 0)} Hz · ${env.build} build · ${(report.totalMs / 1000).toFixed(0)} s`,
    );
    const warning = el(
      'p',
      'hud-sim-note',
      'Viewer, search engine and metrics.json loads are SIMULATIONS of planned modules, not the real libraries.',
    );

    const wrap = el('div', 'bench-table-wrap');
    const table = el('table', 'bench-table');
    const thead = el('thead');
    const hr = el('tr');
    for (const c of COLUMNS) {
      const th = el('th', undefined, c.header);
      th.title = c.title;
      th.scope = 'col';
      hr.append(th);
    }
    thead.append(hr);
    const tbody = el('tbody');
    for (const r of report.results) {
      const tr = el('tr');
      if (r.error !== null) tr.className = 'is-error';
      for (const c of COLUMNS) tr.append(el('td', undefined, c.cell(r)));
      tbody.append(tr);
    }
    table.append(thead, tbody);
    wrap.append(table);

    const raw = el('details', 'bench-raw');
    raw.append(el('summary', undefined, 'Raw JSON'));
    const textarea = el('textarea', 'bench-json');
    textarea.readOnly = true;
    textarea.value = json;
    raw.append(textarea);

    copy.addEventListener('click', () => {
      const done = (ok: boolean): void => {
        copy.textContent = ok ? 'Copied' : 'Copy failed: use Raw JSON';
        window.setTimeout(() => (copy.textContent = 'Copy JSON'), 2000);
      };
      if (navigator.clipboard?.writeText !== undefined) {
        navigator.clipboard.writeText(json).then(
          () => done(true),
          () => {
            raw.open = true;
            textarea.select();
            done(false);
          },
        );
      } else {
        raw.open = true;
        textarea.select();
        done(false);
      }
    });
    close.addEventListener('click', () => this.closeOverlay());

    overlay.append(head, meta, warning, wrap, raw);
    this.root.before(overlay);
    this.overlay = overlay;
    this.status.textContent = `Done in ${(report.totalMs / 1000).toFixed(0)} s · ${report.results.length} steps · window.__bench.report`;
  }

  private closeOverlay(): void {
    this.overlay?.remove();
    this.overlay = null;
  }
}
