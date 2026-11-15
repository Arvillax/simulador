import { DataTexture, LinearFilter, MeshBasicMaterial, NormalBlending, RGBAFormat, UnsignedByteType } from 'three';
import type { Material, Mesh, Object3D } from 'three';
import {
  ApplyForce,
  BatchedRenderer,
  Bezier,
  ColorOverLife,
  ConstantColor,
  ConstantValue,
  Gradient,
  GridEmitter,
  IntervalValue,
  LimitSpeedOverLife,
  ParticleSystem,
  PiecewiseBezier,
  Vector3 as QuarksVector3,
  Vector4 as QuarksVector4,
  RenderMode,
  TurbulenceField,
} from 'three.quarks';
import type { SurfaceClass } from './TerrainGenerator.ts';
import { PLOT_SIZE } from './TerrainGenerator.ts';
import { DEG2RAD, clamp01 } from './ScratchMath.ts';

export const MAX_DUST_PARTICLES = 4000;
const LIFE_MIN_S = 3;
const LIFE_MAX_S = 5;
/** Emission rate at thermal inertia 0; rate × max life stays within the 4000-particle budget. */
export const MAX_EMISSION_PER_S = MAX_DUST_PARTICLES / LIFE_MAX_S - 20;
export const MAX_DUST_OPACITY = 0.6;
export const EDS_SWEEP_DURATION_S = 0.6;
export const EDS_SWEEP_ACCEL = 16;
const LIMIT_DAMPEN = 0.25;

const SPRITE_SIZE = 32;
/** Peak alpha of the sprite: motes stay faint, so overlapping quads add little. */
const SPRITE_PEAK_ALPHA = 0.55;

/**
 * Soft round sprite generated once in code (no canvas, no download): white with a Gaussian alpha that reaches
 * zero at the quad edge, so most of each quad blends almost nothing and overlapping motes stay cheap.
 */
function createDustTexture(): DataTexture {
  const data = new Uint8Array(SPRITE_SIZE * SPRITE_SIZE * 4);
  const half = (SPRITE_SIZE - 1) / 2;
  for (let y = 0; y < SPRITE_SIZE; y++) {
    for (let x = 0; x < SPRITE_SIZE; x++) {
      const dx = (x - half) / half;
      const dy = (y - half) / half;
      const r2 = Math.min(1, dx * dx + dy * dy);
      const alpha = SPRITE_PEAK_ALPHA * Math.exp(-4.2 * r2) * (1 - r2);
      const o = (y * SPRITE_SIZE + x) * 4;
      data[o] = 255;
      data[o + 1] = 255;
      data[o + 2] = 255;
      data[o + 3] = Math.round(255 * alpha);
    }
  }
  const texture = new DataTexture(data, SPRITE_SIZE, SPRITE_SIZE, RGBAFormat, UnsignedByteType);
  texture.name = 'dust-sprite';
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Regolith dust: one three.quarks BatchedRenderer (one draw call), billboard sprites, turbulence always on and an
 * ApplyForce that is enabled for ~0.6 s after an EDS pulse.
 */
export class DustSystemQuarks {
  readonly batch: BatchedRenderer;
  readonly system: ParticleSystem;
  readonly emitter: Object3D;
  private readonly emission = new ConstantValue(0);
  private readonly startColor = new QuarksVector4(0.6, 0.55, 0.5, 0.4);
  private readonly sweepMagnitude = new ConstantValue(0);
  private readonly limit: LimitSpeedOverLife;
  private readonly shape: GridEmitter;
  private sweepTimer = 0;
  /** True once the engine has set a body tint; until then the tint follows the surface class. */
  private bodyTinted = false;

  constructor() {
    this.batch = new BatchedRenderer();
    this.batch.name = 'dust-batch';
    const material = new MeshBasicMaterial({
      map: createDustTexture(),
      transparent: true,
      depthWrite: false,
      blending: NormalBlending,
    });
    this.shape = new GridEmitter({ width: PLOT_SIZE, height: PLOT_SIZE, column: 64, row: 64 });
    this.limit = new LimitSpeedOverLife(new PiecewiseBezier([[new Bezier(0.9, 0.8, 0.7, 0.6), 0]]), LIMIT_DAMPEN);
    this.system = new ParticleSystem({
      duration: LIFE_MAX_S,
      looping: true,
      prewarm: false,
      worldSpace: true,
      shape: this.shape,
      startLife: new IntervalValue(LIFE_MIN_S, LIFE_MAX_S),
      startSpeed: new IntervalValue(0.05, 0.35),
      startSize: new IntervalValue(0.07, 0.22),
      startColor: new ConstantColor(this.startColor),
      emissionOverTime: this.emission,
      material,
      renderMode: RenderMode.BillBoard,
      behaviors: [
        new TurbulenceField(new QuarksVector3(4, 4, 4), 2, new QuarksVector3(0.7, 0.35, 0.7), new QuarksVector3(0.15, 0.15, 0.15)),
        new ApplyForce(new QuarksVector3(1, 0.3, 0.15).normalize(), this.sweepMagnitude),
        this.limit,
        new ColorOverLife(
          new Gradient(
            [
              [new QuarksVector3(1, 1, 1), 0],
              [new QuarksVector3(1, 1, 1), 1],
            ],
            [
              [0, 0],
              [1, 0.2],
              [1, 0.7],
              [0, 1],
            ],
          ),
        ),
      ],
    });
    this.emitter = this.system.emitter;
    this.emitter.name = 'dust-emitter';
    // Local XY grid -> world XZ, emission (+z local) -> up; then tilted to the mean slope about world z.
    this.emitter.rotation.order = 'ZYX';
    this.emitter.rotation.set(-Math.PI / 2, 0, 0);
    this.batch.addSystem(this.system);
    // The batch shader applies the renderer's tone mapping but not its output encoding, which leaves the motes
    // too dark on bright worlds. Turn tone mapping off here; `setTint` takes display-referred colours instead.
    this.batch.traverse((object) => {
      const material = (object as Mesh).material as Material | undefined;
      if (material !== undefined) material.toneMapped = false;
    });
  }

  get particleCount(): number {
    return this.system.particleNum;
  }

  /**
   * Dust colour of the current world, display-referred (sRGB-encoded 0..1): the sprites are unlit and skip tone
   * mapping, so the engine passes the lit regolith tint already tone mapped. Keeps the opacity. No allocation.
   */
  setTint(r: number, g: number, b: number): void {
    this.bodyTinted = true;
    this.startColor.set(r, g, b, this.startColor.w);
  }

  /** Emission rate and opacity ∝ (1 - thermal inertia). Without a body tint the colour follows the surface class. */
  onVectorChanged(vector: Float32Array, surface: SurfaceClass): void {
    const loose = 1 - clamp01(vector[2]);
    this.emission.value = MAX_EMISSION_PER_S * loose;
    this.startColor.w = MAX_DUST_OPACITY * loose;
    if (!this.bodyTinted) {
      if (surface === 'ICE') this.startColor.set(0.86, 0.89, 0.93, this.startColor.w);
      else if (surface === 'BASALT') this.startColor.set(0.45, 0.45, 0.47, this.startColor.w);
      else this.startColor.set(0.74, 0.54, 0.37, this.startColor.w);
    }
    const slope = vector[0] * DEG2RAD;
    this.emitter.rotation.set(-Math.PI / 2, 0, slope);
    this.emitter.position.set(0, 0.15, 0);
    this.shape.width = PLOT_SIZE / Math.cos(slope);
  }

  /** Electrodynamic dust shield sweep: push particles away for EDS_SWEEP_DURATION_S. */
  triggerEdsSweep(): void {
    this.sweepTimer = EDS_SWEEP_DURATION_S;
    this.sweepMagnitude.value = EDS_SWEEP_ACCEL;
    this.limit.dampen = 0;
  }

  update(dt: number): void {
    if (this.sweepTimer > 0) {
      this.sweepTimer -= dt;
      if (this.sweepTimer <= 0) {
        this.sweepTimer = 0;
        this.sweepMagnitude.value = 0;
        this.limit.dampen = LIMIT_DAMPEN;
      }
    }
    // three.quarks iterates its systems with Map.forEach and a closure internally (library allocation per frame).
    this.batch.update(dt);
  }
}
