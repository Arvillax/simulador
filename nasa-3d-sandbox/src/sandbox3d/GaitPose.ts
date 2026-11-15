/**
 * Procedural suited gait: a fixed-step walker (planted feet, swing arcs, pelvis vault or ballistic flight) and a
 * pose solver that writes joint angles into the suit rig. No allocation per frame.
 *
 * Geometry conventions follow the rig (AssetBuilder.SuitRig): the suit faces +z at yaw 0, +x is its left, and every
 * joint swings about its local x, where a positive angle moves the limb backward (toes down at the ankle).
 */
import type { SuitRig } from './AssetBuilder.ts';
import type { Gait, GaitState } from './GaitModel.ts';

export type HeightFn = (x: number, z: number) => number;

export interface WalkerDims {
  /** Lateral offset of each hip joint from the pelvis centre (m). */
  readonly hipHalfWidth: number;
  readonly thigh: number;
  readonly shin: number;
  /** Ankle joint above the sole (m). */
  readonly ankleHeight: number;
  /** Hip joint to sole, standing (m). */
  readonly legLength: number;
  readonly footLength: number;
}

/** Simulation step (s): the walker advances in fixed steps, so 30 Hz and 144 Hz displays give the same walk. */
export const GAIT_STEP_S = 1 / 240;
/** Upper bound of steps per frame (the engine clamps dt to 0.1 s, i.e. 24 steps). */
const MAX_STEPS_PER_FRAME = 30;
/** Yaw rate limit and easing (rad/s, 1/s). Visual choice, not verified. */
const YAW_RATE_MAX = 1.2;
const YAW_EASE = 4;
const ALIGN_FULL_RAD = 0.3;
const ALIGN_STOP_RAD = 0.8;
/** Speed change per second of ground contact (m/s²) and stride frequency change (Hz/s). not verified. */
const SPEED_ACCEL = 0.5;
const FREQUENCY_RATE = 0.8;
/** Stride frequency of stepping in place while stopped and turning (Hz). not verified. */
const TURN_FREQUENCY = 0.7;
const TURN_DUTY = 0.65;
/** Swing-foot clearance (m). not verified. */
const CLEARANCE_WALK = 0.07;
const CLEARANCE_BOUNCE = 0.1;
/** Bouncing gaits: nominal hip height as a fraction of the leg and stance compression (m). not verified. */
const BOUNCE_HIP_FRACTION = 0.95;
const BOUNCE_COMPRESSION = 0.03;
/** Pelvis rise easing (1/s); a fall to the leg-reach limit is immediate. */
const PELVIS_RISE_EASE = 30;
/** Fraction of the full leg the IK may use. */
const REACH_FRACTION = 0.999;

/** Apex height of a ballistic flight of duration t under gravity g: h = g·t² / 8. */
export function flightArcHeight(gravity: number, flightTime: number): number {
  return (gravity * flightTime * flightTime) / 8;
}

export interface LegIk {
  /** Hip flexion about x (negative = thigh forward). */
  hip: number;
  /** Knee flexion about x (positive = shin backward). */
  knee: number;
  /** Hip abduction about z (positive = foot toward +x). */
  abduction: number;
}

export function createLegIk(): LegIk {
  return { hip: 0, knee: 0, abduction: 0 };
}

/**
 * Two-bone IK from the hip to an ankle target (dx, dy, dz) in the hip's parent frame, knee forward. Reach is
 * clamped to the leg, so an unreachable target leaves the leg straight and pointing at it.
 */
export function solveLegIk(dx: number, dy: number, dz: number, l1: number, l2: number, out: LegIk): LegIk {
  const full = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const maxReach = (l1 + l2) * REACH_FRACTION;
  const minReach = Math.abs(l1 - l2) + 0.05;
  const d = full < minReach ? minReach : full > maxReach ? maxReach : full;
  out.abduction = full > 1e-9 ? Math.asin(Math.max(-1, Math.min(1, dx / full))) : 0;
  const cosKnee = (l1 * l1 + l2 * l2 - d * d) / (2 * l1 * l2);
  out.knee = Math.PI - Math.acos(Math.max(-1, Math.min(1, cosKnee)));
  const cosHip = (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d);
  const alpha = Math.acos(Math.max(-1, Math.min(1, cosHip)));
  out.hip = Math.atan2(-dz, -dy) - alpha;
  return out;
}

/** Steers the walker and updates its gait; called once per fixed step. Returns the target yaw (rad). */
export interface WalkerController {
  control(walker: GaitWalker, h: number): number;
}

export interface FootState {
  planted: boolean;
  /** Ground point under the ankle (world). */
  x: number;
  y: number;
  z: number;
  /** Foot pitch (positive = toes down). */
  pitch: number;
  fromX: number;
  fromY: number;
  fromZ: number;
  fromPitch: number;
  liftTime: number;
  /** Swing progress 0..1 (1 while planted). */
  swing: number;
}

function createFoot(): FootState {
  return { planted: true, x: 0, y: 0, z: 0, pitch: 0, fromX: 0, fromY: 0, fromZ: 0, fromPitch: 0, liftTime: 0, swing: 1 };
}

function wrap01(v: number): number {
  return v - Math.floor(v);
}

function wrapAngle(a: number): number {
  return a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI));
}

function smooth(u: number): number {
  return u * u * (3 - 2 * u);
}

/** Phase distance from `from` forward to `to` on the unit circle, in (0, 1]. */
function ahead(from: number, to: number): number {
  const d = wrap01(to - from);
  return d === 0 ? 1 : d;
}

/**
 * Fixed-step walker. Feet are event-driven: a foot touches down when the stride phase crosses its contact start and
 * lifts off when it crosses the contact end, so a planted foot keeps its world position until lift-off. The swing
 * foot flies from its lift-off point to where the hip will be at touchdown, plus half the stance travel.
 */
export class GaitWalker {
  /** Pelvis ground position (world). */
  x = 0;
  z = 0;
  yaw = 0;
  speed = 0;
  frequency = 0;
  /** Stride phase 0..1; foot 0 (left) touches down at 0. */
  phase = 0;
  time = 0;
  /** Pelvis (hip joint) height and terrain height under it (world). */
  pelvisY = 0;
  groundY = 0;
  /** Bouncing gaits: analytic pelvis offset from the nominal hip height (flight arc > 0). */
  bounceOffset = 0;
  gait: Gait = 'stand';
  duty = TURN_DUTY;
  gravity = 1.62;
  /** Footfall counter and the last touchdown point (world). */
  footfalls = 0;
  lastFootfallX = 0;
  lastFootfallY = 0;
  lastFootfallZ = 0;
  /** Speed multiplier set by the controller (path creeping or scanning). */
  speedScale = 1;
  readonly feet: readonly [FootState, FootState] = [createFoot(), createFoot()];
  readonly dims: WalkerDims;
  private targetSpeed = 0;
  private targetFrequency = TURN_FREQUENCY;
  private pendingGait: Gait = 'stand';
  private pendingDuty = TURN_DUTY;
  private hasGait = false;
  private accumulator = 0;

  constructor(dims: WalkerDims) {
    this.dims = dims;
  }

  /** Standing start at (x, z) facing yaw, both feet down. */
  reset(x: number, z: number, yaw: number, feetGround: HeightFn): void {
    this.x = x;
    this.z = z;
    this.yaw = yaw;
    this.speed = 0;
    this.phase = 0;
    this.time = 0;
    this.accumulator = 0;
    this.footfalls = 0;
    this.hasGait = false;
    const cx = Math.cos(yaw);
    const sx = -Math.sin(yaw);
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? 1 : -1;
      const f = this.feet[i];
      f.planted = true;
      f.x = x + cx * side * this.dims.hipHalfWidth;
      f.z = z + sx * side * this.dims.hipHalfWidth;
      f.y = feetGround(f.x, f.z);
      f.pitch = 0;
      f.swing = 1;
    }
    this.groundY = feetGround(x, z);
    this.pelvisY = this.groundY + this.dims.legLength;
    this.bounceOffset = 0;
  }

  /**
   * Takes a new gait solution. Speed and stride frequency ease toward it; the gait type and duty factor switch at
   * the next stride start (immediately on the first call after a reset). A stopped state steps in place.
   */
  setGait(state: GaitState, gravity: number): void {
    this.gravity = gravity;
    if (state.stopped || state.gait === 'stand' || state.strideFrequency <= 0) {
      this.pendingGait = 'stand';
      this.pendingDuty = TURN_DUTY;
      this.targetSpeed = 0;
      this.targetFrequency = TURN_FREQUENCY;
    } else {
      this.pendingGait = state.gait;
      this.pendingDuty = state.dutyFactor;
      this.targetSpeed = state.speed;
      this.targetFrequency = state.strideFrequency;
    }
    if (!this.hasGait) {
      this.hasGait = true;
      this.frequency = this.targetFrequency;
      this.switchGait();
    }
  }

  /**
   * Advances by dt in fixed steps. `steer` is a fixed target yaw or a controller asked once per step (so steering
   * and gait updates run on the fixed clock too). `ground` is the bare terrain; `feetGround` adds rocks.
   */
  advance(dt: number, steer: number | WalkerController, ground: HeightFn, feetGround: HeightFn): void {
    this.accumulator += dt;
    let n = 0;
    while (this.accumulator >= GAIT_STEP_S - 1e-9 && n < MAX_STEPS_PER_FRAME) {
      this.accumulator -= GAIT_STEP_S;
      const targetYaw = typeof steer === 'number' ? steer : steer.control(this, GAIT_STEP_S);
      this.step(GAIT_STEP_S, targetYaw, ground, feetGround);
      n++;
    }
    if (n === MAX_STEPS_PER_FRAME) this.accumulator = 0;
  }

  /** Contact start of foot i in the current gait. */
  private contactStart(i: number): number {
    if (i === 0) return 0;
    return this.gait === 'lope' ? this.duty : 0.5;
  }

  private inContact(i: number, phase: number): boolean {
    return wrap01(phase - this.contactStart(i)) < this.duty;
  }

  private switchGait(): void {
    this.gait = this.pendingGait;
    this.duty = this.pendingDuty;
    // A planted foot that the new gait has in the air lifts off now; a swinging one waits for its touchdown.
    for (let i = 0; i < 2; i++) {
      const f = this.feet[i];
      if (f.planted && !this.inContact(i, this.phase)) this.liftOff(f);
    }
  }

  private liftOff(f: FootState): void {
    f.planted = false;
    f.fromX = f.x;
    f.fromY = f.y;
    f.fromZ = f.z;
    f.fromPitch = f.pitch;
    f.liftTime = this.time;
    f.swing = 0;
  }

  private step(h: number, targetYaw: number, ground: HeightFn, feetGround: HeightFn): void {
    const feet = this.feet;
    const grounded = feet[0].planted || feet[1].planted;

    // Heading and speed change only through a foot on the ground.
    if (grounded) {
      const dYaw = wrapAngle(targetYaw - this.yaw);
      let turn = dYaw * Math.min(1, YAW_EASE * h);
      const maxTurn = YAW_RATE_MAX * h;
      if (turn > maxTurn) turn = maxTurn;
      else if (turn < -maxTurn) turn = -maxTurn;
      this.yaw = wrapAngle(this.yaw + turn);
      // Turn, then go: full speed within ~17° of the target heading, stepping in place beyond ~46°.
      const align = Math.min(1, Math.max(0, (ALIGN_STOP_RAD - Math.abs(dYaw)) / (ALIGN_STOP_RAD - ALIGN_FULL_RAD)));
      const dv = this.targetSpeed * this.speedScale * align - this.speed;
      const maxDv = SPEED_ACCEL * h;
      this.speed += dv > maxDv ? maxDv : dv < -maxDv ? -maxDv : dv;
    }
    const df = this.targetFrequency - this.frequency;
    const maxDf = FREQUENCY_RATE * h;
    this.frequency += df > maxDf ? maxDf : df < -maxDf ? -maxDf : df;

    const sinY = Math.sin(this.yaw);
    const cosY = Math.cos(this.yaw);
    this.x += sinY * this.speed * h;
    this.z += cosY * this.speed * h;
    this.time += h;

    // Phase and foot events.
    const f = this.frequency;
    const dPhase = f * h;
    const p0 = this.phase;
    for (let i = 0; i < 2; i++) {
      const foot = feet[i];
      const start = this.contactStart(i);
      if (!foot.planted && ahead(p0, start) <= dPhase) {
        this.updateSwing(i, foot, 1, sinY, cosY, 0, feetGround);
        foot.planted = true;
        foot.swing = 1;
        foot.pitch = this.groundPitch(foot.x, foot.z, sinY, cosY, ground);
        this.footfalls++;
        this.lastFootfallX = foot.x;
        this.lastFootfallY = foot.y;
        this.lastFootfallZ = foot.z;
      } else if (foot.planted && ahead(p0, wrap01(start + this.duty)) <= dPhase) {
        this.liftOff(foot);
      }
    }
    let p1 = p0 + dPhase;
    if (p1 >= 1) {
      p1 -= 1;
      this.phase = p1;
      this.switchGait();
    } else {
      this.phase = p1;
    }

    // Swing feet.
    for (let i = 0; i < 2; i++) {
      const foot = feet[i];
      if (foot.planted) continue;
      const tau = ahead(this.phase, this.contactStart(i)) / Math.max(f, 0.05);
      const elapsed = this.time - foot.liftTime;
      const u = elapsed / (elapsed + tau);
      this.updateSwing(i, foot, u, sinY, cosY, tau, feetGround);
    }

    this.updatePelvis(h, ground);
  }

  /** Writes the swing foot at progress u toward its predicted touchdown point (tau seconds ahead). */
  private updateSwing(
    i: number,
    foot: FootState,
    u: number,
    sinY: number,
    cosY: number,
    tau: number,
    feetGround: HeightFn,
  ): void {
    const f = Math.max(this.frequency, 0.05);
    const lead = (0.5 * this.speed * this.duty) / f;
    const side = i === 0 ? 1 : -1;
    const along = this.speed * tau + lead;
    const tx = this.x + sinY * along + cosY * side * this.dims.hipHalfWidth;
    const tz = this.z + cosY * along - sinY * side * this.dims.hipHalfWidth;
    const ty = feetGround(tx, tz);
    const s = smooth(u);
    foot.x = foot.fromX + (tx - foot.fromX) * s;
    foot.z = foot.fromZ + (tz - foot.fromZ) * s;
    const clearance = this.gait === 'walk' || this.gait === 'stand' ? CLEARANCE_WALK : CLEARANCE_BOUNCE;
    foot.y = foot.fromY + (ty - foot.fromY) * s + (u < 1 ? clearance * Math.sin(Math.PI * u) : 0);
    // Push-off (toes down) early in the swing, toes up before the touchdown.
    foot.pitch = foot.fromPitch * (1 - s) + 0.45 * (1 - u) * (1 - u) * (1 - u) - 0.18 * Math.sin(Math.PI * u);
    foot.swing = u;
  }

  /** Foot pitch that lays the sole on the ground along the heading (positive = toes down). */
  private groundPitch(x: number, z: number, sinY: number, cosY: number, ground: HeightFn): number {
    const half = 0.5 * this.dims.footLength;
    const rise = ground(x + sinY * half, z + cosY * half) - ground(x - sinY * half, z - cosY * half);
    return -Math.atan2(rise, 2 * half);
  }

  private updatePelvis(h: number, ground: HeightFn): void {
    const d = this.dims;
    const base = ground(this.x, this.z);
    this.groundY = base;
    let target: number;
    let offset = 0;
    const bouncing = this.gait === 'lope' || this.gait === 'run';
    if (bouncing) {
      const f = Math.max(this.frequency, 0.05);
      const beta = this.duty;
      // Stance and flight windows: lope = trail + lead contact then one flight; run = two (contact, flight) halves.
      const period = this.gait === 'lope' ? 1 : 0.5;
      const stance = this.gait === 'lope' ? 2 * beta : beta;
      const local = this.gait === 'lope' ? this.phase : this.phase % 0.5;
      if (local < stance) {
        offset = -BOUNCE_COMPRESSION * Math.sin((Math.PI * local) / stance);
      } else {
        const flightFrac = period - stance;
        const u = (local - stance) / flightFrac;
        offset = 4 * flightArcHeight(this.gravity, flightFrac / f) * u * (1 - u);
      }
      target = base + d.legLength * BOUNCE_HIP_FRACTION + offset;
    } else {
      target = base + d.legLength;
    }
    this.bounceOffset = offset;

    // Every planted foot must stay within reach of its hip: this is the inverted-pendulum vault of the walk.
    const reach = (d.thigh + d.shin) * REACH_FRACTION;
    const cosY = Math.cos(this.yaw);
    const sinY = Math.sin(this.yaw);
    let cap = Infinity;
    for (let i = 0; i < 2; i++) {
      const foot = this.feet[i];
      if (!foot.planted) continue;
      const side = i === 0 ? 1 : -1;
      const hx = this.x + cosY * side * d.hipHalfWidth;
      const hz = this.z - sinY * side * d.hipHalfWidth;
      const dx = foot.x - hx;
      const dz = foot.z - hz;
      const r2 = reach * reach - dx * dx - dz * dz;
      const y = foot.y + d.ankleHeight + Math.sqrt(r2 > 0 ? r2 : 0);
      if (y < cap) cap = y;
    }
    if (target > cap) target = cap;
    if (target < this.pelvisY) this.pelvisY = target;
    else this.pelvisY += (target - this.pelvisY) * Math.min(1, PELVIS_RISE_EASE * h);
    if (this.pelvisY > cap) this.pelvisY = cap;
  }
}

// ------------------------------------------------------------------------------------------- Rig pose

const _ikL = createLegIk();
const _ikR = createLegIk();

/** Cosmetic pose state carried between frames (torso lean easing). */
export interface PoseState {
  lean: number;
}

export function createPoseState(): PoseState {
  return { lean: 0 };
}

/** Forward lean (rad): suit/backpack posture, speed and uphill grade. Gains not verified. */
const LEAN_BASE = 0.1;
const LEAN_PER_FROUDE = 0.35;
const LEAN_PER_UP_GRADE = 0.8;
const LEAN_PER_DOWN_GRADE = 0.3;
const LEAN_EASE = 3;

function legPose(
  walker: GaitWalker,
  i: number,
  pelvisLocalY: number,
  sinY: number,
  cosY: number,
  out: ReturnType<typeof createLegIk>,
): void {
  const d = walker.dims;
  const foot = walker.feet[i];
  const side = i === 0 ? 1 : -1;
  // Hip joint (world) and the ankle target (world), then into the root frame (yaw only).
  const hx = walker.x + cosY * side * d.hipHalfWidth;
  const hz = walker.z - sinY * side * d.hipHalfWidth;
  const wx = foot.x - hx;
  const wz = foot.z - hz;
  const dy = foot.y + d.ankleHeight - (walker.groundY + pelvisLocalY);
  const lx = wx * cosY - wz * sinY;
  const lz = wx * sinY + wz * cosY;
  solveLegIk(lx, dy, lz, d.thigh, d.shin, out);
}

/**
 * Writes the walker into the rig: root on the ground under the pelvis with the walker's yaw, pelvis height, leg IK
 * with feet laid on the ground, counter-phase arm swing and a forward lean. No allocation.
 */
export function applySuitPose(
  rig: SuitRig,
  walker: GaitWalker,
  froude: number,
  grade: number,
  dt: number,
  pose: PoseState,
): void {
  const sinY = Math.sin(walker.yaw);
  const cosY = Math.cos(walker.yaw);
  rig.root.position.set(walker.x, walker.groundY, walker.z);
  rig.root.rotation.y = walker.yaw;
  const pelvisLocalY = walker.pelvisY - walker.groundY;
  rig.pelvis.position.y = pelvisLocalY;

  legPose(walker, 0, pelvisLocalY, sinY, cosY, _ikL);
  legPose(walker, 1, pelvisLocalY, sinY, cosY, _ikR);
  rig.hipL.rotation.set(_ikL.hip, 0, _ikL.abduction);
  rig.kneeL.rotation.x = _ikL.knee;
  rig.ankleL.rotation.x = walker.feet[0].pitch - _ikL.hip - _ikL.knee;
  rig.hipR.rotation.set(_ikR.hip, 0, _ikR.abduction);
  rig.kneeR.rotation.x = _ikR.knee;
  rig.ankleR.rotation.x = walker.feet[1].pitch - _ikR.hip - _ikR.knee;

  // Arms swing against the opposite leg; in the bouncing gaits they stay forward with little swing.
  const bouncing = walker.gait === 'lope' || walker.gait === 'run';
  const gain = bouncing ? 0.3 : 0.7;
  const bias = bouncing ? -0.3 : -0.08;
  const shoulderL = bias + gain * _ikR.hip;
  const shoulderR = bias + gain * _ikL.hip;
  rig.shoulderL.rotation.x = shoulderL;
  rig.shoulderR.rotation.x = shoulderR;
  rig.elbowL.rotation.x = -0.3 - 0.4 * Math.max(0, -shoulderL);
  rig.elbowR.rotation.x = -0.3 - 0.4 * Math.max(0, -shoulderR);

  const targetLean =
    LEAN_BASE +
    LEAN_PER_FROUDE * froude +
    (grade > 0 ? LEAN_PER_UP_GRADE * grade : LEAN_PER_DOWN_GRADE * grade);
  pose.lean += (targetLean - pose.lean) * Math.min(1, LEAN_EASE * dt);
  rig.torso.rotation.x = pose.lean;
  rig.helmet.rotation.x = -0.4 * pose.lean;
}
