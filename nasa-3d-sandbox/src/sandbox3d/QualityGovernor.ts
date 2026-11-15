/**
 * Quality governor (art direction, "Performance contract"). The scene is fill-rate bound on integrated graphics,
 * so one ordered ladder of (render scale, shadow map) levels is stepped from measured frame times, with
 * hysteresis and exponential back-off. Pure: no DOM, no WebGL; `sample` does not allocate.
 */

export interface QualityLevel {
  /** Render scale (drawing-buffer pixels per CSS pixel) before the device cap. */
  readonly scale: number;
  /** Shadow map side in texels; 0 turns the shadows off. */
  readonly shadowMapSize: number;
}

/** L0 (best) to L6 (cheapest). */
export const QUALITY_LADDER: readonly QualityLevel[] = [
  { scale: 1.5, shadowMapSize: 1024 },
  { scale: 1.25, shadowMapSize: 1024 },
  { scale: 1.0, shadowMapSize: 1024 },
  { scale: 1.0, shadowMapSize: 512 },
  { scale: 0.85, shadowMapSize: 512 },
  { scale: 0.85, shadowMapSize: 0 },
  { scale: 0.7, shadowMapSize: 0 },
];

/** The render scale never exceeds min(devicePixelRatio, MAX_RENDER_SCALE). */
export const MAX_RENDER_SCALE = 1.5;
/** A frame is "slow" above this interval (50 FPS). */
export const SLOW_FRAME_MS = 20;
/** Step down when this share of the last WINDOW_FRAMES sampled frames is slow. */
export const WINDOW_FRAMES = 60;
export const DOWN_FRACTION = 0.25;
/** No second step down before this much sampled time has passed since the last change. */
export const DOWN_COOLDOWN_MS = 1500;
/** Probe one level up after this much stable sampled time. */
export const STABLE_MS = 8000;
/** "Stable" means at most this share of slow frames. */
export const STABLE_FRACTION = 0.02;
/** The first probe after start comes sooner, so a capable machine does not sit at the start level. */
export const FIRST_PROBE_MS = 4000;
/** A step down this soon after a probe marks the probe as failed. */
export const PROBE_WINDOW_MS = 4000;
/** Back-off of a failed probe: 16 s, 32 s, ... capped at 120 s. */
export const BACKOFF_FIRST_MS = 16_000;
export const BACKOFF_CAP_MS = 120_000;
/** Frames longer than this are hitches (tab switch, shader compile), not a steady-state signal. */
export const IGNORE_FRAME_MS = 250;
/** Frames whose measured CPU time exceeds this are CPU-bound: fewer pixels would not help. */
export const CPU_BOUND_MS = 12;

const LAST_LEVEL = QUALITY_LADDER.length - 1;
const INTEGRATED_START_LEVEL = 2;
const DOWN_FRAMES = Math.ceil(WINDOW_FRAMES * DOWN_FRACTION);
const INTEGRATED_PATTERN = /intel|uhd|iris|mali|adreno|powervr|swiftshader|llvmpipe/i;

export interface QualityState {
  level: number;
  /** Effective render scale (after the device cap). */
  renderScale: number;
  shadowMapSize: number;
  /** False when a fixed level was requested (`?quality=N`). */
  auto: boolean;
  /** True while a caller (the benchmark) pins the level. */
  locked: boolean;
}

export interface QualityGovernorOptions {
  /** min(devicePixelRatio, 1.5). Default 1.5. */
  maxScale?: number;
  /** True when the GPU looks integrated: start at L2 instead of L0. */
  integrated?: boolean;
}

/** True when the unmasked WebGL renderer string names an integrated or software GPU. */
export function looksIntegrated(renderer: string | null | undefined): boolean {
  return typeof renderer === 'string' && INTEGRATED_PATTERN.test(renderer);
}

/** min(devicePixelRatio, 1.5); 1 when the ratio is not a positive number. */
export function renderScaleCap(devicePixelRatio: number): number {
  if (!(devicePixelRatio > 0) || !Number.isFinite(devicePixelRatio)) return 1;
  return Math.min(devicePixelRatio, MAX_RENDER_SCALE);
}

/** Parses the `?quality=` URL parameter: 'auto', a level 0..6, or null when absent or invalid. */
export function parseQualityParam(raw: string | null | undefined): 'auto' | number | null {
  if (raw === null || raw === undefined) return null;
  const text = raw.trim().toLowerCase();
  if (text === 'auto') return 'auto';
  if (!/^[0-9]$/.test(text)) return null;
  const level = Number(text);
  return level <= LAST_LEVEL ? level : null;
}

export class QualityGovernor {
  private maxScale: number;
  private current: number;
  private autoMode = true;
  private isLocked = false;

  /** Ring of the last WINDOW_FRAMES sampled frames: 1 = slow. */
  private readonly ring = new Uint8Array(WINDOW_FRAMES);
  private ringHead = 0;
  private ringCount = 0;
  private slowInRing = 0;

  /** Sampled time (ms): only the frames that count advance it, so pauses and hitches do not. */
  private clockMs = 0;
  private lastChangeClock = 0;
  private stableStartClock = 0;
  private stableFrames = 0;
  private stableSlow = 0;
  private firstProbePending = true;

  /** Stable time required before probing up TO each level (back-off state). */
  private readonly requiredStableMs = new Float64Array(QUALITY_LADDER.length).fill(STABLE_MS);
  private probeLevel = -1;
  private probeFromLevel = -1;
  private probeClock = 0;

  constructor(options: QualityGovernorOptions = {}) {
    this.maxScale = options.maxScale !== undefined && options.maxScale > 0 ? Math.min(options.maxScale, MAX_RENDER_SCALE) : MAX_RENDER_SCALE;
    this.current = this.normalize(options.integrated === true ? INTEGRATED_START_LEVEL : 0);
  }

  get level(): number {
    return this.current;
  }

  get renderScale(): number {
    return Math.min(QUALITY_LADDER[this.current].scale, this.maxScale);
  }

  get shadowMapSize(): number {
    return QUALITY_LADDER[this.current].shadowMapSize;
  }

  get auto(): boolean {
    return this.autoMode;
  }

  get locked(): boolean {
    return this.isLocked;
  }

  /** New state object (allocates). Use `writeState` on a hot path. */
  getState(): QualityState {
    return this.writeState({ level: 0, renderScale: 0, shadowMapSize: 0, auto: true, locked: false });
  }

  writeState(out: QualityState): QualityState {
    out.level = this.current;
    out.renderScale = this.renderScale;
    out.shadowMapSize = this.shadowMapSize;
    out.auto = this.autoMode;
    out.locked = this.isLocked;
    return out;
  }

  /** Updates the device cap (devicePixelRatio can change). Returns true when the effective settings changed. */
  setMaxScale(maxScale: number): boolean {
    const next = maxScale > 0 ? Math.min(maxScale, MAX_RENDER_SCALE) : MAX_RENDER_SCALE;
    if (next === this.maxScale) return false;
    const scaleBefore = this.renderScale;
    const shadowBefore = this.shadowMapSize;
    this.maxScale = next;
    this.current = this.normalize(this.current);
    this.resetWindows();
    return this.renderScale !== scaleBefore || this.shadowMapSize !== shadowBefore;
  }

  /** Automatic stepping on or off. The level is kept. */
  setAuto(auto: boolean): void {
    this.autoMode = auto;
    this.resetWindows();
  }

  /** Jumps to a level (clamped to 0..6 and to the device cap). Returns true when the level changed. */
  setLevel(level: number): boolean {
    const target = this.normalize(Number.isFinite(level) ? Math.round(level) : this.current);
    this.probeLevel = -1;
    this.resetWindows();
    if (target === this.current) return false;
    this.current = target;
    return true;
  }

  /**
   * Pins the level until `unlock`. Without an argument the current level is pinned, except that an unverified
   * probe (younger than 4 s) falls back to the level it came from. Returns true when the level changed.
   */
  lock(level?: number): boolean {
    let changed = false;
    if (level !== undefined) {
      changed = this.setLevel(level);
    } else if (this.probeLevel === this.current && this.clockMs - this.probeClock <= PROBE_WINDOW_MS) {
      this.current = this.probeFromLevel;
      changed = true;
    }
    this.probeLevel = -1;
    this.isLocked = true;
    this.resetWindows();
    return changed;
  }

  unlock(): void {
    this.isLocked = false;
    this.resetWindows();
  }

  /**
   * Feeds one frame: `frameMs` is the rAF interval, `cpuMs` the CPU time measured inside the frame callback and
   * `synthesized` whether a terrain synthesis ran. Returns true when the level changed. Never allocates.
   */
  sample(frameMs: number, cpuMs: number, synthesized: boolean): boolean {
    if (!(frameMs > 0) || frameMs > IGNORE_FRAME_MS || synthesized || cpuMs > CPU_BOUND_MS) return false;

    this.clockMs += frameMs;
    const slow = frameMs > SLOW_FRAME_MS ? 1 : 0;
    if (this.ringCount === WINDOW_FRAMES) this.slowInRing -= this.ring[this.ringHead];
    else this.ringCount++;
    this.ring[this.ringHead] = slow;
    this.ringHead = (this.ringHead + 1) % WINDOW_FRAMES;
    this.slowInRing += slow;
    this.stableFrames++;
    this.stableSlow += slow;

    if (!this.autoMode || this.isLocked) return false;

    const clock = this.clockMs;
    if (this.probeLevel >= 0 && clock - this.probeClock > PROBE_WINDOW_MS) {
      // The probe survived its window: that level is verified, its back-off starts over.
      this.requiredStableMs[this.probeLevel] = STABLE_MS;
      this.probeLevel = -1;
    }

    // Down: enough slow frames in the window and the cool-down has passed.
    if (this.slowInRing >= DOWN_FRAMES && clock - this.lastChangeClock >= DOWN_COOLDOWN_MS && this.current < LAST_LEVEL) {
      if (this.probeLevel === this.current) {
        const failed = this.probeLevel;
        this.requiredStableMs[failed] = Math.min(BACKOFF_CAP_MS, Math.max(BACKOFF_FIRST_MS, this.requiredStableMs[failed] * 2));
      }
      this.probeLevel = -1;
      this.firstProbePending = false;
      this.current = this.normalize(this.current + 1);
      this.resetWindows();
      return true;
    }

    // Up: a full stable window, then probe one level up.
    const target = this.levelAbove(this.current);
    if (target >= 0) {
      const required = this.firstProbePending ? Math.min(FIRST_PROBE_MS, this.requiredStableMs[target]) : this.requiredStableMs[target];
      if (clock - this.stableStartClock >= required) {
        this.firstProbePending = false;
        if (this.stableSlow <= STABLE_FRACTION * this.stableFrames) {
          this.probeFromLevel = this.current;
          this.probeLevel = target;
          this.probeClock = clock;
          this.current = target;
          this.resetWindows();
          return true;
        }
        // Not stable enough: start a new observation window at this level.
        this.stableStartClock = clock;
        this.stableFrames = 0;
        this.stableSlow = 0;
      }
    }
    return false;
  }

  private sameEffect(a: number, b: number): boolean {
    const la = QUALITY_LADDER[a];
    const lb = QUALITY_LADDER[b];
    return la.shadowMapSize === lb.shadowMapSize && Math.min(la.scale, this.maxScale) === Math.min(lb.scale, this.maxScale);
  }

  /** Clamps to the ladder and moves to the last level with the same effective settings (cap collapse). */
  private normalize(level: number): number {
    let l = level < 0 ? 0 : level > LAST_LEVEL ? LAST_LEVEL : level;
    while (l < LAST_LEVEL && this.sameEffect(l, l + 1)) l++;
    return l;
  }

  /** Next level up with different effective settings, or -1 at the top. */
  private levelAbove(level: number): number {
    let k = level - 1;
    while (k >= 0 && this.sameEffect(k, level)) k--;
    return k;
  }

  private resetWindows(): void {
    this.ring.fill(0);
    this.ringHead = 0;
    this.ringCount = 0;
    this.slowInRing = 0;
    this.lastChangeClock = this.clockMs;
    this.stableStartClock = this.clockMs;
    this.stableFrames = 0;
    this.stableSlow = 0;
  }
}
