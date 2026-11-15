import { describe, expect, it } from 'vitest';
import { BoxGeometry, CylinderGeometry } from 'three';
import { helixFlight, mergeParts, part, triangleCount, tube } from './HardwareGeometry.ts';
import { crinkleNormalData, solarCellData } from './HardwareKit.ts';

describe('helixFlight', () => {
  const inner = 0.02;
  const outer = 0.05;
  const pitch = 0.1;
  const turns = 4;
  const perTurn = 12;
  const y0 = 0.08;
  const flight = helixFlight(inner, outer, pitch, turns, perTurn, y0);

  it('emits two triangles per segment', () => {
    expect(flight.positions.length).toBe(turns * perTurn * 6 * 3);
    expect(flight.normals.length).toBe(flight.positions.length);
    expect(flight.uvs.length).toBe(turns * perTurn * 6 * 2);
  });

  it('stays between the two radii and inside its height', () => {
    const p = flight.positions;
    for (let i = 0; i < p.length; i += 3) {
      const r = Math.hypot(p[i], p[i + 2]);
      expect(r).toBeGreaterThan(inner - 1e-6);
      expect(r).toBeLessThan(outer + 1e-6);
      expect(p[i + 1]).toBeGreaterThan(y0 - 1e-6);
      expect(p[i + 1]).toBeLessThan(y0 + turns * pitch + 1e-6);
    }
  });

  it('climbs one pitch per turn', () => {
    const p = flight.positions;
    const stride = perTurn * 6 * 3; // one full turn of vertices
    for (let i = 0; i + stride < p.length; i += 3) {
      expect(p[i + stride]).toBeCloseTo(p[i], 5);
      expect(p[i + stride + 1] - p[i + 1]).toBeCloseTo(pitch, 5);
      expect(p[i + stride + 2]).toBeCloseTo(p[i + 2], 5);
    }
  });

  it('has unit normals facing up that agree with the triangle winding', () => {
    const p = flight.positions;
    const n = flight.normals;
    for (let t = 0; t < p.length; t += 9) {
      const ux = p[t + 3] - p[t];
      const uy = p[t + 4] - p[t + 1];
      const uz = p[t + 5] - p[t + 2];
      const vx = p[t + 6] - p[t];
      const vy = p[t + 7] - p[t + 1];
      const vz = p[t + 8] - p[t + 2];
      const fx = uy * vz - uz * vy;
      const fy = uz * vx - ux * vz;
      const fz = ux * vy - uy * vx;
      for (let k = 0; k < 9; k += 3) {
        expect(Math.hypot(n[t + k], n[t + k + 1], n[t + k + 2])).toBeCloseTo(1, 5);
        expect(n[t + k + 1]).toBeGreaterThan(0);
        expect(fx * n[t + k] + fy * n[t + k + 1] + fz * n[t + k + 2]).toBeGreaterThan(0);
      }
    }
  });
});

describe('part and mergeParts', () => {
  it('returns a non-indexed geometry with position, normal, uv and colour, moved into place', () => {
    const g = part(new BoxGeometry(1, 1, 1), { at: [2, 0, 0], color: 0xffffff });
    expect(g.index).toBeNull();
    expect(Object.keys(g.attributes).sort()).toEqual(['color', 'normal', 'position', 'uv']);
    g.computeBoundingBox();
    expect(g.boundingBox?.min.x).toBeCloseTo(1.5, 6);
    expect(g.boundingBox?.max.x).toBeCloseTo(2.5, 6);
    expect(g.attributes.color.getX(0)).toBeCloseTo(1, 6);
  });

  it('merges parts into one geometry and keeps every triangle', () => {
    const a = part(new BoxGeometry(1, 1, 1));
    const b = part(new CylinderGeometry(0.5, 0.5, 1, 8), { at: [0, 2, 0] });
    const total = triangleCount(a) + triangleCount(b);
    const merged = mergeParts([a, b]);
    expect(triangleCount(merged)).toBe(total);
    expect(total).toBe(12 + 32);
  });

  it('builds a tube between two points', () => {
    const g = tube([0, 0, 0], [0, 0, 2], 0.1);
    g.computeBoundingBox();
    expect(g.boundingBox?.min.z).toBeCloseTo(0, 5);
    expect(g.boundingBox?.max.z).toBeCloseTo(2, 5);
    expect(g.boundingBox?.max.x).toBeLessThan(0.1 + 1e-6);
    expect(g.boundingBox?.max.y).toBeLessThan(0.1 + 1e-6);
  });
});

describe('procedural kit textures', () => {
  it('writes a deterministic, tileable tangent-space normal map', () => {
    const size = 32;
    const a = crinkleNormalData(size, 7);
    const b = crinkleNormalData(size, 7);
    expect(a.length).toBe(size * size * 4);
    expect(Array.from(a)).toEqual(Array.from(b));
    let bent = 0;
    for (let i = 0; i < a.length; i += 4) {
      const x = a[i] / 127.5 - 1;
      const y = a[i + 1] / 127.5 - 1;
      const z = a[i + 2] / 127.5 - 1;
      expect(Math.hypot(x, y, z)).toBeGreaterThan(0.97);
      expect(Math.hypot(x, y, z)).toBeLessThan(1.03);
      expect(z).toBeGreaterThan(0.4);
      if (Math.abs(x) > 0.05 || Math.abs(y) > 0.05) bent++;
      expect(a[i + 3]).toBe(255);
    }
    // A flat map would not crinkle anything.
    expect(bent).toBeGreaterThan((size * size) / 4);
  });

  it('draws grid lines brighter than the cells in the solar texture', () => {
    const size = 32;
    const data = solarCellData(size);
    expect(data.length).toBe(size * size * 4);
    const luminance = (i: number): number => data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2];
    // Texel (0, 0) is on a grid line; the middle of the first cell is not.
    const cell = size / 4;
    expect(luminance(0)).toBeGreaterThan(luminance(Math.floor(cell / 2) * size + Math.floor(cell / 2)));
  });
});
