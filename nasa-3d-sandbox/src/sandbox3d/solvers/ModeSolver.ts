import type { Group, Mesh, Vector3 } from 'three';
import type { FrameTimings } from '../SandboxEngine.ts';
import type { SandboxMode, SimTelemetryAlertDetail, SitePhysicsState } from '../../bridge/copilotContract.ts';

export type SolverAlertPayload = Omit<SimTelemetryAlertDetail, 'source' | 'timestampMs'>;

/** Describes one telemetry card in the HUD. `key` names a numeric field of the solver telemetry object. */
export interface TelemetryField {
  readonly key: string;
  readonly label: string;
  readonly unit: string;
  readonly digits: number;
}

export interface PhysicsState {
  /** Surface gravity in m/s^2. */
  gravity: number;
}

/** Shared, preallocated state handed to every solver. */
export interface SolverContext {
  /** [slope_deg, tri, thermal_inertia, albedo, temp_K, ndvi] (the bridge's etlVector). */
  readonly vector: Float32Array;
  readonly physics: PhysicsState;
  readonly site: SitePhysicsState;
  readonly terrainMesh: Mesh;
  /** Engine frame timings; the LiDAR solver writes lidarMs here. */
  readonly timings: FrameTimings;
  /** Emits a deduplicated threshold alert back to Copilot UI / parent iframe. */
  readonly emitAlert: (alert: SolverAlertPayload) => void;
}

export interface ModeSolver {
  readonly mode: SandboxMode;
  /** Mode scene. Toggled only through `visible`. */
  readonly group: Group;
  /** World point the camera eases toward while this mode is active. */
  readonly focus: Vector3;
  /** Fixed object whose numeric fields are mutated in place every frame. */
  readonly telemetry: Readonly<Record<string, number>>;
  readonly fields: readonly TelemetryField[];
  /** Static HUD note (time scale, ray budget, ...). */
  readonly note: string;
  /**
   * Unit vector toward the sun that this solver computes with, when it has one. While the mode is active the
   * engine points the visible sun along this same object, so what is drawn and what is solved cannot diverge.
   */
  readonly sunDirection?: Vector3;
  activate(): void;
  deactivate(): void;
  /** Called after every terrain synthesis (vector or seed change). Allocation is allowed here, sparingly. */
  onVectorChanged(): void;
  /** Per-frame update. Must not allocate. */
  update(dt: number, t: number): void;
}
