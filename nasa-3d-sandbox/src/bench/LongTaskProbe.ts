export interface LongTaskStats {
  count: number;
  maxMs: number;
  totalMs: number;
}

export interface LoafStats {
  count: number;
  maxMs: number;
  maxBlockingMs: number;
  totalBlockingMs: number;
}

/** null fields mean the entry type is not supported by this browser. */
export interface LongTaskReport {
  longtask: LongTaskStats | null;
  loaf: LoafStats | null;
}

const LONGTASK = 'longtask';
const LOAF = 'long-animation-frame';

function supportedTypes(): readonly string[] {
  if (typeof PerformanceObserver === 'undefined') return [];
  return PerformanceObserver.supportedEntryTypes ?? [];
}

export function longTaskSupport(): { longtask: boolean; loaf: boolean } {
  const types = supportedTypes();
  return { longtask: types.includes(LONGTASK), loaf: types.includes(LOAF) };
}

type LoafEntry = PerformanceEntry & { blockingDuration?: number };

/**
 * Counts main-thread long tasks (> 50 ms) and long animation frames (LoAF, > 50 ms) between start() and stop().
 * Tasks that run inside Web Workers are not reported here by design.
 */
export class LongTaskProbe {
  private longObserver: PerformanceObserver | null = null;
  private loafObserver: PerformanceObserver | null = null;
  private long: LongTaskStats | null = null;
  private loaf: LoafStats | null = null;

  start(): void {
    this.stopObservers();
    const support = longTaskSupport();
    this.long = support.longtask ? { count: 0, maxMs: 0, totalMs: 0 } : null;
    this.loaf = support.loaf ? { count: 0, maxMs: 0, maxBlockingMs: 0, totalBlockingMs: 0 } : null;
    if (this.long !== null) {
      this.longObserver = new PerformanceObserver((list) => this.addLongTasks(list.getEntries()));
      this.longObserver.observe({ type: LONGTASK, buffered: false });
    }
    if (this.loaf !== null) {
      this.loafObserver = new PerformanceObserver((list) => this.addLoaf(list.getEntries()));
      this.loafObserver.observe({ type: LOAF, buffered: false });
    }
  }

  stop(): LongTaskReport {
    if (this.longObserver !== null) this.addLongTasks(this.longObserver.takeRecords());
    if (this.loafObserver !== null) this.addLoaf(this.loafObserver.takeRecords());
    this.stopObservers();
    return {
      longtask: this.long === null ? null : { ...this.long },
      loaf: this.loaf === null ? null : { ...this.loaf },
    };
  }

  private stopObservers(): void {
    this.longObserver?.disconnect();
    this.loafObserver?.disconnect();
    this.longObserver = null;
    this.loafObserver = null;
  }

  private addLongTasks(entries: PerformanceEntryList): void {
    const s = this.long;
    if (s === null) return;
    for (const e of entries) {
      s.count++;
      s.totalMs += e.duration;
      if (e.duration > s.maxMs) s.maxMs = e.duration;
    }
  }

  private addLoaf(entries: PerformanceEntryList): void {
    const s = this.loaf;
    if (s === null) return;
    for (const e of entries) {
      const blocking = (e as LoafEntry).blockingDuration ?? 0;
      s.count++;
      if (e.duration > s.maxMs) s.maxMs = e.duration;
      if (blocking > s.maxBlockingMs) s.maxBlockingMs = blocking;
      s.totalBlockingMs += blocking;
    }
  }
}
