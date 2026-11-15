import {
  CircleGeometry,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
  SphereGeometry,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { LoadGenerator, ViewerStats } from '../types.ts';
import { SampleBuffer, distribution } from '../stats.ts';

export type ViewerVariant = 'instanced' | 'naive';

export interface ViewerLoadOptions {
  variant: ViewerVariant;
  cells: number;
  /** Rewrite every instance colour once per second (models refreshing the map after a search). */
  recolor?: boolean;
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const RECOLOR_INTERVAL_MS = 1000;
const ROTATION_RAD_S = 0.08;
const CELL_LIFT = 1.002;
const MAX_PIXEL_RATIO = 1.5;
const Z_AXIS = new Vector3(0, 0, 1);

/** Flat-hexagon radius so N cells cover ~90 % of the unit sphere. */
function hexRadius(cells: number): number {
  const area = (4 * Math.PI) / cells;
  return Math.sqrt(area / ((3 * Math.sqrt(3)) / 2)) * 0.9;
}

/** Unit vectors of a Fibonacci sphere, xyz interleaved. */
function fibonacciSphere(n: number): Float32Array {
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const phi = i * GOLDEN_ANGLE;
    out[i * 3] = Math.cos(phi) * r;
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = Math.sin(phi) * r;
  }
  return out;
}

/** Fake similarity score in [0, 1] → three-stop colour ramp (dark blue → teal → yellow). */
function writeScoreColors(dirs: Float32Array, out: Float32Array, phase: number): void {
  const n = dirs.length / 3;
  for (let i = 0; i < n; i++) {
    const x = dirs[i * 3];
    const y = dirs[i * 3 + 1];
    const z = dirs[i * 3 + 2];
    const s = 0.5 + 0.5 * Math.sin(3.1 * x + phase) * Math.cos(2.3 * y - 0.7 * phase) * Math.cos(1.7 * z + 0.3 * phase);
    let r: number;
    let g: number;
    let b: number;
    if (s < 0.5) {
      const k = s * 2;
      r = 0.08 + (0.1 - 0.08) * k;
      g = 0.12 + (0.6 - 0.12) * k;
      b = 0.35 + (0.55 - 0.35) * k;
    } else {
      const k = (s - 0.5) * 2;
      r = 0.1 + (0.95 - 0.1) * k;
      g = 0.6 + (0.85 - 0.6) * k;
      b = 0.55 + (0.2 - 0.55) * k;
    }
    out[i * 3] = r;
    out[i * 3 + 1] = g;
    out[i * 3 + 2] = b;
  }
}

/** Column-major rotation (tangent, bitangent, normal) + translation for each cell, written in place. */
function writeCellMatrices(dirs: Float32Array, out: Float32Array): void {
  const n = dirs.length / 3;
  for (let i = 0; i < n; i++) {
    const x = dirs[i * 3];
    const y = dirs[i * 3 + 1];
    const z = dirs[i * 3 + 2];
    // t = normalize(up × n), up = +Y except near the poles (+X there).
    let tx: number;
    let ty: number;
    let tz: number;
    if (Math.abs(y) < 0.99) {
      tx = z;
      ty = 0;
      tz = -x;
    } else {
      tx = 0;
      ty = -z;
      tz = y;
    }
    const tl = 1 / Math.hypot(tx, ty, tz);
    tx *= tl;
    ty *= tl;
    tz *= tl;
    // b = n × t
    const bx = y * tz - z * ty;
    const by = z * tx - x * tz;
    const bz = x * ty - y * tx;
    const o = i * 16;
    out[o] = tx;
    out[o + 1] = ty;
    out[o + 2] = tz;
    out[o + 3] = 0;
    out[o + 4] = bx;
    out[o + 5] = by;
    out[o + 6] = bz;
    out[o + 7] = 0;
    out[o + 8] = x;
    out[o + 9] = y;
    out[o + 10] = z;
    out[o + 11] = 0;
    out[o + 12] = x * CELL_LIFT;
    out[o + 13] = y * CELL_LIFT;
    out[o + 14] = z * CELL_LIFT;
    out[o + 15] = 1;
  }
}

/**
 * SIMULATED geospatial viewer (the real library is undecided): a second canvas with its own WebGLRenderer and
 * its own rAF loop over the left half of the viewport, drawing a globe plus N HEALPix-like cells (flat hexagons on
 * a Fibonacci sphere), slowly rotating. `instanced` = one InstancedMesh; `naive` = one Mesh per cell.
 */
export class ViewerLoad implements LoadGenerator {
  readonly label: string;
  private readonly variant: ViewerVariant;
  private readonly cells: number;
  private readonly recolor: boolean;
  private canvas: HTMLCanvasElement | null = null;
  private badge: HTMLElement | null = null;
  private renderer: WebGLRenderer | null = null;
  private scene: Scene | null = null;
  private camera: PerspectiveCamera | null = null;
  private globe: Group | null = null;
  private instanced: InstancedMesh | null = null;
  private dirs: Float32Array | null = null;
  private readonly disposables: Array<{ dispose(): void }> = [];
  private readonly frames = new SampleBuffer(16384);
  private readonly cpu = new SampleBuffer(16384);
  private readonly recolorMs = new SampleBuffer(4096);
  private measuring = false;
  private recolors = 0;
  private rafId = 0;
  private lastNow = -1;
  private startNow = -1;
  private lastRecolor = -Infinity;
  private phase = 0;
  private setupMs = 0;
  private drawCalls = 0;
  private triangles = 0;
  private readonly loop = (now: number): void => this.frame(now);

  constructor(options: ViewerLoadOptions) {
    this.variant = options.variant;
    this.cells = Math.max(1, Math.floor(options.cells));
    this.recolor = options.recolor === true && options.variant === 'instanced';
    const n = this.cells.toLocaleString('en-US');
    this.label = `Simulated viewer · ${n} ${this.variant} cells${this.recolor ? ' · recolor 1 Hz' : ''}`;
  }

  async start(): Promise<void> {
    const t0 = performance.now();
    const canvas = document.createElement('canvas');
    canvas.className = 'bench-viewer-canvas';
    canvas.setAttribute('aria-label', 'Simulated geospatial viewer (benchmark load)');
    const anchor = document.getElementById('viewport');
    if (anchor !== null) anchor.after(canvas);
    else document.body.append(canvas);
    this.canvas = canvas;

    const badge = document.createElement('div');
    badge.className = 'bench-sim-badge';
    badge.textContent = `SIMULATED viewer load · ${this.cells.toLocaleString('en-US')} ${this.variant} cells · own WebGL context`;
    canvas.after(badge);
    this.badge = badge;

    const renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer = renderer;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    const w = Math.max(1, canvas.clientWidth);
    const h = Math.max(1, canvas.clientHeight);
    renderer.setSize(w, h, false);

    const scene = new Scene();
    const camera = new PerspectiveCamera(40, w / h, 0.1, 50);
    camera.position.set(0, 0, 3.3);
    const globe = new Group();
    globe.rotation.x = 0.35;
    scene.add(globe);
    this.scene = scene;
    this.camera = camera;
    this.globe = globe;

    const sphereGeo = new SphereGeometry(1, 64, 32);
    const sphereMat = new MeshBasicMaterial({ color: 0x0b1a2e });
    globe.add(new Mesh(sphereGeo, sphereMat));
    this.disposables.push(sphereGeo, sphereMat);

    const hexGeo = new CircleGeometry(hexRadius(this.cells), 6);
    this.disposables.push(hexGeo);
    const dirs = fibonacciSphere(this.cells);

    if (this.variant === 'instanced') {
      const mat = new MeshBasicMaterial({ color: 0xffffff });
      this.disposables.push(mat);
      const mesh = new InstancedMesh(hexGeo, mat, this.cells);
      writeCellMatrices(dirs, mesh.instanceMatrix.array as Float32Array);
      mesh.instanceMatrix.needsUpdate = true;
      const colors = new InstancedBufferAttribute(new Float32Array(this.cells * 3), 3);
      if (this.recolor) colors.setUsage(DynamicDrawUsage);
      writeScoreColors(dirs, colors.array as Float32Array, 0);
      mesh.instanceColor = colors;
      mesh.frustumCulled = false;
      globe.add(mesh);
      this.instanced = mesh;
      this.dirs = dirs;
    } else {
      // Non-instanced polygon viewer: one Mesh (one draw call) per cell, shared geometry and material.
      const mat = new MeshBasicMaterial({ color: 0x5fb4ff });
      this.disposables.push(mat);
      const normal = new Vector3();
      for (let i = 0; i < this.cells; i++) {
        normal.set(dirs[i * 3], dirs[i * 3 + 1], dirs[i * 3 + 2]);
        const cell = new Mesh(hexGeo, mat);
        cell.position.copy(normal).multiplyScalar(CELL_LIFT);
        cell.quaternion.setFromUnitVectors(Z_AXIS, normal);
        globe.add(cell);
      }
    }

    renderer.compile(scene, camera);
    renderer.render(scene, camera);
    this.setupMs = performance.now() - t0;
    this.rafId = requestAnimationFrame(this.loop);
  }

  beginMeasure(): void {
    this.frames.reset();
    this.cpu.reset();
    this.recolorMs.reset();
    this.recolors = 0;
    this.lastNow = -1;
    this.measuring = true;
  }

  endMeasure(): void {
    this.measuring = false;
  }

  private frame(now: number): void {
    this.rafId = requestAnimationFrame(this.loop);
    const renderer = this.renderer;
    const scene = this.scene;
    const camera = this.camera;
    const globe = this.globe;
    if (renderer === null || scene === null || camera === null || globe === null) return;
    if (this.startNow < 0) this.startNow = now;
    if (this.measuring && this.lastNow >= 0) this.frames.push(now - this.lastNow);
    this.lastNow = now;
    globe.rotation.y = ((now - this.startNow) / 1000) * ROTATION_RAD_S;

    const mesh = this.instanced;
    if (this.recolor && mesh !== null && this.dirs !== null && now - this.lastRecolor >= RECOLOR_INTERVAL_MS) {
      this.lastRecolor = now;
      const k0 = performance.now();
      this.phase += 0.9;
      const colors = mesh.instanceColor;
      if (colors !== null) {
        writeScoreColors(this.dirs, colors.array as Float32Array, this.phase);
        colors.needsUpdate = true;
      }
      if (this.measuring) {
        this.recolorMs.push(performance.now() - k0);
        this.recolors++;
      }
    }

    const c0 = performance.now();
    renderer.render(scene, camera);
    if (this.measuring) this.cpu.push(performance.now() - c0);
    this.drawCalls = renderer.info.render.calls;
    this.triangles = renderer.info.render.triangles;
  }

  stats(): ViewerStats {
    const f = distribution(this.frames.view());
    const c = distribution(this.cpu.view());
    const k = distribution(this.recolorMs.view());
    const renderer = this.renderer;
    const ctx = renderer?.getContext();
    return {
      simulated: true,
      variant: this.variant,
      cells: this.cells,
      recolor: this.recolor,
      pixelRatio: renderer?.getPixelRatio() ?? 0,
      drawingBuffer: { width: ctx?.drawingBufferWidth ?? 0, height: ctx?.drawingBufferHeight ?? 0 },
      frames: f.n,
      avgFps: f.n > 0 ? 1000 / f.mean : null,
      p95Ms: f.n > 0 ? f.p95 : null,
      p99Ms: f.n > 0 ? f.p99 : null,
      meanCpuMs: c.n > 0 ? c.mean : null,
      p95CpuMs: c.n > 0 ? c.p95 : null,
      meanRecolorMs: k.n > 0 ? k.mean : null,
      recolors: this.recolors,
      drawCalls: this.drawCalls,
      triangles: this.triangles,
      setupMs: this.setupMs,
    };
  }

  async stop(): Promise<void> {
    if (this.rafId !== 0) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    this.measuring = false;
    try {
      this.globe?.clear();
      this.instanced?.dispose();
      for (const d of this.disposables) d.dispose();
    } finally {
      this.disposables.length = 0;
      const renderer = this.renderer;
      if (renderer !== null) {
        renderer.dispose();
        renderer.forceContextLoss();
      }
      this.canvas?.remove();
      this.badge?.remove();
      this.renderer = null;
      this.scene = null;
      this.camera = null;
      this.globe = null;
      this.instanced = null;
      this.dirs = null;
      this.canvas = null;
      this.badge = null;
    }
  }
}
