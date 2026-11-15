import { describe, expect, it } from 'vitest';
import { FrameStats } from './FpsMeter.ts';

describe('FrameStats', () => {
  it('returns zeros when empty', () => {
    const stats = new FrameStats(64);
    expect(stats.avgFps()).toBe(0);
    expect(stats.onePercentLowFps()).toBe(0);
    expect(stats.worstMs()).toBe(0);
  });

  it('averages FPS over the last ~0.5 s', () => {
    const stats = new FrameStats(600);
    for (let i = 0; i < 120; i++) stats.push(1000 / 60);
    expect(stats.avgFps(500)).toBeCloseTo(60, 6);
    for (let i = 0; i < 60; i++) stats.push(10);
    expect(stats.avgFps(500)).toBeCloseTo(100, 6);
  });

  it('computes 1 % low FPS and worst frame over the last ~2 s', () => {
    const stats = new FrameStats(600);
    for (let i = 0; i < 100; i++) stats.push(10);
    stats.push(40);
    stats.push(40);
    for (let i = 0; i < 100; i++) stats.push(10);
    // Window of 2000 ms holds 194 frames, so the worst 1 % is the 2 slowest frames (40 ms each).
    expect(stats.onePercentLowFps(2000)).toBeCloseTo(25, 6);
    expect(stats.worstMs(2000)).toBe(40);
    expect(stats.avgFps(500)).toBeCloseTo(100, 6);
  });

  it('wraps the ring buffer without losing the newest samples', () => {
    const stats = new FrameStats(8);
    for (let i = 0; i < 20; i++) stats.push(i);
    expect(stats.count).toBe(8);
    expect(stats.at(0)).toBe(19);
    expect(stats.at(7)).toBe(12);
  });
});
