/**
 * Automatic, deterministic walking loop across the 20 m block, and the per-step controller that couples it to the
 * gait model. Steering avoids rocks (collider grid), the rim, and slopes beyond the slip margin. The loop is seeded
 * from the site seed and every decision runs on the walker's fixed step, so the same site gives the same walk.
 */
import alea from 'alea';
import { PLOT_HALF, sampleHeight } from './TerrainGenerator.ts';
import { ROCK_STRIDE, findRockNear, rockColliders, rockReliefAt } from './RockFieldInstancer.ts';
import {
  BOOT_FRICTION,
  createGaitInputs,
  createGaitState,
  slipMargin,
  slopeSpeedFactor,
  solveGait,
} from './GaitModel.ts';
import type { GaitInputs, GaitState } from './GaitModel.ts';
import type { GaitWalker, WalkerController } from './GaitPose.ts';

export const WAYPOINT_COUNT = 6;
/** Waypoints and look-ahead probes stay this far inside the block edge (m). */
export const WALK_RIM_MARGIN_M = 1.2;
/** Clearance kept between the walking line and a rock collider (m): hip offset plus boot half-width. */
const ROCK_CLEARANCE_M = 0.2;
/** Rocks are checked at every probe (0.3 m apart), so none fits between two checks. */
const ROCK_PROBE_SUBSTEPS = 1;
/**
 * Short look-ahead probes along a candidate heading (m); the slope at each is taken over one stride (1.2 m). The
 * route grid handles the long range, the probes only the last metre.
 */
const PROBE_STEP_M = 0.3;
/** 1.5 m: about two seconds at the lunar lope, enough to turn before a rock (no turning in flight). */
const PROBE_COUNT = 5;
/** A creeping or scanning heading is kept at least this long unless its first probe fails (no ping-pong). */
const COMMIT_S = 1.5;
/** A heading is passable only with this much slip margin left. not verified. */
const SLIP_RESERVE = 0.1;
/** Candidate headings: the desired one, then alternating sides in 15° steps up to 180°. */
const CANDIDATE_STEP_RAD = Math.PI / 12;
const CANDIDATE_COUNT = 12;
const REPLAN_INTERVAL_S = 0.1;
const WAYPOINT_REACHED_M = 0.8;
/** A waypoint not reached in this time is skipped (it may sit behind a steep patch). */
const WAYPOINT_TIMEOUT_S = 15;
const RAD2DEG = 180 / Math.PI;
/** After a slip stop, headings within ±45° of the stopped one are excluded for 3 s. */
const TURN_AWAY_RAD = Math.PI / 4;
const TURN_AWAY_S = 3;
/** Speed multiplier while creeping along a partly clear heading. */
const BLOCKED_SPEED_SCALE = 0.4;
/** The walker counts as facing the planned heading within this angle. */
const ALIGNED_RAD = 0.3;
const YAW_CHECK_INTERVAL_S = 0.1;

function wrapAngle(a: number): number {
  return a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI));
}

/** Ground under a boot: terrain plus rock relief. */
export function feetGroundHeight(x: number, z: number): number {
  return sampleHeight(x, z) + rockReliefAt(x, z);
}

/** Slope (deg) along the yaw at (x, z), uphill positive, from the bare terrain. */
export function slopeAlong(x: number, z: number, yaw: number, half = 0.6): number {
  const sx = Math.sin(yaw) * half;
  const sz = Math.cos(yaw) * half;
  const rise = sampleHeight(x + sx, z + sz) - sampleHeight(x - sx, z - sz);
  return Math.atan2(rise, 2 * half) * RAD2DEG;
}

// ------------------------------------------------------------------------------------------- Flow field

/** Coarse route grid: 36 x 36 cells of 0.5 m, centres from −8.75 to 8.75 m. */
const GRID_STEP_M = 0.5;
const GRID_N = 36;
const GRID_CELLS = GRID_N * GRID_N;
const GRID_HALF_M = (GRID_N * GRID_STEP_M) / 2;
const NB_DX = [1, 1, 0, -1, -1, -1, 0, 1];
const NB_DZ = [0, 1, 1, 1, 0, -1, -1, -1];
/** Route cells keep this much more room around rocks than the look-ahead probes (m). */
const GRID_ROCK_EXTRA_M = 0.1;
/** Steering aims this many cells down the field (line-of-sight smoothing). */
const FIELD_LOOKAHEAD_CELLS = 3;

function cellCentre(i: number): number {
  return -GRID_HALF_M + (i + 0.5) * GRID_STEP_M;
}

function cellIndex(v: number): number {
  const i = Math.floor((v + GRID_HALF_M) / GRID_STEP_M);
  return i < 0 ? 0 : i >= GRID_N ? GRID_N - 1 : i;
}

/**
 * Distance-to-waypoint fields over the route grid (Dijkstra, 8-connected, no corner cutting). A cell is open when
 * no rock is near its centre; an edge is open when the slope along it, over one stride, keeps the slip reserve.
 * Built once per vector or seed change, so the walker can route around rock and slope dead ends.
 */
class FlowField {
  readonly open = new Uint8Array(GRID_CELLS);
  readonly edges = new Uint8Array(GRID_CELLS);
  /** Travel-time cost per edge: length over the gait model's slope speed factor, so routes prefer gentle ground. */
  readonly edgeCost = new Float32Array(GRID_CELLS * 8);
  readonly dist = new Float32Array(WAYPOINT_COUNT * GRID_CELLS);
  targetX = 0;
  targetZ = 0;
  private readonly heapCell = new Int32Array(GRID_CELLS * 8 + 8);
  private readonly heapKey = new Float32Array(GRID_CELLS * 8 + 8);
  private heapSize = 0;

  build(friction: number): void {
    const lim = PLOT_HALF - WALK_RIM_MARGIN_M;
    for (let ix = 0; ix < GRID_N; ix++) {
      for (let iz = 0; iz < GRID_N; iz++) {
        const x = cellCentre(ix);
        const z = cellCentre(iz);
        const inside = Math.abs(x) <= lim && Math.abs(z) <= lim;
        this.open[ix * GRID_N + iz] = inside && findRockNear(x, z, ROCK_CLEARANCE_M + GRID_ROCK_EXTRA_M) < 0 ? 1 : 0;
      }
    }
    this.edges.fill(0);
    for (let ix = 0; ix < GRID_N; ix++) {
      for (let iz = 0; iz < GRID_N; iz++) {
        const c = ix * GRID_N + iz;
        if (this.open[c] === 0) continue;
        // Directions 0..3; each edge is stored on both ends.
        for (let k = 0; k < 4; k++) {
          const jx = ix + NB_DX[k];
          const jz = iz + NB_DZ[k];
          if (jx < 0 || jx >= GRID_N || jz < 0 || jz >= GRID_N) continue;
          const n = jx * GRID_N + jz;
          if (this.open[n] === 0) continue;
          if (k % 2 === 1 && (this.open[jx * GRID_N + iz] === 0 || this.open[ix * GRID_N + jz] === 0)) continue;
          const mx = 0.5 * (cellCentre(ix) + cellCentre(jx));
          const mz = 0.5 * (cellCentre(iz) + cellCentre(jz));
          const yaw = Math.atan2(NB_DX[k], NB_DZ[k]);
          const slope = slopeAlong(mx, mz, yaw);
          if (slipMargin(slope, friction) < SLIP_RESERVE) continue;
          const cost = ((k % 2 === 1 ? Math.SQRT2 : 1) * GRID_STEP_M) / Math.max(0.2, slopeSpeedFactor(slope, friction));
          this.edges[c] |= 1 << k;
          this.edges[n] |= 1 << (k + 4);
          this.edgeCost[c * 8 + k] = cost;
          this.edgeCost[n * 8 + k + 4] = cost;
        }
      }
    }
  }

  solve(w: number, wx: number, wz: number): void {
    const base = w * GRID_CELLS;
    const dist = this.dist;
    dist.fill(Infinity, base, base + GRID_CELLS);
    const source = this.nearestOpen(cellIndex(wx), cellIndex(wz));
    if (source < 0) return;
    this.heapSize = 0;
    dist[base + source] = 0;
    this.push(source, 0);
    while (this.heapSize > 0) {
      const key = this.heapKey[0];
      const c = this.pop();
      if (key > dist[base + c]) continue;
      const ix = Math.floor(c / GRID_N);
      const iz = c - ix * GRID_N;
      const e = this.edges[c];
      for (let k = 0; k < 8; k++) {
        if ((e & (1 << k)) === 0) continue;
        const n = (ix + NB_DX[k]) * GRID_N + iz + NB_DZ[k];
        const nd = key + this.edgeCost[c * 8 + k];
        if (nd < dist[base + n]) {
          dist[base + n] = nd;
          this.push(n, nd);
        }
      }
    }
  }

  /** Distance from (x, z) to waypoint w along the field (Infinity when unreachable). */
  distanceAt(w: number, x: number, z: number): number {
    const base = w * GRID_CELLS;
    const ix = cellIndex(x);
    const iz = cellIndex(z);
    let best = this.dist[base + ix * GRID_N + iz];
    if (Number.isFinite(best)) return best;
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        const jx = ix + dx;
        const jz = iz + dz;
        if (jx < 0 || jx >= GRID_N || jz < 0 || jz >= GRID_N) continue;
        const d = this.dist[base + jx * GRID_N + jz];
        if (d < best) best = d;
      }
    }
    return best;
  }

  /**
   * Writes the point to aim at (targetX/targetZ) a few cells down the field toward waypoint w. Returns false when
   * the field has nothing better than the current cell (at the waypoint, or unreachable).
   */
  aim(w: number, x: number, z: number): boolean {
    const base = w * GRID_CELLS;
    const dist = this.dist;
    let ix = cellIndex(x);
    let iz = cellIndex(z);
    let c = ix * GRID_N + iz;
    if (!Number.isFinite(dist[base + c])) {
      // Off the grid of open cells (next to a rock): head for the best reachable cell around.
      let best = -1;
      let bd = Infinity;
      for (let dx = -2; dx <= 2; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
          const jx = ix + dx;
          const jz = iz + dz;
          if (jx < 0 || jx >= GRID_N || jz < 0 || jz >= GRID_N) continue;
          const d = dist[base + jx * GRID_N + jz];
          if (d < bd) {
            bd = d;
            best = jx * GRID_N + jz;
          }
        }
      }
      if (best < 0) return false;
      ix = Math.floor(best / GRID_N);
      iz = best - ix * GRID_N;
      this.targetX = cellCentre(ix);
      this.targetZ = cellCentre(iz);
      return true;
    }
    const start = c;
    for (let s = 0; s < FIELD_LOOKAHEAD_CELLS; s++) {
      const e = this.edges[c];
      let next = c;
      let bd = dist[base + c];
      for (let k = 0; k < 8; k++) {
        if ((e & (1 << k)) === 0) continue;
        const n = (ix + NB_DX[k]) * GRID_N + iz + NB_DZ[k];
        if (dist[base + n] < bd) {
          bd = dist[base + n];
          next = n;
        }
      }
      if (next === c) break;
      c = next;
      ix = Math.floor(c / GRID_N);
      iz = c - ix * GRID_N;
    }
    if (c === start) return false;
    this.targetX = cellCentre(ix);
    this.targetZ = cellCentre(iz);
    return true;
  }

  private nearestOpen(ix: number, iz: number): number {
    for (let r = 0; r <= 3; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const jx = ix + dx;
          const jz = iz + dz;
          if (jx < 0 || jx >= GRID_N || jz < 0 || jz >= GRID_N) continue;
          if (this.open[jx * GRID_N + jz] === 1) return jx * GRID_N + jz;
        }
      }
    }
    return -1;
  }

  private push(cell: number, key: number): void {
    let i = this.heapSize++;
    const hc = this.heapCell;
    const hk = this.heapKey;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (hk[p] <= key) break;
      hc[i] = hc[p];
      hk[i] = hk[p];
      i = p;
    }
    hc[i] = cell;
    hk[i] = key;
  }

  private pop(): number {
    const hc = this.heapCell;
    const hk = this.heapKey;
    const top = hc[0];
    const n = --this.heapSize;
    const lastCell = hc[n];
    const lastKey = hk[n];
    let i = 0;
    for (;;) {
      let child = 2 * i + 1;
      if (child >= n) break;
      if (child + 1 < n && hk[child + 1] < hk[child]) child++;
      if (hk[child] >= lastKey) break;
      hc[i] = hc[child];
      hk[i] = hk[child];
      i = child;
    }
    hc[i] = lastCell;
    hk[i] = lastKey;
    return top;
  }
}

export class WalkPath {
  /** (x, z) per waypoint, in loop order. */
  readonly waypoints = new Float32Array(WAYPOINT_COUNT * 2);
  private readonly field = new FlowField();
  index = 0;
  /** Current planned heading (yaw, rad). */
  heading = 0;
  /** True when no candidate heading was clear at the last replan (the walker turns around). */
  blocked = false;
  /** Speed multiplier for the walker: 1 on a clear heading, lower while creeping, 0 while turning to scan. */
  speedScale = 1;
  waypointsReached = 0;
  friction = BOOT_FRICTION;
  private elapsed = 0;
  private replanTimer = 0;
  private side = 1;
  private avoidYaw = 0;
  private avoidTimer = 0;
  private commitTimer = 0;

  /** The walker stopped at the slip limit along `yaw`: replan now and keep away from that heading for a while. */
  turnAway(yaw: number): void {
    this.avoidYaw = yaw;
    this.avoidTimer = TURN_AWAY_S;
    this.replanTimer = 0;
  }

  /** Seeds the loop. Allocation only here (the PRNG), on vector or seed change. */
  reset(seed: number, startX: number, startZ: number): void {
    const rng = alea(seed, 'walk');
    const lim = PLOT_HALF - WALK_RIM_MARGIN_M;
    const a0 = rng() * Math.PI * 2;
    for (let i = 0; i < WAYPOINT_COUNT; i++) {
      const a = a0 + (i * 2 * Math.PI) / WAYPOINT_COUNT + (rng() - 0.5) * 0.5;
      let r = 3.5 + rng() * (lim - 2 - 3.5);
      let x = 0;
      let z = 0;
      for (let tries = 0; tries < 6; tries++) {
        x = Math.sin(a) * r;
        z = Math.cos(a) * r;
        const steep = slipMargin(slopeAlong(x, z, a), this.friction) < SLIP_RESERVE;
        if (!steep && findRockNear(x, z, ROCK_CLEARANCE_M + 0.3) < 0) break;
        r = Math.max(2, r - 0.7);
      }
      this.waypoints[2 * i] = Math.max(-lim, Math.min(lim, x));
      this.waypoints[2 * i + 1] = Math.max(-lim, Math.min(lim, z));
    }
    this.index = 0;
    this.elapsed = 0;
    this.replanTimer = 0;
    this.side = 1;
    this.commitTimer = 0;
    this.avoidTimer = 0;
    this.speedScale = 1;
    this.blocked = false;
    this.waypointsReached = 0;
    this.rebuildRoutes();
    this.heading = Math.atan2(this.waypoints[0] - startX, this.waypoints[1] - startZ);
  }

  /** Rebuilds the route grid and the distance field of every waypoint (call after editing `waypoints`). */
  rebuildRoutes(): void {
    this.field.build(this.friction);
    for (let i = 0; i < WAYPOINT_COUNT; i++) this.field.solve(i, this.waypoints[2 * i], this.waypoints[2 * i + 1]);
  }

  /**
   * True when the walker at (x, z) can head along `yaw`: every probe stays inside the rim, clear of rocks, and on
   * a slope with slip margin left. A rock the walker already stands next to only blocks probes that get closer.
   */
  headingClear(x: number, z: number, yaw: number): boolean {
    return this.headingScore(x, z, yaw) === PROBE_COUNT;
  }

  /**
   * Number of consecutive look-ahead probes that pass (0..4); 0 also when the slope at the walker itself, the one
   * the gait model sees at the next footfall, fails.
   */
  headingScore(x: number, z: number, yaw: number): number {
    if (slipMargin(slopeAlong(x, z, yaw), this.friction) < SLIP_RESERVE) return 0;
    const lim = PLOT_HALF - WALK_RIM_MARGIN_M;
    const sx = Math.sin(yaw);
    const sz = Math.cos(yaw);
    const selfRock = findRockNear(x, z, ROCK_CLEARANCE_M);
    let px = x;
    let pz = z;
    for (let k = 1; k <= PROBE_COUNT; k++) {
      const nx = x + sx * PROBE_STEP_M * k;
      const nz = z + sz * PROBE_STEP_M * k;
      if ((Math.abs(nx) > lim && Math.abs(nx) > Math.abs(x)) || (Math.abs(nz) > lim && Math.abs(nz) > Math.abs(z))) {
        return k - 1;
      }
      for (let j = 1; j <= ROCK_PROBE_SUBSTEPS; j++) {
        const t = (PROBE_STEP_M * (k - 1 + j / ROCK_PROBE_SUBSTEPS));
        const rx = x + sx * t;
        const rz = z + sz * t;
        const rock = findRockNear(rx, rz, ROCK_CLEARANCE_M);
        if (rock < 0) continue;
        const o = rock * ROCK_STRIDE;
        if (rock !== selfRock) return k - 1;
        // A rock the walker already stands beside only blocks probes that get closer to it.
        const dNew = Math.hypot(rx - rockColliders[o], rz - rockColliders[o + 2]);
        const dOld = Math.hypot(px - rockColliders[o], pz - rockColliders[o + 2]);
        if (dNew <= dOld) return k - 1;
      }
      if (slipMargin(slopeAlong(nx, nz, yaw), this.friction) < SLIP_RESERVE) return k - 1;
      px = nx;
      pz = nz;
    }
    return PROBE_COUNT;
  }

  /** Advances the plan by h seconds and returns the target heading. Replans every 0.1 s. */
  update(h: number, x: number, z: number, yaw: number): number {
    this.elapsed += h;
    this.avoidTimer -= h;
    this.replanTimer -= h;
    if (this.replanTimer > 0) return this.heading;
    this.replanTimer = REPLAN_INTERVAL_S;

    let wx = this.waypoints[2 * this.index];
    let wz = this.waypoints[2 * this.index + 1];
    const reached = Math.hypot(wx - x, wz - z) < WAYPOINT_REACHED_M;
    if (reached || this.elapsed > WAYPOINT_TIMEOUT_S) {
      if (reached) this.waypointsReached++;
      this.index = (this.index + 1) % WAYPOINT_COUNT;
      this.elapsed = 0;
      wx = this.waypoints[2 * this.index];
      wz = this.waypoints[2 * this.index + 1];
    }
    // Skip waypoints the route grid cannot reach from here.
    const field = this.field;
    for (let tries = 0; tries < WAYPOINT_COUNT && !Number.isFinite(field.distanceAt(this.index, x, z)); tries++) {
      this.index = (this.index + 1) % WAYPOINT_COUNT;
      this.elapsed = 0;
      wx = this.waypoints[2 * this.index];
      wz = this.waypoints[2 * this.index + 1];
    }
    // While creeping or scanning, keep the committed heading for a while unless it is now blocked right ahead.
    this.commitTimer -= REPLAN_INTERVAL_S;
    if (this.blocked && this.commitTimer > 0 && (this.speedScale === 0 || this.headingScore(x, z, this.heading) > 0)) {
      if (!this.headingClear(x, z, this.heading)) return this.heading;
    }
    const desired = field.aim(this.index, x, z)
      ? Math.atan2(field.targetX - x, field.targetZ - z)
      : Math.atan2(wx - x, wz - z);
    const avoiding = this.avoidTimer > 0;
    let bestScore = 0;
    let best = 0;
    let bestSign = this.side;
    for (let k = 0; k <= CANDIDATE_COUNT; k++) {
      for (let s = 0; s < (k === 0 || k === CANDIDATE_COUNT ? 1 : 2); s++) {
        const sign = s === 0 ? this.side : -this.side;
        const candidate = desired + sign * k * CANDIDATE_STEP_RAD;
        if (avoiding && Math.abs(wrapAngle(candidate - this.avoidYaw)) < TURN_AWAY_RAD) continue;
        const score = this.headingScore(x, z, candidate);
        if (score === PROBE_COUNT) {
          if (k > 0) this.side = sign;
          this.heading = candidate;
          this.blocked = false;
          this.speedScale = 1;
          return candidate;
        }
        if (score > bestScore) {
          bestScore = score;
          best = candidate;
          bestSign = sign;
        }
      }
    }
    // Nothing fully clear: creep along the heading with the longest clear run, or turn in place to scan.
    this.blocked = true;
    this.commitTimer = COMMIT_S;
    if (bestScore > 0) {
      this.side = bestSign;
      this.heading = best;
      this.speedScale = BLOCKED_SPEED_SCALE;
    } else {
      this.heading = yaw + this.side * (Math.PI / 2);
      this.speedScale = 0;
    }
    return this.heading;
  }
}

/**
 * Couples the path and the gait model to a walker: steering every fixed step, and a new gait solution at every
 * footfall from the slope along the current heading, the site roughness and the live gravity.
 */
export class WalkController implements WalkerController {
  readonly path = new WalkPath();
  readonly inputs: GaitInputs = createGaitInputs();
  readonly state: GaitState = createGaitState();
  /** Live surface gravity (m/s²); read at every footfall. */
  gravity = 1.62;
  /** Grade (rise over run) along the heading at the last footfall. */
  grade = 0;
  private lastFootfalls = -1;
  private yawCheckTimer = 0;
  private yawPassable = true;

  reset(seed: number, roughness: number, legLength: number, startX: number, startZ: number): void {
    this.inputs.roughness = roughness;
    this.inputs.legLength = legLength;
    this.inputs.previousGait = 'stand';
    this.state.gait = 'stand';
    this.lastFootfalls = -1;
    this.yawCheckTimer = 0;
    this.yawPassable = true;
    this.path.reset(seed, startX, startZ);
  }

  control(walker: GaitWalker, h: number): number {
    if (walker.footfalls !== this.lastFootfalls) {
      this.lastFootfalls = walker.footfalls;
      // The gait is solved for the heading the walker is about to walk; while it still turns it steps in place.
      const slope = slopeAlong(walker.x, walker.z, this.path.heading);
      this.grade = Math.tan((slope * Math.PI) / 180);
      const inp = this.inputs;
      inp.gravity = this.gravity;
      inp.slopeDeg = slope;
      inp.friction = this.path.friction;
      inp.previousGait = this.state.gait;
      solveGait(inp, this.state);
      walker.setGait(this.state, this.gravity);
      // Stopped at the slip limit on the planned heading itself: turn away from it. While still turning toward the
      // plan, stepping in place is enough.
      if (this.state.stopped && Math.abs(wrapAngle(walker.yaw - this.path.heading)) < ALIGNED_RAD) {
        this.path.turnAway(walker.yaw);
      }
    }
    const heading = this.path.update(h, walker.x, walker.z, walker.yaw);
    this.yawCheckTimer -= h;
    if (this.yawCheckTimer <= 0) {
      // Never walk on along the current facing when the slope that way is beyond the slip margin.
      this.yawCheckTimer = YAW_CHECK_INTERVAL_S;
      this.yawPassable = slipMargin(slopeAlong(walker.x, walker.z, walker.yaw), this.path.friction) > 0;
    }
    walker.speedScale = this.yawPassable ? this.path.speedScale : 0;
    return heading;
  }
}
