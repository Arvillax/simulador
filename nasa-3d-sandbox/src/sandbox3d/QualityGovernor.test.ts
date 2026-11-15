import { describe, expect, it } from 'vitest';
import {
  MAX_RENDER_SCALE,
  QUALITY_LADDER,
  QualityGovernor,
  looksIntegrated,
  parseQualityParam,
  renderScaleCap,
} from './QualityGovernor.ts';

const FAST = 16.7;
const SLOW = 33.3;

/** Feeds `count` frames and returns how many of them changed the level. */
function feed(g: QualityGovernor, count: number, frameMs: number, cpuMs = 2, synthesized = false): number {
  let changes = 0;
  for (let i = 0; i < count; i++) if (g.sample(frameMs, cpuMs, synthesized)) changes++;
  return changes;
}

/** Frames needed to accumulate at least `ms` of sampled time. */
function framesFor(ms: number, frameMs: number): number {
  return Math.ceil(ms / frameMs);
}

describe('QUALITY_LADDER', () => {
  it('is the ordered ladder of the art direction', () => {
    expect(QUALITY_LADDER.map((l) => [l.scale, l.shadowMapSize])).toEqual([
      [1.5, 1024],
      [1.25, 1024],
      [1.0, 1024],
      [1.0, 512],
      [0.85, 512],
      [0.85, 0],
      [0.7, 0],
    ]);
    expect(MAX_RENDER_SCALE).toBe(1.5);
  });
});

describe('looksIntegrated', () => {
  it('recognises integrated and software renderers', () => {
    expect(looksIntegrated('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe(true);
    expect(looksIntegrated('Intel Iris OpenGL Engine')).toBe(true);
    expect(looksIntegrated('Mali-G78')).toBe(true);
    expect(looksIntegrated('Adreno (TM) 640')).toBe(true);
    expect(looksIntegrated('PowerVR Rogue GE8320')).toBe(true);
    expect(looksIntegrated('Google SwiftShader')).toBe(true);
    expect(looksIntegrated('llvmpipe (LLVM 15.0.7, 256 bits)')).toBe(true);
  });

  it('treats discrete or unknown renderers as not integrated', () => {
    expect(looksIntegrated('ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe(false);
    expect(looksIntegrated('AMD Radeon RX 6700 XT')).toBe(false);
    expect(looksIntegrated(null)).toBe(false);
    expect(looksIntegrated(undefined)).toBe(false);
    expect(looksIntegrated('')).toBe(false);
  });
});

describe('renderScaleCap', () => {
  it('is min(devicePixelRatio, 1.5) with a sane fallback', () => {
    expect(renderScaleCap(1)).toBe(1);
    expect(renderScaleCap(1.25)).toBe(1.25);
    expect(renderScaleCap(1.75)).toBe(1.5);
    expect(renderScaleCap(3)).toBe(1.5);
    expect(renderScaleCap(Number.NaN)).toBe(1);
    expect(renderScaleCap(0)).toBe(1);
  });
});

describe('parseQualityParam', () => {
  it('reads auto or a level 0..6, anything else is null', () => {
    expect(parseQualityParam('auto')).toBe('auto');
    expect(parseQualityParam('0')).toBe(0);
    expect(parseQualityParam('6')).toBe(6);
    expect(parseQualityParam('7')).toBeNull();
    expect(parseQualityParam('-1')).toBeNull();
    expect(parseQualityParam('2.5')).toBeNull();
    expect(parseQualityParam('')).toBeNull();
    expect(parseQualityParam(null)).toBeNull();
  });
});

describe('QualityGovernor start level and scale cap', () => {
  it('starts at L2 on integrated graphics and at L0 otherwise', () => {
    expect(new QualityGovernor({ integrated: true, maxScale: 1.5 }).level).toBe(2);
    expect(new QualityGovernor({ integrated: false, maxScale: 1.5 }).level).toBe(0);
  });

  it('reports the effective settings of the level', () => {
    const g = new QualityGovernor({ integrated: false, maxScale: 1.5 });
    expect(g.getState()).toEqual({ level: 0, renderScale: 1.5, shadowMapSize: 1024, auto: true, locked: false });
    g.setLevel(5);
    expect(g.getState()).toEqual({ level: 5, renderScale: 0.85, shadowMapSize: 0, auto: true, locked: false });
  });

  it('collapses the levels above the cap', () => {
    const one = new QualityGovernor({ integrated: false, maxScale: 1.0 });
    expect(one.level).toBe(2);
    expect(one.renderScale).toBe(1.0);
    const mid = new QualityGovernor({ integrated: false, maxScale: 1.25 });
    expect(mid.level).toBe(1);
    expect(mid.renderScale).toBe(1.25);
    const odd = new QualityGovernor({ integrated: false, maxScale: 1.1 });
    expect(odd.level).toBe(1);
    expect(odd.renderScale).toBe(1.1);
    odd.setLevel(0);
    expect(odd.level).toBe(1);
  });

  it('never reports a render scale above the cap, at any level', () => {
    for (const cap of [0.6, 0.8, 1, 1.1, 1.25, 1.5]) {
      const g = new QualityGovernor({ integrated: false, maxScale: cap });
      for (let level = 0; level < QUALITY_LADDER.length; level++) {
        g.setLevel(level);
        expect(g.renderScale).toBeLessThanOrEqual(cap);
        expect(g.renderScale).toBeLessThanOrEqual(MAX_RENDER_SCALE);
      }
    }
  });

  it('steps through the distinct levels only when several collapse (cap below 0.85)', () => {
    const g = new QualityGovernor({ integrated: false, maxScale: 0.8 });
    expect(g.level).toBe(2);
    feed(g, 3000, SLOW);
    expect(g.level).toBe(6);
    // Up again: 6 -> 5 -> 4 (L3 and L4 are the same at this cap) -> 2 (L0..L2 are the same).
    const seen: number[] = [];
    for (let i = 0; i < framesFor(200_000, FAST); i++) if (g.sample(FAST, 2, false)) seen.push(g.level);
    expect(seen).toEqual([5, 4, 2]);
  });

  it('never probes above the cap', () => {
    const g = new QualityGovernor({ integrated: true, maxScale: 1.0 });
    expect(feed(g, framesFor(30_000, FAST), FAST)).toBe(0);
    expect(g.level).toBe(2);
  });

  it('re-normalises the level when the cap changes', () => {
    const g = new QualityGovernor({ integrated: false, maxScale: 1.5 });
    expect(g.setMaxScale(1.0)).toBe(true);
    expect(g.level).toBe(2);
    expect(g.renderScale).toBe(1.0);
    expect(g.setMaxScale(1.0)).toBe(false);
  });
});

describe('QualityGovernor stepping down', () => {
  it('steps one level down when 25 % of the last 60 sampled frames are over 20 ms', () => {
    const g = new QualityGovernor({ integrated: true, maxScale: 1.5 });
    feed(g, 120, FAST);
    expect(feed(g, 14, SLOW)).toBe(0);
    expect(g.level).toBe(2);
    expect(g.sample(SLOW, 2, false)).toBe(true);
    expect(g.level).toBe(3);
  });

  it('does not step down for a few slow frames', () => {
    const g = new QualityGovernor({ integrated: true, maxScale: 1.5 });
    for (let i = 0; i < 200; i++) g.sample(i % 20 === 0 ? SLOW : FAST, 2, false);
    expect(g.level).toBeLessThanOrEqual(2);
    const h = new QualityGovernor({ integrated: false, maxScale: 1.5 });
    for (let i = 0; i < 2000; i++) h.sample(i % 20 === 0 ? SLOW : FAST, 2, false);
    expect(h.level).toBe(0);
  });

  it('waits 1.5 s after a change before the next step down', () => {
    const g = new QualityGovernor({ integrated: true, maxScale: 1.5 });
    feed(g, 120, FAST);
    feed(g, 15, SLOW);
    expect(g.level).toBe(3);
    expect(feed(g, 44, SLOW)).toBe(0); // 44 × 33.3 = 1465 ms
    expect(g.level).toBe(3);
    expect(feed(g, 2, SLOW)).toBe(1);
    expect(g.level).toBe(4);
  });

  it('stops at the last level', () => {
    const g = new QualityGovernor({ integrated: true, maxScale: 1.5 });
    feed(g, 3000, SLOW);
    expect(g.level).toBe(6);
    expect(g.getState()).toMatchObject({ renderScale: 0.7, shadowMapSize: 0 });
  });
});

describe('QualityGovernor probing up', () => {
  it('makes the first probe after 4 s of stable frames, the next ones after 8 s', () => {
    const g = new QualityGovernor({ integrated: true, maxScale: 1.5 });
    expect(feed(g, framesFor(4000, FAST) - 1, FAST)).toBe(0);
    expect(g.level).toBe(2);
    expect(g.sample(FAST, 2, false)).toBe(true);
    expect(g.level).toBe(1);
    expect(feed(g, framesFor(8000, FAST) - 1, FAST)).toBe(0);
    expect(g.level).toBe(1);
    expect(g.sample(FAST, 2, false)).toBe(true);
    expect(g.level).toBe(0);
    expect(feed(g, framesFor(60_000, FAST), FAST)).toBe(0);
  });

  it('does not probe while more than 2 % of the frames are slow', () => {
    const g = new QualityGovernor({ integrated: true, maxScale: 1.5 });
    for (let i = 0; i < 3000; i++) g.sample(i % 25 === 0 ? SLOW : FAST, 2, false); // 4 % slow
    expect(g.level).toBe(2);
  });

  it('backs off exponentially when a probe is followed by a step down within 4 s', () => {
    const g = new QualityGovernor({ integrated: true, maxScale: 1.5 });
    feed(g, framesFor(4000, FAST), FAST);
    expect(g.level).toBe(1);
    const expectedWaits = [16_000, 32_000, 64_000, 120_000, 120_000];
    for (const wait of expectedWaits) {
      // The probe fails: slow frames push the level back down inside the 4 s window.
      feed(g, framesFor(1500, SLOW), SLOW);
      expect(g.level).toBe(2);
      expect(feed(g, framesFor(wait, FAST) - 1, FAST)).toBe(0);
      expect(g.level).toBe(2);
      expect(feed(g, 1, FAST)).toBe(1);
      expect(g.level).toBe(1);
    }
  });

  it('resets the back-off of a level once a probe survives 4 s', () => {
    const g = new QualityGovernor({ integrated: true, maxScale: 1.5 });
    feed(g, framesFor(4000, FAST), FAST);
    feed(g, framesFor(1500, SLOW), SLOW);
    expect(g.level).toBe(2);
    feed(g, framesFor(16_000, FAST), FAST);
    expect(g.level).toBe(1);
    // Survives the 4 s window, then degrades later: this is not a failed probe.
    feed(g, framesFor(4100, FAST), FAST);
    expect(g.level).toBe(1);
    feed(g, 15, SLOW);
    expect(g.level).toBe(2);
    expect(feed(g, framesFor(8000, FAST), FAST)).toBe(1);
    expect(g.level).toBe(1);
  });
});

describe('QualityGovernor ignored frames', () => {
  it('ignores hitches over 250 ms, synthesis frames, CPU-bound frames and restart frames', () => {
    const g = new QualityGovernor({ integrated: true, maxScale: 1.5 });
    feed(g, 120, FAST);
    expect(feed(g, 200, 300)).toBe(0);
    expect(feed(g, 200, 40, 2, true)).toBe(0);
    expect(feed(g, 200, 40, 12.5)).toBe(0);
    expect(feed(g, 200, 0)).toBe(0);
    expect(g.level).toBe(2);
    // Ignored frames do not advance the stability clock either: 2 s were sampled so far.
    expect(feed(g, framesFor(2000, FAST) - 2, FAST)).toBe(0);
    expect(feed(g, 3, FAST)).toBe(1);
    expect(g.level).toBe(1);
  });
});

describe('QualityGovernor manual control', () => {
  it('does not change level while locked and resumes after unlock', () => {
    const g = new QualityGovernor({ integrated: true, maxScale: 1.5 });
    feed(g, 120, FAST);
    g.lock();
    expect(g.getState().locked).toBe(true);
    expect(feed(g, 500, SLOW)).toBe(0);
    expect(feed(g, 2000, FAST)).toBe(0);
    expect(g.level).toBe(2);
    g.unlock();
    expect(g.getState().locked).toBe(false);
    feed(g, framesFor(1500, SLOW) + 1, SLOW);
    expect(g.level).toBe(3);
  });

  it('lock(level) pins that level', () => {
    const g = new QualityGovernor({ integrated: true, maxScale: 1.5 });
    expect(g.lock(5)).toBe(true);
    expect(g.getState()).toEqual({ level: 5, renderScale: 0.85, shadowMapSize: 0, auto: true, locked: true });
    expect(feed(g, 2000, FAST)).toBe(0);
    expect(g.lock(5)).toBe(false);
  });

  it('lock() during an unverified probe falls back to the last verified level', () => {
    const g = new QualityGovernor({ integrated: true, maxScale: 1.5 });
    feed(g, framesFor(4000, FAST), FAST);
    expect(g.level).toBe(1);
    expect(g.lock()).toBe(true);
    expect(g.level).toBe(2);

    const h = new QualityGovernor({ integrated: true, maxScale: 1.5 });
    feed(h, framesFor(4000, FAST), FAST);
    feed(h, framesFor(4100, FAST), FAST);
    expect(h.level).toBe(1);
    expect(h.lock()).toBe(false);
    expect(h.level).toBe(1);
  });

  it('setAuto(false) keeps the level fixed', () => {
    const g = new QualityGovernor({ integrated: true, maxScale: 1.5 });
    g.setAuto(false);
    expect(g.getState().auto).toBe(false);
    expect(feed(g, 500, SLOW)).toBe(0);
    expect(feed(g, 2000, FAST)).toBe(0);
    expect(g.level).toBe(2);
    g.setAuto(true);
    feed(g, framesFor(1500, SLOW) + 1, SLOW);
    expect(g.level).toBe(3);
  });

  it('setLevel clamps and rounds', () => {
    const g = new QualityGovernor({ integrated: true, maxScale: 1.5 });
    g.setLevel(99);
    expect(g.level).toBe(6);
    g.setLevel(-3);
    expect(g.level).toBe(0);
    g.setLevel(3.4);
    expect(g.level).toBe(3);
  });

  it('writes its state into a caller-owned object', () => {
    const g = new QualityGovernor({ integrated: true, maxScale: 1.5 });
    const out = { level: -1, renderScale: -1, shadowMapSize: -1, auto: false, locked: true };
    expect(g.writeState(out)).toBe(out);
    expect(out).toEqual({ level: 2, renderScale: 1, shadowMapSize: 1024, auto: true, locked: false });
  });
});
