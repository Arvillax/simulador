import { mulberry32 } from '../prng.ts';

/**
 * SIMULATED `metrics.json` (shape of ADR-007: contract, dimensions, targets with per-analog, per-dimension
 * value / diff / label / source, limits). Every number is synthetic. Pure, no DOM; used by the main thread and
 * by the ETL worker.
 */

export interface MetricsDimension {
  id: string;
  unit: string;
  description: string;
}

export const METRICS_DIMENSIONS: readonly MetricsDimension[] = [
  { id: 'slope_deg', unit: 'deg', description: 'Terrain slope' },
  { id: 'roughness_tri', unit: '1', description: 'Terrain ruggedness index (normalised)' },
  { id: 'thermal_inertia', unit: '1', description: 'Thermal inertia (normalised)' },
  { id: 'albedo_mineral', unit: '1', description: 'Albedo / mineral proxy' },
  { id: 'surface_temp_k', unit: 'K', description: 'Surface temperature' },
  { id: 'ndvi', unit: '1', description: 'Vegetation index (planetary-analog purity)' },
];

const DIM_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0, 45],
  [0, 1],
  [0, 1],
  [0.05, 0.6],
  [40, 400],
  [-0.1, 1.0],
];

export const MOON_TARGET_COUNT = 9;
export const MARS_TARGET_COUNT = 12;

export type MetricsLabel = 'match' | 'differs' | 'no_data';

export interface MetricsDimValue {
  target: number | null;
  value: number | null;
  diff: number | null;
  label: MetricsLabel;
  source: { column: string; dataset: string; version: string };
}

export interface MetricsAnalog {
  cell: number;
  lat: number;
  lon: number;
  score: number;
  coverage: { compared: number; missing: string[] };
  dims: Record<string, MetricsDimValue>;
}

export interface MetricsTarget {
  id: string;
  body: 'moon' | 'mars';
  name: string;
  lat: number;
  lon: number;
  values: Record<string, number | null>;
  analogs: MetricsAnalog[];
}

export interface MetricsFile {
  contract: {
    version: string;
    generated_at: string;
    healpix_level: number;
    manifest_sha256: string;
    simulated: boolean;
  };
  dimensions: MetricsDimension[];
  limits: Array<{ id: string; note: string }>;
  targets: MetricsTarget[];
}

export interface MetricsBuild {
  json: string;
  /** Size in bytes (the string is ASCII, so bytes === json.length). */
  bytes: number;
  targets: number;
  analogs: number;
}

const HEALPIX_L12_NPIX = 12 * 4096 * 4096;
const MISSING_FRACTION = 0.05;
const MATCH_THRESHOLD = 0.15;

function r4(x: number): number {
  return Math.round(x * 1e4) / 1e4;
}

function hex(rand: () => number, length: number): string {
  let s = '';
  for (let i = 0; i < length; i++) s += Math.floor(rand() * 16).toString(16);
  return s;
}

function buildTarget(i: number, rand: () => number): MetricsTarget {
  const isMoon = i < MOON_TARGET_COUNT;
  const n = isMoon ? i + 1 : i - MOON_TARGET_COUNT + 1;
  const values: Record<string, number | null> = {};
  METRICS_DIMENSIONS.forEach((d, k) => {
    const [min, max] = DIM_RANGES[k];
    values[d.id] = r4(min + rand() * (max - min));
  });
  return {
    id: `${isMoon ? 'moon' : 'mars'}-${String(n).padStart(2, '0')}`,
    body: isMoon ? 'moon' : 'mars',
    name: `Simulated ${isMoon ? 'Moon' : 'Mars'} target ${n}`,
    lat: r4(isMoon ? -90 + rand() * 6 : -60 + rand() * 120),
    lon: r4(-180 + rand() * 360),
    values,
    analogs: [],
  };
}

function buildAnalog(target: MetricsTarget, rand: () => number): MetricsAnalog {
  const dims: Record<string, MetricsDimValue> = {};
  const missing: string[] = [];
  let sumSq = 0;
  let compared = 0;
  METRICS_DIMENSIONS.forEach((d, k) => {
    const [min, max] = DIM_RANGES[k];
    const span = max - min;
    const t = target.values[d.id] ?? null;
    const source = { column: d.id, dataset: 'SIMULATED-ETL', version: '0.0.0-sim' };
    if (t === null || rand() < MISSING_FRACTION) {
      missing.push(d.id);
      dims[d.id] = { target: t, value: null, diff: null, label: 'no_data', source };
      return;
    }
    const value = r4(Math.min(max, Math.max(min, t + (rand() - 0.5) * span * 0.5)));
    const diff = r4(value - t);
    const norm = Math.abs(diff) / span;
    sumSq += norm * norm;
    compared++;
    dims[d.id] = { target: t, value, diff, label: norm <= MATCH_THRESHOLD ? 'match' : 'differs', source };
  });
  return {
    cell: Math.floor(rand() * HEALPIX_L12_NPIX),
    lat: r4(-60 + rand() * 140),
    lon: r4(-180 + rand() * 360),
    score: compared > 0 ? r4(1 - Math.sqrt(sumSq / compared)) : 0,
    coverage: { compared, missing },
    dims,
  };
}

/**
 * Builds a synthetic metrics.json string of about `targetBytes` bytes (overshoot ≤ one analog record).
 * Analogs are added round-robin across the 21 targets until the size is reached.
 */
export function buildMetricsJson(targetBytes: number, seed = 7): MetricsBuild {
  const rand = mulberry32(seed);
  const targets: MetricsTarget[] = [];
  for (let i = 0; i < MOON_TARGET_COUNT + MARS_TARGET_COUNT; i++) targets.push(buildTarget(i, rand));

  const file: MetricsFile = {
    contract: {
      version: '0.1.0-sim',
      generated_at: '2026-11-14T00:00:00Z',
      healpix_level: 12,
      manifest_sha256: hex(rand, 64),
      simulated: true,
    },
    dimensions: METRICS_DIMENSIONS.map((d) => ({ ...d })),
    limits: [
      { id: 'gravity', note: 'Gravity differs (Moon 1.62, Mars 3.71, Earth 9.81 m/s^2); no column captures it.' },
      { id: 'atmosphere', note: 'Atmosphere and pressure differ; not captured by any column.' },
      { id: 'scale', note: 'Cell scale (HEALPix level 12, ~2.5 km^2) is coarser than surface operations.' },
      { id: 'simulated', note: 'SIMULATED file for performance testing. No value comes from a dataset.' },
    ],
    targets: [],
  };

  // Header: everything before the targets array content.
  const header = JSON.stringify(file);
  const headPrefix = header.slice(0, header.length - '[]}'.length) + '[';
  const prefixes = targets.map((t) => {
    const s = JSON.stringify(t);
    return s.slice(0, s.length - ']}'.length);
  });
  const perTarget: string[][] = targets.map(() => []);

  // Fixed overhead: header, target prefixes, target separators and closing brackets.
  let total = headPrefix.length + (targets.length - 1) + 2;
  for (const p of prefixes) total += p.length + 2;

  let analogs = 0;
  let t = 0;
  while (total < targetBytes || analogs < targets.length) {
    const s = JSON.stringify(buildAnalog(targets[t], rand));
    const list = perTarget[t];
    total += s.length + (list.length > 0 ? 1 : 0);
    list.push(s);
    analogs++;
    t = (t + 1) % targets.length;
  }

  const parts: string[] = [headPrefix];
  for (let i = 0; i < targets.length; i++) {
    if (i > 0) parts.push(',');
    parts.push(prefixes[i], perTarget[i].join(','), ']}');
  }
  parts.push(']}');
  const json = parts.join('');
  return { json, bytes: json.length, targets: targets.length, analogs };
}
