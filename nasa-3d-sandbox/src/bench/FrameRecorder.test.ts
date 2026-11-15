import { describe, expect, it } from 'vitest';
import { FrameRecorder } from './FrameRecorder.ts';
import type { FrameSample } from './FrameRecorder.ts';
import { distribution, percentile } from './stats.ts';

function sample(frameMs: number, extra: Partial<FrameSample> = {}): FrameSample {
  return {
    frameMs,
    cpuMs: 2,
    updateMs: 1,
    renderMs: 0.5,
    lidarMs: 0,
    synthMs: 0,
    drawCalls: 10,
    triangles: 1000,
    ...extra,
  };
}

describe('percentile (nearest rank)', () => {
  it('picks the nearest-rank value of an ascending array', () => {
    const sorted = new Float64Array(100);
    for (let i = 0; i < 100; i++) sorted[i] = i + 1;
    expect(percentile(sorted, 50)).toBe(50);
    expect(percentile(sorted, 95)).toBe(95);
    expect(percentile(sorted, 99)).toBe(99);
    expect(percentile(sorted, 100)).toBe(100);
    expect(percentile(sorted, 0)).toBe(1);
  });

  it('returns NaN for an empty array', () => {
    expect(percentile(new Float64Array(0), 50)).toBeNaN();
  });

  it('summarizes an unsorted sample list', () => {
    const d = distribution([5, 1, 4, 2, 3]);
    expect(d.n).toBe(5);
    expect(d.mean).toBe(3);
    expect(d.p50).toBe(3);
    expect(d.max).toBe(5);
  });
});

describe('FrameRecorder', () => {
  it('returns null when nothing was recorded', () => {
    expect(new FrameRecorder(4096).summarize()).toBeNull();
  });

  it('computes frame-time percentiles, average FPS, 1 % low and the share of frames over budget', () => {
    const r = new FrameRecorder(4096);
    for (let i = 1; i <= 100; i++) r.record(sample(i));
    const s = r.summarize();
    expect(s).not.toBeNull();
    if (s === null) return;
    expect(s.frames).toBe(100);
    expect(s.p50Ms).toBe(50);
    expect(s.p95Ms).toBe(95);
    expect(s.p99Ms).toBe(99);
    expect(s.maxMs).toBe(100);
    expect(s.avgFps).toBeCloseTo((100 * 1000) / 5050, 9);
    // Slowest 1 % of 100 frames is the single 100 ms frame.
    expect(s.onePercentLowFps).toBeCloseTo(10, 9);
    // 17..100 ms are over 16.67 ms (84 frames); 34..100 ms are over 33.33 ms (67 frames).
    expect(s.pctOver16ms).toBeCloseTo(84, 9);
    expect(s.pctOver33ms).toBeCloseTo(67, 9);
  });

  it('averages the per-phase CPU timings and keeps the last draw calls and triangles', () => {
    const r = new FrameRecorder(4096);
    r.record(sample(16, { cpuMs: 2, updateMs: 1, renderMs: 1, lidarMs: 0, synthMs: 0, drawCalls: 5, triangles: 50 }));
    r.record(sample(16, { cpuMs: 4, updateMs: 3, renderMs: 2, lidarMs: 2, synthMs: 8, drawCalls: 7, triangles: 70 }));
    const s = r.summarize();
    if (s === null) throw new Error('expected a summary');
    expect(s.meanCpuMs).toBe(3);
    expect(s.meanUpdateMs).toBe(2);
    expect(s.meanRenderMs).toBe(1.5);
    expect(s.meanLidarMs).toBe(1);
    expect(s.meanSynthMs).toBe(4);
    expect(s.maxSynthMs).toBe(8);
    expect(s.drawCalls).toBe(7);
    expect(s.triangles).toBe(70);
  });

  it('ignores restart frames whose frameMs is 0', () => {
    const r = new FrameRecorder(4096);
    r.record(sample(0));
    r.record(sample(20));
    const s = r.summarize();
    if (s === null) throw new Error('expected a summary');
    expect(s.frames).toBe(1);
    expect(s.skippedRestartFrames).toBe(1);
    expect(s.avgFps).toBeCloseTo(50, 9);
  });

  it('counts samples dropped past capacity instead of growing', () => {
    const r = new FrameRecorder(4);
    for (let i = 0; i < 10; i++) r.record(sample(10));
    const s = r.summarize();
    if (s === null) throw new Error('expected a summary');
    expect(r.capacity).toBe(4);
    expect(s.frames).toBe(4);
    expect(s.droppedSamples).toBe(6);
  });

  it('reset clears previous samples', () => {
    const r = new FrameRecorder(4096);
    r.record(sample(40));
    r.reset();
    r.record(sample(10));
    const s = r.summarize();
    if (s === null) throw new Error('expected a summary');
    expect(s.frames).toBe(1);
    expect(s.maxMs).toBe(10);
  });
});
