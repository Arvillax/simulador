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
import type { LidarProfile, SandboxMode } from '../../bridge/copilotContract.ts';
import type { ModeSolver, SolverContext, TelemetryField } from './ModeSolver.ts';
import { buildLander } from '../AssetBuilder.ts';
import type { LanderRig } from '../AssetBuilder.ts';
import { sampleHeight } from '../TerrainGenerator.ts';
import { ROCK_STRIDE, findRockNear, rockColliders } from '../RockFieldInstancer.ts';
import { DEG2RAD, RAD2DEG } from '../ScratchMath.ts';

// BVH-accelerated raycasting for every Mesh (the terrain carries geometry.boundsTree).
Mesh.prototype.raycast = acceleratedRaycast;

export const LIDAR_RAYS = 500;
export const CONE_HALF_ANGLE_DEG = 38;
export const LANDER_ALTITUDE_M = 7;
export const ALHAT_SLOPE_DEG = 5;
export const SAFE_SLOPE_DEG = 10;
export const ROCK_MARGIN_M = 0.25;
export const ANOMALY_NDVI = 0.08;
export const SUN_ELEVATION_DEG = 8;
/** Sun mostly across the slope (from -z), so self-shadowing comes from relief rather than the mean slope. */
export const SUN_AZIMUTH_DEG = 250;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const SCAN_RATE_RAD_S = 1.7;
const SHADOW_BIAS_M = 0.03;

const ALERT_PSR = 1;
const ALERT_HAZARD = 2;

export type LidarClass = 'SAFE' | 'CAUTION' | 'HAZARD' | 'SHADOW' | 'ANOMALY';

export interface LidarLimits {
  readonly greenMaxDeg: number;
  readonly redMinDeg: number;
  readonly hazardSizeM: number;
}

const ALHAT_LIMITS: LidarLimits = { greenMaxDeg: 5, redMinDeg: 5, hazardSizeM: 0.3 };
const SPLICE_LIMITS: LidarLimits = { greenMaxDeg: 5, redMinDeg: 20, hazardSizeM: 0.3 };
const CLPS_LIMITS: LidarLimits = { greenMaxDeg: 5, redMinDeg: 10, hazardSizeM: 0.2 };
const M2020_LIMITS: LidarLimits = { greenMaxDeg: 5, redMinDeg: 20, hazardSizeM: 0.5 };

export function lidarLimitsForProfile(profile: LidarProfile): LidarLimits {
  if (profile === 'ALHAT') return ALHAT_LIMITS;
  if (profile === 'SPLICE') return SPLICE_LIMITS;
  if (profile === 'CLPS') return CLPS_LIMITS;
  return M2020_LIMITS;
}

/** Ray i of n on a golden-angle spiral inside a downward cone, rotated by `phase`. */
export function coneDirection(i: number, n: number, halfAngleRad: number, phase: number, out: Vector3): Vector3 {
  const r = Math.sqrt((i + 0.5) / n);
  const theta = halfAngleRad * r;
  const phi = i * GOLDEN_ANGLE + phase;
  const s = Math.sin(theta);
  return out.set(s * Math.cos(phi), -Math.cos(theta), s * Math.sin(phi));
}

/** Priority: hazard (rock hazard or slope >= redMinDeg) > hard shadow > biological anomaly > caution > safe. */
export function classifyLidarHit(
  slopeDeg: number,
  rockHazard: boolean,
  shadowed: boolean,
  anomaly: boolean,
  redMinDeg = SAFE_SLOPE_DEG,
  greenMaxDeg = ALHAT_SLOPE_DEG,
  rockCaution = false,
): LidarClass {
  if (rockHazard || slopeDeg >= redMinDeg) return 'HAZARD';
  if (shadowed) return 'SHADOW';
  if (anomaly) return 'ANOMALY';
  if (rockCaution || slopeDeg >= greenMaxDeg) return 'CAUTION';
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
  cautionPct: number;
  hazardPct: number;
  shadowPct: number;
  anomalyPct: number;
  opticalBlindPct: number;
  raycastMs: number;
};

const LIDAR_FIELDS: readonly TelemetryField[] = [
  { key: 'rays', label: 'Rays / frame', unit: '', digits: 0 },
  { key: 'hits', label: 'Hits', unit: '', digits: 0 },
  { key: 'safePct', label: 'Safe', unit: '%', digits: 1 },
  { key: 'cautionPct', label: 'Caution', unit: '%', digits: 1 },
  { key: 'hazardPct', label: 'Hazard', unit: '%', digits: 1 },
  { key: 'shadowPct', label: 'Hard shadow', unit: '%', digits: 1 },
  { key: 'opticalBlindPct', label: 'Optical blind', unit: '%', digits: 0 },
  { key: 'anomalyPct', label: 'Bio anomaly', unit: '%', digits: 1 },
  { key: 'raycastMs', label: 'Raycast', unit: 'ms', digits: 2 },
];

export class LidarBvhSolver implements ModeSolver {
  readonly mode: SandboxMode = 'LIDAR_LANDER';
  readonly group = new Group();
  readonly focus = new Vector3();
  readonly fields = LIDAR_FIELDS;
  readonly note = `${LIDAR_RAYS} active LiDAR rays/frame · ALHAT ≥ 5°/0.30 m (Moon) vs CLPS ≥ 10° / M2020 (Mars) · 0% PSR loss`;
  readonly telemetry: LidarTelemetry = {
    rays: LIDAR_RAYS,
    hits: 0,
    safePct: 0,
    cautionPct: 0,
    hazardPct: 0,
    shadowPct: 0,
    anomalyPct: 0,
    opticalBlindPct: 0,
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
  private activeAlerts = 0;

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

  activate(): void {
    this.activeAlerts = 0;
  }

  deactivate(): void {
    this.ctx.timings.lidarMs = 0;
  }

  onVectorChanged(): void {
    this.groundY = sampleHeight(0, 0);
    this.focus.set(0, this.groundY + 2, 0);
    const radius = LANDER_ALTITUDE_M * Math.tan(this.halfAngle);
    this.rig.cone.scale.set(radius, LANDER_ALTITUDE_M, radius);
    this.activeAlerts = 0;
    this.placeLander(0);
  }

  update(dt: number, t: number): void {
    this.placeLander(t);
    this.phase += SCAN_RATE_RAD_S * dt;
    this.rig.lidarHead.rotation.y = -this.phase;
    this.rig.lidarHead.getWorldPosition(this.origin);

    const terrain = this.ctx.terrainMesh;
    const site = this.ctx.site;
    const limits = lidarLimitsForProfile(site.lidarProfile);
    // ADR-003: NDVI applies only to terrestrial analogs, never Moon or Mars.
    const ndvi = site.body === 'earth' ? this.ctx.vector[5] : 0;
    const hasDirectSun = site.sunlit && !(site.body === 'moon' && Number.isFinite(site.solarIllumFrac) && site.solarIllumFrac <= 0);
    const raycaster = this.raycaster;
    const hits = this.hits;
    const pos = this.positions;
    const col = this.colors;
    let hitCount = 0;
    let safe = 0;
    let caution = 0;
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
      const rockIdx = findRockNear(p.x, p.z, ROCK_MARGIN_M);
      const rockSpanM = rockIdx >= 0 ? 2 * rockColliders[rockIdx * ROCK_STRIDE + 3] : 0;
      const rockHazard = rockIdx >= 0 && rockSpanM >= limits.hazardSizeM;
      const rockCaution = rockIdx >= 0 && !rockHazard;

      let shadowed = false;
      if (hasDirectSun) {
        this.shadowOrigin.set(p.x, p.y + SHADOW_BIAS_M, p.z);
        raycaster.set(this.shadowOrigin, this.sunDir);
        hits.length = 0;
        raycaster.intersectObject(terrain, false, hits); // library allocation per hit, as above
        shadowed = hits.length > 0;
      }
      const bio = ndvi > ANOMALY_NDVI && anomalyHash(p.x, p.z) < ndvi;

      pos[o] = p.x;
      pos[o + 1] = p.y + 0.02;
      pos[o + 2] = p.z;
      const cls = classifyLidarHit(slopeDeg, rockHazard, shadowed, bio, limits.redMinDeg, limits.greenMaxDeg, rockCaution);
      if (cls === 'HAZARD') {
        hazard++;
        col[o] = 1;
        col[o + 1] = 0.12;
        col[o + 2] = 0.1;
      } else if (cls === 'CAUTION') {
        caution++;
        col[o] = 1;
        col[o + 1] = 0.62;
        col[o + 2] = 0.08;
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
    tel.cautionPct = caution * denom;
    tel.hazardPct = hazard * denom;
    tel.shadowPct = shadow * denom;
    tel.anomalyPct = anomaly * denom;
    tel.opticalBlindPct = hasDirectSun ? Math.min(100, tel.shadowPct) : 100;
    tel.raycastMs = raycastMs;

    this.checkAlerts(hasDirectSun, limits.redMinDeg);
  }

  private checkAlerts(hasDirectSun: boolean, redMinDeg: number): void {
    if (!this.group.visible) return;
    const site = this.ctx.site;
    if (!hasDirectSun) {
      if ((this.activeAlerts & ALERT_PSR) === 0) {
        this.activeAlerts |= ALERT_PSR;
        this.ctx.emitAlert({
          code: 'LIDAR_PSR_OPTICAL_BLIND',
          mode: 'LIDAR_LANDER',
          body: site.body,
          severity: 'yellow',
          message: 'PSR dark zone (N6=0 / no direct sun): passive optical TRN 100% blind; active LiDAR operates with 0% degradation.',
          metric: 'optical_blind_pct',
          value: 100,
          threshold: 10,
        });
      }
    } else {
      this.activeAlerts &= ~ALERT_PSR;
    }

    if (this.telemetry.hazardPct >= 25 || this.ctx.vector[0] >= redMinDeg) {
      if ((this.activeAlerts & ALERT_HAZARD) === 0) {
        this.activeAlerts |= ALERT_HAZARD;
        this.ctx.emitAlert({
          code: 'LIDAR_ALHAT_HAZARD',
          mode: 'LIDAR_LANDER',
          body: site.body,
          severity: 'red',
          message: `${site.lidarProfile} HDA rejection: ${this.telemetry.hazardPct.toFixed(0)}% hazard returns (slope ≥ ${redMinDeg}° or boulder ≥ ${lidarLimitsForProfile(site.lidarProfile).hazardSizeM.toFixed(2)} m).`,
          metric: 'hazard_pct',
          value: this.telemetry.hazardPct,
          threshold: 25,
        });
      }
    } else {
      this.activeAlerts &= ~ALERT_HAZARD;
    }
  }

  private placeLander(t: number): void {
    this.rig.root.position.set(0.6 * Math.sin(t * 0.21), this.groundY + LANDER_ALTITUDE_M + 0.6 + 0.25 * Math.sin(t * 0.5), 0);
  }
}
