import {
  BoxGeometry,
  CapsuleGeometry,
  CircleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Euler,
  Group,
  LatheGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  RingGeometry,
  ShaderMaterial,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  Vector3,
} from 'three';
import type { BufferAttribute, BufferGeometry, Material, Object3D, WebGLRenderer } from 'three';
import { sampleHeight } from './TerrainGenerator.ts';
import { helixGeometry, mergeParts, part, tube } from './HardwareGeometry.ts';
import type { Vec3 } from './HardwareGeometry.ts';
import { MARKING_ORANGE, MLI_UV_DENSITY, getHardwareKit, registerEnvMaterial } from './HardwareKit.ts';

// ---------------------------------------------------------------------------------------------------------------
// Rover model dimensions (metres). The Rover solver uses the same constants for its kinematics.
// ---------------------------------------------------------------------------------------------------------------
export const WHEEL_RADIUS = 0.25;
export const WHEEL_WIDTH = 0.2;
export const WHEEL_FRONT_X = 0.75;
export const WHEEL_MID_X = 0;
export const WHEEL_REAR_X = -0.7;
export const TRACK_WIDTH = 1.4;
export const BOGIE_PIVOT_X = (WHEEL_MID_X + WHEEL_REAR_X) / 2;
export const L_BOGIE = WHEEL_MID_X - WHEEL_REAR_X;
export const L_ROCKER = WHEEL_FRONT_X - BOGIE_PIVOT_X;
export const H_OFFSET = 0.35;
/** Rocker main pivot (attached to the differential/chassis) measured along x. */
export const ROCKER_PIVOT_X = 0.15;
export const ARM_INSET = 0.17;

export interface RoverRig {
  readonly root: Group;
  readonly chassis: Group;
  /** Order: FL, ML, RL, FR, MR, RR. Each group spins about local z. */
  readonly wheels: readonly Group[];
  /** Order: left, right. Positioned at the beam midpoint, rotated about z. */
  readonly rockers: readonly Group[];
  readonly rockerBeams: readonly Mesh[];
  readonly bogies: readonly Group[];
  /** Fake lamp light on the ground (additive decal, chassis-local); visible only without direct sun. */
  readonly lampPool: Mesh;
}

/**
 * Articulated suit. The suit faces +z, so +x is the crew member's left. Every joint is a Group at its anatomical
 * pivot and swings about its local x (sagittal plane); rotating a joint moves everything below it. Rest pose:
 * standing, all joint rotations zero, soles flat on the root's y = 0.
 */
export interface SuitRig {
  readonly root: Group;
  /** Left shoulder (alias of shoulderL); the dust solver turns it about z. */
  readonly shoulder: Group;
  /** Left elbow (alias of elbowL); the dust solver turns it about z. */
  readonly elbow: Group;
  readonly seal: Mesh;
  readonly sealMaterial: MeshStandardMaterial;
  readonly panel: Mesh;
  readonly panelMaterial: ShaderMaterial;
  /** Fake helmet-lamp light on the ground (additive decal); visible only without direct sun. */
  readonly lampPool: Mesh;
  /** Root of the legs and of the torso, at hip height. */
  readonly pelvis: Group;
  /** Waist pivot (lean); carries the upper body, the arms, the helmet and the EDS panel. */
  readonly torso: Group;
  /** Neck pivot with the visor assembly (the shell is fixed to the upper torso, as on an EMU). */
  readonly helmet: Group;
  readonly hipL: Group;
  readonly hipR: Group;
  readonly kneeL: Group;
  readonly kneeR: Group;
  readonly ankleL: Group;
  readonly ankleR: Group;
  readonly shoulderL: Group;
  readonly shoulderR: Group;
  readonly elbowL: Group;
  readonly elbowR: Group;
  /** Hip joint to sole in the rest pose (m). */
  readonly legLength: number;
  /** Heel to toe of the boot sole (m). */
  readonly footLength: number;
}

export interface LanderRig {
  readonly root: Group;
  readonly lidarHead: Group;
  /** Unit cone with its apex at the head origin; scale (R, h, R). */
  readonly cone: Mesh;
  /** Fake landing-lamp light on the ground (additive decal, draped on the terrain); visible only without direct sun. */
  readonly lampPool: Mesh;
}

export interface DrillRig {
  readonly root: Group;
  /** Translates down with depth; the auger tip sits at the pivot origin. */
  readonly augerPivot: Group;
  readonly auger: Mesh;
  readonly augerMaterial: ShaderMaterial;
  /** Stratigraphic cut, top to bottom: 0-0.10 m, 0.10-0.50 m, 0.50-1.50 m. */
  readonly strata: readonly Mesh[];
  readonly strataMaterials: readonly MeshBasicMaterial[];
  /** Fake lamp light on the ground (additive decal, draped on the terrain); visible only without direct sun. */
  readonly lampPool: Mesh;
}

export const AUGER_LENGTH = 2.0;
export const STRATA_BOUNDS_M: readonly number[] = [0, 0.1, 0.5, 1.5];


// ---------------------------------------------------------------------------------------------------------------
// Rover: six-wheel rocker-bogie on the solver's kinematics. Every static part is merged by kit material, so the
// rover is 6 wheels + 2 rockers + 2 bogies + 5 chassis meshes + the lamp pool.
// ---------------------------------------------------------------------------------------------------------------
/** Vertex tints on the kit materials (sRGB). */
const TINT_HUB = 0x50555c;
const TINT_FACE = 0x9ea3aa;
const TINT_LENS = 0x0a0b0e;
const TINT_SHADE = 0xc9c6bf;
/** Cylinder axis (+y) turned onto +z / +x. */
const AXIS_Z: Vec3 = [Math.PI / 2, 0, 0];
const AXIS_X: Vec3 = [0, 0, -Math.PI / 2];

/** Rocker arm attachment plane, inset from the wheel centre line (same as the solver's armZ). */
const ARM_Z = TRACK_WIDTH / 2 - ARM_INSET;

/**
 * One wheel, spinning about local z, hub at the origin: a thin drum with 20 grousers whose tips sit exactly on
 * WHEEL_RADIUS, recessed faces with six curved flexure spokes, hub, motor cans and the axle stub that reaches the
 * arm. Symmetric in z, so one geometry serves the left and the right wheels.
 */
function roverWheelGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const halfW = WHEEL_WIDTH / 2;
  const drumR = 0.226;
  const recess = 0.015;
  const seg = 24;
  parts.push(part(new CylinderGeometry(drumR, drumR, WHEEL_WIDTH, seg, 1, true), { rot: AXIS_Z }));
  for (let side = -1; side <= 1; side += 2) {
    const flip: Vec3 = side > 0 ? [0, 0, 0] : [0, Math.PI, 0];
    // Rim lip and the recessed face.
    parts.push(part(new RingGeometry(drumR - 0.012, drumR, seg), { at: [0, 0, side * halfW], rot: flip }));
    parts.push(part(new CircleGeometry(drumR - 0.012, seg), { at: [0, 0, side * (halfW - recess)], rot: flip, color: TINT_FACE }));
    // Inner wall of the recess (lathe points in descending y face inward).
    const top = side > 0 ? halfW : -(halfW - recess);
    const wall = [new Vector2(drumR - 0.012, top), new Vector2(drumR - 0.012, top - recess)];
    parts.push(part(new LatheGeometry(wall, seg), { rot: AXIS_Z, color: TINT_FACE }));
    // Six swept flexure spokes (one angled blade each), standing proud of the recessed face.
    const z = side * (halfW - recess + 0.006);
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      const x0 = 0.062 * Math.cos(a);
      const y0 = 0.062 * Math.sin(a);
      const x1 = 0.212 * Math.cos(a + 0.45 * side);
      const y1 = 0.212 * Math.sin(a + 0.45 * side);
      parts.push(
        part(new BoxGeometry(Math.hypot(x1 - x0, y1 - y0) + 0.012, 0.024, 0.012), {
          at: [(x0 + x1) / 2, (y0 + y1) / 2, z],
          rot: [0, 0, Math.atan2(y1 - y0, x1 - x0)],
        }),
      );
    }
    // Hub cap with the wheel drive motor behind it.
    parts.push(part(new CylinderGeometry(0.046, 0.054, 0.08, 10), { at: [0, 0, side * 0.135], rot: AXIS_Z, color: TINT_HUB }));
  }
  parts.push(part(new CylinderGeometry(0.066, 0.066, WHEEL_WIDTH - 2 * recess, 12), { rot: AXIS_Z, color: TINT_HUB }));
  parts.push(part(new CylinderGeometry(0.028, 0.028, 2 * (ARM_INSET + 0.015), 8), { rot: AXIS_Z, color: TINT_HUB }));
  // Grousers: tangential width w, outer face at sqrt(R² - (w/2)²) so the outer corners touch WHEEL_RADIUS.
  const grousers = 20;
  const w = 0.016;
  const outer = Math.sqrt(WHEEL_RADIUS * WHEEL_RADIUS - (w / 2) * (w / 2));
  const inner = drumR - 0.002;
  for (let g = 0; g < grousers; g++) {
    const a = (g / grousers) * Math.PI * 2;
    const r = (inner + outer) / 2;
    parts.push(part(new BoxGeometry(outer - inner, w, WHEEL_WIDTH), { at: [r * Math.cos(a), r * Math.sin(a), 0], rot: [0, 0, a] }));
  }
  return mergeParts(parts);
}

/**
 * Rocker beam, unit length along x and centred, because the solver sets `scale.x` to the hub-to-pivot length.
 * Knuckles at both ends and the differential pivot boss at ROCKER_PIVOT_X.
 */
function rockerBeamGeometry(): BufferGeometry {
  const rockerMidX = 0.5 * (WHEEL_FRONT_X + BOGIE_PIVOT_X);
  const bossX = (ROCKER_PIVOT_X - rockerMidX) / L_ROCKER;
  return mergeParts([
    tube([-0.5, 0, 0], [0.5, 0, 0], 0.03, 12),
    part(new CylinderGeometry(0.044, 0.044, 0.09, 14), { at: [0.5, 0, 0], rot: AXIS_Z }),
    part(new CylinderGeometry(0.044, 0.044, 0.09, 14), { at: [-0.5, 0, 0], rot: AXIS_Z }),
    part(new CylinderGeometry(0.05, 0.05, 0.1, 16), { at: [bossX, 0, 0], rot: AXIS_Z }),
    part(new BoxGeometry(0.26, 0.05, 0.03), { at: [bossX, -0.012, 0] }),
  ]);
}

/** Bogie: an A-frame from the two hubs (local y = 0) up to its pivot at H_OFFSET, where the rocker ends. */
function bogieGeometry(): BufferGeometry {
  const half = L_BOGIE / 2;
  return mergeParts([
    tube([half, 0, 0], [0, H_OFFSET, 0], 0.027, 10),
    tube([-half, 0, 0], [0, H_OFFSET, 0], 0.027, 10),
    tube([0.5 * half, 0.5 * H_OFFSET, 0], [-0.5 * half, 0.5 * H_OFFSET, 0], 0.018, 8),
    part(new CylinderGeometry(0.046, 0.046, 0.09, 14), { at: [0, H_OFFSET, 0], rot: AXIS_Z }),
    part(new CylinderGeometry(0.04, 0.04, 0.075, 14), { at: [half, 0, 0], rot: AXIS_Z }),
    part(new CylinderGeometry(0.04, 0.04, 0.075, 14), { at: [-half, 0, 0], rot: AXIS_Z }),
  ]);
}

/** Closed parabolic dish of radius r and focal length f, opening toward +y, with thickness t. */
function dishGeometry(r: number, f: number, t: number, segments: number): BufferGeometry {
  const profile: Vector2[] = [];
  const steps = 6;
  for (let i = 0; i <= steps; i++) {
    const x = (r * i) / steps;
    profile.push(new Vector2(Math.max(x, 0.001), (x * x) / (4 * f)));
  }
  for (let i = steps; i >= 0; i--) {
    const x = (r * i) / steps;
    profile.push(new Vector2(Math.max(x, 0.001), (x * x) / (4 * f) + t));
  }
  return new LatheGeometry(profile, segments);
}

/** Lamp: emissive face of radius r looking along +x, at `at`. */
function lampFace(at: Vec3, r: number): BufferGeometry {
  return part(new CylinderGeometry(r, r, 0.012, 14), { at, rot: AXIS_X });
}

/** Lamp housing behind a face of radius r looking along +x. */
function lampHousing(at: Vec3, r: number): BufferGeometry {
  return part(new CylinderGeometry(r * 1.35, r * 1.5, 0.05, 14), { at: [at[0] - 0.026, at[1], at[2]], rot: AXIS_X });
}

function namedMesh(name: string, geometry: BufferGeometry, material: Material, castShadow = true): Mesh {
  const mesh = new Mesh(geometry, material);
  mesh.name = name;
  if (!castShadow) mesh.userData.castShadow = false;
  return mesh;
}

/** Height of the pool above the terrain surface (m); the material's polygon offset hides the rest. */
const POOL_LIFT_M = 0.025;

/**
 * Additive ground decal for the unsunlit preset (size along x, z), centred on its parent-local position. It never
 * casts a shadow and is hidden by the kit while the site has direct sun. While it is drawn, each frame it drapes
 * its vertices over the terrain (sampleHeight at the world position of every vertex): about 81 samples, no
 * allocation, nothing at all while it is hidden. The vertical correction assumes a near-upright parent.
 */
function lampPoolMesh(name: string, sizeX: number, sizeZ: number, segments = 8): Mesh {
  const geometry = new PlaneGeometry(sizeX, sizeZ, segments, segments);
  geometry.rotateX(-Math.PI / 2);
  const position = geometry.attributes.position as BufferAttribute;
  position.setUsage(DynamicDrawUsage);
  const mesh = new Mesh(geometry, getHardwareKit().lampPool);
  mesh.name = name;
  mesh.userData.castShadow = false;
  mesh.renderOrder = 1;
  mesh.frustumCulled = false; // the draped surface leaves the flat bounding sphere
  mesh.raycast = () => {};
  mesh.onBeforeRender = () => {
    const m = mesh.matrixWorld.elements;
    const up = m[5] > 0.2 ? m[5] : 1;
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i);
      const z = position.getZ(i);
      const wx = m[0] * x + m[8] * z + m[12];
      const wy = m[1] * x + m[9] * z + m[13];
      const wz = m[2] * x + m[10] * z + m[14];
      position.setY(i, (sampleHeight(wx, wz) + POOL_LIFT_M - wy) / up);
    }
    position.needsUpdate = true;
  };
  return mesh;
}

/** Chassis-local layout (chassis origin: about 0.6 m above flat ground, 0.16 m above the rocker main pivots). */
const WEB_MIN_X = -0.56;
const WEB_MAX_X = 0.62;
const WEB_BOTTOM = -0.21;
const WEB_TOP = 0.1;
const WEB_HALF_Z = 0.42;
const DECK_TOP = WEB_TOP + 0.035;
const MAST_X = 0.47;
const MAST_Z = 0.25;
const MAST_TOP = 0.93;
const HGA_AT: Vec3 = [0.4, 0.36, -0.25];

function buildRoverChassis(chassis: Group): void {
  const kit = getHardwareKit();
  const webLength = WEB_MAX_X - WEB_MIN_X;
  const webMidX = 0.5 * (WEB_MIN_X + WEB_MAX_X);
  const webHeight = WEB_TOP - WEB_BOTTOM;

  // Warm electronics box: gold MLI blanket on the four sides.
  const mli: BufferGeometry[] = [
    part(new BoxGeometry(webLength, webHeight, 2 * WEB_HALF_Z), { at: [webMidX, 0.5 * (WEB_TOP + WEB_BOTTOM), 0], uvDensity: MLI_UV_DENSITY }),
  ];

  // White thermal paint: deck plate, remote-sensing mast and camera head, antennas, stowed arm.
  const paint: BufferGeometry[] = [
    part(new BoxGeometry(webLength + 0.05, DECK_TOP - WEB_TOP, 2 * WEB_HALF_Z + 0.05), { at: [webMidX, 0.5 * (WEB_TOP + DECK_TOP), 0] }),
    tube([MAST_X, DECK_TOP + 0.05, MAST_Z], [MAST_X, MAST_TOP - 0.02, MAST_Z], 0.028, 14),
    part(new CylinderGeometry(0.031, 0.031, 0.045, 14), { at: [MAST_X, 0.66, MAST_Z], color: MARKING_ORANGE }),
    part(new BoxGeometry(0.15, 0.115, 0.32), { at: [MAST_X + 0.02, MAST_TOP + 0.06, MAST_Z] }),
    part(new BoxGeometry(0.19, 0.012, 0.35), { at: [MAST_X + 0.04, MAST_TOP + 0.124, MAST_Z], color: TINT_SHADE }),
    part(dishGeometry(0.19, 0.13, 0.012, 28), { at: HGA_AT, rot: [-0.55, 0, 0.5] }),
    part(new CylinderGeometry(0.012, 0.02, 0.05, 10), { at: [-0.5, DECK_TOP + 0.21, -0.3] }),
    tube([0.66, -0.075, -0.33], [0.68, -0.075, 0.18], 0.024, 10),
    tube([0.68, -0.075, 0.18], [0.7, -0.03, 0.3], 0.021, 10),
  ];

  // Anodised dark aluminium: belly pan, solar deck frame, pivots, mast fittings, lenses, gimbal, arm turret.
  const dark: BufferGeometry[] = [
    part(new BoxGeometry(webLength + 0.02, 0.022, 2 * WEB_HALF_Z + 0.02), { at: [webMidX, WEB_BOTTOM - 0.011, 0] }),
    part(new BoxGeometry(0.95, 0.018, 2 * WEB_HALF_Z + 0.01), { at: [-0.16, DECK_TOP + 0.03, 0] }),
    part(new CylinderGeometry(0.05, 0.06, 0.06, 16), { at: [MAST_X, DECK_TOP + 0.03, MAST_Z] }),
    part(new CylinderGeometry(0.036, 0.036, 0.13, 14), { at: [MAST_X, MAST_TOP - 0.01, MAST_Z], rot: AXIS_Z }),
    part(new CylinderGeometry(0.03, 0.035, 0.06, 12), { at: HGA_AT, rot: [-0.55, 0, 0.5] }),
    tube([HGA_AT[0], DECK_TOP, HGA_AT[2]], [HGA_AT[0] - 0.02, HGA_AT[1] - 0.03, HGA_AT[2] + 0.02], 0.022, 10),
    tube([-0.5, DECK_TOP, -0.3], [-0.5, DECK_TOP + 0.19, -0.3], 0.012, 8),
    part(new BoxGeometry(0.12, 0.09, 0.11), { at: [0.74, -0.04, 0.32] }),
    part(new CylinderGeometry(0.03, 0.03, 0.06, 12), { at: [0.66, -0.075, -0.36], rot: AXIS_Z }),
    part(new BoxGeometry(0.05, 0.06, 0.32), { at: [WEB_MAX_X + 0.02, -0.16, 0] }),
  ];
  // Solar deck standoffs.
  for (const sx of [-0.58, 0.26]) {
    for (const sz of [-0.36, 0.36]) dark.push(part(new BoxGeometry(0.03, 0.025, 0.03), { at: [sx, DECK_TOP + 0.011, sz] }));
  }
  // High-gain antenna feed on the dish axis, with an orange cap.
  const hgaAxis = new Vector3(0, 1, 0).applyEuler(new Euler(-0.55, 0, 0.5));
  const feedEnd: Vec3 = [HGA_AT[0] + hgaAxis.x * 0.11, HGA_AT[1] + hgaAxis.y * 0.11, HGA_AT[2] + hgaAxis.z * 0.11];
  dark.push(tube([HGA_AT[0] + hgaAxis.x * 0.02, HGA_AT[1] + hgaAxis.y * 0.02, HGA_AT[2] + hgaAxis.z * 0.02], feedEnd, 0.008, 8));
  paint.push(part(new CylinderGeometry(0.018, 0.012, 0.02, 10), { at: feedEnd, rot: [-0.55, 0, 0.5], color: MARKING_ORANGE }));
  // Differential pivot axles from the box sides to the rocker bosses.
  for (let side = -1; side <= 1; side += 2) {
    const z = side * 0.5 * (WEB_HALF_Z + ARM_Z);
    dark.push(part(new CylinderGeometry(0.04, 0.04, ARM_Z - WEB_HALF_Z + 0.02, 14), { at: [ROCKER_PIVOT_X - 0.05, -0.16, z], rot: AXIS_Z }));
  }
  // Mast head: two navigation cameras and a science camera, glossy near-black glass.
  for (const dz of [-0.1, 0, 0.1]) {
    const r = dz === 0 ? 0.03 : 0.022;
    const at: Vec3 = [MAST_X + 0.095 + 0.02, MAST_TOP + 0.06, MAST_Z + dz];
    dark.push(part(new CylinderGeometry(r * 1.3, r * 1.3, 0.04, 14), { at, rot: AXIS_X }));
    dark.push(part(new CylinderGeometry(r, r, 0.006, 14), { at: [at[0] + 0.022, at[1], at[2]], rot: AXIS_X, color: TINT_LENS }));
  }
  // Front hazard cameras, pointing down.
  for (const dz of [-0.13, 0.13]) {
    dark.push(part(new CylinderGeometry(0.02, 0.02, 0.012, 12), { at: [WEB_MAX_X + 0.05, -0.16, dz], rot: [0, 0, -Math.PI / 2 - 0.5], color: TINT_LENS }));
  }

  // Solar array on the rear two thirds of the deck.
  const solar = [part(new BoxGeometry(0.93, 0.022, 2 * WEB_HALF_Z), { at: [-0.16, DECK_TOP + 0.05, 0] })];

  // Lamps: two drive lamps on the front face, one on the mast head.
  const lampAt: Vec3[] = [
    [WEB_MAX_X + 0.04, 0.045, -0.3],
    [WEB_MAX_X + 0.04, 0.045, 0.3],
  ];
  const headLamp: Vec3 = [MAST_X + 0.1, MAST_TOP - 0.02, MAST_Z];
  const lamps: BufferGeometry[] = [];
  for (const at of lampAt) {
    lamps.push(lampFace(at, 0.034));
    dark.push(lampHousing(at, 0.034));
  }
  lamps.push(lampFace(headLamp, 0.018));
  dark.push(lampHousing(headLamp, 0.018));

  chassis.add(
    namedMesh('rover-mli', mergeParts(mli), kit.mli),
    namedMesh('rover-paint', mergeParts(paint), kit.paint),
    namedMesh('rover-dark', mergeParts(dark), kit.darkAluminium),
    namedMesh('rover-solar', mergeParts(solar), kit.solarCell),
    namedMesh('rover-lamps', mergeParts(lamps), kit.lamp, false),
  );
}

export function buildRover(): RoverRig {
  const kit = getHardwareKit();
  const root = new Group();
  root.name = 'rover';

  const chassis = new Group();
  chassis.name = 'rover-chassis';
  buildRoverChassis(chassis);
  // Drive lamp pool: on the ground under and ahead of the rover, tilting with the chassis.
  const lampPool = lampPoolMesh('rover-lamp-pool', 3.4, 2.4);
  lampPool.position.set(0.95, -0.6, 0);
  chassis.add(lampPool);
  root.add(chassis);

  const wheelGeometry = roverWheelGeometry();
  const wheels: Group[] = [];
  for (let i = 0; i < 6; i++) {
    const wheel = new Group();
    wheel.name = `rover-wheel-${i}`;
    wheel.add(namedMesh('rover-wheel', wheelGeometry, kit.wheelAluminium));
    root.add(wheel);
    wheels.push(wheel);
  }

  const beamGeometry = rockerBeamGeometry();
  const bogieGeo = bogieGeometry();
  const rockers: Group[] = [];
  const rockerBeams: Mesh[] = [];
  const bogies: Group[] = [];
  for (let side = 0; side < 2; side++) {
    const rocker = new Group();
    rocker.name = `rover-rocker-${side}`;
    const beam = namedMesh('rover-rocker-beam', beamGeometry, kit.darkAluminium);
    rocker.add(beam);
    root.add(rocker);
    rockers.push(rocker);
    rockerBeams.push(beam);

    const bogie = new Group();
    bogie.name = `rover-bogie-${side}`;
    bogie.add(namedMesh('rover-bogie', bogieGeo, kit.darkAluminium));
    root.add(bogie);
    bogies.push(bogie);
  }

  return { root, chassis, wheels, rockers, rockerBeams, bogies, lampPool };
}

// ---------------------------------------------------------------------------------------------------------------
// Suit: EMU-like astronaut with the AxEMU arm joints the dust solver drives, and the EDS solar panel.
// ---------------------------------------------------------------------------------------------------------------
const PANEL_VERTEX = /* glsl */ `
varying vec2 vUv;
varying vec3 vNormalW;
void main() {
  vUv = uv;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const PANEL_FRAGMENT = /* glsl */ `
uniform float uDustObscuration;
uniform float uEdsFlash;
varying vec2 vUv;
varying vec3 vNormalW;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  vec2 cell = fract(vUv * vec2(12.0, 6.0));
  float grid = step(0.06, cell.x) * step(0.06, cell.y);
  vec3 photovoltaic = mix(vec3(0.72, 0.75, 0.8), vec3(0.04, 0.1, 0.3), grid);
  float speck = hash(floor(vUv * 180.0));
  float coverage = clamp(uDustObscuration * 1.25 + (speck - 0.5) * 0.35 * uDustObscuration, 0.0, 1.0);
  vec3 dust = vec3(0.6, 0.5, 0.38);
  float light = 0.55 + 0.45 * max(dot(normalize(vNormalW), normalize(vec3(-0.4, 0.8, 0.45))), 0.0);
  vec3 color = mix(photovoltaic, dust, coverage) * light;
  color += vec3(0.3, 0.5, 1.0) * uEdsFlash * (0.5 + 0.5 * sin(vUv.x * 90.0));
  gl_FragColor = vec4(color, 1.0);
}
`;

/** Yaw of the suit (rad): its front (+z) turned toward the hero camera in a 3/4 view. */
const SUIT_HEADING_RAD = 2.2;
const TINT_GLOVE = 0x8e9298;
const TINT_SOLE = 0x4a4d52;
const TINT_BEARING = 0xb9bdc3;
const TINT_DETAIL = 0x3a3d42;

/** Suit dimensions in the rest pose (root-local metres; the suit faces +z, so +x is the crew member's left). */
const SUIT_HIP_Y = 0.92;
const SUIT_HIP_X = 0.12;
const SUIT_THIGH = 0.42;
const SUIT_SHIN = 0.4;
/** Ankle height above the sole. */
const SUIT_ANKLE_Y = SUIT_HIP_Y - SUIT_THIGH - SUIT_SHIN;
const SUIT_FOOT_LENGTH = 0.3;
/** The boot reaches this far behind the ankle (the rest is ahead of it, toward +z). */
const SUIT_HEEL = 0.08;
const SUIT_WAIST_Y = 0.98;
const SUIT_SHOULDER: Vec3 = [0.32, 1.45, 0];
const SUIT_UPPER_ARM = 0.42;
const SUIT_NECK_Y = 1.6;

function suitGroup(name: string, parent: Object3D, x: number, y: number, z: number): Group {
  const group = new Group();
  group.name = name;
  group.position.set(x, y, z);
  parent.add(group);
  return group;
}

/** Thigh in hip-local coordinates (hangs along -y), with the orange marking band. */
function thighParts(): BufferGeometry[] {
  return [
    part(new CapsuleGeometry(0.088, SUIT_THIGH - 0.12, 4, 14), { at: [0, -0.5 * SUIT_THIGH, 0] }),
    part(new CylinderGeometry(0.092, 0.092, 0.05, 14), { at: [0, -0.14, 0], color: MARKING_ORANGE }),
  ];
}

/** Shin and knee pad in knee-local coordinates. */
function shinParts(): BufferGeometry[] {
  return [
    part(new SphereGeometry(0.082, 12, 8), { at: [0, 0, 0.03], scale: [1, 0.9, 0.8] }),
    part(new CapsuleGeometry(0.075, SUIT_SHIN - 0.13, 4, 14), { at: [0, -0.5 * SUIT_SHIN, 0.005] }),
  ];
}

/** Boot in ankle-local coordinates: the sole's underside is at y = -SUIT_ANKLE_Y. */
function footParts(): BufferGeometry[] {
  const mid = SUIT_FOOT_LENGTH / 2 - SUIT_HEEL;
  return [
    part(new CylinderGeometry(0.078, 0.082, 0.07, 14), { at: [0, 0.01, 0] }),
    part(new BoxGeometry(0.13, SUIT_ANKLE_Y - 0.01, SUIT_FOOT_LENGTH - 0.02), { at: [0, -0.5 * (SUIT_ANKLE_Y + 0.01) + 0.01, mid] }),
    part(new BoxGeometry(0.14, 0.03, SUIT_FOOT_LENGTH), { at: [0, -SUIT_ANKLE_Y + 0.015, mid], color: TINT_SOLE }),
  ];
}

/** Upper arm in shoulder-local coordinates. */
function upperArmParts(): BufferGeometry[] {
  return [part(new CapsuleGeometry(0.068, 0.26, 4, 14), { at: [0, -0.21, 0] })];
}

/** Forearm, cuff and glove in elbow-local coordinates. */
function forearmParts(): BufferGeometry[] {
  return [
    part(new CapsuleGeometry(0.06, 0.22, 4, 14), { at: [0, -0.2, 0] }),
    part(new CylinderGeometry(0.06, 0.064, 0.045, 14), { at: [0, -0.39, 0] }),
    part(new CapsuleGeometry(0.046, 0.05, 4, 12), { at: [0, -0.452, 0], scale: [1, 1, 0.72], color: TINT_GLOVE }),
    part(new CapsuleGeometry(0.017, 0.04, 3, 8), { at: [0.038, -0.43, 0.02], rot: [0, 0, 0.5], color: TINT_GLOVE }),
  ];
}

/** Elbow and wrist bearings in elbow-local coordinates. */
function armBearingParts(color = 0xffffff): BufferGeometry[] {
  return [
    part(new TorusGeometry(0.068, 0.021, 6, 20), { rot: [Math.PI / 2, 0, 0], color }),
    part(new TorusGeometry(0.057, 0.014, 6, 16), { at: [0, -0.36, 0], rot: [Math.PI / 2, 0, 0], color }),
  ];
}

/**
 * EMU-like suit as an articulated rig: root → pelvis (hips) → hip → knee → ankle per leg, and pelvis → torso →
 * shoulder → elbow per arm, plus the helmet visor assembly on the torso. Every joint is a Group at the anatomical
 * pivot; static parts are merged per segment and material (16 meshes). Rest pose: standing, all joint rotations
 * zero, soles flat on y = 0. Each joint swings about its local x (sagittal plane); the dust solver additionally
 * turns `shoulder`/`elbow` about z (frontal plane), as before.
 */
export function buildSuit(): SuitRig {
  const kit = getHardwareKit();
  const root = new Group();
  root.name = 'axemu-suit';
  root.rotation.y = SUIT_HEADING_RAD;
  const sealMaterial = new MeshStandardMaterial({ color: 0xb8bcc2, roughness: 0.38, metalness: 0.65, vertexColors: true });
  sealMaterial.name = 'suit-seal';
  registerEnvMaterial(sealMaterial, 0.8);

  // Pelvis at hip height: the root of both legs and of the torso.
  const pelvis = suitGroup('suit-pelvis', root, 0, SUIT_HIP_Y, 0);
  const legs: { hip: Group; knee: Group; ankle: Group }[] = [];
  for (const side of [1, -1]) {
    const tag = side > 0 ? 'l' : 'r';
    const hip = suitGroup(`suit-hip-${tag}`, pelvis, side * SUIT_HIP_X, 0, 0);
    hip.add(namedMesh(`suit-thigh-${tag}`, mergeParts(thighParts()), kit.betaCloth));
    const knee = suitGroup(`suit-knee-${tag}`, hip, 0, -SUIT_THIGH, 0);
    knee.add(namedMesh(`suit-shin-${tag}`, mergeParts(shinParts()), kit.betaCloth));
    const ankle = suitGroup(`suit-ankle-${tag}`, knee, 0, -SUIT_SHIN, 0);
    ankle.add(namedMesh(`suit-foot-${tag}`, mergeParts(footParts()), kit.betaCloth));
    legs.push({ hip, knee, ankle });
  }

  // Torso, pivoting at the waist: lower torso, hard upper torso, backpack, helmet shell (fixed to the upper torso
  // on an EMU), chest controls, bearings and panel stand. One cloth mesh; small details are vertex tints.
  const torso = suitGroup('suit-torso', pelvis, 0, SUIT_WAIST_Y - SUIT_HIP_Y, 0);
  const w = SUIT_WAIST_Y;
  const cloth: BufferGeometry[] = [
    part(new SphereGeometry(1, 16, 10), { at: [0, 0.95 - w, 0], scale: [0.23, 0.14, 0.17] }),
    part(new CapsuleGeometry(0.2, 0.25, 6, 18), { at: [0, 1.3 - w, 0], scale: [1.15, 1, 0.8] }),
    part(new BoxGeometry(0.46, 0.56, 0.22), { at: [0, 1.3 - w, -0.27] }),
    part(new CylinderGeometry(0.11, 0.11, 0.46, 18), { at: [0, 1.58 - w, -0.27], rot: [0, 0, Math.PI / 2] }),
    part(new SphereGeometry(0.16, 20, 14), { at: [0, 1.7 - w, 0.05] }),
    part(new BoxGeometry(0.26, 0.12, 0.1), { at: [0, 1.22 - w, 0.215] }),
    part(new BoxGeometry(0.3, 0.26, 0.012), { at: [0, 1.2 - w, -0.386], color: TINT_DETAIL }),
    tube([0, 1.66 - w, -0.33], [0, 1.85 - w, -0.37], 0.016, 8, TINT_DETAIL),
    part(new BoxGeometry(0.12, 0.03, 0.04), { at: [0, 1.86 - w, -0.37], color: TINT_DETAIL }),
    part(new TorusGeometry(0.13, 0.02, 6, 24), { at: [0, 1.585 - w, 0.02], rot: [Math.PI / 2, 0, 0], color: TINT_BEARING }),
    part(new TorusGeometry(0.2, 0.022, 6, 24), { at: [0, 1.02 - w, 0], rot: [Math.PI / 2, 0, 0], scale: [1, 0.78, 1], color: TINT_BEARING }),
  ];
  for (const dx of [-0.08, 0, 0.08]) {
    cloth.push(part(new CylinderGeometry(0.018, 0.018, 0.03, 12), { at: [dx, 1.22 - w, 0.275], rot: [Math.PI / 2, 0, 0], color: TINT_DETAIL }));
  }
  const lamps: BufferGeometry[] = [];
  for (const s of [1, -1]) {
    cloth.push(
      part(new SphereGeometry(0.1, 14, 10), { at: [0.29 * s, 1.47 - w, 0] }),
      part(new TorusGeometry(0.085, 0.02, 6, 18), { at: [0.25 * s, 1.47 - w, 0], rot: [0, Math.PI / 2, 0], color: TINT_BEARING }),
      part(new BoxGeometry(0.045, 0.05, 0.07), { at: [0.165 * s, 1.75 - w, 0.07], color: TINT_DETAIL }),
    );
    lamps.push(part(new CylinderGeometry(0.018, 0.018, 0.01, 12), { at: [0.165 * s, 1.75 - w, 0.108], rot: [Math.PI / 2, 0, 0] }));
  }
  torso.add(namedMesh('suit-torso', mergeParts(cloth), kit.betaCloth), namedMesh('suit-lamps', mergeParts(lamps), kit.lamp, false));

  // Helmet: the gold visor assembly over the shell, pivoting at the neck ring.
  const neck = SUIT_NECK_Y - w;
  const helmet = suitGroup('suit-helmet', torso, 0, neck, 0);
  helmet.add(
    namedMesh(
      'suit-visor',
      mergeParts([part(new SphereGeometry(0.166, 24, 12, Math.PI / 2 - 1.0, 2.0, 0.62, 1.2), { at: [0, 1.7 - SUIT_NECK_Y, 0.05] })]),
      kit.visor,
    ),
  );

  // Arms. The left one (+x) is the one the dust solver moves, with the tinted elbow seal.
  const arms: { shoulder: Group; elbow: Group }[] = [];
  let seal: Mesh | null = null;
  for (const side of [1, -1]) {
    const tag = side > 0 ? 'l' : 'r';
    const shoulder = suitGroup(`suit-shoulder-${tag}`, torso, side * SUIT_SHOULDER[0], SUIT_SHOULDER[1] - w, SUIT_SHOULDER[2]);
    shoulder.add(namedMesh(`suit-upper-arm-${tag}`, mergeParts(upperArmParts()), kit.betaCloth));
    const elbow = suitGroup(`suit-elbow-${tag}`, shoulder, 0, -SUIT_UPPER_ARM, 0);
    if (side > 0) {
      seal = namedMesh('suit-elbow-seal', mergeParts(armBearingParts()), sealMaterial);
      elbow.add(seal, namedMesh(`suit-forearm-${tag}`, mergeParts(forearmParts()), kit.betaCloth));
    } else {
      elbow.add(namedMesh(`suit-forearm-${tag}`, mergeParts([...forearmParts(), ...armBearingParts(TINT_BEARING)]), kit.betaCloth));
    }
    arms.push({ shoulder, elbow });
  }
  if (seal === null) throw new Error('buildSuit: no elbow seal');

  // EDS-coated solar panel (the dust solver's 1.0 m x 0.55 m panel) on the backpack stand, same place as before.
  const panelMaterial = new ShaderMaterial({
    uniforms: { uDustObscuration: { value: 0 }, uEdsFlash: { value: 0 } },
    vertexShader: PANEL_VERTEX,
    fragmentShader: PANEL_FRAGMENT,
    side: DoubleSide,
  });
  const panel = new Mesh(new PlaneGeometry(1.0, 0.55), panelMaterial);
  panel.name = 'suit-eds-panel';
  panel.position.set(0, 1.9 - w, -0.35);
  panel.rotation.x = -Math.PI / 3;
  torso.add(panel);

  const lampPool = lampPoolMesh('suit-lamp-pool', 2.6, 2.6);
  lampPool.position.set(0, 0, 0.7);
  root.add(lampPool);

  const [left, right] = arms;
  const [legL, legR] = legs;
  return {
    root,
    shoulder: left.shoulder,
    elbow: left.elbow,
    seal,
    sealMaterial,
    panel,
    panelMaterial,
    lampPool,
    pelvis,
    torso,
    helmet,
    hipL: legL.hip,
    hipR: legR.hip,
    kneeL: legL.knee,
    kneeR: legR.knee,
    ankleL: legL.ankle,
    ankleR: legR.ankle,
    shoulderL: left.shoulder,
    shoulderR: right.shoulder,
    elbowL: left.elbow,
    elbowR: right.elbow,
    legLength: SUIT_HIP_Y,
    footLength: SUIT_FOOT_LENGTH,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Lander: faceted descent stage in MLI, four legs, descent engines, LiDAR head and scan cone.
// ---------------------------------------------------------------------------------------------------------------
/** Descent-stage octagon: circumradius, apothem and half height (m). */
const LANDER_R = 1.0;
const LANDER_APOTHEM = LANDER_R * Math.cos(Math.PI / 8);
const LANDER_HALF_H = 0.45;
const TINT_NIOBIUM = 0x6a625c;

/** Engine bell: outer wall (ascending profile, faces out) and inner wall (descending profile, faces in). */
function bellParts(at: Vec3, throat: number, exit: number, length: number): BufferGeometry[] {
  const outer: Vector2[] = [];
  const inner: Vector2[] = [];
  const steps = 8;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const r = throat + (exit - throat) * Math.pow(t, 0.62);
    outer.push(new Vector2(r + 0.006, -length * t));
  }
  outer.reverse(); // ascending y
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    inner.push(new Vector2(throat + (exit - throat) * Math.pow(t, 0.62), -length * t)); // descending y
  }
  return [
    part(new LatheGeometry(outer, 20), { at, color: TINT_NIOBIUM }),
    part(new LatheGeometry(inner, 20), { at, color: 0x2a2624 }),
    part(new CylinderGeometry(throat * 1.4, throat * 1.6, 0.1, 14), { at: [at[0], at[1] + 0.05, at[2]] }),
  ];
}

export function buildLander(): LanderRig {
  const kit = getHardwareKit();
  const root = new Group();
  root.name = 'lander';
  const octagon = [0, -Math.PI / 8, 0] as const; // flat faces toward ±x and ±z

  const mli: BufferGeometry[] = [
    part(new CylinderGeometry(LANDER_R, LANDER_R, 2 * LANDER_HALF_H, 8, 1), { rot: octagon, flat: true, uvDensity: MLI_UV_DENSITY }),
    part(new BoxGeometry(0.5, 0.24, 0.36), { at: [-0.1, LANDER_HALF_H + 0.17, -0.5], uvDensity: MLI_UV_DENSITY }),
  ];
  const paint: BufferGeometry[] = [
    part(new CylinderGeometry(LANDER_R + 0.04, LANDER_R + 0.04, 0.05, 8, 1), { at: [0, LANDER_HALF_H + 0.025, 0], rot: octagon, flat: true }),
    part(new SphereGeometry(0.29, 20, 14), { at: [0.4, LANDER_HALF_H + 0.32, 0.1] }),
    part(new SphereGeometry(0.29, 20, 14), { at: [-0.4, LANDER_HALF_H + 0.32, 0.1] }),
    part(new BoxGeometry(0.02, 0.32, 0.5), { at: [0.16, LANDER_HALF_H + 0.21, -0.5] }),
  ];
  const dark: BufferGeometry[] = [
    part(new CylinderGeometry(LANDER_R + 0.02, LANDER_R + 0.02, 0.04, 8, 1), { at: [0, -LANDER_HALF_H - 0.02, 0], rot: octagon, flat: true }),
    part(new SphereGeometry(0.13, 16, 10), { at: [0, LANDER_HALF_H + 0.18, 0.55] }),
    part(new CylinderGeometry(0.045, 0.045, 0.08, 12), { at: [0, -LANDER_HALF_H - 0.08, 0] }),
  ];
  // Tank saddles.
  for (const x of [-0.4, 0.4]) {
    dark.push(part(new CylinderGeometry(0.2, 0.24, 0.06, 16), { at: [x, LANDER_HALF_H + 0.07, 0.1] }));
  }
  // High-gain antenna on a mast, with an orange feed cap.
  const hgaAt: Vec3 = [0.62, LANDER_HALF_H + 0.62, -0.5];
  const hgaRot: Vec3 = [-0.45, 0, -0.55];
  dark.push(tube([0.6, LANDER_HALF_H + 0.05, -0.48], [hgaAt[0], hgaAt[1] - 0.03, hgaAt[2]], 0.025, 10));
  paint.push(part(dishGeometry(0.24, 0.16, 0.014, 28), { at: hgaAt, rot: hgaRot }));
  const hgaAxis = new Vector3(0, 1, 0).applyEuler(new Euler(hgaRot[0], hgaRot[1], hgaRot[2]));
  const feedEnd: Vec3 = [hgaAt[0] + hgaAxis.x * 0.13, hgaAt[1] + hgaAxis.y * 0.13, hgaAt[2] + hgaAxis.z * 0.13];
  dark.push(tube(hgaAt, feedEnd, 0.009, 8));
  paint.push(part(new CylinderGeometry(0.02, 0.014, 0.022, 10), { at: feedEnd, rot: hgaRot, color: MARKING_ORANGE }));
  // Omni antenna.
  dark.push(tube([-0.55, LANDER_HALF_H + 0.05, 0.5], [-0.55, LANDER_HALF_H + 0.5, 0.5], 0.012, 8));
  paint.push(part(new SphereGeometry(0.03, 10, 8), { at: [-0.55, LANDER_HALF_H + 0.52, 0.5] }));

  // Solar panels on the +x and -z facets (toward the hero camera).
  const solar: BufferGeometry[] = [
    part(new BoxGeometry(0.02, 0.62, 0.66), { at: [LANDER_APOTHEM + 0.012, 0, 0] }),
    part(new BoxGeometry(0.66, 0.62, 0.02), { at: [0, 0, -LANDER_APOTHEM - 0.012] }),
  ];

  // Descent engines: four throttleable bells under the bottom deck, clear of the central LiDAR head.
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 2;
    dark.push(...bellParts([0.52 * Math.cos(a), -LANDER_HALF_H - 0.06, 0.52 * Math.sin(a)], 0.055, 0.17, 0.34));
  }

  // Legs on the diagonals: shock-absorbing primary strut, two secondary struts, footpad, orange band.
  const struts: BufferGeometry[] = [];
  const lamps: BufferGeometry[] = [];
  for (let k = 0; k < 4; k++) {
    const a = Math.PI / 4 + (k * Math.PI) / 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const top: Vec3 = [0.88 * c, 0.2, 0.88 * s];
    const foot: Vec3 = [1.62 * c, -1.2, 1.62 * s];
    const knee: Vec3 = [top[0] + 0.62 * (foot[0] - top[0]), top[1] + 0.62 * (foot[1] - top[1]), top[2] + 0.62 * (foot[2] - top[2])];
    const sleeveEnd: Vec3 = [top[0] + 0.42 * (foot[0] - top[0]), top[1] + 0.42 * (foot[1] - top[1]), top[2] + 0.42 * (foot[2] - top[2])];
    struts.push(tube(top, foot, 0.036, 10));
    dark.push(tube(top, sleeveEnd, 0.056, 12));
    for (const da of [-0.38, 0.38]) {
      dark.push(tube([0.9 * Math.cos(a + da), -LANDER_HALF_H, 0.9 * Math.sin(a + da)], knee, 0.022, 8));
    }
    struts.push(part(new CylinderGeometry(0.22, 0.17, 0.06, 18), { at: [foot[0], foot[1] - 0.06, foot[2]] }));
    struts.push(part(new CylinderGeometry(0.05, 0.07, 0.06, 12), { at: [foot[0], foot[1] - 0.01, foot[2]] }));
    const band: Vec3 = [top[0] + 0.82 * (foot[0] - top[0]), top[1] + 0.82 * (foot[1] - top[1]), top[2] + 0.82 * (foot[2] - top[2])];
    paint.push(tube([band[0], band[1] + 0.03, band[2]], [band[0], band[1] - 0.03, band[2]], 0.042, 12, MARKING_ORANGE));
    // Landing lamp under the deck at this corner, facing down.
    lamps.push(part(new CylinderGeometry(0.04, 0.04, 0.012, 14), { at: [0.74 * c, -LANDER_HALF_H - 0.05, 0.74 * s] }));
    dark.push(part(new CylinderGeometry(0.055, 0.05, 0.05, 14), { at: [0.74 * c, -LANDER_HALF_H - 0.02, 0.74 * s] }));
  }
  // Beacon on the avionics box.
  lamps.push(part(new SphereGeometry(0.03, 10, 8), { at: [-0.25, LANDER_HALF_H + 0.31, -0.5] }));

  root.add(
    namedMesh('lander-mli', mergeParts(mli), kit.mli),
    namedMesh('lander-paint', mergeParts(paint), kit.paint),
    namedMesh('lander-dark', mergeParts(dark), kit.darkAluminium),
    namedMesh('lander-struts', mergeParts(struts), kit.wheelAluminium),
    namedMesh('lander-solar', mergeParts(solar), kit.solarCell),
    namedMesh('lander-lamps', mergeParts(lamps), kit.lamp, false),
  );

  // LiDAR head: turns about y under the deck; the scan cone's apex is at its origin.
  const lidarHead = new Group();
  lidarHead.name = 'lander-lidar-head';
  lidarHead.position.y = -0.6;
  root.add(lidarHead);
  lidarHead.add(
    namedMesh(
      'lander-lidar-housing',
      mergeParts([
        part(new CylinderGeometry(0.1, 0.11, 0.13, 18)),
        part(new CylinderGeometry(0.075, 0.1, 0.03, 18), { at: [0, 0.08, 0] }),
        part(new BoxGeometry(0.03, 0.05, 0.09), { at: [0.1, -0.01, 0], color: TINT_LENS }),
      ]),
      kit.darkAluminium,
    ),
  );

  const coneGeo = new ConeGeometry(1, 1, 32, 1, true);
  coneGeo.translate(0, -0.5, 0); // apex at the origin, base at y = -1
  const coneMat = new MeshBasicMaterial({
    color: 0x40e0ff,
    transparent: true,
    opacity: 0.07,
    depthWrite: false,
    side: DoubleSide,
  });
  const cone = new Mesh(coneGeo, coneMat);
  cone.name = 'lander-scan-cone';
  cone.renderOrder = 2;
  lidarHead.add(cone);

  // Landing-lamp pool on the ground under the lander (draped on the terrain wherever the lander hovers).
  const lampPool = lampPoolMesh('lander-lamp-pool', 5.0, 5.0);
  lampPool.position.y = -7.6;
  root.add(lampPool);

  return { root, lidarHead, cone, lampPool };
}

// ---------------------------------------------------------------------------------------------------------------
// TRIDENT-like rotary-percussive drill: deck on four legs, feed mast, motor head on a carriage, helical auger with a
// heated tip, cuttings chute, and the stratigraphic cutaway tinted like the block walls.
// ---------------------------------------------------------------------------------------------------------------
const AUGER_VERTEX = /* glsl */ `
varying vec2 vUv;
varying float vY;
varying vec3 vNormalW;
varying vec3 vViewW;
void main() {
  vUv = uv;
  vY = position.y;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  vec4 world = modelMatrix * vec4(position, 1.0);
  vViewW = cameraPosition - world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

// Schematic shading (the auger is drawn as a cutaway): a fixed key light, a steel highlight, and the heated tip.
// AUGER_GHOST draws the same shading translucent and without the depth test, so the bit shows through the ground.
const AUGER_FRAGMENT = /* glsl */ `
uniform float uDrillHeat;
varying vec2 vUv;
varying float vY;
varying vec3 vNormalW;
varying vec3 vViewW;
void main() {
  vec3 n = normalize(vNormalW);
  if (!gl_FrontFacing) n = -n;
  vec3 v = normalize(vViewW);
  vec3 l = normalize(vec3(-0.35, 0.8, -0.5));
  float diffuse = 0.32 + 0.68 * max(dot(n, l), 0.0);
  float highlight = pow(max(dot(reflect(-l, n), v), 0.0), 24.0) * 0.45;
  vec3 steel = vec3(0.6, 0.62, 0.66) * diffuse + highlight;
  float tip = 1.0 - smoothstep(0.0, 0.4, vY);
  vec3 hot = mix(vec3(0.9, 0.25, 0.04), vec3(1.0, 0.85, 0.45), uDrillHeat);
  vec3 color = mix(steel, hot, tip * (0.25 + 0.75 * uDrillHeat));
#ifdef AUGER_GHOST
  gl_FragColor = vec4(color, 0.42);
#else
  gl_FragColor = vec4(color, 1.0);
#endif
}
`;

/**
 * Body tint of each drill stratum (linear RGB, unlit), one per depth interval. The engine writes it from the same
 * palette as the block walls (BlockWalls.strataBandRgb); the solver's per-layer colour (density, ice) then sets
 * the brightness. Shared by every drill built.
 */
const STRATA_TINT: readonly Color[] = STRATA_BOUNDS_M.slice(1).map(() => new Color(0.42, 0.4, 0.38));

/** Sets the body tint of drill stratum `index` (no allocation). */
export function setStrataTint(index: number, r: number, g: number, b: number): void {
  const tint = STRATA_TINT[index];
  if (tint !== undefined) tint.setRGB(r, g, b);
}

const STRATA_VERTEX_PARS = /* glsl */ `
varying vec2 vStrataUv;
`;
const STRATA_FRAGMENT_PARS = /* glsl */ `
uniform vec3 uStrataTint;
varying vec2 vStrataUv;
`;
// Hue from the wall palette, brightness from the solver colour (luminance 0.5 = neutral), and a crisp outline on
// the edges of every face so each bed reads as a cut block.
const STRATA_FRAGMENT = /* glsl */ `
#include <color_fragment>
float strataShade = clamp( dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) ) / 0.5, 0.6, 1.6 );
diffuseColor.rgb = uStrataTint * strataShade;
vec2 strataEdge = min( vStrataUv, 1.0 - vStrataUv );
float strataDist = min( strataEdge.x, strataEdge.y );
float strataAa = max( fwidth( strataDist ), 1e-4 );
float strataLine = 1.0 - smoothstep( strataAa, 2.0 * strataAa, strataDist );
diffuseColor.rgb *= 1.0 - 0.5 * strataLine;
diffuseColor.a = mix( diffuseColor.a, 0.9, strataLine );
`;

function strataMaterial(index: number): MeshBasicMaterial {
  const material = new MeshBasicMaterial({
    color: 0x8a7a66,
    transparent: true,
    opacity: 0.5,
    depthTest: false,
    depthWrite: false,
  });
  material.name = `drill-strata-${index}`;
  const tint = STRATA_TINT[index];
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uStrataTint = { value: tint };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${STRATA_VERTEX_PARS}`)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvStrataUv = uv;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${STRATA_FRAGMENT_PARS}`)
      .replace('#include <color_fragment>', STRATA_FRAGMENT);
  };
  material.customProgramCacheKey = () => 'drill-strata';
  return material;
}

const DECK_Y = 0.4;
const MAST_RAIL_X = -0.36;
const MAST_TOP_Y = 2.72;

function augerGeometry(): BufferGeometry {
  const pitch = 0.075;
  const flightStart = 0.1;
  const turns = Math.floor((1.75 - flightStart) / pitch);
  return mergeParts([
    part(new ConeGeometry(0.036, 0.09, 14), { at: [0, 0.045, 0], rot: [Math.PI, 0, 0] }),
    part(new CylinderGeometry(0.02, 0.02, AUGER_LENGTH - 0.08, 12), { at: [0, 0.08 + 0.5 * (AUGER_LENGTH - 0.08), 0] }),
    helixGeometry(0.019, 0.05, pitch, turns, 16, flightStart),
    part(new CylinderGeometry(0.04, 0.04, 0.08, 14), { at: [0, AUGER_LENGTH - 0.04, 0] }),
  ]);
}

export function buildDrill(): DrillRig {
  const kit = getHardwareKit();
  const root = new Group();
  root.name = 'trident-drill';

  // Deck on four legs, with the electronics box (MLI) and the guide collar the auger runs through.
  const mli = [part(new BoxGeometry(0.42, 0.3, 0.62), { at: [0.38, DECK_Y + 0.17, 0], uvDensity: MLI_UV_DENSITY })];
  const paint: BufferGeometry[] = [
    part(new BoxGeometry(1.26, 0.02, 1.06), { at: [0, DECK_Y + 0.01, 0] }),
    part(new BoxGeometry(0.46, 0.02, 0.66), { at: [0.38, DECK_Y + 0.33, 0] }),
    part(new BoxGeometry(0.5, 0.14, 0.3), { at: [-0.17, MAST_TOP_Y + 0.07, 0] }),
    part(new BoxGeometry(0.505, 0.03, 0.305), { at: [-0.17, MAST_TOP_Y + 0.02, 0], color: MARKING_ORANGE }),
    tube([0.09, DECK_Y - 0.01, 0.09], [0.3, 0.12, 0.42], 0.036, 10),
  ];
  const dark: BufferGeometry[] = [
    part(new BoxGeometry(1.3, 0.06, 1.1), { at: [0, DECK_Y - 0.03, 0] }),
    part(new CylinderGeometry(0.075, 0.085, 0.12, 18), { at: [0, DECK_Y + 0.04, 0] }),
    part(new BoxGeometry(0.16, 0.1, 0.26), { at: [MAST_RAIL_X, DECK_Y + 0.07, 0] }),
    part(new CylinderGeometry(0.05, 0.05, 0.12, 14), { at: [MAST_RAIL_X, MAST_TOP_Y + 0.2, 0], rot: AXIS_Z }),
  ];
  const bare: BufferGeometry[] = [part(new CylinderGeometry(0.06, 0.05, 0.06, 14), { at: [0.32, 0.07, 0.43] })];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      dark.push(tube([0.58 * sx, DECK_Y - 0.06, 0.48 * sz], [0.68 * sx, 0.04, 0.58 * sz], 0.028, 10));
      bare.push(part(new CylinderGeometry(0.09, 0.11, 0.04, 16), { at: [0.68 * sx, 0.02, 0.58 * sz] }));
    }
  }
  // Feed mast: two rails with a ladder of braces and diagonals.
  for (const z of [-0.07, 0.07]) dark.push(tube([MAST_RAIL_X, DECK_Y + 0.02, z], [MAST_RAIL_X, MAST_TOP_Y, z], 0.022, 10));
  for (let y = DECK_Y + 0.3; y < MAST_TOP_Y - 0.1; y += 0.3) {
    dark.push(tube([MAST_RAIL_X - 0.02, y, -0.07], [MAST_RAIL_X - 0.02, y, 0.07], 0.01, 6));
    dark.push(tube([MAST_RAIL_X - 0.02, y, -0.07], [MAST_RAIL_X - 0.02, y + 0.3, 0.07], 0.008, 6));
  }
  // Lamps on the electronics box, facing +x.
  const lamps: BufferGeometry[] = [];
  for (const z of [-0.18, 0.18]) {
    const at: Vec3 = [0.6, DECK_Y + 0.17, z];
    lamps.push(lampFace(at, 0.03));
    dark.push(lampHousing(at, 0.03));
  }
  root.add(
    namedMesh('drill-mli', mergeParts(mli), kit.mli),
    namedMesh('drill-paint', mergeParts(paint), kit.paint),
    namedMesh('drill-dark', mergeParts(dark), kit.darkAluminium),
    namedMesh('drill-bare', mergeParts(bare), kit.wheelAluminium),
    namedMesh('drill-lamps', mergeParts(lamps), kit.lamp, false),
  );

  // Auger pivot: translates down with depth; the auger tip sits at its origin, the motor head above the auger.
  const augerPivot = new Group();
  augerPivot.name = 'drill-auger-pivot';
  root.add(augerPivot);
  const augerMaterial = new ShaderMaterial({
    uniforms: { uDrillHeat: { value: 0 } },
    vertexShader: AUGER_VERTEX,
    fragmentShader: AUGER_FRAGMENT,
    side: DoubleSide,
  });
  augerMaterial.name = 'drill-auger';
  const auger = new Mesh(augerGeometry(), augerMaterial);
  auger.name = 'drill-auger';
  auger.renderOrder = 5;
  augerPivot.add(auger);
  // X-ray cutaway: a translucent copy without the depth test shows the bit through the regolith. It shares the
  // uniforms, so the solver's heat drives both.
  const ghostMaterial = new ShaderMaterial({
    uniforms: augerMaterial.uniforms,
    vertexShader: AUGER_VERTEX,
    fragmentShader: AUGER_FRAGMENT,
    defines: { AUGER_GHOST: '' },
    side: DoubleSide,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  ghostMaterial.name = 'drill-auger-ghost';
  const ghost = new Mesh(auger.geometry, ghostMaterial);
  ghost.name = 'drill-auger-ghost';
  ghost.renderOrder = 5;
  auger.add(ghost);

  const headY = AUGER_LENGTH + 0.15;
  const headPaint = [
    part(new BoxGeometry(0.24, 0.26, 0.24), { at: [0, headY, 0] }),
    part(new BoxGeometry(0.245, 0.03, 0.245), { at: [0, headY - 0.07, 0], color: MARKING_ORANGE }),
  ];
  const headDark = [
    part(new CylinderGeometry(0.06, 0.07, 0.06, 16), { at: [0, AUGER_LENGTH, 0] }),
    part(new CylinderGeometry(0.075, 0.075, 0.16, 16), { at: [0, headY + 0.21, 0] }),
    part(new BoxGeometry(0.22, 0.08, 0.1), { at: [-0.23, headY, 0] }),
    part(new BoxGeometry(0.08, 0.22, 0.2), { at: [MAST_RAIL_X, headY, 0] }),
  ];
  const headLampAt: Vec3 = [0.13, headY + 0.03, 0];
  headDark.push(lampHousing(headLampAt, 0.022));
  augerPivot.add(
    namedMesh('drill-head-paint', mergeParts(headPaint), kit.paint),
    namedMesh('drill-head-dark', mergeParts(headDark), kit.darkAluminium),
    namedMesh('drill-head-lamp', mergeParts([lampFace(headLampAt, 0.022)]), kit.lamp, false),
  );

  // Stratigraphic cut below the deck: one box per depth interval, drawn through the terrain.
  const strataGeo = new BoxGeometry(1, 1, 1);
  const strata: Mesh[] = [];
  const strataMaterials: MeshBasicMaterial[] = [];
  for (let i = 0; i < STRATA_BOUNDS_M.length - 1; i++) {
    const top = STRATA_BOUNDS_M[i];
    const bottom = STRATA_BOUNDS_M[i + 1];
    const mat = strataMaterial(i);
    const layer = new Mesh(strataGeo, mat);
    layer.name = `drill-stratum-${i}`;
    layer.position.y = -(top + bottom) / 2;
    layer.scale.set(0.9, bottom - top - 0.01, 0.9);
    layer.renderOrder = 6;
    root.add(layer);
    strata.push(layer);
    strataMaterials.push(mat);
  }

  const lampPool = lampPoolMesh('drill-lamp-pool', 3.0, 2.6);
  lampPool.position.set(1.1, 0, 0);
  root.add(lampPool);

  return { root, augerPivot, auger, augerMaterial, strata, strataMaterials, lampPool };
}

// ---------------------------------------------------------------------------------------------------------------
// Optional external glTF (Meshopt + KTX2). Not called by default: no external assets ship with the sandbox.
// ---------------------------------------------------------------------------------------------------------------
export async function loadOptionalGlb(
  url: string,
  fallback: () => Object3D,
  renderer: WebGLRenderer | null = null,
  transcoderPath = '/basis/',
): Promise<Object3D> {
  try {
    const [{ GLTFLoader }, { MeshoptDecoder }, { KTX2Loader }] = await Promise.all([
      import('three/examples/jsm/loaders/GLTFLoader.js'),
      import('three/examples/jsm/libs/meshopt_decoder.module.js'),
      import('three/examples/jsm/loaders/KTX2Loader.js'),
    ]);
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    if (renderer !== null) {
      loader.setKTX2Loader(new KTX2Loader().setTranscoderPath(transcoderPath).detectSupport(renderer));
    }
    const gltf = await loader.loadAsync(url);
    return gltf.scene;
  } catch (error) {
    console.warn(`[AssetBuilder] Falling back to the procedural model for ${url}:`, error);
    return fallback();
  }
}
