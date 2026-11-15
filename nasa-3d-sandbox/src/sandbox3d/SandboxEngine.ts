import {
  ACESFilmicToneMapping,
  Color,
  DataTexture,
  DirectionalLight,
  FogExp2,
  HemisphereLight,
  LinearFilter,
  PCFShadowMap,
  PerspectiveCamera,
  RGBAFormat,
  SRGBColorSpace,
  Scene,
  UnsignedByteType,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { Material, Mesh, Object3D } from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { DEFAULT_SITE_SEED, etlVector } from '../bridge/sandboxDataBridge.ts';
import { PLOT_HALF, TerrainGenerator, sampleHeight } from './TerrainGenerator.ts';
import { RockFieldInstancer } from './RockFieldInstancer.ts';
import { DustSystemQuarks } from './DustSystemQuarks.ts';
import { BlockWalls, strataBandRgb } from './BlockWalls.ts';
import { STRATA_BOUNDS_M, setStrataTint } from './AssetBuilder.ts';
import {
  BACKDROP_ROWS,
  blendLooks,
  copyLook,
  createLook,
  displayTone,
  lookFor,
  sunDirection,
  terrainPalette,
  wallGain,
  writeBackdrop,
} from './BodyLook.ts';
import type { Body, BodyLook, Rgb } from './BodyLook.ts';
import { CAMERA_TRAVEL_MS, LOOK_BLEND_MS, easeInOut } from './Easing.ts';
import { QualityGovernor, looksIntegrated, renderScaleCap } from './QualityGovernor.ts';
import type { QualityState } from './QualityGovernor.ts';
import type { FpsMeter } from './FpsMeter.ts';
import type { ModeSolver, PhysicsState, SolverContext } from './solvers/ModeSolver.ts';
import { RoverSolver } from './solvers/RoverSolver.ts';
import { SuitDustSolver } from './solvers/SuitDustSolver.ts';
import { LidarBvhSolver } from './solvers/LidarBvhSolver.ts';
import { IsruDrillSolver, MAX_ICE_WT, iceWeightFraction } from './solvers/IsruDrillSolver.ts';
import { _v1, _v2, clamp } from './ScratchMath.ts';
import { applyHardwareEnvironment, setHardwareSunlit } from './HardwareKit.ts';

export type SandboxMode = 'ROVER' | 'SUIT_EDS' | 'LIDAR_LANDER' | 'ISRU_DRILL';

export const SANDBOX_MODES: readonly SandboxMode[] = ['ROVER', 'SUIT_EDS', 'LIDAR_LANDER', 'ISRU_DRILL'];

export interface FrameTimings {
  /** Interval between consecutive rAF callbacks (ms). 0 on the first frame after a (re)start. */
  frameMs: number;
  /** Active solver + dust update (ms). Includes lidarMs in LIDAR_LANDER mode. */
  updateMs: number;
  /** CPU submit time of renderer.render (ms). */
  renderMs: number;
  /** Total LiDAR raycast time this frame (ms), 0 outside LIDAR_LANDER. */
  lidarMs: number;
  /** Draw calls of the frame, shadow pass included. */
  drawCalls: number;
  /** Triangles of the frame, shadow pass included. */
  triangles: number;
  /** Extra: total CPU time spent inside the frame callback (ms). */
  cpuMs: number;
  /** Extra: terrain synthesis time executed in this frame (ms), 0 when none was pending. */
  synthMs: number;
  /** Drawing-buffer pixels per CSS pixel chosen by the quality governor. */
  renderScale: number;
  /** Quality ladder level, 0 (best) to 6. */
  qualityLevel: number;
  /** Shadow map side in texels; 0 while shadows are off (quality level or a site without direct sun). */
  shadowMapSize: number;
}

export interface SynthTimings {
  noiseMs: number;
  normalsMs: number;
  bvhMs: number;
  rocksMs: number;
  /** Cut-block walls and rim: copy of the edge heights (ms). */
  wallsMs: number;
  totalMs: number;
  rockCount: number;
}

export type FrameListener = (nowMs: number) => void;

/** Optional hook around renderer.render (benchmark GPU timer). Its own cost is outside renderMs and cpuMs. */
export interface RenderPassHook {
  beforeRender(): void;
  afterRender(): void;
}

export interface SandboxEngineOptions {
  /** Element whose size the renderer follows. Default: the parent of the canvas. */
  container?: HTMLElement;
}

export interface SetModeOptions {
  /** Skip the camera travel and the light blend (keyboard switch, benchmark). */
  instant?: boolean;
}

export interface SetBodyOptions {
  /** Snap instead of blending over 500 ms. */
  immediate?: boolean;
  /** False for a permanently shadowed site: no direct sun, dim cold fill, shadows off. Default true. */
  sunlit?: boolean;
}

/** Quality governor control surface (`engine.quality`). */
export interface QualityFacade {
  getState(): QualityState;
  /** Automatic stepping on or off; the level is kept. */
  setAuto(auto: boolean): void;
  /** Jumps to a ladder level (0..6). Automatic stepping continues from there unless it is off or locked. */
  setLevel(level: number): void;
  /** Pins the current level, or `level` when given, until `unlock()`. */
  lock(level?: number): void;
  unlock(): void;
}

/**
 * Hero framing per mode, relative to the focus: a 3/4 view from the lit side of the block (the sun comes from -z
 * on every world), close to the hardware with the cut rim still in frame. Tuned so the hardware fills about a third of
 * the frame height (measured: rover 0.34, suit 0.33, drill 0.36); the lander stays smaller (about 0.24) so its
 * scan cone and the point cloud on the ground stay in frame.
 */
const MODE_CAMERA_OFFSET: Record<SandboxMode, Vector3> = {
  ROVER: new Vector3(3.45, 2.7, -4.5),
  SUIT_EDS: new Vector3(4.3, 3.25, -5.25),
  LIDAR_LANDER: new Vector3(9.4, 7.2, -11.2),
  ISRU_DRILL: new Vector3(6.4, 4.5, -8.0),
};

/** The orbit target sits this far above the solver focus, so tall hardware is centred in the frame (m). */
const MODE_FOCUS_LIFT_M: Record<SandboxMode, number> = { ROVER: 0.25, SUIT_EDS: 0, LIDAR_LANDER: 1.8, ISRU_DRILL: 1.0 };

/** Height above the highest terrain point that the shadow frustum must cover per mode (hardware height, m). */
const SHADOW_HEADROOM_M: Record<SandboxMode, number> = { ROVER: 2, SUIT_EDS: 2.6, LIDAR_LANDER: 10, ISRU_DRILL: 3.2 };

const CAMERA_FOV_DEG = 46;
const FOCUS_EASE_PER_S = 3;
/** The camera never goes closer than this to the ground inside the plot (m). */
const CAMERA_CLEARANCE_M = 0.35;
/** Distance of the sun light from the block centre (m); only the direction matters for the look. */
const SUN_DISTANCE_M = 60;
/** Margin of the shadow frustum around the 20 m block (m). */
const SHADOW_MARGIN_M = 0.6;
const SHADOW_BIAS = -0.0004;
const SHADOW_NORMAL_BIAS_M = 0.035;

// Scratch objects private to this module (see ScratchMath rules).
const _axisX = new Vector3();
const _axisY = new Vector3();
const _focus = new Vector3();

function setRgb(color: Color, rgb: Rgb): void {
  color.setRGB(rgb[0], rgb[1], rgb[2]);
}

/**
 * Owns the single persistent WebGLRenderer and the single Scene. The four mode scenes are Groups toggled only
 * with `visible`. The rAF loop is zero-allocation; it pauses cooperatively when the tab is hidden, when the canvas
 * leaves the viewport, or on request.
 */
export class SandboxEngine {
  readonly renderer: WebGLRenderer;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly timings: FrameTimings = {
    frameMs: 0,
    updateMs: 0,
    renderMs: 0,
    lidarMs: 0,
    drawCalls: 0,
    triangles: 0,
    cpuMs: 0,
    synthMs: 0,
    renderScale: 1,
    qualityLevel: 0,
    shadowMapSize: 0,
  };
  readonly synthTimings: SynthTimings = { noiseMs: 0, normalsMs: 0, bvhMs: 0, rocksMs: 0, wallsMs: 0, totalMs: 0, rockCount: 0 };
  readonly physics: PhysicsState = { gravity: 1.62 };
  readonly terrain: TerrainGenerator;
  readonly rocks: RockFieldInstancer;
  readonly dust: DustSystemQuarks;
  /** Cut-block side walls and rim line. */
  readonly walls: BlockWalls;
  /** The only shadow-casting light. */
  readonly sun: DirectionalLight;
  readonly hemi: HemisphereLight;
  /** Unit vector toward the visible sun (live; read-only for callers). */
  readonly sunDirection = new Vector3(0, 1, 0);
  readonly solvers: Readonly<Record<SandboxMode, ModeSolver>>;
  readonly suit: SuitDustSolver;
  /** Quality governor: render scale and shadow map from frame times. */
  readonly quality: QualityFacade;
  /** Benchmark-only hook around the render pass. Null by default (no effect on the frame path). */
  renderPassHook: RenderPassHook | null = null;

  private readonly container: HTMLElement;
  private readonly frameListeners: FrameListener[] = [];
  private readonly loop: (now: number) => void;
  private readonly governor: QualityGovernor;
  private readonly fog: FogExp2;
  private readonly backdrop: DataTexture;
  private readonly backdropData = new Uint8Array(BACKDROP_ROWS * 4);
  private readonly reducedMotion: MediaQueryList | null;
  private fpsMeter: FpsMeter | null = null;
  private mode: SandboxMode = 'ROVER';
  private started = false;
  private userPaused = false;
  private hiddenPaused = false;
  private offscreenPaused = false;
  private rafId = 0;
  private lastNow = -1;
  private simTime = 0;
  private synthDirty = false;
  private pendingSeed = DEFAULT_SITE_SEED;
  private currentSeed = DEFAULT_SITE_SEED;
  private synthesized = false;
  private prevCpuMs = 0;
  private prevSynth = false;

  // World look: `shownLook` is what is on screen; it blends from `fromLook` to `targetLook`.
  private body: Body = 'moon';
  private sunlit = true;
  private targetLook: BodyLook = lookFor('moon');
  private readonly fromLook = copyLook(lookFor('moon'), createLook());
  private readonly shownLook = copyLook(lookFor('moon'), createLook());
  private lookBlend = 1;
  private readonly sunFrom = new Vector3(0, 1, 0);
  private readonly sunTo = new Vector3(0, 1, 0);
  private readonly rimFrom = new Color();
  private readonly rimTo = new Color();
  private readonly paletteLow: Rgb = [0, 0, 0];
  private readonly paletteHigh: Rgb = [0, 0, 0];
  private readonly strataRgb: Rgb = [0, 0, 0];

  // Camera travel on mode switch: progress 0..1, 1 = idle.
  private travel = 1;
  private readonly travelFromPosition = new Vector3();
  private readonly travelFromTarget = new Vector3();

  constructor(canvas: HTMLCanvasElement, options: SandboxEngineOptions = {}) {
    this.container = options.container ?? canvas.parentElement ?? canvas;
    this.renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFShadowMap;

    const gl = this.renderer.getContext();
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    const gpuName = gl.getParameter(debugInfo !== null ? debugInfo.UNMASKED_RENDERER_WEBGL : gl.RENDERER) as string | null;
    this.governor = new QualityGovernor({
      integrated: looksIntegrated(gpuName),
      maxScale: renderScaleCap(window.devicePixelRatio),
    });
    this.renderer.setPixelRatio(this.governor.renderScale);
    this.quality = {
      getState: () => this.governor.getState(),
      setAuto: (auto) => this.governor.setAuto(auto),
      setLevel: (level) => {
        if (this.governor.setLevel(level)) this.applyQuality();
      },
      lock: (level) => {
        if (this.governor.lock(level)) this.applyQuality();
      },
      unlock: () => this.governor.unlock(),
    };

    this.scene = new Scene();
    // Backdrop: one tiny vertical gradient, rewritten in place on world change. sRGB, so it is not tone mapped.
    this.backdrop = new DataTexture(this.backdropData, 1, BACKDROP_ROWS, RGBAFormat, UnsignedByteType);
    this.backdrop.colorSpace = SRGBColorSpace;
    this.backdrop.magFilter = LinearFilter;
    this.backdrop.minFilter = LinearFilter;
    this.scene.background = this.backdrop;
    this.fog = new FogExp2(0x000000, 0);
    this.scene.fog = this.fog;

    this.camera = new PerspectiveCamera(CAMERA_FOV_DEG, 1, 0.1, 250);
    this.camera.position.set(6, 5, -8);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    // Just above the horizon: the block has no bottom face, so the camera must never look at it from below.
    this.controls.maxPolarAngle = Math.PI * 0.485;
    this.controls.minDistance = 2.2;
    this.controls.maxDistance = 42;

    this.hemi = new HemisphereLight(0xffffff, 0x000000, 1);
    this.sun = new DirectionalLight(0xffffff, 1);
    this.sun.castShadow = this.governor.shadowMapSize > 0;
    this.sun.shadow.bias = SHADOW_BIAS;
    this.sun.shadow.normalBias = SHADOW_NORMAL_BIAS_M;
    const mapSize = this.governor.shadowMapSize > 0 ? this.governor.shadowMapSize : 512;
    this.sun.shadow.mapSize.set(mapSize, mapSize);
    this.scene.add(this.hemi, this.sun, this.sun.target);

    this.terrain = new TerrainGenerator();
    this.rocks = new RockFieldInstancer();
    this.dust = new DustSystemQuarks();
    this.walls = new BlockWalls(this.terrain.positionArray, this.terrain.detailTexture);
    this.scene.add(this.terrain.mesh, this.walls.mesh, this.walls.rim, this.rocks.mesh, this.dust.batch, this.dust.emitter);

    const ctx: SolverContext = {
      vector: etlVector,
      physics: this.physics,
      terrainMesh: this.terrain.mesh,
      timings: this.timings,
    };
    this.suit = new SuitDustSolver(ctx);
    this.solvers = {
      ROVER: new RoverSolver(ctx),
      SUIT_EDS: this.suit,
      LIDAR_LANDER: new LidarBvhSolver(ctx),
      ISRU_DRILL: new IsruDrillSolver(ctx),
    };
    for (const m of SANDBOX_MODES) {
      const group = this.solvers[m].group;
      group.visible = m === this.mode;
      SandboxEngine.enableShadows(group);
      this.scene.add(group);
    }

    this.loop = (now: number) => this.frame(now);
    this.reducedMotion = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

    // The user takes over the camera: stop the travel where it is.
    const cancelTravel = (): void => {
      this.travel = 1;
    };
    canvas.addEventListener('pointerdown', cancelTravel, { passive: true });
    canvas.addEventListener('wheel', cancelTravel, { passive: true });

    // Size from the container, not the window: the HUD rail docks beside the canvas.
    new ResizeObserver(() => this.resize()).observe(this.container);
    new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      this.offscreenPaused = entry !== undefined && !entry.isIntersecting;
      this.updateLoopState();
    }).observe(canvas);
    document.addEventListener('visibilitychange', () => {
      this.hiddenPaused = document.hidden;
      this.updateLoopState();
    });
    this.hiddenPaused = document.hidden;

    // Hardware metal and glass reflect a small environment of the shown world (never the terrain).
    applyHardwareEnvironment(this.renderer, this.body, this.sunlit);
    setHardwareSunlit(this.sunlit);

    this.resolveSunTarget(this.sunTo);
    this.rimTo.setHex(this.targetLook.accent);
    this.finishLookBlend();
    this.applyQuality();
    this.resize();
  }

  /**
   * Opaque meshes of a mode scene cast and receive shadows; transparent helpers (scan cone, strata cut) do not.
   * A mesh opts out with `userData.castShadow = false`.
   */
  private static enableShadows(root: Object3D): void {
    root.traverse((object) => {
      const mesh = object as Mesh;
      if (mesh.isMesh !== true) return;
      const material = mesh.material as Material | Material[];
      const transparent = Array.isArray(material) ? material.some((m) => m.transparent) : material.transparent;
      const opaque = !transparent && mesh.userData.castShadow !== false;
      mesh.castShadow = opaque;
      mesh.receiveShadow = opaque;
    });
  }

  setFpsMeter(meter: FpsMeter | null): void {
    this.fpsMeter = meter;
  }

  getMode(): SandboxMode {
    return this.mode;
  }

  getSeed(): number {
    return this.currentSeed;
  }

  /**
   * Switches the mode scene. The camera travels to the mode framing in 550 ms; `instant`, a paused loop or
   * `prefers-reduced-motion` snap instead. A pointer-down on the canvas cancels the travel.
   */
  setMode(mode: SandboxMode, options?: SetModeOptions): void {
    const previous = this.solvers[this.mode];
    const next = this.solvers[mode];
    if (previous !== next) previous.deactivate();
    for (const m of SANDBOX_MODES) this.solvers[m].group.visible = m === mode;
    this.mode = mode;
    next.activate();
    const snap = options?.instant === true || !this.canAnimate();
    if (snap) {
      this.travel = 1;
      this.frameCamera(next);
    } else {
      this.travelFromPosition.copy(this.camera.position);
      this.travelFromTarget.copy(this.controls.target);
      this.travel = 0;
    }
    // The visible sun follows the solver that computes with one (LiDAR); the shadow frustum follows the hardware.
    this.resolveSunTarget(_v1);
    if (_v1.distanceToSquared(this.sunTo) > 1e-8) this.beginLookBlend(snap);
    else this.placeSun();
    this.renderStill();
  }

  /** World whose look the scene shows. */
  getBody(): Body {
    return this.body;
  }

  /** False while the scene shows a site without direct sun. */
  isSunlit(): boolean {
    return this.sunlit;
  }

  /**
   * Changes the world: sky, light, exposure, haze and terrain tint blend over 500 ms (snap with `immediate`, a
   * paused loop or `prefers-reduced-motion`). Physics is not touched: gravity has its own setter.
   */
  setBody(body: Body, options?: SetBodyOptions): void {
    const sunlit = options?.sunlit ?? true;
    const immediate = options?.immediate === true;
    if (body === this.body && sunlit === this.sunlit) {
      if (immediate && this.lookBlend < 1) this.finishLookBlend();
      return;
    }
    this.body = body;
    this.sunlit = sunlit;
    this.targetLook = lookFor(body, sunlit);
    applyHardwareEnvironment(this.renderer, body, sunlit);
    setHardwareSunlit(sunlit);
    this.beginLookBlend(immediate);
  }

  /** Marks the vector dirty; synthesis runs at the start of the next frame (at most once per frame). */
  requestSynthesis(seed: number): void {
    this.pendingSeed = seed;
    this.synthDirty = true;
    if (this.started && this.rafId === 0) {
      // No frame is scheduled while paused: apply now and show one still frame.
      this.synthDirty = false;
      this.synthesizeNow(seed);
      this.renderer.render(this.scene, this.camera);
    }
  }

  /** Synchronous synthesis of terrain, cut block, BVH, rocks and solver-derived state; fills synthTimings. */
  synthesizeNow(seed: number): void {
    const v = etlVector;
    const s = this.synthTimings;
    const t0 = performance.now();
    this.terrain.synthesize(seed, v[0], v[1], v[3], v[4], s);
    const w0 = performance.now();
    this.walls.update(this.terrain.positionArray);
    const r0 = performance.now();
    s.wallsMs = r0 - w0;
    s.rockCount = this.rocks.regenerate(seed, v[1]);
    s.rocksMs = performance.now() - r0;
    const surface = this.terrain.surfaceClass;
    this.dust.onVectorChanged(v, surface);
    this.applyPalette();
    this.placeSun();
    for (const m of SANDBOX_MODES) this.solvers[m].onVectorChanged();
    s.totalMs = performance.now() - t0;
    this.currentSeed = seed;
    this.synthesized = true;
  }

  /** Full MeshBVH rebuild of the terrain; returns elapsed ms (compare with synthTimings.bvhMs refit). */
  rebuildTerrainBvhFull(): number {
    return this.terrain.rebuildBvhFull();
  }

  pulseEds(): void {
    this.suit.pulse();
    this.dust.triggerEdsSweep();
  }

  setGravity(g: number): void {
    if (Number.isFinite(g)) this.physics.gravity = clamp(g, 0.1, 30);
  }

  getGravity(): number {
    return this.physics.gravity;
  }

  addFrameListener(fn: FrameListener): void {
    this.frameListeners.push(fn);
  }

  removeFrameListener(fn: FrameListener): void {
    const i = this.frameListeners.indexOf(fn);
    if (i >= 0) this.frameListeners.splice(i, 1);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    if (this.synthDirty || !this.synthesized) {
      this.synthDirty = false;
      this.synthesizeNow(this.pendingSeed);
    }
    this.finishLookBlend();
    this.compileAll();
    this.setMode(this.mode, { instant: true });
    this.updateLoopState();
  }

  pause(): void {
    this.userPaused = true;
    this.updateLoopState();
  }

  resume(): void {
    this.userPaused = false;
    this.updateLoopState();
  }

  /** True while no frame is scheduled (user pause, hidden tab, canvas off screen, or not started). */
  isPaused(): boolean {
    return this.rafId === 0;
  }

  /** Compiles every mode scene with and without the shadow map, so neither variant stalls a later frame. */
  private compileAll(): void {
    for (const m of SANDBOX_MODES) this.solvers[m].group.visible = true;
    const cast = this.sun.castShadow;
    this.sun.castShadow = !cast;
    this.renderer.compile(this.scene, this.camera);
    this.sun.castShadow = cast;
    this.renderer.compile(this.scene, this.camera);
    for (const m of SANDBOX_MODES) this.solvers[m].group.visible = m === this.mode;
  }

  private updateLoopState(): void {
    const shouldRun = this.started && !this.userPaused && !this.hiddenPaused && !this.offscreenPaused;
    if (shouldRun && this.rafId === 0) {
      this.lastNow = -1;
      this.rafId = requestAnimationFrame(this.loop);
    } else if (!shouldRun && this.rafId !== 0) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

  /** Motion is allowed only while frames run and the user has not asked for reduced motion. */
  private canAnimate(): boolean {
    return this.rafId !== 0 && (this.reducedMotion === null || !this.reducedMotion.matches);
  }

  /** One still frame while no frame is scheduled, so a change made during a pause is visible. */
  private renderStill(): void {
    if (this.started && this.rafId === 0) this.renderer.render(this.scene, this.camera);
  }

  private resize(): void {
    const w = Math.max(1, Math.floor(this.container.clientWidth));
    const h = Math.max(1, Math.floor(this.container.clientHeight));
    this.governor.setMaxScale(renderScaleCap(window.devicePixelRatio));
    if (this.renderer.getPixelRatio() !== this.governor.renderScale) this.renderer.setPixelRatio(this.governor.renderScale);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.applyQuality();
    // Resizing clears the canvas and this runs after the frame callback: draw again so no blank frame shows.
    if (this.started) this.renderer.render(this.scene, this.camera);
  }

  /** Pushes the governor level to the renderer (drawing buffer size, shadow map) and to the timings. */
  private applyQuality(): void {
    const scale = this.governor.renderScale;
    if (this.renderer.getPixelRatio() !== scale) this.renderer.setPixelRatio(scale);
    this.updateShadowState();
    this.timings.renderScale = scale;
    this.timings.qualityLevel = this.governor.level;
    this.renderStill();
  }

  /** Shadows are on when the quality level has a shadow map and the shown world has direct sun. */
  private updateShadowState(): void {
    const size = this.governor.shadowMapSize;
    const wanted = size > 0 && this.shownLook.sunIntensity > 1e-3;
    if (this.sun.castShadow !== wanted) this.sun.castShadow = wanted;
    if (size > 0 && this.sun.shadow.mapSize.x !== size) this.sun.shadow.mapSize.set(size, size);
    this.timings.shadowMapSize = wanted ? size : 0;
  }

  // ------------------------------------------------------------------------------------------- World look

  /** Sun direction the scene should show: the active solver's own vector when it has one, else the look's. */
  private resolveSunTarget(out: Vector3): Vector3 {
    const solverSun = this.solvers[this.mode].sunDirection;
    if (solverSun !== undefined && this.targetLook.sunIntensity > 0) return out.copy(solverSun);
    sunDirection(this.targetLook.sunElevationDeg, this.targetLook.sunAzimuthDeg, out);
    return out;
  }

  private beginLookBlend(immediate: boolean): void {
    copyLook(this.shownLook, this.fromLook);
    this.sunFrom.copy(this.sunDirection);
    this.rimFrom.copy(this.walls.rim.material.color);
    this.resolveSunTarget(this.sunTo);
    this.rimTo.setHex(this.targetLook.accent);
    if (immediate || !this.canAnimate()) {
      this.finishLookBlend();
      this.renderStill();
    } else {
      this.lookBlend = 0;
    }
  }

  private finishLookBlend(): void {
    this.lookBlend = 1;
    this.applyLookAt(1);
  }

  /** Shows the blend at eased progress `e` (0 = previous look, 1 = target look). No allocation. */
  private applyLookAt(e: number): void {
    blendLooks(this.fromLook, this.targetLook, e, this.shownLook);
    this.sunDirection.lerpVectors(this.sunFrom, this.sunTo, e).normalize();
    this.walls.rim.material.color.lerpColors(this.rimFrom, this.rimTo, e);
    const look = this.shownLook;
    this.renderer.toneMappingExposure = look.exposure;
    setRgb(this.sun.color, look.sunColor);
    this.sun.intensity = look.sunIntensity;
    this.sun.shadow.radius = look.shadowRadius;
    setRgb(this.hemi.color, look.hemiSky);
    setRgb(this.hemi.groundColor, look.hemiGround);
    this.hemi.intensity = look.hemiIntensity;
    setRgb(this.fog.color, look.hazeColor);
    this.fog.density = look.hazeDensity;
    writeBackdrop(look, this.backdropData);
    this.backdrop.needsUpdate = true;
    this.applyPalette();
    this.placeSun();
    this.updateShadowState();
  }

  /** Terrain, wall, rock and dust colours from the shown look and the surface class of the last synthesis. */
  private applyPalette(): void {
    const look = this.shownLook;
    const terrain = this.terrain;
    const low = this.paletteLow;
    const high = this.paletteHigh;
    const surface = terrain.surfaceTint;
    terrainPalette(look, surface.r, surface.g, surface.b, terrain.albedo, low, high);
    terrain.setPalette(low, high);
    const sun = this.sunDirection;
    const ice = iceWeightFraction(etlVector[4]) / MAX_ICE_WT;
    const gain = wallGain(sun.x, sun.y, sun.z, look.sunIntensity);
    this.walls.setPalette(low, high, ice, gain);
    // Drill strata: the wall bed colours, lit like flat ground (they are unlit; tone mapping applies exposure).
    const strataLight = (look.sunIntensity * Math.max(sun.y, 0.25) + 0.7 * look.hemiIntensity) / Math.PI;
    for (let i = 0; i < STRATA_BOUNDS_M.length - 1; i++) {
      const rgb = strataBandRgb(i, low, high, ice, gain, this.strataRgb);
      setStrataTint(i, rgb[0] * strataLight, rgb[1] * strataLight, rgb[2] * strataLight);
    }
    // Rocks: slightly darker than the ground they sit on.
    this.rocks.setTint(
      (0.55 * low[0] + 0.45 * high[0]) * 0.82,
      (0.55 * low[1] + 0.45 * high[1]) * 0.82,
      (0.55 * low[2] + 0.45 * high[2]) * 0.82,
    );
    // Dust sprites are unlit: give them about the brightness of sunlit flat ground, so motes read as lit dust
    // against shadow and sky and disappear against lit ground.
    const light = ((look.sunIntensity * Math.max(sun.y, 0.25) + 0.7 * look.hemiIntensity) / Math.PI) * look.exposure;
    this.dust.setTint(displayTone(high[0] * light), displayTone(high[1] * light), displayTone(high[2] * light));
  }

  /**
   * Places the sun along `sunDirection` and fits its shadow frustum to the block: the light-space bounds of the
   * 20 m footprint between the lowest terrain point and the hardware headroom of the mode. The frustum is static
   * between changes (it does not follow the camera), so shadow edges never swim.
   */
  private placeSun(): void {
    const dir = this.sunDirection;
    const minY = this.terrain.minY - SHADOW_MARGIN_M;
    const maxY = this.terrain.maxY + SHADOW_HEADROOM_M[this.mode];
    const centreY = 0.5 * (minY + maxY);
    this.sun.target.position.set(0, centreY, 0);
    this.sun.position.set(dir.x * SUN_DISTANCE_M, centreY + dir.y * SUN_DISTANCE_M, dir.z * SUN_DISTANCE_M);

    // Light basis as Matrix4.lookAt builds it for the shadow camera (default +y up).
    _axisX.set(0, 1, 0).cross(dir).normalize();
    _axisY.crossVectors(dir, _axisX);
    const half = PLOT_HALF + SHADOW_MARGIN_M;
    const halfY = 0.5 * (maxY - minY);
    let left = Infinity;
    let right = -Infinity;
    let bottom = Infinity;
    let top = -Infinity;
    let nearest = -Infinity;
    let farthest = Infinity;
    for (let i = 0; i < 8; i++) {
      const px = (i & 1) !== 0 ? half : -half;
      const py = (i & 2) !== 0 ? halfY : -halfY;
      const pz = (i & 4) !== 0 ? half : -half;
      const lx = px * _axisX.x + py * _axisX.y + pz * _axisX.z;
      const ly = px * _axisY.x + py * _axisY.y + pz * _axisY.z;
      const lz = px * dir.x + py * dir.y + pz * dir.z;
      if (lx < left) left = lx;
      if (lx > right) right = lx;
      if (ly < bottom) bottom = ly;
      if (ly > top) top = ly;
      if (lz > nearest) nearest = lz;
      if (lz < farthest) farthest = lz;
    }
    const camera = this.sun.shadow.camera;
    camera.left = left;
    camera.right = right;
    camera.bottom = bottom;
    camera.top = top;
    camera.near = SUN_DISTANCE_M - nearest - 0.5;
    camera.far = SUN_DISTANCE_M - farthest + 0.5;
    camera.updateProjectionMatrix();
  }

  // ------------------------------------------------------------------------------------------- Camera

  /** Orbit target of a mode: the solver focus, lifted so tall hardware is centred. */
  private modeTarget(solver: ModeSolver, out: Vector3): Vector3 {
    out.copy(solver.focus);
    out.y += MODE_FOCUS_LIFT_M[solver.mode];
    return out;
  }

  private frameCamera(solver: ModeSolver): void {
    this.modeTarget(solver, this.controls.target);
    this.camera.position.copy(this.controls.target).add(MODE_CAMERA_OFFSET[solver.mode]);
    this.controls.update();
    this.keepCameraAboveGround();
  }

  /** Travel from the pose at the switch to the mode framing (which follows a moving focus). */
  private advanceTravel(solver: ModeSolver, dt: number): void {
    this.travel = Math.min(1, this.travel + (dt * 1000) / CAMERA_TRAVEL_MS);
    const e = easeInOut(this.travel);
    this.modeTarget(solver, _focus);
    _v2.copy(_focus).add(MODE_CAMERA_OFFSET[solver.mode]);
    this.controls.target.lerpVectors(this.travelFromTarget, _focus, e);
    this.camera.position.lerpVectors(this.travelFromPosition, _v2, e);
  }

  /** Eases the orbit target (and camera, keeping the user's orbit offset) toward the solver focus. */
  private followFocus(solver: ModeSolver, dt: number): void {
    const k = Math.min(1, dt * FOCUS_EASE_PER_S);
    _v1.subVectors(this.modeTarget(solver, _focus), this.controls.target);
    if (_v1.lengthSq() > 25) {
      // Large jump (e.g. the rover wrapping at the plot edge): snap instead of sweeping across the plot.
      this.controls.target.add(_v1);
      this.camera.position.add(_v1);
      return;
    }
    _v1.multiplyScalar(k);
    this.controls.target.add(_v1);
    this.camera.position.add(_v1);
  }

  /** Inside the plot the camera stays above the surface, so the inside of the block is never seen. */
  private keepCameraAboveGround(): void {
    const p = this.camera.position;
    if (p.x < -PLOT_HALF || p.x > PLOT_HALF || p.z < -PLOT_HALF || p.z > PLOT_HALF) return;
    const floor = sampleHeight(p.x, p.z) + CAMERA_CLEARANCE_M;
    if (p.y < floor) {
      p.y = floor;
      this.camera.lookAt(this.controls.target);
    }
  }

  // ------------------------------------------------------------------------------------------- Frame

  private frame(now: number): void {
    this.rafId = requestAnimationFrame(this.loop);
    const cpu0 = performance.now();
    let frameMs = 0;
    let dt = 0;
    if (this.lastNow >= 0) {
      frameMs = now - this.lastNow;
      dt = clamp(frameMs / 1000, 0, 0.1);
    }
    this.lastNow = now;

    // The interval measured now is the cost of the previous frame: pair it with that frame's CPU time and
    // synthesis flag. A level change resizes the drawing buffer here, before this frame is drawn.
    if (this.governor.sample(frameMs, this.prevCpuMs, this.prevSynth)) this.applyQuality();

    let synthMs = 0;
    if (this.synthDirty) {
      this.synthDirty = false;
      const s0 = performance.now();
      this.synthesizeNow(this.pendingSeed);
      synthMs = performance.now() - s0;
    }

    this.simTime += dt;
    const solver = this.solvers[this.mode];
    const u0 = performance.now();
    solver.update(dt, this.simTime);
    this.dust.update(dt);
    const u1 = performance.now();

    if (this.travel < 1) this.advanceTravel(solver, dt);
    else this.followFocus(solver, dt);
    this.controls.update(dt);
    this.keepCameraAboveGround();

    if (this.lookBlend < 1) {
      this.lookBlend = Math.min(1, this.lookBlend + (dt * 1000) / LOOK_BLEND_MS);
      this.applyLookAt(easeInOut(this.lookBlend));
    }

    const hook = this.renderPassHook;
    if (hook !== null) hook.beforeRender();
    const r0 = performance.now();
    this.renderer.render(this.scene, this.camera);
    const r1 = performance.now();
    if (hook !== null) hook.afterRender();

    const t = this.timings;
    t.frameMs = frameMs;
    t.updateMs = u1 - u0;
    t.renderMs = r1 - r0;
    t.drawCalls = this.renderer.info.render.calls;
    t.triangles = this.renderer.info.render.triangles;
    t.cpuMs = r1 - cpu0;
    t.synthMs = synthMs;
    if (this.mode !== 'LIDAR_LANDER') t.lidarMs = 0;

    this.prevCpuMs = t.cpuMs;
    this.prevSynth = synthMs > 0;

    if (this.fpsMeter !== null && frameMs > 0) this.fpsMeter.tick(t, now);
    const listeners = this.frameListeners;
    for (let i = 0; i < listeners.length; i++) listeners[i](now);
  }
}
