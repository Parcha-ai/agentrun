// What a cloud instance leaves behind about itself, for the server to keep: its lease (heartbeat writes that took long, the fence's reason) and, every few seconds, its health
// (event-loop delay, memory, the last heartbeat's duration). A VM whose disk stalls fences itself and exits; these lines, sent over the link as they happen, are what tells a
// stalled disk from a stalled process afterwards. Synchronous and best effort: nothing here can wait on the link or the disk.
import { monitorEventLoopDelay } from "node:perf_hooks";
import { freemem, loadavg } from "node:os";
import type { LeaseEvent } from "@parcha/pi-durable-disk";

export type TrailSend = (event: string, data?: Record<string, unknown>) => void;

export interface VmTrail {
  /** The run's `onLease`: report a heartbeat write slower than `slowBeatMs` (or failed) and every fence. */
  readonly onLease: (event: LeaseEvent) => void;
  /** Start the periodic health line; the returned function stops it. */
  startHealth(everyMs: number): () => void;
}

export function vmTrail(send: TrailSend, options: { slowBeatMs?: number } = {}): VmTrail {
  const slowBeatMs = options.slowBeatMs ?? 1_000;
  let lastBeatMs: number | undefined;
  let slowestBeatMs = 0;
  let beats = 0;
  let failedBeats = 0;
  const report = (event: string, data: Record<string, unknown>) => {
    try {
      send(event, data);
    } catch {
      // The trail never throws into the lease.
    }
  };
  return {
    onLease(event) {
      if (event.kind === "fence") {
        report("lease.fence", { code: event.code, message: event.message, ...(event.sinceMs === undefined ? {} : { sinceMs: event.sinceMs }), ...(event.by ? { by: event.by } : {}) });
        return;
      }
      if (event.ok) {
        beats++;
        lastBeatMs = event.ms;
        slowestBeatMs = Math.max(slowestBeatMs, event.ms);
        if (event.ms >= slowBeatMs) report("lease.slow-beat", { ms: Math.round(event.ms) });
      } else {
        failedBeats++;
        report("lease.beat-failed", { error: event.error ?? "" });
      }
    },
    startHealth(everyMs) {
      const delay = monitorEventLoopDelay({ resolution: 20 });
      delay.enable();
      const timer = setInterval(() => {
        const mem = process.memoryUsage();
        report("vm.health", {
          loopDelayMaxMs: Math.round(delay.max / 1e6),
          loopDelayMeanMs: Math.round(delay.mean / 1e6),
          rssMB: Math.round(mem.rss / 1048576),
          heapMB: Math.round(mem.heapUsed / 1048576),
          freeMemMB: Math.round(freemem() / 1048576),
          load1: Math.round(loadavg()[0]! * 100) / 100,
          beats,
          failedBeats,
          lastBeatMs: lastBeatMs === undefined ? null : Math.round(lastBeatMs),
          slowestBeatMs: Math.round(slowestBeatMs),
        });
        delay.reset();
        slowestBeatMs = 0;
      }, everyMs);
      timer.unref();
      return () => {
        clearInterval(timer);
        delay.disable();
      };
    },
  };
}
