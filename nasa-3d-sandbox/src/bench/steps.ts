import type { SandboxMode } from '../sandbox3d/SandboxEngine.ts';
import type { ViewerLoadOptions } from './scenarios/viewerLoad.ts';
import type { SearchLoadOptions } from './scenarios/searchLoad.ts';
import type { EtlLoadOptions } from './scenarios/etlLoad.ts';

export const BASE_PRESET = 0;
export const STRESS_PRESET = 8;

export interface StepPlan {
  readonly id: string;
  readonly label: string;
  /** Kind `frame` measures a frame window; `synth` is the synthesis micro-benchmark (S07). */
  readonly kind: 'frame' | 'synth';
  readonly mode: SandboxMode;
  readonly preset: number;
  /** Re-synthesise the terrain every frame through the bridge (slider-drag simulation). */
  readonly sliderDrag?: boolean;
  /** engine.pause() during the window (sandbox stats are null). */
  readonly pauseSandbox?: boolean;
  readonly viewer?: ViewerLoadOptions;
  readonly search?: SearchLoadOptions;
  readonly etl?: EtlLoadOptions;
  readonly notes?: readonly string[];
}

const COMBINED: Pick<StepPlan, 'viewer' | 'search' | 'etl'> = {
  viewer: { variant: 'instanced', cells: 50_000, recolor: true },
  search: { mode: 'worker', cells: 1_000_000 },
  etl: { mode: 'main', sizeMB: 8, once: true },
};

export const BENCH_STEPS: readonly StepPlan[] = [
  { id: 'S01', label: 'Baseline · ROVER', kind: 'frame', mode: 'ROVER', preset: BASE_PRESET },
  { id: 'S02', label: 'Baseline · SUIT_EDS', kind: 'frame', mode: 'SUIT_EDS', preset: BASE_PRESET },
  { id: 'S03', label: 'Baseline · LIDAR_LANDER', kind: 'frame', mode: 'LIDAR_LANDER', preset: BASE_PRESET },
  { id: 'S04', label: 'Baseline · ISRU_DRILL', kind: 'frame', mode: 'ISRU_DRILL', preset: BASE_PRESET },
  { id: 'S05', label: 'LIDAR_LANDER · stress preset', kind: 'frame', mode: 'LIDAR_LANDER', preset: STRESS_PRESET },
  {
    id: 'S06',
    label: 'ROVER · slider drag (re-synthesis every frame)',
    kind: 'frame',
    mode: 'ROVER',
    preset: BASE_PRESET,
    sliderDrag: true,
    notes: ['bridge.updateSandboxTerrain is called from a frame listener every frame; synthesis runs at the start of the next frame.'],
  },
  {
    id: 'S07',
    label: 'Synthesis micro-benchmark (40 × synthesizeNow per preset, 10 × full BVH rebuild)',
    kind: 'synth',
    mode: 'ROVER',
    preset: BASE_PRESET,
    notes: ['No frame window. The sandbox is paused while it runs. Plan budget for terrain synthesis: < 1 ms.'],
  },
  { id: 'S08', label: 'ROVER + viewer instanced 10k', kind: 'frame', mode: 'ROVER', preset: BASE_PRESET, viewer: { variant: 'instanced', cells: 10_000 } },
  { id: 'S09', label: 'ROVER + viewer instanced 50k', kind: 'frame', mode: 'ROVER', preset: BASE_PRESET, viewer: { variant: 'instanced', cells: 50_000 } },
  { id: 'S10', label: 'ROVER + viewer instanced 200k', kind: 'frame', mode: 'ROVER', preset: BASE_PRESET, viewer: { variant: 'instanced', cells: 200_000 } },
  { id: 'S11', label: 'ROVER + viewer instanced 1M', kind: 'frame', mode: 'ROVER', preset: BASE_PRESET, viewer: { variant: 'instanced', cells: 1_000_000 } },
  {
    id: 'S12',
    label: 'ROVER + viewer naive 10k (one draw call per cell)',
    kind: 'frame',
    mode: 'ROVER',
    preset: BASE_PRESET,
    viewer: { variant: 'naive', cells: 10_000 },
  },
  {
    id: 'S13',
    label: 'ROVER + viewer instanced 50k + recolor 1 Hz',
    kind: 'frame',
    mode: 'ROVER',
    preset: BASE_PRESET,
    viewer: { variant: 'instanced', cells: 50_000, recolor: true },
  },
  { id: 'S14', label: 'ROVER + search main thread 100k', kind: 'frame', mode: 'ROVER', preset: BASE_PRESET, search: { mode: 'main', cells: 100_000 } },
  { id: 'S15', label: 'ROVER + search main thread 1M', kind: 'frame', mode: 'ROVER', preset: BASE_PRESET, search: { mode: 'main', cells: 1_000_000 } },
  { id: 'S16', label: 'ROVER + search worker 1M', kind: 'frame', mode: 'ROVER', preset: BASE_PRESET, search: { mode: 'worker', cells: 1_000_000 } },
  { id: 'S17', label: 'ROVER + search worker 5M', kind: 'frame', mode: 'ROVER', preset: BASE_PRESET, search: { mode: 'worker', cells: 5_000_000 } },
  { id: 'S18', label: 'ROVER + metrics.json 2 MB main parse 1 Hz', kind: 'frame', mode: 'ROVER', preset: BASE_PRESET, etl: { mode: 'main', sizeMB: 2 } },
  { id: 'S19', label: 'ROVER + metrics.json 8 MB main parse 1 Hz', kind: 'frame', mode: 'ROVER', preset: BASE_PRESET, etl: { mode: 'main', sizeMB: 8 } },
  { id: 'S20', label: 'ROVER + metrics.json 32 MB main parse 1 Hz', kind: 'frame', mode: 'ROVER', preset: BASE_PRESET, etl: { mode: 'main', sizeMB: 32 } },
  { id: 'S21', label: 'ROVER + metrics.json 32 MB worker parse 1 Hz', kind: 'frame', mode: 'ROVER', preset: BASE_PRESET, etl: { mode: 'worker', sizeMB: 32 } },
  {
    id: 'S22',
    label: 'Combined · LIDAR_LANDER + viewer 50k recolor + search worker 1M + 8 MB metrics.json once',
    kind: 'frame',
    mode: 'LIDAR_LANDER',
    preset: BASE_PRESET,
    ...COMBINED,
  },
  {
    id: 'S23',
    label: 'Combined as S22 · sandbox paused',
    kind: 'frame',
    mode: 'LIDAR_LANDER',
    preset: BASE_PRESET,
    pauseSandbox: true,
    ...COMBINED,
    notes: ['engine.pause() during warm-up and window: shows the cooperative-pause benefit on the viewer. Sandbox stats are null.'],
  },
];
