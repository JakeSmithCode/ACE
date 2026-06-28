// The tick scheduler (docs/PHASE2.md §6 — "the tick · scheduled resolution"). In
// production a match scheduled for 8pm resolves on a CRON/queue, not a manual button:
// BullMQ runs a repeatable job that calls `runTick` on the world's cadence. That needs
// Redis + the BullMQ framework, which the proven `node:http` slice keeps OUT (zero-dep).
//
// So this is the SAME scheduling contract behind a minimal, runnable interface: a
// `Scheduler` that fires an async `tick` on an interval, with an in-memory timer impl
// that runs anywhere (used by the live server's auto-advance). A BullMQ adapter is a
// drop-in — it implements the exact same `Scheduler` shape over a Redis-backed
// repeatable job, so the resolution code (the `tick` fn) is identical either way.
//
//   // production (apps/server, with deps):
//   const sched: Scheduler = new BullScheduler(queue, 'world-tick', everyMs);
//   sched.start(() => runTick(store, worldId, opts));
//
//   // here (zero-dep, in-process):
//   const sched: Scheduler = new IntervalScheduler(everyMs);
//   sched.start(() => advance());

/** Fires an async `tick` on a cadence; `stop()` halts it. A BullMQ repeatable job and
 *  this in-memory interval both satisfy it, so the tick logic never knows which runs. */
export interface Scheduler {
  start(tick: () => Promise<unknown>): void;
  stop(): void;
}

/** In-process interval scheduler — runs the tick every `everyMs`, never overlapping
 *  (a still-running tick skips the next fire, like BullMQ's single-active-job guard).
 *  `now` is injectable only to mirror the rest of the slice; timing uses setInterval. */
export class IntervalScheduler implements Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  constructor(private everyMs: number) {}

  start(tick: () => Promise<unknown>): void {
    if (this.timer) return;   // idempotent
    this.timer = setInterval(async () => {
      if (this.running) return;   // don't overlap — wait for the prior tick to finish
      this.running = true;
      try { await tick(); } catch { /* a failed tick is retried on the next fire, like a queue job */ }
      finally { this.running = false; }
    }, this.everyMs);
    if (typeof this.timer === 'object' && 'unref' in this.timer) (this.timer as { unref(): void }).unref();   // don't keep the process alive
  }
  stop(): void { if (this.timer) { clearInterval(this.timer); this.timer = null; } }
}
