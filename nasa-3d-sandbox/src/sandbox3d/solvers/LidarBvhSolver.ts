import {
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  Group,
  Mesh,
  Points,
  PointsMaterial,
  Raycaster,
  Vector3,
} from 'three';
import type { Intersection } from 'three';
import { acceleratedRaycast } from 'three-mesh-bvh';
import type { SandboxMode } from '../SandboxEngine.ts';
import type { ModeSolver, SolverContext, TelemetryField } from './ModeSolver.ts';
import { buildLander } from '../AssetBuilder.ts';
import type { LanderRig } from '../AssetBuilder.ts';
import { sampleHeight } from '../TerrainGenerator.ts';
import { findRockNear } from '../RockFieldInstancer.ts';
import { DEG2RAD, RAD2DEG } from '../ScratchMath.ts';

// BVH-accelerated raycasting for every Mesh (the terrain carries geometry.boundsTree).
Mesh.prototype.raycast = acceleratedRaycast;

export const LIDAR_RAYS = 500;
export const CONE_HALF_ANGLE_DEG = 38;
export const LANDER_ALTITUDE_M = 7;
export const SAFE_SLOPE_DEG = 10;
export const ROCK_MARGIN_M = 0.25;
export const ANOMALY_NDVI = 0.08;
export const SUN_ELEVATION_DEG = 8;
/** Sun mostly across the slope (from -z), so self-shadowing comes from relief rather than the mean slope. */
export const SUN_AZIMUTH_DEG = 250;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const SCAN_RATE_RAD_S = 1.7;
const SHADOW_BIAS_M = 0.03;

export type LidarClass = 'SAFE' | 'HAZARD' | 'SHADOW' | 'ANOMALY';

/** Ray i of n on a golden-angle spiral inside a downward cone, rotated by `phase`. */
export function coneDirection(i: number, n: number, halfAngleRad: number, phase: number, out: Vector3): Vector3 {
  const r = Math.sqrt((i + 0.5) / n);
  const theta = halfAngleRad * r;
  const phi = i * GOLDEN_ANGLE + phase;
  const s = Math.sin(theta);
  return out.set(s * Math.cos(phi), -Math.cos(theta), s * Math.sin(phi));
}

/** Priority: hazard (rock or slope ≥ 10°) > hard shadow > biological anomaly > safe. */
export function classifyLidarHit(slopeDeg: number, rock: boolean, shadowed: boolean, anomaly: boolean): LidarClass {
  if (rock || slopeDeg >= SAFE_SLOPE_DEG) return 'HAZARD';
  if (shadowed) return 'SHADOW';
  if (anomaly) return 'ANOMALY';
  return 'SAFE';
}

/** Deterministic value in [0, 1) per 0.5 m cell, used to place NDVI anomaly patches. */
export function anomalyHash(x: number, z: number): number {
  const h = Math.sin(Math.floor(x * 2) * 127.1 + Math.floor(z * 2) * 311.7) * 43758.5453;
  return h - Math.floor(h);
}

export type LidarTelemetry = {
  rays: number;
  hits: number;
  safePct: number;
  hazardPct: number;
  shadowPct: number;
  anomalyPct: number;
  raycastMs: number;
};

const LIDAR_FIELDS: readonly TelemetryField[] = [
  { key: 'rays', label: 'Rays / frame', unit: '', digits: 0 },
  { key: 'hits', label: 'Hits', unit: '', digits: 0 },
  { key: 'safePct', label: 'Safe', unit: '%', digits: 1 },
  { key: 'hazardPct', label: 'Hazard', unit: '%', digits: 1 },
  { key: 'shadowPct', label: 'Hard shadow', unit: '%', digits: 1 },
  { key: 'anomalyPct', label: 'Bio anomaly', unit: '%', digits: 1 },
  { key: 'raycastMs', label: 'Raycast', unit: 'ms', digits: 2 },
];

export class LidarBvhSolver implements ModeSolver {
  readonly mode: SandboxMode = 'LIDAR_LANDER';
  readonly group = new Group();
  readonly focus = new Vector3();
  readonly fields = LIDAR_FIELDS;
  readonly note = `${LIDAR_RAYS} primary + up to ${LIDAR_RAYS} shadow rays / frame · sun elevation ${SUN_ELEVATION_DEG}° · rocks via collider grid`;
  readonly telemetry: LidarTelemetry = {
    rays: LIDAR_RAYS,
    hits: 0,
    safePct: 0,
    hazardPct: 0,
    shadowPct: 0,
    anomalyPct: 0,
    raycastMs: 0,
  };
  private readonly ctx: SolverContext;
  private readonly rig: LanderRig;
  private readonly raycaster = new Raycaster();
  /** Reused intersections array; length is reset before every cast. */
  private readonly hits: Intersection[] = [];
  private readonly positions = new Float32Array(LIDAR_RAYS * 3);
  private readonly colors = new Float32Array(LIDAR_RAYS * 3);
  private readonly positionAttr: BufferAttribute;
  private readonly colorAttr: BufferAttribute;
  private readonly sunDir = new Vector3();
  /** The shadow-ray direction (toward the sun). The engine lights the scene along this vector in this mode. */
  readonly sunDirection: Vector3 = this.sunDir;
  private readonly origin = new Vector3();
  private readonly dir = new Vector3();
  private readonly shadowOrigin = new Vector3();
  private readonly halfAngle = CONE_HALF_ANGLE_DEG * DEG2RAD;
  private groundY = 0;
  private phase = 0;

  constructor(ctx: SolverContext) {
    this.ctx = ctx;
    this.raycaster.firstHitOnly = true;
    this.raycaster.far = 80;
    this.rig = buildLander();

    const geometry = new BufferGeometry();
    this.positionAttr = new BufferAttribute(this.positions, 3).setUsage(DynamicDrawUsage);
    this.colorAttr = new BufferAttribute(this.colors, 3).setUsage(DynamicDrawUsage);
    geometry.setAttribute('position', this.positionAttr);
    geometry.setAttribute('color', this.colorAttr);
    // Class colours are status: keep them exact (no tone mapping, no haze).
    const cloud = new Points(
      geometry,
      new PointsMaterial({ size: 0.14, vertexColors: true, sizeAttenuation: true, toneMapped: false, fog: false }),
    );
    cloud.frustumCulled = false; // positions change every frame
    cloud.renderOrder = 3;

    const el = SUN_ELEVATION_DEG * DEG2RAD;
    const az = SUN_AZIMUTH_DEG * DEG2RAD;
    this.sunDir.set(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)).normalize();

    this.group.name = 'mode-lidar-lander';
    this.group.add(this.rig.root, cloud);
  }

  activate(): void {}

  deactivate(): void {
    this.ctx.timings.lidarMs = 0;
  }

  onVectorChanged(): void {
    this.groundY = sampleHeight(0, 0);
    this.focus.set(0, this.groundY + 2, 0);
    const radius = LANDER_ALTITUDE_M * Math.tan(this.halfAngle);
    this.rig.cone.scale.set(radius, LANDER_ALTITUDE_M, radius);
    this.placeLander(0);
  }

  update(dt: number, t: number): void {
    this.placeLander(t);
    this.phase += SCAN_RATE_RAD_S * dt;
    this.rig.lidarHead.rotation.y = -this.phase;
    this.rig.lidarHead.getWorldPosition(this.origin);

    const terrain = this.ctx.terrainMesh;
    const ndvi = this.ctx.vector[5];
    const raycaster = this.raycaster;
    const hits = this.hits;
    const pos = this.positions;
    const col = this.colors;
    let hitCount = 0;
    let safe = 0;
    let hazard = 0;
    let shadow = 0;
    let anomaly = 0;

    const t0 = performance.now();
    for (let i = 0; i < LIDAR_RAYS; i++) {
      coneDirection(i, LIDAR_RAYS, this.halfAngle, this.phase, this.dir);
      raycaster.set(this.origin, this.dir);
      hits.length = 0;
      // three-mesh-bvh allocates one intersection object (point, face, normal) per hit internally.
      raycaster.intersectObject(terrain, false, hits);
      const o = i * 3;
      if (hits.length === 0) {
        pos[o] = this.origin.x;
        pos[o + 1] = this.origin.y;
        pos[o + 2] = this.origin.z;
        col[o] = 0;
        col[o + 1] = 0;
        col[o + 2] = 0;
        continue;
      }
      hitCount++;
      const hit = hits[0];
      const p = hit.point;
      const ny = hit.face ? Math.abs(hit.face.normal.y) : 1;
      const slopeDeg = Math.acos(ny > 1 ? 1 : ny) * RAD2DEG;
      const rock = findRockNear(p.x, p.z, ROCK_MARGIN_M) >= 0;

      this.shadowOrigin.set(p.x, p.y + SHADOW_BIAS_M, p.z);
      raycaster.set(this.shadowOrigin, this.sunDir);
      hits.length = 0;
      raycaster.intersectObject(terrain, false, hits); // library allocation per hit, as above
      const shadowed = hits.length > 0;
      const bio = ndvi > ANOMALY_NDVI && anomalyHash(p.x, p.z) < ndvi;

      pos[o] = p.x;
      pos[o + 1] = p.y + 0.02;
      pos[o + 2] = p.z;
      const cls = classifyLidarHit(slopeDeg, rock, shadowed, bio);
      if (cls === 'HAZARD') {
        hazard++;
        col[o] = 1;
        col[o + 1] = 0.12;
        col[o + 2] = 0.1;
      } else if (cls === 'SHADOW') {
        shadow++;
        col[o] = 0.08;
        col[o + 1] = 0.12;
        col[o + 2] = 0.55;
      } else if (cls === 'ANOMALY') {
        anomaly++;
        col[o] = 1;
        col[o + 1] = 0.9;
        col[o + 2] = 0.1;
      } else {
        safe++;
        col[o] = 0.15;
        col[o + 1] = 1;
        col[o + 2] = 0.3;
      }
    }
    const raycastMs = performance.now() - t0;
    hits.length = 0;

    this.positionAttr.needsUpdate = true;
    this.colorAttr.needsUpdate = true;
    this.ctx.timings.lidarMs = raycastMs;

    const tel = this.telemetry;
    const denom = hitCount > 0 ? 100 / hitCount : 0;
    tel.hits = hitCount;
    tel.safePct = safe * denom;
    tel.hazardPct = hazard * denom;
    tel.shadowPct = shadow * denom;
    tel.anomalyPct = anomaly * denom;
    tel.raycastMs = raycastMs;
  }

  private placeLander(t: number): void {
    this.rig.root.position.set(0.6 * Math.sin(t * 0.21), this.groundY + LANDER_ALTITUDE_M + 0.6 + 0.25 * Math.sin(t * 0.5), 0);
  }
}
