// A stand-in trainer for measuring the multiverse without a GPU: it steps on a timer, checkpoints to the run's work/
// every few steps, and after a move resumes from the last checkpoint, so whatever it did after that checkpoint is
// redone, as a real trainer's would be. Its score follows a curve fixed by the universe's seed, so universes differ and
// a run is repeatable. A checkpoint is durable before it is reported: files are written, then the claim's barrier
// runs, then progress.json names the checkpoint (and the barrier runs again), so progress never names a lost checkpoint.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Progress } from "./multiverse.ts";

export interface TrainerOptions {
  /** The run's work directory on the claim. */
  readonly work: string;
  readonly total: number;
  readonly stepMs: number;
  readonly checkpointEvery: number;
  readonly seed: number;
  readonly generation: number;
  /** The machine label, as the notice gave it; written into progress so the watcher knows who trains. */
  readonly host: string;
  /** Bytes of weights each checkpoint writes (work/universe/weights.bin), as a real checkpoint would. Default 0: none. */
  readonly checkpointBytes?: number;
  /** The claim's barrier: the files are durable on the disk when it resolves. */
  barrier(): Promise<void>;
  readonly log?: (event: string, data?: Record<string, unknown>) => void;
}

export type Checkpoint = { step: number; score: number; seed: number; generation: number; at: string };

export const DIR = "universe";

/** Deterministic in [0, 1) from integers. */
function hash01(a: number, b: number): number {
  let h = (Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 2 ** 32;
}

/** The score after `step` of `total` steps: a saturating curve whose height and pace the seed fixes, plus small noise. */
export function scoreAt(seed: number, step: number, total: number): number {
  const peak = 0.4 + 0.6 * hash01(seed, 1);
  const pace = total * (0.15 + 0.35 * hash01(seed, 2));
  const noise = (hash01(seed, 1000 + step) - 0.5) * 0.04;
  return Math.round((peak * (1 - Math.exp(-step / pace)) + noise) * 10_000) / 10_000;
}

/** A checkpoint's stand-in weights: `bytes` bytes that change with every step. */
function weights(seed: number, step: number, bytes: number): Uint8Array {
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i += 4096) out[i] = Math.floor(hash01(seed, step * 7919 + i) * 256);
  return out;
}

async function atomicWrite(path: string, data: string | Uint8Array): Promise<void> {
  await writeFile(`${path}.tmp`, data);
  await rename(`${path}.tmp`, path);
}

export async function readCheckpoint(work: string): Promise<Checkpoint | null> {
  try {
    return JSON.parse(await readFile(join(work, DIR, "checkpoint.json"), "utf8")) as Checkpoint;
  } catch {
    return null;
  }
}

/** Train until `total` steps or `stop()`; resolves with the last checkpoint. */
export function startTrainer(o: TrainerOptions): { stop(): Promise<void>; done: Promise<Checkpoint | null> } {
  let stopped = false;
  let wake: (() => void) | null = null;
  const dir = join(o.work, DIR);
  const done = (async () => {
    await mkdir(dir, { recursive: true });
    const resumed = await readCheckpoint(o.work);
    let step = resumed?.step ?? 0;
    let last: Checkpoint | null = resumed;
    o.log?.("trainer.start", { from: step, generation: o.generation });
    const report = async (ck: Checkpoint, finished: boolean) => {
      const progress: Progress = { step: ck.step, total: o.total, score: ck.score, progress: Math.min(1, ck.step / o.total), done: finished, generation: o.generation, host: o.host, at: ck.at };
      await atomicWrite(join(dir, "progress.json"), `${JSON.stringify(progress)}\n`);
      await o.barrier();
    };
    // A resumed run says so at once: the watcher sees this machine's generation before the next checkpoint.
    if (resumed) await report({ ...resumed, generation: o.generation, at: new Date().toISOString() }, resumed.step >= o.total);
    while (!stopped && step < o.total) {
      await new Promise<void>((r) => {
        wake = r;
        setTimeout(r, o.stepMs);
      });
      if (stopped) break;
      step++;
      if (step % o.checkpointEvery !== 0 && step < o.total) continue;
      const ck: Checkpoint = { step, score: scoreAt(o.seed, step, o.total), seed: o.seed, generation: o.generation, at: new Date().toISOString() };
      if (o.checkpointBytes) await atomicWrite(join(dir, "weights.bin"), weights(o.seed, step, o.checkpointBytes));
      await atomicWrite(join(dir, "checkpoint.json"), `${JSON.stringify(ck)}\n`);
      if (step >= o.total) await atomicWrite(join(dir, "policy.json"), `${JSON.stringify({ kind: "stand-in", seed: o.seed, steps: step, score: ck.score })}\n`);
      await o.barrier();
      await report(ck, step >= o.total);
      last = ck;
    }
    o.log?.("trainer.end", { step, stopped });
    return last;
  })();
  return {
    async stop() {
      stopped = true;
      wake?.();
      await done.catch(() => undefined);
    },
    done,
  };
}
