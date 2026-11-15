import { beforeEach, describe, expect, it } from 'vitest';
import { WALK_RIM_MARGIN_M, WAYPOINT_COUNT, WalkController, WalkPath, feetGroundHeight, slopeAlong } from './WalkPath.ts';
import { GaitWalker } from './GaitPose.ts';
import { PLOT_HALF, configureHeightField, sampleHeight } from './TerrainGenerator.ts';
import { RockFieldInstancer, findRockNear, rebuildRockGrid, rockColliders, rockState } from './RockFieldInstancer.ts';
import { G_MOON, slipMargin } from './GaitModel.ts';

const DIMS = { hipHalfWidth: 0.12, thigh: 0.42, shin: 0.4, ankleHeight: 0.1, legLength: 0.92, footLength: 0.3 };

function flatNoRocks(): void {
  configureHeightField(7, 0, 0);
  rebuildRockGrid(0);
}

describe('walk path', () => {
  beforeEach(flatNoRocks);

  it('builds the same loop for the same seed and a different one for another seed', () => {
    const a = new WalkPath();
    const b = new WalkPath();
    a.reset(42, 0, 0);
    b.reset(42, 0, 0);
    expect(Array.from(b.waypoints)).toEqual(Array.from(a.waypoints));
    b.reset(43, 0, 0);
    expect(Array.from(b.waypoints)).not.toEqual(Array.from(a.waypoints));
  });

  it('keeps every waypoint inside the rim margin', () => {
    const p = new WalkPath();
    for (let seed = 1; seed < 40; seed++) {
      p.reset(seed, 0, 0);
      for (let i = 0; i < WAYPOINT_COUNT; i++) {
        expect(Math.abs(p.waypoints[2 * i])).toBeLessThanOrEqual(PLOT_HALF - WALK_RIM_MARGIN_M);
        expect(Math.abs(p.waypoints[2 * i + 1])).toBeLessThanOrEqual(PLOT_HALF - WALK_RIM_MARGIN_M);
      }
    }
  });

  it('steers around a rock straight ahead', () => {
    rockColliders.set([0, 0, 1.2, 0.5]);
    rebuildRockGrid(1);
    const p = new WalkPath();
    p.reset(1, 0, 0);
    p.waypoints[0] = 0;
    p.waypoints[1] = 6;
    p.index = 0;
    p.rebuildRoutes();
    expect(p.headingClear(0, 0, 0)).toBe(false);
    const heading = p.update(0.2, 0, 0, 0);
    expect(Math.abs(heading)).toBeGreaterThan(0.2);
    expect(p.headingClear(0, 0, heading)).toBe(true);
  });

  it('turns away from a slope beyond the slip margin', () => {
    configureHeightField(7, 40, 0); // y = x · tan 40°: impossible along ±x
    const p = new WalkPath();
    p.reset(1, 0, 0);
    p.waypoints[0] = 6;
    p.waypoints[1] = 0;
    p.index = 0;
    p.rebuildRoutes();
    expect(p.headingClear(0, 0, Math.PI / 2)).toBe(false);
    const heading = p.update(0.2, 0, 0, Math.PI / 2);
    expect(p.blocked).toBe(false);
    expect(slipMargin(slopeAlong(0, 0, heading), p.friction)).toBeGreaterThan(0);
    expect(Math.abs(Math.sin(heading))).toBeLessThan(0.9);
  });
});

describe('walk controller on a seeded site', () => {
  function run(
    seconds: number,
    seed = 1,
    gravity = G_MOON,
  ): { walker: GaitWalker; controller: WalkController; minRockGap: number; maxCoord: number } {
    configureHeightField(seed, 16, 0.72);
    new RockFieldInstancer().regenerate(seed, 0.72);
    const controller = new WalkController();
    const walker = new GaitWalker(DIMS);
    controller.gravity = gravity;
    controller.reset(seed, 0.72, DIMS.legLength, 0, 0);
    walker.reset(0, 0, controller.path.heading, feetGroundHeight);
    let minRockGap = Infinity;
    let maxCoord = 0;
    const startRock = findRockNear(0, 0, 0);
    for (let f = 0; f < seconds * 60; f++) {
      walker.advance(1 / 60, controller, sampleHeight, feetGroundHeight);
      maxCoord = Math.max(maxCoord, Math.abs(walker.x), Math.abs(walker.z));
      if (f > 120) {
        for (let r = 0; r < rockState.count; r++) {
          if (r === startRock) continue;
          const o = r * 4;
          const gap = Math.hypot(walker.x - rockColliders[o], walker.z - rockColliders[o + 2]) - rockColliders[o + 3];
          if (gap < minRockGap) minRockGap = gap;
        }
      }
    }
    return { walker, controller, minRockGap, maxCoord };
  }

  it('loops across the block, inside the rim and clear of rocks, and repeats exactly', () => {
    const a = run(90);
    expect(a.maxCoord).toBeLessThan(PLOT_HALF - 0.9);
    expect(a.minRockGap).toBeGreaterThan(0);
    expect(a.controller.path.waypointsReached).toBeGreaterThanOrEqual(2);
    expect(a.walker.footfalls).toBeGreaterThan(40);
    const b = run(90);
    expect(b.walker.x).toBe(a.walker.x);
    expect(b.walker.z).toBe(a.walker.z);
  });

  it('stays on the block and off the rocks for other seeds and gravities', () => {
    for (const [seed, g] of [
      [2, G_MOON],
      [3, G_MOON],
      [5, 3.71],
      [8, 9.81],
    ]) {
      const r = run(60, seed, g);
      expect(r.maxCoord).toBeLessThan(PLOT_HALF - 0.9);
      expect(r.minRockGap).toBeGreaterThan(0);
      expect(r.walker.footfalls).toBeGreaterThan(20);
    }
  });
});
