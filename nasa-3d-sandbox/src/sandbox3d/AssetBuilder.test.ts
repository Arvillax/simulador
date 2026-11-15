import { describe, expect, it } from 'vitest';
import { Box3, Matrix4, MeshBasicMaterial, ShaderMaterial, Vector3 } from 'three';
import type { BufferGeometry, Material, Mesh, Object3D } from 'three';
import {
  ARM_INSET,
  AUGER_LENGTH,
  BOGIE_PIVOT_X,
  H_OFFSET,
  L_BOGIE,
  L_ROCKER,
  ROCKER_PIVOT_X,
  STRATA_BOUNDS_M,
  TRACK_WIDTH,
  WHEEL_FRONT_X,
  WHEEL_MID_X,
  WHEEL_RADIUS,
  WHEEL_REAR_X,
  WHEEL_WIDTH,
  buildDrill,
  buildLander,
  buildRover,
  buildSuit,
} from './AssetBuilder.ts';
import { strataBandRgb } from './BlockWalls.ts';
import type { Rgb } from './BodyLook.ts';
import { getHardwareKit } from './HardwareKit.ts';
import { triangleCount } from './HardwareGeometry.ts';

/** Per-asset budgets of the art direction: draw calls stay low because static parts are merged by material. */
const MAX_TRIANGLES = 12_000;

function meshesOf(root: Object3D): Mesh[] {
  const out: Mesh[] = [];
  root.traverse((object) => {
    if ((object as Mesh).isMesh === true) out.push(object as Mesh);
  });
  return out;
}

function materialsOf(root: Object3D): Set<Material> {
  const out = new Set<Material>();
  for (const mesh of meshesOf(root)) out.add(mesh.material as Material);
  return out;
}

function boundsOf(geometry: BufferGeometry): Box3 {
  return new Box3().setFromBufferAttribute(geometry.attributes.position as never);
}

function maxRadiusXY(geometry: BufferGeometry): number {
  const p = geometry.attributes.position;
  let max = 0;
  for (let i = 0; i < p.count; i++) max = Math.max(max, Math.hypot(p.getX(i), p.getY(i)));
  return max;
}

describe('rig constants', () => {
  it('keeps the rover, drill and strata dimensions the solvers compute with', () => {
    expect(WHEEL_RADIUS).toBe(0.25);
    expect(WHEEL_WIDTH).toBe(0.2);
    expect(WHEEL_FRONT_X).toBe(0.75);
    expect(WHEEL_MID_X).toBe(0);
    expect(WHEEL_REAR_X).toBe(-0.7);
    expect(TRACK_WIDTH).toBe(1.4);
    expect(BOGIE_PIVOT_X).toBe(-0.35);
    expect(L_BOGIE).toBe(0.7);
    expect(L_ROCKER).toBeCloseTo(1.1, 12);
    expect(H_OFFSET).toBe(0.35);
    expect(ROCKER_PIVOT_X).toBe(0.15);
    expect(ARM_INSET).toBe(0.17);
    expect(AUGER_LENGTH).toBe(2.0);
    expect(STRATA_BOUNDS_M).toEqual([0, 0.1, 0.5, 1.5]);
  });
});

describe('buildRover', () => {
  const rig = buildRover();

  it('exposes six wheels, two rockers with their beams and two bogies under the root', () => {
    expect(rig.wheels).toHaveLength(6);
    expect(rig.rockers).toHaveLength(2);
    expect(rig.rockerBeams).toHaveLength(2);
    expect(rig.bogies).toHaveLength(2);
    expect(rig.chassis.parent).toBe(rig.root);
    for (const wheel of rig.wheels) expect(wheel.parent).toBe(rig.root);
    for (let side = 0; side < 2; side++) {
      expect(rig.rockers[side].parent).toBe(rig.root);
      expect(rig.bogies[side].parent).toBe(rig.root);
      expect(rig.rockerBeams[side].parent).toBe(rig.rockers[side]);
    }
  });

  it('keeps the rocker beam a unit-length part along x, so the solver can scale it to the arm length', () => {
    for (const beam of rig.rockerBeams) {
      const box = boundsOf(beam.geometry);
      expect(box.min.x + box.max.x).toBeCloseTo(0, 6);
      expect(box.max.x - box.min.x).toBeGreaterThanOrEqual(1);
      expect(box.max.x - box.min.x).toBeLessThan(1.12); // end knuckles only
    }
  });

  it('draws each wheel as one mesh whose grouser tips are at the kinematic radius', () => {
    for (const wheel of rig.wheels) {
      const meshes = meshesOf(wheel);
      expect(meshes).toHaveLength(1);
      const geometry = meshes[0].geometry;
      expect(maxRadiusXY(geometry)).toBeCloseTo(WHEEL_RADIUS, 4);
      const p = geometry.attributes.position;
      for (let i = 0; i < p.count; i++) {
        // The tread and the grousers stay inside the wheel width; only the axle stub is longer.
        if (Math.hypot(p.getX(i), p.getY(i)) > 0.5 * WHEEL_RADIUS) {
          expect(Math.abs(p.getZ(i))).toBeLessThanOrEqual(WHEEL_WIDTH / 2 + 1e-6);
        }
      }
    }
    expect(rig.wheels[0].children[0]).toBeDefined();
    expect((rig.wheels[0].children[0] as Mesh).geometry).toBe((rig.wheels[5].children[0] as Mesh).geometry);
  });

  it('stays inside the mesh and triangle budgets', () => {
    // Ten kinematic parts (6 wheels, 2 rockers, 2 bogies) plus the chassis merged by material.
    expect(meshesOf(rig.root).length).toBeLessThanOrEqual(16);
    expect(triangleCount(rig.root)).toBeLessThanOrEqual(MAX_TRIANGLES);
  });
});

describe('buildSuit', () => {
  const rig = buildSuit();

  /** Position of an object's origin in the suit root frame (the root itself has a presentation yaw). */
  function inRoot(object: Object3D): number[] {
    rig.root.updateMatrixWorld(true);
    const inverse = new Matrix4().copy(rig.root.matrixWorld).invert();
    return object.getWorldPosition(new Vector3()).applyMatrix4(inverse).toArray().map((v) => Math.round(v * 1e6) / 1e6);
  }

  it('keeps the arm pivots and the solver-driven parts', () => {
    expect(inRoot(rig.shoulder)).toEqual([0.32, 1.45, 0]);
    expect(rig.elbow.parent).toBe(rig.shoulder);
    expect(rig.elbow.position.toArray()).toEqual([0, -0.42, 0]);
    expect(rig.shoulder.rotation.toArray().slice(0, 3)).toEqual([0, 0, 0]);
    expect(rig.elbow.rotation.toArray().slice(0, 3)).toEqual([0, 0, 0]);
    expect(rig.seal.parent).toBe(rig.elbow);
    expect(rig.seal.material).toBe(rig.sealMaterial);
    expect(rig.panel.material).toBe(rig.panelMaterial);
    expect(rig.panelMaterial.uniforms.uDustObscuration.value).toBe(0);
    expect(rig.panelMaterial.uniforms.uEdsFlash.value).toBe(0);
  });

  it('keeps the 1.0 m x 0.55 m panel the dust solver assumes, in its place', () => {
    const box = boundsOf(rig.panel.geometry);
    expect(box.max.x - box.min.x).toBeCloseTo(1.0, 6);
    expect(box.max.y - box.min.y).toBeCloseTo(0.55, 6);
    expect(inRoot(rig.panel)).toEqual([0, 1.9, -0.35]);
    expect(rig.panel.rotation.x).toBeCloseTo(-Math.PI / 3, 12);
  });

  it('is an articulated chain: every joint moves everything below it', () => {
    expect(rig.pelvis.parent).toBe(rig.root);
    expect(rig.torso.parent).toBe(rig.pelvis);
    expect(rig.helmet.parent).toBe(rig.torso);
    expect(rig.hipL.parent).toBe(rig.pelvis);
    expect(rig.hipR.parent).toBe(rig.pelvis);
    expect(rig.kneeL.parent).toBe(rig.hipL);
    expect(rig.kneeR.parent).toBe(rig.hipR);
    expect(rig.ankleL.parent).toBe(rig.kneeL);
    expect(rig.ankleR.parent).toBe(rig.kneeR);
    expect(rig.shoulderL.parent).toBe(rig.torso);
    expect(rig.shoulderR.parent).toBe(rig.torso);
    expect(rig.elbowL.parent).toBe(rig.shoulderL);
    expect(rig.elbowR.parent).toBe(rig.shoulderR);
    // The solver's arm is the crew member's left (+x, the suit faces +z).
    expect(rig.shoulder).toBe(rig.shoulderL);
    expect(rig.elbow).toBe(rig.elbowL);
    expect(rig.panel.parent).toBe(rig.torso);
  });

  it('puts the joints at anatomical heights, mirrored left and right, in a zero-rotation rest pose', () => {
    expect(inRoot(rig.pelvis)[1]).toBeCloseTo(rig.legLength, 6);
    expect(rig.legLength).toBeGreaterThan(0.85);
    expect(rig.legLength).toBeLessThan(0.95);
    expect(rig.footLength).toBeGreaterThan(0.25);
    expect(rig.footLength).toBeLessThan(0.34);
    const pairs = [
      [rig.hipL, rig.hipR],
      [rig.kneeL, rig.kneeR],
      [rig.ankleL, rig.ankleR],
      [rig.shoulderL, rig.shoulderR],
      [rig.elbowL, rig.elbowR],
    ] as const;
    for (const [l, r] of pairs) {
      const a = inRoot(l);
      const b = inRoot(r);
      expect(a[0]).toBeGreaterThan(0);
      expect(a[0]).toBeCloseTo(-b[0], 6);
      expect(a[1]).toBeCloseTo(b[1], 6);
    }
    const y = (g: Object3D): number => inRoot(g)[1];
    expect(y(rig.hipL)).toBeGreaterThan(y(rig.kneeL));
    expect(y(rig.kneeL)).toBeGreaterThan(y(rig.ankleL));
    expect(y(rig.ankleL)).toBeGreaterThan(0);
    expect(y(rig.helmet)).toBeGreaterThan(y(rig.shoulderL));
    for (const joint of [rig.pelvis, rig.torso, rig.helmet, rig.hipL, rig.kneeL, rig.ankleL, rig.shoulderL, rig.elbowL]) {
      expect(joint.rotation.toArray().slice(0, 3)).toEqual([0, 0, 0]);
    }
  });

  it('stands with both soles flat on y = 0 and moves the foot with the hip but not the thigh with the knee', () => {
    for (const ankle of [rig.ankleL, rig.ankleR]) {
      rig.root.updateMatrixWorld(true);
      const inverse = new Matrix4().copy(rig.root.matrixWorld).invert();
      const foot = meshesOf(ankle)[0];
      const box = new Box3().setFromObject(foot).applyMatrix4(inverse);
      expect(box.min.y).toBeCloseTo(0, 4);
      expect(box.max.z - box.min.z).toBeGreaterThan(rig.footLength - 0.02);
    }
    const thigh = meshesOf(rig.hipL).find((m) => m.parent === rig.hipL);
    expect(thigh).toBeDefined();
    const footBefore = inRoot(rig.ankleL);
    const thighBefore = thigh === undefined ? [] : inRoot(thigh);
    rig.kneeL.rotation.x = 0.6;
    expect(inRoot(rig.ankleL)).not.toEqual(footBefore);
    expect(thigh === undefined ? [] : inRoot(thigh)).toEqual(thighBefore);
    rig.kneeL.rotation.x = 0;
    rig.hipL.rotation.x = -0.4;
    expect(inRoot(rig.ankleL)).not.toEqual(footBefore);
    rig.hipL.rotation.x = 0;
  });

  it('stays inside the mesh and triangle budgets', () => {
    expect(meshesOf(rig.root).length).toBeLessThanOrEqual(16);
    expect(triangleCount(rig.root)).toBeLessThanOrEqual(MAX_TRIANGLES);
  });
});

describe('buildLander', () => {
  const rig = buildLander();

  it('keeps the LiDAR head pivot and the unit scan cone with its apex at the head', () => {
    expect(rig.lidarHead.parent).toBe(rig.root);
    expect(rig.lidarHead.position.toArray()).toEqual([0, -0.6, 0]);
    expect(rig.cone.parent).toBe(rig.lidarHead);
    const box = boundsOf(rig.cone.geometry);
    expect(box.max.y).toBeCloseTo(0, 6);
    expect(box.min.y).toBeCloseTo(-1, 6);
    expect(box.max.x).toBeCloseTo(1, 6);
    expect(box.max.z).toBeCloseTo(1, 6);
    expect((rig.cone.material as Material).transparent).toBe(true);
  });

  it('keeps the footpads about where the old model had them and nothing inside the scan cone near the head', () => {
    rig.root.updateMatrixWorld(true);
    const box = new Box3().setFromObject(rig.root.getObjectByName('lander-struts') as Object3D);
    expect(box.min.y).toBeGreaterThan(-1.45);
    expect(box.min.y).toBeLessThan(-1.2);
    expect(box.max.x).toBeGreaterThan(1.3);
  });

  it('stays inside the mesh and triangle budgets', () => {
    expect(meshesOf(rig.root).length).toBeLessThanOrEqual(12);
    expect(triangleCount(rig.root)).toBeLessThanOrEqual(MAX_TRIANGLES);
  });
});

describe('buildDrill', () => {
  const rig = buildDrill();

  it('keeps the auger pivot, the auger length and the heat uniform', () => {
    expect(rig.augerPivot.parent).toBe(rig.root);
    expect(rig.augerPivot.position.toArray()).toEqual([0, 0, 0]);
    expect(rig.auger.parent).toBe(rig.augerPivot);
    expect(rig.auger.material).toBe(rig.augerMaterial);
    expect(rig.augerMaterial.uniforms.uDrillHeat.value).toBe(0);
    const box = boundsOf(rig.auger.geometry);
    expect(box.min.y).toBeCloseTo(0, 6); // tip at the pivot origin
    expect(box.max.y).toBeCloseTo(AUGER_LENGTH, 6);
  });

  it('models the auger as a helix, not a plain shaft, and drives its x-ray copy with the same uniforms', () => {
    expect(triangleCount(rig.auger.geometry)).toBeGreaterThan(300);
    const p = rig.auger.geometry.attributes.position;
    let max = 0;
    for (let i = 0; i < p.count; i++) max = Math.max(max, Math.hypot(p.getX(i), p.getZ(i)));
    expect(max).toBeGreaterThan(0.045);
    const ghost = rig.auger.children.find((c) => (c as Mesh).isMesh === true) as Mesh | undefined;
    expect(ghost).toBeDefined();
    const ghostMaterial = ghost?.material as ShaderMaterial;
    expect(ghostMaterial.uniforms).toBe(rig.augerMaterial.uniforms);
    expect(ghostMaterial.depthTest).toBe(false);
  });

  it('keeps one strata mesh and one basic material per depth interval', () => {
    const layers = STRATA_BOUNDS_M.length - 1;
    expect(rig.strata).toHaveLength(layers);
    expect(rig.strataMaterials).toHaveLength(layers);
    for (let i = 0; i < layers; i++) {
      const mesh = rig.strata[i];
      expect(mesh.material).toBe(rig.strataMaterials[i]);
      expect(rig.strataMaterials[i]).toBeInstanceOf(MeshBasicMaterial);
      const box = boundsOf(mesh.geometry);
      const top = box.max.y * mesh.scale.y + mesh.position.y;
      const bottom = box.min.y * mesh.scale.y + mesh.position.y;
      expect(top).toBeCloseTo(-STRATA_BOUNDS_M[i], 1);
      expect(bottom).toBeCloseTo(-STRATA_BOUNDS_M[i + 1], 1);
    }
  });

  it('stays inside the mesh and triangle budgets', () => {
    expect(meshesOf(rig.root).length).toBeLessThanOrEqual(14);
    expect(triangleCount(rig.root)).toBeLessThanOrEqual(MAX_TRIANGLES);
  });
});

describe('strataBandRgb', () => {
  const low: Rgb = [0.2, 0.15, 0.1];
  const high: Rgb = [0.6, 0.5, 0.4];
  const out: Rgb = [0, 0, 0];

  it('gives the top bed the light band colour and no ice', () => {
    strataBandRgb(0, low, high, 1, 1, out);
    expect(out[0]).toBeCloseTo(0.6 * 0.99, 6);
    expect(out[2]).toBeCloseTo(0.4 * 0.99, 6);
  });

  it('darkens deeper beds toward the dark band and tints them with ice', () => {
    const dry = [...strataBandRgb(2, low, high, 0, 1, out)];
    const icy = strataBandRgb(2, low, high, 1, 1, out);
    expect(dry[0]).toBeLessThan(0.6 * 0.99);
    expect(icy[2]).toBeGreaterThan(dry[2]);
  });
});

describe('shared hardware kit', () => {
  const kit = getHardwareKit();
  const rover = buildRover();

  it('builds the rover from the shared material set only', () => {
    const shared = new Set<Material>(Object.values(kit));
    for (const material of materialsOf(rover.root)) expect(shared.has(material)).toBe(true);
    for (const m of [kit.mli, kit.paint, kit.darkAluminium, kit.wheelAluminium, kit.solarCell, kit.lamp]) {
      expect(materialsOf(rover.root).has(m)).toBe(true);
    }
  });

  it('gives the rover a lamp pool that never casts a shadow', () => {
    expect(rover.lampPool.material).toBe(kit.lampPool);
    expect(rover.lampPool.userData.castShadow).toBe(false);
  });

  it('builds the lander and the drill from the kit plus their own cone, auger and strata materials', () => {
    const shared = new Set<Material>(Object.values(kit));
    const lander = buildLander();
    for (const material of materialsOf(lander.root)) expect(shared.has(material) || material === lander.cone.material).toBe(true);
    const drill = buildDrill();
    for (const material of materialsOf(drill.root)) {
      const own = material instanceof ShaderMaterial || (drill.strataMaterials as readonly Material[]).includes(material);
      expect(shared.has(material) || own).toBe(true);
    }
    for (const root of [rover.root, lander.root, drill.root]) {
      for (const m of [kit.mli, kit.paint, kit.darkAluminium, kit.lamp]) expect(materialsOf(root).has(m)).toBe(true);
    }
    expect(lander.lampPool.material).toBe(kit.lampPool);
    expect(drill.lampPool.material).toBe(kit.lampPool);
  });

  it('builds the suit from the kit plus its own seal and panel materials', () => {
    const suit = buildSuit();
    const shared = new Set<Material>(Object.values(kit));
    for (const material of materialsOf(suit.root)) {
      expect(shared.has(material) || material === suit.sealMaterial || material === suit.panelMaterial).toBe(true);
    }
    for (const m of [kit.betaCloth, kit.visor, kit.lamp]) {
      expect(materialsOf(suit.root).has(m)).toBe(true);
    }
    expect(suit.lampPool.material).toBe(kit.lampPool);
    expect(suit.lampPool.userData.castShadow).toBe(false);
  });
});
